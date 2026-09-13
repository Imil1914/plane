import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="PpmProjectCanvas",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("name", models.CharField(default="Мозг проекта", max_length=255)),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("archived", "Archived")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("current_version", models.PositiveIntegerField(default=0)),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "ppm_project_canvases"},
        ),
        migrations.CreateModel(
            name="PpmCanvasVersion",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("version", models.PositiveIntegerField()),
                ("schema_version", models.PositiveSmallIntegerField(default=1)),
                ("snapshot_json", models.JSONField()),
                ("content_hash", models.CharField(max_length=64)),
                ("client_operation_id", models.UUIDField()),
                ("request_id", models.UUIDField()),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "canvas",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="versions",
                        to="ppm_canvas.ppmprojectcanvas",
                    ),
                ),
            ],
            options={"db_table": "ppm_canvas_versions", "ordering": ("-version",)},
        ),
        migrations.AddConstraint(
            model_name="ppmprojectcanvas",
            constraint=models.CheckConstraint(
                condition=models.Q(("current_version__gte", 0)), name="ppm_canvas_version_nonnegative"
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmprojectcanvas",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "active")),
                fields=("project_id",),
                name="ppm_canvas_unique_active_project",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmprojectcanvas",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_canvas_scope_idx"),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasversion",
            constraint=models.CheckConstraint(
                condition=models.Q(("version__gte", 1)), name="ppm_canvas_saved_version_positive"
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasversion",
            constraint=models.UniqueConstraint(fields=("canvas", "version"), name="ppm_canvas_unique_version"),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasversion",
            constraint=models.UniqueConstraint(
                fields=("canvas", "client_operation_id"), name="ppm_canvas_unique_operation"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasversion",
            index=models.Index(fields=["canvas", "-version"], name="ppm_canvas_version_idx"),
        ),
    ]
