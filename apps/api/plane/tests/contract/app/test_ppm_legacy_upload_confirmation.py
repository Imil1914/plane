"""Every upload-confirmation route must verify the stored object first."""

from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from rest_framework import status

from plane.db.models import DeployBoard, FileAsset, Issue
from plane.tests.factories import ProjectFactory, ProjectMemberFactory, WorkspaceFactory, WorkspaceMemberFactory


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def missing_object():
    return ClientError({"Error": {"Code": "404", "Message": "not found"}}, "HeadObject")


@pytest.mark.parametrize("server_route", [False, True])
def test_public_user_asset_cannot_confirm_missing_file(api_key_client, create_user, server_route):
    asset = FileAsset.objects.create(
        asset="pending/avatar.png",
        size=16,
        attributes={"name": "avatar.png", "type": "image/png", "size": 16},
        user=create_user,
        created_by=create_user,
        entity_type="USER_AVATAR",
    )
    suffix = "server/" if server_route else ""
    with patch("plane.utils.asset_upload.S3Storage") as storage:
        storage.return_value.s3_client.head_object.side_effect = missing_object()
        response = api_key_client.patch(f"/api/v1/assets/user-assets/{asset.id}/{suffix}", {}, format="json")

    assert response.status_code == status.HTTP_409_CONFLICT
    asset.refresh_from_db()
    assert asset.is_uploaded is False


def test_public_workspace_asset_cannot_confirm_missing_file(api_key_client, create_user):
    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    asset = FileAsset.objects.create(
        asset=f"{workspace.id}/pending.pdf",
        size=16,
        attributes={"name": "pending.pdf", "type": "application/pdf", "size": 16},
        workspace=workspace,
        created_by=create_user,
        entity_type="ISSUE_ATTACHMENT",
    )
    with patch("plane.utils.asset_upload.S3Storage") as storage:
        storage.return_value.s3_client.head_object.side_effect = missing_object()
        response = api_key_client.patch(
            f"/api/v1/workspaces/{workspace.slug}/assets/{asset.id}/",
            {"is_uploaded": True},
            format="json",
        )

    assert response.status_code == status.HTTP_409_CONFLICT
    asset.refresh_from_db()
    assert asset.is_uploaded is False


def issue_asset(create_user):
    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="ATT")
    ProjectMemberFactory(workspace=workspace, project=project, member=create_user, role=20)
    issue = Issue.objects.create(name="Attachment issue", workspace=workspace, project=project, created_by=create_user)
    asset = FileAsset.objects.create(
        asset=f"{workspace.id}/pending.pdf",
        size=16,
        attributes={"name": "pending.pdf", "type": "application/pdf", "size": 16},
        workspace=workspace,
        project=project,
        issue=issue,
        created_by=create_user,
        entity_type="ISSUE_ATTACHMENT",
    )
    return workspace, project, issue, asset


def test_app_issue_attachment_cannot_confirm_missing_file(session_client, create_user):
    workspace, project, issue, asset = issue_asset(create_user)
    with (
        patch("plane.utils.asset_upload.S3Storage") as storage,
        patch("plane.app.views.issue.attachment.issue_activity.delay") as activity,
    ):
        storage.return_value.s3_client.head_object.side_effect = missing_object()
        response = session_client.patch(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/attachments/{asset.id}/",
            {},
            format="json",
        )

    assert response.status_code == status.HTTP_409_CONFLICT
    asset.refresh_from_db()
    assert asset.is_uploaded is False
    activity.assert_not_called()


def test_public_issue_attachment_cannot_confirm_missing_file(api_key_client, create_user):
    workspace, project, issue, asset = issue_asset(create_user)
    with (
        patch("plane.utils.asset_upload.S3Storage") as storage,
        patch("plane.api.views.issue.issue_activity.delay") as activity,
    ):
        storage.return_value.s3_client.head_object.side_effect = missing_object()
        response = api_key_client.patch(
            f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/issue-attachments/{asset.id}/",
            {},
            format="json",
        )

    assert response.status_code == status.HTTP_409_CONFLICT
    asset.refresh_from_db()
    assert asset.is_uploaded is False
    activity.assert_not_called()


def test_app_issue_attachment_download_signing_failure_returns_503(session_client, create_user):
    workspace, project, issue, asset = issue_asset(create_user)
    asset.is_uploaded = True
    asset.save(update_fields=["is_uploaded"])

    with patch("plane.app.views.issue.attachment.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = None
        response = session_client.get(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/attachments/{asset.id}/"
        )

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data == {"error": "File storage is temporarily unavailable."}


def test_public_issue_attachment_download_signing_failure_returns_503(api_key_client, create_user):
    workspace, project, issue, asset = issue_asset(create_user)
    asset.is_uploaded = True
    asset.save(update_fields=["is_uploaded"])

    with patch("plane.api.views.issue.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = None
        response = api_key_client.get(
            f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/issue-attachments/{asset.id}/"
        )

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data == {"error": "File storage is temporarily unavailable."}


def test_published_space_asset_cannot_confirm_missing_file(session_client, create_user):
    workspace = WorkspaceFactory(owner=create_user)
    project = ProjectFactory(workspace=workspace, identifier="PUB")
    board = DeployBoard.objects.create(
        workspace=workspace,
        project=project,
        entity_name="project",
        entity_identifier=project.id,
        anchor="test-asset-upload",
    )
    asset = FileAsset.objects.create(
        asset=f"{workspace.id}/pending.png",
        size=16,
        attributes={"name": "pending.png", "type": "image/png", "size": 16},
        workspace=workspace,
        project=project,
        created_by=create_user,
        entity_type="COMMENT_DESCRIPTION",
    )
    with patch("plane.utils.asset_upload.S3Storage") as storage:
        storage.return_value.s3_client.head_object.side_effect = missing_object()
        response = session_client.patch(f"/api/public/assets/v2/anchor/{board.anchor}/{asset.id}/", {}, format="json")

    assert response.status_code == status.HTTP_409_CONFLICT
    asset.refresh_from_db()
    assert asset.is_uploaded is False


def test_published_space_asset_download_signing_failure_returns_503(session_client, create_user):
    workspace = WorkspaceFactory(owner=create_user)
    project = ProjectFactory(workspace=workspace, identifier="PUB")
    board = DeployBoard.objects.create(
        workspace=workspace,
        project=project,
        entity_name="project",
        entity_identifier=project.id,
        anchor="test-asset-download",
    )
    asset = FileAsset.objects.create(
        asset=f"{workspace.id}/published.png",
        size=16,
        attributes={"name": "published.png", "type": "image/png", "size": 16},
        workspace=workspace,
        project=project,
        created_by=create_user,
        entity_type="COMMENT_DESCRIPTION",
        is_uploaded=True,
    )

    with patch("plane.space.views.asset.S3Storage") as storage:
        storage.return_value.generate_presigned_url.return_value = None
        response = session_client.get(f"/api/public/assets/v2/anchor/{board.anchor}/{asset.id}/")

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data == {"error": "File storage is temporarily unavailable."}
