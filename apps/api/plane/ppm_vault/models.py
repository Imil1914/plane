import uuid

from django.core.exceptions import ValidationError
from django.db import models


class PpmVaultStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    ARCHIVED = "archived", "Archived"


class PpmVaultEntryKind(models.TextChoices):
    FOLDER = "folder", "Folder"
    MARKDOWN = "markdown", "Markdown"
    PDF = "pdf", "PDF"
    IMAGE = "image", "Image"
    FILE = "file", "File"


class PpmVaultEntryStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    QUARANTINED = "quarantined", "Quarantined"
    TRASHED = "trashed", "Trashed"


class PpmVaultVersionStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    VERIFIED = "verified", "Verified"
    QUARANTINED = "quarantined", "Quarantined"


class PpmVaultIndexPolicy(models.TextChoices):
    INHERIT = "inherit", "Inherit"
    INCLUDE = "include", "Include"
    EXCLUDE = "exclude", "Exclude"


class PpmVaultLinkStatus(models.TextChoices):
    RESOLVED = "resolved", "Resolved"
    MISSING = "missing", "Missing"
    AMBIGUOUS = "ambiguous", "Ambiguous"


class PpmVaultTransferDirection(models.TextChoices):
    PAGE_TO_VAULT = "page_to_vault", "Page to Vault"
    VAULT_TO_PAGE = "vault_to_page", "Vault to Page"


class PpmProjectVault(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    name = models.CharField(max_length=255, default="Хранилище проекта")
    status = models.CharField(max_length=16, choices=PpmVaultStatus.choices, default=PpmVaultStatus.ACTIVE)
    root_entry = models.ForeignKey(
        "PpmVaultEntry",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="root_for_vaults",
    )
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_vaults"
        constraints = [
            models.UniqueConstraint(
                fields=["project_id"],
                condition=models.Q(status=PpmVaultStatus.ACTIVE),
                name="ppm_vault_unique_active_project",
            )
        ]
        indexes = [models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_vault_scope_idx")]


class PpmVaultEntry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    vault = models.ForeignKey(PpmProjectVault, on_delete=models.CASCADE, related_name="entries")
    parent = models.ForeignKey(
        "self",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="children",
    )
    kind = models.CharField(db_column="entry_type", max_length=16, choices=PpmVaultEntryKind.choices)
    name = models.CharField(max_length=255)
    normalized_name = models.CharField(max_length=255)
    extension = models.CharField(max_length=16, null=True, blank=True)
    mime_type = models.CharField(max_length=127, null=True, blank=True)
    size_bytes = models.PositiveBigIntegerField(default=0)
    content_hash = models.CharField(max_length=64, null=True, blank=True)
    index_policy = models.CharField(
        max_length=16,
        choices=PpmVaultIndexPolicy.choices,
        default=PpmVaultIndexPolicy.INHERIT,
    )
    status = models.CharField(
        max_length=16,
        choices=PpmVaultEntryStatus.choices,
        default=PpmVaultEntryStatus.ACTIVE,
    )
    current_version = models.ForeignKey(
        "PpmVaultVersion",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="current_for_entries",
    )
    created_by = models.UUIDField()
    updated_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_vault_entries"
        constraints = [
            models.UniqueConstraint(
                fields=["vault", "parent", "normalized_name"],
                condition=models.Q(status__in=[PpmVaultEntryStatus.ACTIVE, PpmVaultEntryStatus.QUARANTINED]),
                name="ppm_vault_unique_active_name",
            ),
            models.UniqueConstraint(
                fields=["vault"],
                condition=models.Q(parent__isnull=True, status=PpmVaultEntryStatus.ACTIVE),
                name="ppm_vault_unique_root",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_vault_entry_scope_idx"),
            models.Index(fields=["vault", "parent", "normalized_name"], name="ppm_vault_tree_idx"),
        ]
        ordering = ("kind", "normalized_name", "id")

    @property
    def version(self):
        return self.current_version.version if self.current_version_id else 0


class PpmVaultVersion(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    entry = models.ForeignKey(PpmVaultEntry, on_delete=models.PROTECT, related_name="versions")
    version = models.PositiveIntegerField()
    content_text = models.TextField(blank=True, default="")
    object_key = models.CharField(max_length=512, unique=True)
    size_bytes = models.PositiveBigIntegerField()
    content_hash = models.CharField(max_length=64)
    mime_type = models.CharField(max_length=127)
    status = models.CharField(
        max_length=16,
        choices=PpmVaultVersionStatus.choices,
        default=PpmVaultVersionStatus.VERIFIED,
    )
    client_operation_id = models.UUIDField(default=uuid.uuid4)
    request_id = models.UUIDField(default=uuid.uuid4)
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    verified_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "ppm_vault_versions"
        constraints = [
            models.CheckConstraint(condition=models.Q(version__gte=1), name="ppm_vault_version_positive"),
            models.UniqueConstraint(fields=["entry", "version"], name="ppm_vault_unique_version"),
            models.UniqueConstraint(
                fields=["entry", "client_operation_id"],
                name="ppm_vault_unique_operation",
            ),
        ]
        indexes = [models.Index(fields=["entry", "-version"], name="ppm_vault_version_idx")]
        ordering = ("-version",)

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("Vault versions are immutable.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Vault versions are immutable.")


class PpmVaultEntryAlias(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    vault = models.ForeignKey(PpmProjectVault, on_delete=models.CASCADE, related_name="entry_aliases")
    entry = models.ForeignKey(PpmVaultEntry, on_delete=models.CASCADE, related_name="aliases")
    path = models.CharField(max_length=1024)
    normalized_path = models.CharField(max_length=1024)
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_vault_entry_aliases"
        constraints = [
            models.UniqueConstraint(
                fields=["entry", "normalized_path"],
                name="ppm_vault_unique_entry_alias",
            )
        ]
        indexes = [
            models.Index(
                fields=["workspace_id", "project_id", "normalized_path"],
                name="ppm_vault_alias_scope_idx",
            )
        ]
        ordering = ("normalized_path", "id")


class PpmVaultLink(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    vault = models.ForeignKey(PpmProjectVault, on_delete=models.CASCADE, related_name="links")
    source_entry = models.ForeignKey(PpmVaultEntry, on_delete=models.CASCADE, related_name="outgoing_links")
    source_version = models.PositiveIntegerField()
    raw_target = models.CharField(max_length=512)
    normalized_target = models.CharField(max_length=512)
    target_entry = models.ForeignKey(
        PpmVaultEntry,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="incoming_links",
    )
    status = models.CharField(max_length=16, choices=PpmVaultLinkStatus.choices)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ppm_vault_links"
        constraints = [
            models.UniqueConstraint(
                fields=["source_entry", "source_version", "normalized_target"],
                name="ppm_vault_unique_version_link",
            )
        ]
        indexes = [
            models.Index(
                fields=["workspace_id", "project_id", "status"],
                name="ppm_vault_link_scope_idx",
            ),
            models.Index(fields=["target_entry", "status"], name="ppm_vault_backlink_idx"),
        ]
        ordering = ("raw_target", "id")


class PpmVaultTransferRecord(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.UUIDField(db_index=True)
    project_id = models.UUIDField(db_index=True)
    vault = models.ForeignKey(PpmProjectVault, on_delete=models.CASCADE, related_name="transfers")
    entry = models.ForeignKey(PpmVaultEntry, on_delete=models.PROTECT, related_name="transfers")
    page_id = models.UUIDField(db_index=True)
    direction = models.CharField(max_length=24, choices=PpmVaultTransferDirection.choices)
    entry_version = models.PositiveIntegerField()
    page_version = models.CharField(max_length=64)
    created_by = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_vault_transfers"
        indexes = [
            models.Index(
                fields=["workspace_id", "project_id", "direction"],
                name="ppm_vault_transfer_scope_idx",
            ),
            models.Index(fields=["entry", "-created_at"], name="ppm_vault_transfer_entry_idx"),
        ]
        ordering = ("-created_at", "id")
