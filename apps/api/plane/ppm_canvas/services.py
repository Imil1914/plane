from dataclasses import dataclass

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import serializers

from .models import PpmCanvasStatus, PpmCanvasVersion, PpmProjectCanvas
from .schema import PPM_CANVAS_SCHEMA_VERSION, canvas_snapshot_hash, validate_canvas_snapshot


@dataclass(frozen=True)
class PpmCanvasConflict(Exception):
    code: str
    message: str
    details: dict


def get_or_create_active_canvas(*, workspace_id, project_id, user_id):
    try:
        with transaction.atomic():
            return PpmProjectCanvas.objects.get_or_create(
                project_id=project_id,
                status=PpmCanvasStatus.ACTIVE,
                defaults={"workspace_id": workspace_id, "created_by": user_id},
            )[0]
    except IntegrityError:
        return PpmProjectCanvas.objects.get(project_id=project_id, status=PpmCanvasStatus.ACTIVE)


def get_canvas_payload(*, canvas, access):
    payload = {
        "canvas_id": str(canvas.id),
        "workspace_id": str(canvas.workspace_id),
        "project_id": str(canvas.project_id),
        "name": canvas.name,
        "schema_version": PPM_CANVAS_SCHEMA_VERSION,
        "version": canvas.current_version,
        "snapshot": None,
        "snapshot_status": "empty",
        "content_hash": None,
        "saved_at": None,
        "saved_by": None,
        "access": access.value,
    }
    if canvas.current_version == 0:
        return payload

    current = PpmCanvasVersion.objects.filter(canvas=canvas, version=canvas.current_version).first()
    if current is None:
        payload["snapshot_status"] = "corrupt"
        return payload

    try:
        validate_canvas_snapshot(current.snapshot_json)
        current_hash = canvas_snapshot_hash(current.snapshot_json)
    except serializers.ValidationError:
        payload["snapshot_status"] = "corrupt"
        return payload

    if current.schema_version != PPM_CANVAS_SCHEMA_VERSION or current_hash != current.content_hash:
        payload["snapshot_status"] = "corrupt"
        return payload

    payload.update(
        {
            "snapshot": current.snapshot_json,
            "snapshot_status": "ready",
            "content_hash": current.content_hash,
            "saved_at": current.created_at.isoformat(),
            "saved_by": str(current.created_by),
        }
    )
    return payload


def save_canvas_snapshot(
    *,
    canvas,
    user_id,
    request_id,
    base_version,
    schema_version,
    snapshot,
    client_operation_id,
):
    content_hash = canvas_snapshot_hash(snapshot)
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=canvas.pk)
        existing = PpmCanvasVersion.objects.filter(
            canvas=locked_canvas,
            client_operation_id=client_operation_id,
        ).first()
        if existing is not None:
            if existing.content_hash != content_hash or existing.schema_version != schema_version:
                raise PpmCanvasConflict(
                    code="CANVAS_OPERATION_REUSED",
                    message="Идентификатор сохранения уже использован для другого снимка.",
                    details={"current_version": locked_canvas.current_version},
                )
            return locked_canvas, existing, True

        if locked_canvas.current_version != base_version:
            raise PpmCanvasConflict(
                code="CANVAS_VERSION_CONFLICT",
                message="Холст был изменён другим участником.",
                details={"current_version": locked_canvas.current_version},
            )

        saved_version = PpmCanvasVersion.objects.create(
            canvas=locked_canvas,
            version=locked_canvas.current_version + 1,
            schema_version=schema_version,
            snapshot_json=snapshot,
            content_hash=content_hash,
            client_operation_id=client_operation_id,
            request_id=request_id,
            created_by=user_id,
        )
        locked_canvas.current_version = saved_version.version
        locked_canvas.updated_at = timezone.now()
        locked_canvas.save(update_fields=["current_version", "updated_at"])
        return locked_canvas, saved_version, False
