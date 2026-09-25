"""Presigned upload failures must not leave an unusable asset behind."""

from unittest.mock import patch

import pytest
from rest_framework import status

from plane.db.models import FileAsset
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.tests.factories import ProjectFactory, ProjectMemberFactory, WorkspaceFactory, WorkspaceMemberFactory


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.mark.parametrize("scope", ["user", "workspace", "project"])
def test_failed_presign_returns_503_without_creating_asset(session_client, create_user, scope):
    url = "/api/assets/v2/user-assets/"
    entity_type = "USER_AVATAR"
    if scope != "user":
        workspace = WorkspaceFactory(owner=create_user)
        WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
        url = f"/api/assets/v2/workspaces/{workspace.slug}/"
        entity_type = "WORKSPACE_LOGO"
        if scope == "project":
            project = ProjectFactory(workspace=workspace, identifier="PIC")
            ProjectMemberFactory(workspace=workspace, project=project, member=create_user, role=20)
            url = f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/"
            entity_type = "PROJECT_COVER"

    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = None
        response = session_client.post(
            url,
            {"entity_type": entity_type, "name": "image.png", "type": "image/png", "size": 16},
            format="json",
        )

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data == {"error": "Upload storage is unavailable."}
    assert FileAsset.objects.count() == 0


@pytest.mark.parametrize("scope", ["workspace", "project"])
def test_cover_upload_uses_scope_from_url(session_client, create_user, scope):
    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    url = f"/api/assets/v2/workspaces/{workspace.slug}/"
    entity_type = "WORKSPACE_LOGO"
    project = None
    if scope == "project":
        project = ProjectFactory(workspace=workspace, identifier="COV")
        ProjectMemberFactory(workspace=workspace, project=project, member=create_user, role=20)
        url = f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/"
        entity_type = "PROJECT_COVER"

    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test/upload", "fields": {}}
        response = session_client.post(
            url,
            {"entity_type": entity_type, "name": "cover.png", "type": "image/png", "size": 16},
            format="json",
        )

    assert response.status_code == status.HTTP_200_OK
    asset = FileAsset.objects.get(id=response.data["asset_id"])
    assert asset.workspace_id == workspace.id
    assert asset.project_id == (project.id if project is not None else None)


def test_workspace_asset_upload_cannot_sign_another_projects_cover(session_client, create_user):
    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="DENY")

    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        response = session_client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/",
            {
                "entity_type": "PROJECT_COVER",
                "entity_identifier": str(project.id),
                "name": "cover.png",
                "type": "image/png",
                "size": 16,
            },
            format="json",
        )

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert FileAsset.objects.count() == 0
    storage.assert_not_called()


def test_global_admin_can_sign_project_cover_without_project_membership(session_client, create_user):
    workspace = WorkspaceFactory(owner=create_user)
    project = ProjectFactory(workspace=workspace, identifier="ADM")
    PpmGlobalAdmin.objects.create(user=create_user, reason="Protected test bootstrap")

    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://storage.test", "fields": {}}
        response = session_client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/",
            {
                "entity_type": "PROJECT_COVER",
                "entity_identifier": str(project.id),
                "name": "cover.png",
                "type": "image/png",
                "size": 16,
            },
            format="json",
        )

    assert response.status_code == status.HTTP_200_OK
    assert FileAsset.objects.get(id=response.data["asset_id"]).project_id == project.id
