import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def create_default_boards(apps, schema_editor):
    Canvas = apps.get_model("ppm_canvas", "PpmProjectCanvas")
    Board = apps.get_model("ppm_canvas", "PpmCanvasBoard")
    Version = apps.get_model("ppm_canvas", "PpmCanvasVersion")
    Binding = apps.get_model("ppm_canvas", "PpmCanvasBinding")

    for canvas in Canvas.objects.all().iterator():
        board_id = uuid.uuid5(uuid.NAMESPACE_URL, f"ppm:canvas:{canvas.id}:default-board")
        operation_id = uuid.uuid5(uuid.NAMESPACE_URL, f"ppm:canvas:{canvas.id}:default-board-operation")
        board, _ = Board.objects.get_or_create(
            id=board_id,
            defaults={
                "workspace_id": canvas.workspace_id,
                "project_id": canvas.project_id,
                "canvas_id": canvas.id,
                "name": "Главная",
                "normalized_name": "главная",
                "position": 0,
                "status": "active",
                "current_version": canvas.current_version,
                "created_operation_id": operation_id,
                "created_by": canvas.created_by,
                "updated_by": canvas.created_by,
            },
        )
        Version.objects.filter(canvas_id=canvas.id, board_id__isnull=True).update(board_id=board.id)
        Binding.objects.filter(canvas_id=canvas.id, board_id__isnull=True).update(board_id=board.id)
        Canvas.objects.filter(id=canvas.id).update(default_board_id=board.id)


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("ppm_canvas", "0002_ppmcanvasbinding"),
    ]

    operations = [
        migrations.CreateModel(
            name="PpmGlobalAdmin",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("reason", models.CharField(max_length=255)),
                ("created_by", models.UUIDField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("revoked_by", models.UUIDField(blank=True, null=True)),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="ppm_global_admin",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "ppm_global_admins"},
        ),
        migrations.AddIndex(
            model_name="ppmglobaladmin",
            index=models.Index(fields=["user", "revoked_at"], name="ppm_global_admin_active_idx"),
        ),
        migrations.CreateModel(
            name="PpmGlobalAdminAudit",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField()),
                ("project_id", models.UUIDField()),
                ("method", models.CharField(max_length=16)),
                ("path", models.CharField(max_length=500)),
                ("request_id", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "global_admin",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="audit_events",
                        to="ppm_canvas.ppmglobaladmin",
                    ),
                ),
            ],
            options={"db_table": "ppm_global_admin_audit"},
        ),
        migrations.AddIndex(
            model_name="ppmglobaladminaudit",
            index=models.Index(fields=["global_admin", "-created_at"], name="ppm_admin_audit_actor_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmglobaladminaudit",
            index=models.Index(
                fields=["workspace_id", "project_id", "-created_at"], name="ppm_admin_audit_scope_idx"
            ),
        ),
        migrations.CreateModel(
            name="PpmGlobalAdminRoleAudit",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "action",
                    models.CharField(choices=[("grant", "Grant"), ("revoke", "Revoke")], max_length=16),
                ),
                ("reason", models.CharField(max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "actor_user",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="ppm_global_admin_actions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "target_user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="ppm_global_admin_role_events",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "ppm_global_admin_role_audit"},
        ),
        migrations.AddIndex(
            model_name="ppmglobaladminroleaudit",
            index=models.Index(fields=["target_user", "-created_at"], name="ppm_admin_role_target_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmglobaladminroleaudit",
            index=models.Index(fields=["actor_user", "-created_at"], name="ppm_admin_role_actor_idx"),
        ),
        migrations.CreateModel(
            name="PpmCanvasBoard",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("name", models.CharField(max_length=120)),
                ("normalized_name", models.CharField(max_length=120)),
                ("position", models.PositiveIntegerField()),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "Active"), ("archived", "Archived")],
                        default="active",
                        max_length=16,
                    ),
                ),
                ("current_version", models.PositiveIntegerField(default=0)),
                ("created_operation_id", models.UUIDField()),
                ("created_by", models.UUIDField()),
                ("updated_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("archived_at", models.DateTimeField(blank=True, null=True)),
                (
                    "canvas",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="boards",
                        to="ppm_canvas.ppmprojectcanvas",
                    ),
                ),
            ],
            options={"db_table": "ppm_canvas_boards", "ordering": ("position", "created_at", "id")},
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasboard",
            constraint=models.CheckConstraint(
                condition=models.Q(("current_version__gte", 0)), name="ppm_board_version_nonnegative"
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasboard",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "active")),
                fields=("canvas", "normalized_name"),
                name="ppm_board_unique_active_name",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasboard",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "active")),
                fields=("canvas", "position"),
                name="ppm_board_unique_active_pos",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasboard",
            constraint=models.UniqueConstraint(
                fields=("canvas", "created_operation_id"), name="ppm_board_unique_create_op"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasboard",
            index=models.Index(fields=["workspace_id", "project_id", "status"], name="ppm_board_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasboard",
            index=models.Index(fields=["canvas", "status", "position"], name="ppm_board_order_idx"),
        ),
        migrations.AddField(
            model_name="ppmprojectcanvas",
            name="default_board",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="default_for_canvases",
                to="ppm_canvas.ppmcanvasboard",
            ),
        ),
        migrations.CreateModel(
            name="PpmCanvasOperation",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("operation_type", models.CharField(max_length=32)),
                ("client_operation_id", models.UUIDField()),
                ("operation_fingerprint", models.CharField(max_length=64)),
                ("result_json", models.JSONField(default=dict)),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "board",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        to="ppm_canvas.ppmcanvasboard",
                    ),
                ),
                (
                    "canvas",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="operations",
                        to="ppm_canvas.ppmprojectcanvas",
                    ),
                ),
            ],
            options={"db_table": "ppm_canvas_operations"},
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasoperation",
            constraint=models.UniqueConstraint(
                fields=("canvas", "client_operation_id"), name="ppm_canvas_unique_lifecycle_op"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasoperation",
            index=models.Index(fields=["canvas", "-created_at"], name="ppm_canvas_operation_idx"),
        ),
        migrations.AddField(
            model_name="ppmcanvasversion",
            name="board",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="versions",
                to="ppm_canvas.ppmcanvasboard",
            ),
        ),
        migrations.AddField(
            model_name="ppmcanvasbinding",
            name="board",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="bindings",
                to="ppm_canvas.ppmcanvasboard",
            ),
        ),
        migrations.RunPython(create_default_boards, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="ppmcanvasversion",
            name="board",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="versions",
                to="ppm_canvas.ppmcanvasboard",
            ),
        ),
        migrations.AlterField(
            model_name="ppmcanvasbinding",
            name="board",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="bindings",
                to="ppm_canvas.ppmcanvasboard",
            ),
        ),
        migrations.RemoveConstraint(model_name="ppmcanvasversion", name="ppm_canvas_unique_version"),
        migrations.RemoveConstraint(model_name="ppmcanvasversion", name="ppm_canvas_unique_operation"),
        migrations.RemoveIndex(model_name="ppmcanvasversion", name="ppm_canvas_version_idx"),
        migrations.AddConstraint(
            model_name="ppmcanvasversion",
            constraint=models.UniqueConstraint(fields=("board", "version"), name="ppm_board_unique_version"),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasversion",
            constraint=models.UniqueConstraint(
                fields=("board", "client_operation_id"), name="ppm_board_unique_operation"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasversion",
            index=models.Index(fields=["board", "-version"], name="ppm_board_version_idx"),
        ),
        migrations.RemoveConstraint(model_name="ppmcanvasbinding", name="ppm_binding_unique_projection"),
        migrations.RemoveConstraint(model_name="ppmcanvasbinding", name="ppm_binding_unique_shape"),
        migrations.RemoveConstraint(model_name="ppmcanvasbinding", name="ppm_binding_unique_operation"),
        migrations.RemoveIndex(model_name="ppmcanvasbinding", name="ppm_binding_shape_idx"),
        migrations.AddConstraint(
            model_name="ppmcanvasbinding",
            constraint=models.UniqueConstraint(
                fields=("board", "shape_id", "entity_type", "entity_id"),
                name="ppm_binding_unique_projection",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasbinding",
            constraint=models.UniqueConstraint(fields=("board", "shape_id"), name="ppm_binding_unique_shape"),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvasbinding",
            constraint=models.UniqueConstraint(
                fields=("board", "client_operation_id"), name="ppm_binding_unique_operation"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvasbinding",
            index=models.Index(fields=["board", "shape_id"], name="ppm_binding_shape_idx"),
        ),
        migrations.CreateModel(
            name="PpmCanvasSemanticEdge",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.UUIDField(db_index=True)),
                ("project_id", models.UUIDField(db_index=True)),
                ("from_shape_id", models.CharField(max_length=255)),
                ("to_shape_id", models.CharField(max_length=255)),
                (
                    "relation_type",
                    models.CharField(
                        choices=[
                            ("relates_to", "Relates to"),
                            ("depends_on", "Depends on"),
                            ("blocks", "Blocks"),
                            ("explains", "Explains"),
                            ("implements", "Implements"),
                            ("evidence_for", "Evidence for"),
                            ("contradicts", "Contradicts"),
                            ("derived_from", "Derived from"),
                            ("result_of", "Result of"),
                        ],
                        max_length=32,
                    ),
                ),
                ("label", models.CharField(blank=True, max_length=255, null=True)),
                ("confidence", models.DecimalField(blank=True, decimal_places=4, max_digits=5, null=True)),
                (
                    "origin",
                    models.CharField(
                        choices=[("user", "User"), ("agent", "Agent"), ("import", "Import")],
                        default="user",
                        max_length=16,
                    ),
                ),
                ("client_operation_id", models.UUIDField()),
                ("created_by", models.UUIDField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "board",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="semantic_edges",
                        to="ppm_canvas.ppmcanvasboard",
                    ),
                ),
                (
                    "canvas",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="semantic_edges",
                        to="ppm_canvas.ppmprojectcanvas",
                    ),
                ),
            ],
            options={"db_table": "ppm_semantic_edges", "ordering": ("created_at", "id")},
        ),
        migrations.AddConstraint(
            model_name="ppmcanvassemanticedge",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("confidence__isnull", True),
                    models.Q(("confidence__gte", 0), ("confidence__lte", 1)),
                    _connector="OR",
                ),
                name="ppm_edge_confidence_range",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvassemanticedge",
            constraint=models.UniqueConstraint(
                fields=("board", "from_shape_id", "to_shape_id", "relation_type"),
                name="ppm_edge_unique_relation",
            ),
        ),
        migrations.AddConstraint(
            model_name="ppmcanvassemanticedge",
            constraint=models.UniqueConstraint(
                fields=("board", "client_operation_id"), name="ppm_edge_unique_operation"
            ),
        ),
        migrations.AddIndex(
            model_name="ppmcanvassemanticedge",
            index=models.Index(fields=["workspace_id", "project_id", "board"], name="ppm_edge_scope_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmcanvassemanticedge",
            index=models.Index(fields=["board", "from_shape_id"], name="ppm_edge_from_shape_idx"),
        ),
        migrations.AddIndex(
            model_name="ppmcanvassemanticedge",
            index=models.Index(fields=["board", "to_shape_id"], name="ppm_edge_to_shape_idx"),
        ),
    ]
