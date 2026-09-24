import uuid

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_brain", "0002_ppmknowledgechunk_embedding_json_and_more")]

    operations = [
        migrations.CreateModel(
            name="PpmAnswerRun",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("created_by", models.UUIDField(db_index=True)),
                ("client_operation_id", models.UUIDField()),
                ("board_id", models.UUIDField(blank=True, null=True)),
                ("query", models.TextField()),
                ("selected_shape_ids", models.JSONField(default=list)),
                ("scope_json", models.JSONField(default=dict)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("queued", "Queued"),
                            ("retrieving", "Retrieving"),
                            ("completing", "Completing"),
                            ("completed", "Completed"),
                            ("degraded", "Degraded"),
                            ("no_sources", "No sources"),
                            ("cancelled", "Cancelled"),
                            ("failed", "Failed"),
                        ],
                        default="queued",
                        max_length=16,
                    ),
                ),
                ("provider", models.CharField(blank=True, default="", max_length=64)),
                ("model", models.CharField(blank=True, default="", max_length=128)),
                ("answer_text", models.TextField(blank=True, default="")),
                ("citations_json", models.JSONField(default=list)),
                ("retrieved_chunks_json", models.JSONField(default=list)),
                ("retrieval_json", models.JSONField(default=dict)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_message", models.CharField(blank=True, default="", max_length=500)),
                ("cancel_requested_at", models.DateTimeField(blank=True, null=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "ppm_answer_runs", "ordering": ("-created_at", "id")},
        ),
        migrations.AddConstraint(
            model_name="ppmanswerrun",
            constraint=models.UniqueConstraint(
                fields=("project_id", "created_by", "client_operation_id"),
                name="ppm_answer_run_operation_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmanswerrun",
            index=models.Index(
                fields=["workspace_id", "project_id", "-created_at"],
                name="ppm_answer_run_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmanswerrun",
            index=models.Index(fields=["created_by", "status", "-created_at"], name="ppm_answer_run_actor_idx"),
        ),
    ]
