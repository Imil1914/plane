import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


EMPTY_BINDING_CHANGES_FINGERPRINT = "ae3a6b5d50c247e7eceff49fb20552796da57b656a15cde6530847d9c009502b"


class PpmCanvasStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    ARCHIVED = "archived", "Archived"


class PpmCanvasEntityType(models.TextChoices):
    WORK_ITEM = "work_item", "Work item"
    PAGE = "page", "Page"
    ATTACHMENT = "attachment", "Attachment"
    VAULT_FILE = "vault_file", "Vault file"
    REPOSITORY = "repository", "Repository"
    BRANCH = "branch", "Branch"
    COMMIT = "commit", "Commit"
    PULL_REQUEST = "pull_request", "Pull request"


class PpmCanvasBindingStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    ACTIVE = "active", "Active"


class PpmSemanticEdgeOrigin(models.TextChoices):
    USER = "user", "User"
    AGENT = "agent", "Agent"
    IMPORT = "import", "Import"


class PpmSemanticEdgeConfirmationStatus(models.TextChoices):
    PROPOSED = "proposed", "Proposed"
    CONFIRMED = "confirmed", "Confirmed"
    REJECTED = "rejected", "Rejected"


class PpmSemanticRelationType(models.TextChoices):
    RELATES_TO = "relates_to", "Relates to"
    DEPENDS_ON = "depends_on", "Depends on"
    BLOCKS = "blocks", "Blocks"
    EXPLAINS = "explains", "Explains"
    IMPLEMENTS = "implements", "Implements"
    EVIDENCE_FOR = "evidence_for", "Evidence for"
    CONTRADICTS = "contradicts", "Contradicts"
    DERIVED_FROM = "derived_from", "Derived from"
    RESULT_OF = "result_of", "Result of"


class PpmGlobalAdmin(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="ppm_global_admin",
    )
    reason = models.CharField(max_length=255)
    created_by = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.UUIDField(null=True, blank=True)

    class Meta:
        db_table = "ppm_global_admins"
        indexes = [models.Index(fields=["user", "revoked_at"], name="ppm_global_admin_active_idx")]


class PpmGlobalAdminAudit(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    global_admin = models.ForeignKey(PpmGlobalAdmin, on_delete=models.PROTECT, related_name="audit_events")
    action = models.CharField(max_length=64, default="project_access")
    workspace_id = models.UUIDField(null=True, blank=True)
    project_id = models.UUIDField(null=True, blank=True)
    method = models.CharField(max_length=16)
    path = models.CharField(max_length=500)
    request_id = models.UUIDField()
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_global_admin_audit"
        indexes = [
            models.Index(fields=["global_admin", "-created_at"], name="ppm_admin_audit_actor_idx"),
            models.Index(fields=["workspace_id", "project_id", "-created_at"], name="ppm_admin_audit_scope_idx"),
            models.Index(fields=["action", "-created_at"], name="ppm_admin_audit_action_idx"),
        ]


class PpmGlobalAdminRoleAudit(models.Model):
    class Action(models.TextChoices):
        GRANT = "grant", "Grant"
        REVOKE = "revoke", "Revoke"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    target_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="ppm_global_admin_role_events",
    )
    actor_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="ppm_global_admin_actions",
    )
    action = models.CharField(max_length=16, choices=Action.choices)
    reason = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_global_admin_role_audit"
        indexes = [
            models.Index(fields=["target_user", "-created_at"], name="ppm_admin_role_target_idx"),
            models.Index(fields=["actor_user", "-created_at"], name="ppm_admin_role_actor_idx"),
        ]


class PpmProjectCanvas(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    name = models.CharField(max_length=255, default="Мозг проекта")
    status = models.CharField(max_length=16, choices=PpmCanvasStatus.choices, default=PpmCanvasStatus.ACTIVE)
    current_version = models.PositiveIntegerField(default=0)
    default_board = models.ForeignKey(
        "PpmCanvasBoard",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="default_for_canvases",
    )
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_project_canvases"
        constraints = [
            models.CheckConstraint(condition=models.Q(current_version__gte=0), name="ppm_canvas_version_nonnegative"),
            models.UniqueConstraint(
                fields=["project_id"],
                condition=models.Q(status=PpmCanvasStatus.ACTIVE),
                name="ppm_canvas_unique_active_project",
            ),
        ]
        indexes = [models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_canvas_scope_idx")]


class PpmCanvasBoard(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    canvas = models.ForeignKey(PpmProjectCanvas, on_delete=models.CASCADE, related_name="boards")
    name = models.CharField(max_length=120)
    normalized_name = models.CharField(max_length=120)
    position = models.PositiveIntegerField()
    status = models.CharField(max_length=16, choices=PpmCanvasStatus.choices, default=PpmCanvasStatus.ACTIVE)
    current_version = models.PositiveIntegerField(default=0)
    created_operation_id = models.UUIDField()
    created_by = models.UUIDField()
    updated_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_canvas_boards"
        constraints = [
            models.CheckConstraint(condition=models.Q(current_version__gte=0), name="ppm_board_version_nonnegative"),
            models.UniqueConstraint(
                fields=["canvas", "normalized_name"],
                condition=models.Q(status=PpmCanvasStatus.ACTIVE),
                name="ppm_board_unique_active_name",
            ),
            models.UniqueConstraint(
                fields=["canvas", "position"],
                condition=models.Q(status=PpmCanvasStatus.ACTIVE),
                name="ppm_board_unique_active_pos",
            ),
            models.UniqueConstraint(
                fields=["canvas", "created_operation_id"],
                name="ppm_board_unique_create_op",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_board_scope_idx"),
            models.Index(fields=["canvas", "status", "position"], name="ppm_board_order_idx"),
        ]
        ordering = ("position", "created_at", "id")


class PpmCanvasOperation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    canvas = models.ForeignKey(PpmProjectCanvas, on_delete=models.CASCADE, related_name="operations")
    board = models.ForeignKey(PpmCanvasBoard, on_delete=models.SET_NULL, null=True, blank=True)
    operation_type = models.CharField(max_length=32)
    client_operation_id = models.UUIDField()
    operation_fingerprint = models.CharField(max_length=64)
    result_json = models.JSONField(default=dict)
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_canvas_operations"
        constraints = [
            models.UniqueConstraint(
                fields=["canvas", "client_operation_id"],
                name="ppm_canvas_unique_lifecycle_op",
            )
        ]
        indexes = [models.Index(fields=["canvas", "-created_at"], name="ppm_canvas_operation_idx")]


class PpmCanvasVersion(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    canvas = models.ForeignKey(PpmProjectCanvas, on_delete=models.PROTECT, related_name="versions")
    board = models.ForeignKey(PpmCanvasBoard, on_delete=models.PROTECT, related_name="versions")
    version = models.PositiveIntegerField()
    schema_version = models.PositiveSmallIntegerField(default=2)
    snapshot_json = models.JSONField()
    content_hash = models.CharField(max_length=64)
    binding_changes_fingerprint = models.CharField(
        max_length=64,
        blank=True,
        default=EMPTY_BINDING_CHANGES_FINGERPRINT,
    )
    client_operation_id = models.UUIDField()
    request_id = models.UUIDField()
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_canvas_versions"
        constraints = [
            models.CheckConstraint(condition=models.Q(version__gte=1), name="ppm_canvas_saved_version_positive"),
            models.UniqueConstraint(fields=["board", "version"], name="ppm_board_unique_version"),
            models.UniqueConstraint(fields=["board", "client_operation_id"], name="ppm_board_unique_operation"),
        ]
        indexes = [models.Index(fields=["board", "-version"], name="ppm_board_version_idx")]
        ordering = ("-version",)

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("Canvas versions are immutable.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Canvas versions are immutable.")


class PpmCanvasBinding(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    canvas = models.ForeignKey(PpmProjectCanvas, on_delete=models.CASCADE, related_name="bindings")
    board = models.ForeignKey(PpmCanvasBoard, on_delete=models.CASCADE, related_name="bindings")
    shape_id = models.CharField(max_length=255)
    entity_type = models.CharField(max_length=32, choices=PpmCanvasEntityType.choices)
    entity_id = models.UUIDField()
    status = models.CharField(
        max_length=16,
        choices=PpmCanvasBindingStatus.choices,
        default=PpmCanvasBindingStatus.PENDING,
    )
    source_version = models.CharField(max_length=64, null=True, blank=True)
    client_operation_id = models.UUIDField()
    operation_fingerprint = models.CharField(max_length=64)
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_canvas_bindings"
        constraints = [
            models.UniqueConstraint(
                fields=["board", "shape_id", "entity_type", "entity_id"],
                name="ppm_binding_unique_projection",
            ),
            models.UniqueConstraint(fields=["board", "shape_id"], name="ppm_binding_unique_shape"),
            models.UniqueConstraint(
                fields=["board", "client_operation_id"],
                name="ppm_binding_unique_operation",
            ),
        ]
        indexes = [
            models.Index(
                fields=["workspace_id", "project_id", "entity_type", "entity_id"],
                name="ppm_binding_source_idx",
            ),
            models.Index(fields=["board", "shape_id"], name="ppm_binding_shape_idx"),
        ]
        ordering = ("created_at", "id")


class PpmCanvasSemanticEdge(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    canvas = models.ForeignKey(PpmProjectCanvas, on_delete=models.CASCADE, related_name="semantic_edges")
    board = models.ForeignKey(PpmCanvasBoard, on_delete=models.CASCADE, related_name="semantic_edges")
    from_shape_id = models.CharField(max_length=255)
    to_shape_id = models.CharField(max_length=255)
    relation_type = models.CharField(max_length=32, choices=PpmSemanticRelationType.choices)
    label = models.CharField(max_length=255, null=True, blank=True)
    confidence = models.DecimalField(max_digits=5, decimal_places=4, null=True, blank=True)
    origin = models.CharField(max_length=16, choices=PpmSemanticEdgeOrigin.choices, default=PpmSemanticEdgeOrigin.USER)
    confirmation_status = models.CharField(
        max_length=16,
        choices=PpmSemanticEdgeConfirmationStatus.choices,
        default=PpmSemanticEdgeConfirmationStatus.CONFIRMED,
    )
    confirmed_by = models.UUIDField(null=True, blank=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    client_operation_id = models.UUIDField()
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_semantic_edges"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(confidence__isnull=True) | models.Q(confidence__gte=0, confidence__lte=1),
                name="ppm_edge_confidence_range",
            ),
            models.UniqueConstraint(
                fields=["board", "from_shape_id", "to_shape_id", "relation_type"],
                name="ppm_edge_unique_relation",
            ),
            models.UniqueConstraint(
                fields=["board", "client_operation_id"],
                name="ppm_edge_unique_operation",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "board"], name="ppm_edge_scope_idx"),
            models.Index(
                fields=["workspace_id", "project_id", "confirmation_status"],
                name="ppm_edge_confirmed_idx",
            ),
            models.Index(fields=["board", "from_shape_id"], name="ppm_edge_from_shape_idx"),
            models.Index(fields=["board", "to_shape_id"], name="ppm_edge_to_shape_idx"),
        ]
        ordering = ("created_at", "id")
