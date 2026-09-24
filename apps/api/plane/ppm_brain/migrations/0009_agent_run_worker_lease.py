from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_brain", "0008_agent_run_input_json")]

    operations = [
        migrations.AddField(
            model_name="ppmagentrun",
            name="attempt_count",
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="ppmagentrun",
            name="lease_expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmagentrun",
            name="lease_token",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmagentrun",
            name="worker_task_id",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddIndex(
            model_name="ppmagentrun",
            index=models.Index(fields=["status", "lease_expires_at"], name="ppm_agent_run_lease_idx"),
        ),
    ]
