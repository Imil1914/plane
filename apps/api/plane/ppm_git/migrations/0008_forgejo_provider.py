# G2.1 R3: the provider value `forgejo` (PPM's own Git server). Choices only — no column, index or data changes.

from django.db import migrations, models


PROVIDER_CHOICES = [
    ("github", "GitHub"),
    ("forgejo", "Forgejo"),
    ("gitlab", "GitLab"),
    ("bitbucket", "Bitbucket"),
    ("gitea", "Gitea"),
    ("generic", "Generic Git"),
]


class Migration(migrations.Migration):
    dependencies = [
        ("ppm_git", "0007_git_write_two_stage"),
    ]

    operations = [
        migrations.AlterField(
            model_name="ppmgitconnectstate",
            name="provider",
            field=models.CharField(choices=PROVIDER_CHOICES, default="github", max_length=24),
        ),
        migrations.AlterField(
            model_name="ppmgitdelivery",
            name="provider",
            field=models.CharField(choices=PROVIDER_CHOICES, default="github", max_length=24),
        ),
        migrations.AlterField(
            model_name="ppmgitinstallation",
            name="provider",
            field=models.CharField(choices=PROVIDER_CHOICES, default="github", max_length=24),
        ),
        migrations.AlterField(
            model_name="ppmgitrepository",
            name="provider",
            field=models.CharField(choices=PROVIDER_CHOICES, default="generic", max_length=24),
        ),
    ]
