import uuid

from django.contrib.postgres.search import SearchVectorField
from django.db import models


class PpmKnowledgeSourceType(models.TextChoices):
    WORK_ITEM = "work_item", "Work item"
    VAULT_FILE = "vault_file", "Vault file"
    GIT_CODE = "git_code", "Git code"


class PpmKnowledgeIndexState(models.TextChoices):
    PENDING = "pending", "Pending"
    INDEXING = "indexing", "Indexing"
    READY = "ready", "Ready"
    STALE = "stale", "Stale"
    FAILED = "failed", "Failed"
    EXCLUDED = "excluded", "Excluded"
    DELETED = "deleted", "Deleted"


class PpmIndexJobStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    RUNNING = "running", "Running"
    RETRY = "retry", "Retry"
    READY = "ready", "Ready"
    SUPERSEDED = "superseded", "Superseded"
    DEAD = "dead", "Dead"


ACTIVE_JOB_STATUSES = [PpmIndexJobStatus.PENDING, PpmIndexJobStatus.RUNNING, PpmIndexJobStatus.RETRY]


class PpmAnswerRunStatus(models.TextChoices):
    QUEUED = "queued", "Queued"
    RETRIEVING = "retrieving", "Retrieving"
    COMPLETING = "completing", "Completing"
    COMPLETED = "completed", "Completed"
    DEGRADED = "degraded", "Degraded"
    NO_SOURCES = "no_sources", "No sources"
    CANCELLED = "cancelled", "Cancelled"
    FAILED = "failed", "Failed"


class PpmProjectMemoryKind(models.TextChoices):
    DECISION = "decision", "Decision"
    DAILY_SUMMARY = "daily_summary", "Daily summary"
    WEEKLY_SUMMARY = "weekly_summary", "Weekly summary"
    RELEASE_SUMMARY = "release_summary", "Release summary"


class PpmProjectMemoryOrigin(models.TextChoices):
    USER = "user", "User"
    AGENT = "agent", "Agent"


class PpmProjectMemoryConfirmationStatus(models.TextChoices):
    PROPOSED = "proposed", "Proposed"
    CONFIRMED = "confirmed", "Confirmed"
    REJECTED = "rejected", "Rejected"


class PpmProjectMemoryFreshness(models.TextChoices):
    CURRENT = "current", "Current"
    POSSIBLY_STALE = "possibly_stale", "Possibly stale"


class PpmAgentKind(models.TextChoices):
    PROJECT_REPORTER = "project_reporter", "Project reporter"
    WORK_DECOMPOSER = "work_decomposer", "Work decomposer"
    KNOWLEDGE_LIBRARIAN = "knowledge_librarian", "Knowledge librarian"
    RELATIONSHIP_ANALYST = "relationship_analyst", "Relationship analyst"


class PpmAgentRunStatus(models.TextChoices):
    QUEUED = "queued", "Queued"
    RUNNING = "running", "Running"
    AWAITING_APPROVAL = "awaiting_approval", "Awaiting approval"
    APPLYING = "applying", "Applying"
    COMPLETED = "completed", "Completed"
    FAILED = "failed", "Failed"
    TIMED_OUT = "timed_out", "Timed out"
    CANCELLED = "cancelled", "Cancelled"
    REJECTED = "rejected", "Rejected"


class PpmAgentActionKind(models.TextChoices):
    CREATE_WORK_ITEMS = "create_work_items", "Create work items"
    APPLY_SEMANTIC_EDGES = "apply_semantic_edges", "Apply semantic edges"
    WRITE_VAULT_FILE = "write_vault_file", "Write Vault file"
    CREATE_GIT_BRANCH = "create_git_branch", "Create Git branch"
    CREATE_PULL_REQUEST = "create_pull_request", "Create pull request"


class PpmAgentActionStatus(models.TextChoices):
    PROPOSED = "proposed", "Proposed"
    APPROVED = "approved", "Approved"
    REJECTED = "rejected", "Rejected"
    APPLYING = "applying", "Applying"
    APPLIED = "applied", "Applied"
    CONFLICT = "conflict", "Conflict"
    FAILED = "failed", "Failed"
    CANCELLED = "cancelled", "Cancelled"


TERMINAL_ANSWER_RUN_STATUSES = [
    PpmAnswerRunStatus.COMPLETED,
    PpmAnswerRunStatus.DEGRADED,
    PpmAnswerRunStatus.NO_SOURCES,
    PpmAnswerRunStatus.CANCELLED,
    PpmAnswerRunStatus.FAILED,
]


class PpmKnowledgeSource(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    source_type = models.CharField(max_length=32, choices=PpmKnowledgeSourceType.choices)
    source_id = models.CharField(max_length=255)
    source_version = models.CharField(max_length=255, blank=True, default="")
    title = models.CharField(max_length=500, blank=True, default="")
    index_state = models.CharField(
        max_length=16,
        choices=PpmKnowledgeIndexState.choices,
        default=PpmKnowledgeIndexState.PENDING,
    )
    pipeline_version = models.CharField(max_length=64, blank=True, default="")
    last_indexed_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=500, blank=True, default="")
    embedding_model = models.CharField(max_length=128, blank=True, default="")
    embedding_error_code = models.CharField(max_length=64, blank=True, default="")
    excluded_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_knowledge_sources"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "source_type", "source_id"],
                name="ppm_brain_source_scope_uniq",
            )
        ]
        indexes = [
            models.Index(
                fields=["workspace_id", "project_id", "index_state"],
                name="ppm_brain_source_scope_idx",
            ),
            models.Index(fields=["project_id", "source_type", "source_id"], name="ppm_brain_source_lookup_idx"),
        ]
        ordering = ("source_type", "title", "id")


class PpmKnowledgeChunk(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    source = models.ForeignKey(PpmKnowledgeSource, on_delete=models.CASCADE, related_name="chunks")
    source_version = models.CharField(max_length=255)
    pipeline_version = models.CharField(max_length=64)
    ordinal = models.PositiveIntegerField()
    text = models.TextField()
    token_count = models.PositiveIntegerField()
    locator_json = models.JSONField(default=dict)
    content_hash = models.CharField(max_length=64)
    search_document = SearchVectorField(null=True)
    embedding_json = models.JSONField(null=True, blank=True)
    embedding_model = models.CharField(max_length=128, blank=True, default="")
    embedding_version = models.CharField(max_length=64, blank=True, default="")
    is_published = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_knowledge_chunks"
        constraints = [
            models.UniqueConstraint(
                fields=["source", "source_version", "pipeline_version", "ordinal", "content_hash"],
                name="ppm_brain_chunk_version_uniq",
            )
        ]
        indexes = [
            models.Index(
                fields=["workspace_id", "project_id", "is_published"],
                name="ppm_brain_chunk_scope_idx",
            ),
            models.Index(fields=["source", "is_published", "ordinal"], name="ppm_brain_chunk_source_idx"),
        ]
        ordering = ("source_id", "ordinal", "id")


class PpmIndexJob(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    source = models.ForeignKey(PpmKnowledgeSource, on_delete=models.CASCADE, related_name="index_jobs")
    requested_version = models.CharField(max_length=255)
    pipeline_version = models.CharField(max_length=64)
    status = models.CharField(
        max_length=16,
        choices=PpmIndexJobStatus.choices,
        default=PpmIndexJobStatus.PENDING,
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=5)
    lease_owner = models.CharField(max_length=128, blank=True, default="")
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    available_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=500, blank=True, default="")
    requested_by = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_index_jobs"
        constraints = [
            models.UniqueConstraint(
                fields=["source", "requested_version", "pipeline_version"],
                condition=models.Q(status__in=ACTIVE_JOB_STATUSES),
                name="ppm_brain_job_active_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["status", "available_at", "lease_expires_at"], name="ppm_brain_job_queue_idx"),
            models.Index(fields=["workspace_id", "project_id", "-created_at"], name="ppm_brain_job_scope_idx"),
        ]
        ordering = ("-created_at", "id")


class PpmAnswerRun(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    created_by = models.UUIDField(db_index=True)
    client_operation_id = models.UUIDField()
    board_id = models.UUIDField(null=True, blank=True)
    query = models.TextField()
    selected_shape_ids = models.JSONField(default=list)
    graph_depth = models.PositiveSmallIntegerField(default=1)
    scope_json = models.JSONField(default=dict)
    status = models.CharField(
        max_length=16,
        choices=PpmAnswerRunStatus.choices,
        default=PpmAnswerRunStatus.QUEUED,
    )
    provider = models.CharField(max_length=64, blank=True, default="")
    model = models.CharField(max_length=128, blank=True, default="")
    answer_text = models.TextField(blank=True, default="")
    citations_json = models.JSONField(default=list)
    retrieved_chunks_json = models.JSONField(default=list)
    retrieval_json = models.JSONField(default=dict)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=500, blank=True, default="")
    cancel_requested_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_answer_runs"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "created_by", "client_operation_id"],
                name="ppm_answer_run_operation_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "-created_at"], name="ppm_answer_run_scope_idx"),
            models.Index(fields=["created_by", "status", "-created_at"], name="ppm_answer_run_actor_idx"),
        ]
        ordering = ("-created_at", "id")


class PpmProjectMemoryRecord(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    kind = models.CharField(max_length=32, choices=PpmProjectMemoryKind.choices)
    title = models.CharField(max_length=255)
    body = models.TextField()
    origin = models.CharField(
        max_length=16,
        choices=PpmProjectMemoryOrigin.choices,
        default=PpmProjectMemoryOrigin.USER,
    )
    confirmation_status = models.CharField(
        max_length=16,
        choices=PpmProjectMemoryConfirmationStatus.choices,
        default=PpmProjectMemoryConfirmationStatus.CONFIRMED,
    )
    freshness_status = models.CharField(
        max_length=24,
        choices=PpmProjectMemoryFreshness.choices,
        default=PpmProjectMemoryFreshness.CURRENT,
    )
    content_hash = models.CharField(max_length=64)
    client_operation_id = models.UUIDField()
    created_by = models.UUIDField(db_index=True)
    confirmed_by = models.UUIDField(null=True, blank=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_project_memory_records"
        indexes = [
            models.Index(
                fields=["workspace_id", "project_id", "confirmation_status", "-created_at"],
                name="ppm_memory_scope_idx",
            ),
            models.Index(fields=["project_id", "freshness_status", "-created_at"], name="ppm_memory_fresh_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "created_by", "client_operation_id"],
                name="ppm_memory_operation_uniq",
            )
        ]
        ordering = ("-created_at", "id")


class PpmProjectMemorySourceReference(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    memory_record = models.ForeignKey(
        PpmProjectMemoryRecord,
        on_delete=models.CASCADE,
        related_name="source_references",
    )
    knowledge_source = models.ForeignKey(
        PpmKnowledgeSource,
        on_delete=models.PROTECT,
        related_name="memory_references",
    )
    source_type = models.CharField(max_length=32, choices=PpmKnowledgeSourceType.choices)
    source_id = models.CharField(max_length=255)
    source_version = models.CharField(max_length=255)
    locator_json = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_project_memory_source_refs"
        constraints = [
            models.UniqueConstraint(
                fields=["memory_record", "source_type", "source_id"],
                name="ppm_memory_source_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "source_type"], name="ppm_memory_ref_scope_idx"),
            models.Index(fields=["knowledge_source", "source_version"], name="ppm_memory_ref_version_idx"),
        ]
        ordering = ("created_at", "id")


class PpmAgentRun(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    created_by = models.UUIDField(db_index=True)
    client_operation_id = models.UUIDField()
    agent_kind = models.CharField(max_length=32, choices=PpmAgentKind.choices)
    status = models.CharField(
        max_length=24,
        choices=PpmAgentRunStatus.choices,
        default=PpmAgentRunStatus.QUEUED,
    )
    input_hash = models.CharField(max_length=64)
    input_json = models.JSONField(default=dict)
    context_json = models.JSONField(default=dict)
    capabilities_json = models.JSONField(default=list)
    policy_version = models.CharField(max_length=64, default="ppm-agents-v1")
    prompt_template_version = models.CharField(max_length=64, blank=True, default="")
    provider = models.CharField(max_length=64, blank=True, default="")
    model = models.CharField(max_length=128, blank=True, default="")
    result_json = models.JSONField(default=dict)
    token_usage_json = models.JSONField(default=dict)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=500, blank=True, default="")
    cancel_requested_at = models.DateTimeField(null=True, blank=True)
    lease_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    worker_task_id = models.CharField(max_length=255, blank=True, default="")
    attempt_count = models.PositiveSmallIntegerField(default=0)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_agent_runs"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "created_by", "client_operation_id"],
                name="ppm_agent_run_operation_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "-created_at"], name="ppm_agent_run_scope_idx"),
            models.Index(fields=["created_by", "status", "-created_at"], name="ppm_agent_run_actor_idx"),
            models.Index(fields=["status", "lease_expires_at"], name="ppm_agent_run_lease_idx"),
        ]
        ordering = ("-created_at", "id")


class PpmAgentAction(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    run = models.ForeignKey(PpmAgentRun, on_delete=models.CASCADE, related_name="actions")
    sequence = models.PositiveSmallIntegerField()
    action_kind = models.CharField(max_length=32, choices=PpmAgentActionKind.choices)
    proposal_tool = models.CharField(max_length=64)
    status = models.CharField(
        max_length=16,
        choices=PpmAgentActionStatus.choices,
        default=PpmAgentActionStatus.PROPOSED,
    )
    payload_json = models.JSONField(default=dict)
    preview_json = models.JSONField(default=dict)
    preconditions_json = models.JSONField(default=dict)
    idempotency_key = models.UUIDField(default=uuid.uuid4)
    approved_by = models.UUIDField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    rejected_by = models.UUIDField(null=True, blank=True)
    rejected_at = models.DateTimeField(null=True, blank=True)
    applied_at = models.DateTimeField(null=True, blank=True)
    result_json = models.JSONField(default=dict)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_agent_actions"
        constraints = [
            models.UniqueConstraint(fields=["run", "sequence"], name="ppm_agent_action_sequence_uniq"),
            models.UniqueConstraint(
                fields=["project_id", "idempotency_key"],
                name="ppm_agent_action_idempotency_uniq",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_agent_action_scope_idx"),
            models.Index(fields=["run", "status", "sequence"], name="ppm_agent_action_run_idx"),
        ]
        ordering = ("sequence", "id")


class PpmAgentCitation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    run = models.ForeignKey(PpmAgentRun, on_delete=models.CASCADE, related_name="citations")
    action = models.ForeignKey(
        PpmAgentAction,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="citations",
    )
    ordinal = models.PositiveSmallIntegerField()
    source_type = models.CharField(max_length=32, choices=PpmKnowledgeSourceType.choices)
    source_id = models.CharField(max_length=255)
    source_version = models.CharField(max_length=255)
    title = models.CharField(max_length=500, blank=True, default="")
    locator_json = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_agent_citations"
        constraints = [models.UniqueConstraint(fields=["run", "ordinal"], name="ppm_agent_citation_ordinal_uniq")]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "source_type"], name="ppm_agent_citation_scope_idx"),
            models.Index(fields=["run", "action", "ordinal"], name="ppm_agent_citation_run_idx"),
        ]
        ordering = ("ordinal", "id")


class PpmAgentAuditEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    run = models.ForeignKey(PpmAgentRun, on_delete=models.PROTECT, related_name="audit_events")
    action = models.ForeignKey(
        PpmAgentAction,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="audit_events",
    )
    actor_id = models.UUIDField(null=True, blank=True, db_index=True)
    event_type = models.CharField(max_length=64)
    metadata_json = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_agent_audit"
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "-created_at"], name="ppm_agent_audit_scope_idx"),
            models.Index(fields=["run", "-created_at"], name="ppm_agent_audit_run_idx"),
            models.Index(fields=["event_type", "-created_at"], name="ppm_agent_audit_event_idx"),
        ]
        ordering = ("created_at", "id")
