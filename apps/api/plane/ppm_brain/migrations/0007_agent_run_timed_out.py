from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_brain", "0006_agent_foundation")]

    operations = [
        migrations.AlterField(
            model_name="ppmagentrun",
            name="status",
            field=models.CharField(
                choices=[
                    ("queued", "Queued"),
                    ("running", "Running"),
                    ("awaiting_approval", "Awaiting approval"),
                    ("applying", "Applying"),
                    ("completed", "Completed"),
                    ("failed", "Failed"),
                    ("timed_out", "Timed out"),
                    ("cancelled", "Cancelled"),
                    ("rejected", "Rejected"),
                ],
                default="queued",
                max_length=24,
            ),
        )
    ]
