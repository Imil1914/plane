import fnmatch
import hashlib
import posixpath
import re
from collections import Counter
from urllib.parse import quote

from django.db import transaction
from django.utils import timezone

from .models import (
    PpmGitCodeFile,
    PpmGitCodeIndexPolicy,
    PpmGitCodeSnapshot,
    PpmGitCodeSnapshotStatus,
    PpmGitConnection,
    PpmGitConnectionStatus,
    PpmGitRepository,
    PpmGitRepositoryStatus,
)
from .providers import GitHubAppClient
from .services import PpmGitError


LANGUAGES = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".css": "css",
    ".go": "go",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript",
    ".json": "json",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".md": "markdown",
    ".php": "php",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shell",
    ".sql": "sql",
    ".swift": "swift",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".vue": "vue",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
}
DENIED_DIRECTORIES = {
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".terraform",
    ".venv",
    "build",
    "coverage",
    "dist",
    "generated",
    "node_modules",
    "out",
    "target",
    "vendor",
}
DENIED_FILENAMES = {
    "composer.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "yarn.lock",
}
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"\n]{12,}['\"]"),
)
COMMIT_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")


def serialize_code_index(repository):
    policy = PpmGitCodeIndexPolicy.objects.filter(repository=repository).first()
    snapshot = (
        PpmGitCodeSnapshot.objects.filter(repository=repository, is_current=True)
        .only(
            "id",
            "branch",
            "commit_sha",
            "status",
            "file_count",
            "total_bytes",
            "excluded_stats",
            "completed_at",
            "error_code",
            "error_message",
        )
        .first()
    )
    return {
        "enabled": bool(policy and policy.enabled),
        "branch": policy.branch if policy else repository.default_branch,
        "include_paths": policy.include_paths if policy else [],
        "exclude_paths": policy.exclude_paths if policy else [],
        "limits": {
            "max_files": policy.max_files if policy else 2000,
            "max_file_bytes": policy.max_file_bytes if policy else 512 * 1024,
            "max_total_bytes": policy.max_total_bytes if policy else 50 * 1024 * 1024,
        },
        "snapshot": (
            {
                "id": str(snapshot.id),
                "branch": snapshot.branch,
                "commit_sha": snapshot.commit_sha,
                "status": snapshot.status,
                "file_count": snapshot.file_count,
                "total_bytes": snapshot.total_bytes,
                "excluded_stats": snapshot.excluded_stats,
                "completed_at": snapshot.completed_at.isoformat() if snapshot.completed_at else None,
                "error": (
                    {"code": snapshot.error_code, "message": snapshot.error_message} if snapshot.error_code else None
                ),
            }
            if snapshot
            else None
        ),
    }


def _validate_globs(value, field):
    if not isinstance(value, list) or len(value) > 100:
        raise PpmGitError("CODE_INDEX_POLICY_INVALID", "Список путей для индексации некорректен.", {"field": field})
    patterns = []
    for item in value:
        pattern = str(item).strip()
        if not pattern or len(pattern) > 255 or pattern.startswith("/") or CONTROL_CHARACTERS.search(pattern):
            raise PpmGitError(
                "CODE_INDEX_POLICY_INVALID",
                "Шаблон пути для индексации некорректен.",
                {"field": field},
            )
        patterns.append(pattern)
    return list(dict.fromkeys(patterns))


def update_code_index_policy(*, repository, payload, user_id):
    allowed = {"enabled", "branch", "include_paths", "exclude_paths"}
    if set(payload) - allowed:
        raise PpmGitError("CODE_INDEX_POLICY_INVALID", "Передано неподдерживаемое поле политики индексации.")
    policy, _ = PpmGitCodeIndexPolicy.objects.get_or_create(
        repository=repository,
        defaults={
            "workspace_id": repository.workspace_id,
            "project_id": repository.project_id,
            "branch": repository.default_branch,
            "updated_by": user_id,
        },
    )
    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            raise PpmGitError("CODE_INDEX_POLICY_INVALID", "Поле enabled должно быть логическим.")
        policy.enabled = payload["enabled"]
    if "branch" in payload:
        branch = str(payload["branch"] or "").strip()
        if not branch or len(branch) > 255 or CONTROL_CHARACTERS.search(branch):
            raise PpmGitError("CODE_INDEX_POLICY_INVALID", "Укажите корректную ветку.", {"field": "branch"})
        policy.branch = branch
    if "include_paths" in payload:
        policy.include_paths = _validate_globs(payload["include_paths"], "include_paths")
    if "exclude_paths" in payload:
        policy.exclude_paths = _validate_globs(payload["exclude_paths"], "exclude_paths")
    if policy.enabled:
        if repository.status != PpmGitRepositoryStatus.ACTIVE:
            raise PpmGitError("CODE_INDEX_REPOSITORY_INACTIVE", "Архивный репозиторий нельзя индексировать.")
        connection = getattr(repository, "connection", None)
        if connection is None or connection.status != PpmGitConnectionStatus.ACTIVE:
            raise PpmGitError(
                "CODE_INDEX_CONNECTION_REQUIRED",
                "Для индексации кода нужен активный GitHub App и доступ к содержимому репозитория.",
            )
        if not policy.branch:
            policy.branch = repository.default_branch
    policy.updated_by = user_id
    policy.save()
    if not policy.enabled:
        purge_repository_code(repository=repository, status=PpmGitCodeSnapshotStatus.REVOKED)
    return policy


def normalize_code_path(value):
    path = str(value or "").replace("\\", "/").strip("/")
    normalized = posixpath.normpath(path)
    if (
        not path
        or normalized in {"", ".", ".."}
        or normalized.startswith("../")
        or len(normalized) > 1024
        or CONTROL_CHARACTERS.search(normalized)
    ):
        raise PpmGitError("CODE_INDEX_PATH_INVALID", "Git provider вернул небезопасный путь файла.")
    return normalized


def language_for_path(path):
    lower = path.casefold()
    filename = lower.rsplit("/", 1)[-1]
    if filename in {"dockerfile", "makefile"}:
        return filename
    suffix = f".{filename.rsplit('.', 1)[-1]}" if "." in filename else ""
    return LANGUAGES.get(suffix)


def path_exclusion_reason(*, path, policy):
    parts = {part.casefold() for part in path.split("/")}
    filename = path.rsplit("/", 1)[-1].casefold()
    if parts & DENIED_DIRECTORIES:
        return "vendor_or_generated"
    if filename in DENIED_FILENAMES or filename.startswith(".env"):
        return "secret_or_lockfile"
    if not language_for_path(path):
        return "unsupported_or_binary"
    if policy.include_paths and not any(fnmatch.fnmatchcase(path, pattern) for pattern in policy.include_paths):
        return "outside_allowlist"
    if any(fnmatch.fnmatchcase(path, pattern) for pattern in policy.exclude_paths):
        return "excluded_by_policy"
    return None


def _decode_safe_text(content):
    if isinstance(content, str):
        raw = content.encode("utf-8")
        text = content
    elif isinstance(content, bytes):
        raw = content
        if b"\x00" in raw:
            return None, raw
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None, raw
    else:
        raise PpmGitError("CODE_INDEX_CONTENT_INVALID", "Git provider вернул неподдерживаемое содержимое файла.")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text, raw


def _contains_secret(text):
    sample = text[:1_000_000]
    return any(pattern.search(sample) for pattern in SECRET_PATTERNS)


def ingest_code_snapshot(*, connection, branch, commit_sha, files, dispatch=True):
    repository = connection.repository
    policy = PpmGitCodeIndexPolicy.objects.filter(repository=repository, enabled=True).first()
    if policy is None:
        raise PpmGitError("CODE_INDEX_DISABLED", "Индексация кода для репозитория выключена.")
    if connection.status != PpmGitConnectionStatus.ACTIVE:
        raise PpmGitError("CODE_INDEX_CONNECTION_REQUIRED", "Подключение Git provider неактивно.")
    if not COMMIT_SHA.fullmatch(str(commit_sha or "")):
        raise PpmGitError("CODE_INDEX_COMMIT_INVALID", "Git provider вернул некорректный commit SHA.")
    if branch != policy.branch:
        raise PpmGitError("CODE_INDEX_BRANCH_MISMATCH", "Снимок получен не из разрешённой ветки.")

    accepted = []
    excluded = Counter()
    total_bytes = 0
    for file_payload in files:
        path = normalize_code_path(file_payload.get("path"))
        reason = path_exclusion_reason(path=path, policy=policy)
        if reason:
            excluded[reason] += 1
            continue
        text, raw = _decode_safe_text(file_payload.get("content"))
        if text is None:
            excluded["unsupported_or_binary"] += 1
            continue
        if not text.strip():
            excluded["empty"] += 1
            continue
        if len(raw) > policy.max_file_bytes:
            excluded["file_too_large"] += 1
            continue
        if _contains_secret(text):
            excluded["secret_detected"] += 1
            continue
        total_bytes += len(raw)
        if total_bytes > policy.max_total_bytes:
            raise PpmGitError("CODE_INDEX_TOTAL_LIMIT", "Код репозитория превышает лимит индексации.")
        accepted.append(
            {
                "path": path,
                "language": language_for_path(path),
                "content_text": text,
                "content_hash": hashlib.sha256(raw).hexdigest(),
                "size_bytes": len(raw),
                "line_count": max(1, text.count("\n") + 1),
                "canonical_url": (
                    f"{repository.canonical_url.rstrip('/')}/blob/{quote(commit_sha, safe='')}/"
                    f"{quote(path, safe='/-._~')}"
                ),
            }
        )
        if len(accepted) > policy.max_files:
            raise PpmGitError("CODE_INDEX_FILE_LIMIT", "Репозиторий содержит слишком много индексируемых файлов.")

    digest = hashlib.sha256()
    for item in sorted(accepted, key=lambda value: value["path"]):
        digest.update(item["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(item["content_hash"].encode("ascii"))
        digest.update(b"\n")
    content_hash = digest.hexdigest()
    old_source_ids = []
    with transaction.atomic():
        locked_connection = (
            PpmGitConnection.objects.select_for_update().select_related("repository").get(id=connection.id)
        )
        if locked_connection.status != PpmGitConnectionStatus.ACTIVE:
            raise PpmGitError("CODE_INDEX_CONNECTION_REQUIRED", "Подключение Git provider неактивно.")
        locked_policy = PpmGitCodeIndexPolicy.objects.select_for_update().get(id=policy.id)
        if not locked_policy.enabled:
            raise PpmGitError("CODE_INDEX_DISABLED", "Индексация кода для репозитория выключена.")
        if locked_policy.updated_at != policy.updated_at:
            raise PpmGitError("CODE_INDEX_POLICY_CHANGED", "Политика индексации изменилась во время синхронизации.")
        if branch != locked_policy.branch:
            raise PpmGitError("CODE_INDEX_BRANCH_MISMATCH", "Снимок получен не из разрешённой ветки.")
        repository = locked_connection.repository
        current = list(PpmGitCodeSnapshot.objects.select_for_update().filter(repository=repository, is_current=True))
        snapshot, _ = PpmGitCodeSnapshot.objects.select_for_update().get_or_create(
            repository=repository,
            commit_sha=commit_sha.lower(),
            defaults={
                "workspace_id": repository.workspace_id,
                "project_id": repository.project_id,
                "connection": locked_connection,
                "branch": branch,
            },
        )
        if (
            snapshot.is_current
            and snapshot.status == PpmGitCodeSnapshotStatus.READY
            and snapshot.content_hash == content_hash
        ):
            return snapshot
        for old_snapshot in current:
            old_source_ids.extend(str(value) for value in old_snapshot.files.values_list("id", flat=True))
            old_snapshot.files.all().delete()
            if old_snapshot.id != snapshot.id:
                old_snapshot.is_current = False
                old_snapshot.status = PpmGitCodeSnapshotStatus.SUPERSEDED
                old_snapshot.save(update_fields=["is_current", "status"])
        if snapshot not in current:
            old_source_ids.extend(str(value) for value in snapshot.files.values_list("id", flat=True))
            snapshot.files.all().delete()
        PpmGitCodeFile.objects.bulk_create(
            [
                PpmGitCodeFile(
                    workspace_id=repository.workspace_id,
                    project_id=repository.project_id,
                    repository=repository,
                    snapshot=snapshot,
                    **item,
                )
                for item in accepted
            ]
        )
        snapshot.connection = locked_connection
        snapshot.branch = branch
        snapshot.status = PpmGitCodeSnapshotStatus.READY
        snapshot.is_current = True
        snapshot.content_hash = content_hash
        snapshot.file_count = len(accepted)
        snapshot.total_bytes = total_bytes
        snapshot.excluded_stats = dict(sorted(excluded.items()))
        snapshot.error_code = ""
        snapshot.error_message = ""
        snapshot.completed_at = timezone.now()
        snapshot.save()

    _exclude_brain_sources(repository=repository, source_ids=old_source_ids, deleted=True)
    _index_snapshot_files(snapshot=snapshot, dispatch=dispatch)
    return snapshot


def purge_repository_code(*, repository, status=PpmGitCodeSnapshotStatus.REVOKED):
    source_ids = []
    with transaction.atomic():
        snapshots = list(PpmGitCodeSnapshot.objects.select_for_update().filter(repository=repository))
        for snapshot in snapshots:
            source_ids.extend(str(value) for value in snapshot.files.values_list("id", flat=True))
            snapshot.files.all().delete()
            snapshot.is_current = False
            snapshot.status = status
            snapshot.save(update_fields=["is_current", "status"])
    _exclude_brain_sources(repository=repository, source_ids=source_ids, deleted=True)
    return len(source_ids)


def _exclude_brain_sources(*, repository, source_ids, deleted):
    if not source_ids:
        return
    from plane.ppm_brain.models import PpmKnowledgeSourceType
    from plane.ppm_brain.services import exclude_source

    for source_id in source_ids:
        exclude_source(
            workspace_id=repository.workspace_id,
            project_id=repository.project_id,
            source_type=PpmKnowledgeSourceType.GIT_CODE,
            source_id=source_id,
            deleted=deleted,
            code="GIT_CODE_PURGED",
        )


def _index_snapshot_files(*, snapshot, dispatch):
    from plane.ppm_brain.models import PpmKnowledgeSourceType
    from plane.ppm_brain.services import request_source_index

    for file_id in snapshot.files.values_list("id", flat=True):
        request_source_index(
            workspace_id=snapshot.workspace_id,
            project_id=snapshot.project_id,
            source_type=PpmKnowledgeSourceType.GIT_CODE,
            source_id=file_id,
            dispatch=dispatch,
        )


def synchronize_repository_code(repository_id, *, client=None, dispatch=True):
    repository = (
        PpmGitRepository.objects.select_related("connection__installation", "code_index_policy")
        .filter(id=repository_id, status=PpmGitRepositoryStatus.ACTIVE)
        .first()
    )
    if repository is None:
        raise PpmGitError("GIT_REPOSITORY_NOT_FOUND", "Репозиторий не найден.")
    policy = getattr(repository, "code_index_policy", None)
    if policy is None or not policy.enabled:
        raise PpmGitError("CODE_INDEX_DISABLED", "Индексация кода для репозитория выключена.")
    connection = getattr(repository, "connection", None)
    if connection is None or connection.status != PpmGitConnectionStatus.ACTIVE:
        raise PpmGitError("CODE_INDEX_CONNECTION_REQUIRED", "Подключение Git provider неактивно.")
    client = client or GitHubAppClient()
    tree = client.get_code_tree(
        connection.installation.provider_installation_id,
        connection.provider_repository_id,
        connection.provider_full_name,
        policy.branch,
    )
    selected = []
    selected_bytes = 0
    for item in tree["files"]:
        path = normalize_code_path(item.get("path"))
        if path_exclusion_reason(path=path, policy=policy):
            continue
        size = item.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > policy.max_file_bytes:
            continue
        selected_bytes += size
        if selected_bytes > policy.max_total_bytes:
            raise PpmGitError("CODE_INDEX_TOTAL_LIMIT", "Код репозитория превышает лимит индексации.")
        selected.append({"path": path, "sha": item["sha"], "size": size})
        if len(selected) > policy.max_files:
            raise PpmGitError("CODE_INDEX_FILE_LIMIT", "Репозиторий содержит слишком много индексируемых файлов.")
    blobs = client.get_code_blobs(
        connection.installation.provider_installation_id,
        connection.provider_repository_id,
        connection.provider_full_name,
        selected,
    )
    candidates = [{"path": item["path"], "content": blobs[item["sha"]]} for item in selected]
    return ingest_code_snapshot(
        connection=connection,
        branch=policy.branch,
        commit_sha=tree["commit_sha"],
        files=candidates,
        dispatch=dispatch,
    )
