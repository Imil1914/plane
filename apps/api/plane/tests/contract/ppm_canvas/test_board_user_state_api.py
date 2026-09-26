import io
import uuid
from datetime import datetime

import pytest
from django.core.management import call_command
from django.db import IntegrityError, transaction
from django.test import override_settings
from django.utils import timezone
from rest_framework import status

from plane.ppm_canvas.models import PpmCanvasBoardUserState
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
def seen_project():
    lead = make_user("lead")
    colleague = make_user("colleague")
    guest = make_user("guest")
    workspace = WorkspaceFactory(owner=lead)
    project = ProjectFactory(workspace=workspace, identifier="SEEN")
    for member, role in ((lead, 20), (colleague, 15), (guest, 5)):
        WorkspaceMemberFactory(workspace=workspace, member=member, role=role)
        ProjectMemberFactory(workspace=workspace, project=project, member=member, role=role)
    return lead, colleague, guest, workspace, project


def boards_url(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/boards/"


def me_url(workspace, project, board_id):
    return f"{boards_url(workspace, project)}{board_id}/me/"


def seen_url(workspace, project, board_id):
    return f"{me_url(workspace, project, board_id)}seen/"


def save_board(api_client, workspace, project, board_id, *, base_version):
    return api_client.put(
        f"{boards_url(workspace, project)}{board_id}/snapshot/",
        {
            "schema_version": 2,
            "base_version": base_version,
            "snapshot": {"document": {"store": {}}},
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )


def test_seen_mark_is_personal_and_uses_server_time_and_the_current_board_version(api_client, seen_project):
    lead, colleague, guest, workspace, project = seen_project
    api_client.force_authenticate(user=lead)
    board_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    before = api_client.get(me_url(workspace, project, board_id))
    saved = save_board(api_client, workspace, project, board_id, base_version=0)
    started = timezone.now()
    marked = api_client.put(
        seen_url(workspace, project, board_id),
        {"seen_at": "2020-01-01T00:00:00Z", "seen_version": 99},
        format="json",
    )
    finished = timezone.now()
    after = api_client.get(me_url(workspace, project, board_id))
    api_client.force_authenticate(user=colleague)
    colleague_view = api_client.get(me_url(workspace, project, board_id))
    api_client.force_authenticate(user=guest)
    guest_mark = api_client.put(seen_url(workspace, project, board_id), format="json")

    assert before.status_code == status.HTTP_200_OK
    assert before.data == {"seen_at": None, "seen_version": None}
    assert saved.status_code == status.HTTP_200_OK
    assert marked.status_code == status.HTTP_200_OK
    # Тело запроса игнорируется: время и версия — серверные.
    assert started <= datetime.fromisoformat(marked.data["seen_at"]) <= finished
    assert marked.data["seen_version"] == 1
    assert after.data == marked.data
    assert colleague_view.data == {"seen_at": None, "seen_version": None}
    assert guest_mark.status_code == status.HTTP_200_OK
    assert guest_mark.data["seen_version"] == 1
    assert PpmCanvasBoardUserState.objects.filter(board_id=board_id).count() == 2


def test_marking_again_moves_the_same_personal_mark_forward(api_client, seen_project):
    lead, _, _, workspace, project = seen_project
    api_client.force_authenticate(user=lead)
    board_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]

    first = api_client.put(seen_url(workspace, project, board_id), format="json")
    save_board(api_client, workspace, project, board_id, base_version=0)
    second = api_client.put(seen_url(workspace, project, board_id), format="json")

    assert first.data["seen_version"] == 0
    assert second.data["seen_version"] == 1
    assert datetime.fromisoformat(second.data["seen_at"]) > datetime.fromisoformat(first.data["seen_at"])
    assert PpmCanvasBoardUserState.objects.filter(board_id=board_id, user=lead).count() == 1
    with pytest.raises(IntegrityError), transaction.atomic():
        PpmCanvasBoardUserState.objects.create(board_id=board_id, user=lead, seen_at=timezone.now())


def test_seen_mark_requires_read_access_to_an_active_board_of_the_project(api_client, seen_project):
    lead, _, _, workspace, project = seen_project
    outsider = make_user("outsider")
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=15)
    other_project = ProjectFactory(workspace=workspace, identifier="SEEN2")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=lead, role=20)
    api_client.force_authenticate(user=lead)
    board_id = api_client.get(boards_url(workspace, project)).data["default_board_id"]
    foreign_board_id = api_client.get(boards_url(workspace, other_project)).data["default_board_id"]
    archived_id = api_client.post(
        boards_url(workspace, project),
        {"name": "Архивная", "client_operation_id": str(uuid.uuid4())},
        format="json",
    ).data["board_id"]
    api_client.post(
        f"{boards_url(workspace, project)}{archived_id}/archive/",
        {"client_operation_id": str(uuid.uuid4())},
        format="json",
    )

    archived = api_client.put(seen_url(workspace, project, archived_id), format="json")
    foreign = api_client.get(me_url(workspace, project, foreign_board_id))
    api_client.force_authenticate(user=outsider)
    denied_read = api_client.get(me_url(workspace, project, board_id))
    denied_mark = api_client.put(seen_url(workspace, project, board_id), format="json")

    assert (archived.status_code, archived.data["error"]["code"]) == (404, "CANVAS_BOARD_NOT_FOUND")
    assert (foreign.status_code, foreign.data["error"]["code"]) == (404, "CANVAS_BOARD_NOT_FOUND")
    assert (denied_read.status_code, denied_read.data["error"]["code"]) == (403, "CANVAS_PERMISSION_DENIED")
    assert (denied_mark.status_code, denied_mark.data["error"]["code"]) == (403, "CANVAS_PERMISSION_DENIED")
    assert PpmCanvasBoardUserState.objects.count() == 0


@override_settings(MIGRATION_MODULES={})
def test_ppm_canvas_migrations_match_the_models():
    """pytest.ini запускает тесты с --nomigrations (таблицы строятся по моделям), поэтому расхождение миграции 0009 и
    модели иначе незаметно: makemigrations --check падает (SystemExit), если модели требуют новой миграции."""
    output = io.StringIO()
    call_command("makemigrations", "ppm_canvas", "--check", "--dry-run", stdout=output)
    assert "No changes detected" in output.getvalue()
