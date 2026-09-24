import uuid

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import override_settings
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_canvas.models import (
    PpmCanvasBinding,
    PpmCanvasSemanticEdge,
    PpmCanvasVersion,
    PpmGlobalAdmin,
    PpmGlobalAdminAudit,
    PpmGlobalAdminRoleAudit,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix="multiboard"):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def multiboard_project():
    lead = make_user("lead")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="MBR")
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


def board_url(workspace, project, board_id):
    return f"{boards_url(workspace, project)}{board_id}/"


def snapshot_url(workspace, project, board_id):
    return f"{board_url(workspace, project, board_id)}snapshot/"


def snapshot(*shape_ids):
    return {
        "document": {
            "store": {
                shape_id: {"id": shape_id, "typeName": "shape", "type": "ppm-canvas-node"} for shape_id in shape_ids
            }
        },
        "session": {},
    }


def create_board(api_client, workspace, project, name, operation_id=None):
    return api_client.post(
        boards_url(workspace, project),
        {"name": name, "client_operation_id": str(operation_id or uuid.uuid4())},
        format="json",
    )


def save_board(api_client, workspace, project, board_id, *, base_version=0, shape_ids=(), operation_id=None):
    return api_client.put(
        snapshot_url(workspace, project, board_id),
        {
            "schema_version": 2,
            "base_version": base_version,
            "snapshot": snapshot(*shape_ids),
            "client_operation_id": str(operation_id or uuid.uuid4()),
        },
        format="json",
    )


def test_default_board_and_three_boards_save_independently(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    api_client.force_authenticate(user=lead)

    opened = api_client.get(boards_url(workspace, project))
    research = create_board(api_client, workspace, project, "Исследование")
    solution = create_board(api_client, workspace, project, "Решение")

    assert opened.status_code == status.HTTP_200_OK
    assert len(opened.data["boards"]) == 1
    assert opened.data["boards"][0]["name"] == "Главная"
    assert research.status_code == status.HTTP_201_CREATED
    assert solution.status_code == status.HTTP_201_CREATED

    main_id = opened.data["default_board_id"]
    saved_main = save_board(api_client, workspace, project, main_id, shape_ids=("shape:main",))
    saved_research = save_board(
        api_client,
        workspace,
        project,
        research.data["board_id"],
        shape_ids=("shape:research",),
    )
    saved_solution = save_board(
        api_client,
        workspace,
        project,
        solution.data["board_id"],
        shape_ids=("shape:solution",),
    )
    stale_research = save_board(
        api_client,
        workspace,
        project,
        research.data["board_id"],
        base_version=0,
        shape_ids=("shape:stale",),
    )
    second_solution = save_board(
        api_client,
        workspace,
        project,
        solution.data["board_id"],
        base_version=1,
        shape_ids=("shape:solution-2",),
    )

    assert saved_main.status_code == status.HTTP_200_OK
    assert saved_research.status_code == status.HTTP_200_OK
    assert saved_solution.status_code == status.HTTP_200_OK
    assert stale_research.status_code == status.HTTP_409_CONFLICT
    assert stale_research.data["error"]["code"] == "CANVAS_VERSION_CONFLICT"
    assert second_solution.status_code == status.HTTP_200_OK
    assert second_solution.data["version"] == 2
    assert PpmCanvasVersion.objects.filter(board_id=research.data["board_id"]).count() == 1
    assert PpmCanvasVersion.objects.filter(board_id=solution.data["board_id"]).count() == 2

    reloaded = api_client.get(board_url(workspace, project, research.data["board_id"]))
    assert reloaded.data["snapshot"] == snapshot("shape:research")


def test_immutable_board_version_is_readable_only_inside_its_project(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    api_client.force_authenticate(user=lead)
    board_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    first = save_board(api_client, workspace, project, board_id, shape_ids=("shape:first",))
    second = save_board(
        api_client,
        workspace,
        project,
        board_id,
        base_version=1,
        shape_ids=("shape:second",),
    )
    historical_url = f"{board_url(workspace, project, board_id)}versions/1/"

    historical = api_client.get(historical_url)
    missing = api_client.get(f"{board_url(workspace, project, board_id)}versions/3/")
    outsider = make_user("outsider")
    api_client.force_authenticate(user=outsider)
    denied = api_client.get(historical_url)

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_200_OK
    assert historical.status_code == status.HTTP_200_OK
    assert historical.data["board_id"] == str(board_id)
    assert historical.data["version"] == 1
    assert historical.data["snapshot"] == snapshot("shape:first")
    assert missing.status_code == status.HTTP_404_NOT_FOUND
    assert denied.status_code in (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)


def test_lifecycle_is_idempotent_and_last_board_cannot_be_archived(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    api_client.force_authenticate(user=lead)
    default = api_client.get(boards_url(workspace, project)).data["boards"][0]
    created_operation = uuid.uuid4()
    created = create_board(api_client, workspace, project, "План", created_operation)
    replay = create_board(api_client, workspace, project, "План", created_operation)
    rename_operation = uuid.uuid4()
    renamed = api_client.patch(
        board_url(workspace, project, created.data["board_id"]),
        {"name": "План работ", "client_operation_id": str(rename_operation)},
        format="json",
    )
    rename_replay = api_client.patch(
        board_url(workspace, project, created.data["board_id"]),
        {"name": "План работ", "client_operation_id": str(rename_operation)},
        format="json",
    )
    archive_operation = uuid.uuid4()
    archived = api_client.post(
        f"{board_url(workspace, project, created.data['board_id'])}archive/",
        {"client_operation_id": str(archive_operation)},
        format="json",
    )
    archive_replay = api_client.post(
        f"{board_url(workspace, project, created.data['board_id'])}archive/",
        {"client_operation_id": str(archive_operation)},
        format="json",
    )
    last_board = api_client.post(
        f"{board_url(workspace, project, default['board_id'])}archive/",
        {"client_operation_id": str(uuid.uuid4())},
        format="json",
    )
    restore_operation = uuid.uuid4()
    restored = api_client.post(
        f"{board_url(workspace, project, created.data['board_id'])}restore/",
        {"client_operation_id": str(restore_operation)},
        format="json",
    )
    restore_replay = api_client.post(
        f"{board_url(workspace, project, created.data['board_id'])}restore/",
        {"client_operation_id": str(restore_operation)},
        format="json",
    )

    assert created.status_code == status.HTTP_201_CREATED
    assert replay.status_code == status.HTTP_200_OK
    assert replay.data["idempotent_replay"] is True
    assert renamed.data["name"] == "План работ"
    assert rename_replay.data["idempotent_replay"] is True
    assert archived.data["status"] == "archived"
    assert archive_replay.data["idempotent_replay"] is True
    assert last_board.status_code == status.HTTP_409_CONFLICT
    assert last_board.data["error"]["code"] == "CANVAS_LAST_BOARD"
    assert restored.data["status"] == "active"
    assert restore_replay.data["idempotent_replay"] is True


def test_reorder_requires_every_active_board_and_replays(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    api_client.force_authenticate(user=lead)
    main = api_client.get(boards_url(workspace, project)).data["boards"][0]
    second = create_board(api_client, workspace, project, "Вторая").data
    third = create_board(api_client, workspace, project, "Третья").data
    order = [third["board_id"], main["board_id"], second["board_id"]]
    operation_id = uuid.uuid4()

    reordered = api_client.post(
        f"{boards_url(workspace, project)}reorder/",
        {"board_ids": order, "client_operation_id": str(operation_id)},
        format="json",
    )
    replay = api_client.post(
        f"{boards_url(workspace, project)}reorder/",
        {"board_ids": order, "client_operation_id": str(operation_id)},
        format="json",
    )
    invalid = api_client.post(
        f"{boards_url(workspace, project)}reorder/",
        {"board_ids": order[:-1], "client_operation_id": str(uuid.uuid4())},
        format="json",
    )

    assert reordered.status_code == status.HTTP_200_OK
    assert [item["board_id"] for item in reordered.data["boards"]] == order
    assert replay.data["idempotent_replay"] is True
    assert invalid.status_code == status.HTTP_409_CONFLICT
    assert invalid.data["error"]["code"] == "CANVAS_BOARD_ORDER_INVALID"


def test_duplicate_copies_snapshot_bindings_and_semantics_without_copying_source(api_client, multiboard_project):
    lead, workspace, project, state = multiboard_project
    api_client.force_authenticate(user=lead)
    board_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    issue = Issue(name="Canonical work item", project=project, state=state)
    issue.save(created_by_id=lead.id)
    binding = api_client.post(
        f"{board_url(workspace, project, board_id)}bindings/",
        {
            "shape_id": "shape:work",
            "entity_type": "work_item",
            "entity_id": str(issue.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    saved = api_client.put(
        snapshot_url(workspace, project, board_id),
        {
            "schema_version": 2,
            "base_version": 0,
            "snapshot": snapshot("shape:work", "shape:note"),
            "client_operation_id": str(uuid.uuid4()),
            "binding_changes": {"activate": [binding.data["binding_id"]], "remove": []},
        },
        format="json",
    )
    edge = api_client.post(
        f"{board_url(workspace, project, board_id)}semantic-edges/",
        {
            "from_shape_id": "shape:work",
            "to_shape_id": "shape:note",
            "relation_type": "explains",
            "label": "Контекст",
            "confidence": "0.9000",
            "origin": "user",
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    issue_count = Issue.all_objects.filter(project=project).count()
    duplicate = api_client.post(
        f"{board_url(workspace, project, board_id)}duplicate/",
        {"name": "Копия знаний", "client_operation_id": str(uuid.uuid4())},
        format="json",
    )

    assert binding.status_code == status.HTTP_201_CREATED
    assert saved.status_code == status.HTTP_200_OK
    assert edge.status_code == status.HTTP_201_CREATED
    assert duplicate.status_code == status.HTTP_201_CREATED
    duplicate_id = duplicate.data["board_id"]
    assert Issue.all_objects.filter(project=project).count() == issue_count
    assert PpmCanvasBinding.objects.filter(board_id=duplicate_id, entity_id=issue.id).count() == 1
    assert PpmCanvasSemanticEdge.objects.filter(board_id=duplicate_id).count() == 1
    assert api_client.get(board_url(workspace, project, duplicate_id)).data["snapshot"] == snapshot(
        "shape:work", "shape:note"
    )


def test_agent_semantic_edge_stays_proposed_until_editor_confirms_it(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    api_client.force_authenticate(user=lead)
    board_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    saved = save_board(
        api_client,
        workspace,
        project,
        board_id,
        shape_ids=("shape:proposal-source", "shape:proposal-target"),
    )
    created = api_client.post(
        f"{board_url(workspace, project, board_id)}semantic-edges/",
        {
            "from_shape_id": "shape:proposal-source",
            "to_shape_id": "shape:proposal-target",
            "relation_type": "implements",
            "origin": "agent",
            "confidence": "0.8800",
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    edge_id = created.data["edge_id"]
    reloaded = api_client.get(f"{board_url(workspace, project, board_id)}semantic-edges/")
    confirmed = api_client.patch(
        f"{board_url(workspace, project, board_id)}semantic-edges/{edge_id}/",
        {"confirmation_status": "confirmed"},
        format="json",
    )
    repeated_review = api_client.patch(
        f"{board_url(workspace, project, board_id)}semantic-edges/{edge_id}/",
        {"confirmation_status": "rejected"},
        format="json",
    )

    assert saved.status_code == status.HTTP_200_OK
    assert created.status_code == status.HTTP_201_CREATED
    assert created.data["confirmation_status"] == "proposed"
    assert created.data["confirmed_by"] is None
    assert reloaded.data["semantic_edges"][0]["confirmation_status"] == "proposed"
    assert confirmed.data["confirmation_status"] == "confirmed"
    assert confirmed.data["from_shape_id"] == "shape:proposal-source"
    assert confirmed.data["to_shape_id"] == "shape:proposal-target"
    assert confirmed.data["confirmed_by"] == str(lead.id)
    assert repeated_review.status_code == status.HTTP_409_CONFLICT
    assert repeated_review.data["error"]["code"] == "CANVAS_EDGE_ALREADY_REVIEWED"


def test_member_can_edit_boards_but_only_lead_can_archive(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    member = make_user("member")
    viewer = make_user("viewer")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    WorkspaceMemberFactory(workspace=workspace, member=viewer, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=viewer, role=5)

    api_client.force_authenticate(user=member)
    opened = api_client.get(boards_url(workspace, project))
    created = create_board(api_client, workspace, project, "Доска участника")
    archive = api_client.post(
        f"{board_url(workspace, project, created.data['board_id'])}archive/",
        {"client_operation_id": str(uuid.uuid4())},
        format="json",
    )

    api_client.force_authenticate(user=viewer)
    viewer_read = api_client.get(boards_url(workspace, project))
    viewer_create = create_board(api_client, workspace, project, "Запрещено")

    assert opened.data["capabilities"]["create_board"] is True
    assert opened.data["capabilities"]["archive_board"] is False
    assert created.status_code == status.HTTP_201_CREATED
    assert archive.status_code == status.HTTP_403_FORBIDDEN
    assert viewer_read.status_code == status.HTTP_200_OK
    assert viewer_read.data["access"] == "read"
    assert viewer_create.status_code == status.HTTP_403_FORBIDDEN


def test_board_uuid_is_scoped_to_its_project(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    second_project = ProjectFactory(workspace=workspace, identifier="MB2")
    ProjectMemberFactory(workspace=workspace, project=second_project, member=lead, role=20)
    api_client.force_authenticate(user=lead)
    foreign_board_id = api_client.get(boards_url(workspace, second_project)).data["default_board_id"]

    response = api_client.get(board_url(workspace, project, foreign_board_id))

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.data["error"]["code"] == "CANVAS_BOARD_NOT_FOUND"


def test_work_item_is_created_and_bound_to_selected_board(api_client, multiboard_project):
    lead, workspace, project, state = multiboard_project
    api_client.force_authenticate(user=lead)
    default_board_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    selected_board = create_board(api_client, workspace, project, "Задачи спринта").data

    response = api_client.post(
        f"{board_url(workspace, project, selected_board['board_id'])}work-items/",
        {
            "name": "Задача с выбранной доски",
            "state_id": str(state.id),
            "shape_id": "shape:selected-board-work-item",
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["board_id"] == selected_board["board_id"]
    assert PpmCanvasBinding.objects.filter(
        board_id=selected_board["board_id"],
        entity_id=response.data["entity_id"],
    ).exists()
    assert not PpmCanvasBinding.objects.filter(
        board_id=default_board_id,
        entity_id=response.data["entity_id"],
    ).exists()


def test_protected_global_admin_can_open_projects_across_workspaces_and_is_audited(api_client):
    owner_one = make_user("owner-one")
    owner_two = make_user("owner-two")
    workspace_one = WorkspaceFactory(owner=owner_one)
    workspace_two = WorkspaceFactory(owner=owner_two)
    project_one = ProjectFactory(workspace=workspace_one, identifier="GA1")
    project_two = ProjectFactory(workspace=workspace_two, identifier="GA2")
    global_admin = make_user("global")
    PpmGlobalAdmin.objects.create(user=global_admin, reason="Operations owner")
    api_client.force_authenticate(user=global_admin)

    first = api_client.get(boards_url(workspace_one, project_one))
    second = api_client.get(boards_url(workspace_two, project_two))

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_200_OK
    assert first.data["access"] == "edit"
    assert second.data["access"] == "edit"
    assert PpmGlobalAdminAudit.objects.filter(global_admin__user=global_admin).count() == 2


@override_settings(PPM_CANVAS_MULTIBOARD_ENABLED=False)
def test_multiboard_feature_flag_keeps_default_board_adapter_available(api_client, multiboard_project):
    lead, workspace, project, _ = multiboard_project
    api_client.force_authenticate(user=lead)

    multiboard = api_client.get(boards_url(workspace, project))
    legacy = api_client.get(f"{project_path(workspace, project)}/canvas/")

    assert multiboard.status_code == status.HTTP_404_NOT_FOUND
    assert legacy.status_code == status.HTTP_200_OK
    assert legacy.data["feature_flags"]["multi_board"] is False
    assert legacy.data["default_board_id"]


def test_global_admin_role_requires_protected_bootstrap_and_records_audit():
    first = make_user("bootstrap")
    second = make_user("delegate")

    with pytest.raises(CommandError, match="requires --bootstrap"):
        call_command("ppm_global_admin", "grant", email=first.email, reason="Initial owner")

    call_command("ppm_global_admin", "grant", email=first.email, reason="Initial owner", bootstrap=True)
    call_command(
        "ppm_global_admin",
        "grant",
        email=second.email,
        actor_email=first.email,
        reason="Second operator",
    )
    call_command(
        "ppm_global_admin",
        "revoke",
        email=second.email,
        actor_email=first.email,
        reason="Rotation",
    )

    assert PpmGlobalAdmin.objects.filter(user=first, revoked_at__isnull=True).exists()
    assert PpmGlobalAdmin.objects.filter(user=second, revoked_at__isnull=False).exists()
    assert list(PpmGlobalAdminRoleAudit.objects.order_by("created_at", "id").values_list("action", flat=True)) == [
        "grant",
        "grant",
        "revoke",
    ]
    with pytest.raises(CommandError, match="last active"):
        call_command(
            "ppm_global_admin",
            "revoke",
            email=first.email,
            actor_email=first.email,
            reason="Forbidden",
        )
