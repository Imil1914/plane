from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_canvas", "0004_global_admin_center_audit")]

    operations = [
        migrations.AlterField(
            model_name="ppmcanvasversion",
            name="schema_version",
            field=models.PositiveSmallIntegerField(default=2),
        ),
    ]
