import uuid
from unittest.mock import patch

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.db.models import Issue, Page, ProjectPage, State
from plane.ppm_canvas import views as canvas_views
from plane.ppm_canvas.models import PpmCanvasBinding, PpmCanvasBindingStatus, PpmCanvasBoard, PpmCanvasStatus
from plane.ppm_vault.services import create_markdown, get_or_create_project_vault
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix="batch"):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def batch_project():
    lead = make_user("lead")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="BAT")
    ProjectMemberFactory(workspace=workspace, project=project, member=lead, role=20)
    state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=lead,
    )
    return lead, workspace, project, state


def project_path(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}"


def boards_url(workspace, project):
    return f"{project_path(workspace, project)}/canvas/boards/"


def batch_url(workspace, project, board_id):
    return f"{boards_url(workspace, project)}{board_id}/bindings/batch/"


def create_issue(project, state, user, name):
    issue = Issue(name=name, project=project, state=state)
    issue.save(created_by_id=user.id)
    return issue


def default_board_id(api_client, workspace, project):
    return api_client.get(boards_url(workspace, project)).data["default_board_id"]


def create_board(api_client, workspace, project, name):
    return api_client.post(
        boards_url(workspace, project),
        {"name": name, "client_operation_id": str(uuid.uuid4())},
        format="json",
    ).data["board_id"]


def batch_item(entity, *, shape_id, entity_type="work_item", operation_id=None):
    item = {"shape_id": shape_id, "entity_type": entity_type, "entity_id": str(entity.id)}
    if operation_id:
        item["client_operation_id"] = str(operation_id)
    return item


def snapshot(*shape_ids):
    return {
        "document": {
            "store": {
                shape_id: {"id": shape_id, "typeName": "shape", "type": "ppm-canvas-node"} for shape_id in shape_ids
            }
        }
    }


def save_board(api_client, workspace, project, board_id, *, shape_ids, activate, base_version=0):
    return api_client.put(
        f"{boards_url(workspace, project)}{board_id}/snapshot/",
        {
            "schema_version": 2,
            "base_version": base_version,
            "snapshot": snapshot(*shape_ids),
            "client_operation_id": str(uuid.uuid4()),
            "binding_changes": {"activate": list(activate), "remove": []},
        },
        format="json",
    )


def test_batch_creates_pending_bindings_in_input_order_with_the_single_binding_json(api_client, batch_project):
    lead, workspace, project, state = batch_project
    first = create_issue(project, state, lead, "Первая задача")
    second = create_issue(project, state, lead, "Вторая задача")
    vault = get_or_create_project_vault(workspace_id=workspace.id, project_id=project.id, user_id=lead.id)
    brief = create_markdown(vault=vault, parent_id=None, name="Контекст.md", content="# Контекст", user_id=lead.id)
    api_client.force_authenticate(user=lead)
    board_id = default_board_id(api_client, workspace, project)
    reference_board_id = create_board(api_client, workspace, project, "Эталон")
    single = api_client.post(
        f"{boards_url(workspace, project)}{reference_board_id}/bindings/",
        {**batch_item(first, shape_id="shape:single"), "client_operation_id": str(uuid.uuid4())},
        format="json",
    )

    response = api_client.post(
        batch_url(workspace, project, board_id),
        {
            "items": [
                batch_item(second, shape_id="shape:second"),
                batch_item(first, shape_id="shape:first"),
                batch_item(brief, shape_id="shape:brief", entity_type="vault_file"),
            ]
        },
        format="json",
    )

    assert single.status_code == status.HTTP_201_CREATED
    assert response.status_code == status.HTTP_200_OK
    results = response.data["results"]
    assert [result["shape_id"] for result in results] == ["shape:second", "shape:first", "shape:brief"]
    assert [result["status"] for result in results] == ["created", "created", "created"]
    assert all("error" not in result for result in results)
    assert [result["binding"]["binding_status"] for result in results] == ["pending", "pending", "pending"]
    assert [result["binding"]["idempotent_replay"] for result in results] == [False, False, False]
    assert [result["binding"]["board_id"] for result in results] == [str(board_id)] * 3
    # «Тот же JSON, что у одиночной привязки»: те же ключи и тот же разрешённый источник.
    assert set(results[1]["binding"]) == set(single.data)
    assert results[1]["binding"]["source"] == single.data["source"]
    assert results[1]["binding"]["entity_id"] == str(first.id)
    assert results[2]["binding"]["source"]["display"]["title"] == "Контекст.md"

    activated = save_board(
        api_client,
        workspace,
        project,
        board_id,
        shape_ids=["shape:second", "shape:first", "shape:brief"],
        activate=[result["binding"]["binding_id"] for result in results],
    )

    assert activated.status_code == status.HTTP_200_OK
    assert PpmCanvasBinding.objects.filter(board_id=board_id, status=PpmCanvasBindingStatus.ACTIVE).count() == 3


def test_batch_reports_errors_per_item_and_keeps_the_valid_items(api_client, batch_project):
    lead, workspace, project, state = batch_project
    kept = create_issue(project, state, lead, "Остаётся")
    also_kept = create_issue(project, state, lead, "Тоже остаётся")
    other_project = ProjectFactory(workspace=workspace, identifier="BAT2")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=lead, role=20)
    other_state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=other_project,
        created_by=lead,
    )
    foreign = create_issue(other_project, other_state, lead, "Чужая")
    api_client.force_authenticate(user=lead)
    board_id = default_board_id(api_client, workspace, project)

    response = api_client.post(
        batch_url(workspace, project, board_id),
        {
            "items": [
                batch_item(kept, shape_id="shape:kept"),
                batch_item(foreign, shape_id="shape:foreign"),
                batch_item(also_kept, shape_id="shape:kept"),
                {"shape_id": "not-a-shape", "entity_type": "work_item", "entity_id": str(kept.id)},
                {"shape_id": "shape:vault", "entity_type": "vault_file", "entity_id": str(uuid.uuid4())},
                "garbage",
                batch_item(also_kept, shape_id="shape:also"),
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    results = response.data["results"]
    assert [(result["shape_id"], result["status"], result.get("error", {}).get("code")) for result in results] == [
        ("shape:kept", "created", None),
        ("shape:foreign", "error", "WORK_ITEM_NOT_FOUND"),
        ("shape:kept", "error", "BINDING_SHAPE_CONFLICT"),
        ("not-a-shape", "error", "BINDING_INVALID"),
        ("shape:vault", "error", "CONTENT_SOURCE_NOT_FOUND"),
        (None, "error", "BINDING_INVALID"),
        ("shape:also", "created", None),
    ]
    assert "shape_id" in results[3]["error"]["details"]
    assert results[2]["error"]["message"] == "Эта фигура уже связана с источником."
    assert all("binding" not in result for result in results if result["status"] == "error")
    assert set(PpmCanvasBinding.objects.filter(board_id=board_id).values_list("shape_id", flat=True)) == {
        "shape:kept",
        "shape:also",
    }


def test_batch_retry_is_idempotent_and_a_reused_operation_id_is_an_item_error(api_client, batch_project):
    lead, workspace, project, state = batch_project
    first = create_issue(project, state, lead, "Первая")
    second = create_issue(project, state, lead, "Вторая")
    api_client.force_authenticate(user=lead)
    board_id = default_board_id(api_client, workspace, project)
    operation_id = uuid.uuid4()
    payload = {
        "items": [
            batch_item(first, shape_id="shape:first"),
            batch_item(second, shape_id="shape:second", operation_id=operation_id),
        ]
    }

    created = api_client.post(batch_url(workspace, project, board_id), payload, format="json")
    replayed = api_client.post(batch_url(workspace, project, board_id), payload, format="json")
    reused = api_client.post(
        batch_url(workspace, project, board_id),
        {"items": [batch_item(first, shape_id="shape:third", operation_id=operation_id)]},
        format="json",
    )

    created_ids = [result["binding"]["binding_id"] for result in created.data["results"]]
    assert [result["binding"]["binding_id"] for result in replayed.data["results"]] == created_ids
    assert [result["status"] for result in replayed.data["results"]] == ["created", "created"]
    assert [result["binding"]["idempotent_replay"] for result in replayed.data["results"]] == [True, True]
    assert reused.status_code == status.HTTP_200_OK
    assert reused.data["results"][0]["status"] == "error"
    assert reused.data["results"][0]["error"]["code"] == "BINDING_OPERATION_REUSED"
    assert PpmCanvasBinding.objects.filter(board_id=board_id).count() == 2


def test_batch_validates_its_size_and_requires_edit_access_to_an_active_board(api_client, batch_project):
    lead, workspace, project, state = batch_project
    issue = create_issue(project, state, lead, "Задача")
    guest = make_user("guest")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    api_client.force_authenticate(user=lead)
    board_id = default_board_id(api_client, workspace, project)
    archived_board_id = create_board(api_client, workspace, project, "Архивная")
    api_client.post(
        f"{boards_url(workspace, project)}{archived_board_id}/archive/",
        {"client_operation_id": str(uuid.uuid4())},
        format="json",
    )

    empty = api_client.post(batch_url(workspace, project, board_id), {"items": []}, format="json")
    not_a_list = api_client.post(
        batch_url(workspace, project, board_id),
        {"items": {"shape_id": "shape:one"}},
        format="json",
    )
    too_large = api_client.post(
        batch_url(workspace, project, board_id),
        {"items": [batch_item(issue, shape_id=f"shape:n{index}") for index in range(201)]},
        format="json",
    )
    archived = api_client.post(
        batch_url(workspace, project, archived_board_id),
        {"items": [batch_item(issue, shape_id="shape:archived")]},
        format="json",
    )
    api_client.force_authenticate(user=guest)
    forbidden = api_client.post(
        batch_url(workspace, project, board_id),
        {"items": [batch_item(issue, shape_id="shape:guest")]},
        format="json",
    )

    assert (empty.status_code, empty.data["error"]["code"]) == (400, "CANVAS_BATCH_EMPTY")
    assert (not_a_list.status_code, not_a_list.data["error"]["code"]) == (400, "CANVAS_BATCH_INVALID")
    assert (too_large.status_code, too_large.data["error"]["code"]) == (400, "CANVAS_BATCH_TOO_LARGE")
    assert too_large.data["error"]["details"] == {"max_items": 200, "received": 201}
    assert (archived.status_code, archived.data["error"]["code"]) == (404, "CANVAS_BOARD_NOT_FOUND")
    assert (forbidden.status_code, forbidden.data["error"]["code"]) == (403, "CANVAS_WRITE_FORBIDDEN")
    assert PpmCanvasBinding.objects.count() == 0


def test_a_full_batch_of_200_is_bound_in_one_request_and_activated_by_one_save(api_client, batch_project):
    lead, workspace, project, state = batch_project
    issue = create_issue(project, state, lead, "Задача на двухстах карточках")
    api_client.force_authenticate(user=lead)
    board_id = default_board_id(api_client, workspace, project)
    shape_ids = [f"shape:card-{index}" for index in range(200)]

    created = api_client.post(
        batch_url(workspace, project, board_id),
        {"items": [batch_item(issue, shape_id=shape_id) for shape_id in shape_ids]},
        format="json",
    )
    activated = save_board(
        api_client,
        workspace,
        project,
        board_id,
        shape_ids=shape_ids,
        activate=[result["binding"]["binding_id"] for result in created.data["results"]],
    )

    assert created.status_code == status.HTTP_200_OK
    assert {result["status"] for result in created.data["results"]} == {"created"}
    assert activated.status_code == status.HTTP_200_OK, activated.data
    assert PpmCanvasBinding.objects.filter(board_id=board_id, status=PpmCanvasBindingStatus.ACTIVE).count() == 200


# ── AF2.2 финальная волна (FW-S): S1 — проверки один раз на пакет (M-10, final-pass), гонка архивации ──


def post_batch(api_client, workspace, project, board_id, items):
    with CaptureQueriesContext(connection) as queries:
        response = api_client.post(batch_url(workspace, project, board_id), {"items": items}, format="json")
    return response, queries


def table_queries(queries, table):
    return sum(f'FROM "{table}"' in query["sql"] for query in queries.captured_queries)


def outcomes(response):
    return [(result["status"], result.get("error", {}).get("code")) for result in response.data["results"]]


def test_batch_reads_task_visibility_once_with_the_single_binding_rules(api_client, batch_project):
    lead, workspace, project, state = batch_project
    tasks = [create_issue(project, state, lead, f"Задача {index}") for index in range(6)]
    archived = create_issue(project, state, lead, "Архивная")
    Issue.all_objects.filter(id=archived.id).update(archived_at=timezone.now().date())
    draft = create_issue(project, state, lead, "Черновик")
    Issue.all_objects.filter(id=draft.id).update(is_draft=True)
    other_project = ProjectFactory(workspace=workspace, identifier="BAT3")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=lead, role=20)
    other_state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=other_project,
        created_by=lead,
    )
    foreign = create_issue(other_project, other_state, lead, "Чужая")
    api_client.force_authenticate(user=lead)
    small_board = create_board(api_client, workspace, project, "Малый пакет")
    large_board = create_board(api_client, workspace, project, "Большой пакет")

    small, small_queries = post_batch(
        api_client,
        workspace,
        project,
        small_board,
        [batch_item(task, shape_id=f"shape:small-{index}") for index, task in enumerate(tasks[:2])],
    )
    large, large_queries = post_batch(
        api_client,
        workspace,
        project,
        large_board,
        [
            *(batch_item(task, shape_id=f"shape:large-{index}") for index, task in enumerate(tasks)),
            batch_item(archived, shape_id="shape:archived"),
            batch_item(draft, shape_id="shape:draft"),
            batch_item(foreign, shape_id="shape:foreign"),
        ],
    )

    assert outcomes(small) == [("created", None)] * 2
    # Те же правила, что у одиночной привязки: архивная задача, черновик и задача другого проекта не найдены.
    assert outcomes(large) == [("created", None)] * 6 + [("error", "WORK_ITEM_NOT_FOUND")] * 3
    assert [result["binding"]["entity_id"] for result in large.data["results"][:6]] == [str(task.id) for task in tasks]
    # Видимость задач пакета читается одним запросом до цикла, а не запросом на каждый пункт (M-10).
    assert table_queries(large_queries, "issues") == table_queries(small_queries, "issues")


def make_page(workspace, project, owner, name):
    page = Page.objects.create(workspace=workspace, name=name, owned_by=owner, access=Page.PUBLIC_ACCESS)
    ProjectPage.objects.create(workspace=workspace, project=project, page=page)
    return page


def test_batch_checks_the_restricted_guest_rule_once_for_all_page_items(api_client, batch_project):
    lead, workspace, project, _ = batch_project
    colleague = make_user("colleague")
    WorkspaceMemberFactory(workspace=workspace, member=colleague, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=colleague, role=15)
    # Чужие страницы: для каждой одиночная привязка проверяет роль (правило ограниченного гостя).
    pages = [make_page(workspace, project, colleague, f"Регламент {index}") for index in range(4)]
    api_client.force_authenticate(user=lead)
    one_board = create_board(api_client, workspace, project, "Одна страница")
    many_board = create_board(api_client, workspace, project, "Три страницы")

    one, one_queries = post_batch(
        api_client,
        workspace,
        project,
        one_board,
        [batch_item(pages[0], shape_id="shape:page-0", entity_type="page")],
    )
    many, many_queries = post_batch(
        api_client,
        workspace,
        project,
        many_board,
        [batch_item(page, shape_id=f"shape:page-{index}", entity_type="page") for index, page in enumerate(pages[1:])],
    )

    assert outcomes(one) == [("created", None)]
    assert outcomes(many) == [("created", None)] * 3
    assert [result["binding"]["source"]["display"]["title"] for result in many.data["results"]] == [
        "Регламент 1",
        "Регламент 2",
        "Регламент 3",
    ]
    # Роль в проекте читается один раз на пакет (create_binding передаёт restricted_guest дальше), и для ответа тоже.
    assert table_queries(many_queries, "project_members") == table_queries(one_queries, "project_members")


def test_batch_on_a_board_archived_after_the_request_found_it_is_a_conflict(api_client, batch_project):
    lead, workspace, project, state = batch_project
    issue = create_issue(project, state, lead, "Задача")
    api_client.force_authenticate(user=lead)
    board_id = create_board(api_client, workspace, project, "Архивируемая")
    create_bindings_batch = canvas_views.create_bindings_batch

    def archive_then_bind(**kwargs):
        # Запрос уже нашёл доску активной (resolve_board), но другой участник архивировал её до блокировки в пакете.
        PpmCanvasBoard.objects.filter(id=kwargs["board"].id).update(
            status=PpmCanvasStatus.ARCHIVED,
            archived_at=timezone.now(),
        )
        return create_bindings_batch(**kwargs)

    with patch.object(canvas_views, "create_bindings_batch", side_effect=archive_then_bind):
        response = api_client.post(
            batch_url(workspace, project, board_id),
            {"items": [batch_item(issue, shape_id="shape:late")]},
            format="json",
        )

    assert (response.status_code, response.data["error"]["code"]) == (409, "CANVAS_BOARD_ARCHIVED")
    assert response.data["error"]["details"] == {"board_id": str(board_id)}
    assert not PpmCanvasBinding.objects.filter(board_id=board_id).exists()
