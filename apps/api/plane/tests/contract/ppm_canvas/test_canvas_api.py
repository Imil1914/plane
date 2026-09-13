import uuid

import pytest
from django.core.exceptions import ValidationError
from rest_framework import status

from plane.ppm_canvas.models import PpmCanvasVersion, PpmProjectCanvas
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user():
    marker = uuid.uuid4().hex
    return UserFactory(username=f"ppm-{marker}", email=f"ppm-{marker}@plane.test")


def canvas_url(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/"


def snapshot(label="one"):
    return {
        "document": {
            "store": {
                f"shape:{label}": {
                    "id": f"shape:{label}",
                    "typeName": "shape",
                    "type": "ppm-canvas-node",
                }
            }
        },
        "session": {},
    }


def save_payload(*, base_version=0, operation_id=None, value=None):
    return {
        "schema_version": 1,
        "base_version": base_version,
        "snapshot": value or snapshot(),
        "client_operation_id": str(operation_id or uuid.uuid4()),
    }


@pytest.fixture
def canvas_project():
    user = make_user()
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="CAN")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    return user, workspace, project


def authenticate(api_client, user):
    api_client.force_authenticate(user=user)


def test_first_open_is_idempotent_and_project_scoped(api_client, canvas_project):
    user, workspace, project = canvas_project
    authenticate(api_client, user)

    first = api_client.get(canvas_url(workspace, project))
    second = api_client.get(canvas_url(workspace, project))

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_200_OK
    assert first.data["canvas_id"] == second.data["canvas_id"]
    assert first.data["version"] == 0
    assert first.data["snapshot_status"] == "empty"
    assert first.data["access"] == "edit"
    assert PpmProjectCanvas.objects.filter(workspace_id=workspace.id, project_id=project.id).count() == 1

    second_project = ProjectFactory(workspace=workspace, identifier="CAN2")
    ProjectMemberFactory(workspace=workspace, project=second_project, member=user, role=15)
    other = api_client.get(canvas_url(workspace, second_project))
    assert other.status_code == status.HTTP_200_OK
    assert other.data["canvas_id"] != first.data["canvas_id"]


def test_successful_save_is_versioned_audited_and_immutable(api_client, canvas_project):
    user, workspace, project = canvas_project
    authenticate(api_client, user)
    api_client.get(canvas_url(workspace, project))

    response = api_client.put(canvas_url(workspace, project), save_payload(), format="json")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["version"] == 1
    assert len(response.data["content_hash"]) == 64
    assert response.data["saved_by"] == str(user.id)
    assert response.data["saved_at"]
    saved = PpmCanvasVersion.objects.get()
    assert saved.request_id
    assert saved.created_by == user.id
    assert saved.canvas.current_version == 1

    saved.content_hash = "0" * 64
    with pytest.raises(ValidationError, match="immutable"):
        saved.save()
    with pytest.raises(ValidationError, match="immutable"):
        saved.delete()


def test_reload_returns_the_saved_snapshot(api_client, canvas_project):
    user, workspace, project = canvas_project
    authenticate(api_client, user)
    expected = snapshot("reload")
    api_client.put(canvas_url(workspace, project), save_payload(value=expected), format="json")

    response = api_client.get(canvas_url(workspace, project))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["snapshot_status"] == "ready"
    assert response.data["snapshot"] == expected
    assert response.data["version"] == 1


def test_stale_second_user_save_conflicts_without_overwrite(api_client, canvas_project):
    first_user, workspace, project = canvas_project
    second_user = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=second_user, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=second_user, role=15)

    authenticate(api_client, first_user)
    first_open = api_client.get(canvas_url(workspace, project))
    authenticate(api_client, second_user)
    second_open = api_client.get(canvas_url(workspace, project))
    assert first_open.data["canvas_id"] == second_open.data["canvas_id"]

    authenticate(api_client, first_user)
    saved = api_client.put(canvas_url(workspace, project), save_payload(base_version=0), format="json")
    authenticate(api_client, second_user)
    conflict = api_client.put(
        canvas_url(workspace, project),
        save_payload(base_version=0, value=snapshot("stale")),
        format="json",
    )

    assert saved.status_code == status.HTTP_200_OK
    assert conflict.status_code == status.HTTP_409_CONFLICT
    assert conflict.data["error"]["code"] == "CANVAS_VERSION_CONFLICT"
    assert conflict.data["error"]["details"]["current_version"] == 1
    assert PpmCanvasVersion.objects.count() == 1


def test_operation_id_retry_is_idempotent(api_client, canvas_project):
    user, workspace, project = canvas_project
    authenticate(api_client, user)
    operation_id = uuid.uuid4()
    payload = save_payload(operation_id=operation_id)

    first = api_client.put(canvas_url(workspace, project), payload, format="json")
    retry = api_client.put(canvas_url(workspace, project), payload, format="json")

    assert first.status_code == status.HTTP_200_OK
    assert retry.status_code == status.HTTP_200_OK
    assert retry.data["version"] == first.data["version"]
    assert retry.data["content_hash"] == first.data["content_hash"]
    assert retry.data["idempotent_replay"] is True
    assert PpmCanvasVersion.objects.count() == 1

    reused = api_client.put(
        canvas_url(workspace, project),
        save_payload(operation_id=operation_id, value=snapshot("different")),
        format="json",
    )
    assert reused.status_code == status.HTTP_409_CONFLICT
    assert reused.data["error"]["code"] == "CANVAS_OPERATION_REUSED"
    assert PpmCanvasVersion.objects.count() == 1


@pytest.mark.parametrize("role,expected_access", [(20, "edit"), (15, "edit"), (5, "read")])
def test_permission_matrix_for_active_project_members(api_client, role, expected_access):
    user = make_user()
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=role)
    project = ProjectFactory(workspace=workspace, identifier=f"R{role}")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=role)
    authenticate(api_client, user)

    read = api_client.get(canvas_url(workspace, project))
    write = api_client.put(canvas_url(workspace, project), save_payload(), format="json")

    assert read.status_code == status.HTTP_200_OK
    assert read.data["access"] == expected_access
    assert write.status_code == (status.HTTP_200_OK if expected_access == "edit" else status.HTTP_403_FORBIDDEN)


def test_unauthenticated_and_outsider_are_denied(api_client, canvas_project):
    _, workspace, project = canvas_project
    unauthenticated = api_client.get(canvas_url(workspace, project))
    assert unauthenticated.status_code == status.HTTP_401_UNAUTHORIZED
    assert unauthenticated.data["error"]["code"] == "AUTHENTICATION_REQUIRED"

    outsider = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=20)
    authenticate(api_client, outsider)
    read = api_client.get(canvas_url(workspace, project))
    write = api_client.put(canvas_url(workspace, project), save_payload(), format="json")
    assert read.status_code == status.HTTP_403_FORBIDDEN
    assert write.status_code == status.HTTP_403_FORBIDDEN
    assert PpmProjectCanvas.objects.count() == 0


def test_cross_workspace_scope_is_denied(api_client, canvas_project):
    user, _, project = canvas_project
    other_workspace = WorkspaceFactory(owner=make_user())
    WorkspaceMemberFactory(workspace=other_workspace, member=user, role=20)
    authenticate(api_client, user)

    response = api_client.get(canvas_url(other_workspace, project))

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert PpmProjectCanvas.objects.count() == 0


def test_corrupt_snapshot_falls_back_without_mutation(api_client, canvas_project):
    user, workspace, project = canvas_project
    canvas = PpmProjectCanvas.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        created_by=user.id,
        current_version=1,
    )
    PpmCanvasVersion.objects.create(
        canvas=canvas,
        version=1,
        snapshot_json={"not_document": True},
        content_hash="0" * 64,
        client_operation_id=uuid.uuid4(),
        request_id=uuid.uuid4(),
        created_by=user.id,
    )
    authenticate(api_client, user)

    response = api_client.get(canvas_url(workspace, project))

    canvas.refresh_from_db()
    assert response.status_code == status.HTTP_200_OK
    assert response.data["snapshot_status"] == "corrupt"
    assert response.data["snapshot"] is None
    assert canvas.current_version == 1
    assert PpmCanvasVersion.objects.count() == 1


def test_invalid_and_oversized_snapshots_are_rejected(api_client, canvas_project):
    user, workspace, project = canvas_project
    authenticate(api_client, user)

    invalid = api_client.put(canvas_url(workspace, project), save_payload(value={"wrong": {}}), format="json")
    oversized = api_client.put(
        canvas_url(workspace, project),
        save_payload(value={"document": {"padding": "x" * (2 * 1024 * 1024)}}),
        format="json",
    )

    assert invalid.status_code == status.HTTP_400_BAD_REQUEST
    assert invalid.data["error"]["code"] == "CANVAS_INVALID_SNAPSHOT"
    assert oversized.status_code == status.HTTP_400_BAD_REQUEST
    assert oversized.data["error"]["code"] == "CANVAS_INVALID_SNAPSHOT"
    assert PpmCanvasVersion.objects.count() == 0
