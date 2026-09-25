"""Failed S3 signing must never produce an empty redirect or success payload."""

from unittest.mock import patch

import pytest
from rest_framework import status

from plane.db.models import FileAsset
from plane.tests.factories import ProjectFactory, ProjectMemberFactory, WorkspaceFactory, WorkspaceMemberFactory


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.mark.parametrize("route", ["workspace", "project", "static", "workspace_download", "project_download"])
def test_app_asset_download_signing_failure_returns_503(session_client, create_user, route):
    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="DL")
    ProjectMemberFactory(workspace=workspace, project=project, member=create_user, role=20)
    asset = FileAsset.objects.create(
        asset=f"{workspace.id}/cover.png",
        size=16,
        attributes={"name": "cover.png", "type": "image/png", "size": 16},
        workspace=workspace,
        project=project,
        created_by=create_user,
        entity_type="PROJECT_COVER",
        is_uploaded=True,
    )
    urls = {
        "workspace": f"/api/assets/v2/workspaces/{workspace.slug}/{asset.id}/",
        "project": f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{asset.id}/",
        "static": f"/api/assets/v2/static/{asset.id}/",
        "workspace_download": f"/api/assets/v2/workspaces/{workspace.slug}/download/{asset.id}/",
        "project_download": f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/download/{asset.id}/",
    }

    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = None
        response = session_client.get(urls[route])

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data == {"error": "File storage is temporarily unavailable."}
