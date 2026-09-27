import io
import json
from pathlib import PurePosixPath
import zipfile

from django.conf import settings

from .links import entry_path
from .models import PpmVaultEntryKind, PpmVaultEntryStatus
from .services import PpmVaultConflict
from .storage import open_private_object


EXPORT_MANIFEST_NAME = "ppm-vault-manifest.json"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def _safe_export_path(entry):
    raw_path = entry_path(entry)
    path = PurePosixPath(raw_path)
    if not raw_path or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise PpmVaultConflict(code="VAULT_EXPORT_PATH_INVALID", message="В хранилище найден небезопасный путь.")
    return path.as_posix()


def _zip_info(path, *, directory=False):
    info = zipfile.ZipInfo(f"{path}/" if directory else path, date_time=ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (0o40755 if directory else 0o100644) << 16
    return info


def _read_binary_version(entry, *, remaining_bytes):
    file_obj = open_private_object(entry.current_version.object_key, max_bytes=remaining_bytes)
    if file_obj is None:
        raise PpmVaultConflict(
            code="VAULT_STORAGE_FAILED",
            message=f"Не удалось прочитать файл «{entry.name}» для экспорта.",
        )
    try:
        payload = file_obj.read(remaining_bytes + 1)
    finally:
        file_obj.close()
    if len(payload) > remaining_bytes:
        raise PpmVaultConflict(code="VAULT_EXPORT_TOO_LARGE", message="Экспорт превышает допустимый размер.")
    return payload


def build_vault_export(vault):
    entries = list(
        vault.entries.filter(status=PpmVaultEntryStatus.ACTIVE)
        .exclude(id=vault.root_entry_id)
        .select_related("current_version", "parent", "parent__parent", "parent__parent__parent")
    )
    paths = [(entry, _safe_export_path(entry)) for entry in entries]
    paths.sort(key=lambda item: (item[1].casefold(), str(item[0].id)))
    maximum_bytes = getattr(settings, "PPM_VAULT_EXPORT_MAX_BYTES", 262_144_000)
    total_bytes = 0
    manifest_entries = []
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as bundle:
        for entry, path in paths:
            manifest_entries.append(
                {
                    "id": str(entry.id),
                    "kind": entry.kind,
                    "path": path,
                    "version": entry.version,
                    "content_hash": entry.content_hash or "",
                    "size_bytes": entry.size_bytes,
                    "mime_type": entry.mime_type or "",
                }
            )
            if entry.kind == PpmVaultEntryKind.FOLDER:
                bundle.writestr(_zip_info(path, directory=True), b"")
                continue
            if entry.current_version is None:
                raise PpmVaultConflict(code="VAULT_EXPORT_VERSION_MISSING", message="У материала отсутствует версия.")
            if entry.kind == PpmVaultEntryKind.MARKDOWN:
                payload = entry.current_version.content_text.encode("utf-8")
            else:
                payload = _read_binary_version(entry, remaining_bytes=maximum_bytes - total_bytes)
            total_bytes += len(payload)
            if total_bytes > maximum_bytes:
                raise PpmVaultConflict(code="VAULT_EXPORT_TOO_LARGE", message="Экспорт превышает допустимый размер.")
            bundle.writestr(_zip_info(path), payload)

        manifest = {
            "schema_version": 1,
            "vault_id": str(vault.id),
            "workspace_id": str(vault.workspace_id),
            "project_id": str(vault.project_id),
            "snapshot_updated_at": vault.updated_at.isoformat(),
            "entries": manifest_entries,
        }
        manifest_payload = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        bundle.writestr(_zip_info(EXPORT_MANIFEST_NAME), manifest_payload)
    archive.seek(0)
    return archive
