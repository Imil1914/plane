from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_canvas", "0005_canvas_schema_v2")]

    operations = [
        migrations.AlterField(
            model_name="ppmcanvasbinding",
            name="entity_type",
            field=models.CharField(
                choices=[
                    ("work_item", "Work item"),
                    ("page", "Page"),
                    ("attachment", "Attachment"),
                    ("vault_file", "Vault file"),
                ],
                max_length=32,
            ),
        ),
    ]
