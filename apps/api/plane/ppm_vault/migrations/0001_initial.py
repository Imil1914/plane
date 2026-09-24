import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="PpmProjectVault",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("name", models.CharField(default="Хранилище проекта", max_length=255)),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("archived", "Archived")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "ppm_vaults"},
        ),
        migrations.CreateModel(
            name="PpmVaultEntry",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                (
                    "kind",
                    models.CharField(
                        choices=[("folder", "Folder"), ("markdown", "Markdown"), ("pdf", "PDF")],
                        db_column="entry_type",
                        max_length=16,
                    ),
                ),
                ("name", models.CharField(max_length=255)),
                ("normalized_name", models.CharField(max_length=255)),
                ("extension", models.CharField(blank=True, max_length=16, null=True)),
                ("mime_type", models.CharField(blank=True, max_length=127, null=True)),
                ("size_bytes", models.PositiveBigIntegerField(default=0)),
                ("content_hash", models.CharField(blank=True, max_length=64, null=True)),
                (
                    "index_policy",
                    models.CharField(
                        choices=[("inherit", "Inherit"), ("include", "Include"), ("exclude", "Exclude")],
                        default="inherit",
                        max_length=16,
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("quarantined", "Quarantined"), ("trashed", "Trashed")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("created_by", models.UUIDField()),
                ("updated_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "parent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="children",
                        to="ppm_vault.ppmvaultentry",
                    ),
                ),
                (
                    "vault",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="entries",
                        to="ppm_vault.ppmprojectvault",
                    ),
                ),
            ],
            options={"db_table": "ppm_vault_entries", "ordering": ("kind", "normalized_name", "id")},
        ),
        migrations.CreateModel(
            name="PpmVaultVersion",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("version", models.PositiveIntegerField()),
                ("object_key", models.CharField(max_length=512, unique=True)),
                ("size_bytes", models.PositiveBigIntegerField()),
                ("content_hash", models.CharField(max_length=64)),
                ("mime_type", models.CharField(max_length=127)),
                (
                    "status",
                    models.CharField(
                        choices=[("pending", "Pending"), ("verified", "Verified"), ("quarantined", "Quarantined")],
                        default="verified",
                        max_length=16,
                    ),
                ),
                ("client_operation_id", models.UUIDField(default=uuid.uuid4)),
                ("request_id", models.UUIDField(default=uuid.uuid4)),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("verified_at", models.DateTimeField(blank=True, null=True)),
                (
                    "entry",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="versions",
                        to="ppm_vault.ppmvaultentry",
                    ),
                ),
            ],
            options={"db_table": "ppm_vault_versions", "ordering": ("-version",)},
        ),
        migrations.AddField(
            model_name="ppmvaultentry",
            name="current_version",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="current_for_entries",
                to="ppm_vault.ppmvaultversion",
            ),
        ),
        migrations.AddField(
            model_name="ppmprojectvault",
            name="root_entry",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="root_for_vaults",
                to="ppm_vault.ppmvaultentry",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmprojectvault",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "active")),
                fields=("project_id",),
                name="ppm_vault_unique_active_project",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmprojectvault",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_vault_scope_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmvaultentry",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status__in", ["active", "quarantined"])),
                fields=("vault", "parent", "normalized_name"),
                name="ppm_vault_unique_active_name",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmvaultentry",
            constraint=models.UniqueConstraint(
                condition=models.Q(("parent__isnull", True), ("status", "active")),
                fields=("vault",),
                name="ppm_vault_unique_root",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmvaultentry",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_vault_entry_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmvaultentry",
            index=models.Index(fields=["vault", "parent", "normalized_name"], name="ppm_vault_tree_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmvaultversion",
            constraint=models.CheckConstraint(condition=models.Q(("version__gte", 1)), name="ppm_vault_version_positive"),
        ),
        migrations.AddConstraint(
            model_name="ppmvaultversion",
            constraint=models.UniqueConstraint(fields=("entry", "version"), name="ppm_vault_unique_version"),
        ),
        migrations.AddConstraint(
            model_name="ppmvaultversion",
            constraint=models.UniqueConstraint(
                fields=("entry", "client_operation_id"),
                name="ppm_vault_unique_operation",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmvaultversion",
            index=models.Index(fields=["entry", "-version"], name="ppm_vault_version_idx"),
        ),
    ]
