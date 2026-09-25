"""Shared confirmation of uploaded files before exposing them to users."""

from pathlib import Path

from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from rest_framework import status
from rest_framework.response import Response

from plane.settings.storage import S3Storage


def local_asset_root():
    return Path(settings.BASE_DIR, "uploads", "ppm-local-assets").resolve()


def local_asset_path(asset):
    raw_path = (asset.storage_metadata or {}).get("ppm_local_path")
    if not raw_path:
        return None
    root = local_asset_root()
    candidate = Path(raw_path).resolve()
    if candidate != root and root not in candidate.parents:
        return None
    return candidate


def upload_confirmation_error(asset, storage_factory=None):
    """Return a safe API error until the object exists at an allowed size."""
    local_path = local_asset_path(asset)
    if local_path is not None:
        try:
            actual_size = local_path.stat().st_size
        except FileNotFoundError:
            actual_size = None
        except OSError:
            return Response(
                {"error": "File storage is temporarily unavailable.", "status": False},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
    else:
        storage = (storage_factory or S3Storage)()
        try:
            response = storage.s3_client.head_object(
                Bucket=settings.AWS_STORAGE_BUCKET_NAME,
                Key=asset.asset.name,
            )
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                actual_size = None
            else:
                return Response(
                    {"error": "File storage is temporarily unavailable.", "status": False},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
        except BotoCoreError:
            return Response(
                {"error": "File storage is temporarily unavailable.", "status": False},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        else:
            actual_size = response.get("ContentLength")

    if isinstance(actual_size, bool) or not isinstance(actual_size, int) or not 0 < actual_size <= asset.size:
        return Response(
            {"error": "Uploaded file was not found or failed validation.", "status": False},
            status=status.HTTP_409_CONFLICT,
        )
    return None
