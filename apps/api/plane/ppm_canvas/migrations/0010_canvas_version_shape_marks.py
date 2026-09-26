from django.db import migrations, models


class Migration(migrations.Migration):
    """AF2.2 S2a: отметки версий доски для ленты «Что изменилось». Столбцы допускают NULL — старые версии не
    заполняются (лента для них ищет время по истории, как раньше). Обратная миграция удаляет столбцы."""

    dependencies = [
        ("ppm_canvas", "0009_board_user_state"),
    ]

    operations = [
        migrations.AddField(
            model_name="ppmcanvasversion",
            name="added_shape_ids",
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="ppmcanvasversion",
            name="changed_shape_ids",
            field=models.JSONField(blank=True, null=True),
        ),
    ]
