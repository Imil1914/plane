from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_brain", "0007_agent_run_timed_out")]

    operations = [
        migrations.AddField(
            model_name="ppmagentrun",
            name="input_json",
            field=models.JSONField(default=dict),
        ),
    ]
