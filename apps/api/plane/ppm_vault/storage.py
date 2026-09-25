import os
from pathlib import Path
import shutil

from django.conf import settings
from botocore.exceptions import BotoCoreError, ClientError

from plane.settings.storage import S3Storage


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
    return storage.upload_file(
        file_obj,
        object_key,
        content_type=content_type,
        extra_args={"ACL": "private"},
    )


def open_private_object(object_key):
    if use_local_vault_storage():
        return _safe_local_path(object_key).open("rb")
    try:
        return S3Storage().open(object_key, "rb")
    except (BotoCoreError, ClientError, OSError):
        return None


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
    S3Storage().delete_files([object_key])


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
    return bool(S3Storage().copy_object(source_key, destination_key))
