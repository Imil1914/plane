from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("ppm_git", "0002_ppmgitconnection_ppmgitconnectstate_ppmgitdelivery_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="ppmgitconnectstate",
            name="provider_installation_id",
            field=models.BigIntegerField(blank=True, null=True),
        ),
    ]
