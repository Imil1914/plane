import logging
import uuid

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer


logger = logging.getLogger("plane.api")


def canvas_presence_group_name(*, project_id, board_id):
    return f"ppm.canvas.{uuid.UUID(str(project_id)).hex}.{uuid.UUID(str(board_id)).hex}"


def broadcast_canvas_board_changed(
    *,
    project_id,
    board_id,
    version,
    content_hash,
    saved_at,
    saved_by,
    client_operation_id,
):
    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning(
            "PPM Canvas realtime event skipped because no channel layer is configured",
            extra={"project_id": str(project_id), "board_id": str(board_id), "version": version},
        )
        return
    async_to_sync(channel_layer.group_send)(
        canvas_presence_group_name(project_id=project_id, board_id=board_id),
        {
            "type": "canvas.board.changed",
            "board_id": str(board_id),
            "version": version,
            "content_hash": content_hash,
            "saved_at": saved_at.isoformat(),
            "saved_by": str(saved_by),
            "client_operation_id": str(client_operation_id),
        },
    )
