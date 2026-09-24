from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_canvas", "0007_semantic_edge_confirmation")]

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
                    ("repository", "Repository"),
                    ("branch", "Branch"),
                    ("commit", "Commit"),
                    ("pull_request", "Pull request"),
                ],
                max_length=32,
            ),
        ),
    ]
