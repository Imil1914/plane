import json
import logging
import time
import uuid

from django.db.models import Case, IntegerField, Value, When
from django.http import StreamingHttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated
from rest_framework.permissions import IsAuthenticated
from rest_framework.renderers import BaseRenderer, JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication
from plane.ppm_canvas.responses import ppm_error_response
from plane.ppm_core.permissions import PpmProjectAccess, get_ppm_project_access

from .adapters import PpmBrainSourceError
from .agent_actions import (
    PpmAgentActionError,
    apply_agent_actions_batch,
    cancel_agent_run,
    create_agent_run,
    expire_stale_agent_runs,
    fail_agent_run,
    retry_agent_run,
    review_agent_action,
    review_agent_actions_batch,
    serialize_agent_audit_event,
    serialize_agent_run,
)
from .agent_execution import execute_agent_run, normalize_agent_options
from .agent_registry import serialize_agent_registry
from .answers import _normalize_selected_shape_ids, cancel_answer_run, create_answer_run, serialize_answer_run
from .completions import get_completion_provider_status
from .flags import agents_enabled, agents_write_enabled, answers_enabled, brain_enabled, graph_enabled
from .graph import normalize_graph_depth, resolve_graph_context
from .models import (
    PpmAnswerRun,
    PpmAnswerRunStatus,
    PpmAgentAction,
    PpmAgentKind,
    PpmAgentRun,
    PpmAgentRunStatus,
    PpmIndexJob,
    PpmKnowledgeIndexState,
    PpmKnowledgeSource,
    PpmKnowledgeSourceType,
    PpmProjectMemoryConfirmationStatus,
    PpmProjectMemoryRecord,
    TERMINAL_ANSWER_RUN_STATUSES,
)
from .memory import create_memory_record, review_memory_record, serialize_memory_record
from .embeddings import PpmEmbeddingProviderError, get_embedding_provider
from .services import PpmBrainConflict, reconcile_project, request_source_index, retrieve_chunks_with_metadata
from .tasks import dispatch_agent_run


AGENT_STREAM_POLL_SECONDS = 0.1
AGENT_STREAM_KEEPALIVE_SECONDS = 15
SERVICE_STREAM_TIMEOUT_SECONDS = 45
SEARCH_REQUEST_FIELDS = {"query", "top_k", "scope"}
SEARCH_SCOPE_FIELDS = {"board_id", "selected_shape_ids", "graph_depth", "source_types"}
ANSWER_REQUEST_FIELDS = {"query", "client_operation_id", "board_id", "selected_shape_ids", "graph_depth"}
logger = logging.getLogger(__name__)
AGENT_STREAM_FINAL_STATUSES = {
    PpmAgentRunStatus.AWAITING_APPROVAL,
    PpmAgentRunStatus.COMPLETED,
    PpmAgentRunStatus.FAILED,
    PpmAgentRunStatus.TIMED_OUT,
    PpmAgentRunStatus.CANCELLED,
    PpmAgentRunStatus.REJECTED,
}


class PpmEventStreamRenderer(BaseRenderer):
    media_type = "text/event-stream"
    format = "event-stream"
    charset = "utf-8"
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return json.dumps(data, ensure_ascii=False).encode("utf-8")


def serialize_source(source):
    return {
        "id": str(source.id),
        "source_type": source.source_type,
        "source_id": source.source_id,
        "source_version": source.source_version,
        "title": source.title,
        "index_state": source.index_state,
        "pipeline_version": source.pipeline_version,
        "last_indexed_at": source.last_indexed_at.isoformat() if source.last_indexed_at else None,
        "error_code": source.error_code,
        "error_message": source.error_message,
        "embedding_model": source.embedding_model,
        "embedding_error_code": source.embedding_error_code,
        "updated_at": source.updated_at.isoformat(),
    }


def serialize_job(job):
    return {
        "id": str(job.id),
        "source_id": str(job.source_id),
        "requested_version": job.requested_version,
        "pipeline_version": job.pipeline_version,
        "status": job.status,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "created_at": job.created_at.isoformat(),
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


class PpmBrainAPIView(APIView):
    authentication_classes = [BaseSessionAuthentication]
    permission_classes = [IsAuthenticated]

    def handle_exception(self, exc):
        if isinstance(exc, (AuthenticationFailed, NotAuthenticated)):
            return ppm_error_response(
                self.request,
                code="AUTHENTICATION_REQUIRED",
                message="Требуется авторизация.",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        if isinstance(exc, (PpmAgentActionError, PpmBrainConflict, PpmBrainSourceError)):
            return ppm_error_response(
                self.request,
                code=exc.code,
                message=exc.message,
                status_code=status.HTTP_400_BAD_REQUEST,
                details=getattr(exc, "details", {}),
            )
        return super().handle_exception(exc)

    def require_access(self, request, workspace_id, project_id, *, edit=False):
        if not brain_enabled():
            return (
                None,
                ppm_error_response(
                    request,
                    code="BRAIN_DISABLED",
                    message="Мозг проекта отключён администратором.",
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                ),
            )
        access = get_ppm_project_access(user=request.user, workspace_id=workspace_id, project_id=project_id)
        if access == PpmProjectAccess.DENY or (edit and access != PpmProjectAccess.EDIT):
            return (
                None,
                ppm_error_response(
                    request,
                    code="BRAIN_WRITE_FORBIDDEN" if edit else "BRAIN_PERMISSION_DENIED",
                    message="Недостаточно прав для управления индексом." if edit else "Нет доступа к Мозгу проекта.",
                    status_code=status.HTTP_403_FORBIDDEN,
                ),
            )
        return access, None

    def require_answers(self, request, workspace_id, project_id):
        access, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return access, denied
        if not answers_enabled():
            return (
                None,
                ppm_error_response(
                    request,
                    code="BRAIN_ANSWERS_DISABLED",
                    message="Ответы Мозга проекта отключены администратором.",
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                ),
            )
        return access, None

    def require_agents(self, request, workspace_id, project_id):
        access, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return access, denied
        if not agents_enabled():
            return (
                None,
                ppm_error_response(
                    request,
                    code="AGENTS_DISABLED",
                    message="Проектные агенты отключены администратором.",
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                ),
            )
        return access, None


class PpmBrainSourceListView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id):
        access, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        sources = PpmKnowledgeSource.objects.filter(workspace_id=workspace_id, project_id=project_id)
        counts = {value: sources.filter(index_state=value).count() for value in PpmKnowledgeIndexState.values}
        ordered_sources = sources.order_by(
            Case(
                When(source_type=PpmKnowledgeSourceType.WORK_ITEM, then=Value(0)),
                When(source_type=PpmKnowledgeSourceType.VAULT_FILE, then=Value(1)),
                When(source_type=PpmKnowledgeSourceType.GIT_CODE, then=Value(2)),
                default=Value(3),
                output_field=IntegerField(),
            ),
            "title",
            "id",
        )
        return Response(
            {
                "access": access.value,
                "counts": counts,
                "sources": [serialize_source(source) for source in ordered_sources[:500]],
            }
        )


class PpmBrainSourceIndexView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id, source_type, source_id):
        _, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        if source_type not in PpmKnowledgeSourceType.values:
            raise PpmBrainConflict(code="SOURCE_TYPE_UNSUPPORTED", message="Тип источника не поддерживается.")
        source, job = request_source_index(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            requested_by=request.user.id,
            dispatch=True,
        )
        return Response(
            {"source": serialize_source(source), "job": serialize_job(job) if job else None},
            status=status.HTTP_202_ACCEPTED if job else status.HTTP_200_OK,
        )


class PpmBrainReindexView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id):
        _, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        jobs = reconcile_project(
            workspace_id=workspace_id,
            project_id=project_id,
            requested_by=request.user.id,
            dispatch=True,
        )
        return Response(
            {"queued": len(jobs), "job_ids": [str(job.id) for job in jobs]},
            status=status.HTTP_202_ACCEPTED,
        )


class PpmBrainJobView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id, job_id):
        _, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        job = PpmIndexJob.objects.filter(
            id=job_id,
            workspace_id=workspace_id,
            project_id=project_id,
        ).first()
        if job is None:
            return ppm_error_response(
                request,
                code="BRAIN_JOB_NOT_FOUND",
                message="Задание индексации не найдено.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return Response(serialize_job(job))


def _search_service_run(*, run_id, status_value, started_at, updated_at, finished_at=None):
    return {
        "run_id": str(run_id),
        "kind": "search",
        "status": status_value,
        "provider": None,
        "model": None,
        "policy_version": "ppm-brain-search-v1",
        "created_at": started_at.isoformat(),
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat() if finished_at else None,
        "updated_at": updated_at.isoformat(),
    }


def _normalize_search_payload(payload):
    if not isinstance(payload, dict):
        raise PpmBrainConflict(code="BRAIN_QUERY_INVALID", message="Запрос поиска должен быть объектом.")
    unknown = sorted(set(payload) - SEARCH_REQUEST_FIELDS)
    if unknown:
        raise PpmBrainConflict(
            code="BRAIN_QUERY_FIELD_FORBIDDEN",
            message="Запрос поиска содержит запрещённые поля.",
            details={"fields": unknown},
        )

    query = payload.get("query")
    if not isinstance(query, str):
        raise PpmBrainConflict(code="BRAIN_INVALID_QUERY", message="Введите запрос длиной до 500 символов.")
    query = " ".join(query.strip().split())
    if not query or len(query) > 500:
        raise PpmBrainConflict(code="BRAIN_INVALID_QUERY", message="Введите запрос длиной до 500 символов.")

    top_k = payload.get("top_k", 12)
    if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 50:
        raise PpmBrainConflict(code="BRAIN_INVALID_TOP_K", message="Укажите от 1 до 50 результатов.")

    raw_scope = payload.get("scope") or {}
    if not isinstance(raw_scope, dict):
        raise PpmBrainConflict(code="BRAIN_SCOPE_INVALID", message="Область поиска должна быть объектом.")
    unknown_scope = sorted(set(raw_scope) - SEARCH_SCOPE_FIELDS)
    if unknown_scope:
        raise PpmBrainConflict(
            code="BRAIN_SCOPE_FIELD_FORBIDDEN",
            message="Область поиска содержит запрещённые поля.",
            details={"fields": unknown_scope},
        )

    board_id = raw_scope.get("board_id")
    if board_id is not None:
        try:
            board_id = str(uuid.UUID(str(board_id)))
        except (TypeError, ValueError) as exc:
            raise PpmBrainConflict(
                code="BRAIN_INVALID_BOARD_ID",
                message="Не удалось определить доску холста.",
            ) from exc

    source_types = raw_scope.get("source_types")
    if source_types is not None:
        if (
            not isinstance(source_types, list)
            or len(source_types) > len(PpmKnowledgeSourceType.values)
            or any(not isinstance(value, str) or value not in PpmKnowledgeSourceType.values for value in source_types)
        ):
            raise PpmBrainConflict(
                code="BRAIN_INVALID_SOURCE_TYPES",
                message="Типы источников поиска указаны неверно.",
            )
        source_types = list(dict.fromkeys(source_types))

    return {
        "query": query,
        "top_k": top_k,
        "scope": {
            "board_id": board_id,
            "selected_shape_ids": _normalize_selected_shape_ids(raw_scope.get("selected_shape_ids")),
            "graph_depth": normalize_graph_depth(raw_scope.get("graph_depth", 1)),
            "source_types": source_types,
        },
    }


def _execute_brain_query(*, workspace_id, project_id, payload, run_id, started_at):
    payload = _normalize_search_payload(payload)
    scope = payload["scope"]
    selected_shape_ids = scope["selected_shape_ids"]
    source_keys, graph_scope, graph_paths_by_source = resolve_graph_context(
        workspace_id=workspace_id,
        project_id=project_id,
        board_id=scope.get("board_id"),
        selected_shape_ids=selected_shape_ids,
        graph_depth=scope["graph_depth"],
    )
    results, retrieval = retrieve_chunks_with_metadata(
        workspace_id=workspace_id,
        project_id=project_id,
        query=payload.get("query", ""),
        top_k=payload.get("top_k", 12),
        source_types=scope["source_types"],
        source_keys=source_keys,
        graph_paths_by_source=graph_paths_by_source,
        graph_scope=graph_scope["graph"],
    )
    finished_at = timezone.now()
    run_status = "no_sources" if not results else "degraded" if retrieval.get("degraded") else "completed"
    return {
        "results": results,
        "retrieval": retrieval,
        "service_run": _search_service_run(
            run_id=run_id,
            status_value=run_status,
            started_at=started_at,
            updated_at=finished_at,
            finished_at=finished_at,
        ),
    }


def _service_progress(*, run_id, name, status_value, result_count=None):
    return {
        "run_id": str(run_id),
        "occurred_at": timezone.now().isoformat(),
        "stage": {
            "name": name,
            "status": status_value,
            "result_count": result_count,
        },
    }


class PpmBrainQueryView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id):
        _, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        started_at = timezone.now()
        return Response(
            _execute_brain_query(
                workspace_id=workspace_id,
                project_id=project_id,
                payload=request.data,
                run_id=uuid.uuid4(),
                started_at=started_at,
            )
        )


class PpmBrainQueryStreamView(PpmBrainAPIView):
    renderer_classes = [PpmEventStreamRenderer, JSONRenderer]

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        run_id = uuid.uuid4()
        started_at = timezone.now()
        payload = request.data.copy()

        def stream():
            running = {
                "service_run": _search_service_run(
                    run_id=run_id,
                    status_value="running",
                    started_at=started_at,
                    updated_at=started_at,
                ),
                "output": None,
            }
            yield _service_stream_event("run", running)
            yield _service_stream_event(
                "progress",
                _service_progress(
                    run_id=run_id,
                    name="search_project_knowledge",
                    status_value="running",
                ),
            )
            try:
                result = _execute_brain_query(
                    workspace_id=workspace_id,
                    project_id=project_id,
                    payload=payload,
                    run_id=run_id,
                    started_at=started_at,
                )
            except PpmBrainConflict as exc:
                yield _service_stream_event("error", {"code": exc.code, "message": exc.message})
                return
            except Exception:
                logger.exception("PPM Project Brain search stream failed", extra={"run_id": str(run_id)})
                yield _service_stream_event(
                    "error",
                    {
                        "code": "BRAIN_SEARCH_FAILED",
                        "message": "Не удалось выполнить поиск. Источники проекта не изменены.",
                    },
                )
                return
            yield _service_stream_event(
                "progress",
                _service_progress(
                    run_id=run_id,
                    name="search_project_knowledge",
                    status_value="completed",
                    result_count=len(result["results"]),
                ),
            )
            yield _service_stream_event(
                "run",
                {
                    "service_run": result["service_run"],
                    "output": result,
                },
            )

        response = StreamingHttpResponse(stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-cache, no-transform"
        response["X-Accel-Buffering"] = "no"
        return response


class PpmBrainHealthView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id):
        _, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        sources = PpmKnowledgeSource.objects.filter(workspace_id=workspace_id, project_id=project_id)
        embedding_provider = None
        embedding_error_code = ""
        try:
            provider = get_embedding_provider()
            embedding_provider = provider.name if provider.enabled else None
        except PpmEmbeddingProviderError as exc:
            embedding_error_code = exc.code
        return Response(
            {
                "status": "ok",
                "retrieval_mode": "hybrid" if embedding_provider else "keyword",
                "embedding_provider": embedding_provider,
                "embedding_error_code": embedding_error_code,
                "ready_sources": sources.filter(index_state=PpmKnowledgeIndexState.READY).count(),
                "failed_sources": sources.filter(index_state=PpmKnowledgeIndexState.FAILED).count(),
                "pending_sources": sources.filter(
                    index_state__in=[
                        PpmKnowledgeIndexState.PENDING,
                        PpmKnowledgeIndexState.INDEXING,
                        PpmKnowledgeIndexState.STALE,
                    ]
                ).count(),
                "answers_enabled": answers_enabled(),
                "completion": get_completion_provider_status(),
                "graph_enabled": graph_enabled(),
                "agents_enabled": agents_enabled(),
                "agent_writes_enabled": agents_write_enabled(),
            }
        )


class PpmBrainAgentRegistryView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        return Response(
            {
                "agents": serialize_agent_registry(),
                "write_enabled": agents_write_enabled(),
                "policy_version": "ppm-agents-v1",
            }
        )


SUPPORTED_AGENT_KINDS = {
    PpmAgentKind.PROJECT_REPORTER,
    PpmAgentKind.WORK_DECOMPOSER,
    PpmAgentKind.KNOWLEDGE_LIBRARIAN,
    PpmAgentKind.RELATIONSHIP_ANALYST,
}


def _prepare_agent_run_request(*, request, workspace_id, project_id):
    if not isinstance(request.data, dict):
        raise PpmAgentActionError(code="AGENT_REQUEST_INVALID", message="Запрос агента должен быть объектом.")
    unknown = sorted(set(request.data) - {"agent_kind", "client_operation_id", "context", "options"})
    if unknown:
        raise PpmAgentActionError(
            code="AGENT_REQUEST_FIELD_FORBIDDEN",
            message="Запрос агента содержит запрещённые поля.",
            details={"fields": unknown},
        )
    agent_kind = str(request.data.get("agent_kind") or "")
    if agent_kind not in SUPPORTED_AGENT_KINDS:
        raise PpmAgentActionError(
            code="AGENT_RUNNER_NOT_READY",
            message="Этот проектный агент ещё не подключён к безопасному исполнителю.",
        )
    options = normalize_agent_options(agent_kind, request.data.get("options") or {})
    run, created = create_agent_run(
        workspace_id=workspace_id,
        project_id=project_id,
        user_id=request.user.id,
        agent_kind=agent_kind,
        client_operation_id=request.data.get("client_operation_id"),
        input_payload={"options": options},
        context=request.data.get("context") or {},
    )
    return run, created, agent_kind, options


def _load_agent_run(run_id):
    return PpmAgentRun.objects.prefetch_related("actions", "citations", "audit_events").get(id=run_id)


class PpmBrainAgentRunListCreateView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        expire_stale_agent_runs(
            workspace_id=workspace_id,
            project_id=project_id,
            created_by=request.user.id,
        )
        runs = (
            PpmAgentRun.objects.filter(
                workspace_id=workspace_id,
                project_id=project_id,
                created_by=request.user.id,
            )
            .prefetch_related("actions", "citations", "audit_events")
            .order_by("-created_at")[:50]
        )
        return Response({"results": [serialize_agent_run(run) for run in runs]})

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        run, created, agent_kind, options = _prepare_agent_run_request(
            request=request,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        if not created:
            run = _load_agent_run(run.id)
            return Response(serialize_agent_run(run))
        run = execute_agent_run(run=run, agent_kind=agent_kind, options=options)
        run = _load_agent_run(run.id)
        return Response(serialize_agent_run(run), status=status.HTTP_201_CREATED)


def _service_stream_event(event, payload):
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _agent_progress_from_audit(run, event):
    serialized = serialize_agent_audit_event(run, event)
    tool = serialized.get("tool")
    metadata = event.metadata_json if isinstance(event.metadata_json, dict) else {}
    call_id = str(metadata.get("call_id") or "")
    if tool is None or not call_id:
        return None
    return {
        "run_id": str(run.id),
        "call_id": call_id,
        "occurred_at": event.created_at.isoformat(),
        "tool": tool,
    }


def _agent_running_snapshot(initial_snapshot, current):
    snapshot = dict(initial_snapshot)
    snapshot.update(
        {
            "status": PpmAgentRunStatus.RUNNING,
            "attempt_count": current.attempt_count,
            "started_at": current.started_at.isoformat() if current.started_at else None,
            "finished_at": None,
            "updated_at": current.updated_at.isoformat(),
            "audit_trace": [serialize_agent_audit_event(current, event) for event in current.audit_events.all()[:500]],
        }
    )
    return snapshot


def _agent_run_stream_response(*, run, created, agent_kind, options):
    def stream():
        current = _load_agent_run(run.id)
        initial_snapshot = serialize_agent_run(current)
        yield _service_stream_event("run", initial_snapshot)
        if not created:
            return

        try:
            dispatch_agent_run(run.id)
        except Exception:
            fail_agent_run(
                run,
                error_code="AGENT_QUEUE_UNAVAILABLE",
                error_message="Очередь проектных агентов временно недоступна. Повторите запуск позже.",
            )

        seen_audit_ids = set()
        running_emitted = False
        last_status = current.status
        last_keepalive_at = time.monotonic()
        while True:
            current = _load_agent_run(run.id)
            for event in current.audit_events.all()[:500]:
                event_id = str(event.id)
                if event_id in seen_audit_ids:
                    continue
                seen_audit_ids.add(event_id)
                if event.event_type == "run_started" and not running_emitted:
                    yield _service_stream_event("run", _agent_running_snapshot(initial_snapshot, current))
                    running_emitted = True
                    last_status = PpmAgentRunStatus.RUNNING
                elif event.event_type == "run_recovered":
                    yield _service_stream_event("run", _agent_running_snapshot(initial_snapshot, current))
                    running_emitted = True
                    last_status = PpmAgentRunStatus.RUNNING
                progress = _agent_progress_from_audit(current, event)
                if progress is not None:
                    yield _service_stream_event("progress", progress)

            if current.status != last_status:
                yield _service_stream_event("run", serialize_agent_run(current))
                last_status = current.status
            if current.status in AGENT_STREAM_FINAL_STATUSES:
                if current.status == PpmAgentRunStatus.FAILED:
                    yield _service_stream_event(
                        "error",
                        {
                            "code": current.error_code or "AGENT_RUN_FAILED",
                            "message": current.error_message or "Не удалось выполнить проектного агента.",
                        },
                    )
                return

            now = time.monotonic()
            if now - last_keepalive_at >= AGENT_STREAM_KEEPALIVE_SECONDS:
                yield ": keepalive\n\n"
                last_keepalive_at = now
            time.sleep(AGENT_STREAM_POLL_SECONDS)

    response = StreamingHttpResponse(
        stream(),
        content_type="text/event-stream",
        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )
    response["Cache-Control"] = "no-cache, no-transform"
    response["X-Accel-Buffering"] = "no"
    return response


class PpmBrainAgentRunStreamCreateView(PpmBrainAPIView):
    renderer_classes = [PpmEventStreamRenderer, JSONRenderer]

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        run, created, agent_kind, options = _prepare_agent_run_request(
            request=request,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        return _agent_run_stream_response(
            run=run,
            created=created,
            agent_kind=agent_kind,
            options=options,
        )


class PpmBrainAgentRunCancelView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        if request.data:
            raise PpmAgentActionError(
                code="AGENT_RUN_CANCEL_INVALID",
                message="Для отмены не нужно передавать дополнительные поля.",
            )
        run = PpmAgentRun.objects.filter(
            id=run_id,
            workspace_id=workspace_id,
            project_id=project_id,
            created_by=request.user.id,
        ).first()
        if run is None:
            return ppm_error_response(
                request,
                code="AGENT_RUN_NOT_FOUND",
                message="Запуск проектного агента не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        cancelled, _ = cancel_agent_run(run=run, user_id=request.user.id)
        cancelled = PpmAgentRun.objects.prefetch_related("actions", "citations", "audit_events").get(id=cancelled.id)
        return Response(serialize_agent_run(cancelled))


def _prepare_agent_retry_request(*, request, workspace_id, project_id, run_id):
    if not isinstance(request.data, dict):
        raise PpmAgentActionError(code="AGENT_RETRY_INVALID", message="Запрос повтора должен быть объектом.")
    unknown = sorted(set(request.data) - {"client_operation_id", "options"})
    if unknown:
        raise PpmAgentActionError(
            code="AGENT_RETRY_FIELD_FORBIDDEN",
            message="Запрос повтора содержит запрещённые поля.",
            details={"fields": unknown},
        )
    original = PpmAgentRun.objects.filter(
        id=run_id,
        workspace_id=workspace_id,
        project_id=project_id,
        created_by=request.user.id,
    ).first()
    if original is None:
        return None
    options = normalize_agent_options(original.agent_kind, request.data.get("options") or {})
    retried, created = retry_agent_run(
        original_run=original,
        user_id=request.user.id,
        client_operation_id=request.data.get("client_operation_id"),
        input_payload={"options": options},
    )
    return retried, created, options


def _agent_run_not_found_response(request):
    return ppm_error_response(
        request,
        code="AGENT_RUN_NOT_FOUND",
        message="Запуск проектного агента не найден.",
        status_code=status.HTTP_404_NOT_FOUND,
    )


class PpmBrainAgentRunStreamRetryView(PpmBrainAPIView):
    renderer_classes = [PpmEventStreamRenderer, JSONRenderer]

    def post(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        prepared = _prepare_agent_retry_request(
            request=request,
            workspace_id=workspace_id,
            project_id=project_id,
            run_id=run_id,
        )
        if prepared is None:
            return _agent_run_not_found_response(request)
        retried, created, options = prepared
        return _agent_run_stream_response(
            run=retried,
            created=created,
            agent_kind=retried.agent_kind,
            options=options,
        )


class PpmBrainAgentRunRetryView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        prepared = _prepare_agent_retry_request(
            request=request,
            workspace_id=workspace_id,
            project_id=project_id,
            run_id=run_id,
        )
        if prepared is None:
            return _agent_run_not_found_response(request)
        retried, created, options = prepared
        if created:
            retried = execute_agent_run(run=retried, agent_kind=retried.agent_kind, options=options)
        retried = PpmAgentRun.objects.prefetch_related("actions", "citations", "audit_events").get(id=retried.id)
        return Response(
            serialize_agent_run(retried),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class PpmBrainAgentRunDetailView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_agents(request, workspace_id, project_id)
        if denied:
            return denied
        expire_stale_agent_runs(
            workspace_id=workspace_id,
            project_id=project_id,
            created_by=request.user.id,
        )
        run = (
            PpmAgentRun.objects.filter(
                id=run_id,
                workspace_id=workspace_id,
                project_id=project_id,
                created_by=request.user.id,
            )
            .prefetch_related("actions", "citations", "audit_events")
            .first()
        )
        if run is None:
            return ppm_error_response(
                request,
                code="AGENT_RUN_NOT_FOUND",
                message="Запуск проектного агента не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return Response(serialize_agent_run(run))


class PpmBrainAgentRunBatchReviewView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        if not agents_enabled():
            return ppm_error_response(
                request,
                code="AGENTS_DISABLED",
                message="Проектные агенты отключены администратором.",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not isinstance(request.data, dict) or set(request.data) != {"decisions"}:
            raise PpmAgentActionError(
                code="AGENT_BATCH_REVIEW_INVALID",
                message="Укажите только список decisions для действий запуска.",
            )
        run = PpmAgentRun.objects.filter(
            id=run_id,
            workspace_id=workspace_id,
            project_id=project_id,
        ).first()
        if run is None:
            return ppm_error_response(
                request,
                code="AGENT_RUN_NOT_FOUND",
                message="Запуск проектного агента не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        reviewed, _, _ = review_agent_actions_batch(
            run=run,
            user_id=request.user.id,
            decisions=request.data.get("decisions"),
        )
        reviewed = PpmAgentRun.objects.prefetch_related("actions", "citations", "audit_events").get(id=reviewed.id)
        return Response(serialize_agent_run(reviewed))


class PpmBrainAgentRunBatchApplyView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        if not agents_enabled():
            return ppm_error_response(
                request,
                code="AGENTS_DISABLED",
                message="Проектные агенты отключены администратором.",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not agents_write_enabled():
            return ppm_error_response(
                request,
                code="AGENT_WRITES_DISABLED",
                message="Применение предложений проектных агентов отключено администратором.",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not isinstance(request.data, dict) or set(request.data) != {"action_ids"}:
            raise PpmAgentActionError(
                code="AGENT_BATCH_APPLY_INVALID",
                message="Укажите только список action_ids для подтверждённых действий запуска.",
            )
        run = PpmAgentRun.objects.filter(
            id=run_id,
            workspace_id=workspace_id,
            project_id=project_id,
        ).first()
        if run is None:
            return ppm_error_response(
                request,
                code="AGENT_RUN_NOT_FOUND",
                message="Запуск проектного агента не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        applied, _, _ = apply_agent_actions_batch(
            run=run,
            user_id=request.user.id,
            action_ids=request.data.get("action_ids"),
        )
        applied = PpmAgentRun.objects.prefetch_related("actions", "citations", "audit_events").get(id=applied.id)
        return Response(serialize_agent_run(applied))


class PpmBrainAgentActionReviewView(PpmBrainAPIView):
    def post(self, request, workspace_id, project_id, action_id):
        _, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        if not agents_enabled():
            return ppm_error_response(
                request,
                code="AGENTS_DISABLED",
                message="Проектные агенты отключены администратором.",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not isinstance(request.data, dict) or set(request.data) != {"decision"}:
            raise PpmAgentActionError(
                code="AGENT_ACTION_REVIEW_INVALID",
                message="Укажите только решение: approve или reject.",
            )
        decision = str(request.data.get("decision") or "")
        if decision not in {"approve", "reject"}:
            raise PpmAgentActionError(
                code="AGENT_ACTION_REVIEW_INVALID",
                message="Решение должно быть approve или reject.",
            )
        action = PpmAgentAction.objects.filter(
            id=action_id,
            workspace_id=workspace_id,
            project_id=project_id,
        ).first()
        if action is None:
            return ppm_error_response(
                request,
                code="AGENT_ACTION_NOT_FOUND",
                message="Предложение проектного агента не найдено.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        reviewed, _ = review_agent_action(
            action=action,
            user_id=request.user.id,
            approve=decision == "approve",
        )
        run = PpmAgentRun.objects.prefetch_related("actions", "citations", "audit_events").get(id=reviewed.run_id)
        return Response(serialize_agent_run(run))


class PpmBrainMemoryListCreateView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id):
        access, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        records = PpmProjectMemoryRecord.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
        ).prefetch_related("source_references__knowledge_source")[:200]
        return Response(
            {
                "access": access.value,
                "records": [serialize_memory_record(record) for record in records],
            }
        )

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        record, created = create_memory_record(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
            kind=request.data.get("kind"),
            title=request.data.get("title"),
            body=request.data.get("body"),
            source_references=request.data.get("source_references"),
            client_operation_id=request.data.get("client_operation_id"),
        )
        record = PpmProjectMemoryRecord.objects.prefetch_related("source_references__knowledge_source").get(
            id=record.id
        )
        return Response(
            {**serialize_memory_record(record), "idempotent_replay": not created},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class PpmBrainMemoryDetailView(PpmBrainAPIView):
    def patch(self, request, workspace_id, project_id, memory_id):
        _, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        record = PpmProjectMemoryRecord.objects.filter(
            id=memory_id,
            workspace_id=workspace_id,
            project_id=project_id,
        ).first()
        if record is None:
            return ppm_error_response(
                request,
                code="BRAIN_MEMORY_NOT_FOUND",
                message="Запись памяти не найдена.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        confirmation_status = request.data.get("confirmation_status")
        if confirmation_status not in {
            PpmProjectMemoryConfirmationStatus.CONFIRMED,
            PpmProjectMemoryConfirmationStatus.REJECTED,
        }:
            raise PpmBrainConflict(
                code="BRAIN_MEMORY_REVIEW_INVALID",
                message="Укажите результат проверки предложения.",
            )
        reviewed = review_memory_record(
            record=record,
            user_id=request.user.id,
            confirmation_status=confirmation_status,
        )
        reviewed = PpmProjectMemoryRecord.objects.prefetch_related("source_references__knowledge_source").get(
            id=reviewed.id
        )
        return Response(serialize_memory_record(reviewed))


class PpmBrainAnswerRunListCreateView(PpmBrainAPIView):
    def get(self, request, workspace_id, project_id):
        _, denied = self.require_answers(request, workspace_id, project_id)
        if denied:
            return denied
        runs = PpmAnswerRun.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            created_by=request.user.id,
        ).order_by("-created_at")[:50]
        return Response({"results": [serialize_answer_run(run) for run in runs]})

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_answers(request, workspace_id, project_id)
        if denied:
            return denied
        payload = _normalize_answer_request(request.data)
        run, created = create_answer_run(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
            **payload,
            dispatch=True,
        )
        return Response(
            serialize_answer_run(run),
            status=status.HTTP_202_ACCEPTED if created else status.HTTP_200_OK,
        )


def _answer_progress_snapshot(run):
    completion_progress = (run.scope_json or {}).get("completion_progress") or {}
    if run.status == PpmAnswerRunStatus.RETRIEVING:
        stage_name = "retrieve_project_sources"
        stage_status = "running"
    elif run.status == PpmAnswerRunStatus.COMPLETING:
        stage_name = (
            "receive_provider_answer"
            if completion_progress.get("stage") in {"provider_stream", "provider_complete"}
            else "contact_answer_provider"
            if completion_progress.get("stage") == "provider_request"
            else "prepare_grounded_answer"
        )
        stage_status = "running"
    elif run.status in TERMINAL_ANSWER_RUN_STATUSES:
        stage_name = "prepare_grounded_answer"
        stage_status = "failed" if run.status == PpmAnswerRunStatus.FAILED else "completed"
    else:
        return None
    return _service_progress(
        run_id=run.id,
        name=stage_name,
        status_value=stage_status,
        result_count=(
            completion_progress.get("received_chunks")
            if stage_name == "receive_provider_answer"
            else len(run.retrieved_chunks_json)
            if run.retrieved_chunks_json
            else None
        ),
    )


def _normalize_answer_request(payload):
    if not isinstance(payload, dict):
        raise PpmBrainConflict(code="BRAIN_ANSWER_INVALID", message="Запрос ответа должен быть объектом.")
    unknown = sorted(set(payload) - ANSWER_REQUEST_FIELDS)
    if unknown:
        raise PpmBrainConflict(
            code="BRAIN_ANSWER_FIELD_FORBIDDEN",
            message="Запрос ответа содержит запрещённые поля.",
            details={"fields": unknown},
        )
    return {
        "query": payload.get("query"),
        "client_operation_id": payload.get("client_operation_id"),
        "board_id": payload.get("board_id"),
        "selected_shape_ids": payload.get("selected_shape_ids"),
        "graph_depth": payload.get("graph_depth", 1),
    }


def _answer_run_stream_response(*, run, created):
    def stream():
        current = PpmAnswerRun.objects.get(id=run.id)
        yield _service_stream_event("run", serialize_answer_run(current))

        if created:
            try:
                from .tasks import process_brain_answer_run_task

                process_brain_answer_run_task.delay(str(run.id))
            except Exception:
                logger.exception("PPM Project Brain answer queue unavailable", extra={"run_id": str(run.id)})
                now = timezone.now()
                PpmAnswerRun.objects.filter(id=run.id).exclude(status__in=TERMINAL_ANSWER_RUN_STATUSES).update(
                    status=PpmAnswerRunStatus.FAILED,
                    error_code="ANSWER_QUEUE_UNAVAILABLE",
                    error_message="Очередь ответов временно недоступна. Повторите запуск позже.",
                    finished_at=now,
                    updated_at=now,
                )

        last_marker = current.updated_at.isoformat()
        last_progress_key = None
        deadline = time.monotonic() + SERVICE_STREAM_TIMEOUT_SECONDS
        last_keepalive_at = time.monotonic()
        while time.monotonic() < deadline:
            current = PpmAnswerRun.objects.filter(id=run.id).first()
            if current is None:
                yield _service_stream_event(
                    "error",
                    {"code": "BRAIN_RUN_NOT_FOUND", "message": "Запрос больше не доступен."},
                )
                return
            marker = current.updated_at.isoformat()
            if marker != last_marker:
                yield _service_stream_event("run", serialize_answer_run(current))
                last_marker = marker
            progress = _answer_progress_snapshot(current)
            progress_key = (
                current.status,
                len(current.retrieved_chunks_json),
                json.dumps((current.scope_json or {}).get("completion_progress") or {}, sort_keys=True),
                current.finished_at.isoformat() if current.finished_at else None,
            )
            if progress is not None and progress_key != last_progress_key:
                yield _service_stream_event("progress", progress)
                last_progress_key = progress_key
            if current.status in TERMINAL_ANSWER_RUN_STATUSES:
                if current.status == PpmAnswerRunStatus.FAILED:
                    yield _service_stream_event(
                        "error",
                        {
                            "code": current.error_code or "ANSWER_RUN_FAILED",
                            "message": current.error_message or "Не удалось подготовить ответ.",
                        },
                    )
                return
            now = time.monotonic()
            if now - last_keepalive_at >= AGENT_STREAM_KEEPALIVE_SECONDS:
                yield ": keepalive\n\n"
                last_keepalive_at = now
            time.sleep(AGENT_STREAM_POLL_SECONDS)
        yield _service_stream_event("timeout", {"retry": True, "run_id": str(run.id)})

    response = StreamingHttpResponse(
        stream(),
        content_type="text/event-stream",
        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )
    response["Cache-Control"] = "no-cache, no-transform"
    response["X-Accel-Buffering"] = "no"
    return response


class PpmBrainAnswerRunStreamCreateView(PpmBrainAPIView):
    renderer_classes = [PpmEventStreamRenderer, JSONRenderer]

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_answers(request, workspace_id, project_id)
        if denied:
            return denied
        payload = _normalize_answer_request(request.data)
        run, created = create_answer_run(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
            **payload,
            dispatch=False,
        )
        return _answer_run_stream_response(run=run, created=created)


class PpmBrainAnswerRunDetailView(PpmBrainAPIView):
    def get_run(self, request, workspace_id, project_id, run_id):
        return PpmAnswerRun.objects.filter(
            id=run_id,
            workspace_id=workspace_id,
            project_id=project_id,
            created_by=request.user.id,
        ).first()

    def get(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_answers(request, workspace_id, project_id)
        if denied:
            return denied
        run = self.get_run(request, workspace_id, project_id, run_id)
        if run is None:
            return ppm_error_response(
                request,
                code="BRAIN_RUN_NOT_FOUND",
                message="Запрос не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return Response(serialize_answer_run(run))


class PpmBrainAnswerRunCancelView(PpmBrainAnswerRunDetailView):
    def post(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_answers(request, workspace_id, project_id)
        if denied:
            return denied
        run = self.get_run(request, workspace_id, project_id, run_id)
        if run is None:
            return ppm_error_response(
                request,
                code="BRAIN_RUN_NOT_FOUND",
                message="Запрос не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return Response(serialize_answer_run(cancel_answer_run(run)))


class PpmBrainAnswerRunEventsView(PpmBrainAnswerRunDetailView):
    renderer_classes = [PpmEventStreamRenderer, JSONRenderer]

    def get(self, request, workspace_id, project_id, run_id):
        _, denied = self.require_answers(request, workspace_id, project_id)
        if denied:
            return denied
        run = self.get_run(request, workspace_id, project_id, run_id)
        if run is None:
            return ppm_error_response(
                request,
                code="BRAIN_RUN_NOT_FOUND",
                message="Запрос не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )

        def stream():
            last_updated = None
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                current = PpmAnswerRun.objects.filter(
                    id=run_id,
                    workspace_id=workspace_id,
                    project_id=project_id,
                    created_by=request.user.id,
                ).first()
                if current is None:
                    break
                marker = current.updated_at.isoformat()
                if marker != last_updated:
                    yield f"event: run\ndata: {json.dumps(serialize_answer_run(current), ensure_ascii=False)}\n\n"
                    last_updated = marker
                if current.status in TERMINAL_ANSWER_RUN_STATUSES:
                    break
                time.sleep(0.35)
            else:
                yield 'event: timeout\ndata: {"retry": true}\n\n'

        response = StreamingHttpResponse(stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-cache, no-transform"
        response["X-Accel-Buffering"] = "no"
        return response
