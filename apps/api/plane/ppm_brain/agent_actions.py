import hashlib
import json
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Max, Q
from django.utils.html import escape
from django.utils import timezone

from plane.db.models import Issue, Project
from plane.ppm_canvas.models import (
    PpmCanvasBoard,
    PpmCanvasStatus,
    PpmSemanticEdgeConfirmationStatus,
    PpmSemanticEdgeOrigin,
)
from plane.ppm_canvas.schema import canvas_snapshot_shape_ids
from plane.ppm_canvas.services import PpmCanvasConflict, create_semantic_edge, serialize_semantic_edge
from plane.ppm_vault.services import PpmVaultConflict, create_markdown, get_or_create_project_vault

from .agent_registry import (
    PpmAgentRegistryError,
    get_agent_definition,
    get_agent_tool_definition,
    validate_agent_tool_call,
    validate_approved_action_tool_call,
)
from .models import (
    PpmAgentAction,
    PpmAgentActionKind,
    PpmAgentActionStatus,
    PpmAgentAuditEvent,
    PpmAgentCitation,
    PpmAgentRun,
    PpmAgentRunStatus,
    PpmKnowledgeIndexState,
    PpmKnowledgeSource,
    PpmKnowledgeSourceType,
)


MAX_AGENT_CITATIONS = 50
ALLOWED_CONTEXT_KEYS = {"canvas_id", "selected_shape_ids", "thread_id", "locale"}
PROPOSAL_ACTION_KIND = {
    "propose_work_items": PpmAgentActionKind.CREATE_WORK_ITEMS,
    "propose_semantic_edges": PpmAgentActionKind.APPLY_SEMANTIC_EDGES,
    "propose_page_or_vault_note": PpmAgentActionKind.WRITE_VAULT_FILE,
}
APPLIER_TOOL_BY_ACTION_KIND = {
    PpmAgentActionKind.CREATE_WORK_ITEMS: "create_work_items_from_action",
    PpmAgentActionKind.APPLY_SEMANTIC_EDGES: "apply_semantic_edges",
    PpmAgentActionKind.WRITE_VAULT_FILE: "write_vault_file_from_action",
}
TERMINAL_AGENT_RUN_STATUSES = {
    PpmAgentRunStatus.COMPLETED,
    PpmAgentRunStatus.FAILED,
    PpmAgentRunStatus.TIMED_OUT,
    PpmAgentRunStatus.CANCELLED,
    PpmAgentRunStatus.REJECTED,
}


class PpmAgentActionError(ValueError):
    def __init__(self, *, code, message, details=None):
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


def _uuid(value, *, code, message):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise PpmAgentActionError(code=code, message=message) from exc


def _canonical_hash(value):
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PpmAgentActionError(
            code="AGENT_INPUT_NOT_SERIALIZABLE",
            message="Вход проектного агента содержит неподдерживаемые данные.",
        ) from exc
    return hashlib.sha256(encoded).hexdigest()


def _normalize_context(context):
    if not isinstance(context, dict):
        raise PpmAgentActionError(code="AGENT_CONTEXT_INVALID", message="Контекст агента должен быть объектом.")
    unknown = sorted(set(context) - ALLOWED_CONTEXT_KEYS)
    if unknown:
        raise PpmAgentActionError(
            code="AGENT_CONTEXT_FIELD_FORBIDDEN",
            message="Контекст агента содержит запрещённые поля.",
            details={"fields": unknown},
        )
    normalized = {}
    if context.get("canvas_id") is not None:
        normalized["canvas_id"] = str(
            _uuid(
                context["canvas_id"],
                code="AGENT_CONTEXT_CANVAS_INVALID",
                message="Не удалось определить холст агента.",
            )
        )
    if context.get("thread_id") is not None:
        normalized["thread_id"] = str(context["thread_id"])[:255]
    selected_shape_ids = context.get("selected_shape_ids", [])
    if not isinstance(selected_shape_ids, list) or len(selected_shape_ids) > 50:
        raise PpmAgentActionError(
            code="AGENT_CONTEXT_SHAPES_INVALID",
            message="Можно передать не более 50 выбранных объектов холста.",
        )
    normalized_shape_ids = []
    for shape_id in selected_shape_ids:
        if not isinstance(shape_id, str):
            raise PpmAgentActionError(
                code="AGENT_CONTEXT_SHAPES_INVALID",
                message="Выбран некорректный объект холста.",
            )
        shape_id = shape_id.strip()
        if not shape_id or len(shape_id) > 255:
            raise PpmAgentActionError(
                code="AGENT_CONTEXT_SHAPES_INVALID",
                message="Выбран некорректный объект холста.",
            )
        if shape_id not in normalized_shape_ids:
            normalized_shape_ids.append(shape_id)
    normalized["selected_shape_ids"] = sorted(normalized_shape_ids)
    locale = str(context.get("locale") or "ru")
    if locale not in {"ru", "en"}:
        raise PpmAgentActionError(code="AGENT_CONTEXT_LOCALE_INVALID", message="Язык агента не поддерживается.")
    normalized["locale"] = locale
    return normalized


def _audit(*, run, action=None, actor_id=None, event_type, metadata=None):
    return PpmAgentAuditEvent.objects.create(
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        run=run,
        action=action,
        actor_id=actor_id,
        event_type=event_type,
        metadata_json=metadata or {},
    )


def _safe_tool_progress(*, run, tool, call_id, status, result_count=None):
    progress = {
        "run_id": str(run.id),
        "call_id": str(call_id),
        "occurred_at": timezone.now().isoformat(),
        "tool": {
            "name": tool.name,
            "mode": tool.mode.value,
            "status": status,
            "result_count": result_count,
        },
    }
    return progress


def start_agent_tool_call(*, run, tool_name, payload, action=None, progress_callback=None):
    """Persist and announce a browser-safe tool step before the real call starts."""
    try:
        tool = validate_agent_tool_call(agent_kind=run.agent_kind, tool_name=tool_name, payload=payload)
    except PpmAgentRegistryError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message, details=exc.details) from exc
    if action is not None and (action.run_id != run.id or action.project_id != run.project_id):
        raise PpmAgentActionError(
            code="AGENT_TOOL_ACTION_SCOPE_INVALID",
            message="Шаг агента не относится к этому запуску.",
        )
    call_id = uuid.uuid4()
    with transaction.atomic():
        locked_run = PpmAgentRun.objects.select_for_update().get(id=run.id)
        _require_agent_run_lease(locked_run, run)
        _audit(
            run=locked_run,
            action=action,
            event_type="tool_call_started",
            metadata={
                "call_id": str(call_id),
                "tool_name": tool.name,
                "tool_mode": tool.mode.value,
                "status": "running",
            },
        )
    if progress_callback is not None:
        progress_callback(
            _safe_tool_progress(
                run=run,
                tool=tool,
                call_id=call_id,
                status="running",
            )
        )
    return call_id


def record_agent_tool_call(
    *,
    run,
    tool_name,
    payload,
    action=None,
    result_count=None,
    call_id=None,
    progress_callback=None,
):
    """Record only allowlisted, browser-safe telemetry after a real local tool call succeeds."""
    try:
        tool = validate_agent_tool_call(agent_kind=run.agent_kind, tool_name=tool_name, payload=payload)
    except PpmAgentRegistryError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message, details=exc.details) from exc
    if action is not None and (action.run_id != run.id or action.project_id != run.project_id):
        raise PpmAgentActionError(
            code="AGENT_TOOL_ACTION_SCOPE_INVALID",
            message="Шаг агента не относится к этому запуску.",
        )
    if result_count is not None and (
        isinstance(result_count, bool) or not isinstance(result_count, int) or not 0 <= result_count <= 100_000
    ):
        raise PpmAgentActionError(
            code="AGENT_TOOL_RESULT_COUNT_INVALID",
            message="Количество результатов шага агента указано неверно.",
        )
    safe_call_id = call_id or uuid.uuid4()
    metadata = {
        "call_id": str(safe_call_id),
        "tool_name": tool.name,
        "tool_mode": tool.mode.value,
        "status": "completed",
    }
    if result_count is not None:
        metadata["result_count"] = result_count
    with transaction.atomic():
        locked_run = PpmAgentRun.objects.select_for_update().get(id=run.id)
        _require_agent_run_lease(locked_run, run)
        event = _audit(
            run=locked_run,
            action=action,
            event_type="tool_call_completed",
            metadata=metadata,
        )
    if progress_callback is not None:
        progress_callback(
            _safe_tool_progress(
                run=run,
                tool=tool,
                call_id=safe_call_id,
                status="completed",
                result_count=result_count,
            )
        )
    return event


def record_approved_action_tool_call(*, run, action, tool_name, result_count, actor_id):
    try:
        tool = validate_approved_action_tool_call(
            tool_name=tool_name,
            payload={"action_id": str(action.id)},
        )
    except PpmAgentRegistryError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message, details=exc.details) from exc
    if action.run_id != run.id or action.project_id != run.project_id:
        raise PpmAgentActionError(
            code="AGENT_TOOL_ACTION_SCOPE_INVALID",
            message="Шаг применения не относится к этому запуску.",
        )
    if isinstance(result_count, bool) or not isinstance(result_count, int) or not 0 <= result_count <= 100_000:
        raise PpmAgentActionError(
            code="AGENT_TOOL_RESULT_COUNT_INVALID",
            message="Количество результатов шага агента указано неверно.",
        )
    return _audit(
        run=run,
        action=action,
        actor_id=actor_id,
        event_type="tool_call_completed",
        metadata={
            "tool_name": tool.name,
            "tool_mode": tool.mode.value,
            "status": "completed",
            "result_count": result_count,
        },
    )


def create_agent_run(
    *,
    workspace_id,
    project_id,
    user_id,
    agent_kind,
    client_operation_id,
    input_payload,
    context=None,
):
    definition = get_agent_definition(agent_kind)
    operation_id = _uuid(
        client_operation_id,
        code="AGENT_OPERATION_ID_INVALID",
        message="Не удалось определить запуск проектного агента.",
    )
    if not isinstance(input_payload, dict):
        raise PpmAgentActionError(code="AGENT_INPUT_INVALID", message="Вход проектного агента должен быть объектом.")
    normalized_context = _normalize_context(context or {})
    board_id = normalized_context.get("canvas_id")
    if board_id:
        board = (
            PpmCanvasBoard.objects.filter(
                id=board_id,
                workspace_id=workspace_id,
                project_id=project_id,
                status=PpmCanvasStatus.ACTIVE,
            )
            .prefetch_related("versions")
            .first()
        )
        if board is None:
            raise PpmAgentActionError(
                code="AGENT_CONTEXT_CANVAS_NOT_FOUND",
                message="Доска холста для запуска агента не найдена.",
            )
        selected_shape_ids = normalized_context["selected_shape_ids"]
        if selected_shape_ids:
            current = board.versions.filter(version=board.current_version).first() if board.current_version else None
            shape_ids = canvas_snapshot_shape_ids(current.snapshot_json) if current else set()
            if set(selected_shape_ids) - shape_ids:
                raise PpmAgentActionError(
                    code="AGENT_CONTEXT_SHAPES_NOT_FOUND",
                    message="Выбранные объекты не найдены на этой доске.",
                )
    input_hash = _canonical_hash({"agent_kind": definition.kind, "input": input_payload, "context": normalized_context})
    existing = PpmAgentRun.objects.filter(
        project_id=project_id,
        created_by=user_id,
        client_operation_id=operation_id,
    ).first()
    if existing is not None:
        if (
            existing.workspace_id != workspace_id
            or existing.agent_kind != definition.kind
            or existing.input_hash != input_hash
            or existing.context_json != normalized_context
        ):
            raise PpmAgentActionError(
                code="AGENT_OPERATION_CONFLICT",
                message="Идентификатор операции уже использован для другого запуска агента.",
            )
        return existing, False
    try:
        with transaction.atomic():
            run, created = PpmAgentRun.objects.get_or_create(
                project_id=project_id,
                created_by=user_id,
                client_operation_id=operation_id,
                defaults={
                    "workspace_id": workspace_id,
                    "agent_kind": definition.kind,
                    "input_hash": input_hash,
                    "input_json": input_payload,
                    "context_json": normalized_context,
                    "capabilities_json": list(definition.allowed_tools),
                },
            )
            if created:
                _audit(
                    run=run,
                    actor_id=user_id,
                    event_type="run_created",
                    metadata={"agent_kind": definition.kind, "input_hash": input_hash},
                )
    except IntegrityError:
        run = PpmAgentRun.objects.get(
            project_id=project_id,
            created_by=user_id,
            client_operation_id=operation_id,
        )
        created = False
    if not created and (
        run.workspace_id != workspace_id
        or run.agent_kind != definition.kind
        or run.input_hash != input_hash
        or run.context_json != normalized_context
    ):
        raise PpmAgentActionError(
            code="AGENT_OPERATION_CONFLICT",
            message="Идентификатор операции уже использован для другого запуска агента.",
        )
    return run, created


def _agent_run_lease_seconds(lease_seconds=None):
    value = lease_seconds if lease_seconds is not None else getattr(settings, "PPM_AGENT_LEASE_SECONDS", 180)
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise PpmAgentActionError(
            code="AGENT_LEASE_INVALID",
            message="Срок аренды исполнителя настроен неверно.",
        ) from exc
    if not 60 <= normalized <= 600:
        raise PpmAgentActionError(
            code="AGENT_LEASE_INVALID",
            message="Срок аренды исполнителя должен быть от 60 до 600 секунд.",
        )
    return normalized


def _agent_run_max_attempts(max_attempts=None):
    value = max_attempts if max_attempts is not None else getattr(settings, "PPM_AGENT_MAX_ATTEMPTS", 3)
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise PpmAgentActionError(
            code="AGENT_ATTEMPTS_INVALID",
            message="Количество попыток агента настроено неверно.",
        ) from exc
    if not 1 <= normalized <= 10:
        raise PpmAgentActionError(
            code="AGENT_ATTEMPTS_INVALID",
            message="Количество попыток агента должно быть от 1 до 10.",
        )
    return normalized


def _clear_agent_run_lease(run):
    run.lease_token = None
    run.lease_expires_at = None
    run.worker_task_id = ""


def _require_agent_run_lease(locked, run, *, now=None):
    checked_at = now or timezone.now()
    token = getattr(run, "lease_token", None)
    if (
        locked.status != PpmAgentRunStatus.RUNNING
        or token is None
        or locked.lease_token != token
        or locked.lease_expires_at is None
        or locked.lease_expires_at <= checked_at
    ):
        raise PpmAgentActionError(
            code="AGENT_RUN_LEASE_LOST",
            message="Исполнение передано другому worker. Устаревшая попытка остановлена.",
        )


def _mark_locked_agent_run_timed_out(locked, *, checked_at, error_message, metadata):
    proposed_actions = list(
        locked.actions.select_for_update().filter(status=PpmAgentActionStatus.PROPOSED).order_by("sequence")
    )
    for action in proposed_actions:
        action.status = PpmAgentActionStatus.CANCELLED
        action.error_code = "AGENT_RUN_TIMED_OUT"
        action.error_message = "Запуск завершён по лимиту времени до применения предложения."
        action.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        _audit(
            run=locked,
            action=action,
            event_type="action_timed_out",
        )
    locked.status = PpmAgentRunStatus.TIMED_OUT
    locked.error_code = "AGENT_RUN_TIMED_OUT"
    locked.error_message = error_message
    locked.finished_at = checked_at
    _clear_agent_run_lease(locked)
    locked.save(
        update_fields=[
            "status",
            "error_code",
            "error_message",
            "finished_at",
            "lease_token",
            "lease_expires_at",
            "worker_task_id",
            "updated_at",
        ]
    )
    _audit(
        run=locked,
        event_type="run_timed_out",
        metadata={**metadata, "cancelled_action_count": len(proposed_actions)},
    )
    return locked


def claim_agent_run(run, *, worker_id="", now=None, lease_seconds=None, max_attempts=None):
    """Atomically claim a queued or expired run for exactly one durable worker."""
    checked_at = now or timezone.now()
    lease_value = _agent_run_lease_seconds(lease_seconds)
    attempt_limit = _agent_run_max_attempts(max_attempts)
    with transaction.atomic():
        locked = PpmAgentRun.objects.select_for_update().get(id=run.id)
        legacy_reference = locked.started_at or locked.created_at
        recovering = locked.status == PpmAgentRunStatus.RUNNING and (
            (locked.lease_expires_at is not None and locked.lease_expires_at <= checked_at)
            or (locked.lease_expires_at is None and legacy_reference <= checked_at - timedelta(seconds=lease_value))
        )
        if locked.status != PpmAgentRunStatus.QUEUED and not recovering:
            return locked, False
        if recovering and locked.attempt_count >= attempt_limit:
            return (
                _mark_locked_agent_run_timed_out(
                    locked,
                    checked_at=checked_at,
                    error_message=(
                        "Исполнитель несколько раз аварийно остановился. Проект не изменён; запуск можно повторить."
                    ),
                    metadata={
                        "previous_status": PpmAgentRunStatus.RUNNING,
                        "reason": "worker_attempts_exhausted",
                        "attempt_count": locked.attempt_count,
                    },
                ),
                False,
            )
        previous_attempt = locked.attempt_count
        previous_worker = locked.worker_task_id
        locked.status = PpmAgentRunStatus.RUNNING
        locked.started_at = locked.started_at or checked_at
        locked.finished_at = None
        locked.error_code = ""
        locked.error_message = ""
        locked.lease_token = uuid.uuid4()
        locked.lease_expires_at = checked_at + timedelta(seconds=lease_value)
        locked.worker_task_id = str(worker_id or "")[:255]
        locked.attempt_count = previous_attempt + 1
        locked.save(
            update_fields=[
                "status",
                "started_at",
                "finished_at",
                "error_code",
                "error_message",
                "lease_token",
                "lease_expires_at",
                "worker_task_id",
                "attempt_count",
                "updated_at",
            ]
        )
        if recovering:
            _audit(
                run=locked,
                actor_id=locked.created_by,
                event_type="run_recovered",
                metadata={
                    "attempt_count": locked.attempt_count,
                    "previous_worker_present": bool(previous_worker),
                },
            )
        _audit(
            run=locked,
            actor_id=locked.created_by,
            event_type="run_started",
            metadata={"attempt_count": locked.attempt_count, "recovered": recovering},
        )
        return locked, True


def renew_agent_run_lease(run, *, now=None, lease_seconds=None):
    """Extend only the currently fenced worker lease; stale attempts cannot renew it."""
    checked_at = now or timezone.now()
    lease_value = _agent_run_lease_seconds(lease_seconds)
    with transaction.atomic():
        locked = PpmAgentRun.objects.select_for_update().get(id=run.id)
        try:
            _require_agent_run_lease(locked, run, now=checked_at)
        except PpmAgentActionError as exc:
            if exc.code == "AGENT_RUN_LEASE_LOST":
                return locked, False
            raise
        locked.lease_expires_at = checked_at + timedelta(seconds=lease_value)
        locked.save(update_fields=["lease_expires_at", "updated_at"])
        run.lease_expires_at = locked.lease_expires_at
        return locked, True


def start_agent_run(run):
    locked, claimed = claim_agent_run(run)
    if claimed:
        return locked
    raise PpmAgentActionError(
        code="AGENT_RUN_NOT_STARTABLE",
        message="Этот запуск агента уже нельзя начать.",
    )


def _resolve_citations(*, run, citations):
    if not isinstance(citations, list) or not citations or len(citations) > MAX_AGENT_CITATIONS:
        raise PpmAgentActionError(
            code="AGENT_CITATIONS_REQUIRED",
            message="Предложение должно содержать от 1 до 50 проверяемых источников.",
        )
    resolved = []
    seen = set()
    for raw in citations:
        if not isinstance(raw, dict):
            raise PpmAgentActionError(code="AGENT_CITATION_INVALID", message="Некорректная ссылка на источник.")
        source_type = str(raw.get("source_type") or "")
        source_id = str(raw.get("source_id") or "")
        if source_type not in PpmKnowledgeSourceType.values or not source_id or (source_type, source_id) in seen:
            raise PpmAgentActionError(code="AGENT_CITATION_INVALID", message="Некорректная ссылка на источник.")
        seen.add((source_type, source_id))
        source = PpmKnowledgeSource.objects.filter(
            workspace_id=run.workspace_id,
            project_id=run.project_id,
            source_type=source_type,
            source_id=source_id,
            index_state=PpmKnowledgeIndexState.READY,
        ).first()
        if source is None:
            raise PpmAgentActionError(
                code="AGENT_CITATION_NOT_READY",
                message="Источник предложения недоступен или ещё не проиндексирован.",
            )
        requested_version = str(raw.get("source_version") or source.source_version)
        if requested_version != source.source_version:
            raise PpmAgentActionError(
                code="AGENT_CITATION_STALE",
                message="Версия источника изменилась до создания предложения.",
            )
        locator = raw.get("locator") or {}
        if not isinstance(locator, dict):
            raise PpmAgentActionError(code="AGENT_CITATION_INVALID", message="Некорректный адрес источника.")
        resolved.append(
            {
                "source_type": source.source_type,
                "source_id": source.source_id,
                "source_version": source.source_version,
                "title": source.title,
                "locator": locator,
            }
        )
    return resolved


def record_run_citations(*, run, citations):
    with transaction.atomic():
        locked_run = PpmAgentRun.objects.select_for_update().get(id=run.id)
        _require_agent_run_lease(locked_run, run)
        resolved_citations = _resolve_citations(run=locked_run, citations=citations)
        existing = list(locked_run.citations.filter(action__isnull=True).order_by("ordinal", "id"))
        if existing:
            existing_fingerprint = _canonical_hash(
                [
                    {
                        "source_type": citation.source_type,
                        "source_id": citation.source_id,
                        "source_version": citation.source_version,
                        "title": citation.title,
                        "locator": citation.locator_json,
                    }
                    for citation in existing
                ]
            )
            requested_fingerprint = _canonical_hash(resolved_citations)
            if existing_fingerprint != requested_fingerprint:
                raise PpmAgentActionError(
                    code="AGENT_RUN_CITATIONS_ALREADY_RECORDED",
                    message="Источники запуска уже зафиксированы с другим составом.",
                )
            return existing
        created = PpmAgentCitation.objects.bulk_create(
            [
                PpmAgentCitation(
                    workspace_id=locked_run.workspace_id,
                    project_id=locked_run.project_id,
                    run=locked_run,
                    ordinal=ordinal,
                    source_type=citation["source_type"],
                    source_id=citation["source_id"],
                    source_version=citation["source_version"],
                    title=citation["title"],
                    locator_json=citation["locator"],
                )
                for ordinal, citation in enumerate(resolved_citations)
            ]
        )
        _audit(
            run=locked_run,
            event_type="run_citations_recorded",
            metadata={"citation_count": len(created)},
        )
        return created


def add_proposed_action(
    *,
    run,
    proposal_tool,
    payload,
    preview,
    citations,
    idempotency_key,
    tool_call_id=None,
    progress_callback=None,
):
    try:
        tool = validate_agent_tool_call(agent_kind=run.agent_kind, tool_name=proposal_tool, payload=payload)
    except PpmAgentRegistryError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message, details=exc.details) from exc
    action_kind = PROPOSAL_ACTION_KIND.get(tool.name)
    if action_kind is None:
        raise PpmAgentActionError(
            code="AGENT_TOOL_NOT_PROPOSAL",
            message="Read-only инструмент не может создать предложение изменения.",
        )
    if not isinstance(preview, dict) or not preview:
        raise PpmAgentActionError(
            code="AGENT_ACTION_PREVIEW_REQUIRED",
            message="Для предложения обязателен понятный предварительный просмотр.",
        )
    operation_id = _uuid(
        idempotency_key,
        code="AGENT_ACTION_IDEMPOTENCY_INVALID",
        message="Не удалось определить предложение агента.",
    )
    with transaction.atomic():
        locked_run = PpmAgentRun.objects.select_for_update().get(id=run.id)
        _require_agent_run_lease(locked_run, run)
        existing = PpmAgentAction.objects.filter(project_id=run.project_id, idempotency_key=operation_id).first()
        payload_hash = _canonical_hash(payload)
        preview_hash = _canonical_hash(preview)
        if existing is not None:
            existing_fingerprint = _canonical_hash(
                {
                    "run_id": str(existing.run_id),
                    "proposal_tool": existing.proposal_tool,
                    "payload": existing.payload_json,
                    "preview": existing.preview_json,
                }
            )
            requested_fingerprint = _canonical_hash(
                {
                    "run_id": str(run.id),
                    "proposal_tool": tool.name,
                    "payload": payload,
                    "preview": preview,
                }
            )
            if existing_fingerprint != requested_fingerprint:
                raise PpmAgentActionError(
                    code="AGENT_ACTION_IDEMPOTENCY_CONFLICT",
                    message="Идентификатор уже использован для другого предложения.",
                )
            record_agent_tool_call(
                run=locked_run,
                action=existing,
                tool_name=tool.name,
                payload=payload,
                result_count=1,
                call_id=tool_call_id,
                progress_callback=progress_callback,
            )
            return existing, False
        resolved_citations = _resolve_citations(run=locked_run, citations=citations)
        max_sequence = locked_run.actions.aggregate(value=Max("sequence"))["value"]
        sequence = 0 if max_sequence is None else max_sequence + 1
        preconditions = {
            "workspace_id": str(locked_run.workspace_id),
            "project_id": str(locked_run.project_id),
            "sources": [
                {
                    "source_type": citation["source_type"],
                    "source_id": citation["source_id"],
                    "source_version": citation["source_version"],
                }
                for citation in resolved_citations
            ],
        }
        action = PpmAgentAction.objects.create(
            workspace_id=locked_run.workspace_id,
            project_id=locked_run.project_id,
            run=locked_run,
            sequence=sequence,
            action_kind=action_kind,
            proposal_tool=tool.name,
            payload_json=payload,
            preview_json=preview,
            preconditions_json=preconditions,
            idempotency_key=operation_id,
        )
        max_ordinal = locked_run.citations.aggregate(value=Max("ordinal"))["value"]
        next_ordinal = 0 if max_ordinal is None else max_ordinal + 1
        PpmAgentCitation.objects.bulk_create(
            [
                PpmAgentCitation(
                    workspace_id=locked_run.workspace_id,
                    project_id=locked_run.project_id,
                    run=locked_run,
                    action=action,
                    ordinal=next_ordinal + offset,
                    source_type=citation["source_type"],
                    source_id=citation["source_id"],
                    source_version=citation["source_version"],
                    title=citation["title"],
                    locator_json=citation["locator"],
                )
                for offset, citation in enumerate(resolved_citations)
            ]
        )
        record_agent_tool_call(
            run=locked_run,
            action=action,
            tool_name=tool.name,
            payload=payload,
            result_count=1,
            call_id=tool_call_id,
            progress_callback=progress_callback,
        )
        _audit(
            run=locked_run,
            action=action,
            event_type="action_proposed",
            metadata={"proposal_tool": tool.name, "payload_hash": payload_hash, "preview_hash": preview_hash},
        )
        return action, True


def finish_agent_run(run, *, result=None):
    if result is not None and not isinstance(result, dict):
        raise PpmAgentActionError(code="AGENT_RESULT_INVALID", message="Результат агента должен быть объектом.")
    with transaction.atomic():
        locked = PpmAgentRun.objects.select_for_update().get(id=run.id)
        _require_agent_run_lease(locked, run)
        has_actions = locked.actions.filter(status=PpmAgentActionStatus.PROPOSED).exists()
        locked.status = PpmAgentRunStatus.AWAITING_APPROVAL if has_actions else PpmAgentRunStatus.COMPLETED
        locked.result_json = result or {}
        locked.finished_at = timezone.now() if not has_actions else None
        _clear_agent_run_lease(locked)
        locked.save(
            update_fields=[
                "status",
                "result_json",
                "finished_at",
                "lease_token",
                "lease_expires_at",
                "worker_task_id",
                "updated_at",
            ]
        )
        _audit(
            run=locked,
            event_type="run_awaiting_approval" if has_actions else "run_completed",
            metadata={"action_count": locked.actions.count()},
        )
        return locked


def fail_agent_run(run, *, error_code, error_message):
    with transaction.atomic():
        locked = PpmAgentRun.objects.select_for_update().get(id=run.id)
        if locked.status in TERMINAL_AGENT_RUN_STATUSES:
            return locked
        if locked.status == PpmAgentRunStatus.RUNNING:
            try:
                _require_agent_run_lease(locked, run)
            except PpmAgentActionError as exc:
                if exc.code == "AGENT_RUN_LEASE_LOST":
                    return locked
                raise
        locked.status = PpmAgentRunStatus.FAILED
        locked.error_code = str(error_code or "AGENT_RUN_FAILED")[:64]
        locked.error_message = str(error_message or "Не удалось выполнить проектного агента.")[:500]
        locked.finished_at = timezone.now()
        _clear_agent_run_lease(locked)
        locked.save(
            update_fields=[
                "status",
                "error_code",
                "error_message",
                "finished_at",
                "lease_token",
                "lease_expires_at",
                "worker_task_id",
                "updated_at",
            ]
        )
        _audit(
            run=locked,
            event_type="run_failed",
            metadata={"error_code": locked.error_code},
        )
        return locked


def _agent_run_timeout_seconds(timeout_seconds=None):
    value = timeout_seconds
    if value is None:
        value = getattr(settings, "PPM_AGENT_RUN_TIMEOUT_SECONDS", 120)
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise PpmAgentActionError(
            code="AGENT_TIMEOUT_INVALID",
            message="Лимит времени проектного агента настроен неверно.",
        ) from exc
    if not 30 <= normalized <= 3600:
        raise PpmAgentActionError(
            code="AGENT_TIMEOUT_INVALID",
            message="Лимит времени проектного агента должен быть от 30 секунд до 1 часа.",
        )
    return normalized


def timeout_agent_run(*, run, now=None, timeout_seconds=None):
    checked_at = now or timezone.now()
    timeout_value = _agent_run_timeout_seconds(timeout_seconds)
    cutoff = checked_at - timedelta(seconds=timeout_value)
    with transaction.atomic():
        locked = PpmAgentRun.objects.select_for_update().get(id=run.id)
        if locked.status == PpmAgentRunStatus.TIMED_OUT:
            return locked, False
        if locked.status not in {PpmAgentRunStatus.QUEUED, PpmAgentRunStatus.RUNNING}:
            return locked, False
        if (
            locked.status == PpmAgentRunStatus.RUNNING
            and locked.lease_token is not None
            and locked.lease_expires_at is not None
        ):
            return locked, False
        reference_time = locked.started_at if locked.status == PpmAgentRunStatus.RUNNING else locked.created_at
        reference_time = reference_time or locked.created_at
        if reference_time > cutoff:
            return locked, False

        previous_status = locked.status
        return (
            _mark_locked_agent_run_timed_out(
                locked,
                checked_at=checked_at,
                error_message=("Запуск превысил безопасный лимит времени. Проект не изменён; запуск можно повторить."),
                metadata={
                    "previous_status": previous_status,
                    "timeout_seconds": timeout_value,
                },
            ),
            True,
        )


def expire_stale_agent_runs(
    *,
    now=None,
    timeout_seconds=None,
    workspace_id=None,
    project_id=None,
    created_by=None,
    limit=500,
):
    checked_at = now or timezone.now()
    timeout_value = _agent_run_timeout_seconds(timeout_seconds)
    cutoff = checked_at - timedelta(seconds=timeout_value)
    query = PpmAgentRun.objects.filter(
        Q(status=PpmAgentRunStatus.QUEUED, created_at__lte=cutoff)
        | Q(
            status=PpmAgentRunStatus.RUNNING,
            lease_token__isnull=True,
            started_at__lte=cutoff,
        )
        | Q(
            status=PpmAgentRunStatus.RUNNING,
            lease_token__isnull=True,
            started_at__isnull=True,
            created_at__lte=cutoff,
        )
    )
    if workspace_id is not None:
        query = query.filter(workspace_id=workspace_id)
    if project_id is not None:
        query = query.filter(project_id=project_id)
    if created_by is not None:
        query = query.filter(created_by=created_by)
    run_ids = list(query.order_by("created_at").values_list("id", flat=True)[: max(1, min(int(limit), 1000))])
    expired_count = 0
    for run_id in run_ids:
        run = PpmAgentRun(id=run_id)
        _, changed = timeout_agent_run(run=run, now=checked_at, timeout_seconds=timeout_value)
        expired_count += int(changed)
    return expired_count


def cancel_agent_run(*, run, user_id):
    with transaction.atomic():
        locked = PpmAgentRun.objects.select_for_update().get(id=run.id)
        if locked.created_by != user_id:
            raise PpmAgentActionError(
                code="AGENT_RUN_CANCEL_FORBIDDEN",
                message="Отменить можно только собственный запуск агента.",
            )
        if locked.status == PpmAgentRunStatus.CANCELLED:
            return locked, False
        if locked.status not in {
            PpmAgentRunStatus.QUEUED,
            PpmAgentRunStatus.RUNNING,
            PpmAgentRunStatus.AWAITING_APPROVAL,
        }:
            raise PpmAgentActionError(
                code="AGENT_RUN_NOT_CANCELLABLE",
                message="Этот запуск агента уже нельзя отменить.",
            )
        blocking_statuses = {
            PpmAgentActionStatus.APPROVED,
            PpmAgentActionStatus.APPLYING,
            PpmAgentActionStatus.APPLIED,
        }
        if locked.actions.filter(status__in=blocking_statuses).exists():
            raise PpmAgentActionError(
                code="AGENT_RUN_ALREADY_REVIEWED",
                message="Запуск содержит уже принятое предложение и не может быть отменён.",
            )
        now = timezone.now()
        proposed_actions = list(
            locked.actions.select_for_update().filter(status=PpmAgentActionStatus.PROPOSED).order_by("sequence")
        )
        for action in proposed_actions:
            action.status = PpmAgentActionStatus.CANCELLED
            action.save(update_fields=["status", "updated_at"])
            _audit(
                run=locked,
                action=action,
                actor_id=user_id,
                event_type="action_cancelled",
            )
        locked.status = PpmAgentRunStatus.CANCELLED
        locked.cancel_requested_at = now
        locked.finished_at = now
        _clear_agent_run_lease(locked)
        locked.save(
            update_fields=[
                "status",
                "cancel_requested_at",
                "finished_at",
                "lease_token",
                "lease_expires_at",
                "worker_task_id",
                "updated_at",
            ]
        )
        _audit(
            run=locked,
            actor_id=user_id,
            event_type="run_cancelled",
            metadata={"cancelled_action_count": len(proposed_actions)},
        )
        return locked, True


def retry_agent_run(*, original_run, user_id, client_operation_id, input_payload):
    with transaction.atomic():
        original = PpmAgentRun.objects.select_for_update().get(id=original_run.id)
        if original.created_by != user_id:
            raise PpmAgentActionError(
                code="AGENT_RUN_RETRY_FORBIDDEN",
                message="Повторить можно только собственный запуск агента.",
            )
        if original.status not in {
            PpmAgentRunStatus.FAILED,
            PpmAgentRunStatus.TIMED_OUT,
            PpmAgentRunStatus.CANCELLED,
            PpmAgentRunStatus.REJECTED,
        }:
            raise PpmAgentActionError(
                code="AGENT_RUN_NOT_RETRYABLE",
                message="Повторить можно только ошибочный, отменённый или отклонённый запуск.",
            )
        normalized_context = _normalize_context(original.context_json)
        retry_hash = _canonical_hash(
            {
                "agent_kind": original.agent_kind,
                "input": input_payload,
                "context": normalized_context,
            }
        )
        if retry_hash != original.input_hash:
            raise PpmAgentActionError(
                code="AGENT_RETRY_INPUT_CHANGED",
                message="Для повтора нужно отправить те же параметры. Для новых параметров создайте новый запуск.",
            )
        retried, created = create_agent_run(
            workspace_id=original.workspace_id,
            project_id=original.project_id,
            user_id=user_id,
            agent_kind=original.agent_kind,
            client_operation_id=client_operation_id,
            input_payload=input_payload,
            context=normalized_context,
        )
        if retried.id == original.id:
            raise PpmAgentActionError(
                code="AGENT_RETRY_OPERATION_REUSED",
                message="Для повторного запуска нужен новый идентификатор операции.",
            )
        retry_link = PpmAgentAuditEvent.objects.filter(run=retried, event_type="run_retried_from").first()
        if not created:
            if retry_link is None or retry_link.metadata_json.get("original_run_id") != str(original.id):
                raise PpmAgentActionError(
                    code="AGENT_RETRY_OPERATION_CONFLICT",
                    message="Идентификатор повтора уже использован для другого запуска.",
                )
            return retried, False
        _audit(
            run=original,
            actor_id=user_id,
            event_type="run_retry_created",
            metadata={"retry_run_id": str(retried.id)},
        )
        _audit(
            run=retried,
            actor_id=user_id,
            event_type="run_retried_from",
            metadata={"original_run_id": str(original.id)},
        )
        return retried, True


def _assert_action_preconditions_current(action):
    preconditions = action.preconditions_json
    if not isinstance(preconditions, dict):
        raise PpmAgentActionError(
            code="AGENT_ACTION_PRECONDITION_INVALID",
            message="У предложения повреждены условия применения.",
            details={"action_id": str(action.id)},
        )
    if preconditions.get("workspace_id") != str(action.workspace_id) or preconditions.get("project_id") != str(
        action.project_id
    ):
        raise PpmAgentActionError(
            code="AGENT_ACTION_SCOPE_CHANGED",
            message="Область проекта изменилась после создания предложения.",
            details={"action_id": str(action.id)},
        )
    sources = preconditions.get("sources")
    if not isinstance(sources, list) or not sources:
        raise PpmAgentActionError(
            code="AGENT_ACTION_PRECONDITION_INVALID",
            message="У предложения отсутствуют проверяемые источники.",
            details={"action_id": str(action.id)},
        )
    for source in sources:
        if not isinstance(source, dict):
            raise PpmAgentActionError(
                code="AGENT_ACTION_PRECONDITION_INVALID",
                message="У предложения повреждены условия источника.",
                details={"action_id": str(action.id)},
            )
        current = PpmKnowledgeSource.objects.filter(
            workspace_id=action.workspace_id,
            project_id=action.project_id,
            source_type=source.get("source_type"),
            source_id=source.get("source_id"),
            source_version=source.get("source_version"),
            index_state=PpmKnowledgeIndexState.READY,
        ).exists()
        if not current:
            raise PpmAgentActionError(
                code="AGENT_ACTION_SOURCE_CHANGED",
                message="Один из источников изменился после подготовки предложения.",
                details={
                    "action_id": str(action.id),
                    "source_type": source.get("source_type"),
                    "source_id": source.get("source_id"),
                },
            )


def review_agent_action(*, action, user_id, approve):
    with transaction.atomic():
        locked = PpmAgentAction.objects.select_for_update().select_related("run").get(id=action.id)
        expected_status = PpmAgentActionStatus.APPROVED if approve else PpmAgentActionStatus.REJECTED
        if locked.status == expected_status:
            expected_actor = locked.approved_by if approve else locked.rejected_by
            if expected_actor == user_id:
                return locked, False
        if locked.status != PpmAgentActionStatus.PROPOSED:
            raise PpmAgentActionError(
                code="AGENT_ACTION_ALREADY_REVIEWED",
                message="Предложение агента уже рассмотрено.",
            )
        if approve:
            _assert_action_preconditions_current(locked)
            locked.status = PpmAgentActionStatus.APPROVED
            locked.approved_by = user_id
            locked.approved_at = timezone.now()
            fields = ["status", "approved_by", "approved_at", "updated_at"]
            event_type = "action_approved"
        else:
            locked.status = PpmAgentActionStatus.REJECTED
            locked.rejected_by = user_id
            locked.rejected_at = timezone.now()
            fields = ["status", "rejected_by", "rejected_at", "updated_at"]
            event_type = "action_rejected"
        locked.save(update_fields=fields)
        _audit(run=locked.run, action=locked, actor_id=user_id, event_type=event_type)
        if not approve and not locked.run.actions.filter(status=PpmAgentActionStatus.PROPOSED).exists():
            locked.run.status = (
                PpmAgentRunStatus.AWAITING_APPROVAL
                if locked.run.actions.filter(status=PpmAgentActionStatus.APPROVED).exists()
                else PpmAgentRunStatus.REJECTED
            )
            if locked.run.status == PpmAgentRunStatus.REJECTED:
                locked.run.finished_at = timezone.now()
            locked.run.save(update_fields=["status", "finished_at", "updated_at"])
        return locked, True


def summarize_agent_actions(actions):
    action_list = list(actions)
    counts = {status: 0 for status in PpmAgentActionStatus.values}
    for action in action_list:
        counts[action.status] = counts.get(action.status, 0) + 1
    total = len(action_list)
    remaining = counts[PpmAgentActionStatus.PROPOSED]
    reviewed = sum(
        counts[status]
        for status in (
            PpmAgentActionStatus.APPROVED,
            PpmAgentActionStatus.REJECTED,
            PpmAgentActionStatus.APPLYING,
            PpmAgentActionStatus.APPLIED,
            PpmAgentActionStatus.CONFLICT,
            PpmAgentActionStatus.FAILED,
        )
    )
    decision_kinds = sum(
        1
        for status in (
            PpmAgentActionStatus.APPROVED,
            PpmAgentActionStatus.REJECTED,
            PpmAgentActionStatus.CANCELLED,
        )
        if counts[status]
    )
    return {
        "total": total,
        "reviewed": reviewed,
        "remaining": remaining,
        "approved": counts[PpmAgentActionStatus.APPROVED],
        "rejected": counts[PpmAgentActionStatus.REJECTED],
        "cancelled": counts[PpmAgentActionStatus.CANCELLED],
        "applying": counts[PpmAgentActionStatus.APPLYING],
        "applied": counts[PpmAgentActionStatus.APPLIED],
        "conflict": counts[PpmAgentActionStatus.CONFLICT],
        "failed": counts[PpmAgentActionStatus.FAILED],
        "review_complete": total > 0 and remaining == 0,
        "partial": (reviewed > 0 and remaining > 0) or decision_kinds > 1,
        "canonical_changes_applied": counts[PpmAgentActionStatus.APPLIED] > 0,
    }


def review_agent_actions_batch(*, run, user_id, decisions):
    if not isinstance(decisions, list) or not 1 <= len(decisions) <= 50:
        raise PpmAgentActionError(
            code="AGENT_BATCH_REVIEW_INVALID",
            message="Передайте от 1 до 50 решений по действиям агента.",
        )
    normalized = []
    seen = set()
    for raw in decisions:
        if not isinstance(raw, dict) or set(raw) != {"action_id", "decision"}:
            raise PpmAgentActionError(
                code="AGENT_BATCH_REVIEW_INVALID",
                message="Каждое решение должно содержать только action_id и decision.",
            )
        action_id = _uuid(
            raw.get("action_id"),
            code="AGENT_BATCH_ACTION_ID_INVALID",
            message="Не удалось определить действие в наборе.",
        )
        decision = str(raw.get("decision") or "")
        if decision not in {"approve", "reject"}:
            raise PpmAgentActionError(
                code="AGENT_BATCH_DECISION_INVALID",
                message="Решение должно быть approve или reject.",
            )
        if action_id in seen:
            raise PpmAgentActionError(
                code="AGENT_BATCH_ACTION_DUPLICATE",
                message="Одно действие нельзя рассмотреть дважды в одном наборе.",
            )
        seen.add(action_id)
        normalized.append((action_id, decision))

    with transaction.atomic():
        locked_run = PpmAgentRun.objects.select_for_update().get(id=run.id)
        actions = {
            action.id: action
            for action in PpmAgentAction.objects.select_for_update()
            .filter(run=locked_run, id__in=seen)
            .order_by("sequence")
        }
        missing = [str(action_id) for action_id, _ in normalized if action_id not in actions]
        if missing:
            raise PpmAgentActionError(
                code="AGENT_BATCH_ACTION_NOT_FOUND",
                message="Одно или несколько действий не принадлежат этому запуску.",
                details={"action_ids": missing},
            )
        changed_count = 0
        for action_id, decision in normalized:
            _, changed = review_agent_action(
                action=actions[action_id],
                user_id=user_id,
                approve=decision == "approve",
            )
            changed_count += int(changed)
        refreshed_actions = list(locked_run.actions.order_by("sequence"))
        summary = summarize_agent_actions(refreshed_actions)
        if changed_count:
            _audit(
                run=locked_run,
                actor_id=user_id,
                event_type="actions_batch_reviewed",
                metadata={
                    "submitted_count": len(normalized),
                    "changed_count": changed_count,
                    "approved": summary["approved"],
                    "rejected": summary["rejected"],
                    "remaining": summary["remaining"],
                    "partial": summary["partial"],
                },
            )
        return locked_run, summary, changed_count


def _work_item_description_html(item):
    parts = []
    description = str(item.get("description") or "").strip()
    if description:
        parts.append(f"<p>{escape(description)}</p>")
    criteria = item.get("acceptance_criteria") or []
    if criteria:
        rendered = "".join(f"<li>{escape(str(criterion))}</li>" for criterion in criteria)
        parts.append(f"<h3>Критерии приёмки</h3><ul>{rendered}</ul>")
    return "".join(parts) or "<p></p>"


def _validate_work_item_action(action):
    if action.action_kind != PpmAgentActionKind.CREATE_WORK_ITEMS or action.proposal_tool != "propose_work_items":
        raise PpmAgentActionError(
            code="AGENT_ACTION_APPLY_UNSUPPORTED",
            message="Этот тип предложения пока нельзя применить к проекту.",
        )
    try:
        validate_agent_tool_call(
            agent_kind=action.run.agent_kind,
            tool_name=action.proposal_tool,
            payload=action.payload_json,
        )
        validate_approved_action_tool_call(
            tool_name="create_work_items_from_action",
            payload={"action_id": str(action.id)},
        )
    except PpmAgentRegistryError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message, details=exc.details) from exc

    source_ids = {
        str(source.get("source_id"))
        for source in action.preconditions_json.get("sources", [])
        if isinstance(source, dict) and source.get("source_id")
    }
    for item in action.payload_json["items"]:
        if not set(map(str, item.get("source_ids", []))).issubset(source_ids):
            raise PpmAgentActionError(
                code="AGENT_ACTION_SOURCE_SCOPE_INVALID",
                message="Предложение ссылается на источник вне подтверждённого набора.",
                details={"action_id": str(action.id)},
            )


def _validate_vault_markdown_action(action):
    if (
        action.action_kind != PpmAgentActionKind.WRITE_VAULT_FILE
        or action.proposal_tool != "propose_page_or_vault_note"
    ):
        raise PpmAgentActionError(
            code="AGENT_ACTION_APPLY_UNSUPPORTED",
            message="Этот тип предложения пока нельзя применить к Хранилищу.",
        )
    try:
        validate_agent_tool_call(
            agent_kind=action.run.agent_kind,
            tool_name=action.proposal_tool,
            payload=action.payload_json,
        )
        validate_approved_action_tool_call(
            tool_name="write_vault_file_from_action",
            payload={"action_id": str(action.id)},
        )
    except PpmAgentRegistryError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message, details=exc.details) from exc

    if action.payload_json.get("target") != "vault_markdown":
        raise PpmAgentActionError(
            code="AGENT_ACTION_APPLY_UNSUPPORTED",
            message="Автоматическое создание страниц пока не поддерживается. Выберите Markdown-файл Хранилища.",
        )
    source_ids = {
        str(source.get("source_id"))
        for source in action.preconditions_json.get("sources", [])
        if isinstance(source, dict) and source.get("source_id")
    }
    if not set(map(str, action.payload_json.get("source_ids", []))).issubset(source_ids):
        raise PpmAgentActionError(
            code="AGENT_ACTION_SOURCE_SCOPE_INVALID",
            message="Черновик ссылается на источник вне подтверждённого набора.",
            details={"action_id": str(action.id)},
        )


def _validate_semantic_edge_action(action):
    if (
        action.action_kind != PpmAgentActionKind.APPLY_SEMANTIC_EDGES
        or action.proposal_tool != "propose_semantic_edges"
    ):
        raise PpmAgentActionError(
            code="AGENT_ACTION_APPLY_UNSUPPORTED",
            message="Этот тип предложения пока нельзя применить к Холсту.",
        )
    try:
        validate_agent_tool_call(
            agent_kind=action.run.agent_kind,
            tool_name=action.proposal_tool,
            payload=action.payload_json,
        )
        validate_approved_action_tool_call(
            tool_name="apply_semantic_edges",
            payload={"action_id": str(action.id)},
        )
    except PpmAgentRegistryError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message, details=exc.details) from exc

    board_precondition = (action.run.result_json or {}).get("board")
    if (
        not isinstance(board_precondition, dict)
        or not board_precondition.get("id")
        or not isinstance(board_precondition.get("version"), int)
    ):
        raise PpmAgentActionError(
            code="AGENT_ACTION_BOARD_PRECONDITION_INVALID",
            message="У предложения отсутствует проверяемая версия доски.",
            details={"action_id": str(action.id)},
        )
    board_id = str(board_precondition["id"])
    if str(action.run.context_json.get("canvas_id") or "") != board_id:
        raise PpmAgentActionError(
            code="AGENT_ACTION_BOARD_SCOPE_INVALID",
            message="Предложение относится к другой доске.",
            details={"action_id": str(action.id)},
        )

    source_ids = {
        str(source.get("source_id"))
        for source in action.preconditions_json.get("sources", [])
        if isinstance(source, dict) and source.get("source_id")
    }
    for edge in action.payload_json["edges"]:
        if str(edge.get("board_id")) != board_id:
            raise PpmAgentActionError(
                code="AGENT_ACTION_BOARD_SCOPE_INVALID",
                message="Предложенная связь относится к другой доске.",
                details={"action_id": str(action.id)},
            )
        if not set(map(str, edge.get("source_ids", []))).issubset(source_ids):
            raise PpmAgentActionError(
                code="AGENT_ACTION_SOURCE_SCOPE_INVALID",
                message="Связь ссылается на источник вне подтверждённого набора.",
                details={"action_id": str(action.id)},
            )


def _validate_supported_action(action):
    if action.action_kind == PpmAgentActionKind.CREATE_WORK_ITEMS:
        _validate_work_item_action(action)
        return
    if action.action_kind == PpmAgentActionKind.WRITE_VAULT_FILE:
        _validate_vault_markdown_action(action)
        return
    if action.action_kind == PpmAgentActionKind.APPLY_SEMANTIC_EDGES:
        _validate_semantic_edge_action(action)
        return
    raise PpmAgentActionError(
        code="AGENT_ACTION_APPLY_UNSUPPORTED",
        message="Этот тип предложения пока нельзя применить к проекту.",
    )


def _apply_work_item_action(*, action, project, user_id):
    created_issues = []
    for item in action.payload_json["items"]:
        issue = Issue.objects.create(
            project=project,
            name=str(item["title"]).strip(),
            description_html=_work_item_description_html(item),
            priority="none",
            created_by_id=user_id,
            updated_by_id=user_id,
        )
        created_issues.append(
            {
                "id": str(issue.id),
                "identifier": f"{project.identifier}-{issue.sequence_id}",
                "name": issue.name,
                "url": f"/{project.workspace.slug}/browse/{project.identifier}-{issue.sequence_id}/",
            }
        )
    return {
        "canonical_changes_applied": True,
        "created_count": len(created_issues),
        "issues": created_issues,
    }, {"issue_ids": [item["id"] for item in created_issues]}


def _apply_vault_markdown_action(*, action, project, user_id):
    try:
        vault = get_or_create_project_vault(
            workspace_id=project.workspace_id,
            project_id=project.id,
            user_id=user_id,
        )
        entry = create_markdown(
            vault=vault,
            parent_id=None,
            name=str(action.payload_json["title"]).strip(),
            content=str(action.payload_json["body"]),
            user_id=user_id,
        )
    except PpmVaultConflict as exc:
        raise PpmAgentActionError(
            code=exc.code,
            message=exc.message,
            details={**exc.details, "action_id": str(action.id)},
        ) from exc
    result_entry = {
        "id": str(entry.id),
        "name": entry.name,
        "version": entry.version,
        "url": (f"/{project.workspace.slug}/projects/{project.id}/knowledge?entry_id={entry.id}"),
    }
    return {
        "canonical_changes_applied": True,
        "created_count": 1,
        "vault_entries": [result_entry],
    }, {"vault_entry_ids": [result_entry["id"]]}


def _apply_semantic_edge_action(*, action, project, user_id):
    board_precondition = action.run.result_json["board"]
    board = (
        PpmCanvasBoard.objects.select_for_update()
        .select_related("canvas")
        .filter(
            id=board_precondition["id"],
            workspace_id=project.workspace_id,
            project_id=project.id,
            canvas__project_id=project.id,
        )
        .first()
    )
    if board is None:
        raise PpmAgentActionError(
            code="AGENT_ACTION_BOARD_NOT_FOUND",
            message="Доска предложения больше недоступна.",
            details={"action_id": str(action.id)},
        )
    if board.current_version != board_precondition["version"]:
        raise PpmAgentActionError(
            code="AGENT_ACTION_BOARD_CHANGED",
            message="Доска изменилась после подготовки связи. Повторите анализ на текущей версии.",
            details={
                "action_id": str(action.id),
                "expected_version": board_precondition["version"],
                "current_version": board.current_version,
            },
        )

    created_edges = []
    for index, edge_payload in enumerate(action.payload_json["edges"]):
        validated_data = {
            "from_shape_id": edge_payload["from_shape_id"],
            "to_shape_id": edge_payload["to_shape_id"],
            "relation_type": edge_payload["relation"],
            "label": str(edge_payload["reason"])[:255],
            "confidence": None,
            "origin": PpmSemanticEdgeOrigin.AGENT,
            "confirmation_status": PpmSemanticEdgeConfirmationStatus.CONFIRMED,
            "client_operation_id": uuid.uuid5(action.id, f"semantic-edge:{index}"),
        }
        try:
            edge, _ = create_semantic_edge(
                board=board,
                user_id=user_id,
                validated_data=validated_data,
            )
        except PpmCanvasConflict as exc:
            raise PpmAgentActionError(
                code=exc.code,
                message=exc.message,
                details={**exc.details, "action_id": str(action.id)},
            ) from exc
        except IntegrityError as exc:
            raise PpmAgentActionError(
                code="CANVAS_EDGE_CONFLICT",
                message="Такая смысловая связь уже существует на доске.",
                details={"action_id": str(action.id)},
            ) from exc
        serialized = serialize_semantic_edge(edge)
        created_edges.append(
            {
                **serialized,
                "reason": edge_payload["reason"],
                "url": f"/{project.workspace.slug}/projects/{project.id}/brain?board_id={board.id}",
            }
        )

    return {
        "canonical_changes_applied": True,
        "created_count": len(created_edges),
        "semantic_edges": created_edges,
    }, {"semantic_edge_ids": [item["edge_id"] for item in created_edges]}


def _apply_supported_action(*, action, project, user_id):
    if action.action_kind == PpmAgentActionKind.CREATE_WORK_ITEMS:
        return _apply_work_item_action(action=action, project=project, user_id=user_id)
    if action.action_kind == PpmAgentActionKind.WRITE_VAULT_FILE:
        return _apply_vault_markdown_action(action=action, project=project, user_id=user_id)
    if action.action_kind == PpmAgentActionKind.APPLY_SEMANTIC_EDGES:
        return _apply_semantic_edge_action(action=action, project=project, user_id=user_id)
    raise PpmAgentActionError(
        code="AGENT_ACTION_APPLY_UNSUPPORTED",
        message="Этот тип предложения пока нельзя применить к проекту.",
    )


def _refresh_run_after_apply(run):
    actions = list(run.actions.order_by("sequence"))
    pending_statuses = {
        PpmAgentActionStatus.PROPOSED,
        PpmAgentActionStatus.APPROVED,
        PpmAgentActionStatus.APPLYING,
    }
    has_pending = any(action.status in pending_statuses for action in actions)
    has_applied = any(action.status == PpmAgentActionStatus.APPLIED for action in actions)
    if has_pending:
        run.status = PpmAgentRunStatus.AWAITING_APPROVAL
        run.finished_at = None
    elif has_applied:
        run.status = PpmAgentRunStatus.COMPLETED
        run.finished_at = timezone.now()
    elif actions and all(action.status == PpmAgentActionStatus.REJECTED for action in actions):
        run.status = PpmAgentRunStatus.REJECTED
        run.finished_at = timezone.now()
    elif actions:
        run.status = PpmAgentRunStatus.COMPLETED
        run.finished_at = timezone.now()

    result = dict(run.result_json or {})
    result["canonical_changes_applied"] = has_applied
    result["applied_action_ids"] = [
        str(action.id) for action in actions if action.status == PpmAgentActionStatus.APPLIED
    ]
    run.result_json = result
    run.save(update_fields=["status", "finished_at", "result_json", "updated_at"])


def _mark_action_conflict(*, run, action_id, user_id, error):
    with transaction.atomic():
        locked_run = PpmAgentRun.objects.select_for_update().get(id=run.id)
        action = (
            PpmAgentAction.objects.select_for_update()
            .filter(id=action_id, run=locked_run, status=PpmAgentActionStatus.APPROVED)
            .first()
        )
        if action is None:
            return
        action.status = PpmAgentActionStatus.CONFLICT
        action.error_code = error.code
        action.error_message = error.message[:500]
        action.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        _audit(
            run=locked_run,
            action=action,
            actor_id=user_id,
            event_type="action_conflict",
            metadata={"error_code": error.code},
        )
        _refresh_run_after_apply(locked_run)


def _apply_agent_actions_batch(*, run, user_id, normalized, seen):
    with transaction.atomic():
        locked_run = PpmAgentRun.objects.select_for_update().get(id=run.id)
        selected_actions = list(
            PpmAgentAction.objects.select_for_update()
            .select_related("run")
            .filter(run=locked_run, id__in=seen)
            .order_by("sequence")
        )
        actions_by_id = {action.id: action for action in selected_actions}
        missing = [str(action_id) for action_id in normalized if action_id not in actions_by_id]
        if missing:
            raise PpmAgentActionError(
                code="AGENT_BATCH_ACTION_NOT_FOUND",
                message="Одно или несколько действий не принадлежат этому запуску.",
                details={"action_ids": missing},
            )

        to_apply = []
        for action_id in normalized:
            action = actions_by_id[action_id]
            if action.status == PpmAgentActionStatus.APPLIED:
                continue
            if action.status != PpmAgentActionStatus.APPROVED:
                raise PpmAgentActionError(
                    code="AGENT_ACTION_NOT_APPROVED",
                    message="Создать задачу можно только из принятого предложения.",
                    details={"action_id": str(action.id), "status": action.status},
                )
            _assert_action_preconditions_current(action)
            _validate_supported_action(action)
            to_apply.append(action)

        project = (
            Project.objects.select_for_update()
            .select_related("workspace")
            .filter(id=locked_run.project_id, workspace_id=locked_run.workspace_id)
            .first()
        )
        if project is None:
            raise PpmAgentActionError(
                code="AGENT_ACTION_PROJECT_NOT_FOUND",
                message="Проект для применения предложения не найден.",
            )

        created_count = 0
        for action in to_apply:
            action.status = PpmAgentActionStatus.APPLYING
            action.error_code = ""
            action.error_message = ""
            action.save(update_fields=["status", "error_code", "error_message", "updated_at"])
            _audit(run=locked_run, action=action, actor_id=user_id, event_type="action_apply_started")

            action_result, audit_metadata = _apply_supported_action(
                action=action,
                project=project,
                user_id=user_id,
            )
            record_approved_action_tool_call(
                run=locked_run,
                action=action,
                actor_id=user_id,
                tool_name=APPLIER_TOOL_BY_ACTION_KIND[action.action_kind],
                result_count=action_result["created_count"],
            )

            action.status = PpmAgentActionStatus.APPLIED
            action.applied_at = timezone.now()
            action.result_json = action_result
            action.save(
                update_fields=[
                    "status",
                    "applied_at",
                    "result_json",
                    "error_code",
                    "error_message",
                    "updated_at",
                ]
            )
            created_count += action_result["created_count"]
            _audit(
                run=locked_run,
                action=action,
                actor_id=user_id,
                event_type="action_applied",
                metadata={"created_count": action_result["created_count"], **audit_metadata},
            )

        _refresh_run_after_apply(locked_run)
        if to_apply:
            _audit(
                run=locked_run,
                actor_id=user_id,
                event_type="actions_batch_applied",
                metadata={
                    "submitted_count": len(normalized),
                    "changed_count": len(to_apply),
                    "created_count": created_count,
                    "action_ids": [str(action.id) for action in to_apply],
                },
            )
        return locked_run, summarize_agent_actions(locked_run.actions.order_by("sequence")), created_count


def apply_agent_actions_batch(*, run, user_id, action_ids):
    """Atomically apply an explicit set of supported approved actions.

    Applied actions are accepted on retries and return their stored result, so a
    repeated client request cannot create duplicate canonical objects.
    """

    if not isinstance(action_ids, list) or not 1 <= len(action_ids) <= 50:
        raise PpmAgentActionError(
            code="AGENT_BATCH_APPLY_INVALID",
            message="Передайте от 1 до 50 подтверждённых действий.",
        )
    normalized = []
    seen = set()
    for raw_action_id in action_ids:
        action_id = _uuid(
            raw_action_id,
            code="AGENT_BATCH_ACTION_ID_INVALID",
            message="Не удалось определить действие для применения.",
        )
        if action_id in seen:
            raise PpmAgentActionError(
                code="AGENT_BATCH_ACTION_DUPLICATE",
                message="Одно действие нельзя применить дважды в одном запросе.",
            )
        seen.add(action_id)
        normalized.append(action_id)

    try:
        return _apply_agent_actions_batch(run=run, user_id=user_id, normalized=normalized, seen=seen)
    except PpmAgentActionError as exc:
        if exc.code in {
            "AGENT_ACTION_PRECONDITION_INVALID",
            "AGENT_ACTION_SCOPE_CHANGED",
            "AGENT_ACTION_SOURCE_CHANGED",
            "AGENT_ACTION_SOURCE_SCOPE_INVALID",
            "AGENT_ACTION_BOARD_PRECONDITION_INVALID",
            "AGENT_ACTION_BOARD_SCOPE_INVALID",
            "AGENT_ACTION_BOARD_NOT_FOUND",
            "AGENT_ACTION_BOARD_CHANGED",
            "CANVAS_EDGE_CONFLICT",
            "CANVAS_EDGE_SHAPE_NOT_FOUND",
            "CANVAS_OPERATION_REUSED",
            "VAULT_FILE_TOO_LARGE",
            "VAULT_INVALID_NAME",
            "VAULT_NAME_CONFLICT",
            "VAULT_PARENT_NOT_FOUND",
            "VAULT_SCOPE_MISMATCH",
        } and exc.details.get("action_id"):
            _mark_action_conflict(
                run=run,
                action_id=exc.details["action_id"],
                user_id=user_id,
                error=exc,
            )
        raise


def serialize_agent_action(action):
    return {
        "id": str(action.id),
        "sequence": action.sequence,
        "action_kind": action.action_kind,
        "proposal_tool": action.proposal_tool,
        "status": action.status,
        "payload": action.payload_json,
        "preview": action.preview_json,
        "preconditions": action.preconditions_json,
        "approved_by": str(action.approved_by) if action.approved_by else None,
        "approved_at": action.approved_at.isoformat() if action.approved_at else None,
        "rejected_by": str(action.rejected_by) if action.rejected_by else None,
        "rejected_at": action.rejected_at.isoformat() if action.rejected_at else None,
        "result": action.result_json,
        "error_code": action.error_code,
        "error_message": action.error_message,
    }


def serialize_agent_audit_event(run, event):
    serialized = {
        "id": str(event.id),
        "event_type": event.event_type,
        "action_id": str(event.action_id) if event.action_id else None,
        "created_at": event.created_at.isoformat(),
    }
    if event.event_type not in {"tool_call_started", "tool_call_completed"} or not isinstance(
        event.metadata_json, dict
    ):
        return serialized
    tool_name = str(event.metadata_json.get("tool_name") or "")
    try:
        tool = get_agent_tool_definition(tool_name)
    except PpmAgentRegistryError:
        return serialized
    if tool_name not in run.capabilities_json and not (tool.mode.value == "apply" and event.action_id):
        return serialized
    result_count = event.metadata_json.get("result_count")
    status = "running" if event.event_type == "tool_call_started" else "completed"
    serialized["tool"] = {
        "name": tool.name,
        "mode": tool.mode.value,
        "status": status,
        "result_count": (
            result_count
            if isinstance(result_count, int) and not isinstance(result_count, bool) and 0 <= result_count <= 100_000
            else None
        ),
    }
    return serialized


def serialize_agent_run(run):
    actions = list(run.actions.all())
    return {
        "id": str(run.id),
        "agent_kind": run.agent_kind,
        "status": run.status,
        "context": run.context_json,
        "capabilities": run.capabilities_json,
        "policy_version": run.policy_version,
        "provider": run.provider,
        "model": run.model,
        "result": run.result_json,
        "error_code": run.error_code,
        "error_message": run.error_message,
        "cancel_requested": run.cancel_requested_at is not None,
        "attempt_count": run.attempt_count,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "created_at": run.created_at.isoformat(),
        "updated_at": run.updated_at.isoformat(),
        "actions": [serialize_agent_action(action) for action in actions],
        "action_summary": summarize_agent_actions(actions),
        "citations": [
            {
                "ordinal": citation.ordinal,
                "action_id": str(citation.action_id) if citation.action_id else None,
                "source_type": citation.source_type,
                "source_id": citation.source_id,
                "source_version": citation.source_version,
                "title": citation.title,
                "locator": citation.locator_json,
            }
            for citation in run.citations.all()
        ],
        "audit_trace": [serialize_agent_audit_event(run, event) for event in run.audit_events.all()[:500]],
    }
