import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [("db", "0122_alter_draftissue_assignees_alter_issue_assignees_and_more")]

    operations = [
        migrations.CreateModel(
            name="PpmGitRepository",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("name", models.CharField(max_length=160)),
                ("normalized_name", models.CharField(max_length=160)),
                (
                    "provider",
                    models.CharField(
                        choices=[
                            ("github", "GitHub"),
                            ("gitlab", "GitLab"),
                            ("bitbucket", "Bitbucket"),
                            ("gitea", "Gitea"),
                            ("generic", "Generic Git"),
                        ],
                        default="generic",
                        max_length=24,
                    ),
                ),
                ("canonical_url", models.URLField(max_length=2048)),
                ("clone_https", models.URLField(max_length=2048)),
                ("clone_ssh", models.CharField(blank=True, default="", max_length=2048)),
                ("default_branch", models.CharField(blank=True, default="", max_length=255)),
                (
                    "visibility",
                    models.CharField(
                        choices=[
                            ("public", "Public"),
                            ("private", "Private"),
                            ("internal", "Internal"),
                            ("unknown", "Unknown"),
                        ],
                        default="unknown",
                        max_length=16,
                    ),
                ),
                ("is_default", models.BooleanField(default=False)),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("archived", "Archived")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("created_by", models.UUIDField()),
                ("updated_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("archived_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={"db_table": "ppm_git_repositories", "ordering": ("-is_default", "normalized_name", "id")},
        ),
        migrations.CreateModel(
            name="PpmGitLink",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                (
                    "object_type",
                    models.CharField(
                        choices=[("branch", "Branch"), ("commit", "Commit"), ("pull_request", "Pull request")],
                        max_length=24,
                    ),
                ),
                ("ref", models.CharField(blank=True, default="", max_length=255)),
                ("title", models.CharField(max_length=255)),
                ("canonical_url", models.URLField(max_length=2048)),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("unlinked", "Unlinked")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("created_by", models.UUIDField()),
                ("updated_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("unlinked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "repository",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="links",
                        to="ppm_git.ppmgitrepository",
                    ),
                ),
                (
                    "work_item",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="ppm_git_links",
                        to="db.issue",
                    ),
                ),
            ],
            options={"db_table": "ppm_git_links", "ordering": ("-created_at", "id")},
        ),
        migrations.CreateModel(
            name="PpmGitAudit",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("actor_id", models.UUIDField(db_index=True)),
                ("action", models.CharField(max_length=64)),
                ("target_type", models.CharField(max_length=32)),
                ("target_id", models.UUIDField(blank=True, null=True)),
                ("request_id", models.UUIDField()),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "ppm_git_audit"},
        ),
        migrations.AddConstraint(
            model_name="ppmgitrepository",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "active")),
                fields=("project_id", "canonical_url"),
                name="ppm_git_repo_active_url_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmgitrepository",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_default", True), ("status", "active")),
                fields=("project_id",),
                name="ppm_git_repo_default_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmgitrepository",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_repo_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitrepository",
            index=models.Index(fields=["project_id", "is_default", "status"], name="ppm_git_repo_default_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmgitlink",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "active")),
                fields=("repository", "work_item", "object_type", "canonical_url"),
                name="ppm_git_link_active_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmgitlink",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_link_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitlink",
            index=models.Index(fields=["work_item", "status"], name="ppm_git_link_item_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitaudit",
            index=models.Index(fields=["workspace_id", "project_id", "-created_at"], name="ppm_git_audit_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitaudit",
            index=models.Index(fields=["actor_id", "-created_at"], name="ppm_git_audit_actor_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitaudit",
            index=models.Index(fields=["action", "-created_at"], name="ppm_git_audit_action_idx"),
        ),
    ]
