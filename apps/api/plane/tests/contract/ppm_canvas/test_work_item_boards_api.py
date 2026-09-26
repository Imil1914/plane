import uuid
from unittest.mock import patch

import pytest
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_canvas.models import PpmCanvasBoard, PpmProjectCanvas
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def boards_project():
    lead = make_user("lead")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="ONM")
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


def work_item_boards_url(workspace, project, work_item_id):
    return f"{project_path(workspace, project)}/canvas/work-items/{work_item_id}/boards/"


def create_issue(project, state, user, name):
    issue = Issue(name=name, project=project, state=state)
    issue.save(created_by_id=user.id)
    return issue


def create_board(api_client, workspace, project, name):
    return api_client.post(
        boards_url(workspace, project),
        {"name": name, "client_operation_id": str(uuid.uuid4())},
        format="json",
    ).data["board_id"]


def place_on_board(api_client, workspace, project, board_id, issue, shape_ids, *, activate=True):
    bindings = [
        api_client.post(
            f"{boards_url(workspace, project)}{board_id}/bindings/",
            {
                "shape_id": shape_id,
                "entity_type": "work_item",
                "entity_id": str(issue.id),
                "client_operation_id": str(uuid.uuid4()),
            },
            format="json",
        ).data
        for shape_id in shape_ids
    ]
    if activate:
        saved = api_client.put(
            f"{boards_url(workspace, project)}{board_id}/snapshot/",
            {
                "schema_version": 2,
                "base_version": 0,
                "snapshot": {
                    "document": {
                        "store": {
                            shape_id: {"id": shape_id, "typeName": "shape", "type": "ppm-canvas-node"}
                            for shape_id in shape_ids
                        }
                    }
                },
                "client_operation_id": str(uuid.uuid4()),
                "binding_changes": {"activate": [binding["binding_id"] for binding in bindings], "remove": []},
            },
            format="json",
        )
        assert saved.status_code == status.HTTP_200_OK, saved.data
    return bindings


def test_work_item_boards_lists_each_active_board_once_with_its_first_card(api_client, boards_project):
    lead, workspace, project, state = boards_project
    task = create_issue(project, state, lead, "Задача на картах")
    api_client.force_authenticate(user=lead)
    main_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    sprint_id = create_board(api_client, workspace, project, "Карта · Спринт 12")
    archived_id = create_board(api_client, workspace, project, "Старая карта")
    pending_id = create_board(api_client, workspace, project, "Черновик")
    place_on_board(api_client, workspace, project, main_id, task, ["shape:first", "shape:second"])
    place_on_board(api_client, workspace, project, sprint_id, task, ["shape:sprint"])
    place_on_board(api_client, workspace, project, archived_id, task, ["shape:archived"])
    place_on_board(api_client, workspace, project, pending_id, task, ["shape:pending"], activate=False)
    api_client.post(
        f"{boards_url(workspace, project)}{archived_id}/archive/",
        {"client_operation_id": str(uuid.uuid4())},
        format="json",
    )

    response = api_client.get(work_item_boards_url(workspace, project, task.id))

    assert response.status_code == status.HTTP_200_OK
    assert response.data == {
        "results": [
            {"board_id": str(main_id), "name": "Главная", "shape_id": "shape:first"},
            {"board_id": str(sprint_id), "name": "Карта · Спринт 12", "shape_id": "shape:sprint"},
        ]
    }


def test_work_item_boards_respects_task_visibility_and_project_access(api_client, boards_project):
    lead, workspace, project, state = boards_project
    guest = make_user("guest")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    outsider = make_user("outsider")
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=15)
    lead_task = create_issue(project, state, lead, "Задача руководителя")
    guest_task = create_issue(project, state, guest, "Задача гостя")
    unplaced = create_issue(project, state, lead, "Нигде не лежит")
    removed = create_issue(project, state, lead, "Удалённая")
    other_project = ProjectFactory(workspace=workspace, identifier="ONM2")
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
    main_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    guest_board_id = create_board(api_client, workspace, project, "Доска гостя")
    removed_board_id = create_board(api_client, workspace, project, "Доска удалённой задачи")
    place_on_board(api_client, workspace, project, main_id, lead_task, ["shape:lead"])
    place_on_board(api_client, workspace, project, guest_board_id, guest_task, ["shape:guest"])
    place_on_board(api_client, workspace, project, removed_board_id, removed, ["shape:removed"])
    with patch("plane.db.mixins.soft_delete_related_objects"):
        removed.delete()

    unplaced_view = api_client.get(work_item_boards_url(workspace, project, unplaced.id))
    removed_view = api_client.get(work_item_boards_url(workspace, project, removed.id))
    foreign_view = api_client.get(work_item_boards_url(workspace, project, foreign.id))
    api_client.force_authenticate(user=guest)
    guest_own = api_client.get(work_item_boards_url(workspace, project, guest_task.id))
    guest_other = api_client.get(work_item_boards_url(workspace, project, lead_task.id))
    api_client.force_authenticate(user=outsider)
    outsider_view = api_client.get(work_item_boards_url(workspace, project, lead_task.id))

    assert unplaced_view.status_code == status.HTTP_200_OK
    assert unplaced_view.data == {"results": []}
    assert (removed_view.status_code, removed_view.data["error"]["code"]) == (404, "WORK_ITEM_NOT_FOUND")
    assert (foreign_view.status_code, foreign_view.data["error"]["code"]) == (404, "WORK_ITEM_NOT_FOUND")
    assert guest_own.status_code == status.HTTP_200_OK
    assert guest_own.data == {
        "results": [{"board_id": str(guest_board_id), "name": "Доска гостя", "shape_id": "shape:guest"}]
    }
    assert (guest_other.status_code, guest_other.data["error"]["code"]) == (404, "WORK_ITEM_NOT_FOUND")
    assert "Задача руководителя" not in str(guest_other.data)
    assert (outsider_view.status_code, outsider_view.data["error"]["code"]) == (403, "CANVAS_PERMISSION_DENIED")


# ── AF2.2 финальная волна (FW-S), final-pass S4 ──


def test_work_item_boards_does_not_create_a_canvas_for_a_project_without_one(api_client, boards_project):
    lead, workspace, project, state = boards_project
    guest = make_user("guest")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    task = create_issue(project, state, lead, "Задача без Холста")
    api_client.force_authenticate(user=lead)

    # Строку «На карте» карточка задачи запрашивает при каждом открытии — и в проекте, где Холст ни разу не открывали.
    lead_view = api_client.get(work_item_boards_url(workspace, project, task.id))
    api_client.force_authenticate(user=guest)
    guest_view = api_client.get(work_item_boards_url(workspace, project, task.id))

    assert lead_view.status_code == status.HTTP_200_OK
    assert lead_view.data == {"results": []}
    assert (guest_view.status_code, guest_view.data["error"]["code"]) == (404, "WORK_ITEM_NOT_FOUND")
    # Ни ответ, ни отказ не создают Холст и доску «Главная» (их создаёт только открытие Холста).
    assert not PpmProjectCanvas.objects.filter(project_id=project.id).exists()
    assert not PpmCanvasBoard.objects.filter(project_id=project.id).exists()
