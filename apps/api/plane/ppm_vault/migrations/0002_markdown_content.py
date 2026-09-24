from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_vault", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="ppmvaultversion",
            name="content_text",
            field=models.TextField(blank=True, default=""),
        )
    ]
