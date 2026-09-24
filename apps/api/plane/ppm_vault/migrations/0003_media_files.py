from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_vault", "0002_markdown_content")]

    operations = [
        migrations.AlterField(
            model_name="ppmvaultentry",
            name="kind",
            field=models.CharField(
                choices=[
                    ("folder", "Folder"),
                    ("markdown", "Markdown"),
                    ("pdf", "PDF"),
                    ("image", "Image"),
                    ("file", "File"),
                ],
                db_column="entry_type",
                max_length=16,
            ),
        ),
    ]
