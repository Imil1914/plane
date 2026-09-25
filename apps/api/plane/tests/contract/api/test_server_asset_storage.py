"""Plane's server asset routes must use the internal object-storage endpoint."""

import os
from unittest.mock import Mock, patch

import pytest
from rest_framework import status

from plane.db.models import FileAsset


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def test_user_server_asset_presign_uses_internal_minio(api_key_client):
    s3_client = Mock()
    s3_client.generate_presigned_post.return_value = {"url": "http://test-minio:9000/uploads", "fields": {}}
    environment = {
        "USE_MINIO": "1",
        "AWS_S3_ENDPOINT_URL": "http://test-minio:9000",
        "AWS_S3_BUCKET_NAME": "uploads",
    }
    with (
        patch.dict(os.environ, environment),
        patch("plane.settings.storage.boto3.client", return_value=s3_client) as client,
    ):
        response = api_key_client.post(
            "/api/v1/assets/user-assets/server/",
            {"name": "avatar.png", "type": "image/png", "size": 16, "entity_type": "USER_AVATAR"},
            format="json",
        )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["upload_data"]["url"] == "http://test-minio:9000/uploads"
    assert client.call_args.kwargs["endpoint_url"] == "http://test-minio:9000"


def test_generic_asset_download_uses_internal_minio(api_key_client, create_user, workspace):
    asset = FileAsset.objects.create(
        attributes={"name": "file.pdf", "type": "application/pdf", "size": 16},
        asset=f"{workspace.id}/file.pdf",
        size=16,
        workspace=workspace,
        created_by=create_user,
        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        is_uploaded=True,
    )
    s3_client = Mock()
    s3_client.generate_presigned_url.return_value = "http://test-minio:9000/uploads/file.pdf"
    environment = {
        "USE_MINIO": "1",
        "AWS_S3_ENDPOINT_URL": "http://test-minio:9000",
        "AWS_S3_BUCKET_NAME": "uploads",
    }
    with (
        patch.dict(os.environ, environment),
        patch("plane.settings.storage.boto3.client", return_value=s3_client) as client,
    ):
        response = api_key_client.get(f"/api/v1/workspaces/{workspace.slug}/assets/{asset.id}/")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["asset_url"] == "http://test-minio:9000/uploads/file.pdf"
    assert client.call_args.kwargs["endpoint_url"] == "http://test-minio:9000"
