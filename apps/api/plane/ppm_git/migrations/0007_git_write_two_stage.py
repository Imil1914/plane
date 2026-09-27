import django.db.models.deletion
from django.db import migrations, models


SUPERSEDED_CODE = "GIT_WRITE_FLOW_SUPERSEDED"
SUPERSEDED_MESSAGE = (
    "Порядок записи в Git изменён: ветка и черновик PR подтверждаются отдельно. "
    "Это предложение закрыто — подготовьте новый предпросмотр ветки."
)
STASH_KEY = "superseded_from_status"
STASH_ERROR_KEY = "superseded_from_error"


def close_open_legacy_proposals(apps, schema_editor):
    """Open single-step proposals had no exact base SHA, so they must never be applied: close them visibly.

    The previous status is kept in ``result`` so the reverse migration restores the rows exactly.
    """
    action_model = apps.get_model("ppm_git", "PpmGitWriteAction")
    legacy = action_model.objects.filter(
        action_type="create_branch_draft_pr",
        status__in=["proposed", "approved"],
    )
    for action in legacy.iterator():
        result = dict(action.result) if isinstance(action.result, dict) else {}
        result[STASH_KEY] = action.status
        if action.error_code or action.error_message:
            result[STASH_ERROR_KEY] = {"code": action.error_code, "message": action.error_message}
        action.result = result
        action.status = "cancelled"
        action.error_code = SUPERSEDED_CODE
        action.error_message = SUPERSEDED_MESSAGE
        action.save(update_fields=["result", "status", "error_code", "error_message", "updated_at"])


def reopen_legacy_proposals(apps, schema_editor):
    action_model = apps.get_model("ppm_git", "PpmGitWriteAction")
    closed = action_model.objects.filter(
        action_type="create_branch_draft_pr",
        status="cancelled",
        error_code=SUPERSEDED_CODE,
    )
    for action in closed.iterator():
        result = dict(action.result) if isinstance(action.result, dict) else {}
        previous = result.pop(STASH_KEY, "proposed")
        previous_error = result.pop(STASH_ERROR_KEY, None)
        if not isinstance(previous_error, dict):
            previous_error = {}
        action.result = result
        action.status = previous if previous in {"proposed", "approved"} else "proposed"
        action.error_code = str(previous_error.get("code", ""))[:64]
        action.error_message = str(previous_error.get("message", ""))[:500]
        action.save(update_fields=["result", "status", "error_code", "error_message", "updated_at"])


class Migration(migrations.Migration):
    """G1.3 (RC-C): two-stage Git write flow (branch → first push → draft PR), apply fencing and cancel.

    Forward-compatible with the previous application version: every new column is nullable or has a database
    default, so an app-only rollback can still read and insert write actions. Fully reversible.
    """

    dependencies = [
        ("ppm_git", "0006_git_object_provider_merged_at"),
    ]

    operations = [
        migrations.AlterField(
            model_name="ppmgitwriteaction",
            name="action_type",
            field=models.CharField(
                choices=[
                    ("create_branch", "Create branch"),
                    ("create_draft_pr", "Create draft pull request"),
                    ("create_branch_draft_pr", "Legacy: branch and draft pull request in one proposal"),
                ],
                default="create_branch",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="parent_action",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="follow_up_actions",
                to="ppm_git.ppmgitwriteaction",
            ),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="base_sha",
            field=models.CharField(blank=True, db_default="", default="", max_length=64),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="head_sha",
            field=models.CharField(blank=True, db_default="", default="", max_length=64),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="apply_attempts",
            field=models.PositiveIntegerField(db_default=0, default=0),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="apply_fence",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="apply_started_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="retry_after",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="cancelled_by",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmgitwriteaction",
            name="cancelled_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(close_open_legacy_proposals, reopen_legacy_proposals),
    ]
