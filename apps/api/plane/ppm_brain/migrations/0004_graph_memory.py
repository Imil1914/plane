import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_brain", "0003_ppmanswerrun")]

    operations = [
        migrations.AddField(
            model_name="ppmanswerrun",
            name="graph_depth",
            field=models.PositiveSmallIntegerField(default=1),
        ),
        migrations.CreateModel(
            name="PpmProjectMemoryRecord",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("decision", "Decision"),
                            ("daily_summary", "Daily summary"),
                            ("weekly_summary", "Weekly summary"),
                            ("release_summary", "Release summary"),
                        ],
                        max_length=32,
                    ),
                ),
                ("title", models.CharField(max_length=255)),
                ("body", models.TextField()),
                (
                    "origin",
                    models.CharField(
                        choices=[("user", "User"), ("agent", "Agent")], default="user", max_length=16
                    ),
                ),
                (
                    "confirmation_status",
                    models.CharField(
                        choices=[
                            ("proposed", "Proposed"),
                            ("confirmed", "Confirmed"),
                            ("rejected", "Rejected"),
                        ],
                        default="confirmed",
                        max_length=16,
                    ),
                ),
                (
                    "freshness_status",
                    models.CharField(
                        choices=[("current", "Current"), ("possibly_stale", "Possibly stale")],
                        default="current",
                        max_length=24,
                    ),
                ),
                ("content_hash", models.CharField(max_length=64)),
                ("client_operation_id", models.UUIDField()),
                ("created_by", models.UUIDField(db_index=True)),
                ("confirmed_by", models.UUIDField(blank=True, null=True)),
                ("confirmed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "ppm_project_memory_records", "ordering": ("-created_at", "id")},
        ),
        migrations.CreateModel(
            name="PpmProjectMemorySourceReference",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                (
                    "source_type",
                    models.CharField(
                        choices=[("work_item", "Work item"), ("vault_file", "Vault file")], max_length=32
                    ),
                ),
                ("source_id", models.CharField(max_length=255)),
                ("source_version", models.CharField(max_length=255)),
                ("locator_json", models.JSONField(default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "memory_record",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="source_references",
                        to="ppm_brain.ppmprojectmemoryrecord",
                    ),
                ),
                (
                    "knowledge_source",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="memory_references",
                        to="ppm_brain.ppmknowledgesource",
                    ),
                ),
            ],
            options={"db_table": "ppm_project_memory_source_refs", "ordering": ("created_at", "id")},
        ),
        migrations.AddIndex(
            model_name="ppmprojectmemoryrecord",
            index=models.Index(
                fields=["workspace_id", "project_id", "confirmation_status", "-created_at"],
                name="ppm_memory_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmprojectmemoryrecord",
            index=models.Index(
                fields=["project_id", "freshness_status", "-created_at"], name="ppm_memory_fresh_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmprojectmemorysourcereference",
            index=models.Index(
                fields=["workspace_id", "project_id", "source_type"], name="ppm_memory_ref_scope_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmprojectmemorysourcereference",
            index=models.Index(fields=["knowledge_source", "source_version"], name="ppm_memory_ref_version_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmprojectmemoryrecord",
            constraint=models.UniqueConstraint(
                fields=("project_id", "created_by", "client_operation_id"),
                name="ppm_memory_operation_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmprojectmemorysourcereference",
            constraint=models.UniqueConstraint(
                fields=("memory_record", "source_type", "source_id"), name="ppm_memory_source_uniq"
            ),
        ),
    ]
