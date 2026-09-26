from django.db import migrations, models


class Migration(migrations.Migration):
    """AF2.2 S2a: время слияния PR. Столбец допускает NULL — старые строки не заполняются: reconcile (раз в 15 минут)
    перечитывает PR у провайдера вместе с `merged_at`. Обратная миграция удаляет столбец."""

    dependencies = [
        ("ppm_git", "0005_git_write_action_preview"),
    ]

    operations = [
        migrations.AddField(
            model_name="ppmgitobject",
            name="provider_merged_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
