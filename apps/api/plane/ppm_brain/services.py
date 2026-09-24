import hashlib
import math
import re
import uuid
from dataclasses import dataclass
from datetime import timedelta

from django.contrib.postgres.search import SearchQuery, SearchRank, SearchVector
from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.utils import timezone

from plane.db.models import Issue
from plane.ppm_git.models import PpmGitCodeFile, PpmGitCodeSnapshotStatus
from plane.ppm_vault.models import PpmVaultEntry, PpmVaultEntryKind, PpmVaultEntryStatus, PpmVaultIndexPolicy

from .adapters import (
    PIPELINE_VERSION,
    PpmBrainSourceDeleted,
    PpmBrainSourceError,
    PpmBrainSourceExcluded,
    SourceDocument,
    SourcePart,
    load_source,
    load_source_metadata,
)
from .embeddings import PpmEmbeddingProviderError, get_embedding_provider
from .models import (
    ACTIVE_JOB_STATUSES,
    PpmIndexJob,
    PpmIndexJobStatus,
    PpmKnowledgeChunk,
    PpmKnowledgeIndexState,
    PpmKnowledgeSource,
    PpmKnowledgeSourceType,
)


CHUNK_TARGET_TOKENS = 800
CHUNK_OVERLAP_TOKENS = 100
MAX_QUERY_LENGTH = 500
GRAPH_NEIGHBOR_RANK_BONUS = 0.12


class PpmBrainConflict(Exception):
    def __init__(self, *, code, message, details=None):
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


@dataclass(frozen=True)
class ChunkDraft:
    text: str
    token_count: int
    locator: dict
    content_hash: str


def estimate_tokens(text):
    return max(1, math.ceil(len(text) / 4))


def _split_part(part: SourcePart):
    words = part.text.split()
    if not words:
        return []
    target_words = CHUNK_TARGET_TOKENS * 3
    overlap_words = CHUNK_OVERLAP_TOKENS * 3
    if len(words) <= target_words:
        text = " ".join(words)
        return [
            ChunkDraft(
                text=text,
                token_count=estimate_tokens(text),
                locator=dict(part.locator),
                content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            )
        ]
    chunks = []
    start = 0
    while start < len(words):
        end = min(len(words), start + target_words)
        text = " ".join(words[start:end])
        locator = {**part.locator, "word_start": start, "word_end": end}
        chunks.append(
            ChunkDraft(
                text=text,
                token_count=estimate_tokens(text),
                locator=locator,
                content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            )
        )
        if end == len(words):
            break
        start = max(start + 1, end - overlap_words)
    return chunks


def chunk_document(document: SourceDocument):
    chunks = []
    for part in document.parts:
        chunks.extend(_split_part(part))
    if not chunks:
        raise PpmBrainSourceError(code="SOURCE_TEXT_EMPTY", message="В источнике нет текста для индексации.")
    return chunks


def _source_defaults(document):
    return {
        "source_version": document.source_version,
        "title": document.title,
        "index_state": PpmKnowledgeIndexState.PENDING,
        "error_code": "",
        "error_message": "",
        "excluded_at": None,
    }


def request_source_index(*, workspace_id, project_id, source_type, source_id, requested_by=None, dispatch=False):
    try:
        document = load_source_metadata(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
        )
    except PpmBrainSourceExcluded as exc:
        source = exclude_source(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            deleted=False,
            code=exc.code,
        )
        return source, None
    except PpmBrainSourceDeleted as exc:
        source = exclude_source(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            deleted=True,
            code=exc.code,
        )
        return source, None

    with transaction.atomic():
        source, created = PpmKnowledgeSource.objects.select_for_update().get_or_create(
            project_id=project_id,
            source_type=source_type,
            source_id=str(source_id),
            defaults={"workspace_id": workspace_id, **_source_defaults(document)},
        )
        if source.workspace_id != workspace_id:
            raise PpmBrainConflict(code="BRAIN_SCOPE_MISMATCH", message="Источник относится к другому пространству.")
        already_ready = (
            not created
            and source.source_version == document.source_version
            and source.pipeline_version == PIPELINE_VERSION
            and source.index_state == PpmKnowledgeIndexState.READY
        )
        if already_ready:
            return source, None
        same_version = source.source_version == document.source_version
        source.source_version = document.source_version
        source.title = document.title
        if created:
            source.index_state = PpmKnowledgeIndexState.PENDING
        elif not same_version or source.index_state in {
            PpmKnowledgeIndexState.EXCLUDED,
            PpmKnowledgeIndexState.DELETED,
        }:
            source.index_state = PpmKnowledgeIndexState.STALE
        source.error_code = ""
        source.error_message = ""
        source.excluded_at = None
        source.save(
            update_fields=[
                "source_version",
                "title",
                "index_state",
                "error_code",
                "error_message",
                "excluded_at",
                "updated_at",
            ]
        )
        try:
            job, _ = PpmIndexJob.objects.get_or_create(
                source=source,
                requested_version=document.source_version,
                pipeline_version=PIPELINE_VERSION,
                status__in=ACTIVE_JOB_STATUSES,
                defaults={
                    "workspace_id": workspace_id,
                    "project_id": project_id,
                    "requested_by": requested_by,
                    "available_at": timezone.now(),
                },
            )
        except IntegrityError:
            job = PpmIndexJob.objects.filter(
                source=source,
                requested_version=document.source_version,
                pipeline_version=PIPELINE_VERSION,
                status__in=ACTIVE_JOB_STATUSES,
            ).first()
        if dispatch and job is not None:
            transaction.on_commit(lambda: _dispatch_job(job.id))
        return source, job


def _dispatch_job(job_id):
    from .tasks import process_brain_index_job_task

    process_brain_index_job_task.delay(str(job_id))


def exclude_source(*, workspace_id, project_id, source_type, source_id, deleted=False, code="SOURCE_EXCLUDED"):
    state = PpmKnowledgeIndexState.DELETED if deleted else PpmKnowledgeIndexState.EXCLUDED
    with transaction.atomic():
        source, _ = PpmKnowledgeSource.objects.select_for_update().get_or_create(
            project_id=project_id,
            source_type=source_type,
            source_id=str(source_id),
            defaults={
                "workspace_id": workspace_id,
                "title": "",
                "index_state": state,
                "error_code": code,
                "excluded_at": timezone.now(),
            },
        )
        if source.workspace_id != workspace_id:
            raise PpmBrainConflict(code="BRAIN_SCOPE_MISMATCH", message="Источник относится к другому пространству.")
        source.index_state = state
        source.error_code = code
        source.error_message = ""
        source.excluded_at = timezone.now()
        source.save(update_fields=["index_state", "error_code", "error_message", "excluded_at", "updated_at"])
        source.chunks.filter(is_published=True).update(is_published=False)
        source.index_jobs.filter(status__in=ACTIVE_JOB_STATUSES).update(
            status=PpmIndexJobStatus.SUPERSEDED,
            finished_at=timezone.now(),
            lease_owner="",
            lease_expires_at=None,
        )
    return source


def _claim_job(job_id, *, worker_id):
    now = timezone.now()
    with transaction.atomic():
        job = PpmIndexJob.objects.select_for_update().select_related("source").filter(id=job_id).first()
        if job is None:
            raise PpmBrainConflict(code="BRAIN_JOB_NOT_FOUND", message="Задание индексации не найдено.")
        if job.status not in ACTIVE_JOB_STATUSES:
            return job, False
        if job.status == PpmIndexJobStatus.RUNNING and job.lease_expires_at and job.lease_expires_at > now:
            return job, False
        job.status = PpmIndexJobStatus.RUNNING
        job.attempts += 1
        job.lease_owner = worker_id
        job.lease_expires_at = now + timedelta(minutes=5)
        job.started_at = job.started_at or now
        job.error_code = ""
        job.error_message = ""
        job.save(
            update_fields=[
                "status",
                "attempts",
                "lease_owner",
                "lease_expires_at",
                "started_at",
                "error_code",
                "error_message",
                "updated_at",
            ]
        )
        if job.source.index_state not in {PpmKnowledgeIndexState.EXCLUDED, PpmKnowledgeIndexState.DELETED}:
            job.source.index_state = PpmKnowledgeIndexState.INDEXING
            job.source.save(update_fields=["index_state", "updated_at"])
        return job, True


def _record_job_failure(job_id, error):
    now = timezone.now()
    with transaction.atomic():
        job = PpmIndexJob.objects.select_for_update().select_related("source").get(id=job_id)
        retry = bool(error.retryable and job.attempts < job.max_attempts)
        job.status = PpmIndexJobStatus.RETRY if retry else PpmIndexJobStatus.DEAD
        job.available_at = now + timedelta(seconds=min(30 * (2**job.attempts), 3600)) if retry else None
        job.error_code = error.code
        job.error_message = error.message[:500]
        job.lease_owner = ""
        job.lease_expires_at = None
        job.finished_at = None if retry else now
        job.save(
            update_fields=[
                "status",
                "available_at",
                "error_code",
                "error_message",
                "lease_owner",
                "lease_expires_at",
                "finished_at",
                "updated_at",
            ]
        )
        job.source.index_state = PpmKnowledgeIndexState.STALE if retry else PpmKnowledgeIndexState.FAILED
        job.source.error_code = error.code
        job.source.error_message = error.message[:500]
        job.source.save(update_fields=["index_state", "error_code", "error_message", "updated_at"])
        return job


def process_index_job(job_id, *, worker_id=None):
    worker_id = worker_id or f"worker:{uuid.uuid4()}"
    job, claimed = _claim_job(job_id, worker_id=worker_id)
    if not claimed:
        return job
    try:
        document = load_source(
            workspace_id=job.workspace_id,
            project_id=job.project_id,
            source_type=job.source.source_type,
            source_id=job.source.source_id,
        )
        if document.source_version != job.requested_version:
            with transaction.atomic():
                locked_job = PpmIndexJob.objects.select_for_update().get(id=job.id)
                locked_job.status = PpmIndexJobStatus.SUPERSEDED
                locked_job.finished_at = timezone.now()
                locked_job.lease_owner = ""
                locked_job.lease_expires_at = None
                locked_job.save(
                    update_fields=["status", "finished_at", "lease_owner", "lease_expires_at", "updated_at"]
                )
            request_source_index(
                workspace_id=job.workspace_id,
                project_id=job.project_id,
                source_type=job.source.source_type,
                source_id=job.source.source_id,
                dispatch=True,
            )
            return locked_job
        drafts = chunk_document(document)
        embedding_vectors = [None for _ in drafts]
        embedding_model = ""
        embedding_error_code = ""
        try:
            embedding_provider = get_embedding_provider()
            if embedding_provider.enabled:
                embedding_vectors = embedding_provider.embed_documents([draft.text for draft in drafts])
                if len(embedding_vectors) != len(drafts):
                    raise PpmEmbeddingProviderError(
                        code="EMBEDDING_PROVIDER_INVALID_RESPONSE",
                        message="Провайдер смыслового поиска вернул неполный результат.",
                    )
                embedding_model = embedding_provider.model
        except PpmEmbeddingProviderError as exc:
            embedding_error_code = exc.code
        with transaction.atomic():
            locked_job = PpmIndexJob.objects.select_for_update().select_related("source").get(id=job.id)
            source = PpmKnowledgeSource.objects.select_for_update().get(id=locked_job.source_id)
            if source.index_state in {PpmKnowledgeIndexState.EXCLUDED, PpmKnowledgeIndexState.DELETED}:
                locked_job.status = PpmIndexJobStatus.SUPERSEDED
                locked_job.finished_at = timezone.now()
                locked_job.lease_owner = ""
                locked_job.lease_expires_at = None
                locked_job.save(
                    update_fields=["status", "finished_at", "lease_owner", "lease_expires_at", "updated_at"]
                )
                return locked_job
            PpmKnowledgeChunk.objects.bulk_create(
                [
                    PpmKnowledgeChunk(
                        workspace_id=job.workspace_id,
                        project_id=job.project_id,
                        source=source,
                        source_version=document.source_version,
                        pipeline_version=PIPELINE_VERSION,
                        ordinal=ordinal,
                        text=draft.text,
                        token_count=draft.token_count,
                        locator_json=draft.locator,
                        content_hash=draft.content_hash,
                        embedding_json=embedding_vectors[ordinal],
                        embedding_model=embedding_model if embedding_vectors[ordinal] is not None else "",
                        embedding_version=PIPELINE_VERSION if embedding_vectors[ordinal] is not None else "",
                    )
                    for ordinal, draft in enumerate(drafts)
                ],
                ignore_conflicts=True,
            )
            candidate_chunks = source.chunks.filter(
                source_version=document.source_version,
                pipeline_version=PIPELINE_VERSION,
            )
            candidate_chunks.update(
                search_document=SearchVector("text", config="russian", weight="A")
                + SearchVector("text", config="simple", weight="B")
            )
            if embedding_model:
                for ordinal, (draft, vector) in enumerate(zip(drafts, embedding_vectors, strict=True)):
                    candidate_chunks.filter(ordinal=ordinal, content_hash=draft.content_hash).update(
                        embedding_json=vector,
                        embedding_model=embedding_model,
                        embedding_version=PIPELINE_VERSION,
                    )
            source.chunks.exclude(
                source_version=document.source_version,
                pipeline_version=PIPELINE_VERSION,
            ).update(is_published=False)
            candidate_chunks.update(is_published=True)
            source.source_version = document.source_version
            source.title = document.title
            source.pipeline_version = PIPELINE_VERSION
            source.index_state = PpmKnowledgeIndexState.READY
            source.last_indexed_at = timezone.now()
            source.error_code = ""
            source.error_message = ""
            source.embedding_model = embedding_model
            source.embedding_error_code = embedding_error_code
            source.excluded_at = None
            source.save(
                update_fields=[
                    "source_version",
                    "title",
                    "pipeline_version",
                    "index_state",
                    "last_indexed_at",
                    "error_code",
                    "error_message",
                    "embedding_model",
                    "embedding_error_code",
                    "excluded_at",
                    "updated_at",
                ]
            )
            locked_job.status = PpmIndexJobStatus.READY
            locked_job.finished_at = timezone.now()
            locked_job.lease_owner = ""
            locked_job.lease_expires_at = None
            locked_job.error_code = ""
            locked_job.error_message = ""
            locked_job.save(
                update_fields=[
                    "status",
                    "finished_at",
                    "lease_owner",
                    "lease_expires_at",
                    "error_code",
                    "error_message",
                    "updated_at",
                ]
            )
            return locked_job
    except PpmBrainSourceExcluded as exc:
        exclude_source(
            workspace_id=job.workspace_id,
            project_id=job.project_id,
            source_type=job.source.source_type,
            source_id=job.source.source_id,
            code=exc.code,
        )
        return PpmIndexJob.objects.get(id=job.id)
    except PpmBrainSourceDeleted as exc:
        exclude_source(
            workspace_id=job.workspace_id,
            project_id=job.project_id,
            source_type=job.source.source_type,
            source_id=job.source.source_id,
            deleted=True,
            code=exc.code,
        )
        return PpmIndexJob.objects.get(id=job.id)
    except PpmBrainSourceError as exc:
        return _record_job_failure(job.id, exc)


def _validated_query(query, top_k):
    query = " ".join(str(query or "").strip().split())
    if not query or len(query) > MAX_QUERY_LENGTH:
        raise PpmBrainConflict(code="BRAIN_INVALID_QUERY", message="Введите запрос длиной до 500 символов.")
    try:
        top_k = max(1, min(int(top_k), 50))
    except (TypeError, ValueError) as exc:
        raise PpmBrainConflict(code="BRAIN_INVALID_TOP_K", message="Некорректное число результатов.") from exc
    return query, top_k


def _retrieval_scope(*, workspace_id, project_id, source_types, source_keys=None):
    sources = PpmKnowledgeSource.objects.filter(
        workspace_id=workspace_id,
        project_id=project_id,
        index_state=PpmKnowledgeIndexState.READY,
    )
    if source_types:
        allowed_types = set(PpmKnowledgeSourceType.values)
        requested_types = {value for value in source_types if value in allowed_types}
        if not requested_types:
            return PpmKnowledgeChunk.objects.none()
        sources = sources.filter(source_type__in=requested_types)
    if source_keys is not None:
        source_filter = Q()
        for source_type, source_id in source_keys:
            if source_type in PpmKnowledgeSourceType.values:
                source_filter |= Q(source_type=source_type, source_id=str(source_id))
        if not source_filter:
            return PpmKnowledgeChunk.objects.none()
        sources = sources.filter(source_filter)
    return PpmKnowledgeChunk.objects.filter(
        workspace_id=workspace_id,
        project_id=project_id,
        source__in=sources,
        is_published=True,
    ).select_related("source")


def _keyword_results(chunks, query, limit):
    search_query = SearchQuery(query, config="russian", search_type="websearch") | SearchQuery(
        query,
        config="simple",
        search_type="websearch",
    )
    exact_terms = [term for term in re.findall(r"[\w.-]+", query, flags=re.UNICODE) if len(term) >= 2][:8]
    exact_filter = Q()
    for term in exact_terms:
        exact_filter |= Q(text__icontains=term)
    return list(
        chunks.annotate(rank=SearchRank(F("search_document"), search_query))
        .filter(Q(search_document=search_query) | exact_filter)
        .order_by("-rank", "source_id", "ordinal")[:limit]
    )


def _cosine_similarity(left, right):
    if not left or not right or len(left) != len(right):
        return 0.0
    numerator = sum(float(a) * float(b) for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(float(value) ** 2 for value in left))
    right_norm = math.sqrt(sum(float(value) ** 2 for value in right))
    return numerator / (left_norm * right_norm) if left_norm and right_norm else 0.0


def _serialize_chunk(chunk):
    payload = {
        "chunk_id": str(chunk.id),
        "source_type": chunk.source.source_type,
        "source_id": chunk.source.source_id,
        "source_version": chunk.source_version,
        "title": chunk.source.title,
        "locator": chunk.locator_json,
        "excerpt": chunk.text[:1200],
        "score": round(float(getattr(chunk, "retrieval_score", getattr(chunk, "rank", 0)) or 0), 6),
    }
    graph_path = getattr(chunk, "graph_path", None)
    if graph_path is not None:
        payload["graph_path"] = graph_path
        payload["graph_rank_bonus"] = round(float(getattr(chunk, "graph_rank_bonus", 0) or 0), 6)
    return payload


def _graph_rank_bonus(path):
    depth = len(path)
    return 0.0 if depth == 0 else GRAPH_NEIGHBOR_RANK_BONUS / depth


def _apply_graph_ranking(chunks, graph_paths_by_source):
    if not graph_paths_by_source:
        return chunks
    for chunk in chunks:
        source_key = (chunk.source.source_type, chunk.source.source_id)
        path = graph_paths_by_source.get(source_key)
        chunk.graph_path = path
        chunk.graph_rank_bonus = _graph_rank_bonus(path) if path is not None else 0.0
        chunk.retrieval_score = float(getattr(chunk, "retrieval_score", getattr(chunk, "rank", 0)) or 0)
        chunk.retrieval_score += chunk.graph_rank_bonus
    return sorted(
        chunks,
        key=lambda chunk: (-chunk.retrieval_score, str(chunk.source_id), chunk.ordinal),
    )


def retrieve_chunks_with_metadata(
    *,
    workspace_id,
    project_id,
    query,
    top_k=12,
    source_types=None,
    source_keys=None,
    graph_paths_by_source=None,
    graph_scope=None,
):
    query, top_k = _validated_query(query, top_k)
    scoped_chunks = _retrieval_scope(
        workspace_id=workspace_id,
        project_id=project_id,
        source_types=source_types,
        source_keys=source_keys,
    )
    keyword_chunks = _keyword_results(scoped_chunks, query, max(50, top_k * 4))
    provider_name = None
    vector_chunks = []
    embedding_error_code = ""
    try:
        provider = get_embedding_provider()
        if provider.enabled:
            provider_name = provider.name
            query_vector = provider.embed_query(query)
            candidates = list(scoped_chunks.exclude(embedding_json__isnull=True)[:2000])
            vector_chunks = sorted(
                candidates,
                key=lambda chunk: _cosine_similarity(query_vector, chunk.embedding_json),
                reverse=True,
            )[: max(50, top_k * 4)]
    except PpmEmbeddingProviderError as exc:
        embedding_error_code = exc.code

    if vector_chunks:
        by_id = {str(chunk.id): chunk for chunk in [*keyword_chunks, *vector_chunks]}
        fused = {}
        for rank, chunk in enumerate(keyword_chunks, start=1):
            fused[str(chunk.id)] = fused.get(str(chunk.id), 0.0) + 1 / (60 + rank)
        for rank, chunk in enumerate(vector_chunks, start=1):
            fused[str(chunk.id)] = fused.get(str(chunk.id), 0.0) + 1 / (60 + rank)
        ordered_ids = sorted(fused, key=fused.get, reverse=True)
        selected = []
        for chunk_id in ordered_ids:
            chunk = by_id[chunk_id]
            chunk.retrieval_score = fused[chunk_id]
            selected.append(chunk)
        selected = _apply_graph_ranking(selected, graph_paths_by_source)[:top_k]
        mode = "hybrid"
        degraded = False
    else:
        selected = _apply_graph_ranking(keyword_chunks, graph_paths_by_source)[:top_k]
        mode = "keyword"
        degraded = True

    metadata = {
        "mode": mode,
        "degraded": degraded,
        "embedding_provider": provider_name,
        "reason": embedding_error_code or ("embeddings_not_configured" if degraded else ""),
    }
    if graph_scope is not None:
        metadata["graph"] = {
            **graph_scope,
            "rank_bonus": GRAPH_NEIGHBOR_RANK_BONUS,
        }
    return [_serialize_chunk(chunk) for chunk in selected], metadata


def retrieve_chunks(
    *,
    workspace_id,
    project_id,
    query,
    top_k=12,
    source_types=None,
    source_keys=None,
    graph_paths_by_source=None,
    graph_scope=None,
):
    results, _ = retrieve_chunks_with_metadata(
        workspace_id=workspace_id,
        project_id=project_id,
        query=query,
        top_k=top_k,
        source_types=source_types,
        source_keys=source_keys,
        graph_paths_by_source=graph_paths_by_source,
        graph_scope=graph_scope,
    )
    return results


def reconcile_project(*, workspace_id, project_id, requested_by=None, dispatch=False):
    expected = set()
    for issue_id in Issue.objects.filter(
        workspace_id=workspace_id,
        project_id=project_id,
        deleted_at__isnull=True,
        is_draft=False,
    ).values_list("id", flat=True):
        expected.add((PpmKnowledgeSourceType.WORK_ITEM, str(issue_id)))
    for entry_id in (
        PpmVaultEntry.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmVaultEntryStatus.ACTIVE,
            kind__in=[PpmVaultEntryKind.MARKDOWN, PpmVaultEntryKind.PDF],
        )
        .exclude(index_policy=PpmVaultIndexPolicy.EXCLUDE)
        .values_list("id", flat=True)
    ):
        expected.add((PpmKnowledgeSourceType.VAULT_FILE, str(entry_id)))
    for code_file_id in PpmGitCodeFile.objects.filter(
        workspace_id=workspace_id,
        project_id=project_id,
        snapshot__is_current=True,
        snapshot__status=PpmGitCodeSnapshotStatus.READY,
        repository__code_index_policy__enabled=True,
    ).values_list("id", flat=True):
        expected.add((PpmKnowledgeSourceType.GIT_CODE, str(code_file_id)))

    jobs = []
    for source_type, source_id in sorted(expected):
        _, job = request_source_index(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            requested_by=requested_by,
            dispatch=dispatch,
        )
        if job is not None:
            jobs.append(job)
    work_item_ids = [source_id for source_type, source_id in expected if source_type == "work_item"]
    vault_file_ids = [source_id for source_type, source_id in expected if source_type == "vault_file"]
    git_code_ids = [source_id for source_type, source_id in expected if source_type == "git_code"]
    stale_sources = PpmKnowledgeSource.objects.filter(workspace_id=workspace_id, project_id=project_id).exclude(
        Q(source_type=PpmKnowledgeSourceType.WORK_ITEM, source_id__in=work_item_ids)
        | Q(source_type=PpmKnowledgeSourceType.VAULT_FILE, source_id__in=vault_file_ids)
        | Q(source_type=PpmKnowledgeSourceType.GIT_CODE, source_id__in=git_code_ids)
    )
    for source in stale_sources:
        exclude_source(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source.source_type,
            source_id=source.source_id,
            deleted=True,
            code="SOURCE_RECONCILED_MISSING",
        )
    return jobs
