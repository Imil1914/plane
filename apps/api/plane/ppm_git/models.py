import uuid

from django.db import models
from django.utils import timezone


class PpmGitProvider(models.TextChoices):
    GITHUB = "github", "GitHub"
    GITLAB = "gitlab", "GitLab"
    BITBUCKET = "bitbucket", "Bitbucket"
    GITEA = "gitea", "Gitea"
    GENERIC = "generic", "Generic Git"


class PpmGitVisibility(models.TextChoices):
    PUBLIC = "public", "Public"
    PRIVATE = "private", "Private"
    INTERNAL = "internal", "Internal"
    UNKNOWN = "unknown", "Unknown"


class PpmGitRepositoryStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    ARCHIVED = "archived", "Archived"


class PpmGitObjectType(models.TextChoices):
    BRANCH = "branch", "Branch"
    COMMIT = "commit", "Commit"
    PULL_REQUEST = "pull_request", "Pull request"


class PpmGitLinkStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    UNLINKED = "unlinked", "Unlinked"


class PpmGitLinkOrigin(models.TextChoices):
    MANUAL = "manual", "Manual"
    PROVIDER = "provider", "Provider"


class PpmGitInstallationStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    SUSPENDED = "suspended", "Suspended"
    REVOKED = "revoked", "Revoked"


class PpmGitConnectionStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    SYNCING = "syncing", "Syncing"
    RATE_LIMITED = "rate_limited", "Rate limited"
    PERMISSION_DRIFT = "permission_drift", "Permission drift"
    ERROR = "error", "Error"
    SUSPENDED = "suspended", "Suspended"
    DISCONNECTED = "disconnected", "Disconnected"
    REVOKED = "revoked", "Revoked"


class PpmGitDeliveryStatus(models.TextChoices):
    RECEIVED = "received", "Received"
    PROCESSING = "processing", "Processing"
    PROCESSED = "processed", "Processed"
    IGNORED = "ignored", "Ignored"
    FAILED = "failed", "Failed"


class PpmGitCodeSnapshotStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    READY = "ready", "Ready"
    FAILED = "failed", "Failed"
    SUPERSEDED = "superseded", "Superseded"
    REVOKED = "revoked", "Revoked"


class PpmGitWriteActionType(models.TextChoices):
    CREATE_BRANCH_DRAFT_PR = "create_branch_draft_pr", "Create branch and draft pull request"


class PpmGitWriteActionStatus(models.TextChoices):
    PROPOSED = "proposed", "Proposed"
    APPROVED = "approved", "Approved"
    REJECTED = "rejected", "Rejected"
    APPLYING = "applying", "Applying"
    APPLIED = "applied", "Applied"
    CONFLICT = "conflict", "Conflict"
    FAILED = "failed", "Failed"
    CANCELLED = "cancelled", "Cancelled"


class PpmGitRepository(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    name = models.CharField(max_length=160)
    normalized_name = models.CharField(max_length=160)
    provider = models.CharField(max_length=24, choices=PpmGitProvider.choices, default=PpmGitProvider.GENERIC)
    provider_repository_id = models.BigIntegerField(null=True, blank=True)
    provider_full_name = models.CharField(max_length=255, blank=True, default="")
    canonical_url = models.URLField(max_length=2048)
    clone_https = models.URLField(max_length=2048)
    clone_ssh = models.CharField(max_length=2048, blank=True, default="")
    default_branch = models.CharField(max_length=255, blank=True, default="")
    visibility = models.CharField(
        max_length=16,
        choices=PpmGitVisibility.choices,
        default=PpmGitVisibility.UNKNOWN,
    )
    is_default = models.BooleanField(default=False)
    status = models.CharField(
        max_length=16,
        choices=PpmGitRepositoryStatus.choices,
        default=PpmGitRepositoryStatus.ACTIVE,
    )
    created_by = models.UUIDField()
    updated_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_git_repositories"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "canonical_url"],
                condition=models.Q(status=PpmGitRepositoryStatus.ACTIVE),
                name="ppm_git_repo_active_url_uniq",
            ),
            models.UniqueConstraint(
                fields=["project_id"],
                condition=models.Q(status=PpmGitRepositoryStatus.ACTIVE, is_default=True),
                name="ppm_git_repo_default_uniq",
            ),
            models.UniqueConstraint(
                fields=["project_id", "provider", "provider_repository_id"],
                condition=models.Q(
                    status=PpmGitRepositoryStatus.ACTIVE,
                    provider_repository_id__isnull=False,
                ),
                name="ppm_git_repo_provider_uniq",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_repo_scope_idx"),
            models.Index(fields=["project_id", "is_default", "status"], name="ppm_git_repo_default_idx"),
        ]
        ordering = ("-is_default", "normalized_name", "id")


class PpmGitInstallation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    provider = models.CharField(max_length=24, choices=PpmGitProvider.choices, default=PpmGitProvider.GITHUB)
    provider_installation_id = models.BigIntegerField()
    provider_account_id = models.BigIntegerField()
    account_login = models.CharField(max_length=255)
    account_type = models.CharField(max_length=32, blank=True, default="")
    repository_selection = models.CharField(max_length=16, blank=True, default="selected")
    permissions = models.JSONField(default=dict, blank=True)
    events = models.JSONField(default=list, blank=True)
    status = models.CharField(
        max_length=24,
        choices=PpmGitInstallationStatus.choices,
        default=PpmGitInstallationStatus.ACTIVE,
    )
    created_by = models.UUIDField()
    updated_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_git_installations"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "provider", "provider_installation_id"],
                name="ppm_git_install_scope_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["provider", "provider_installation_id", "status"], name="ppm_git_install_ext_idx"),
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_install_ws_idx"),
        ]
        ordering = ("account_login", "id")


class PpmGitConnectState(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    provider = models.CharField(max_length=24, choices=PpmGitProvider.choices, default=PpmGitProvider.GITHUB)
    user_id = models.UUIDField(db_index=True)
    token_hash = models.CharField(max_length=64, unique=True)
    provider_installation_id = models.BigIntegerField(null=True, blank=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_git_connect_states"
        indexes = [
            models.Index(fields=["user_id", "expires_at"], name="ppm_git_connect_user_idx"),
            models.Index(fields=["workspace_id", "project_id", "expires_at"], name="ppm_git_connect_scope_idx"),
        ]


class PpmGitConnection(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    installation = models.ForeignKey(PpmGitInstallation, on_delete=models.PROTECT, related_name="connections")
    repository = models.OneToOneField(PpmGitRepository, on_delete=models.PROTECT, related_name="connection")
    provider_repository_id = models.BigIntegerField()
    provider_full_name = models.CharField(max_length=255)
    permissions = models.JSONField(default=dict, blank=True)
    events = models.JSONField(default=list, blank=True)
    status = models.CharField(
        max_length=24,
        choices=PpmGitConnectionStatus.choices,
        default=PpmGitConnectionStatus.ACTIVE,
    )
    sync_cursor = models.JSONField(default=dict, blank=True)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_event_at = models.DateTimeField(null=True, blank=True)
    last_error_code = models.CharField(max_length=64, blank=True, default="")
    last_error_message = models.CharField(max_length=500, blank=True, default="")
    retry_after = models.DateTimeField(null=True, blank=True)
    created_by = models.UUIDField()
    updated_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    disconnected_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_git_connections"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "installation", "provider_repository_id"],
                name="ppm_git_connection_scope_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_conn_scope_idx"),
            models.Index(fields=["installation", "provider_repository_id", "status"], name="ppm_git_conn_ext_idx"),
        ]
        ordering = ("provider_full_name", "id")


class PpmGitCodeIndexPolicy(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    repository = models.OneToOneField(PpmGitRepository, on_delete=models.PROTECT, related_name="code_index_policy")
    enabled = models.BooleanField(default=False)
    branch = models.CharField(max_length=255, blank=True, default="")
    include_paths = models.JSONField(default=list, blank=True)
    exclude_paths = models.JSONField(default=list, blank=True)
    max_files = models.PositiveIntegerField(default=2000)
    max_file_bytes = models.PositiveIntegerField(default=512 * 1024)
    max_total_bytes = models.PositiveIntegerField(default=50 * 1024 * 1024)
    updated_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_git_code_index_policies"
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "enabled"], name="ppm_git_code_policy_idx"),
        ]


class PpmGitCodeSnapshot(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    repository = models.ForeignKey(PpmGitRepository, on_delete=models.PROTECT, related_name="code_snapshots")
    connection = models.ForeignKey(PpmGitConnection, on_delete=models.PROTECT, related_name="code_snapshots")
    branch = models.CharField(max_length=255)
    commit_sha = models.CharField(max_length=64)
    status = models.CharField(
        max_length=16,
        choices=PpmGitCodeSnapshotStatus.choices,
        default=PpmGitCodeSnapshotStatus.PENDING,
    )
    is_current = models.BooleanField(default=False)
    content_hash = models.CharField(max_length=64, blank=True, default="")
    file_count = models.PositiveIntegerField(default=0)
    total_bytes = models.PositiveBigIntegerField(default=0)
    excluded_stats = models.JSONField(default=dict, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_git_code_snapshots"
        constraints = [
            models.UniqueConstraint(fields=["repository", "commit_sha"], name="ppm_git_code_snapshot_uniq"),
            models.UniqueConstraint(
                fields=["repository"],
                condition=models.Q(is_current=True),
                name="ppm_git_code_current_uniq",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_code_snap_scope_idx"),
            models.Index(fields=["repository", "is_current", "status"], name="ppm_git_code_snap_repo_idx"),
        ]
        ordering = ("-created_at", "id")


class PpmGitCodeFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    repository = models.ForeignKey(PpmGitRepository, on_delete=models.PROTECT, related_name="indexed_code_files")
    snapshot = models.ForeignKey(PpmGitCodeSnapshot, on_delete=models.CASCADE, related_name="files")
    path = models.CharField(max_length=1024)
    language = models.CharField(max_length=64)
    content_text = models.TextField()
    content_hash = models.CharField(max_length=64)
    size_bytes = models.PositiveIntegerField()
    line_count = models.PositiveIntegerField()
    canonical_url = models.URLField(max_length=2048)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_git_code_files"
        constraints = [
            models.UniqueConstraint(fields=["snapshot", "path"], name="ppm_git_code_file_path_uniq"),
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "language"], name="ppm_git_code_file_scope_idx"),
            models.Index(fields=["repository", "path"], name="ppm_git_code_file_repo_idx"),
        ]
        ordering = ("path", "id")


class PpmGitObject(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    connection = models.ForeignKey(PpmGitConnection, on_delete=models.PROTECT, related_name="git_objects")
    repository = models.ForeignKey(PpmGitRepository, on_delete=models.PROTECT, related_name="git_objects")
    object_type = models.CharField(max_length=24, choices=PpmGitObjectType.choices)
    provider_object_id = models.CharField(max_length=255)
    ref = models.CharField(max_length=255, blank=True, default="")
    title = models.CharField(max_length=500)
    canonical_url = models.URLField(max_length=2048)
    state = models.CharField(max_length=32, blank=True, default="")
    is_draft = models.BooleanField(default=False)
    author_name = models.CharField(max_length=255, blank=True, default="")
    author_avatar_url = models.URLField(max_length=2048, blank=True, default="")
    base_ref = models.CharField(max_length=255, blank=True, default="")
    head_ref = models.CharField(max_length=255, blank=True, default="")
    commit_sha = models.CharField(max_length=64, blank=True, default="")
    metadata = models.JSONField(default=dict, blank=True)
    source_version = models.CharField(max_length=255)
    provider_updated_at = models.DateTimeField(null=True, blank=True)
    # AF2.2 S2a: настоящее время слияния PR (GitHub `merged_at`) — `provider_updated_at` сдвигает любая активность.
    provider_merged_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    first_seen_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_git_objects"
        constraints = [
            models.UniqueConstraint(
                fields=["repository", "object_type", "provider_object_id"],
                name="ppm_git_object_provider_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "object_type"], name="ppm_git_object_scope_idx"),
            models.Index(fields=["repository", "object_type", "-provider_updated_at"], name="ppm_git_object_repo_idx"),
            models.Index(fields=["connection", "is_active", "object_type"], name="ppm_git_object_conn_idx"),
        ]
        ordering = ("object_type", "-provider_updated_at", "-last_seen_at", "id")


class PpmGitLink(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    repository = models.ForeignKey(PpmGitRepository, on_delete=models.PROTECT, related_name="links")
    git_object = models.ForeignKey(
        PpmGitObject,
        on_delete=models.PROTECT,
        related_name="work_item_links",
        null=True,
        blank=True,
    )
    work_item = models.ForeignKey("db.Issue", on_delete=models.PROTECT, related_name="ppm_git_links")
    object_type = models.CharField(max_length=24, choices=PpmGitObjectType.choices)
    ref = models.CharField(max_length=255, blank=True, default="")
    title = models.CharField(max_length=255)
    canonical_url = models.URLField(max_length=2048)
    status = models.CharField(max_length=16, choices=PpmGitLinkStatus.choices, default=PpmGitLinkStatus.ACTIVE)
    origin = models.CharField(max_length=16, choices=PpmGitLinkOrigin.choices, default=PpmGitLinkOrigin.MANUAL)
    created_by = models.UUIDField()
    updated_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    unlinked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_git_links"
        constraints = [
            models.UniqueConstraint(
                fields=["repository", "work_item", "object_type", "canonical_url"],
                condition=models.Q(status=PpmGitLinkStatus.ACTIVE),
                name="ppm_git_link_active_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_link_scope_idx"),
            models.Index(fields=["work_item", "status"], name="ppm_git_link_item_idx"),
        ]
        ordering = ("-created_at", "id")

    def unlink(self, *, user_id):
        self.status = PpmGitLinkStatus.UNLINKED
        self.updated_by = user_id
        self.unlinked_at = timezone.now()
        self.save(update_fields=["status", "updated_by", "unlinked_at", "updated_at"])


class PpmGitDelivery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.CharField(max_length=24, choices=PpmGitProvider.choices, default=PpmGitProvider.GITHUB)
    provider_delivery_id = models.CharField(max_length=255)
    event_name = models.CharField(max_length=64)
    action = models.CharField(max_length=64, blank=True, default="")
    provider_installation_id = models.BigIntegerField(null=True, blank=True)
    provider_repository_id = models.BigIntegerField(null=True, blank=True)
    body_sha256 = models.CharField(max_length=64)
    payload = models.JSONField(default=dict, blank=True)
    status = models.CharField(
        max_length=16,
        choices=PpmGitDeliveryStatus.choices,
        default=PpmGitDeliveryStatus.RECEIVED,
    )
    attempts = models.PositiveIntegerField(default=0)
    last_error_code = models.CharField(max_length=64, blank=True, default="")
    last_error_message = models.CharField(max_length=500, blank=True, default="")
    received_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    next_retry_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_git_deliveries"
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "provider_delivery_id"],
                name="ppm_git_delivery_provider_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["provider_installation_id", "received_at"], name="ppm_git_delivery_inst_idx"),
            models.Index(fields=["provider_repository_id", "received_at"], name="ppm_git_delivery_repo_idx"),
            models.Index(fields=["status", "next_retry_at"], name="ppm_git_delivery_retry_idx"),
        ]


class PpmGitAudit(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    actor_id = models.UUIDField(db_index=True)
    action = models.CharField(max_length=64)
    target_type = models.CharField(max_length=32)
    target_id = models.UUIDField(null=True, blank=True)
    request_id = models.UUIDField()
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_git_audit"
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "-created_at"], name="ppm_git_audit_scope_idx"),
            models.Index(fields=["actor_id", "-created_at"], name="ppm_git_audit_actor_idx"),
            models.Index(fields=["action", "-created_at"], name="ppm_git_audit_action_idx"),
        ]


class PpmGitWriteAction(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    repository = models.ForeignKey(PpmGitRepository, on_delete=models.PROTECT, related_name="write_actions")
    connection = models.ForeignKey(PpmGitConnection, on_delete=models.PROTECT, related_name="write_actions")
    work_item = models.ForeignKey("db.Issue", on_delete=models.PROTECT, related_name="ppm_git_write_actions")
    action_type = models.CharField(
        max_length=32,
        choices=PpmGitWriteActionType.choices,
        default=PpmGitWriteActionType.CREATE_BRANCH_DRAFT_PR,
    )
    status = models.CharField(
        max_length=16,
        choices=PpmGitWriteActionStatus.choices,
        default=PpmGitWriteActionStatus.PROPOSED,
    )
    client_operation_id = models.UUIDField()
    request_fingerprint = models.CharField(max_length=64)
    repository_updated_at = models.DateTimeField()
    connection_updated_at = models.DateTimeField()
    work_item_updated_at = models.DateTimeField()
    base_ref = models.CharField(max_length=255)
    head_ref = models.CharField(max_length=255)
    title = models.CharField(max_length=500)
    body = models.TextField(blank=True, default="")
    preview = models.JSONField(default=dict)
    result = models.JSONField(default=dict, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_message = models.CharField(max_length=500, blank=True, default="")
    created_by = models.UUIDField(db_index=True)
    decided_by = models.UUIDField(null=True, blank=True)
    applied_by = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    decided_at = models.DateTimeField(null=True, blank=True)
    applied_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_git_write_actions"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id", "created_by", "client_operation_id"],
                name="ppm_git_write_operation_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_write_scope_idx"),
            models.Index(fields=["repository", "status", "-created_at"], name="ppm_git_write_repo_idx"),
            models.Index(fields=["work_item", "-created_at"], name="ppm_git_write_item_idx"),
        ]
        ordering = ("-created_at", "id")
