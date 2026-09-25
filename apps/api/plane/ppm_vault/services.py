import codecs
import hashlib
import re
import uuid

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import (
    PpmProjectVault,
    PpmVaultEntry,
    PpmVaultEntryAlias,
    PpmVaultEntryKind,
    PpmVaultEntryStatus,
    PpmVaultVersion,
    PpmVaultVersionStatus,
    PpmVaultStatus,
)
from .formats import CODE_TEXT_EXTENSIONS
from .storage import copy_private_object, delete_private_object, put_private_object


INVALID_NAME = re.compile(r"[\\/\x00]")
IMAGE_SIGNATURES = {
    "png": ("image/png", lambda header: header.startswith(b"\x89PNG\r\n\x1a\n")),
    "jpg": ("image/jpeg", lambda header: header.startswith(b"\xff\xd8\xff")),
    "jpeg": ("image/jpeg", lambda header: header.startswith(b"\xff\xd8\xff")),
    "webp": ("image/webp", lambda header: header.startswith(b"RIFF") and header[8:12] == b"WEBP"),
    "gif": ("image/gif", lambda header: header.startswith((b"GIF87a", b"GIF89a"))),
}
REFERENCE_MIME_TYPES = {
    "csv": "text/csv",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "json": "application/json",
    "key": "application/octet-stream",
    "md": "text/markdown",
    "odp": "application/vnd.oasis.opendocument.presentation",
    "ods": "application/vnd.oasis.opendocument.spreadsheet",
    "odt": "application/vnd.oasis.opendocument.text",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "txt": "text/plain",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
ENTRY_PARENT_UNSET = object()


class PpmVaultConflict(Exception):
    def __init__(self, *, code, message, details=None):
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


def normalize_name(name):
    return " ".join(name.strip().split()).casefold()


def validate_entry_name(name, *, kind):
    name = " ".join(str(name or "").strip().split())
    if not name or len(name) > 255 or name in {".", ".."} or INVALID_NAME.search(name):
        raise PpmVaultConflict(code="VAULT_INVALID_NAME", message="Недопустимое имя материала.")
    if kind == PpmVaultEntryKind.MARKDOWN and not name.casefold().endswith(".md"):
        name = f"{name}.md"
    if kind == PpmVaultEntryKind.PDF and not name.casefold().endswith(".pdf"):
        raise PpmVaultConflict(code="VAULT_INVALID_FILE_TYPE", message="Разрешены только PDF-файлы.")
    return name


def _entry_path(entry):
    from .links import entry_path

    return entry_path(entry)


def _record_entry_alias(entry, *, user_id):
    path = _entry_path(entry)
    if not path:
        return
    PpmVaultEntryAlias.objects.get_or_create(
        entry=entry,
        normalized_path=path.casefold(),
        defaults={
            "workspace_id": entry.workspace_id,
            "project_id": entry.project_id,
            "vault": entry.vault,
            "path": path,
            "created_by": user_id,
        },
    )


def _active_descendants(entry):
    descendants = []
    queue = list(entry.children.filter(status=PpmVaultEntryStatus.ACTIVE))
    while queue:
        child = queue.pop(0)
        descendants.append(child)
        queue.extend(child.children.filter(status=PpmVaultEntryStatus.ACTIVE))
    return descendants


def _reindex_vault(vault):
    from .links import reindex_vault_links

    reindex_vault_links(vault)


def _uploaded_file_metadata(uploaded_file):
    name = validate_entry_name(uploaded_file.name, kind=PpmVaultEntryKind.FILE)
    extension = name.rsplit(".", 1)[-1].casefold() if "." in name else ""
    header = uploaded_file.read(16)
    uploaded_file.seek(0)
    if extension == "pdf" and header.startswith(b"%PDF-"):
        return name, extension, PpmVaultEntryKind.PDF, "application/pdf"
    if extension in IMAGE_SIGNATURES:
        mime_type, matches = IMAGE_SIGNATURES[extension]
        if matches(header):
            return name, extension, PpmVaultEntryKind.IMAGE, mime_type
    if extension in REFERENCE_MIME_TYPES:
        return name, extension, PpmVaultEntryKind.FILE, REFERENCE_MIME_TYPES[extension]
    if extension in CODE_TEXT_EXTENSIONS:
        _require_utf8_text(uploaded_file)
        return name, extension, PpmVaultEntryKind.FILE, "text/plain"
    raise PpmVaultConflict(
        code="VAULT_INVALID_FILE_TYPE",
        message="Разрешены PDF, PNG, JPEG, WebP, GIF, офисные и текстовые файлы, исходный код.",
    )


def _require_utf8_text(uploaded_file):
    if int(getattr(uploaded_file, "size", 0) or 0) > _binary_limit(PpmVaultEntryKind.FILE):
        return  # the caller rejects the size; oversized input is never decoded
    decoder = codecs.getincrementaldecoder("utf-8-sig")("strict")
    try:
        for chunk in uploaded_file.chunks():
            if b"\x00" in chunk:
                raise ValueError("NUL byte in a text file")
            decoder.decode(chunk)
        decoder.decode(b"", final=True)
    except ValueError as exc:  # UnicodeDecodeError is a ValueError
        raise PpmVaultConflict(
            code="VAULT_INVALID_FILE_TYPE",
            message="Файл с кодом должен быть текстом в кодировке UTF-8.",
        ) from exc
    finally:
        uploaded_file.seek(0)


def _suggest_free_name(*, vault, parent, name):
    stem, dot, extension = name.rpartition(".")
    if not dot or not stem:
        stem, extension = name, ""
    suffix = f".{extension}" if extension else ""
    taken = set(
        PpmVaultEntry.objects.filter(
            vault=vault,
            parent=parent,
            normalized_name__startswith=normalize_name(stem),
            status__in=[PpmVaultEntryStatus.ACTIVE, PpmVaultEntryStatus.QUARANTINED],
        ).values_list("normalized_name", flat=True)
    )
    for index in range(2, 1000):
        candidate = f"{stem} ({index}){suffix}"
        if len(candidate) > 255:
            return None
        if normalize_name(candidate) not in taken:
            return candidate
    return None


def _assert_name_available(*, vault, parent, name):
    taken = PpmVaultEntry.objects.filter(
        vault=vault,
        parent=parent,
        normalized_name=normalize_name(name),
        status__in=[PpmVaultEntryStatus.ACTIVE, PpmVaultEntryStatus.QUARANTINED],
    ).exists()
    if taken:
        raise PpmVaultConflict(
            code="VAULT_NAME_CONFLICT",
            message="Материал с таким именем уже существует.",
            details={"name": name, "suggested_name": _suggest_free_name(vault=vault, parent=parent, name=name)},
        )


def _binary_limit(kind):
    if kind == PpmVaultEntryKind.PDF:
        return getattr(settings, "PPM_VAULT_PDF_MAX_BYTES", settings.FILE_SIZE_LIMIT)
    if kind == PpmVaultEntryKind.IMAGE:
        return getattr(settings, "PPM_VAULT_IMAGE_MAX_BYTES", settings.FILE_SIZE_LIMIT)
    return getattr(settings, "PPM_VAULT_FILE_MAX_BYTES", settings.FILE_SIZE_LIMIT)


def _hash_uploaded_file(uploaded_file):
    digest = hashlib.sha256()
    for chunk in uploaded_file.chunks():
        digest.update(chunk)
    uploaded_file.seek(0)
    return digest.hexdigest()


def create_uploaded_file(*, vault, parent_id, uploaded_file, user_id):
    parent = get_parent(vault=vault, parent_id=parent_id)
    name, extension, kind, mime_type = _uploaded_file_metadata(uploaded_file)
    size = int(getattr(uploaded_file, "size", 0) or 0)
    if size <= 0 or size > _binary_limit(kind):
        raise PpmVaultConflict(
            code="VAULT_FILE_TOO_LARGE",
            message="Файл пустой или превышает допустимый размер.",
            details={"size_bytes": size, "limit_bytes": _binary_limit(kind)},
        )
    _assert_name_available(vault=vault, parent=parent, name=name)
    if extension == "md":
        try:
            content = uploaded_file.read().decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PpmVaultConflict(
                code="VAULT_INVALID_FILE_TYPE",
                message="Markdown-файл должен быть в кодировке UTF-8.",
            ) from exc
        finally:
            uploaded_file.seek(0)
        return create_markdown(vault=vault, parent_id=parent.id, name=name, content=content, user_id=user_id)
    content_hash = _hash_uploaded_file(uploaded_file)
    entry_id = uuid.uuid4()
    version_id = uuid.uuid4()
    object_key = f"ppm-vault/{vault.id}/{entry_id}/{version_id}.{extension}"
    if not put_private_object(object_key=object_key, file_obj=uploaded_file, content_type=mime_type):
        raise PpmVaultConflict(code="VAULT_STORAGE_FAILED", message="Не удалось сохранить файл.")
    try:
        with transaction.atomic():
            entry = PpmVaultEntry.objects.create(
                id=entry_id,
                workspace_id=vault.workspace_id,
                project_id=vault.project_id,
                vault=vault,
                parent=parent,
                kind=kind,
                name=name,
                normalized_name=normalize_name(name),
                extension=extension,
                mime_type=mime_type,
                size_bytes=size,
                content_hash=content_hash,
                created_by=user_id,
                updated_by=user_id,
            )
            version = PpmVaultVersion.objects.create(
                id=version_id,
                entry=entry,
                workspace_id=vault.workspace_id,
                project_id=vault.project_id,
                version=1,
                object_key=object_key,
                mime_type=mime_type,
                size_bytes=size,
                content_hash=content_hash,
                status=PpmVaultVersionStatus.VERIFIED,
                verified_at=timezone.now(),
                created_by=user_id,
            )
            entry.current_version = version
            entry.save(update_fields=["current_version", "updated_at"])
    except IntegrityError as exc:
        delete_private_object(object_key)
        raise PpmVaultConflict(code="VAULT_NAME_CONFLICT", message="Материал с таким именем уже существует.") from exc
    except Exception:
        delete_private_object(object_key)
        raise
    _reindex_vault(vault)
    return entry


def replace_uploaded_file(*, entry, base_version, uploaded_file, user_id):
    name, extension, kind, mime_type = _uploaded_file_metadata(uploaded_file)
    if kind != entry.kind:
        raise PpmVaultConflict(
            code="VAULT_FILE_TYPE_MISMATCH",
            message="Новая версия должна иметь тот же тип материала.",
        )
    size = int(getattr(uploaded_file, "size", 0) or 0)
    if size <= 0 or size > _binary_limit(kind):
        raise PpmVaultConflict(
            code="VAULT_FILE_TOO_LARGE",
            message="Файл пустой или превышает допустимый размер.",
            details={"size_bytes": size, "limit_bytes": _binary_limit(kind)},
        )
    content_hash = _hash_uploaded_file(uploaded_file)
    version_id = uuid.uuid4()
    object_key = f"ppm-vault/{entry.vault_id}/{entry.id}/{version_id}.{extension}"
    if not put_private_object(object_key=object_key, file_obj=uploaded_file, content_type=mime_type):
        raise PpmVaultConflict(code="VAULT_STORAGE_FAILED", message="Не удалось сохранить новую версию файла.")
    try:
        with transaction.atomic():
            locked = PpmVaultEntry.objects.select_for_update().get(id=entry.id)
            if locked.status != PpmVaultEntryStatus.ACTIVE or locked.version != base_version:
                raise PpmVaultConflict(
                    code="VAULT_VERSION_CONFLICT",
                    message="Материал уже изменён другим участником.",
                    details={"base_version": base_version, "current_version": locked.version},
                )
            next_version = locked.version + 1
            old_path = _entry_path(locked)
            version = PpmVaultVersion.objects.create(
                id=version_id,
                entry=locked,
                workspace_id=locked.workspace_id,
                project_id=locked.project_id,
                version=next_version,
                object_key=object_key,
                mime_type=mime_type,
                size_bytes=size,
                content_hash=content_hash,
                status=PpmVaultVersionStatus.VERIFIED,
                verified_at=timezone.now(),
                created_by=user_id,
            )
            locked.current_version = version
            locked.name = name
            locked.normalized_name = normalize_name(name)
            locked.extension = extension
            locked.mime_type = mime_type
            locked.size_bytes = size
            locked.content_hash = content_hash
            locked.updated_by = user_id
            locked.save(
                update_fields=[
                    "current_version",
                    "name",
                    "normalized_name",
                    "extension",
                    "mime_type",
                    "size_bytes",
                    "content_hash",
                    "updated_by",
                    "updated_at",
                ]
            )
            if old_path and normalize_name(old_path) != normalize_name(_entry_path(locked)):
                PpmVaultEntryAlias.objects.get_or_create(
                    entry=locked,
                    normalized_path=old_path.casefold(),
                    defaults={
                        "workspace_id": locked.workspace_id,
                        "project_id": locked.project_id,
                        "vault": locked.vault,
                        "path": old_path,
                        "created_by": user_id,
                    },
                )
    except IntegrityError as exc:
        delete_private_object(object_key)
        raise PpmVaultConflict(code="VAULT_NAME_CONFLICT", message="Материал с таким именем уже существует.") from exc
    except Exception:
        delete_private_object(object_key)
        raise
    _reindex_vault(locked.vault)
    return locked


def get_or_create_project_vault(*, workspace_id, project_id, user_id):
    vault = PpmProjectVault.objects.filter(project_id=project_id, status=PpmVaultStatus.ACTIVE).first()
    if vault is None:
        with transaction.atomic():
            vault = PpmProjectVault.objects.create(
                workspace_id=workspace_id,
                project_id=project_id,
                created_by=user_id,
            )
            root = PpmVaultEntry.objects.create(
                workspace_id=workspace_id,
                project_id=project_id,
                vault=vault,
                kind=PpmVaultEntryKind.FOLDER,
                name="/",
                normalized_name="/",
                created_by=user_id,
                updated_by=user_id,
            )
            vault.root_entry = root
            vault.save(update_fields=["root_entry", "updated_at"])
    if vault.workspace_id != workspace_id:
        raise PpmVaultConflict(code="VAULT_SCOPE_MISMATCH", message="Хранилище относится к другому пространству.")
    return vault


def get_parent(*, vault, parent_id):
    if not parent_id:
        return vault.root_entry
    parent = PpmVaultEntry.objects.filter(
        id=parent_id,
        vault=vault,
        kind=PpmVaultEntryKind.FOLDER,
        status=PpmVaultEntryStatus.ACTIVE,
    ).first()
    if parent is None:
        raise PpmVaultConflict(code="VAULT_PARENT_NOT_FOUND", message="Папка не найдена.")
    return parent


def create_folder(*, vault, parent_id, name, user_id):
    parent = get_parent(vault=vault, parent_id=parent_id)
    name = validate_entry_name(name, kind=PpmVaultEntryKind.FOLDER)
    try:
        entry = PpmVaultEntry.objects.create(
            workspace_id=vault.workspace_id,
            project_id=vault.project_id,
            vault=vault,
            parent=parent,
            kind=PpmVaultEntryKind.FOLDER,
            name=name,
            normalized_name=normalize_name(name),
            created_by=user_id,
            updated_by=user_id,
        )
    except IntegrityError as exc:
        raise PpmVaultConflict(code="VAULT_NAME_CONFLICT", message="Материал с таким именем уже существует.") from exc
    return entry


def create_markdown(*, vault, parent_id, name, content, user_id):
    parent = get_parent(vault=vault, parent_id=parent_id)
    name = validate_entry_name(name, kind=PpmVaultEntryKind.MARKDOWN)
    encoded = content.encode("utf-8")
    limit = getattr(settings, "PPM_VAULT_MARKDOWN_MAX_BYTES", 1_048_576)
    if len(encoded) > limit:
        raise PpmVaultConflict(code="VAULT_FILE_TOO_LARGE", message="Markdown-файл превышает допустимый размер.")
    content_hash = hashlib.sha256(encoded).hexdigest()
    try:
        with transaction.atomic():
            entry = PpmVaultEntry.objects.create(
                workspace_id=vault.workspace_id,
                project_id=vault.project_id,
                vault=vault,
                parent=parent,
                kind=PpmVaultEntryKind.MARKDOWN,
                name=name,
                normalized_name=normalize_name(name),
                extension="md",
                mime_type="text/markdown",
                size_bytes=len(encoded),
                content_hash=content_hash,
                created_by=user_id,
                updated_by=user_id,
            )
            version = PpmVaultVersion.objects.create(
                entry=entry,
                workspace_id=vault.workspace_id,
                project_id=vault.project_id,
                version=1,
                content_text=content,
                object_key=f"ppm-vault/{vault.id}/{entry.id}/{uuid.uuid4()}.md",
                mime_type="text/markdown",
                size_bytes=len(encoded),
                content_hash=content_hash,
                status=PpmVaultVersionStatus.VERIFIED,
                verified_at=timezone.now(),
                created_by=user_id,
            )
            entry.current_version = version
            entry.save(update_fields=["current_version", "updated_at"])
    except IntegrityError as exc:
        raise PpmVaultConflict(code="VAULT_NAME_CONFLICT", message="Материал с таким именем уже существует.") from exc
    _reindex_vault(vault)
    return entry


def update_markdown(*, entry, base_version, content, user_id):
    encoded = content.encode("utf-8")
    limit = getattr(settings, "PPM_VAULT_MARKDOWN_MAX_BYTES", 1_048_576)
    if len(encoded) > limit:
        raise PpmVaultConflict(code="VAULT_FILE_TOO_LARGE", message="Markdown-файл превышает допустимый размер.")
    with transaction.atomic():
        locked = PpmVaultEntry.objects.select_for_update().get(id=entry.id)
        if locked.status != PpmVaultEntryStatus.ACTIVE or locked.kind != PpmVaultEntryKind.MARKDOWN:
            raise PpmVaultConflict(code="VAULT_ENTRY_NOT_FOUND", message="Markdown-файл не найден.")
        if locked.version != base_version:
            raise PpmVaultConflict(
                code="VAULT_VERSION_CONFLICT",
                message="Материал уже изменён другим участником.",
                details={"base_version": base_version, "current_version": locked.version},
            )
        next_version = locked.version + 1
        content_hash = hashlib.sha256(encoded).hexdigest()
        version = PpmVaultVersion.objects.create(
            entry=locked,
            workspace_id=locked.workspace_id,
            project_id=locked.project_id,
            version=next_version,
            content_text=content,
            object_key=f"ppm-vault/{locked.vault_id}/{locked.id}/{uuid.uuid4()}.md",
            mime_type="text/markdown",
            size_bytes=len(encoded),
            content_hash=content_hash,
            status=PpmVaultVersionStatus.VERIFIED,
            verified_at=timezone.now(),
            created_by=user_id,
        )
        locked.current_version = version
        locked.size_bytes = len(encoded)
        locked.content_hash = content_hash
        locked.updated_by = user_id
        locked.save(update_fields=["current_version", "size_bytes", "content_hash", "updated_by", "updated_at"])
    from .links import reindex_entry_links

    reindex_entry_links(locked)
    return locked


def create_pdf(*, vault, parent_id, uploaded_file, user_id):
    _, _, kind, _ = _uploaded_file_metadata(uploaded_file)
    if kind != PpmVaultEntryKind.PDF:
        raise PpmVaultConflict(code="VAULT_INVALID_FILE_TYPE", message="Файл не является PDF.")
    entry = create_uploaded_file(
        vault=vault,
        parent_id=parent_id,
        uploaded_file=uploaded_file,
        user_id=user_id,
    )
    if entry.kind != PpmVaultEntryKind.PDF:
        raise PpmVaultConflict(code="VAULT_INVALID_FILE_TYPE", message="Файл не является PDF.")
    return entry


def trash_entry(*, entry, user_id):
    if entry.id == entry.vault.root_entry_id:
        raise PpmVaultConflict(code="VAULT_ROOT_IMMUTABLE", message="Корневую папку нельзя удалить.")
    if entry.kind == PpmVaultEntryKind.FOLDER and entry.children.filter(status=PpmVaultEntryStatus.ACTIVE).exists():
        raise PpmVaultConflict(code="VAULT_FOLDER_NOT_EMPTY", message="Сначала удалите содержимое папки.")
    entry.status = PpmVaultEntryStatus.TRASHED
    entry.updated_by = user_id
    entry.save(update_fields=["status", "updated_by", "updated_at"])
    _reindex_vault(entry.vault)
    return entry


def update_entry_metadata(*, entry, name=None, parent_id=ENTRY_PARENT_UNSET, user_id):
    with transaction.atomic():
        locked = PpmVaultEntry.objects.select_for_update().get(id=entry.id)
        if locked.status != PpmVaultEntryStatus.ACTIVE:
            raise PpmVaultConflict(code="VAULT_ENTRY_NOT_FOUND", message="Материал не найден.")
        if locked.id == locked.vault.root_entry_id:
            raise PpmVaultConflict(code="VAULT_ROOT_IMMUTABLE", message="Корневую папку нельзя изменить.")
        old_entries = [locked, *_active_descendants(locked)] if locked.kind == PpmVaultEntryKind.FOLDER else [locked]
        for old_entry in old_entries:
            _record_entry_alias(old_entry, user_id=user_id)

        if parent_id is not ENTRY_PARENT_UNSET:
            parent = get_parent(vault=locked.vault, parent_id=parent_id)
            if parent.id == locked.id or parent.id in {descendant.id for descendant in _active_descendants(locked)}:
                raise PpmVaultConflict(code="VAULT_MOVE_CYCLE", message="Папку нельзя переместить внутрь самой себя.")
            locked.parent = parent
        if name is not None:
            locked.name = validate_entry_name(name, kind=locked.kind)
            locked.normalized_name = normalize_name(locked.name)
        locked.updated_by = user_id
        try:
            locked.save(update_fields=["parent", "name", "normalized_name", "updated_by", "updated_at"])
        except IntegrityError as exc:
            raise PpmVaultConflict(
                code="VAULT_NAME_CONFLICT",
                message="Материал с таким именем уже существует.",
            ) from exc
    _reindex_vault(locked.vault)
    return locked


def restore_trashed_entry(*, entry, user_id):
    with transaction.atomic():
        locked = PpmVaultEntry.objects.select_for_update().get(id=entry.id)
        if locked.status != PpmVaultEntryStatus.TRASHED:
            raise PpmVaultConflict(code="VAULT_ENTRY_NOT_TRASHED", message="Материал не находится в корзине.")
        if locked.parent is None or locked.parent.status != PpmVaultEntryStatus.ACTIVE:
            raise PpmVaultConflict(
                code="VAULT_RESTORE_PARENT_MISSING",
                message="Сначала восстановите родительскую папку.",
            )
        conflict = PpmVaultEntry.objects.filter(
            vault=locked.vault,
            parent=locked.parent,
            normalized_name=locked.normalized_name,
            status__in=[PpmVaultEntryStatus.ACTIVE, PpmVaultEntryStatus.QUARANTINED],
        ).exclude(id=locked.id)
        if conflict.exists():
            raise PpmVaultConflict(
                code="VAULT_NAME_CONFLICT",
                message="В папке уже есть материал с таким именем.",
            )
        locked.status = PpmVaultEntryStatus.ACTIVE
        locked.updated_by = user_id
        locked.save(update_fields=["status", "updated_by", "updated_at"])
    _reindex_vault(locked.vault)
    return locked


def restore_entry_version(*, entry, version_number, base_version, user_id):
    with transaction.atomic():
        locked = PpmVaultEntry.objects.select_for_update().get(id=entry.id)
        if locked.status != PpmVaultEntryStatus.ACTIVE or locked.kind == PpmVaultEntryKind.FOLDER:
            raise PpmVaultConflict(code="VAULT_ENTRY_NOT_FOUND", message="Материал не найден.")
        if locked.version != base_version:
            raise PpmVaultConflict(
                code="VAULT_VERSION_CONFLICT",
                message="Материал уже изменён другим участником.",
                details={"base_version": base_version, "current_version": locked.version},
            )
        source = locked.versions.filter(version=version_number, status=PpmVaultVersionStatus.VERIFIED).first()
        if source is None:
            raise PpmVaultConflict(code="VAULT_VERSION_NOT_FOUND", message="Версия не найдена.")
        next_version = locked.version + 1
        if locked.kind == PpmVaultEntryKind.MARKDOWN:
            object_key = f"ppm-vault/{locked.vault_id}/{locked.id}/{uuid.uuid4()}.md"
        else:
            suffix = f".{locked.extension}" if locked.extension else ""
            object_key = f"ppm-vault/{locked.vault_id}/{locked.id}/{uuid.uuid4()}{suffix}"
            if not copy_private_object(source_key=source.object_key, destination_key=object_key):
                raise PpmVaultConflict(code="VAULT_STORAGE_FAILED", message="Не удалось восстановить файл.")
        restored = PpmVaultVersion.objects.create(
            entry=locked,
            workspace_id=locked.workspace_id,
            project_id=locked.project_id,
            version=next_version,
            content_text=source.content_text,
            object_key=object_key,
            mime_type=source.mime_type,
            size_bytes=source.size_bytes,
            content_hash=source.content_hash,
            status=PpmVaultVersionStatus.VERIFIED,
            verified_at=timezone.now(),
            created_by=user_id,
        )
        locked.current_version = restored
        locked.size_bytes = restored.size_bytes
        locked.content_hash = restored.content_hash
        locked.updated_by = user_id
        locked.save(update_fields=["current_version", "size_bytes", "content_hash", "updated_by", "updated_at"])
    if locked.kind == PpmVaultEntryKind.MARKDOWN:
        from .links import reindex_entry_links

        reindex_entry_links(locked)
    return locked
