from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_canvas", "0006_content_bindings")]

    operations = [
        migrations.AddField(
            model_name="ppmcanvassemanticedge",
            name="confirmation_status",
            field=models.CharField(
                choices=[
                    ("proposed", "Proposed"),
                    ("confirmed", "Confirmed"),
                    ("rejected", "Rejected"),
                ],
                default="confirmed",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="ppmcanvassemanticedge",
            name="confirmed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmcanvassemanticedge",
            name="confirmed_by",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name="ppmcanvassemanticedge",
            index=models.Index(
                fields=["workspace_id", "project_id", "confirmation_status"],
                name="ppm_edge_confirmed_idx",
            ),
        ),
    ]
