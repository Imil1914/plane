import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_git", "0003_ppmgitconnectstate_provider_installation_id")]

    operations = [
        migrations.CreateModel(
            name="PpmGitCodeSnapshot",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("branch", models.CharField(max_length=255)),
                ("commit_sha", models.CharField(max_length=64)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("ready", "Ready"),
                            ("failed", "Failed"),
                            ("superseded", "Superseded"),
                            ("revoked", "Revoked"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("is_current", models.BooleanField(default=False)),
                ("content_hash", models.CharField(blank=True, default="", max_length=64)),
                ("file_count", models.PositiveIntegerField(default=0)),
                ("total_bytes", models.PositiveBigIntegerField(default=0)),
                ("excluded_stats", models.JSONField(blank=True, default=dict)),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_message", models.CharField(blank=True, default="", max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                (
                    "connection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="code_snapshots",
                        to="ppm_git.ppmgitconnection",
                    ),
                ),
                (
                    "repository",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="code_snapshots",
                        to="ppm_git.ppmgitrepository",
                    ),
                ),
            ],
            options={"db_table": "ppm_git_code_snapshots", "ordering": ("-created_at", "id")},
        ),
        migrations.CreateModel(
            name="PpmGitCodeFile",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("path", models.CharField(max_length=1024)),
                ("language", models.CharField(max_length=64)),
                ("content_text", models.TextField()),
                ("content_hash", models.CharField(max_length=64)),
                ("size_bytes", models.PositiveIntegerField()),
                ("line_count", models.PositiveIntegerField()),
                ("canonical_url", models.URLField(max_length=2048)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "repository",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="indexed_code_files",
                        to="ppm_git.ppmgitrepository",
                    ),
                ),
                (
                    "snapshot",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="files",
                        to="ppm_git.ppmgitcodesnapshot",
                    ),
                ),
            ],
            options={"db_table": "ppm_git_code_files", "ordering": ("path", "id")},
        ),
        migrations.CreateModel(
            name="PpmGitCodeIndexPolicy",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("enabled", models.BooleanField(default=False)),
                ("branch", models.CharField(blank=True, default="", max_length=255)),
                ("include_paths", models.JSONField(blank=True, default=list)),
                ("exclude_paths", models.JSONField(blank=True, default=list)),
                ("max_files", models.PositiveIntegerField(default=2000)),
                ("max_file_bytes", models.PositiveIntegerField(default=524288)),
                ("max_total_bytes", models.PositiveIntegerField(default=52428800)),
                ("updated_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "repository",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="code_index_policy",
                        to="ppm_git.ppmgitrepository",
                    ),
                ),
            ],
            options={
                "db_table": "ppm_git_code_index_policies",
                "indexes": [
                    models.Index(fields=["workspace_id", "project_id", "enabled"], name="ppm_git_code_policy_idx")
                ],
            },
        ),
        migrations.AddIndex(
            model_name="ppmgitcodesnapshot",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_git_code_snap_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitcodesnapshot",
            index=models.Index(fields=["repository", "is_current", "status"], name="ppm_git_code_snap_repo_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmgitcodesnapshot",
            constraint=models.UniqueConstraint(fields=("repository", "commit_sha"), name="ppm_git_code_snapshot_uniq"),
        ),
        migrations.AddConstraint(
            model_name="ppmgitcodesnapshot",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_current", True)),
                fields=("repository",),
                name="ppm_git_code_current_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmgitcodefile",
            index=models.Index(fields=["workspace_id", "project_id", "language"], name="ppm_git_code_file_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmgitcodefile",
            index=models.Index(fields=["repository", "path"], name="ppm_git_code_file_repo_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmgitcodefile",
            constraint=models.UniqueConstraint(fields=("snapshot", "path"), name="ppm_git_code_file_path_uniq"),
        ),
    ]
