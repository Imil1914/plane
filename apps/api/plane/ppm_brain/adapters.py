import io
import re
from dataclasses import dataclass

from django.conf import settings

from plane.db.models import Issue
from plane.ppm_canvas.work_item_version import (
    current_assignees,
    current_assignees_prefetch,
    work_item_source_version,
)
from plane.ppm_git.models import (
    PpmGitCodeFile,
    PpmGitCodeSnapshotStatus,
    PpmGitConnectionStatus,
    PpmGitRepositoryStatus,
)
from plane.ppm_vault.models import (
    PpmVaultEntry,
    PpmVaultEntryKind,
    PpmVaultEntryStatus,
    PpmVaultIndexPolicy,
    PpmVaultVersionStatus,
)
from plane.ppm_vault.storage import open_private_object

from .models import PpmKnowledgeSourceType


PIPELINE_VERSION = "brain-v1-ru-keyword-2026-09"
MAX_NORMALIZED_CHARS = 2_000_000
MAX_PDF_PAGES = 500
GIT_CODE_READABLE_CONNECTION_STATUSES = {
    PpmGitConnectionStatus.ACTIVE,
    PpmGitConnectionStatus.SYNCING,
    PpmGitConnectionStatus.ERROR,
    PpmGitConnectionStatus.RATE_LIMITED,
}


class PpmBrainSourceError(Exception):
    def __init__(self, *, code, message, retryable=False):
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)


class PpmBrainSourceExcluded(PpmBrainSourceError):
    pass


class PpmBrainSourceDeleted(PpmBrainSourceError):
    pass


@dataclass(frozen=True)
class SourcePart:
    text: str
    locator: dict


@dataclass(frozen=True)
class SourceDocument:
    source_type: str
    source_id: str
    source_version: str
    title: str
    parts: tuple[SourcePart, ...]


def normalize_text(value):
    value = str(value or "").replace("\x00", " ").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[\t ]+", " ", line).strip() for line in value.split("\n")]
    normalized = "\n".join(line for line in lines if line)
    if len(normalized) > MAX_NORMALIZED_CHARS:
        raise PpmBrainSourceError(code="SOURCE_TEXT_TOO_LARGE", message="Текст источника превышает лимит.")
    return normalized


def vault_path(entry):
    parts = [entry.name]
    parent = entry.parent
    guard = 0
    while parent is not None and parent.parent_id is not None and guard < 100:
        parts.append(parent.name)
        parent = parent.parent
        guard += 1
    return "/".join(reversed(parts))


def load_work_item(*, workspace_id, project_id, source_id):
    issue = (
        Issue.objects.select_related("project", "state")
        .prefetch_related(current_assignees_prefetch())
        .filter(
            id=source_id,
            workspace_id=workspace_id,
            project_id=project_id,
            deleted_at__isnull=True,
            is_draft=False,
        )
        .first()
    )
    if issue is None:
        raise PpmBrainSourceDeleted(code="SOURCE_NOT_FOUND", message="Задача не найдена.")
    identifier = f"{issue.project.identifier}-{issue.sequence_id}"
    # RC-F1 (D-1): у `plane.db.models.User` нет `get_full_name()` (есть свойство `full_name`) — вызов ронял индексацию
    # и через сигнал `on_commit` сохранение любой задачи с исполнителем (500). Исполнители — текущие (без мягко
    # удалённых строк IssueAssignee), как на карточке Холста.
    assignee_users = current_assignees(issue)
    assignees = ", ".join(filter(None, (user.full_name or user.display_name or user.email for user in assignee_users)))
    body = "\n".join(
        filter(
            None,
            [
                identifier,
                issue.name,
                normalize_text(issue.description_stripped),
                f"Статус: {issue.state.name}" if issue.state else "",
                f"Приоритет: {issue.priority}" if issue.priority else "",
                f"Исполнители: {assignees}" if assignees else "",
                f"Начало: {issue.start_date.isoformat()}" if issue.start_date else "",
                f"Срок: {issue.target_date.isoformat()}" if issue.target_date else "",
            ],
        )
    )
    return SourceDocument(
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=str(issue.id),
        # RC-F1 (D-2): та же версия, что у карточки Холста (отпечаток полей и описания, а не `updated_at`, который
        # двигает журнал активности Plane) — клиентское «изменился после поиска» сравнивает их строкой.
        source_version=work_item_source_version(issue, assignee_ids=[user.id for user in assignee_users]),
        title=f"{identifier} · {issue.name}",
        parts=(
            SourcePart(
                text=body,
                locator={"kind": "work_item", "identifier": identifier, "work_item_id": str(issue.id)},
            ),
        ),
    )


def _extract_pdf_parts(entry):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise PpmBrainSourceError(
            code="PDF_PARSER_UNAVAILABLE",
            message="Серверный PDF-парсер не установлен.",
            retryable=True,
        ) from exc

    handle = open_private_object(entry.current_version.object_key)
    if handle is None:
        raise PpmBrainSourceError(
            code="VAULT_STORAGE_UNAVAILABLE",
            message="Хранилище файла временно недоступно.",
            retryable=True,
        )
    try:
        payload = handle.read()
    finally:
        handle.close()
    if len(payload) > getattr(settings, "PPM_BRAIN_PDF_MAX_BYTES", 25 * 1024 * 1024):
        raise PpmBrainSourceError(code="PDF_TOO_LARGE", message="PDF превышает лимит обработки.")
    try:
        reader = PdfReader(io.BytesIO(payload), strict=True)
        if reader.is_encrypted:
            raise PpmBrainSourceError(code="PDF_ENCRYPTED", message="Зашифрованный PDF нельзя индексировать.")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise PpmBrainSourceError(code="PDF_TOO_MANY_PAGES", message="В PDF слишком много страниц.")
        parts = []
        path = vault_path(entry)
        for page_number, page in enumerate(reader.pages, start=1):
            text = normalize_text(page.extract_text() or "")
            if text:
                parts.append(
                    SourcePart(
                        text=text,
                        locator={"kind": "vault_pdf", "path": path, "page": page_number},
                    )
                )
        if not parts:
            raise PpmBrainSourceError(
                code="PDF_TEXT_LAYER_EMPTY",
                message="В PDF не найден текстовый слой. OCR будет добавлен отдельным этапом.",
            )
        return tuple(parts)
    except PpmBrainSourceError:
        raise
    except Exception as exc:
        raise PpmBrainSourceError(code="PDF_PARSE_FAILED", message="Не удалось безопасно разобрать PDF.") from exc


def _get_vault_entry(*, workspace_id, project_id, source_id):
    entry = (
        PpmVaultEntry.objects.select_related("current_version", "parent")
        .filter(id=source_id, workspace_id=workspace_id, project_id=project_id)
        .first()
    )
    if entry is None or entry.status == PpmVaultEntryStatus.TRASHED:
        raise PpmBrainSourceDeleted(code="SOURCE_NOT_FOUND", message="Материал не найден.")
    if (
        entry.status != PpmVaultEntryStatus.ACTIVE
        or entry.index_policy == PpmVaultIndexPolicy.EXCLUDE
        or entry.current_version_id is None
        or entry.current_version.status != PpmVaultVersionStatus.VERIFIED
    ):
        raise PpmBrainSourceExcluded(code="SOURCE_EXCLUDED", message="Материал исключён из индекса.")
    return entry


def load_vault_file_metadata(*, workspace_id, project_id, source_id):
    entry = _get_vault_entry(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    if entry.kind not in {PpmVaultEntryKind.MARKDOWN, PpmVaultEntryKind.PDF}:
        raise PpmBrainSourceExcluded(
            code="SOURCE_TYPE_NOT_INDEXABLE",
            message="Этот тип файла пока не индексируется.",
        )
    version = entry.current_version
    return SourceDocument(
        source_type=PpmKnowledgeSourceType.VAULT_FILE,
        source_id=str(entry.id),
        source_version=f"{version.version}:{version.content_hash}",
        title=entry.name,
        parts=(),
    )


def load_vault_file(*, workspace_id, project_id, source_id):
    entry = _get_vault_entry(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    if entry.kind == PpmVaultEntryKind.MARKDOWN:
        content = normalize_text(entry.current_version.content_text)
        parts = (
            SourcePart(
                text=content,
                locator={"kind": "vault_markdown", "path": vault_path(entry)},
            ),
        )
    elif entry.kind == PpmVaultEntryKind.PDF:
        parts = _extract_pdf_parts(entry)
    else:
        raise PpmBrainSourceExcluded(
            code="SOURCE_TYPE_NOT_INDEXABLE",
            message="Этот тип файла пока не индексируется.",
        )
    version = entry.current_version
    return SourceDocument(
        source_type=PpmKnowledgeSourceType.VAULT_FILE,
        source_id=str(entry.id),
        source_version=f"{version.version}:{version.content_hash}",
        title=entry.name,
        parts=parts,
    )


def _get_git_code_file(*, workspace_id, project_id, source_id):
    code_file = (
        PpmGitCodeFile.objects.select_related("snapshot", "repository")
        .filter(
            id=source_id,
            workspace_id=workspace_id,
            project_id=project_id,
            snapshot__is_current=True,
            snapshot__status=PpmGitCodeSnapshotStatus.READY,
            snapshot__connection__status__in=GIT_CODE_READABLE_CONNECTION_STATUSES,
            repository__status=PpmGitRepositoryStatus.ACTIVE,
            repository__code_index_policy__enabled=True,
        )
        .first()
    )
    if code_file is None:
        raise PpmBrainSourceDeleted(code="SOURCE_NOT_FOUND", message="Файл кода не найден или больше не индексируется.")
    return code_file


def load_git_code_metadata(*, workspace_id, project_id, source_id):
    code_file = _get_git_code_file(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    return SourceDocument(
        source_type=PpmKnowledgeSourceType.GIT_CODE,
        source_id=str(code_file.id),
        source_version=f"{code_file.snapshot.commit_sha}:{code_file.content_hash}",
        title=f"{code_file.repository.name}:{code_file.path}",
        parts=(),
    )


def _git_code_parts(code_file):
    lines = code_file.content_text.splitlines()
    window = 60 if code_file.language == "markdown" else 100 if code_file.language in {"json", "yaml"} else 80
    overlap = 10
    parts = []
    start = 0
    while start < len(lines):
        end = min(len(lines), start + window)
        text = "\n".join(lines[start:end]).strip()
        if text:
            line_start = start + 1
            line_end = end
            parts.append(
                SourcePart(
                    text=text,
                    locator={
                        "kind": "git_code",
                        "repository_id": str(code_file.repository_id),
                        "repository_name": code_file.repository.provider_full_name or code_file.repository.name,
                        "branch": code_file.snapshot.branch,
                        "commit_sha": code_file.snapshot.commit_sha,
                        "path": code_file.path,
                        "language": code_file.language,
                        "line_start": line_start,
                        "line_end": line_end,
                        "canonical_url": f"{code_file.canonical_url}#L{line_start}-L{line_end}",
                    },
                )
            )
        if end == len(lines):
            break
        start = max(start + 1, end - overlap)
    return tuple(parts)


def load_git_code(*, workspace_id, project_id, source_id):
    code_file = _get_git_code_file(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    return SourceDocument(
        source_type=PpmKnowledgeSourceType.GIT_CODE,
        source_id=str(code_file.id),
        source_version=f"{code_file.snapshot.commit_sha}:{code_file.content_hash}",
        title=f"{code_file.repository.name}:{code_file.path}",
        parts=_git_code_parts(code_file),
    )


def load_source(*, workspace_id, project_id, source_type, source_id):
    if source_type == PpmKnowledgeSourceType.WORK_ITEM:
        return load_work_item(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    if source_type == PpmKnowledgeSourceType.VAULT_FILE:
        return load_vault_file(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    if source_type == PpmKnowledgeSourceType.GIT_CODE:
        return load_git_code(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    raise PpmBrainSourceError(code="SOURCE_TYPE_UNSUPPORTED", message="Тип источника не поддерживается.")


def load_source_metadata(*, workspace_id, project_id, source_type, source_id):
    if source_type == PpmKnowledgeSourceType.WORK_ITEM:
        return load_work_item(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    if source_type == PpmKnowledgeSourceType.VAULT_FILE:
        return load_vault_file_metadata(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    if source_type == PpmKnowledgeSourceType.GIT_CODE:
        return load_git_code_metadata(workspace_id=workspace_id, project_id=project_id, source_id=source_id)
    raise PpmBrainSourceError(code="SOURCE_TYPE_UNSUPPORTED", message="Тип источника не поддерживается.")
