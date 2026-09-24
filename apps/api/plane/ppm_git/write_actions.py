import hashlib
import json
import re

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.db.models import Issue

from .models import (
    PpmGitConnection,
    PpmGitConnectionStatus,
    PpmGitRepository,
    PpmGitRepositoryStatus,
    PpmGitWriteAction,
    PpmGitWriteActionStatus,
    PpmGitWriteActionType,
)
from .services import PpmGitError, normalize_name, parse_uuid, reject_credential_fields


REF_CONTROL_OR_SPACE = re.compile(r"[\x00-\x20\x7f]")
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
WRITE_REQUIRED_PERMISSIONS = {"contents": "write", "pull_requests": "write"}
WRITE_DISPLAY_PERMISSIONS = {"metadata": "read", **WRITE_REQUIRED_PERMISSIONS}


def normalize_git_ref(value, *, field):
    if not isinstance(value, str):
        raise PpmGitError("GIT_WRITE_INVALID_REF", "Название ветки должно быть строкой.", {"field": field})
    ref = value.strip()
    invalid = (
        not ref
        or len(ref) > 255
        or REF_CONTROL_OR_SPACE.search(ref)
        or ref == "@"
        or ref.startswith(("/", ".", "-"))
        or ref.endswith(("/", "."))
        or ".." in ref
        or "//" in ref
        or "@{" in ref
        or any(character in ref for character in "~^:?*[\\")
        or any(part.startswith(".") or part.endswith((".", ".lock")) for part in ref.split("/"))
    )
    if invalid:
        raise PpmGitError(
            "GIT_WRITE_INVALID_REF",
            "Название ветки не соответствует безопасному формату Git.",
            {"field": field},
        )
    return ref


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


def _provider_write_ready(connection):
    permissions = connection.permissions or {}
    return (
        bool(getattr(settings, "PPM_GIT_WRITE_ENABLED", False))
        and permissions.get("contents") == "write"
        and permissions.get("pull_requests") == "write"
    )


def serialize_git_write_readiness(connections):
    values = []
    for connection in connections:
        current_permissions = connection.permissions if isinstance(connection.permissions, dict) else {}
        missing_permissions = [
            name for name, required in WRITE_REQUIRED_PERMISSIONS.items() if current_permissions.get(name) != required
        ]
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

    provider_writes_enabled = bool(getattr(settings, "PPM_GIT_WRITE_ENABLED", False))
    permission_ready = any(value["permission_ready"] for value in values)
    blockers = ["OWNER_DECISION_REQUIRED", "APPLY_ENDPOINT_PENDING"]
    if not provider_writes_enabled:
        blockers.append("PROVIDER_WRITE_DISABLED")
    if not permission_ready:
        blockers.append("GITHUB_PERMISSIONS_MISSING")
    return {
        "provider": "github",
        "flow": "branch_then_commit_then_draft_pr",
        "decision_status": "proposed",
        "required_permissions": WRITE_DISPLAY_PERMISSIONS,
        "provider_writes_enabled": provider_writes_enabled,
        "permission_ready": permission_ready,
        "apply_available": False,
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
        status=PpmGitConnectionStatus.ACTIVE,
    ).first()
    if connection is None:
        raise PpmGitError(
            "GIT_WRITE_CONNECTION_REQUIRED",
            "Для подготовки Git-действия нужен активный подключённый репозиторий.",
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


def _normalized_request(*, workspace_id, project_id, payload):
    reject_credential_fields(payload)
    allowed = {
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
    title = normalize_name(payload.get("title"), field="title", maximum=500)
    body = _normalize_body(payload.get("body"))
    normalized = {
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
    return normalized, operation_id, repository, connection, work_item


def _build_preview(*, repository, connection, work_item, base_ref, head_ref, title, body):
    identifier = f"{work_item.project.identifier}-{work_item.sequence_id}"
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
            "account_login": connection.installation.account_login,
            "permissions": connection.permissions,
            "write_ready": _provider_write_ready(connection),
        },
        "branch": {"base_ref": base_ref, "head_ref": head_ref},
        "draft_pull_request": {"title": title, "body": body, "is_draft": True},
        "work_item": {
            "id": str(work_item.id),
            "identifier": identifier,
            "title": work_item.name,
            "updated_at": work_item.updated_at.isoformat(),
        },
        "safety": {
            "provider_write_performed": False,
            "merge_allowed": False,
            "message": "Это предварительный просмотр. GitHub не изменяется до отдельной команды применения.",
        },
    }


def create_git_write_action_preview(*, workspace_id, project_id, payload, user_id):
    normalized, operation_id, repository, connection, work_item = _normalized_request(
        workspace_id=workspace_id,
        project_id=project_id,
        payload=payload,
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

    preview = _build_preview(
        repository=repository,
        connection=connection,
        work_item=work_item,
        base_ref=normalized["base_ref"],
        head_ref=normalized["head_ref"],
        title=normalized["title"],
        body=normalized["body"],
    )
    try:
        with transaction.atomic():
            action = PpmGitWriteAction.objects.create(
                workspace_id=workspace_id,
                project_id=project_id,
                repository=repository,
                connection=connection,
                work_item=work_item,
                action_type=PpmGitWriteActionType.CREATE_BRANCH_DRAFT_PR,
                client_operation_id=operation_id,
                request_fingerprint=fingerprint,
                repository_updated_at=repository.updated_at,
                connection_updated_at=connection.updated_at,
                work_item_updated_at=work_item.updated_at,
                base_ref=normalized["base_ref"],
                head_ref=normalized["head_ref"],
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

        if decision == "approve":
            repository, connection, work_item = _get_sources(
                workspace_id=locked.workspace_id,
                project_id=locked.project_id,
                repository_id=locked.repository_id,
                work_item_id=locked.work_item_id,
                lock=True,
            )
            if (
                repository.updated_at != locked.repository_updated_at
                or connection.updated_at != locked.connection_updated_at
                or work_item.updated_at != locked.work_item_updated_at
            ):
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


def serialize_git_write_action(action):
    return {
        "id": str(action.id),
        "action_type": action.action_type,
        "status": action.status,
        "client_operation_id": str(action.client_operation_id),
        "preview": action.preview,
        "result": action.result,
        "error": ({"code": action.error_code, "message": action.error_message} if action.error_code else None),
        "created_by": str(action.created_by),
        "decided_by": str(action.decided_by) if action.decided_by else None,
        "created_at": action.created_at.isoformat(),
        "updated_at": action.updated_at.isoformat(),
        "decided_at": action.decided_at.isoformat() if action.decided_at else None,
        "apply_available": False,
    }
