import hashlib
import json
import uuid

from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import (
    PpmKnowledgeChunk,
    PpmKnowledgeIndexState,
    PpmKnowledgeSource,
    PpmKnowledgeSourceType,
    PpmProjectMemoryConfirmationStatus,
    PpmProjectMemoryFreshness,
    PpmProjectMemoryKind,
    PpmProjectMemoryOrigin,
    PpmProjectMemoryRecord,
    PpmProjectMemorySourceReference,
)
from .services import PpmBrainConflict


MAX_MEMORY_BODY_LENGTH = 50_000
MAX_MEMORY_REFERENCES = 50


def _normalize_text(value, *, field_code, field_label, max_length):
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > max_length:
        raise PpmBrainConflict(
            code=f"BRAIN_MEMORY_INVALID_{field_code}",
            message=f"Поле «{field_label}» обязательно и не должно превышать {max_length} символов.",
        )
    return normalized


def _normalize_operation_id(value):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise PpmBrainConflict(
            code="BRAIN_MEMORY_INVALID_OPERATION_ID",
            message="Не удалось определить операцию с памятью проекта.",
        ) from exc


def _resolve_source_references(*, workspace_id, project_id, source_references):
    if (
        not isinstance(source_references, list)
        or not source_references
        or len(source_references) > MAX_MEMORY_REFERENCES
    ):
        raise PpmBrainConflict(
            code="BRAIN_MEMORY_SOURCES_REQUIRED",
            message="Выберите от 1 до 50 проверяемых источников.",
        )
    resolved = []
    seen = set()
    for raw_reference in source_references:
        if not isinstance(raw_reference, dict):
            raise PpmBrainConflict(code="BRAIN_MEMORY_SOURCE_INVALID", message="Некорректная ссылка на источник.")
        source_type = str(raw_reference.get("source_type") or "")
        source_id = str(raw_reference.get("source_id") or "")
        source_key = (source_type, source_id)
        if source_type not in PpmKnowledgeSourceType.values or not source_id or source_key in seen:
            raise PpmBrainConflict(code="BRAIN_MEMORY_SOURCE_INVALID", message="Некорректная ссылка на источник.")
        seen.add(source_key)
        source = PpmKnowledgeSource.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            index_state=PpmKnowledgeIndexState.READY,
        ).first()
        if source is None:
            raise PpmBrainConflict(
                code="BRAIN_MEMORY_SOURCE_NOT_READY",
                message="Один из источников недоступен или ещё не проиндексирован.",
            )
        locator = {}
        chunk_id = raw_reference.get("chunk_id")
        if chunk_id:
            chunk = PpmKnowledgeChunk.objects.filter(
                id=chunk_id,
                source=source,
                workspace_id=workspace_id,
                project_id=project_id,
                source_version=source.source_version,
                is_published=True,
            ).first()
            if chunk is None:
                raise PpmBrainConflict(
                    code="BRAIN_MEMORY_CHUNK_INVALID",
                    message="Ссылка на фрагмент источника устарела или недоступна.",
                )
            locator = chunk.locator_json
        resolved.append((source, locator))
    return sorted(resolved, key=lambda item: (item[0].source_type, item[0].source_id))


def _requested_source_keys(source_references):
    if not isinstance(source_references, list):
        return None
    keys = []
    for reference in source_references:
        if not isinstance(reference, dict):
            return None
        source_type = str(reference.get("source_type") or "")
        source_id = str(reference.get("source_id") or "")
        if source_type not in PpmKnowledgeSourceType.values or not source_id:
            return None
        keys.append((source_type, source_id))
    return sorted(keys)


def _memory_hash(*, kind, title, body, references):
    payload = {
        "kind": kind,
        "title": title,
        "body": body,
        "sources": [
            {
                "source_type": source.source_type,
                "source_id": source.source_id,
                "source_version": source.source_version,
                "locator": locator,
            }
            for source, locator in references
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def create_memory_record(
    *,
    workspace_id,
    project_id,
    user_id,
    kind,
    title,
    body,
    source_references,
    client_operation_id,
    origin=PpmProjectMemoryOrigin.USER,
):
    if kind not in PpmProjectMemoryKind.values:
        raise PpmBrainConflict(code="BRAIN_MEMORY_KIND_INVALID", message="Неизвестный тип записи памяти.")
    if origin not in PpmProjectMemoryOrigin.values:
        raise PpmBrainConflict(code="BRAIN_MEMORY_ORIGIN_INVALID", message="Неизвестный источник записи памяти.")
    title = _normalize_text(title, field_code="TITLE", field_label="название", max_length=255)
    body = _normalize_text(
        body,
        field_code="BODY",
        field_label="содержание",
        max_length=MAX_MEMORY_BODY_LENGTH,
    )
    operation_id = _normalize_operation_id(client_operation_id)
    existing = (
        PpmProjectMemoryRecord.objects.filter(
            project_id=project_id,
            created_by=user_id,
            client_operation_id=operation_id,
        )
        .prefetch_related("source_references")
        .first()
    )
    if existing is not None:
        requested_keys = _requested_source_keys(source_references)
        existing_keys = sorted(
            (reference.source_type, reference.source_id) for reference in existing.source_references.all()
        )
        if (
            existing.workspace_id != workspace_id
            or existing.kind != kind
            or existing.title != title
            or existing.body != body
            or existing.origin != origin
            or requested_keys != existing_keys
        ):
            raise PpmBrainConflict(
                code="BRAIN_MEMORY_OPERATION_CONFLICT",
                message="Идентификатор операции уже использован для другой записи памяти.",
            )
        return existing, False
    references = _resolve_source_references(
        workspace_id=workspace_id,
        project_id=project_id,
        source_references=source_references,
    )
    confirmation_status = (
        PpmProjectMemoryConfirmationStatus.PROPOSED
        if origin == PpmProjectMemoryOrigin.AGENT
        else PpmProjectMemoryConfirmationStatus.CONFIRMED
    )
    content_hash = _memory_hash(kind=kind, title=title, body=body, references=references)
    try:
        with transaction.atomic():
            record, created = PpmProjectMemoryRecord.objects.get_or_create(
                project_id=project_id,
                created_by=user_id,
                client_operation_id=operation_id,
                defaults={
                    "workspace_id": workspace_id,
                    "kind": kind,
                    "title": title,
                    "body": body,
                    "origin": origin,
                    "confirmation_status": confirmation_status,
                    "freshness_status": PpmProjectMemoryFreshness.CURRENT,
                    "content_hash": content_hash,
                    "confirmed_by": user_id
                    if confirmation_status == PpmProjectMemoryConfirmationStatus.CONFIRMED
                    else None,
                    "confirmed_at": timezone.now()
                    if confirmation_status == PpmProjectMemoryConfirmationStatus.CONFIRMED
                    else None,
                },
            )
            if created:
                PpmProjectMemorySourceReference.objects.bulk_create(
                    [
                        PpmProjectMemorySourceReference(
                            workspace_id=workspace_id,
                            project_id=project_id,
                            memory_record=record,
                            knowledge_source=source,
                            source_type=source.source_type,
                            source_id=source.source_id,
                            source_version=source.source_version,
                            locator_json=locator,
                        )
                        for source, locator in references
                    ]
                )
    except IntegrityError:
        record = PpmProjectMemoryRecord.objects.get(
            project_id=project_id,
            created_by=user_id,
            client_operation_id=operation_id,
        )
        created = False
    expected = (workspace_id, kind, title, body, origin, content_hash)
    actual = (record.workspace_id, record.kind, record.title, record.body, record.origin, record.content_hash)
    if not created and actual != expected:
        raise PpmBrainConflict(
            code="BRAIN_MEMORY_OPERATION_CONFLICT",
            message="Идентификатор операции уже использован для другой записи памяти.",
        )
    return record, created


def refresh_memory_freshness(record):
    references = list(record.source_references.select_related("knowledge_source"))
    is_current = bool(references) and all(
        reference.workspace_id == record.workspace_id
        and reference.project_id == record.project_id
        and reference.knowledge_source.workspace_id == record.workspace_id
        and reference.knowledge_source.project_id == record.project_id
        and reference.knowledge_source.source_version == reference.source_version
        and reference.knowledge_source.index_state == PpmKnowledgeIndexState.READY
        for reference in references
    )
    next_status = PpmProjectMemoryFreshness.CURRENT if is_current else PpmProjectMemoryFreshness.POSSIBLY_STALE
    if record.freshness_status != next_status:
        PpmProjectMemoryRecord.objects.filter(id=record.id).update(
            freshness_status=next_status,
            updated_at=timezone.now(),
        )
        record.freshness_status = next_status
    return record


def refresh_project_memory_freshness(*, workspace_id, project_id):
    records = PpmProjectMemoryRecord.objects.filter(workspace_id=workspace_id, project_id=project_id).prefetch_related(
        "source_references__knowledge_source"
    )
    return [refresh_memory_freshness(record) for record in records]


def review_memory_record(*, record, user_id, confirmation_status):
    if confirmation_status not in {
        PpmProjectMemoryConfirmationStatus.CONFIRMED,
        PpmProjectMemoryConfirmationStatus.REJECTED,
    }:
        raise PpmBrainConflict(code="BRAIN_MEMORY_REVIEW_INVALID", message="Некорректное решение по записи памяти.")
    with transaction.atomic():
        locked = PpmProjectMemoryRecord.objects.select_for_update().get(id=record.id)
        if locked.confirmation_status != PpmProjectMemoryConfirmationStatus.PROPOSED:
            raise PpmBrainConflict(
                code="BRAIN_MEMORY_ALREADY_REVIEWED",
                message="Предложение памяти уже рассмотрено.",
            )
        locked.confirmation_status = confirmation_status
        locked.confirmed_by = user_id
        locked.confirmed_at = timezone.now()
        locked.save(update_fields=["confirmation_status", "confirmed_by", "confirmed_at", "updated_at"])
    return locked


def serialize_memory_record(record):
    refresh_memory_freshness(record)
    references = list(record.source_references.select_related("knowledge_source"))
    return {
        "id": str(record.id),
        "kind": record.kind,
        "title": record.title,
        "body": record.body,
        "origin": record.origin,
        "confirmation_status": record.confirmation_status,
        "freshness_status": record.freshness_status,
        "content_hash": record.content_hash,
        "created_by": str(record.created_by),
        "confirmed_by": str(record.confirmed_by) if record.confirmed_by else None,
        "confirmed_at": record.confirmed_at.isoformat() if record.confirmed_at else None,
        "created_at": record.created_at.isoformat(),
        "updated_at": record.updated_at.isoformat(),
        "source_references": [
            {
                "source_type": reference.source_type,
                "source_id": reference.source_id,
                "source_version": reference.source_version,
                "title": reference.knowledge_source.title,
                "locator": reference.locator_json,
                "current_version": reference.knowledge_source.source_version,
                "current_state": reference.knowledge_source.index_state,
                "is_current": reference.knowledge_source.source_version == reference.source_version
                and reference.knowledge_source.index_state == PpmKnowledgeIndexState.READY,
            }
            for reference in references
        ],
    }
