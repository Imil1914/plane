import re
import uuid

from django.utils import timezone

from plane.ppm_canvas.models import (
    PpmCanvasBindingStatus,
    PpmCanvasBoard,
    PpmCanvasEntityType,
    PpmSemanticRelationType,
)
from plane.ppm_canvas.schema import canvas_snapshot_shape_ids

from .adapters import PpmBrainSourceError, load_source
from .agent_actions import (
    PpmAgentActionError,
    add_proposed_action,
    finish_agent_run,
    record_agent_tool_call,
    start_agent_tool_call,
)
from .models import PpmAgentKind, PpmKnowledgeIndexState, PpmKnowledgeSource, PpmKnowledgeSourceType


SHAPE_ID_PATTERN = re.compile(r"^shape:[A-Za-z0-9_-]+$")
ENTITY_TO_SOURCE_TYPE = {
    PpmCanvasEntityType.WORK_ITEM: PpmKnowledgeSourceType.WORK_ITEM,
    PpmCanvasEntityType.VAULT_FILE: PpmKnowledgeSourceType.VAULT_FILE,
}


def normalize_relationship_analyst_options(options):
    allowed = {"from_shape_id", "to_shape_id", "relation", "reason"}
    if not isinstance(options, dict) or set(options) - allowed:
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_OPTIONS_INVALID",
            message="Выберите два объекта, тип связи и укажите основание.",
        )
    from_shape_id = str(options.get("from_shape_id") or "").strip()
    to_shape_id = str(options.get("to_shape_id") or "").strip()
    relation = str(options.get("relation") or "").strip()
    reason = re.sub(r"\s+", " ", str(options.get("reason") or "")).strip()
    if (
        not SHAPE_ID_PATTERN.fullmatch(from_shape_id)
        or not SHAPE_ID_PATTERN.fullmatch(to_shape_id)
        or from_shape_id == to_shape_id
        or relation not in PpmSemanticRelationType.values
        or not 3 <= len(reason) <= 1_000
    ):
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_OPTIONS_INVALID",
            message="Выберите два разных объекта, допустимый тип связи и основание от 3 до 1000 символов.",
        )
    return {
        "from_shape_id": from_shape_id,
        "to_shape_id": to_shape_id,
        "relation": relation,
        "reason": reason,
    }


def _current_board(run):
    board_id = run.context_json.get("canvas_id")
    if not board_id:
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_BOARD_REQUIRED",
            message="Откройте доску проекта перед анализом связей.",
        )
    board = (
        PpmCanvasBoard.objects.select_related("canvas")
        .filter(
            id=board_id,
            workspace_id=run.workspace_id,
            project_id=run.project_id,
            canvas__project_id=run.project_id,
        )
        .first()
    )
    if board is None:
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_BOARD_NOT_FOUND",
            message="Текущая доска недоступна в этом проекте.",
        )
    return board


def _validate_selected_shapes(*, run, board, normalized):
    requested_shape_ids = [normalized["from_shape_id"], normalized["to_shape_id"]]
    selected_shape_ids = run.context_json.get("selected_shape_ids") or []
    if len(selected_shape_ids) != 2 or set(selected_shape_ids) != set(requested_shape_ids):
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_SELECTION_CHANGED",
            message="Выбор на доске изменился. Выберите ровно два объекта и повторите анализ.",
        )
    current = board.versions.filter(version=board.current_version).first() if board.current_version else None
    shape_ids = canvas_snapshot_shape_ids(current.snapshot_json) if current else set()
    missing = sorted(set(requested_shape_ids) - shape_ids)
    if missing:
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_SHAPE_NOT_FOUND",
            message="Один или оба выбранных объекта отсутствуют в текущей версии доски.",
            details={"shape_ids": missing},
        )


def _resolve_sources(*, run, board, shape_ids, progress_callback=None):
    bindings = {
        binding.shape_id: binding
        for binding in board.bindings.filter(
            shape_id__in=shape_ids,
            status=PpmCanvasBindingStatus.ACTIVE,
        )
    }
    citations = []
    labels = {}
    source_ids = []
    for shape_id in shape_ids:
        binding = bindings.get(shape_id)
        if binding is None:
            labels[shape_id] = shape_id
            continue
        source_type = ENTITY_TO_SOURCE_TYPE.get(binding.entity_type)
        if source_type is None:
            labels[shape_id] = binding.get_entity_type_display()
            continue
        source = PpmKnowledgeSource.objects.filter(
            workspace_id=run.workspace_id,
            project_id=run.project_id,
            source_type=source_type,
            source_id=str(binding.entity_id),
            index_state=PpmKnowledgeIndexState.READY,
        ).first()
        if source is None:
            labels[shape_id] = binding.get_entity_type_display()
            continue
        tool_name = "read_work_item" if source_type == PpmKnowledgeSourceType.WORK_ITEM else "read_vault_file"
        tool_payload = (
            {"work_item_id": source.source_id}
            if source_type == PpmKnowledgeSourceType.WORK_ITEM
            else {"entry_id": source.source_id}
        )
        read_call_id = start_agent_tool_call(
            run=run,
            tool_name=tool_name,
            payload=tool_payload,
            progress_callback=progress_callback,
        )
        try:
            canonical = load_source(
                workspace_id=run.workspace_id,
                project_id=run.project_id,
                source_type=source.source_type,
                source_id=source.source_id,
            )
        except PpmBrainSourceError as exc:
            raise PpmAgentActionError(code=exc.code, message=exc.message) from exc
        if canonical.source_version != source.source_version:
            raise PpmAgentActionError(
                code="RELATIONSHIP_ANALYST_SOURCE_CHANGED",
                message="Один из источников изменился. Обновите индекс и повторите анализ.",
            )
        record_agent_tool_call(
            run=run,
            tool_name=tool_name,
            payload=tool_payload,
            result_count=1,
            call_id=read_call_id,
            progress_callback=progress_callback,
        )
        labels[shape_id] = source.title
        if source.source_id in source_ids:
            continue
        source_ids.append(source.source_id)
        locator = canonical.parts[0].locator if canonical.parts else {"kind": source.source_type}
        citations.append(
            {
                "source_type": source.source_type,
                "source_id": source.source_id,
                "source_version": source.source_version,
                "locator": locator,
            }
        )
    if not citations:
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_SOURCE_REQUIRED",
            message="Хотя бы один выбранный объект должен быть актуальной задачей или Markdown-материалом.",
        )
    return citations, labels, source_ids


def run_relationship_analyst(*, run, options=None, progress_callback=None):
    if run.agent_kind != PpmAgentKind.RELATIONSHIP_ANALYST:
        raise PpmAgentActionError(
            code="RELATIONSHIP_ANALYST_KIND_REQUIRED",
            message="Этот обработчик запускает только агент «Аналитик связей».",
        )
    normalized = normalize_relationship_analyst_options(options)
    shape_ids = [normalized["from_shape_id"], normalized["to_shape_id"]]
    board = _current_board(run)
    canvas_payload = {
        "board_id": str(board.id),
        "shape_ids": shape_ids,
        "depth": 1,
    }
    canvas_call_id = start_agent_tool_call(
        run=run,
        tool_name="read_canvas_neighborhood",
        payload=canvas_payload,
        progress_callback=progress_callback,
    )
    _validate_selected_shapes(run=run, board=board, normalized=normalized)
    record_agent_tool_call(
        run=run,
        tool_name="read_canvas_neighborhood",
        payload=canvas_payload,
        result_count=len(shape_ids),
        call_id=canvas_call_id,
        progress_callback=progress_callback,
    )
    citations, labels, source_ids = _resolve_sources(
        run=run,
        board=board,
        shape_ids=shape_ids,
        progress_callback=progress_callback,
    )
    edge = {
        "board_id": str(board.id),
        "from_shape_id": normalized["from_shape_id"],
        "to_shape_id": normalized["to_shape_id"],
        "relation": normalized["relation"],
        "reason": normalized["reason"],
        "source_ids": source_ids,
    }
    preview = {
        "title": "Предложена смысловая связь",
        "summary": "Связь можно принять или отклонить. Холст пока не изменяется.",
        "edge": {
            **edge,
            "from_title": labels[normalized["from_shape_id"]],
            "to_title": labels[normalized["to_shape_id"]],
        },
    }
    proposal_payload = {"edges": [edge]}
    proposal_call_id = start_agent_tool_call(
        run=run,
        tool_name="propose_semantic_edges",
        payload=proposal_payload,
        progress_callback=progress_callback,
    )
    action, _ = add_proposed_action(
        run=run,
        proposal_tool="propose_semantic_edges",
        payload=proposal_payload,
        preview=preview,
        citations=citations,
        idempotency_key=uuid.uuid5(uuid.UUID(str(run.id)), "relationship-analyst-v1"),
        tool_call_id=proposal_call_id,
        progress_callback=progress_callback,
    )
    result = {
        "kind": "semantic_edge_proposal",
        "generated_at": timezone.now().isoformat(),
        "action_id": str(action.id),
        "board": {"id": str(board.id), "name": board.name, "version": board.current_version},
        "edge": preview["edge"],
        "canonical_changes_applied": False,
    }
    return finish_agent_run(run, result=result)
