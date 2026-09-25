# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import os
from unittest.mock import Mock, patch
import pytest
from botocore.exceptions import ClientError
from plane.settings.storage import S3Storage


@pytest.mark.unit
class TestS3StorageSignedURLExpiration:
    """Test the configurable signed URL expiration in S3Storage"""

    @patch.dict(os.environ, {"AWS_S3_BUCKET_NAME": "test-bucket"}, clear=True)
    @patch("plane.settings.storage.boto3")
    def test_presign_error_is_redacted(self, mock_boto3, caplog):
        secret = "private-provider-detail"
        mock_boto3.client.return_value.generate_presigned_post.side_effect = ClientError(
            {"Error": {"Code": "InvalidAccessKeyId", "Message": secret}}, "GeneratePresignedPost"
        )

        assert S3Storage().generate_presigned_post("image.png", "image/png", 16) is None
        assert "Could not generate an asset upload URL" in caplog.text
        assert secret not in caplog.text

    @patch.dict(os.environ, {"AWS_S3_BUCKET_NAME": "test-bucket"}, clear=True)
    @patch("plane.settings.storage.boto3")
    def test_download_presign_error_is_redacted(self, mock_boto3, caplog):
        secret = "private-download-provider-detail"
        mock_boto3.client.return_value.generate_presigned_url.side_effect = ClientError(
            {"Error": {"Code": "InvalidAccessKeyId", "Message": secret}}, "GeneratePresignedUrl"
        )

        assert S3Storage().generate_presigned_url("image.png") is None
        assert "Could not generate an asset download URL" in caplog.text
        assert secret not in caplog.text

    @patch.dict(os.environ, {}, clear=True)
    @patch("plane.settings.storage.boto3")
    def test_default_expiration_without_env_variable(self, mock_boto3):
        """Test that default expiration is 3600 seconds when env variable is not set"""
        # Mock the boto3 client
        mock_boto3.client.return_value = Mock()

        # Create S3Storage instance without SIGNED_URL_EXPIRATION env variable
        storage = S3Storage()

        # Assert default expiration is 3600
        assert storage.signed_url_expiration == 3600

    @patch.dict(os.environ, {"SIGNED_URL_EXPIRATION": "30"}, clear=True)
    @patch("plane.settings.storage.boto3")
    def test_custom_expiration_with_env_variable(self, mock_boto3):
        """Test that expiration is read from SIGNED_URL_EXPIRATION env variable"""
        # Mock the boto3 client
        mock_boto3.client.return_value = Mock()

        # Create S3Storage instance with SIGNED_URL_EXPIRATION=30
        storage = S3Storage()

        # Assert expiration is 30
        assert storage.signed_url_expiration == 30

    @patch.dict(os.environ, {"SIGNED_URL_EXPIRATION": "300"}, clear=True)
    @patch("plane.settings.storage.boto3")
    def test_custom_expiration_multiple_values(self, mock_boto3):
        """Test that expiration works with different custom values"""
        # Mock the boto3 client
        mock_boto3.client.return_value = Mock()

        # Create S3Storage instance with SIGNED_URL_EXPIRATION=300
        storage = S3Storage()

        # Assert expiration is 300
        assert storage.signed_url_expiration == 300

    @patch.dict(
        os.environ,
        {
            "AWS_ACCESS_KEY_ID": "test-key",
            "AWS_SECRET_ACCESS_KEY": "test-secret",
            "AWS_S3_BUCKET_NAME": "test-bucket",
            "AWS_REGION": "us-east-1",
        },
        clear=True,
    )
    @patch("plane.settings.storage.boto3")
    def test_generate_presigned_post_uses_default_expiration(self, mock_boto3):
        """Test that generate_presigned_post uses the configured default expiration"""
        # Mock the boto3 client and its response
        mock_s3_client = Mock()
        mock_s3_client.generate_presigned_post.return_value = {
            "url": "https://test-url.com",
            "fields": {},
        }
        mock_boto3.client.return_value = mock_s3_client

        # Create S3Storage instance
        storage = S3Storage()

        # Call generate_presigned_post without explicit expiration
        storage.generate_presigned_post("test-object", "image/png", 1024)

        # Assert that the boto3 method was called with the default expiration (3600)
        mock_s3_client.generate_presigned_post.assert_called_once()
        call_kwargs = mock_s3_client.generate_presigned_post.call_args[1]
        assert call_kwargs["ExpiresIn"] == 3600

    @patch.dict(
        os.environ,
        {
            "AWS_ACCESS_KEY_ID": "test-key",
            "AWS_SECRET_ACCESS_KEY": "test-secret",
            "AWS_S3_BUCKET_NAME": "test-bucket",
            "AWS_REGION": "us-east-1",
            "SIGNED_URL_EXPIRATION": "60",
        },
        clear=True,
    )
    @patch("plane.settings.storage.boto3")
    def test_generate_presigned_post_uses_custom_expiration(self, mock_boto3):
        """Test that generate_presigned_post uses custom expiration from env variable"""
        # Mock the boto3 client and its response
        mock_s3_client = Mock()
        mock_s3_client.generate_presigned_post.return_value = {
            "url": "https://test-url.com",
            "fields": {},
        }
        mock_boto3.client.return_value = mock_s3_client

        # Create S3Storage instance with SIGNED_URL_EXPIRATION=60
        storage = S3Storage()

        # Call generate_presigned_post without explicit expiration
        storage.generate_presigned_post("test-object", "image/png", 1024)

        # Assert that the boto3 method was called with custom expiration (60)
        mock_s3_client.generate_presigned_post.assert_called_once()
        call_kwargs = mock_s3_client.generate_presigned_post.call_args[1]
        assert call_kwargs["ExpiresIn"] == 60

    @patch.dict(
        os.environ,
        {
            "AWS_ACCESS_KEY_ID": "test-key",
            "AWS_SECRET_ACCESS_KEY": "test-secret",
            "AWS_S3_BUCKET_NAME": "test-bucket",
            "AWS_REGION": "us-east-1",
        },
        clear=True,
    )
    @patch("plane.settings.storage.boto3")
    def test_generate_presigned_url_uses_default_expiration(self, mock_boto3):
        """Test that generate_presigned_url uses the configured default expiration"""
        # Mock the boto3 client and its response
        mock_s3_client = Mock()
        mock_s3_client.generate_presigned_url.return_value = "https://test-url.com"
        mock_boto3.client.return_value = mock_s3_client

        # Create S3Storage instance
        storage = S3Storage()

        # Call generate_presigned_url without explicit expiration
        storage.generate_presigned_url("test-object")

        # Assert that the boto3 method was called with the default expiration (3600)
        mock_s3_client.generate_presigned_url.assert_called_once()
        call_kwargs = mock_s3_client.generate_presigned_url.call_args[1]
        assert call_kwargs["ExpiresIn"] == 3600

    @patch.dict(
        os.environ,
        {
            "AWS_ACCESS_KEY_ID": "test-key",
            "AWS_SECRET_ACCESS_KEY": "test-secret",
            "AWS_S3_BUCKET_NAME": "test-bucket",
            "AWS_REGION": "us-east-1",
            "SIGNED_URL_EXPIRATION": "30",
        },
        clear=True,
    )
    @patch("plane.settings.storage.boto3")
    def test_generate_presigned_url_uses_custom_expiration(self, mock_boto3):
        """Test that generate_presigned_url uses custom expiration from env variable"""
        # Mock the boto3 client and its response
        mock_s3_client = Mock()
        mock_s3_client.generate_presigned_url.return_value = "https://test-url.com"
        mock_boto3.client.return_value = mock_s3_client

        # Create S3Storage instance with SIGNED_URL_EXPIRATION=30
        storage = S3Storage()

        # Call generate_presigned_url without explicit expiration
        storage.generate_presigned_url("test-object")

        # Assert that the boto3 method was called with custom expiration (30)
        mock_s3_client.generate_presigned_url.assert_called_once()
        call_kwargs = mock_s3_client.generate_presigned_url.call_args[1]
        assert call_kwargs["ExpiresIn"] == 30

    @patch.dict(
        os.environ,
        {
            "AWS_ACCESS_KEY_ID": "test-key",
            "AWS_SECRET_ACCESS_KEY": "test-secret",
            "AWS_S3_BUCKET_NAME": "test-bucket",
            "AWS_REGION": "us-east-1",
            "SIGNED_URL_EXPIRATION": "30",
        },
        clear=True,
    )
    @patch("plane.settings.storage.boto3")
    def test_explicit_expiration_overrides_default(self, mock_boto3):
        """Test that explicit expiration parameter overrides the default"""
        # Mock the boto3 client and its response
        mock_s3_client = Mock()
        mock_s3_client.generate_presigned_url.return_value = "https://test-url.com"
        mock_boto3.client.return_value = mock_s3_client

        # Create S3Storage instance with SIGNED_URL_EXPIRATION=30
        storage = S3Storage()

        # Call generate_presigned_url with explicit expiration=120
        storage.generate_presigned_url("test-object", expiration=120)

        # Assert that the boto3 method was called with explicit expiration (120)
        mock_s3_client.generate_presigned_url.assert_called_once()
        call_kwargs = mock_s3_client.generate_presigned_url.call_args[1]
        assert call_kwargs["ExpiresIn"] == 120


@pytest.mark.unit
@pytest.mark.parametrize(
    ("is_server", "expected_endpoint"),
    [(False, "https://ppm.example"), (True, "http://test-minio:9000")],
)
def test_minio_server_flag_selects_internal_or_public_endpoint(is_server, expected_endpoint):
    request = Mock(scheme="https")
    request.get_host.return_value = "ppm.example"
    environment = {
        "USE_MINIO": "1",
        "AWS_S3_ENDPOINT_URL": "http://test-minio:9000",
        "MINIO_ENDPOINT_SSL": "0",
    }
    with patch.dict(os.environ, environment, clear=True), patch("plane.settings.storage.boto3") as mock_boto3:
        S3Storage(request=request, is_server=is_server)

    assert mock_boto3.client.call_args.kwargs["endpoint_url"] == expected_endpoint


@pytest.mark.unit
def test_minio_without_request_uses_internal_endpoint():
    with (
        patch.dict(os.environ, {"USE_MINIO": "1", "AWS_S3_ENDPOINT_URL": "http://test-minio:9000"}, clear=True),
        patch("plane.settings.storage.boto3") as mock_boto3,
    ):
        S3Storage()

    assert mock_boto3.client.call_args.kwargs["endpoint_url"] == "http://test-minio:9000"


@pytest.mark.unit
def test_minio_public_endpoint_is_used_for_browser_signed_urls():
    request = Mock(scheme="http")
    request.get_host.return_value = "localhost:8000"
    environment = {
        "USE_MINIO": "1",
        "AWS_S3_ENDPOINT_URL": "http://test-minio:9000",
        "AWS_S3_PUBLIC_ENDPOINT_URL": "http://localhost:9000",
    }
    with patch.dict(os.environ, environment, clear=True), patch("plane.settings.storage.boto3") as mock_boto3:
        S3Storage(request=request)
        browser_endpoint = mock_boto3.client.call_args.kwargs["endpoint_url"]
        S3Storage(request=request, is_server=True)
        server_endpoint = mock_boto3.client.call_args.kwargs["endpoint_url"]

    assert browser_endpoint == "http://localhost:9000"
    assert server_endpoint == "http://test-minio:9000"


@pytest.mark.unit
def test_external_s3_accepts_server_flag_without_changing_endpoint():
    request = Mock(scheme="https")
    request.get_host.return_value = "ppm.example"
    with (
        patch.dict(os.environ, {"USE_MINIO": "0", "AWS_S3_ENDPOINT_URL": "https://s3.example"}, clear=True),
        patch("plane.settings.storage.boto3") as mock_boto3,
    ):
        S3Storage(request=request, is_server=True)

    assert mock_boto3.client.call_args.kwargs["endpoint_url"] == "https://s3.example"
