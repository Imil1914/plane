from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_canvas", "0003_multiboard_and_global_admin")]

    operations = [
        migrations.AddField(
            model_name="ppmglobaladminaudit",
            name="action",
            field=models.CharField(default="project_access", max_length=64),
        ),
        migrations.AddField(
            model_name="ppmglobaladminaudit",
            name="metadata",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AlterField(
            model_name="ppmglobaladminaudit",
            name="project_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="ppmglobaladminaudit",
            name="workspace_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name="ppmglobaladminaudit",
            index=models.Index(fields=["action", "-created_at"], name="ppm_admin_audit_action_idx"),
        ),
    ]
