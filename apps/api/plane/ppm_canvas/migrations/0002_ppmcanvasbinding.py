import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ppm_canvas", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="ppmcanvasversion",
            name="binding_changes_fingerprint",
            field=models.CharField(
                blank=True,
                default="ae3a6b5d50c247e7eceff49fb20552796da57b656a15cde6530847d9c009502b",
                max_length=64,
            ),
        ),
        migrations.CreateModel(
            name="PpmCanvasBinding",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("shape_id", models.CharField(max_length=255)),
                (
                    "entity_type",
                    models.CharField(choices=[("work_item", "Work item")], max_length=32),
                ),
                ("entity_id", models.UUIDField()),
                (
                    "status",
                    models.CharField(
                        choices=[("pending", "Pending"), ("active", "Active")],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("source_version", models.CharField(blank=True, max_length=64, null=True)),
                ("client_operation_id", models.UUIDField()),
                ("operation_fingerprint", models.CharField(max_length=64)),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "canvas",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="bindings",
                        to="ppm_canvas.ppmprojectcanvas",
                    ),
                ),
            ],
            options={"db_table": "ppm_canvas_bindings", "ordering": ("created_at", "id")},
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasbinding",
            constraint=models.UniqueConstraint(
                fields=("canvas", "shape_id", "entity_type", "entity_id"),
                name="ppm_binding_unique_projection",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasbinding",
            constraint=models.UniqueConstraint(fields=("canvas", "shape_id"), name="ppm_binding_unique_shape"),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasbinding",
            constraint=models.UniqueConstraint(
                fields=("canvas", "client_operation_id"),
                name="ppm_binding_unique_operation",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasbinding",
            index=models.Index(
                fields=["workspace_id", "project_id", "entity_type", "entity_id"],
                name="ppm_binding_source_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasbinding",
            index=models.Index(fields=["canvas", "shape_id"], name="ppm_binding_shape_idx"),
        ),
    ]
