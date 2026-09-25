"""A failed browser-to-S3 transfer must never be reported as an uploaded asset."""

import uuid
from unittest.mock import patch
from urllib.parse import urlsplit

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from django.conf import settings
from rest_framework import status

from plane.db.models import FileAsset
from plane.settings.storage import S3Storage
from plane.tests.factories import ProjectFactory, ProjectMemberFactory, WorkspaceFactory, WorkspaceMemberFactory


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def pending_asset(create_user, scope):
    attributes = {"name": "image.png", "type": "image/png", "size": 16}
    if scope == "user":
        asset = FileAsset.objects.create(
            asset="pending/avatar.png",
            size=16,
            attributes=attributes,
            user=create_user,
            created_by=create_user,
            entity_type="USER_AVATAR",
        )
        return asset, f"/api/assets/v2/user-assets/{asset.id}/"

    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    if scope == "workspace":
        asset = FileAsset.objects.create(
            asset="pending/logo.png",
            size=16,
            attributes=attributes,
            workspace=workspace,
            created_by=create_user,
            entity_type="WORKSPACE_LOGO",
        )
        return asset, f"/api/assets/v2/workspaces/{workspace.slug}/{asset.id}/"

    project = ProjectFactory(workspace=workspace, identifier="IMG")
    ProjectMemberFactory(workspace=workspace, project=project, member=create_user, role=20)
    asset = FileAsset.objects.create(
        asset="pending/cover.png",
        size=16,
        attributes=attributes,
        workspace=workspace,
        project=project,
        created_by=create_user,
        entity_type="PROJECT_COVER",
    )
    return asset, f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{asset.id}/"


@pytest.mark.parametrize("scope", ["user", "workspace", "project"])
def test_missing_s3_object_cannot_be_confirmed(session_client, create_user, scope):
    asset, url = pending_asset(create_user, scope)
    missing = ClientError({"Error": {"Code": "404", "Message": "object not found"}}, "HeadObject")
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.s3_client.head_object.side_effect = missing
        response = session_client.patch(url, {}, format="json")

    assert response.status_code == status.HTTP_409_CONFLICT
    asset.refresh_from_db()
    assert asset.is_uploaded is False
    if scope == "user":
        create_user.refresh_from_db()
        assert create_user.avatar_asset_id is None


@pytest.mark.parametrize("scope", ["user", "workspace", "project"])
def test_existing_s3_object_can_be_confirmed(session_client, create_user, scope):
    asset, url = pending_asset(create_user, scope)
    with (
        patch("plane.app.views.asset.v2.S3Storage") as storage,
        patch("plane.app.views.asset.v2.get_asset_object_metadata.delay"),
    ):
        storage.return_value.s3_client.head_object.return_value = {"ContentLength": asset.size}
        response = session_client.patch(url, {}, format="json")

    assert response.status_code == status.HTTP_204_NO_CONTENT
    asset.refresh_from_db()
    assert asset.is_uploaded is True
    if scope == "user":
        create_user.refresh_from_db()
        assert create_user.avatar_asset_id == asset.id


def test_storage_outage_is_redacted_and_does_not_confirm_asset(session_client, create_user):
    asset, url = pending_asset(create_user, "user")
    secret = "credential-that-must-not-appear"
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.s3_client.head_object.side_effect = EndpointConnectionError(
            endpoint_url=f"https://{secret}@storage.invalid"
        )
        response = session_client.patch(url, {}, format="json")

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert secret not in str(response.data)
    asset.refresh_from_db()
    assert asset.is_uploaded is False


def test_wrong_s3_object_size_cannot_be_confirmed(session_client, create_user):
    asset, url = pending_asset(create_user, "user")
    with patch("plane.app.views.asset.v2.S3Storage") as storage:
        storage.return_value.s3_client.head_object.return_value = {"ContentLength": asset.size + 1}
        response = session_client.patch(url, {}, format="json")

    assert response.status_code == status.HTTP_409_CONFLICT
    asset.refresh_from_db()
    assert asset.is_uploaded is False


def test_real_disposable_minio_object_can_be_confirmed(session_client, create_user):
    if urlsplit(settings.AWS_S3_ENDPOINT_URL or "").hostname != "test-minio":
        pytest.skip("Real object probe is restricted to the disposable test MinIO service")

    storage = S3Storage()
    key = f"_ppm-confirm/{uuid.uuid4().hex}.png"
    content = b"\x89PNG\r\n\x1a\nconfirm"
    put_result = storage.s3_client.put_object(
        Bucket=settings.AWS_STORAGE_BUCKET_NAME,
        Key=key,
        Body=content,
        ContentType="image/png",
    )
    try:
        asset = FileAsset.objects.create(
            asset=key,
            size=len(content),
            attributes={"name": "image.png", "type": "image/png", "size": len(content)},
            user=create_user,
            created_by=create_user,
            entity_type="USER_AVATAR",
        )
        with patch("plane.app.views.asset.v2.get_asset_object_metadata.delay"):
            response = session_client.patch(f"/api/assets/v2/user-assets/{asset.id}/", {}, format="json")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        asset.refresh_from_db()
        assert asset.is_uploaded is True
        create_user.refresh_from_db()
        assert create_user.avatar_asset_id == asset.id
    finally:
        delete_args = {"Bucket": settings.AWS_STORAGE_BUCKET_NAME, "Key": key}
        if version_id := put_result.get("VersionId"):
            delete_args["VersionId"] = version_id
        storage.s3_client.delete_object(**delete_args)
