"""G1.3 — user-approved Git write actions: a branch first, a draft pull request only after the first push.

Owner decision 2026-09-26 (ADR «Двухэтапный Git write flow»): every provider write needs its own exact preview and
approval, then a separate apply. Apply is fenced (``APPLYING`` + ``apply_fence``), idempotent, audited, and stays
behind ``PPM_GIT_WRITE_ENABLED`` (off by default). PPM never merges, never pushes commits, never moves or deletes refs.
"""

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timedelta
from urllib.parse import quote

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status as http_status

from plane.db.models import Issue

from .models import (
    PpmGitAudit,
    PpmGitConnection,
    PpmGitConnectionStatus,
    PpmGitInstallationStatus,
    PpmGitLink,
    PpmGitLinkOrigin,
    PpmGitLinkStatus,
    PpmGitObject,
    PpmGitObjectType,
    PpmGitProvider,
    PpmGitRepository,
    PpmGitRepositoryStatus,
    PpmGitWriteAction,
    PpmGitWriteActionStatus,
    PpmGitWriteActionType,
)
from .provider_services import upsert_git_object
from .providers import GitHubAppClient, github_app_is_configured
from .providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from .providers.github import pull_request_marker
from .services import PpmGitError, normalize_name, parse_uuid, reject_credential_fields


logger = logging.getLogger("plane.api")

# G1.3 review I1: branch names end up in copy-paste git commands (manual path while writes are off), so only a
# conservative, shell-neutral alphabet is accepted — safe in POSIX shells, PowerShell and cmd alike.
SAFE_REF = re.compile(r"^[A-Za-z0-9._/-]+$")
MAX_REF_LENGTH = 244  # 255 bytes of a ref minus "refs/heads/"
MAX_PULL_REQUEST_TITLE_LENGTH = 256  # GitHub rejects longer pull request titles
BODY_CONTROL = re.compile(r"[\x00\x0b\x0c\x7f]")
FINAL_STATUSES = {
    PpmGitWriteActionStatus.APPROVED,
    PpmGitWriteActionStatus.REJECTED,
    PpmGitWriteActionStatus.APPLYING,
    PpmGitWriteActionStatus.APPLIED,
    PpmGitWriteActionStatus.CONFLICT,
    PpmGitWriteActionStatus.FAILED,
    PpmGitWriteActionStatus.CANCELLED,
}
TWO_STAGE_TYPES = {PpmGitWriteActionType.CREATE_BRANCH, PpmGitWriteActionType.CREATE_DRAFT_PR}
WRITE_REQUIRED_PERMISSIONS = {"contents": "write", "pull_requests": "write"}
WRITE_DISPLAY_PERMISSIONS = {"metadata": "read", **WRITE_REQUIRED_PERMISSIONS}
STEP_REQUIRED_PERMISSIONS = {
    PpmGitWriteActionType.CREATE_BRANCH: {"contents": "write"},
    PpmGitWriteActionType.CREATE_DRAFT_PR: {"pull_requests": "write"},
}
# Transient read-sync states do not change what a write may do; revoked/suspended/disconnected ones do.
WRITE_CONNECTION_STATUSES = {
    PpmGitConnectionStatus.ACTIVE,
    PpmGitConnectionStatus.SYNCING,
    PpmGitConnectionStatus.ERROR,
    PpmGitConnectionStatus.RATE_LIMITED,
}
APPLY_LEASE_SECONDS = 120
# Provider answers that mean "the previewed state is no longer true": a new preview is required.
CONFLICT_PROVIDER_CODES = {
    "GITHUB_BASE_MOVED",
    "GITHUB_HEAD_MOVED",
    "GITHUB_BRANCH_CONFLICT",
    "GITHUB_BRANCH_NOT_FOUND",
    "GITHUB_PULL_REQUEST_EXISTS",
    "GITHUB_PULL_REQUEST_CONFLICT",
    "GITHUB_PULL_REQUEST_EMPTY",
    # Reconciliation could not prove what an earlier attempt left in GitHub, or found this action's own PR closed:
    # final, never cancellable, and audited honestly ("unknown"/"exists"), never as "no write".
    "GITHUB_BRANCH_UNCONFIRMED",
    "GITHUB_PULL_REQUEST_UNCONFIRMED",
    "GITHUB_PULL_REQUEST_CLOSED",
}
PULL_REQUEST_BLOCKING_STATUSES = {
    PpmGitWriteActionStatus.PROPOSED,
    PpmGitWriteActionStatus.APPROVED,
    PpmGitWriteActionStatus.APPLYING,
    PpmGitWriteActionStatus.FAILED,
}
BRANCH_SAFETY_MESSAGE = (
    "Это предварительный просмотр: GitHub не изменится до отдельных подтверждения и применения. "
    "Будет создана только ветка от показанного коммита — без коммитов и изменения файлов."
)
PULL_REQUEST_SAFETY_MESSAGE = (
    "Это предварительный просмотр: GitHub не изменится до отдельных подтверждения и применения. "
    "Будет создан только черновик PR из показанных коммитов; в конец описания PPM добавит невидимую в GitHub "
    "служебную отметку — по ней при повторе PPM узнаёт только свой PR. Слияние (merge) выполняется только в GitHub."
)
WRITE_DISABLED_MESSAGE = (
    "Запись в GitHub выключена администратором PPM. Создайте ветку или черновик PR вручную — готовые команды "
    "есть в разделе «Код»; PPM подхватит результат по webhook."
)


def is_safe_git_ref(ref):
    """Allow-list plus git's ref-name rules (``git check-ref-format``) for branches PPM creates or names."""
    return bool(
        isinstance(ref, str)
        and 0 < len(ref) <= MAX_REF_LENGTH
        and SAFE_REF.fullmatch(ref)
        and not ref.startswith(("-", "/", "."))
        and not ref.endswith(("/", ".", ".lock"))
        and ".." not in ref
        and "//" not in ref
        and "@{" not in ref
        and not any(part.startswith(".") or part.endswith((".", ".lock")) for part in ref.split("/"))
    )


def normalize_git_ref(value, *, field):
    if not isinstance(value, str):
        raise PpmGitError("GIT_WRITE_INVALID_REF", "Название ветки должно быть строкой.", {"field": field})
    ref = value.strip()
    if not is_safe_git_ref(ref):
        raise PpmGitError(
            "GIT_WRITE_INVALID_REF",
            "Имя ветки может содержать только латинские буквы, цифры и символы «.», «_», «/», «-» — до 244 "
            "символов, без «..» и «//», не начинаться с «-», «/» или «.» и не заканчиваться на «/», «.» или «.lock».",
            {"field": field},
        )
    return ref


def _normalize_title(value):
    title = normalize_name(value, field="title", maximum=2000)
    if len(title) > MAX_PULL_REQUEST_TITLE_LENGTH:
        raise PpmGitError(
            "GIT_WRITE_TITLE_TOO_LONG",
            "Название черновика PR — не длиннее 256 символов (ограничение GitHub).",
            {"field": "title", "maximum": MAX_PULL_REQUEST_TITLE_LENGTH},
        )
    return title


def _normalize_body(value):
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or len(value) > 20000 or BODY_CONTROL.search(value):
        raise PpmGitError(
            "GIT_WRITE_INVALID_BODY",
            "Описание draft PR должно быть текстом до 20 000 символов.",
            {"field": "body"},
        )
    return value.strip()


def _request_fingerprint(payload):
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _writes_enabled():
    return bool(getattr(settings, "PPM_GIT_WRITE_ENABLED", False))


def _missing_permissions(connection, required):
    current = connection.permissions if isinstance(connection.permissions, dict) else {}
    return [name for name, level in required.items() if current.get(name) != level]


def _provider_write_ready(connection):
    return _writes_enabled() and not _missing_permissions(connection, WRITE_REQUIRED_PERMISSIONS)


def _lease_expired(action, now):
    return action.apply_started_at is None or action.apply_started_at <= now - timedelta(seconds=APPLY_LEASE_SECONDS)


def _outcome_unknown(action):
    """An earlier attempt may have written to GitHub (crash, timeout after the write request, lost lease): until a
    retry reconciles with GitHub the step can only be retried, never cancelled."""
    return bool(isinstance(action.result, dict) and action.result.get("outcome_unknown"))


def serialize_git_write_readiness(connections):
    values = []
    for connection in connections:
        # G1.3 writes are GitHub-only (G2.1): another provider's repository is not a write target.
        if connection.installation.provider != PpmGitProvider.GITHUB:
            continue
        current_permissions = connection.permissions if isinstance(connection.permissions, dict) else {}
        missing_permissions = _missing_permissions(connection, WRITE_REQUIRED_PERMISSIONS)
        values.append(
            {
                "connection_id": str(connection.id),
                "repository_id": str(connection.repository_id),
                "repository_full_name": connection.provider_full_name,
                "connection_status": connection.status,
                "current_permissions": current_permissions,
                "missing_permissions": missing_permissions,
                "permission_ready": (connection.status == PpmGitConnectionStatus.ACTIVE and not missing_permissions),
            }
        )

    provider_writes_enabled = _writes_enabled()
    permission_ready = any(value["permission_ready"] for value in values)
    blockers = []
    if not provider_writes_enabled:
        blockers.append("PROVIDER_WRITE_DISABLED")
    if not permission_ready:
        blockers.append("GITHUB_PERMISSIONS_MISSING")
    return {
        "provider": "github",
        "flow": "branch_then_commit_then_draft_pr",
        # ADR «Двухэтапный Git write flow» approved by the owner on 2026-09-26.
        "decision_status": "accepted",
        "required_permissions": WRITE_DISPLAY_PERMISSIONS,
        "provider_writes_enabled": provider_writes_enabled,
        "permission_ready": permission_ready,
        "apply_available": provider_writes_enabled and permission_ready,
        "blockers": blockers,
        "connections": values,
    }


def _get_sources(*, workspace_id, project_id, repository_id, work_item_id, lock=False):
    repository_query = PpmGitRepository.objects
    connection_query = PpmGitConnection.objects.select_related("installation", "repository")
    work_item_query = Issue.objects.select_related("project")
    if lock:
        repository_query = repository_query.select_for_update()
        connection_query = connection_query.select_for_update()
        work_item_query = work_item_query.select_for_update()

    repository = repository_query.filter(
        id=repository_id,
        workspace_id=workspace_id,
        project_id=project_id,
        status=PpmGitRepositoryStatus.ACTIVE,
    ).first()
    if repository is None:
        raise PpmGitError("GIT_REPOSITORY_NOT_FOUND", "Репозиторий не найден.")
    connection = connection_query.filter(
        repository_id=repository.id,
        workspace_id=workspace_id,
        project_id=project_id,
        status__in=WRITE_CONNECTION_STATUSES,
        installation__status=PpmGitInstallationStatus.ACTIVE,
        # G1.3 writes are GitHub-only (G2.1): another provider's repository never reaches the GitHub API.
        installation__provider=PpmGitProvider.GITHUB,
    ).first()
    if connection is None:
        raise PpmGitError(
            "GIT_WRITE_CONNECTION_REQUIRED",
            "Для Git-действия нужен активный подключённый репозиторий GitHub.",
            status_code=http_status.HTTP_409_CONFLICT,
        )
    work_item = work_item_query.filter(
        id=work_item_id,
        workspace_id=workspace_id,
        project_id=project_id,
        deleted_at__isnull=True,
    ).first()
    if work_item is None:
        raise PpmGitError("GIT_WORK_ITEM_NOT_FOUND", "Задача не найдена в этом проекте.")
    return repository, connection, work_item


def _sources_changed(action, *, repository, connection, work_item):
    """Did anything the preview showed change? Background sync only touches ``connection.updated_at``, so a
    connection counts as changed when it now belongs to another installation (reinstall/reconnect). For the Work
    Item only the shown key and title count: moving it to «В работе» after the branch exists is not a change."""
    if repository.updated_at != action.repository_updated_at:
        return True
    preview = action.preview if isinstance(action.preview, dict) else {}
    shown_item = preview.get("work_item") if isinstance(preview.get("work_item"), dict) else None
    if shown_item and shown_item.get("identifier"):
        current = (f"{work_item.project.identifier}-{work_item.sequence_id}", work_item.name)
        if (shown_item.get("identifier"), shown_item.get("title")) != current:
            return True
    elif work_item.updated_at != action.work_item_updated_at:
        return True
    provider = action.preview.get("provider") if isinstance(action.preview, dict) else None
    installation_id = provider.get("installation_id") if isinstance(provider, dict) else None
    if installation_id:
        return str(connection.installation_id) != installation_id
    # Legacy previews did not record the installation: keep their strict comparison.
    return connection.updated_at != action.connection_updated_at


def _provider_http_status(error):
    if isinstance(error, PpmGitProviderRateLimited) or error.code == "GITHUB_RATE_LIMITED":
        return http_status.HTTP_429_TOO_MANY_REQUESTS
    if error.code in CONFLICT_PROVIDER_CODES:
        return http_status.HTTP_409_CONFLICT
    # A provider 401/403/404/422 must never reach the browser as-is (401 would log the PPM user out).
    return http_status.HTTP_502_BAD_GATEWAY


def _provider_identity(connection):
    return {
        "provider": "github",
        "account_login": connection.installation.account_login,
        "provider_installation_id": connection.installation.provider_installation_id,
        "repository_full_name": connection.provider_full_name,
    }


def _request_summary(action):
    return {
        "action_type": action.action_type,
        "base_ref": action.base_ref,
        "base_sha": action.base_sha,
        "head_ref": action.head_ref,
        "head_sha": action.head_sha,
    }


def _audit(*, workspace_id, project_id, actor_id, request_id, name, target_id=None, metadata=None):
    PpmGitAudit.objects.create(
        workspace_id=workspace_id,
        project_id=project_id,
        actor_id=actor_id,
        action=name,
        target_type="write_action",
        target_id=target_id,
        request_id=request_id or uuid.uuid4(),
        metadata=metadata or {},
    )


def _branch_url(connection, ref):
    return f"https://github.com/{connection.provider_full_name}/tree/{quote(ref, safe='/-._')}"


def _preview_header(*, repository, connection, work_item):
    return {
        "repository": {
            "id": str(repository.id),
            "provider": repository.provider,
            "name": repository.name,
            "full_name": repository.provider_full_name or repository.name,
            "canonical_url": repository.canonical_url,
        },
        "provider": {
            "connection_id": str(connection.id),
            "installation_id": str(connection.installation_id),
            "account_login": connection.installation.account_login,
            "permissions": connection.permissions,
            "write_ready": _provider_write_ready(connection),
        },
        "work_item": {
            "id": str(work_item.id),
            "identifier": f"{work_item.project.identifier}-{work_item.sequence_id}",
            "title": work_item.name,
            "updated_at": work_item.updated_at.isoformat(),
        },
    }


def _build_branch_preview(*, repository, connection, work_item, base_ref, base_sha, head_ref, title, body):
    return {
        "stage": "branch",
        **_preview_header(repository=repository, connection=connection, work_item=work_item),
        "branch": {
            "base_ref": base_ref,
            "base_sha": base_sha,
            "head_ref": head_ref,
            "canonical_url": _branch_url(connection, head_ref),
        },
        # Planned PR text, created only later by the separately approved draft PR step (keeps the preview shape
        # readable by the previous application version after an app-only rollback).
        "draft_pull_request": {"title": title, "body": body, "is_draft": True, "planned": True},
        "safety": {"provider_write_performed": False, "merge_allowed": False, "message": BRANCH_SAFETY_MESSAGE},
    }


def _build_pull_request_preview(*, repository, connection, work_item, parent, state, title, body, action_id):
    return {
        "stage": "pull_request",
        **_preview_header(repository=repository, connection=connection, work_item=work_item),
        "parent_action_id": str(parent.id),
        "branch": {
            "base_ref": parent.base_ref,
            "base_sha": state["base_sha"],
            "head_ref": parent.head_ref,
            "head_sha": state["head_sha"],
            "canonical_url": _branch_url(connection, parent.head_ref),
        },
        "commits": {
            "ahead_by": state["ahead_by"],
            "truncated": state["truncated"],
            "items": state["commits"],
        },
        # Closed or merged PRs for the same branches do not block a new draft PR; shown for reference only.
        "previous_pull_requests": state.get("previous_pull_requests", []),
        # Exactly what GitHub will receive: the body plus the hidden per-action marker on its own line.
        "draft_pull_request": {
            "title": title,
            "body": body,
            "marker": pull_request_marker(action_id),
            "is_draft": True,
        },
        "safety": {
            "provider_write_performed": False,
            "merge_allowed": False,
            "message": PULL_REQUEST_SAFETY_MESSAGE,
        },
    }


def _action_type(payload):
    action_type = payload.get("action_type") or PpmGitWriteActionType.CREATE_BRANCH
    if not isinstance(action_type, str) or action_type not in TWO_STAGE_TYPES:
        raise PpmGitError(
            "GIT_WRITE_ACTION_TYPE_UNSUPPORTED",
            "Поддерживаются только два шага: ветка, затем черновик PR.",
            {"field": "action_type"},
            status_code=http_status.HTTP_400_BAD_REQUEST,
        )
    return action_type


def _normalized_branch_request(*, workspace_id, project_id, payload):
    allowed = {
        "action_type",
        "repository_id",
        "work_item_id",
        "base_ref",
        "head_ref",
        "title",
        "body",
        "client_operation_id",
    }
    unknown = set(payload) - allowed
    if unknown:
        raise PpmGitError("GIT_UNSUPPORTED_FIELD", "Передано неподдерживаемое поле.", {"fields": sorted(unknown)})

    repository_id = parse_uuid(payload.get("repository_id"), field="repository_id")
    work_item_id = parse_uuid(payload.get("work_item_id"), field="work_item_id")
    operation_id = parse_uuid(payload.get("client_operation_id"), field="client_operation_id")
    repository, connection, work_item = _get_sources(
        workspace_id=workspace_id,
        project_id=project_id,
        repository_id=repository_id,
        work_item_id=work_item_id,
    )
    base_ref = normalize_git_ref(payload.get("base_ref") or repository.default_branch or "main", field="base_ref")
    head_ref = normalize_git_ref(payload.get("head_ref"), field="head_ref")
    if base_ref == head_ref:
        raise PpmGitError("GIT_WRITE_REF_CONFLICT", "Новая ветка должна отличаться от базовой.")
    title = _normalize_title(payload.get("title"))
    body = _normalize_body(payload.get("body"))
    normalized = {
        "action_type": PpmGitWriteActionType.CREATE_BRANCH,
        "workspace_id": str(workspace_id),
        "project_id": str(project_id),
        "repository_id": str(repository.id),
        "connection_id": str(connection.id),
        "work_item_id": str(work_item.id),
        "base_ref": base_ref,
        "head_ref": head_ref,
        "title": title,
        "body": body,
    }
    return normalized, operation_id, repository, connection, work_item, None


def _normalized_pull_request_request(*, workspace_id, project_id, payload):
    allowed = {"action_type", "parent_action_id", "title", "body", "client_operation_id"}
    unknown = set(payload) - allowed
    if unknown:
        raise PpmGitError("GIT_UNSUPPORTED_FIELD", "Передано неподдерживаемое поле.", {"fields": sorted(unknown)})
    parent_id = parse_uuid(payload.get("parent_action_id"), field="parent_action_id")
    operation_id = parse_uuid(payload.get("client_operation_id"), field="client_operation_id")
    parent = PpmGitWriteAction.objects.filter(id=parent_id, workspace_id=workspace_id, project_id=project_id).first()
    if parent is None:
        raise PpmGitError("GIT_WRITE_ACTION_NOT_FOUND", "Предложение Git-действия не найдено.")
    if parent.action_type != PpmGitWriteActionType.CREATE_BRANCH:
        raise PpmGitError(
            "GIT_WRITE_PARENT_INVALID",
            "Черновик PR готовится только для ветки, созданной через PPM.",
            status_code=http_status.HTTP_409_CONFLICT,
        )
    if parent.status != PpmGitWriteActionStatus.APPLIED:
        raise PpmGitError(
            "GIT_WRITE_PARENT_NOT_APPLIED",
            "Сначала создайте ветку: черновик PR готовится после её создания и первого push.",
            {"parent_action_id": str(parent.id), "status": parent.status},
            status_code=http_status.HTTP_409_CONFLICT,
        )
    repository, connection, work_item = _get_sources(
        workspace_id=workspace_id,
        project_id=project_id,
        repository_id=parent.repository_id,
        work_item_id=parent.work_item_id,
    )
    title = _normalize_title(payload.get("title"))
    body = _normalize_body(payload.get("body"))
    normalized = {
        "action_type": PpmGitWriteActionType.CREATE_DRAFT_PR,
        "workspace_id": str(workspace_id),
        "project_id": str(project_id),
        "parent_action_id": str(parent.id),
        "repository_id": str(repository.id),
        "connection_id": str(connection.id),
        "work_item_id": str(work_item.id),
        "base_ref": parent.base_ref,
        "head_ref": parent.head_ref,
        "title": title,
        "body": body,
    }
    return normalized, operation_id, repository, connection, work_item, parent


def _require_github_configured():
    if not github_app_is_configured():
        raise PpmGitError(
            "GITHUB_APP_NOT_CONFIGURED",
            "GitHub App ещё не настроен администратором PPM.",
            status_code=http_status.HTTP_409_CONFLICT,
        )


def _pending_pull_request_action(parent):
    """A PR step of this branch that is still undecided or may still write. An applied one does not block: whether
    its PR is still OPEN (blocks) or closed/merged (does not) is read live from GitHub by the preview."""
    return (
        PpmGitWriteAction.objects.filter(
            parent_action=parent,
            action_type=PpmGitWriteActionType.CREATE_DRAFT_PR,
            status__in=PULL_REQUEST_BLOCKING_STATUSES,
        )
        .order_by("-created_at")
        .first()
    )


def _read_preview_state(*, action_type, repository, connection, normalized, parent, client):
    """Read-only provider calls for an exact preview. Raises PpmGitError; never writes."""
    installation_id = connection.installation.provider_installation_id
    if action_type == PpmGitWriteActionType.CREATE_BRANCH:
        base_ref, head_ref = normalized["base_ref"], normalized["head_ref"]
        heads = client.get_branch_heads(
            installation_id,
            connection.provider_repository_id,
            connection.provider_full_name,
            [base_ref, head_ref],
        )
        if heads.get(base_ref) is None:
            raise PpmGitError(
                "GITHUB_BRANCH_NOT_FOUND",
                "Базовая ветка не найдена в GitHub.",
                {"field": "base_ref"},
                status_code=http_status.HTTP_409_CONFLICT,
            )
        if heads.get(head_ref) is not None:
            raise PpmGitError(
                "GIT_WRITE_BRANCH_EXISTS",
                "Ветка с таким именем уже есть в GitHub. PPM не изменяет существующие ветки — выберите другое имя.",
                {"field": "head_ref", "canonical_url": _branch_url(connection, head_ref)},
                status_code=http_status.HTTP_409_CONFLICT,
            )
        return {"base_sha": heads[base_ref], "head_sha": ""}

    state = client.get_pull_request_preview(
        installation_id,
        connection.provider_repository_id,
        connection.provider_full_name,
        base_ref=parent.base_ref,
        head_ref=parent.head_ref,
    )
    if state["existing_pull_requests"]:
        raise PpmGitError(
            "GIT_WRITE_PULL_REQUEST_EXISTS",
            "Для этой ветки в GitHub уже есть открытый pull request. PPM не создаёт дубликаты и не присваивает "
            "чужие PR.",
            {"canonical_url": state["existing_pull_requests"][0]["canonical_url"]},
            status_code=http_status.HTTP_409_CONFLICT,
        )
    if state["ahead_by"] < 1:
        raise PpmGitError(
            "GIT_WRITE_NO_COMMITS",
            f"В ветке {parent.head_ref} пока нет новых коммитов. Сделайте commit и push, затем подготовьте "
            "черновик PR — PPM не создаёт скрытых пустых коммитов.",
            {"head_ref": parent.head_ref, "base_ref": parent.base_ref},
            status_code=http_status.HTTP_409_CONFLICT,
        )
    return state


def create_git_write_action_preview(*, workspace_id, project_id, payload, user_id, request_id=None, client=None):
    reject_credential_fields(payload)
    action_type = _action_type(payload)
    if action_type == PpmGitWriteActionType.CREATE_BRANCH:
        normalized, operation_id, repository, connection, work_item, parent = _normalized_branch_request(
            workspace_id=workspace_id, project_id=project_id, payload=payload
        )
    else:
        normalized, operation_id, repository, connection, work_item, parent = _normalized_pull_request_request(
            workspace_id=workspace_id, project_id=project_id, payload=payload
        )
    fingerprint = _request_fingerprint(normalized)
    existing = PpmGitWriteAction.objects.filter(
        project_id=project_id,
        created_by=user_id,
        client_operation_id=operation_id,
    ).first()
    if existing is not None:
        if existing.request_fingerprint != fingerprint:
            raise PpmGitError(
                "GIT_WRITE_OPERATION_REUSED",
                "Этот идентификатор операции уже использован для другого preview.",
            )
        return existing, False

    if parent is not None:
        sibling = _pending_pull_request_action(parent)
        if sibling is not None:
            raise PpmGitError(
                "GIT_WRITE_PULL_REQUEST_PENDING",
                "Черновик PR для этой ветки уже ждёт решения. Откройте его или отмените, чтобы подготовить новый.",
                {"action_id": str(sibling.id), "status": sibling.status},
                status_code=http_status.HTTP_409_CONFLICT,
            )

    _require_github_configured()
    scope = {
        "workspace_id": workspace_id,
        "project_id": project_id,
        "actor_id": user_id,
        "request_id": request_id,
        "repository_id": str(repository.id),
    }
    try:
        state = _read_preview_state(
            action_type=action_type,
            repository=repository,
            connection=connection,
            normalized=normalized,
            parent=parent,
            client=client or GitHubAppClient(),
        )
    except PpmGitProviderError as exc:
        _audit_preview_refusal(scope, action_type=action_type, connection=connection, parent=parent, code=exc.code)
        details = dict(exc.details or {})
        if exc.retry_after_seconds:
            details["retry_after_seconds"] = exc.retry_after_seconds
        raise PpmGitError(exc.code, exc.message, details or None, status_code=_provider_http_status(exc)) from exc
    except PpmGitError as exc:
        _audit_preview_refusal(scope, action_type=action_type, connection=connection, parent=parent, code=exc.code)
        raise

    action_id = uuid.uuid4()
    if action_type == PpmGitWriteActionType.CREATE_BRANCH:
        preview = _build_branch_preview(
            repository=repository,
            connection=connection,
            work_item=work_item,
            base_ref=normalized["base_ref"],
            base_sha=state["base_sha"],
            head_ref=normalized["head_ref"],
            title=normalized["title"],
            body=normalized["body"],
        )
    else:
        preview = _build_pull_request_preview(
            repository=repository,
            connection=connection,
            work_item=work_item,
            parent=parent,
            state=state,
            title=normalized["title"],
            body=normalized["body"],
            action_id=action_id,
        )
    try:
        with transaction.atomic():
            action = PpmGitWriteAction.objects.create(
                id=action_id,
                workspace_id=workspace_id,
                project_id=project_id,
                repository=repository,
                connection=connection,
                work_item=work_item,
                action_type=action_type,
                parent_action=parent,
                client_operation_id=operation_id,
                request_fingerprint=fingerprint,
                repository_updated_at=repository.updated_at,
                connection_updated_at=connection.updated_at,
                work_item_updated_at=work_item.updated_at,
                base_ref=normalized["base_ref"],
                head_ref=normalized["head_ref"],
                base_sha=state["base_sha"],
                head_sha=state["head_sha"],
                title=normalized["title"],
                body=normalized["body"],
                preview=preview,
                created_by=user_id,
            )
    except IntegrityError:
        existing = PpmGitWriteAction.objects.filter(
            project_id=project_id,
            created_by=user_id,
            client_operation_id=operation_id,
        ).first()
        if existing is None or existing.request_fingerprint != fingerprint:
            raise PpmGitError(
                "GIT_WRITE_OPERATION_REUSED",
                "Этот идентификатор операции уже использован для другого preview.",
            )
        return existing, False
    return action, True


def _audit_preview_refusal(scope, *, action_type, connection, parent, code):
    _audit(
        workspace_id=scope["workspace_id"],
        project_id=scope["project_id"],
        actor_id=scope["actor_id"],
        request_id=scope["request_id"],
        name="write_action.preview_refused",
        metadata={
            "action_type": action_type,
            "repository_id": scope["repository_id"],
            "parent_action_id": str(parent.id) if parent else None,
            "provider": _provider_identity(connection),
            "error_code": code,
            "provider_write_performed": False,
        },
    )


def decide_git_write_action(*, action, decision, user_id):
    if decision not in {"approve", "reject"}:
        raise PpmGitError(
            "GIT_WRITE_INVALID_DECISION",
            "Решение должно быть approve или reject.",
            {"field": "decision"},
        )
    desired_status = PpmGitWriteActionStatus.APPROVED if decision == "approve" else PpmGitWriteActionStatus.REJECTED
    conflict = None
    with transaction.atomic():
        locked = (
            PpmGitWriteAction.objects.select_for_update()
            .select_related("repository", "connection__installation", "work_item__project")
            .get(id=action.id)
        )
        if locked.status == desired_status:
            return locked, False
        if locked.status in FINAL_STATUSES:
            raise PpmGitError(
                "GIT_WRITE_DECISION_FINAL",
                "Решение по этому Git-действию уже зафиксировано.",
                {"action_id": str(locked.id), "status": locked.status},
            )
        if decision == "approve" and locked.action_type not in TWO_STAGE_TYPES:
            raise PpmGitError(
                "GIT_WRITE_ACTION_TYPE_UNSUPPORTED",
                "Это предложение в устаревшем формате. Подготовьте новый предпросмотр ветки.",
                {"action_id": str(locked.id)},
                status_code=http_status.HTTP_409_CONFLICT,
            )

        if decision == "approve":
            repository, connection, work_item = _get_sources(
                workspace_id=locked.workspace_id,
                project_id=locked.project_id,
                repository_id=locked.repository_id,
                work_item_id=locked.work_item_id,
                lock=True,
            )
            if _sources_changed(locked, repository=repository, connection=connection, work_item=work_item):
                locked.status = PpmGitWriteActionStatus.CONFLICT
                locked.error_code = "GIT_WRITE_SOURCE_CHANGED"
                locked.error_message = "Репозиторий, подключение или задача изменились после preview."
                locked.decided_by = user_id
                locked.decided_at = timezone.now()
                locked.save(
                    update_fields=[
                        "status",
                        "error_code",
                        "error_message",
                        "decided_by",
                        "decided_at",
                        "updated_at",
                    ]
                )
                conflict = PpmGitError(
                    "GIT_WRITE_SOURCE_CHANGED",
                    "Данные изменились после preview. Подготовьте новое предложение.",
                    {"action_id": str(locked.id)},
                )
            else:
                locked.status = desired_status
        else:
            locked.status = desired_status

        if conflict is None:
            locked.decided_by = user_id
            locked.decided_at = timezone.now()
            locked.error_code = ""
            locked.error_message = ""
            locked.save(
                update_fields=[
                    "status",
                    "decided_by",
                    "decided_at",
                    "error_code",
                    "error_message",
                    "updated_at",
                ]
            )
    if conflict is not None:
        raise conflict
    return locked, True


def _status_refusal(locked, now, details):
    """Refusals decided by the action's own state; ``None`` when apply may proceed."""
    if locked.action_type not in TWO_STAGE_TYPES:
        return "LEGACY_FLOW", PpmGitError(
            "GIT_WRITE_ACTION_TYPE_UNSUPPORTED",
            "Это предложение в устаревшем формате и не может быть применено. Подготовьте новый предпросмотр.",
            details,
            status_code=http_status.HTTP_409_CONFLICT,
        )
    if not is_safe_git_ref(locked.base_ref) or not is_safe_git_ref(locked.head_ref):
        return "INVALID_REF", PpmGitError(
            "GIT_WRITE_INVALID_REF",
            "Имя ветки в этом предложении не проходит проверку безопасности. Подготовьте новый предпросмотр.",
            details,
            status_code=http_status.HTTP_409_CONFLICT,
        )
    if locked.status == PpmGitWriteActionStatus.APPLYING and not _lease_expired(locked, now):
        return "APPLY_IN_PROGRESS", PpmGitError(
            "GIT_WRITE_APPLY_IN_PROGRESS",
            "Это действие уже применяется. Обновите страницу через несколько секунд.",
            details,
            status_code=http_status.HTTP_409_CONFLICT,
        )
    if locked.status == PpmGitWriteActionStatus.PROPOSED:
        return "APPROVAL_REQUIRED", PpmGitError(
            "GIT_WRITE_NOT_APPROVED",
            "Сначала подтвердите предпросмотр — без подтверждения PPM ничего не записывает в GitHub.",
            details,
            status_code=http_status.HTTP_409_CONFLICT,
        )
    if locked.status in {
        PpmGitWriteActionStatus.REJECTED,
        PpmGitWriteActionStatus.CANCELLED,
        PpmGitWriteActionStatus.CONFLICT,
    }:
        return "STATUS_FINAL", PpmGitError(
            "GIT_WRITE_DECISION_FINAL",
            "Это действие закрыто и не может быть применено. Подготовьте новый предпросмотр.",
            details,
            status_code=http_status.HTTP_409_CONFLICT,
        )
    if locked.status == PpmGitWriteActionStatus.FAILED and locked.retry_after and locked.retry_after > now:
        return "RETRY_LATER", PpmGitError(
            "GIT_WRITE_RETRY_LATER",
            "GitHub просил подождать. Повторите попытку позже.",
            {**details, "retry_after_seconds": max(1, int((locked.retry_after - now).total_seconds()))},
            status_code=http_status.HTTP_429_TOO_MANY_REQUESTS,
        )
    if not _writes_enabled():
        return "PROVIDER_WRITE_DISABLED", PpmGitError(
            "GIT_WRITE_DISABLED", WRITE_DISABLED_MESSAGE, details, status_code=http_status.HTTP_403_FORBIDDEN
        )
    if not github_app_is_configured():
        return "GITHUB_APP_NOT_CONFIGURED", PpmGitError(
            "GITHUB_APP_NOT_CONFIGURED",
            "GitHub App ещё не настроен администратором PPM.",
            details,
            status_code=http_status.HTTP_409_CONFLICT,
        )
    return None


def _claim_for_apply(*, action, user_id, request_id):
    """Phase 1 (one transaction): validate, then move the action to APPLYING with a new fencing token.

    Every refusal is audited; audits and status changes are committed before the error is raised.
    """
    now = timezone.now()
    audits = []
    error = None
    claim = None
    with transaction.atomic():
        locked = (
            PpmGitWriteAction.objects.select_for_update()
            .select_related("repository", "connection__installation", "work_item__project")
            .get(id=action.id)
        )
        details = {"action_id": str(locked.id), "status": locked.status}
        if locked.action_type in TWO_STAGE_TYPES and locked.status == PpmGitWriteActionStatus.APPLIED:
            return {"replayed": locked}
        refusal = _status_refusal(locked, now, details)
        if refusal is None:
            try:
                repository, connection, work_item = _get_sources(
                    workspace_id=locked.workspace_id,
                    project_id=locked.project_id,
                    repository_id=locked.repository_id,
                    work_item_id=locked.work_item_id,
                    lock=True,
                )
            except PpmGitError as exc:
                refusal = exc.code, PpmGitError(exc.code, exc.message, details, status_code=exc.status_code or 409)
        # An earlier attempt may already have written the approved step: the retry then only completes or
        # reconciles that step, so later edits of the sources must not turn it into a conflict that hides it.
        unknown = _outcome_unknown(locked) or locked.status == PpmGitWriteActionStatus.APPLYING
        if (
            refusal is None
            and not unknown
            and _sources_changed(locked, repository=repository, connection=connection, work_item=work_item)
        ):
            locked.status = PpmGitWriteActionStatus.CONFLICT
            locked.error_code = "GIT_WRITE_SOURCE_CHANGED"
            locked.error_message = "Репозиторий, подключение или задача изменились после предпросмотра."
            locked.apply_fence = None
            locked.save(update_fields=["status", "error_code", "error_message", "apply_fence", "updated_at"])
            audits.append(
                (
                    "write_action.apply_conflict",
                    {
                        "error_code": "GIT_WRITE_SOURCE_CHANGED",
                        "write_outcome": "not_performed",
                        "provider_write_performed": False,
                    },
                )
            )
            error = PpmGitError(
                "GIT_WRITE_SOURCE_CHANGED",
                "Данные изменились после предпросмотра. Подготовьте новое предложение.",
                {"action_id": str(locked.id), "status": locked.status},
                status_code=http_status.HTTP_409_CONFLICT,
            )
        elif refusal is None:
            missing = _missing_permissions(connection, STEP_REQUIRED_PERMISSIONS[locked.action_type])
            if missing:
                refusal = (
                    "GITHUB_PERMISSIONS_MISSING",
                    PpmGitError(
                        "GIT_WRITE_PERMISSIONS_MISSING",
                        "У GitHub App нет прав на запись для этого шага. Выдайте права в GitHub и нажмите "
                        "«Проверить права».",
                        {**details, "missing_permissions": missing},
                        status_code=http_status.HTTP_409_CONFLICT,
                    ),
                )
        if refusal is not None:
            reason, error = refusal
            audits.append(
                (
                    "write_action.apply_refused",
                    {"reason": reason, "status": locked.status, "provider_write_performed": False},
                )
            )
        elif error is None:
            takeover = locked.status == PpmGitWriteActionStatus.APPLYING
            locked.status = PpmGitWriteActionStatus.APPLYING
            locked.apply_fence = uuid.uuid4()
            locked.apply_attempts += 1
            locked.apply_started_at = now
            locked.applied_by = user_id
            locked.error_code = ""
            locked.error_message = ""
            locked.retry_after = None
            result = dict(locked.result) if isinstance(locked.result, dict) else {}
            # When this action first tried to write: a PR without our marker is someone else's only if it is older.
            result.setdefault("first_attempt_at", now.isoformat())
            if takeover:
                # The attempt that held the expired lease may have written before it died.
                result["outcome_unknown"] = True
            locked.result = result
            locked.save(
                update_fields=[
                    "status",
                    "apply_fence",
                    "apply_attempts",
                    "apply_started_at",
                    "applied_by",
                    "error_code",
                    "error_message",
                    "retry_after",
                    "result",
                    "updated_at",
                ]
            )
            audits.append(
                (
                    "write_action.apply_started",
                    {
                        "attempt": locked.apply_attempts,
                        "lease_takeover": takeover,
                        "reconcile": locked.apply_attempts > 1,
                        "provider": _provider_identity(connection),
                        "request": _request_summary(locked),
                    },
                )
            )
            claim = {
                "action": locked,
                "fence": locked.apply_fence,
                "repository": repository,
                "connection": connection,
                "work_item": work_item,
            }

    for name, metadata in audits:
        _audit(
            workspace_id=locked.workspace_id,
            project_id=locked.project_id,
            actor_id=user_id,
            request_id=request_id,
            name=name,
            target_id=locked.id,
            metadata={"action_type": locked.action_type, **metadata},
        )
    if error is not None:
        raise error
    return claim


def _call_provider(*, action, connection, client):
    installation_id = connection.installation.provider_installation_id
    # Reconcile with GitHub only while an earlier attempt may have written (lost answer, lost lease). After a
    # definite refusal (429, 422, …) nothing was written, so the retry behaves like a first attempt.
    reconciling = _outcome_unknown(action)
    if action.action_type == PpmGitWriteActionType.CREATE_BRANCH:
        return client.create_branch(
            installation_id,
            connection.provider_repository_id,
            connection.provider_full_name,
            base_ref=action.base_ref,
            head_ref=action.head_ref,
            base_sha=action.base_sha,
            allow_replay=reconciling,
        )
    return client.create_draft_pull_request(
        installation_id,
        connection.provider_repository_id,
        connection.provider_full_name,
        base_ref=action.base_ref,
        head_ref=action.head_ref,
        title=action.title,
        body=action.body,
        marker=pull_request_marker(action.id),
        base_sha=action.base_sha,
        head_sha=action.head_sha,
        reconciling=reconciling,
        first_attempt_at=_first_attempt_at(action),
    )


def _first_attempt_at(action):
    value = action.result.get("first_attempt_at") if isinstance(action.result, dict) else None
    try:
        return datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _ensure_work_item_link(*, git_object, work_item, actor_id):
    lookup = {
        "repository": git_object.repository,
        "work_item": work_item,
        "object_type": git_object.object_type,
        "canonical_url": git_object.canonical_url,
        "status": PpmGitLinkStatus.ACTIVE,
    }
    try:
        with transaction.atomic():
            link, _ = PpmGitLink.objects.get_or_create(
                **lookup,
                defaults={
                    "workspace_id": git_object.workspace_id,
                    "project_id": git_object.project_id,
                    "git_object": git_object,
                    "ref": git_object.ref,
                    "title": git_object.title[:255],
                    "origin": PpmGitLinkOrigin.PROVIDER,
                    "created_by": actor_id,
                    "updated_by": actor_id,
                },
            )
    except IntegrityError:
        link = PpmGitLink.objects.get(**lookup)
    if link.git_object_id is None:
        link.git_object = git_object
        link.updated_by = actor_id
        link.save(update_fields=["git_object", "updated_by", "updated_at"])
    return link


def _result_summary(action, provider_result):
    if action.action_type == PpmGitWriteActionType.CREATE_BRANCH:
        return {
            "ref": provider_result["ref"],
            "sha": provider_result["sha"],
            "canonical_url": provider_result["canonical_url"],
            "created": provider_result["created"],
        }
    summary = {
        "provider_object_id": provider_result["provider_object_id"],
        "number": provider_result["ref"],
        "canonical_url": provider_result["canonical_url"],
        "is_draft": provider_result["is_draft"],
        "state": provider_result["state"],
        "base_ref": provider_result["base_ref"],
        "head_ref": provider_result["head_ref"],
        "head_sha": provider_result["commit_sha"],
        "created": provider_result["created"],
    }
    head_sha = provider_result["commit_sha"]
    if provider_result["created"] and head_sha and head_sha != action.head_sha:
        # A push landed between the fenced check and creation; the PR shows GitHub's actual head.
        summary["head_sha_changed_during_apply"] = True
    return summary


def _record_result(*, action, connection, work_item, provider_result, actor_id):
    """Project the created provider object into PPM (Git object + Work Item link → Canvas) and build the result."""
    summary = _result_summary(action, provider_result)
    if action.action_type == PpmGitWriteActionType.CREATE_BRANCH:
        object_payload = {
            "object_type": PpmGitObjectType.BRANCH,
            "provider_object_id": summary["ref"],
            "ref": summary["ref"],
            "title": summary["ref"],
            "canonical_url": summary["canonical_url"],
            "state": "active",
            "commit_sha": summary["sha"],
            "metadata": {"ppm_write_action_id": str(action.id)},
            "source_version": summary["sha"],
            "provider_updated_at": None,
        }
        result = {"branch": summary}
    else:
        object_payload = {key: value for key, value in provider_result.items() if key != "created"}
        result = {"pull_request": summary}
    try:
        with transaction.atomic():
            git_object = upsert_git_object(connection=connection, payload=object_payload)
            link = _ensure_work_item_link(git_object=git_object, work_item=work_item, actor_id=actor_id)
        result.update({"git_object_id": str(git_object.id), "link_id": str(link.id)})
    except (PpmGitError, IntegrityError, ValueError):
        # The provider object exists; a projection problem must not hide it. Reconciliation will link it later.
        logger.warning("PPM Git write result could not be projected", extra={"write_action_id": str(action.id)})
        result.update({"git_object_id": None, "link_id": None})
    return result, summary


def _unconfirmed_check(action, connection):
    """Honest wording and a place to look when an earlier attempt's result could not be proven either way."""
    full_name = connection.provider_full_name
    if action.action_type == PpmGitWriteActionType.CREATE_DRAFT_PR:
        search = quote(f"is:pr head:{action.head_ref}", safe="")
        return (
            "Не удалось подтвердить, создан ли PR прошлой попыткой — проверьте в GitHub.",
            f"https://github.com/{full_name}/pulls?q={search}",
        )
    return (
        "Не удалось подтвердить, создана ли ветка прошлой попыткой — проверьте в GitHub.",
        f"https://github.com/{full_name}/tree/{quote(action.head_ref, safe='/-._')}",
    )


def _finish_failed_apply(*, claim, error, user_id, request_id):
    """Record a provider failure (fenced) and return the error to raise.

    ``conflict`` is final (a new preview is needed). ``failed`` may be retried explicitly by the user (never
    automatically). What GitHub may hold is recorded honestly: ``not_performed`` only when proven (a definite
    refusal, or reconciliation found nothing of ours), ``exists`` when this action's object was found, otherwise
    ``unknown`` — sticky until a retry reconciles; such a step can be retried or is final, but never cancelled and
    never audited as «no write».
    """
    action = claim["action"]
    now = timezone.now()
    rate_limited = isinstance(error, PpmGitProviderRateLimited) or error.code == "GITHUB_RATE_LIMITED"
    attempt_outcome = getattr(error, "write_outcome", None)
    message = error.message
    details = dict(error.details or {})
    with transaction.atomic():
        locked = PpmGitWriteAction.objects.select_for_update().get(id=action.id)
        owned = locked.status == PpmGitWriteActionStatus.APPLYING and locked.apply_fence == claim["fence"]
        previous = locked.result if isinstance(locked.result, dict) else {}
        unknown = attempt_outcome == "unknown" or (attempt_outcome is None and bool(previous.get("outcome_unknown")))
        if unknown and attempt_outcome != "unknown":
            # This attempt learned nothing about the earlier one (e.g. it failed before reading GitHub).
            note, check_url = _unconfirmed_check(locked, claim["connection"])
            message = f"{message} {note}"
            details.setdefault("canonical_url", check_url)
        if owned:
            final = error.code in CONFLICT_PROVIDER_CODES
            locked.status = PpmGitWriteActionStatus.CONFLICT if final else PpmGitWriteActionStatus.FAILED
            locked.error_code = error.code[:64]
            locked.error_message = message[:500]
            locked.retry_after = now + timedelta(seconds=error.retry_after_seconds or 60) if rate_limited else None
            locked.apply_fence = None
            result = {"first_attempt_at": previous["first_attempt_at"]} if previous.get("first_attempt_at") else {}
            if details:
                result["error_details"] = details
            if unknown:
                result["outcome_unknown"] = True
            locked.result = result
            locked.save(
                update_fields=[
                    "status",
                    "error_code",
                    "error_message",
                    "retry_after",
                    "apply_fence",
                    "result",
                    "updated_at",
                ]
            )
    if not owned:
        name = "write_action.apply_superseded"
    elif locked.status == PpmGitWriteActionStatus.CONFLICT:
        name = "write_action.apply_conflict"
    else:
        name = "write_action.apply_failed"
    if attempt_outcome == "exists":
        write_outcome = "exists"
    else:
        write_outcome = "unknown" if unknown else "not_performed"
    _audit(
        workspace_id=locked.workspace_id,
        project_id=locked.project_id,
        actor_id=user_id,
        request_id=request_id,
        name=name,
        target_id=locked.id,
        metadata={
            "action_type": locked.action_type,
            "attempt": action.apply_attempts,
            "provider": _provider_identity(claim["connection"]),
            "request": _request_summary(locked),
            "error_code": error.code,
            "outcome": {
                "status": locked.status,
                **({"canonical_url": details["canonical_url"]} if details.get("canonical_url") else {}),
            },
            # What GitHub may hold for this step: "not_performed" (proven), "exists" (found), "unknown".
            "write_outcome": write_outcome,
            # This request's own write: None («неизвестно») when it was sent and never answered, else False.
            "provider_write_performed": None if getattr(error, "write_request_unanswered", False) else False,
        },
    )
    if not owned:
        return _superseded_error(locked)
    details.update({"action_id": str(locked.id), "status": locked.status})
    if unknown:
        details["outcome_unknown"] = True
    if rate_limited:
        details["retry_after_seconds"] = error.retry_after_seconds or 60
    return PpmGitError(error.code, message, details, status_code=_provider_http_status(error))


def _superseded_error(action):
    return PpmGitError(
        "GIT_WRITE_APPLY_SUPERSEDED",
        "Применение продолжила более поздняя попытка. Обновите страницу, чтобы увидеть результат.",
        {"action_id": str(action.id), "status": action.status},
        status_code=http_status.HTTP_409_CONFLICT,
    )


def apply_git_write_action(*, action, user_id, request_id=None, client=None):
    """Apply an approved step. Returns ``(action, performed)``; ``performed`` is False for an idempotent replay."""
    claim = _claim_for_apply(action=action, user_id=user_id, request_id=request_id)
    if "replayed" in claim:
        replayed = claim["replayed"]
        _audit(
            workspace_id=replayed.workspace_id,
            project_id=replayed.project_id,
            actor_id=user_id,
            request_id=request_id,
            name="write_action.apply_replayed",
            target_id=replayed.id,
            metadata={
                "action_type": replayed.action_type,
                "outcome": replayed.result,
                "provider_write_performed": False,
            },
        )
        return replayed, False

    claimed = claim["action"]
    client = client or GitHubAppClient()
    try:
        provider_result = _call_provider(action=claimed, connection=claim["connection"], client=client)
    except PpmGitProviderError as exc:
        raise _finish_failed_apply(claim=claim, error=exc, user_id=user_id, request_id=request_id) from exc
    except Exception as exc:
        logger.exception("PPM Git write apply failed unexpectedly", extra={"write_action_id": str(claimed.id)})
        unexpected = PpmGitProviderError(
            "GIT_WRITE_APPLY_FAILED",
            "Не удалось завершить запись в GitHub. Повторите попытку — PPM сначала проверит, что уже создано.",
            write_outcome="unknown",
            write_request_unanswered=True,
        )
        raise _finish_failed_apply(claim=claim, error=unexpected, user_id=user_id, request_id=request_id) from exc

    superseded = False
    with transaction.atomic():
        locked = PpmGitWriteAction.objects.select_for_update().get(id=claimed.id)
        if locked.status != PpmGitWriteActionStatus.APPLYING or locked.apply_fence != claim["fence"]:
            superseded = True
            summary = _result_summary(claimed, provider_result)
        else:
            result, summary = _record_result(
                action=locked,
                connection=claim["connection"],
                work_item=claim["work_item"],
                provider_result=provider_result,
                actor_id=user_id,
            )
            locked.status = PpmGitWriteActionStatus.APPLIED
            locked.result = result
            locked.applied_at = timezone.now()
            locked.apply_fence = None
            locked.error_code = ""
            locked.error_message = ""
            locked.save(
                update_fields=[
                    "status",
                    "result",
                    "applied_at",
                    "apply_fence",
                    "error_code",
                    "error_message",
                    "updated_at",
                ]
            )
    metadata = {
        "action_type": locked.action_type,
        "attempt": claimed.apply_attempts,
        "provider": _provider_identity(claim["connection"]),
        "request": _request_summary(locked),
        # This request's own write; an object found by a retry was written by an earlier attempt («reconciled»).
        "provider_write_performed": bool(summary["created"]),
        "reconciled": not summary["created"],
        "write_outcome": "exists",
    }
    if superseded:
        # The GitHub object exists (URL below); the attempt that now holds the fence reconciles and records it.
        metadata["outcome"] = {"status": locked.status, **summary}
        _audit(
            workspace_id=locked.workspace_id,
            project_id=locked.project_id,
            actor_id=user_id,
            request_id=request_id,
            name="write_action.apply_superseded",
            target_id=locked.id,
            metadata=metadata,
        )
        raise _superseded_error(locked)
    metadata["outcome"] = {"status": locked.status, **summary}
    _audit(
        workspace_id=locked.workspace_id,
        project_id=locked.project_id,
        actor_id=user_id,
        request_id=request_id,
        name="write_action.apply_succeeded",
        target_id=locked.id,
        metadata=metadata,
    )
    return locked, True


def cancel_git_write_action(*, action, user_id, request_id=None):
    """Withdraw a step before it reaches GitHub.

    Only steps that certainly wrote nothing can be cancelled. A running or interrupted apply (``applying``, or
    ``failed`` with an unknown outcome) can only be retried — the retry reconciles with GitHub. Applied steps are
    never undone by PPM (no deletes in GitHub).
    """
    now = timezone.now()
    error = None
    reason = None
    changed = False
    with transaction.atomic():
        locked = PpmGitWriteAction.objects.select_for_update().get(id=action.id)
        details = {"action_id": str(locked.id), "status": locked.status}
        previous = locked.status
        if locked.status == PpmGitWriteActionStatus.CANCELLED:
            pass
        elif locked.status == PpmGitWriteActionStatus.APPLIED:
            reason = "ALREADY_APPLIED"
            error = PpmGitError(
                "GIT_WRITE_ALREADY_APPLIED",
                "Ветка или черновик PR уже созданы в GitHub. PPM ничего не удаляет — закройте или удалите их в GitHub.",
                details,
                status_code=http_status.HTTP_409_CONFLICT,
            )
        elif locked.status == PpmGitWriteActionStatus.APPLYING and not _lease_expired(locked, now):
            reason = "APPLY_IN_PROGRESS"
            error = PpmGitError(
                "GIT_WRITE_APPLY_IN_PROGRESS",
                "Это действие сейчас применяется, отменить его нельзя. Обновите страницу через несколько секунд.",
                details,
                status_code=http_status.HTTP_409_CONFLICT,
            )
        elif locked.status == PpmGitWriteActionStatus.APPLYING or (
            locked.status == PpmGitWriteActionStatus.FAILED and _outcome_unknown(locked)
        ):
            reason = "OUTCOME_UNKNOWN"
            error = PpmGitError(
                "GIT_WRITE_OUTCOME_UNKNOWN",
                "Неизвестно, успела ли прошлая попытка создать объект в GitHub, поэтому отменить нельзя. "
                "Нажмите «Повторить» — PPM проверит GitHub и зафиксирует результат.",
                {**details, "outcome_unknown": True},
                status_code=http_status.HTTP_409_CONFLICT,
            )
        elif locked.status in {PpmGitWriteActionStatus.REJECTED, PpmGitWriteActionStatus.CONFLICT}:
            reason = "STATUS_FINAL"
            error = PpmGitError(
                "GIT_WRITE_DECISION_FINAL",
                "Это действие уже закрыто.",
                details,
                status_code=http_status.HTTP_409_CONFLICT,
            )
        else:
            changed = True
            locked.status = PpmGitWriteActionStatus.CANCELLED
            locked.cancelled_by = user_id
            locked.cancelled_at = now
            locked.apply_fence = None
            locked.save(update_fields=["status", "cancelled_by", "cancelled_at", "apply_fence", "updated_at"])
    if error is not None:
        name = "write_action.cancel_refused"
        metadata = {"reason": reason, "status": locked.status}
    else:
        name = "write_action.cancel" if changed else "write_action.cancel_replayed"
        # Only steps that certainly wrote nothing to GitHub can be cancelled.
        metadata = {"previous_status": previous, "write_outcome": "not_performed"}
    _audit(
        workspace_id=locked.workspace_id,
        project_id=locked.project_id,
        actor_id=user_id,
        request_id=request_id,
        name=name,
        target_id=locked.id,
        metadata={
            "action_type": locked.action_type,
            "request": _request_summary(locked),
            "provider_write_performed": False,
            **metadata,
        },
    )
    if error is not None:
        raise error
    return locked, changed


def _stage(action):
    if action.action_type == PpmGitWriteActionType.CREATE_BRANCH:
        return "branch"
    if action.action_type == PpmGitWriteActionType.CREATE_DRAFT_PR:
        return "pull_request"
    return "legacy"


def _apply_blockers(action, *, writes_enabled, now):
    if action.action_type not in TWO_STAGE_TYPES:
        return ["LEGACY_FLOW"]
    if action.status in {
        PpmGitWriteActionStatus.APPLIED,
        PpmGitWriteActionStatus.REJECTED,
        PpmGitWriteActionStatus.CANCELLED,
        PpmGitWriteActionStatus.CONFLICT,
    }:
        return ["STATUS_FINAL"]
    if action.status == PpmGitWriteActionStatus.APPLYING and not _lease_expired(action, now):
        return ["APPLY_IN_PROGRESS"]
    blockers = []
    if action.status == PpmGitWriteActionStatus.PROPOSED:
        blockers.append("APPROVAL_REQUIRED")
    if action.status == PpmGitWriteActionStatus.FAILED and action.retry_after and action.retry_after > now:
        blockers.append("RETRY_LATER")
    if not writes_enabled:
        blockers.append("PROVIDER_WRITE_DISABLED")
    if action.connection.status not in WRITE_CONNECTION_STATUSES:
        blockers.append("CONNECTION_INACTIVE")
    elif _missing_permissions(action.connection, STEP_REQUIRED_PERMISSIONS[action.action_type]):
        blockers.append("GITHUB_PERMISSIONS_MISSING")
    return blockers


def _can_cancel(action):
    if action.status in {PpmGitWriteActionStatus.PROPOSED, PpmGitWriteActionStatus.APPROVED}:
        return True
    return action.status == PpmGitWriteActionStatus.FAILED and not _outcome_unknown(action)


def _follow_up_context(actions):
    applied_branches = [
        action
        for action in actions
        if action.action_type == PpmGitWriteActionType.CREATE_BRANCH
        and action.status == PpmGitWriteActionStatus.APPLIED
    ]
    if not applied_branches:
        return {}, {}
    heads = {
        (row["repository_id"], row["provider_object_id"]): row
        for row in PpmGitObject.objects.filter(
            object_type=PpmGitObjectType.BRANCH,
            repository_id__in={action.repository_id for action in applied_branches},
            provider_object_id__in={action.head_ref for action in applied_branches},
        ).values("repository_id", "provider_object_id", "commit_sha", "is_active")
    }
    children = {}
    for child in (
        PpmGitWriteAction.objects.filter(
            parent_action_id__in=[action.id for action in applied_branches],
            action_type=PpmGitWriteActionType.CREATE_DRAFT_PR,
        )
        .order_by("-created_at")
        .values("id", "parent_action_id", "status")
    ):
        children.setdefault(child["parent_action_id"], child)
    return heads, children


def _follow_up(action, heads, children):
    if action.action_type != PpmGitWriteActionType.CREATE_BRANCH or action.status != PpmGitWriteActionStatus.APPLIED:
        return None
    head = heads.get((action.repository_id, action.head_ref))
    head_sha = head["commit_sha"] if head and head["is_active"] and head["commit_sha"] else None
    child = children.get(action.id)
    return {
        # Webhook/reconciliation saw a commit on the new branch beyond the base: the second preview is worth
        # preparing. The preview itself re-reads GitHub; the webhook never triggers a write.
        "pull_request_ready": bool(head_sha and head_sha != action.base_sha),
        "branch_head_sha": head_sha,
        "branch_active": bool(head and head["is_active"]),
        "pull_request_action": ({"id": str(child["id"]), "status": child["status"]} if child else None),
    }


def _isoformat(value):
    return value.isoformat() if value else None


def _serialize(action, *, writes_enabled, now, heads, children):
    blockers = _apply_blockers(action, writes_enabled=writes_enabled, now=now)
    return {
        "id": str(action.id),
        "action_type": action.action_type,
        "stage": _stage(action),
        "status": action.status,
        "client_operation_id": str(action.client_operation_id),
        "parent_action_id": str(action.parent_action_id) if action.parent_action_id else None,
        "base_sha": action.base_sha,
        "head_sha": action.head_sha,
        "preview": action.preview,
        "result": action.result,
        "error": ({"code": action.error_code, "message": action.error_message} if action.error_code else None),
        "created_by": str(action.created_by),
        "decided_by": str(action.decided_by) if action.decided_by else None,
        "applied_by": str(action.applied_by) if action.applied_by else None,
        "cancelled_by": str(action.cancelled_by) if action.cancelled_by else None,
        "created_at": action.created_at.isoformat(),
        "updated_at": action.updated_at.isoformat(),
        "decided_at": _isoformat(action.decided_at),
        "applied_at": _isoformat(action.applied_at),
        "cancelled_at": _isoformat(action.cancelled_at),
        "apply_attempts": action.apply_attempts,
        "retry_after": _isoformat(action.retry_after),
        "apply_available": not blockers,
        "apply_blockers": blockers,
        "can_cancel": _can_cancel(action),
        "outcome_unknown": _outcome_unknown(action),
        "follow_up": _follow_up(action, heads, children),
    }


def serialize_git_write_actions(actions):
    actions = list(actions)
    heads, children = _follow_up_context(actions)
    writes_enabled = _writes_enabled()
    now = timezone.now()
    return [
        _serialize(action, writes_enabled=writes_enabled, now=now, heads=heads, children=children) for action in actions
    ]


def serialize_git_write_action(action):
    return serialize_git_write_actions([action])[0]
