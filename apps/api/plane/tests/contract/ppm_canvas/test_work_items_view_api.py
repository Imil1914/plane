import csv
import io
import uuid

import pytest
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_canvas.models import PpmCanvasBinding
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix="view"):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def view_project():
    user = make_user()
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="FLOW", description="Общая цель проекта")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    backlog = State.objects.create(
        name="Бэклог",
        color="#F59E0B",
        group="backlog",
        default=True,
        project=project,
        workspace=workspace,
        created_by=user,
    )
    doing = State.objects.create(
        name="В работе",
        color="#60A5FA",
        group="started",
        project=project,
        workspace=workspace,
        created_by=user,
    )
    done = State.objects.create(
        name="Готово",
        color="#4ADE80",
        group="completed",
        project=project,
        workspace=workspace,
        created_by=user,
    )
    return user, workspace, project, backlog, doing, done


def project_path(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}"


def board_id(api_client, workspace, project):
    response = api_client.get(f"{project_path(workspace, project)}/canvas/")
    assert response.status_code == status.HTTP_200_OK
    return response.data["board_id"]


def view_url(workspace, project, board):
    return f"{project_path(workspace, project)}/canvas/boards/{board}/work-items-view/"


def create_issue(project, state, user, name, *, priority="none", target_date=None):
    issue = Issue(name=name, project=project, state=state, priority=priority, target_date=target_date)
    issue.save(created_by_id=user.id)
    return issue


def test_view_filters_groups_and_sorts_only_current_project(api_client, view_project):
    user, workspace, project, backlog, doing, done = view_project
    create_issue(project, doing, user, "Вторая задача", priority="high")
    first = create_issue(project, doing, user, "Первая задача", priority="urgent")
    create_issue(project, done, user, "Готовая задача")
    foreign_project = ProjectFactory(workspace=workspace, identifier="OUT")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=user, role=20)
    foreign_state = State.objects.create(
        name="Чужой статус",
        color="#F87171",
        group="started",
        default=True,
        project=foreign_project,
        workspace=workspace,
        created_by=user,
    )
    foreign = create_issue(foreign_project, foreign_state, user, "Чужая задача")
    api_client.force_authenticate(user=user)
    board = board_id(api_client, workspace, project)

    response = api_client.get(
        view_url(workspace, project, board),
        {"state_ids": str(doing.id), "priorities": "urgent", "sort": "created_asc"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert [item["identity"]["entity_id"] for item in response.data["results"]] == [str(first.id)]
    assert response.data["summary"] == {
        "total": 1,
        "completed": 0,
        "progress_percent": 0,
        "by_state": [
            {
                "state_id": str(doing.id),
                "name": "В работе",
                "group": "started",
                "color": "#60A5FA",
                "count": 1,
            }
        ],
    }
    assert str(foreign.id) not in str(response.data)


def test_cross_project_state_filter_is_denied_instead_of_returning_empty(api_client, view_project):
    user, workspace, project, _, _, _ = view_project
    foreign_project = ProjectFactory(workspace=workspace, identifier="OUT")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=user, role=20)
    foreign_state = State.objects.create(
        name="Чужой статус",
        color="#F87171",
        group="started",
        default=True,
        project=foreign_project,
        workspace=workspace,
        created_by=user,
    )
    api_client.force_authenticate(user=user)
    board = board_id(api_client, workspace, project)

    response = api_client.get(view_url(workspace, project, board), {"state_ids": str(foreign_state.id)})

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.data["error"]["code"] == "WORK_ITEM_VIEW_FILTER_NOT_FOUND"


def test_create_from_view_is_idempotent_and_creates_no_canvas_binding(api_client, view_project):
    user, workspace, project, backlog, _, _ = view_project
    api_client.force_authenticate(user=user)
    board = board_id(api_client, workspace, project)
    operation_id = uuid.uuid4()
    payload = {
        "name": "Создано из Kanban",
        "state_id": str(backlog.id),
        "priority": "high",
        "client_operation_id": str(operation_id),
    }

    first = api_client.post(view_url(workspace, project, board), payload, format="json")
    replay = api_client.post(view_url(workspace, project, board), payload, format="json")

    assert first.status_code == status.HTTP_201_CREATED
    assert replay.status_code == status.HTTP_200_OK
    assert first.data["identity"]["entity_id"] == replay.data["identity"]["entity_id"]
    assert first.data["idempotent_replay"] is False
    assert replay.data["idempotent_replay"] is True
    assert Issue.issue_objects.filter(project=project, name="Создано из Kanban").count() == 1
    assert PpmCanvasBinding.objects.filter(project_id=project.id).count() == 0


def test_viewer_can_read_but_cannot_create_or_drag(api_client, view_project):
    owner, workspace, project, backlog, _, _ = view_project
    create_issue(project, backlog, owner, "Доступная задача")
    viewer = make_user("viewer")
    WorkspaceMemberFactory(workspace=workspace, member=viewer, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=viewer, role=5)
    project.guest_view_all_features = True
    project.save(update_fields=["guest_view_all_features"])
    api_client.force_authenticate(user=viewer)
    board = board_id(api_client, workspace, project)

    read = api_client.get(view_url(workspace, project, board))
    create = api_client.post(
        view_url(workspace, project, board),
        {"name": "Запрещено", "client_operation_id": str(uuid.uuid4())},
        format="json",
    )
    source = read.data["results"][0]
    update = api_client.patch(
        f"{project_path(workspace, project)}/work-items/{source['identity']['entity_id']}/",
        {"source_version": source["source_version"], "priority": "urgent"},
        format="json",
    )

    assert read.status_code == status.HTTP_200_OK
    assert source["capabilities"]["update"] is False
    assert create.status_code == status.HTTP_403_FORBIDDEN
    assert update.status_code == status.HTTP_403_FORBIDDEN


def test_csv_export_is_utf8_escaped_and_project_scoped(api_client, view_project):
    user, workspace, project, backlog, _, _ = view_project
    own = create_issue(project, backlog, user, 'Кавычки "и", перенос\nстроки', priority="urgent")
    foreign_project = ProjectFactory(workspace=workspace, identifier="OUT")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=user, role=20)
    foreign_state = State.objects.create(
        name="Other",
        color="#60646C",
        group="backlog",
        default=True,
        project=foreign_project,
        workspace=workspace,
        created_by=user,
    )
    create_issue(foreign_project, foreign_state, user, "Секрет другого проекта")
    api_client.force_authenticate(user=user)
    board = board_id(api_client, workspace, project)

    response = api_client.get(f"{view_url(workspace, project, board)}export/csv/")

    assert response.status_code == status.HTTP_200_OK
    assert response["Content-Type"] == "text/csv; charset=utf-8"
    assert response["Content-Disposition"] == 'attachment; filename="ppm-flow-work-items.csv"'
    decoded = response.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(decoded)))
    assert rows[0] == ["Ключ", "Название", "Статус", "Приоритет", "Исполнитель", "Срок"]
    assert rows[1][0] == f"FLOW-{own.sequence_id}"
    assert rows[1][1] == 'Кавычки "и", перенос\nстроки'
    assert "Секрет другого проекта" not in decoded


def test_markdown_export_covers_empty_and_one_hundred_items(api_client, view_project):
    user, workspace, project, backlog, _, done = view_project
    api_client.force_authenticate(user=user)
    board = board_id(api_client, workspace, project)
    url = f"{view_url(workspace, project, board)}export/markdown/"

    empty = api_client.get(url)
    for index in range(100):
        create_issue(project, done if index < 25 else backlog, user, f"Задача {index + 1}")
    filled = api_client.get(url)

    assert empty.status_code == status.HTTP_200_OK
    assert "Выполнено: 0 из 0 (0%)." in empty.content.decode("utf-8")
    content = filled.content.decode("utf-8")
    assert "## Цель" in content
    assert "Общая цель проекта" in content
    assert "Выполнено: 25 из 100 (25%)." in content
    assert "## Активные работы" in content
    assert "## Блокировки" in content


def test_outsider_cannot_export(api_client, view_project):
    owner, workspace, project, _, _, _ = view_project
    outsider = make_user("outsider")
    api_client.force_authenticate(user=owner)
    board = board_id(api_client, workspace, project)
    api_client.force_authenticate(user=outsider)

    response = api_client.get(f"{view_url(workspace, project, board)}export/csv/")

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert response.data["error"]["code"] == "CANVAS_PERMISSION_DENIED"
