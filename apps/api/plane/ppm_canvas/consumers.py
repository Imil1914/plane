import logging
import math
import time
import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.utils import timezone

from plane.db.models import User
from plane.ppm_core.permissions import is_ppm_global_admin

from .models import PpmCanvasBoard, PpmCanvasStatus, PpmGlobalAdmin, PpmGlobalAdminAudit
from .permissions import PpmCanvasAccess, get_ppm_canvas_access
from .realtime import canvas_presence_group_name


logger = logging.getLogger("plane.api")

PPM_PRESENCE_PROTOCOL_VERSION = 1
PPM_PRESENCE_CURSOR_MAX_ABS = 1_000_000
PPM_PRESENCE_CURSOR_MIN_INTERVAL_SECONDS = 1 / 30


class PpmCanvasPresenceConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.room_group_name = None
        self.connection_id = str(uuid.uuid4())
        self.participant = None
        self.last_cursor_broadcast_at = 0.0

        user = self.scope.get("user")
        if not user or not user.is_authenticated:
            await self.close(code=4401)
            return

        route = self.scope.get("url_route", {}).get("kwargs", {})
        self.workspace_id = route.get("workspace_id")
        self.project_id = route.get("project_id")
        self.board_id = route.get("board_id")
        if not all((self.workspace_id, self.project_id, self.board_id)):
            await self.close(code=4400)
            return

        context = await self._presence_context(user_id=user.id, audit_path=self.scope.get("path", ""))
        if context is None:
            await self.close(code=4403)
            return

        self.participant = {
            **context,
            "connection_id": self.connection_id,
            "joined_at": timezone.now().isoformat(),
        }
        self.room_group_name = canvas_presence_group_name(project_id=self.project_id, board_id=self.board_id)

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        board_version = await self._current_board_version()
        if board_version is None:
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
            await self.close(code=4403)
            return
        await self.accept()
        await self.send_json(
            {
                "type": "presence.ready",
                "protocol": PPM_PRESENCE_PROTOCOL_VERSION,
                "room": {
                    "workspace_id": str(self.workspace_id),
                    "project_id": str(self.project_id),
                    "board_id": str(self.board_id),
                },
                "self": self.participant,
                "board_version": board_version,
            }
        )
        await self.channel_layer.group_send(
            self.room_group_name,
            {"type": "presence.joined", "participant": self.participant},
        )
        await self.channel_layer.group_send(
            self.room_group_name,
            {"type": "presence.sync.request", "request_connection_id": self.connection_id},
        )

    async def disconnect(self, close_code):
        if not self.room_group_name or not self.participant:
            return
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "presence.left",
                "connection_id": self.connection_id,
                "user_id": self.participant["user_id"],
            },
        )

    async def receive_json(self, content, **kwargs):
        if not isinstance(content, dict):
            await self._send_protocol_error("INVALID_MESSAGE", "Сообщение realtime должно быть объектом.")
            return

        message_type = content.get("type")
        if message_type == "presence.heartbeat":
            if not await self._access_is_still_valid():
                await self.send_json({"type": "presence.revoked"})
                await self.close(code=4403)
                return
            # Redis expires group membership independently from the WebSocket.
            # Refresh it on every heartbeat so a healthy long-lived board keeps
            # receiving cursor and snapshot-version events.
            await self.channel_layer.group_add(self.room_group_name, self.channel_name)
            await self.send_json(
                {
                    "type": "presence.heartbeat_ack",
                    "connection_id": self.connection_id,
                    "at": timezone.now().isoformat(),
                }
            )
            return

        if message_type == "presence.cursor":
            cursor = self._validated_cursor(content.get("cursor"))
            if cursor is None:
                await self._send_protocol_error("INVALID_CURSOR", "Координаты курсора некорректны.")
                return
            now = time.monotonic()
            if now - self.last_cursor_broadcast_at < PPM_PRESENCE_CURSOR_MIN_INTERVAL_SECONDS:
                return
            self.last_cursor_broadcast_at = now
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    "type": "presence.cursor.moved",
                    "connection_id": self.connection_id,
                    "user_id": self.participant["user_id"],
                    "display_name": self.participant["display_name"],
                    "cursor": cursor,
                },
            )
            return

        await self._send_protocol_error("UNSUPPORTED_MESSAGE", "Этот тип realtime-сообщения не поддерживается.")

    async def presence_joined(self, event):
        await self.send_json({"type": "presence.joined", "participant": event["participant"]})

    async def presence_left(self, event):
        await self.send_json(
            {
                "type": "presence.left",
                "connection_id": event["connection_id"],
                "user_id": event["user_id"],
            }
        )

    async def presence_sync_request(self, event):
        request_connection_id = event.get("request_connection_id")
        if not request_connection_id or request_connection_id == self.connection_id:
            return
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "presence.sync.response",
                "target_connection_id": request_connection_id,
                "participant": self.participant,
            },
        )

    async def presence_sync_response(self, event):
        if event.get("target_connection_id") != self.connection_id:
            return
        await self.send_json({"type": "presence.snapshot", "participant": event["participant"]})

    async def presence_cursor_moved(self, event):
        if event.get("connection_id") == self.connection_id:
            return
        await self.send_json(
            {
                "type": "presence.cursor",
                "connection_id": event["connection_id"],
                "user_id": event["user_id"],
                "display_name": event["display_name"],
                "cursor": event["cursor"],
            }
        )

    async def canvas_board_changed(self, event):
        await self.send_json(
            {
                "type": "canvas.board.changed",
                "board_id": event["board_id"],
                "version": event["version"],
                "content_hash": event["content_hash"],
                "saved_at": event["saved_at"],
                "saved_by": event["saved_by"],
                "client_operation_id": event["client_operation_id"],
            }
        )

    async def _send_protocol_error(self, code, message):
        await self.send_json({"type": "presence.error", "error": {"code": code, "message": message}})

    @staticmethod
    def _validated_cursor(value):
        if not isinstance(value, dict) or set(value) - {"x", "y", "pointer_down"}:
            return None
        x = value.get("x")
        y = value.get("y")
        if (
            isinstance(x, bool)
            or isinstance(y, bool)
            or not isinstance(x, (int, float))
            or not isinstance(y, (int, float))
        ):
            return None
        if not math.isfinite(x) or not math.isfinite(y):
            return None
        if abs(x) > PPM_PRESENCE_CURSOR_MAX_ABS or abs(y) > PPM_PRESENCE_CURSOR_MAX_ABS:
            return None
        pointer_down = value.get("pointer_down", False)
        if not isinstance(pointer_down, bool):
            return None
        return {"x": float(x), "y": float(y), "pointer_down": pointer_down}

    @database_sync_to_async
    def _presence_context(self, *, user_id, audit_path):
        access = get_ppm_canvas_access(
            user=User.objects.get(id=user_id),
            workspace_id=self.workspace_id,
            project_id=self.project_id,
        )
        if access == PpmCanvasAccess.DENY:
            return None
        board_exists = PpmCanvasBoard.objects.filter(
            id=self.board_id,
            workspace_id=self.workspace_id,
            project_id=self.project_id,
            status=PpmCanvasStatus.ACTIVE,
            canvas__status=PpmCanvasStatus.ACTIVE,
        ).exists()
        if not board_exists:
            return None

        user = User.objects.select_related("avatar_asset").get(id=user_id)
        if is_ppm_global_admin(user=user):
            global_admin = PpmGlobalAdmin.objects.filter(user=user, revoked_at__isnull=True).first()
            if global_admin is not None:
                PpmGlobalAdminAudit.objects.create(
                    global_admin=global_admin,
                    action="canvas_presence_connect",
                    workspace_id=self.workspace_id,
                    project_id=self.project_id,
                    method="WS",
                    path=str(audit_path)[:500],
                    request_id=uuid.uuid4(),
                    metadata={"board_id": str(self.board_id)},
                )

        return {
            "user_id": str(user.id),
            "display_name": user.display_name or user.first_name or user.username or "Участник",
            "avatar_url": user.avatar_url or "",
            "access": access.value,
        }

    @database_sync_to_async
    def _current_board_version(self):
        return (
            PpmCanvasBoard.objects.filter(
                id=self.board_id,
                workspace_id=self.workspace_id,
                project_id=self.project_id,
                status=PpmCanvasStatus.ACTIVE,
                canvas__status=PpmCanvasStatus.ACTIVE,
            )
            .values_list("current_version", flat=True)
            .first()
        )

    @database_sync_to_async
    def _access_is_still_valid(self):
        user = User.objects.filter(id=self.participant["user_id"], is_active=True).first()
        if user is None:
            return False
        access = get_ppm_canvas_access(
            user=user,
            workspace_id=self.workspace_id,
            project_id=self.project_id,
        )
        # A role downgrade invalidates the rights advertised when this socket joined.
        # The client must reconnect and reload the board with the new access level.
        if access == PpmCanvasAccess.DENY or access.value != self.participant["access"]:
            return False
        return PpmCanvasBoard.objects.filter(
            id=self.board_id,
            workspace_id=self.workspace_id,
            project_id=self.project_id,
            status=PpmCanvasStatus.ACTIVE,
            canvas__status=PpmCanvasStatus.ACTIVE,
        ).exists()
