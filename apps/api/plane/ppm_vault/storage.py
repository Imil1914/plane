import io
import logging
import os
from pathlib import Path
import shutil

from django.conf import settings
from botocore.exceptions import BotoCoreError, ClientError

from plane.settings.storage import S3Storage


logger = logging.getLogger("plane.api")

# Object-storage failures (unreachable endpoint, timeout, closed connection, missing object) become the
# Vault's normal "storage failed" outcome instead of a 500.
STORAGE_ERRORS = (BotoCoreError, ClientError, OSError)

# Largest object a server-side reader holds in memory (the ZIP export's total budget); PPM_VAULT_READ_MAX_BYTES
# overrides it. Readers with their own smaller limit (preview 16 MiB, export's remaining budget) pass max_bytes.
READ_MAX_BYTES_DEFAULT = 262_144_000


def _log_storage_failure(message, exc):
    fields = {"error": type(exc).__name__}
    if isinstance(exc, ClientError):
        # The S3 error code (NoSuchKey, AccessDenied, SignatureDoesNotMatch, ...) names the cause and is not secret.
        fields["code"] = str(exc.response.get("Error", {}).get("Code", ""))[:64]
    logger.warning(message, extra=fields)


def use_local_vault_storage():
    return bool(getattr(settings, "PPM_LOCAL_ASSET_UPLOADS", False))


def local_vault_root():
    configured = getattr(settings, "PPM_VAULT_STORAGE_ROOT", None)
    return Path(configured or (Path(settings.BASE_DIR) / "private" / "ppm-vault")).resolve()


def _safe_local_path(object_key):
    root = local_vault_root()
    candidate = (root / object_key).resolve()
    if root not in candidate.parents:
        raise ValueError("Invalid Vault object key.")
    return candidate


def put_private_object(*, object_key, file_obj, content_type):
    if use_local_vault_storage():
        path = _safe_local_path(object_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.uploading")
        with temporary.open("wb") as target:
            for chunk in file_obj.chunks():
                target.write(chunk)
        os.replace(temporary, path)
        return True

    storage = S3Storage()
    try:
        return storage.upload_file(
            file_obj,
            object_key,
            content_type=content_type,
            extra_args={"ACL": "private"},
        )
    except STORAGE_ERRORS as exc:
        _log_storage_failure("PPM vault object upload failed", exc)
        return False


def open_private_object(object_key, *, max_bytes=None):
    """Readable file object with the object's bytes, or None when object storage cannot serve it.

    S3 reads go through the boto3 client: `S3Storage` never initialises `S3Boto3Storage`, so its django-storages
    `open()` is unusable. The copy is held in memory, so it is bounded: with ``max_bytes`` (below the ceiling) at
    most ``max_bytes + 1`` bytes are loaded and the caller detects "too large" by length; otherwise an object above
    PPM_VAULT_READ_MAX_BYTES is refused (None) — by its ContentLength before the body is read. Every storage error
    surfaces here (as None) instead of inside a later read()."""
    if use_local_vault_storage():
        return _safe_local_path(object_key).open("rb")
    ceiling = int(getattr(settings, "PPM_VAULT_READ_MAX_BYTES", READ_MAX_BYTES_DEFAULT))
    if max_bytes is not None and int(max_bytes) < ceiling:
        read_limit, refuse_above = int(max_bytes), None
    else:
        read_limit, refuse_above = ceiling, ceiling
    storage = S3Storage()
    try:
        response = storage.s3_client.get_object(Bucket=storage.aws_storage_bucket_name, Key=object_key)
        body = response["Body"]
        try:
            if refuse_above is not None and int(response.get("ContentLength") or 0) > refuse_above:
                data = None
            else:
                data = body.read(read_limit + 1)
        finally:
            body.close()
    except STORAGE_ERRORS as exc:
        _log_storage_failure("PPM vault object read failed", exc)
        return None
    if data is None or (refuse_above is not None and len(data) > refuse_above):
        logger.warning("PPM vault object read refused", extra={"error": "ObjectTooLarge", "limit": refuse_above})
        return None
    return io.BytesIO(data)


def private_object_url(*, object_key, filename, disposition="inline"):
    if use_local_vault_storage():
        return None
    return S3Storage().generate_presigned_url(
        object_key,
        expiration=300,
        disposition=disposition,
        filename=filename,
    )


def delete_private_object(object_key):
    if not object_key:
        return
    if use_local_vault_storage():
        path = _safe_local_path(object_key)
        if path.exists():
            path.unlink()
        return
    try:
        S3Storage().delete_files([object_key])
    except STORAGE_ERRORS as exc:
        # Best-effort cleanup: never mask the error that triggered it.
        _log_storage_failure("PPM vault object delete failed", exc)


def copy_private_object(*, source_key, destination_key):
    if use_local_vault_storage():
        source = _safe_local_path(source_key)
        destination = _safe_local_path(destination_key)
        if not source.exists():
            return False
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(f"{destination.suffix}.copying")
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
        return True
    try:
        return bool(S3Storage().copy_object(source_key, destination_key))
    except STORAGE_ERRORS as exc:
        _log_storage_failure("PPM vault object copy failed", exc)
        return False
