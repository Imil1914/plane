from collections import Counter

from django.utils import timezone

from plane.db.models import Issue

from .adapters import PpmBrainSourceError, load_source_metadata
from .agent_actions import (
    PpmAgentActionError,
    finish_agent_run,
    record_agent_tool_call,
    record_run_citations,
    start_agent_tool_call,
)
from .models import PpmAgentKind, PpmKnowledgeIndexState, PpmKnowledgeSource, PpmKnowledgeSourceType


STATE_LABELS = {
    "backlog": "Бэклог",
    "unstarted": "Не начато",
    "started": "В работе",
    "completed": "Завершено",
    "cancelled": "Отменено",
}
PRIORITY_LABELS = {
    "urgent": "срочный",
    "high": "высокий",
    "medium": "средний",
    "low": "низкий",
    "none": "без приоритета",
}
PRIORITY_WEIGHT = {"urgent": 0, "high": 1, "medium": 2, "low": 3, "none": 4}


def normalize_project_reporter_options(options):
    if options is None:
        return {"max_highlights": 10}
    if not isinstance(options, dict) or set(options) - {"max_highlights"}:
        raise PpmAgentActionError(
            code="PROJECT_REPORTER_OPTIONS_INVALID",
            message="Настройки сводки проекта не поддерживаются.",
        )
    max_highlights = options.get("max_highlights", 10)
    if isinstance(max_highlights, bool) or not isinstance(max_highlights, int) or not 1 <= max_highlights <= 20:
        raise PpmAgentActionError(
            code="PROJECT_REPORTER_OPTIONS_INVALID",
            message="Количество важных задач должно быть от 1 до 20.",
        )
    return {"max_highlights": max_highlights}


def _issue_identifier(issue):
    return f"{issue.project.identifier}-{issue.sequence_id}"


def _is_closed(issue):
    return bool(issue.state and issue.state.group in {"completed", "cancelled"})


def _serialize_highlight(issue, *, today):
    overdue = bool(issue.target_date and issue.target_date < today and not _is_closed(issue))
    return {
        "id": str(issue.id),
        "identifier": _issue_identifier(issue),
        "title": issue.name,
        "state": issue.state.name if issue.state else "Без статуса",
        "state_group": issue.state.group if issue.state else "unstarted",
        "priority": issue.priority,
        "target_date": issue.target_date.isoformat() if issue.target_date else None,
        "overdue": overdue,
    }


def _report_markdown(*, issue_count, state_counts, overdue, risks, completed, highlights):
    state_lines = [
        f"- {STATE_LABELS.get(group, group)}: {count}"
        for group, count in sorted(state_counts.items(), key=lambda item: item[0])
    ]
    highlight_lines = [
        "- {identifier} — {title} · {state} · {priority}{deadline}".format(
            identifier=item["identifier"],
            title=item["title"],
            state=item["state"],
            priority=PRIORITY_LABELS.get(item["priority"], item["priority"]),
            deadline=f" · срок {item['target_date']}" if item["target_date"] else "",
        )
        for item in highlights
    ]
    sections = [
        "# Сводка проекта",
        "",
        f"Всего задач: {issue_count}. Завершено: {completed}. Просрочено: {overdue}. Рисков: {risks}.",
        "",
        "## Состояние работы",
        *(state_lines or ["- Задач пока нет."]),
        "",
        "## Важные задачи и риски",
        *(highlight_lines or ["- Важных открытых задач не найдено."]),
        "",
        "Сводка построена по текущему состоянию задач PPM. Источники закреплены версиями Мозга проекта.",
    ]
    return "\n".join(sections)


def run_project_reporter(*, run, options=None, progress_callback=None):
    if run.agent_kind != PpmAgentKind.PROJECT_REPORTER:
        raise PpmAgentActionError(
            code="PROJECT_REPORTER_KIND_REQUIRED",
            message="Этот обработчик запускает только агент «Сводка проекта».",
        )
    options = normalize_project_reporter_options(options)
    today = timezone.localdate()
    list_call_id = start_agent_tool_call(
        run=run,
        tool_name="list_work_items",
        payload={},
        progress_callback=progress_callback,
    )
    issues = list(
        Issue.issue_objects.filter(workspace_id=run.workspace_id, project_id=run.project_id)
        .select_related("state", "project")
        .order_by("-updated_at", "id")
    )
    record_agent_tool_call(
        run=run,
        tool_name="list_work_items",
        payload={},
        result_count=len(issues),
        call_id=list_call_id,
        progress_callback=progress_callback,
    )
    state_counts = Counter(issue.state.group if issue.state else "unstarted" for issue in issues)
    overdue_issues = [
        issue for issue in issues if issue.target_date and issue.target_date < today and not _is_closed(issue)
    ]
    risk_issues = [issue for issue in issues if not _is_closed(issue) and issue.priority in {"urgent", "high"}]
    completed_count = sum(1 for issue in issues if issue.state and issue.state.group == "completed")
    highlighted = sorted(
        {issue.id: issue for issue in overdue_issues + risk_issues}.values(),
        key=lambda issue: (
            0 if issue in overdue_issues else 1,
            PRIORITY_WEIGHT.get(issue.priority, 99),
            issue.target_date or today,
            issue.sequence_id,
        ),
    )[: options["max_highlights"]]

    candidate_sources = {
        source.source_id: source
        for source in PpmKnowledgeSource.objects.filter(
            workspace_id=run.workspace_id,
            project_id=run.project_id,
            source_type=PpmKnowledgeSourceType.WORK_ITEM,
            source_id__in=[str(issue.id) for issue in highlighted],
            index_state=PpmKnowledgeIndexState.READY,
        )
    }
    source_by_issue_id = {}
    for issue in highlighted:
        source = candidate_sources.get(str(issue.id))
        if source is None:
            continue
        read_payload = {"work_item_id": str(issue.id)}
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
                source_id=issue.id,
            )
        except PpmBrainSourceError:
            continue
        if canonical.source_version == source.source_version:
            record_agent_tool_call(
                run=run,
                tool_name="read_work_item",
                payload=read_payload,
                result_count=1,
                call_id=read_call_id,
                progress_callback=progress_callback,
            )
            source_by_issue_id[str(issue.id)] = source
    cited_highlights = [issue for issue in highlighted if str(issue.id) in source_by_issue_id]
    if cited_highlights:
        record_run_citations(
            run=run,
            citations=[
                {
                    "source_type": PpmKnowledgeSourceType.WORK_ITEM,
                    "source_id": str(issue.id),
                    "source_version": source_by_issue_id[str(issue.id)].source_version,
                    "locator": {"identifier": _issue_identifier(issue)},
                }
                for issue in cited_highlights
            ],
        )
    serialized_highlights = [_serialize_highlight(issue, today=today) for issue in highlighted]
    result = {
        "kind": "project_report",
        "generated_at": timezone.now().isoformat(),
        "scope": {"workspace_id": str(run.workspace_id), "project_id": str(run.project_id)},
        "metrics": {
            "issue_count": len(issues),
            "completed_count": completed_count,
            "overdue_count": len(overdue_issues),
            "risk_count": len(risk_issues),
            "state_counts": dict(sorted(state_counts.items())),
        },
        "highlights": serialized_highlights,
        "uncited_highlight_count": len(highlighted) - len(cited_highlights),
        "markdown": _report_markdown(
            issue_count=len(issues),
            state_counts=state_counts,
            overdue=len(overdue_issues),
            risks=len(risk_issues),
            completed=completed_count,
            highlights=serialized_highlights,
        ),
    }
    return finish_agent_run(run, result=result)
