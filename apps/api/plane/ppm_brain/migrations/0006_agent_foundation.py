import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_brain", "0005_git_code_source_type")]

    operations = [
        migrations.CreateModel(
            name="PpmAgentRun",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("created_by", models.UUIDField(db_index=True)),
                ("client_operation_id", models.UUIDField()),
                (
                    "agent_kind",
                    models.CharField(
                        choices=[
                            ("project_reporter", "Project reporter"),
                            ("work_decomposer", "Work decomposer"),
                            ("knowledge_librarian", "Knowledge librarian"),
                            ("relationship_analyst", "Relationship analyst"),
                        ],
                        max_length=32,
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("queued", "Queued"),
                            ("running", "Running"),
                            ("awaiting_approval", "Awaiting approval"),
                            ("applying", "Applying"),
                            ("completed", "Completed"),
                            ("failed", "Failed"),
                            ("cancelled", "Cancelled"),
                            ("rejected", "Rejected"),
                        ],
                        default="queued",
                        max_length=24,
                    ),
                ),
                ("input_hash", models.CharField(max_length=64)),
                ("context_json", models.JSONField(default=dict)),
                ("capabilities_json", models.JSONField(default=list)),
                ("policy_version", models.CharField(default="ppm-agents-v1", max_length=64)),
                ("prompt_template_version", models.CharField(blank=True, default="", max_length=64)),
                ("provider", models.CharField(blank=True, default="", max_length=64)),
                ("model", models.CharField(blank=True, default="", max_length=128)),
                ("result_json", models.JSONField(default=dict)),
                ("token_usage_json", models.JSONField(default=dict)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_message", models.CharField(blank=True, default="", max_length=500)),
                ("cancel_requested_at", models.DateTimeField(blank=True, null=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "ppm_agent_runs", "ordering": ("-created_at", "id")},
        ),
        migrations.CreateModel(
            name="PpmAgentAction",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("sequence", models.PositiveSmallIntegerField()),
                (
                    "action_kind",
                    models.CharField(
                        choices=[
                            ("create_work_items", "Create work items"),
                            ("apply_semantic_edges", "Apply semantic edges"),
                            ("write_vault_file", "Write Vault file"),
                            ("create_git_branch", "Create Git branch"),
                            ("create_pull_request", "Create pull request"),
                        ],
                        max_length=32,
                    ),
                ),
                ("proposal_tool", models.CharField(max_length=64)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("proposed", "Proposed"),
                            ("approved", "Approved"),
                            ("rejected", "Rejected"),
                            ("applying", "Applying"),
                            ("applied", "Applied"),
                            ("conflict", "Conflict"),
                            ("failed", "Failed"),
                            ("cancelled", "Cancelled"),
                        ],
                        default="proposed",
                        max_length=16,
                    ),
                ),
                ("payload_json", models.JSONField(default=dict)),
                ("preview_json", models.JSONField(default=dict)),
                ("preconditions_json", models.JSONField(default=dict)),
                ("idempotency_key", models.UUIDField(default=uuid.uuid4)),
                ("approved_by", models.UUIDField(blank=True, null=True)),
                ("approved_at", models.DateTimeField(blank=True, null=True)),
                ("rejected_by", models.UUIDField(blank=True, null=True)),
                ("rejected_at", models.DateTimeField(blank=True, null=True)),
                ("applied_at", models.DateTimeField(blank=True, null=True)),
                ("result_json", models.JSONField(default=dict)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_message", models.CharField(blank=True, default="", max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "run",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="actions",
                        to="ppm_brain.ppmagentrun",
                    ),
                ),
            ],
            options={"db_table": "ppm_agent_actions", "ordering": ("sequence", "id")},
        ),
        migrations.CreateModel(
            name="PpmAgentCitation",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("ordinal", models.PositiveSmallIntegerField()),
                (
                    "source_type",
                    models.CharField(
                        choices=[
                            ("work_item", "Work item"),
                            ("vault_file", "Vault file"),
                            ("git_code", "Git code"),
                        ],
                        max_length=32,
                    ),
                ),
                ("source_id", models.CharField(max_length=255)),
                ("source_version", models.CharField(max_length=255)),
                ("title", models.CharField(blank=True, default="", max_length=500)),
                ("locator_json", models.JSONField(default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "action",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="citations",
                        to="ppm_brain.ppmagentaction",
                    ),
                ),
                (
                    "run",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="citations",
                        to="ppm_brain.ppmagentrun",
                    ),
                ),
            ],
            options={"db_table": "ppm_agent_citations", "ordering": ("ordinal", "id")},
        ),
        migrations.CreateModel(
            name="PpmAgentAuditEvent",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("actor_id", models.UUIDField(blank=True, db_index=True, null=True)),
                ("event_type", models.CharField(max_length=64)),
                ("metadata_json", models.JSONField(default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "action",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="audit_events",
                        to="ppm_brain.ppmagentaction",
                    ),
                ),
                (
                    "run",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="audit_events",
                        to="ppm_brain.ppmagentrun",
                    ),
                ),
            ],
            options={"db_table": "ppm_agent_audit", "ordering": ("created_at", "id")},
        ),
        migrations.AddConstraint(
            model_name="ppmagentrun",
            constraint=models.UniqueConstraint(
                fields=("project_id", "created_by", "client_operation_id"),
                name="ppm_agent_run_operation_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmagentrun",
            index=models.Index(
                fields=["workspace_id", "project_id", "-created_at"],
                name="ppm_agent_run_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmagentrun",
            index=models.Index(fields=["created_by", "status", "-created_at"], name="ppm_agent_run_actor_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmagentaction",
            constraint=models.UniqueConstraint(
                fields=("run", "sequence"),
                name="ppm_agent_action_sequence_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmagentaction",
            constraint=models.UniqueConstraint(
                fields=("project_id", "idempotency_key"),
                name="ppm_agent_action_idempotency_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmagentaction",
            index=models.Index(
                fields=["workspace_id", "project_id", "status"],
                name="ppm_agent_action_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmagentaction",
            index=models.Index(fields=["run", "status", "sequence"], name="ppm_agent_action_run_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmagentcitation",
            constraint=models.UniqueConstraint(
                fields=("run", "ordinal"),
                name="ppm_agent_citation_ordinal_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmagentcitation",
            index=models.Index(
                fields=["workspace_id", "project_id", "source_type"],
                name="ppm_agent_citation_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmagentcitation",
            index=models.Index(fields=["run", "action", "ordinal"], name="ppm_agent_citation_run_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmagentauditevent",
            index=models.Index(
                fields=["workspace_id", "project_id", "-created_at"],
                name="ppm_agent_audit_scope_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmagentauditevent",
            index=models.Index(fields=["run", "-created_at"], name="ppm_agent_audit_run_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmagentauditevent",
            index=models.Index(fields=["event_type", "-created_at"], name="ppm_agent_audit_event_idx"),
        ),
    ]
