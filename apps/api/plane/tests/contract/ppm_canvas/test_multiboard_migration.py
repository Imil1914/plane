import uuid

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from django.test import override_settings


pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


MIGRATE_FROM = [("ppm_canvas", "0002_ppmcanvasbinding")]
MIGRATE_TO = [("ppm_canvas", "0003_multiboard_and_global_admin")]


def ensure_synced_test_schema_is_recorded():
    """Teach MigrationExecutor about tables created by pytest --nomigrations."""
    recorder = MigrationRecorder(connection)
    applied = recorder.applied_migrations()
    if "ppm_project_canvases" not in connection.introspection.table_names():
        return
    if ("contenttypes", "0001_initial") not in applied:
        executor = MigrationExecutor(connection)
        for app_label, migration_name in executor.loader.graph.nodes:
            recorder.record_applied(app_label, migration_name)
        return
    if ("ppm_canvas", "0001_initial") not in applied:
        executor = MigrationExecutor(connection)
        for app_label, migration_name in executor.loader.graph.nodes:
            if app_label == "ppm_canvas":
                recorder.record_applied(app_label, migration_name)


@override_settings(MIGRATION_MODULES={"ppm_canvas": "plane.ppm_canvas.migrations"})
def test_existing_canvas_history_migrates_idempotently_to_default_board():
    ensure_synced_test_schema_is_recorded()
    executor = MigrationExecutor(connection)
    executor.migrate(MIGRATE_FROM)
    old_apps = executor.loader.project_state(MIGRATE_FROM).apps
    Canvas = old_apps.get_model("ppm_canvas", "PpmProjectCanvas")
    Version = old_apps.get_model("ppm_canvas", "PpmCanvasVersion")
    Binding = old_apps.get_model("ppm_canvas", "PpmCanvasBinding")

    workspace_id = uuid.uuid4()
    project_id = uuid.uuid4()
    user_id = uuid.uuid4()
    canvas = Canvas.objects.create(
        workspace_id=workspace_id,
        project_id=project_id,
        created_by=user_id,
        current_version=1,
    )
    version = Version.objects.create(
        canvas=canvas,
        version=1,
        schema_version=1,
        snapshot_json={
            "document": {
                "store": {
                    "shape:legacy": {
                        "id": "shape:legacy",
                        "typeName": "shape",
                        "type": "ppm-canvas-node",
                    }
                }
            }
        },
        content_hash="a" * 64,
        client_operation_id=uuid.uuid4(),
        request_id=uuid.uuid4(),
        created_by=user_id,
    )
    binding = Binding.objects.create(
        workspace_id=workspace_id,
        project_id=project_id,
        canvas=canvas,
        shape_id="shape:legacy",
        entity_type="work_item",
        entity_id=uuid.uuid4(),
        status="active",
        client_operation_id=uuid.uuid4(),
        operation_fingerprint="b" * 64,
        created_by=user_id,
    )

    try:
        executor = MigrationExecutor(connection)
        executor.migrate(MIGRATE_TO)
        new_apps = executor.loader.project_state(MIGRATE_TO).apps
        NewCanvas = new_apps.get_model("ppm_canvas", "PpmProjectCanvas")
        Board = new_apps.get_model("ppm_canvas", "PpmCanvasBoard")
        NewVersion = new_apps.get_model("ppm_canvas", "PpmCanvasVersion")
        NewBinding = new_apps.get_model("ppm_canvas", "PpmCanvasBinding")

        migrated_canvas = NewCanvas.objects.get(id=canvas.id)
        board = Board.objects.get(canvas_id=canvas.id)
        assert board.name == "Главная"
        assert board.current_version == 1
        assert migrated_canvas.default_board_id == board.id
        assert NewVersion.objects.get(id=version.id).board_id == board.id
        assert NewBinding.objects.get(id=binding.id).board_id == board.id

        executor = MigrationExecutor(connection)
        executor.migrate(MIGRATE_TO)
        assert Board.objects.filter(canvas_id=canvas.id).count() == 1
        assert NewVersion.objects.filter(id=version.id).count() == 1
        assert NewBinding.objects.filter(id=binding.id).count() == 1
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes("ppm_canvas"))

    assert all(
        migration in MigrationRecorder(connection).applied_migrations()
        for migration in MigrationExecutor(connection).loader.graph.leaf_nodes("ppm_canvas")
    )
