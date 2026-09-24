import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0122_alter_draftissue_assignees_alter_issue_assignees_and_more"),
        ("ppm_git", "0004_code_index"),
    ]

    operations = [
        migrations.CreateModel(
            name="PpmGitWriteAction",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                (
                    "action_type",
                    models.CharField(
                        choices=[
                            ("create_branch_draft_pr", "Create branch and draft pull request"),
                        ],
                        default="create_branch_draft_pr",
                        max_length=32,
                    ),
                ),
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
                ("client_operation_id", models.UUIDField()),
                ("request_fingerprint", models.CharField(max_length=64)),
                ("repository_updated_at", models.DateTimeField()),
                ("connection_updated_at", models.DateTimeField()),
                ("work_item_updated_at", models.DateTimeField()),
                ("base_ref", models.CharField(max_length=255)),
                ("head_ref", models.CharField(max_length=255)),
                ("title", models.CharField(max_length=500)),
                ("body", models.TextField(blank=True, default="")),
                ("preview", models.JSONField(default=dict)),
                ("result", models.JSONField(blank=True, default=dict)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_message", models.CharField(blank=True, default="", max_length=500)),
                ("created_by", models.UUIDField(db_index=True)),
                ("decided_by", models.UUIDField(blank=True, null=True)),
                ("applied_by", models.UUIDField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("decided_at", models.DateTimeField(blank=True, null=True)),
                ("applied_at", models.DateTimeField(blank=True, null=True)),
                (
                    "connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="write_actions",
                        to="ppm_git.ppmgitconnection",
                    ),
                ),
                (
                    "repository",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="write_actions",
                        to="ppm_git.ppmgitrepository",
                    ),
                ),
                (
                    "work_item",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="ppm_git_write_actions",
                        to="db.issue",
                    ),
                ),
            ],
            options={
                "db_table": "ppm_git_write_actions",
                "ordering": ("-created_at", "id"),
            },
        ),
        migrations.AddConstraint(
            model_name="ppmgitwriteaction",
            constraint=models.UniqueConstraint(
                fields=("project_id", "created_by", "client_operation_id"),
                name="ppm_git_write_operation_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmgitwriteaction",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_write_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitwriteaction",
            index=models.Index(fields=["repository", "status", "-created_at"], name="ppm_git_write_repo_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitwriteaction",
            index=models.Index(fields=["work_item", "-created_at"], name="ppm_git_write_item_idx"),
        ),
    ]
