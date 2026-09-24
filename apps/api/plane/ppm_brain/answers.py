import uuid

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from plane.db.models import Workspace
from plane.ppm_canvas.models import (
    PpmCanvasBoard,
    PpmCanvasStatus,
)

from .completions import PpmCompletionProviderCancelled, PpmCompletionProviderError, get_completion_provider
from .graph import normalize_graph_depth, resolve_graph_context
from .models import (
    PpmAnswerRun,
    PpmAnswerRunStatus,
    PpmKnowledgeChunk,
    PpmKnowledgeIndexState,
    PpmKnowledgeSourceType,
    TERMINAL_ANSWER_RUN_STATUSES,
)
from .services import MAX_QUERY_LENGTH, PpmBrainConflict, estimate_tokens, retrieve_chunks_with_metadata


MAX_SELECTED_SHAPES = 500
MAX_CONTEXT_TOKENS = 6_000
MAX_CONTEXT_CHUNKS = 24
PPM_BRAIN_ANSWER_POLICY_VERSION = "ppm-brain-answer-v1"


def serialize_answer_run(run):
    return {
        "id": str(run.id),
        "query": run.query,
        "board_id": str(run.board_id) if run.board_id else None,
        "selected_shape_ids": run.selected_shape_ids,
        "graph_depth": run.graph_depth,
        "scope": run.scope_json,
        "status": run.status,
        "provider": run.provider or None,
        "model": run.model or None,
        "policy_version": PPM_BRAIN_ANSWER_POLICY_VERSION,
        "answer": run.answer_text,
        "citations": run.citations_json,
        "retrieved_sources": run.retrieved_chunks_json,
        "retrieval": run.retrieval_json,
        "error": (
            {"code": run.error_code, "message": run.error_message} if run.error_code or run.error_message else None
        ),
        "cancel_requested": bool(run.cancel_requested_at),
        "created_at": run.created_at.isoformat(),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "updated_at": run.updated_at.isoformat(),
    }


def _normalize_question(value):
    query = " ".join(str(value or "").strip().split())
    if not query or len(query) > MAX_QUERY_LENGTH:
        raise PpmBrainConflict(code="BRAIN_INVALID_QUERY", message="Введите вопрос длиной до 500 символов.")
    return query


def _normalize_selected_shape_ids(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_SELECTED_SHAPES:
        raise PpmBrainConflict(
            code="BRAIN_INVALID_SELECTION",
            message="Выберите не более 500 объектов холста.",
        )
    selected = []
    for shape_id in value:
        if not isinstance(shape_id, str):
            raise PpmBrainConflict(code="BRAIN_INVALID_SELECTION", message="Выбран некорректный объект холста.")
        shape_id = shape_id.strip()
        if not shape_id or len(shape_id) > 255:
            raise PpmBrainConflict(code="BRAIN_INVALID_SELECTION", message="Выбран некорректный объект холста.")
        if shape_id not in selected:
            selected.append(shape_id)
    return selected


def create_answer_run(
    *,
    workspace_id,
    project_id,
    user_id,
    query,
    client_operation_id,
    board_id=None,
    selected_shape_ids=None,
    graph_depth=1,
    dispatch=False,
):
    query = _normalize_question(query)
    selected_shape_ids = _normalize_selected_shape_ids(selected_shape_ids)
    graph_depth = normalize_graph_depth(graph_depth)
    try:
        client_operation_id = uuid.UUID(str(client_operation_id))
    except (TypeError, ValueError) as exc:
        raise PpmBrainConflict(
            code="BRAIN_INVALID_OPERATION_ID",
            message="Не удалось определить запрос. Повторите попытку.",
        ) from exc

    board = None
    if board_id:
        try:
            board_id = uuid.UUID(str(board_id))
        except (TypeError, ValueError) as exc:
            raise PpmBrainConflict(
                code="BRAIN_INVALID_BOARD_ID",
                message="Не удалось определить доску холста.",
            ) from exc
        board = PpmCanvasBoard.objects.filter(
            id=board_id,
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmCanvasStatus.ACTIVE,
        ).first()
        if board is None:
            raise PpmBrainConflict(code="BRAIN_BOARD_NOT_FOUND", message="Доска холста не найдена.")
    if selected_shape_ids and board is None:
        raise PpmBrainConflict(
            code="BRAIN_SELECTION_BOARD_REQUIRED",
            message="Для выбранного контекста укажите доску холста.",
        )

    try:
        with transaction.atomic():
            run, created = PpmAnswerRun.objects.get_or_create(
                project_id=project_id,
                created_by=user_id,
                client_operation_id=client_operation_id,
                defaults={
                    "workspace_id": workspace_id,
                    "board_id": board.id if board else None,
                    "query": query,
                    "selected_shape_ids": selected_shape_ids,
                    "graph_depth": graph_depth,
                    "scope_json": {"mode": "selection" if selected_shape_ids else "project"},
                },
            )
    except IntegrityError:
        run = PpmAnswerRun.objects.get(
            project_id=project_id,
            created_by=user_id,
            client_operation_id=client_operation_id,
        )
        created = False
    if not created and (
        run.workspace_id != workspace_id
        or run.query != query
        or run.board_id != (board.id if board else None)
        or run.selected_shape_ids != selected_shape_ids
        or run.graph_depth != graph_depth
    ):
        raise PpmBrainConflict(
            code="BRAIN_OPERATION_CONFLICT",
            message="Идентификатор запроса уже использован с другими данными.",
        )
    if created and dispatch:
        from .tasks import process_brain_answer_run_task

        process_brain_answer_run_task.delay(str(run.id))
    return run, created


def _selected_source_keys(run):
    return resolve_graph_context(
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        board_id=run.board_id,
        selected_shape_ids=run.selected_shape_ids,
        graph_depth=run.graph_depth,
    )


def _source_filter(source_keys):
    source_filter = Q()
    for source_type, source_id in source_keys or []:
        source_filter |= Q(source__source_type=source_type, source__source_id=source_id)
    return source_filter


def _fetch_evidence(run, results, source_keys):
    ordered_ids = [result["chunk_id"] for result in results]
    chunks = PpmKnowledgeChunk.objects.filter(
        id__in=ordered_ids,
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        is_published=True,
        source__index_state=PpmKnowledgeIndexState.READY,
    ).select_related("source")
    if source_keys is not None:
        source_filter = _source_filter(source_keys)
        chunks = chunks.filter(source_filter) if source_filter else chunks.none()
    by_id = {str(chunk.id): chunk for chunk in chunks}
    evidence = []
    token_total = 0
    for result in results:
        chunk = by_id.get(result["chunk_id"])
        if chunk is None:
            continue
        token_count = max(1, chunk.token_count or estimate_tokens(chunk.text))
        if evidence and token_total + token_count > MAX_CONTEXT_TOKENS:
            continue
        evidence.append({**result, "text": chunk.text, "token_count": token_count})
        token_total += token_count
        if len(evidence) >= MAX_CONTEXT_CHUNKS or token_total >= MAX_CONTEXT_TOKENS:
            break
    return evidence, token_total


def _source_url(*, workspace_slug, project_id, source):
    if source["source_type"] == PpmKnowledgeSourceType.WORK_ITEM:
        identifier = source["locator"].get("identifier")
        if identifier:
            return f"/{workspace_slug}/browse/{identifier}/"
        return f"/{workspace_slug}/projects/{project_id}/issues/{source['source_id']}"
    if source["source_type"] == PpmKnowledgeSourceType.GIT_CODE:
        return source["locator"].get("canonical_url") or f"/{workspace_slug}/projects/{project_id}/code"
    return f"/{workspace_slug}/projects/{project_id}/knowledge?entry_id={source['source_id']}"


def _citations_for_ids(run, evidence, chunk_ids):
    allowed = {source["chunk_id"]: source for source in evidence}
    workspace_slug = Workspace.objects.only("slug").get(id=run.workspace_id).slug
    citations = []
    seen_sources = set()
    for chunk_id in chunk_ids:
        source = allowed.get(str(chunk_id))
        if source is None:
            continue
        source_key = (source["source_type"], source["source_id"])
        if source_key in seen_sources:
            continue
        seen_sources.add(source_key)
        citations.append(
            {
                "citation_id": source["chunk_id"],
                "chunk_id": source["chunk_id"],
                "source_type": source["source_type"],
                "source_id": source["source_id"],
                "source_version": source["source_version"],
                "title": source["title"],
                "locator": source["locator"],
                "source_url": _source_url(workspace_slug=workspace_slug, project_id=run.project_id, source=source),
                "graph_path": source.get("graph_path", []),
                "graph_explanation": _graph_explanation(source.get("graph_path", [])),
            }
        )
    return citations


def _graph_explanation(path):
    if not path:
        return "Источник выбран напрямую."
    relations = " → ".join(step["relation_type"] for step in path)
    return f"Источник найден через смысловой граф: {relations}."


def _evidence_summary(evidence):
    lines = ["Модель ответов не подключена. Ниже — проверяемая сводка по найденным материалам:"]
    seen_sources = set()
    for source in evidence:
        key = (source["source_type"], source["source_id"])
        if key in seen_sources:
            continue
        seen_sources.add(key)
        excerpt = " ".join(source["text"].split())
        if len(excerpt) > 360:
            excerpt = f"{excerpt[:357]}…"
        lines.append(f"• {source['title']}: {excerpt}")
        if len(seen_sources) >= 8:
            break
    lines.append("Выводы выше не заменяют проверку первоисточников.")
    return "\n".join(lines)


def _mark_cancelled(run_id):
    now = timezone.now()
    PpmAnswerRun.objects.filter(id=run_id).exclude(status__in=TERMINAL_ANSWER_RUN_STATUSES).update(
        status=PpmAnswerRunStatus.CANCELLED,
        cancel_requested_at=now,
        finished_at=now,
        updated_at=now,
    )
    return PpmAnswerRun.objects.get(id=run_id)


def cancel_answer_run(run):
    if run.status in TERMINAL_ANSWER_RUN_STATUSES:
        return run
    return _mark_cancelled(run.id)


def _answer_run_cancelled(run_id):
    return (
        PpmAnswerRun.objects.filter(id=run_id)
        .filter(Q(cancel_requested_at__isnull=False) | Q(status=PpmAnswerRunStatus.CANCELLED))
        .exists()
    )


def _record_completion_progress(run_id, *, stage, received_chunks):
    current = (
        PpmAnswerRun.objects.filter(id=run_id)
        .exclude(status__in=TERMINAL_ANSWER_RUN_STATUSES)
        .only("scope_json")
        .first()
    )
    if current is None:
        return None
    progress = {
        "stage": str(stage),
        "received_chunks": max(0, int(received_chunks)),
    }
    scope = {**(current.scope_json or {}), "completion_progress": progress}
    PpmAnswerRun.objects.filter(id=run_id).exclude(status__in=TERMINAL_ANSWER_RUN_STATUSES).update(
        scope_json=scope,
        updated_at=timezone.now(),
    )
    return progress


def process_answer_run(run_id):
    with transaction.atomic():
        run = PpmAnswerRun.objects.select_for_update().filter(id=run_id).first()
        if run is None:
            raise PpmBrainConflict(code="BRAIN_RUN_NOT_FOUND", message="Запрос не найден.")
        if run.status in TERMINAL_ANSWER_RUN_STATUSES:
            return run
        if run.cancel_requested_at:
            return _mark_cancelled(run.id)
        run.status = PpmAnswerRunStatus.RETRIEVING
        run.started_at = run.started_at or timezone.now()
        run.error_code = ""
        run.error_message = ""
        run.save(update_fields=["status", "started_at", "error_code", "error_message", "updated_at"])

    source_keys, scope, graph_paths_by_source = _selected_source_keys(run)
    results, retrieval = retrieve_chunks_with_metadata(
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        query=run.query,
        top_k=MAX_CONTEXT_CHUNKS,
        source_keys=source_keys,
        graph_paths_by_source=graph_paths_by_source,
        graph_scope=scope["graph"],
    )
    evidence, token_total = _fetch_evidence(run, results, source_keys)
    scope = {
        **scope,
        "retrieved_chunks": len(evidence),
        "available_sources": len({(item["source_type"], item["source_id"]) for item in evidence}),
        "context_tokens": token_total,
    }

    run.refresh_from_db()
    if run.cancel_requested_at or run.status == PpmAnswerRunStatus.CANCELLED:
        return _mark_cancelled(run.id)

    if not evidence:
        now = timezone.now()
        PpmAnswerRun.objects.filter(id=run.id).exclude(status=PpmAnswerRunStatus.CANCELLED).update(
            scope_json=scope,
            status=PpmAnswerRunStatus.NO_SOURCES,
            answer_text="В доступных материалах проекта нет подтверждённых данных для ответа на этот вопрос.",
            citations_json=[],
            retrieved_chunks_json=[],
            retrieval_json=retrieval,
            provider="disabled",
            finished_at=now,
            updated_at=now,
        )
        return PpmAnswerRun.objects.get(id=run.id)

    PpmAnswerRun.objects.filter(id=run.id).exclude(status=PpmAnswerRunStatus.CANCELLED).update(
        status=PpmAnswerRunStatus.COMPLETING,
        scope_json=scope,
        retrieved_chunks_json=[{key: value for key, value in item.items() if key != "text"} for item in evidence],
        retrieval_json=retrieval,
        updated_at=timezone.now(),
    )

    provider_name = "disabled"
    model_name = ""
    error_code = ""
    error_message = ""
    status = PpmAnswerRunStatus.DEGRADED
    answer = _evidence_summary(evidence)
    citation_ids = [source["chunk_id"] for source in evidence]
    completion_progress = None

    def record_progress(*, stage, received_chunks):
        nonlocal completion_progress
        completion_progress = _record_completion_progress(
            run.id,
            stage=stage,
            received_chunks=received_chunks,
        )

    try:
        provider = get_completion_provider()
        provider_name = provider.name
        model_name = provider.model
        if provider.enabled:
            completion = provider.complete(
                query=run.query,
                sources=evidence,
                progress_callback=record_progress,
                cancel_check=lambda: _answer_run_cancelled(run.id),
            )
            valid_ids = [chunk_id for chunk_id in completion.citation_chunk_ids if chunk_id in citation_ids]
            if not valid_ids:
                raise PpmCompletionProviderError(
                    code="COMPLETION_CITATIONS_INVALID",
                    message="Ответ модели не содержал проверяемых ссылок. Показана сводка по источникам.",
                )
            answer = completion.answer
            citation_ids = valid_ids
            status = PpmAnswerRunStatus.COMPLETED
        else:
            error_code = "COMPLETION_PROVIDER_DISABLED"
            error_message = "Модель ответов не настроена. Показана сводка по найденным источникам."
    except PpmCompletionProviderCancelled:
        return _mark_cancelled(run.id)
    except PpmCompletionProviderError as exc:
        error_code = exc.code
        error_message = _safe_completion_error_message(exc.code)

    citations = _citations_for_ids(run, evidence, citation_ids)
    if completion_progress:
        scope = {**scope, "completion_progress": completion_progress}
    now = timezone.now()
    with transaction.atomic():
        locked = PpmAnswerRun.objects.select_for_update().get(id=run.id)
        if locked.cancel_requested_at or locked.status == PpmAnswerRunStatus.CANCELLED:
            return _mark_cancelled(locked.id)
        locked.status = status
        locked.scope_json = scope
        locked.provider = provider_name
        locked.model = model_name
        locked.answer_text = answer
        locked.citations_json = citations
        locked.retrieved_chunks_json = [
            {key: value for key, value in item.items() if key != "text"} for item in evidence
        ]
        locked.retrieval_json = retrieval
        locked.error_code = error_code
        locked.error_message = error_message[:500]
        locked.finished_at = now
        locked.save(
            update_fields=[
                "status",
                "scope_json",
                "provider",
                "model",
                "answer_text",
                "citations_json",
                "retrieved_chunks_json",
                "retrieval_json",
                "error_code",
                "error_message",
                "finished_at",
                "updated_at",
            ]
        )
        return locked


def _safe_completion_error_message(code):
    messages = {
        "COMPLETION_PROVIDER_DISABLED": "Модель ответов не настроена. Показана сводка по найденным источникам.",
        "COMPLETION_EGRESS_NOT_APPROVED": "Внешняя обработка текста не разрешена политикой PPM.",
        "COMPLETION_POLICY_NOT_APPROVED": "Политика использования внешней модели не утверждена.",
        "COMPLETION_CREDENTIAL_MISSING": "Серверный ключ модели не настроен.",
        "COMPLETION_CITATIONS_INVALID": ("Ответ модели не содержал проверяемых ссылок. Показана сводка по источникам."),
    }
    return messages.get(str(code), "Модель ответов временно недоступна. Показана сводка по найденным источникам.")
