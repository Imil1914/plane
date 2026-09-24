"""Isolated MinIO helpers used only by the AF1.2 disposable restore drill."""

import hashlib
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.core.management.base import CommandError


ASSET_NAME = "af12-plane-attachment-proof.txt"
ASSET_CONTENT = b"PPM AF1.2 synthetic Plane attachment restore proof\n"
ASSET_HASH = hashlib.sha256(ASSET_CONTENT).hexdigest()


def guarded_asset_client(*, restored=False):
    """Refuse to access any object store except the two disposable test services."""
    expected_endpoint = "http://test-minio-restore:9000" if restored else "http://test-minio:9000"
    expected_bucket = "ppm-af12-restore" if restored else "ppm-af12-source"
    if (
        os.environ.get("AWS_S3_ENDPOINT_URL") != expected_endpoint
        or os.environ.get("AWS_S3_BUCKET_NAME") != expected_bucket
    ):
        raise CommandError("AF1.2 object storage is not the disposable MinIO service and bucket.")
    return boto3.client("s3", endpoint_url=expected_endpoint), expected_bucket


def read_asset_object(client, bucket, key):
    try:
        return client.get_object(Bucket=bucket, Key=key)["Body"].read()
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in {"NoSuchKey", "NoSuchBucket", "404"}:
            raise CommandError("AF1.2 Plane attachment object missing after restore.") from exc
        raise CommandError("AF1.2 Plane attachment object could not be read.") from exc
    except BotoCoreError as exc:
        raise CommandError("AF1.2 Plane attachment object could not be read.") from exc
