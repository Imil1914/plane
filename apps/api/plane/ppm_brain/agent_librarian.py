import re
import uuid

from django.utils import timezone

from .adapters import PpmBrainSourceError, load_source
from .agent_actions import (
    PpmAgentActionError,
    add_proposed_action,
    finish_agent_run,
    record_agent_tool_call,
    start_agent_tool_call,
)
from .models import PpmAgentKind, PpmKnowledgeIndexState, PpmKnowledgeSource, PpmKnowledgeSourceType


MAX_CONTEXT_EXCERPT = 1_200


def normalize_knowledge_librarian_options(options):
    if not isinstance(options, dict) or set(options) - {"topic", "source_id"}:
        raise PpmAgentActionError(
            code="KNOWLEDGE_LIBRARIAN_OPTIONS_INVALID",
            message="Укажите пробел в знаниях и один актуальный Markdown-материал.",
        )
    topic = re.sub(r"\s+", " ", str(options.get("topic") or "")).strip()
    source_id = str(options.get("source_id") or "").strip()
    if not 3 <= len(topic) <= 500 or not source_id:
        raise PpmAgentActionError(
            code="KNOWLEDGE_LIBRARIAN_OPTIONS_INVALID",
            message="Описание пробела должно содержать от 3 до 500 символов, а источник обязателен.",
        )
    return {"topic": topic, "source_id": source_id}


def _title(topic):
    prefix = "Дополнение: "
    available = 255 - len(prefix)
    normalized = topic if len(topic) <= available else f"{topic[: available - 1].rstrip()}…"
    return f"{prefix}{normalized}"


def _excerpt(text):
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(normalized) <= MAX_CONTEXT_EXCERPT:
        return normalized
    return f"{normalized[: MAX_CONTEXT_EXCERPT - 1].rstrip()}…"


def _proposal_body(*, topic, source_title, source_excerpt):
    return "\n".join(
        [
            f"# {_title(topic)}",
            "",
            "> Черновик Библиотекаря знаний. Перед публикацией проверьте факты и формулировки.",
            "",
            "## Обнаруженный пробел",
            topic,
            "",
            "## Контекст исходного материала",
            source_excerpt or "В исходном материале нет текстового фрагмента для предварительного просмотра.",
            "",
            "## Что нужно подтвердить перед публикацией",
            "- добавить проверенные факты, необходимые для закрытия пробела;",
            "- указать ответственного и дату актуальности, если они важны;",
            "- приложить ссылки на первичные материалы проекта;",
            "- удалить неподтверждённые предположения.",
            "",
            "## Источник",
            f"Материал проекта: {source_title}",
        ]
    )


def run_knowledge_librarian(*, run, options=None, progress_callback=None):
    if run.agent_kind != PpmAgentKind.KNOWLEDGE_LIBRARIAN:
        raise PpmAgentActionError(
            code="KNOWLEDGE_LIBRARIAN_KIND_REQUIRED",
            message="Этот обработчик запускает только агент «Библиотекарь знаний».",
        )
    normalized = normalize_knowledge_librarian_options(options)
    source = PpmKnowledgeSource.objects.filter(
        workspace_id=run.workspace_id,
        project_id=run.project_id,
        source_type=PpmKnowledgeSourceType.VAULT_FILE,
        source_id=normalized["source_id"],
        index_state=PpmKnowledgeIndexState.READY,
    ).first()
    if source is None:
        raise PpmAgentActionError(
            code="KNOWLEDGE_LIBRARIAN_SOURCE_NOT_READY",
            message="Выбранный материал недоступен или ещё не проиндексирован.",
        )
    read_payload = {"entry_id": source.source_id}
    read_call_id = start_agent_tool_call(
        run=run,
        tool_name="read_vault_file",
        payload=read_payload,
        progress_callback=progress_callback,
    )
    try:
        canonical = load_source(
            workspace_id=run.workspace_id,
            project_id=run.project_id,
            source_type=PpmKnowledgeSourceType.VAULT_FILE,
            source_id=source.source_id,
        )
    except PpmBrainSourceError as exc:
        raise PpmAgentActionError(code=exc.code, message=exc.message) from exc
    if canonical.source_version != source.source_version:
        raise PpmAgentActionError(
            code="KNOWLEDGE_LIBRARIAN_SOURCE_CHANGED",
            message="Материал изменился. Обновите индекс и повторите подготовку черновика.",
        )
    if not canonical.parts or canonical.parts[0].locator.get("kind") != "vault_markdown":
        raise PpmAgentActionError(
            code="KNOWLEDGE_LIBRARIAN_MARKDOWN_REQUIRED",
            message="Библиотекарь знаний пока работает только с Markdown-материалами.",
        )
    record_agent_tool_call(
        run=run,
        tool_name="read_vault_file",
        payload=read_payload,
        result_count=1,
        call_id=read_call_id,
        progress_callback=progress_callback,
    )

    topic = normalized["topic"]
    title = _title(topic)
    body = _proposal_body(
        topic=topic,
        source_title=canonical.title,
        source_excerpt=_excerpt(canonical.parts[0].text),
    )
    citation = {
        "source_type": source.source_type,
        "source_id": source.source_id,
        "source_version": source.source_version,
        "locator": canonical.parts[0].locator,
    }
    preview = {
        "title": title,
        "summary": "Черновик можно принять или отклонить. Хранилище пока не изменяется.",
        "source": {"title": source.title, "path": canonical.parts[0].locator.get("path", source.title)},
        "target": "vault_markdown",
        "body": body,
    }
    proposal_payload = {
        "target": "vault_markdown",
        "title": title,
        "body": body,
        "source_ids": [source.source_id],
    }
    proposal_call_id = start_agent_tool_call(
        run=run,
        tool_name="propose_page_or_vault_note",
        payload=proposal_payload,
        progress_callback=progress_callback,
    )
    action, _ = add_proposed_action(
        run=run,
        proposal_tool="propose_page_or_vault_note",
        payload=proposal_payload,
        preview=preview,
        citations=[citation],
        idempotency_key=uuid.uuid5(uuid.UUID(str(run.id)), "knowledge-librarian-v1"),
        tool_call_id=proposal_call_id,
        progress_callback=progress_callback,
    )
    result = {
        "kind": "knowledge_proposal",
        "generated_at": timezone.now().isoformat(),
        "topic": topic,
        "source": {
            "id": source.source_id,
            "path": canonical.parts[0].locator.get("path", source.title),
            "title": source.title,
        },
        "title": title,
        "action_id": str(action.id),
        "canonical_changes_applied": False,
    }
    return finish_agent_run(run, result=result)
