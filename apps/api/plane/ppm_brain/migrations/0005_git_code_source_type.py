from django.db import migrations, models


SOURCE_CHOICES = [
    ("work_item", "Work item"),
    ("vault_file", "Vault file"),
    ("git_code", "Git code"),
]


class Migration(migrations.Migration):
    dependencies = [("ppm_brain", "0004_graph_memory")]

    operations = [
        migrations.AlterField(
            model_name="ppmknowledgesource",
            name="source_type",
            field=models.CharField(choices=SOURCE_CHOICES, max_length=32),
        ),
        migrations.AlterField(
            model_name="ppmprojectmemorysourcereference",
            name="source_type",
            field=models.CharField(choices=SOURCE_CHOICES, max_length=32),
        ),
    ]
