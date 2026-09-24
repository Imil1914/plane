import uuid

from django.utils import timezone

from plane.db.models import Issue

from .adapters import PpmBrainSourceError, load_source_metadata
from .agent_actions import (
    PpmAgentActionError,
    add_proposed_action,
    finish_agent_run,
    record_agent_tool_call,
    start_agent_tool_call,
)
from .models import PpmAgentKind, PpmKnowledgeIndexState, PpmKnowledgeSource, PpmKnowledgeSourceType


def normalize_work_decomposer_options(options):
    if not isinstance(options, dict) or set(options) - {"goal", "source_id"}:
        raise PpmAgentActionError(
            code="WORK_DECOMPOSER_OPTIONS_INVALID",
            message="Укажите цель и одну актуальную задачу проекта.",
        )
    goal = str(options.get("goal") or "").strip()
    source_id = str(options.get("source_id") or "").strip()
    if not 3 <= len(goal) <= 500 or not source_id:
        raise PpmAgentActionError(
            code="WORK_DECOMPOSER_OPTIONS_INVALID",
            message="Цель должна содержать от 3 до 500 символов, а источник обязателен.",
        )
    return {"goal": goal, "source_id": source_id}


def _title(prefix, goal):
    available = 255 - len(prefix)
    normalized = goal if len(goal) <= available else f"{goal[: available - 1].rstrip()}…"
    return f"{prefix}{normalized}"


def _proposal_items(*, goal, source):
    source_ids = [source.source_id]
    return [
        {
            "title": _title("Уточнить результат: ", goal),
            "description": (
                f"Зафиксировать ожидаемый результат, границы и ответственного для цели «{goal}». "
                f"Основание: {source.title}."
            ),
            "acceptance_criteria": [
                "Ожидаемый результат описан и понятен участникам проекта",
                "Зафиксированы ограничения, ответственный и способ проверки результата",
            ],
            "source_ids": source_ids,
        },
        {
            "title": _title("Реализовать: ", goal),
            "description": (
                f"Выполнить согласованный объём работы по цели «{goal}» и приложить подтверждения результата. "
                f"Основание: {source.title}."
            ),
            "acceptance_criteria": [
                "Согласованный объём работы выполнен",
                "Результат связан с исходной задачей и готов к проверке",
            ],
            "source_ids": source_ids,
        },
        {
            "title": _title("Проверить результат: ", goal),
            "description": (
                f"Проверить результат по согласованным критериям и зафиксировать итог по цели «{goal}». "
                f"Основание: {source.title}."
            ),
            "acceptance_criteria": [
                "Все согласованные критерии приёмки проверены",
                "Итог проверки и обнаруженные замечания зафиксированы в проекте",
            ],
            "source_ids": source_ids,
        },
    ]


def run_work_decomposer(*, run, options=None, progress_callback=None):
    if run.agent_kind != PpmAgentKind.WORK_DECOMPOSER:
        raise PpmAgentActionError(
            code="WORK_DECOMPOSER_KIND_REQUIRED",
            message="Этот обработчик запускает только агент «Декомпозиция работы».",
        )
    normalized = normalize_work_decomposer_options(options)
    source = PpmKnowledgeSource.objects.filter(
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=normalized["source_id"],
        index_state=PpmKnowledgeIndexState.READY,
    ).first()
    if source is None:
        raise PpmAgentActionError(
            code="WORK_DECOMPOSER_SOURCE_NOT_READY",
            message="Выбранная задача недоступна или ещё не проиндексирована.",
        )
    read_payload = {"work_item_id": source.source_id}
    read_call_id = start_agent_tool_call(
        run=run,
        tool_name="read_work_item",
        payload=read_payload,
        progress_callback=progress_callback,
    )
    try:
        canonical = load_source_metadata(
            workspace_id=run.workspace_id,
            project_id=run.project_id,
            source_type=PpmKnowledgeSourceType.WORK_ITEM,
            source_id=source.source_id,
        )
    except PpmBrainSourceError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message) from exc
    if canonical.source_version != source.source_version:
        raise PpmAgentActionError(
            code="WORK_DECOMPOSER_SOURCE_CHANGED",
            message="Задача изменилась. Обновите индекс и повторите декомпозицию.",
        )
    issue = (
        Issue.issue_objects.filter(
            id=source.source_id,
            workspace_id=run.workspace_id,
            project_id=run.project_id,
        )
        .select_related("project")
        .first()
    )
    if issue is None:
        raise PpmAgentActionError(
            code="WORK_DECOMPOSER_SOURCE_NOT_FOUND",
            message="Исходная задача больше не существует.",
        )
    record_agent_tool_call(
        run=run,
        tool_name="read_work_item",
        payload=read_payload,
        result_count=1,
        call_id=read_call_id,
        progress_callback=progress_callback,
    )

    items = _proposal_items(goal=normalized["goal"], source=source)
    identifier = f"{issue.project.identifier}-{issue.sequence_id}"
    citation = {
        "source_type": source.source_type,
        "source_id": source.source_id,
        "source_version": source.source_version,
        "locator": {"identifier": identifier},
    }
    actions = []
    for index, item in enumerate(items):
        preview = {
            "title": item["title"],
            "summary": "Для этой задачи можно принять отдельное решение. Реальная задача пока не создаётся.",
            "source": {"identifier": identifier, "title": source.title},
            "items": [item],
            "batch": {"position": index + 1, "total": len(items)},
        }
        proposal_payload = {"items": [item]}
        proposal_call_id = start_agent_tool_call(
            run=run,
            tool_name="propose_work_items",
            payload=proposal_payload,
            progress_callback=progress_callback,
        )
        action, _ = add_proposed_action(
            run=run,
            proposal_tool="propose_work_items",
            payload=proposal_payload,
            preview=preview,
            citations=[citation],
            idempotency_key=uuid.uuid5(uuid.UUID(str(run.id)), f"work-decomposition-v2-item-{index}"),
            tool_call_id=proposal_call_id,
            progress_callback=progress_callback,
        )
        actions.append(action)
    result = {
        "kind": "work_decomposition",
        "generated_at": timezone.now().isoformat(),
        "goal": normalized["goal"],
        "source": {"id": source.source_id, "identifier": identifier, "title": source.title},
        "item_count": len(items),
        "action_id": str(actions[0].id),
        "action_ids": [str(action.id) for action in actions],
        "canonical_changes_applied": False,
    }
    return finish_agent_run(run, result=result)
