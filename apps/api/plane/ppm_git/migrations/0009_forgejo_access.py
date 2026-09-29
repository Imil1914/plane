# G2.2 B (R8–R16): accounts, organizations, teams and synchronization runs of the Git server access engine
# (`ppm_git.forgejo_access`). Additive: four new tables; the audit table only stops requiring an actor, a workspace
# and a project — the engine records what it does itself (actor empty) and account-wide events (no workspace or
# project). Existing rows and writers are unchanged. Unapplying first gives such rows the zero UUID, so NOT NULL
# comes back.

import uuid

from django.db import migrations, models


SYSTEM = uuid.UUID(int=0)


def restore_required_audit_fields(apps, schema_editor):
    audit_model = apps.get_model("ppm_git", "PpmGitAudit")
    for field in ("actor_id", "workspace_id", "project_id"):
        audit_model.objects.filter(**{f"{field}__isnull": True}).update(**{field: SYSTEM})


class Migration(migrations.Migration):
    dependencies = [
        ("ppm_git", "0008_forgejo_provider"),
    ]

    operations = [
        migrations.AlterField(
            model_name="ppmgitaudit",
            name="actor_id",
            field=models.UUIDField(blank=True, db_index=True, null=True),
        ),
        migrations.AlterField(
            model_name="ppmgitaudit",
            name="project_id",
            field=models.UUIDField(blank=True, db_index=True, null=True),
        ),
        migrations.AlterField(
            model_name="ppmgitaudit",
            name="workspace_id",
            field=models.UUIDField(blank=True, db_index=True, null=True),
        ),
        migrations.RunPython(migrations.RunPython.noop, restore_required_audit_fields),
        migrations.CreateModel(
            name="PpmForgejoAccount",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("user_id", models.UUIDField(unique=True)),
                ("forgejo_user_id", models.BigIntegerField(unique=True)),
                ("username", models.CharField(max_length=40, unique=True)),
                ("adopted", models.BooleanField(default=False)),
                ("prohibited", models.BooleanField(default=False)),
                ("admin_granted", models.BooleanField(default=False)),
                ("last_synced_at", models.DateTimeField(blank=True, null=True)),
                ("last_error_code", models.CharField(blank=True, default="", max_length=64)),
                ("last_error_message", models.CharField(blank=True, default="", max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "ppm_forgejo_accounts",
                "ordering": ("username", "id"),
            },
        ),
        migrations.CreateModel(
            name="PpmForgejoOrganization",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(unique=True)),
                ("forgejo_org_id", models.BigIntegerField(unique=True)),
                ("name", models.CharField(max_length=40)),
                ("adopted", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "ppm_forgejo_organizations",
                "ordering": ("name", "id"),
            },
        ),
        migrations.CreateModel(
            name="PpmForgejoSyncRun",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("kind", models.CharField(choices=[("full", "Full"), ("scoped", "Scoped")], max_length=8)),
                (
                    "status",
                    models.CharField(
                        choices=[("ok", "Ok"), ("partial", "Partial"), ("error", "Error")],
                        max_length=8,
                    ),
                ),
                ("started_at", models.DateTimeField()),
                ("finished_at", models.DateTimeField()),
                ("counts", models.JSONField(blank=True, default=dict)),
                ("problems", models.JSONField(blank=True, default=list)),
            ],
            options={
                "db_table": "ppm_forgejo_sync_runs",
                "ordering": ("-started_at", "id"),
                "indexes": [models.Index(fields=["kind", "-started_at"], name="ppm_forgejo_sync_kind_idx")],
            },
        ),
        migrations.CreateModel(
            name="PpmForgejoTeam",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                (
                    "role",
                    models.CharField(
                        choices=[("admin", "Admin"), ("write", "Write"), ("read", "Read")],
                        max_length=8,
                    ),
                ),
                ("forgejo_team_id", models.BigIntegerField(unique=True)),
                ("name", models.CharField(max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "ppm_forgejo_teams",
                "ordering": ("name", "id"),
                "constraints": [
                    models.UniqueConstraint(fields=("project_id", "role"), name="ppm_forgejo_team_role_uniq")
                ],
            },
        ),
    ]
