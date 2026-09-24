import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_vault", "0003_media_files")]

    operations = [
        migrations.CreateModel(
            name="PpmVaultEntryAlias",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("path", models.CharField(max_length=1024)),
                ("normalized_path", models.CharField(max_length=1024)),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "entry",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="aliases",
                        to="ppm_vault.ppmvaultentry",
                    ),
                ),
                (
                    "vault",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="entry_aliases",
                        to="ppm_vault.ppmprojectvault",
                    ),
                ),
            ],
            options={"db_table": "ppm_vault_entry_aliases", "ordering": ("normalized_path", "id")},
        ),
        migrations.CreateModel(
            name="PpmVaultLink",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("source_version", models.PositiveIntegerField()),
                ("raw_target", models.CharField(max_length=512)),
                ("normalized_target", models.CharField(max_length=512)),
                (
                    "status",
                    models.CharField(
                        choices=[("resolved", "Resolved"), ("missing", "Missing"), ("ambiguous", "Ambiguous")],
                        max_length=16,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "source_entry",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="outgoing_links",
                        to="ppm_vault.ppmvaultentry",
                    ),
                ),
                (
                    "target_entry",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="incoming_links",
                        to="ppm_vault.ppmvaultentry",
                    ),
                ),
                (
                    "vault",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="links",
                        to="ppm_vault.ppmprojectvault",
                    ),
                ),
            ],
            options={"db_table": "ppm_vault_links", "ordering": ("raw_target", "id")},
        ),
        migrations.CreateModel(
            name="PpmVaultTransferRecord",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("page_id", models.UUIDField(db_index=True)),
                (
                    "direction",
                    models.CharField(
                        choices=[("page_to_vault", "Page to Vault"), ("vault_to_page", "Vault to Page")],
                        max_length=24,
                    ),
                ),
                ("entry_version", models.PositiveIntegerField()),
                ("page_version", models.CharField(max_length=64)),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "entry",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="transfers",
                        to="ppm_vault.ppmvaultentry",
                    ),
                ),
                (
                    "vault",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="transfers",
                        to="ppm_vault.ppmprojectvault",
                    ),
                ),
            ],
            options={"db_table": "ppm_vault_transfers", "ordering": ("-created_at", "id")},
        ),
        migrations.AddConstraint(
            model_name="ppmvaultentryalias",
            constraint=models.UniqueConstraint(
                fields=("entry", "normalized_path"),
                name="ppm_vault_unique_entry_alias",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmvaultentryalias",
            index=models.Index(
                fields=["workspace_id", "project_id", "normalized_path"],
                name="ppm_vault_alias_scope_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmvaultlink",
            constraint=models.UniqueConstraint(
                fields=("source_entry", "source_version", "normalized_target"),
                name="ppm_vault_unique_version_link",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmvaultlink",
            index=models.Index(
                fields=["workspace_id", "project_id", "status"],
                name="ppm_vault_link_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmvaultlink",
            index=models.Index(fields=["target_entry", "status"], name="ppm_vault_backlink_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmvaulttransferrecord",
            index=models.Index(
                fields=["workspace_id", "project_id", "direction"],
                name="ppm_vault_transfer_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmvaulttransferrecord",
            index=models.Index(fields=["entry", "-created_at"], name="ppm_vault_transfer_entry_idx"),
        ),
    ]
