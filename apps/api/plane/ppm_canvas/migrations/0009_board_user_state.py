import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("ppm_canvas", "0008_git_projection_entity_types"),
    ]

    operations = [
        migrations.CreateModel(
            name="PpmCanvasBoardUserState",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("seen_at", models.DateTimeField()),
                ("seen_version", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "board",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="user_states",
                        to="ppm_canvas.ppmcanvasboard",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="ppm_canvas_board_states",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "ppm_canvas_board_user_states"},
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasboarduserstate",
            constraint=models.UniqueConstraint(fields=("board", "user"), name="ppm_board_user_state_unique"),
        ),
    ]
