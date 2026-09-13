import uuid

from django.core.exceptions import ValidationError
from django.db import models


class PpmCanvasStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    ARCHIVED = "archived", "Archived"


class PpmProjectCanvas(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    name = models.CharField(max_length=255, default="Мозг проекта")
    status = models.CharField(max_length=16, choices=PpmCanvasStatus.choices, default=PpmCanvasStatus.ACTIVE)
    current_version = models.PositiveIntegerField(default=0)
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


class PpmCanvasVersion(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    canvas = models.ForeignKey(PpmProjectCanvas, on_delete=models.PROTECT, related_name="versions")
    version = models.PositiveIntegerField()
    schema_version = models.PositiveSmallIntegerField(default=1)
    snapshot_json = models.JSONField()
    content_hash = models.CharField(max_length=64)
    client_operation_id = models.UUIDField()
    request_id = models.UUIDField()
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_canvas_versions"
        constraints = [
            models.CheckConstraint(condition=models.Q(version__gte=1), name="ppm_canvas_saved_version_positive"),
            models.UniqueConstraint(fields=["canvas", "version"], name="ppm_canvas_unique_version"),
            models.UniqueConstraint(fields=["canvas", "client_operation_id"], name="ppm_canvas_unique_operation"),
        ]
        indexes = [models.Index(fields=["canvas", "-version"], name="ppm_canvas_version_idx")]
        ordering = ("-version",)

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("Canvas versions are immutable.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Canvas versions are immutable.")
