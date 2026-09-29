"""UX2.1 U1–U3 — the project events socket of a workspace: ``/ws/ppm/v1/workspaces/<slug>/events/``.

Built like the Canvas presence socket (``plane.ppm_canvas.consumers``): session sign-in, the Canvas read rule for every
project (``access.project_scopes`` — ``get_ppm_canvas_access`` for many projects in a few queries), a re-check every
12–15 s that also renews the Redis group membership (``group_expiry`` would silently drop a long-lived socket) and ends
the socket when the browser session is gone. One socket serves a browser tab in one workspace and subscribes to up to
50 projects («Мои задачи» spans several). Events carry ids only; a guest who sees only own items gets only events of
the work items they created and none of sprints and directions. Coalescing happens here: at most one event per
(project, entity, id) every 250 ms, the ids of a burst in one event — also for item-by-item changes that arrive from
different requests and processes. Limits against abuse: 10 sockets per person, 30 messages per 10 s, 200 project
access checks per minute, 50 ids per message, 16 KB per message.
"""

import asyncio
import json
import logging
import random
import time
import traceback
import uuid
from collections import deque
from pathlib import PurePath

from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.utils import timezone

from plane.db.models import User, Workspace
from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminAudit
from plane.ppm_core.permissions import is_ppm_global_admin

from . import limits
from .access import OWN_WORK_ITEMS, is_workspace_member, project_scopes, session_is_valid
from .flags import realtime_events_enabled
from .protocol import (
    ACTION_STRENGTH,
    ACTIONS,
    CLOSE_FORBIDDEN,
    CLOSE_INTERNAL_ERROR,
    CLOSE_MESSAGE_TOO_BIG,
    CLOSE_NOT_AUTHENTICATED,
    CLOSE_TOO_MANY,
    CLOSE_UNAVAILABLE,
    ENTITIES,
    EVENT_ACTION_ORDER,
    project_events_group_name,
)


logger = logging.getLogger("plane.api")

PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS = 15
# Re-checks of many sockets must not come in waves: every interval is 80–100 % of the nominal one, never longer.
PPM_REALTIME_ACCESS_CHECK_JITTER = 0.2
PPM_REALTIME_COALESCE_SECONDS = 0.25
PPM_REALTIME_MAX_SUBSCRIPTIONS = 50
# A tab sends a ping every 25 s and (un)subscribes on navigation; 30 messages in 10 s is far above that.
PPM_REALTIME_MAX_CLIENT_MESSAGES = 30
PPM_REALTIME_CLIENT_MESSAGE_WINDOW_SECONDS = 10
# Every project a client asks for costs an access check, granted or denied.
PPM_REALTIME_MAX_ACCESS_CHECKS_PER_MINUTE = 200
# 50 project ids take ≈2 KB.
PPM_REALTIME_MAX_MESSAGE_CHARS = 16_384
PPM_REALTIME_MAX_IDS_PER_EVENT = 500
DENIED_ID_MAX_CHARS = 64

# Why a re-check ends the socket.
_SIGNED_OUT = "signed_out"
_NO_WORKSPACE = "no_workspace"


class PpmProjectEventsConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.connection_id = uuid.uuid4().hex
        self.user_id = None
        self.workspace_id = None
        self.session_key = None
        self.slot_taken = False
        self.subscriptions = {}
        self.pending = {}
        self.flush_task = None
        self.monitor_task = None
        self.message_times = deque()
        self.access_check_times = deque()
        self.seq = 0
        self.closing = False

        if not realtime_events_enabled() or self.channel_layer is None:
            await self._refuse(CLOSE_UNAVAILABLE)
            return
        user = self.scope.get("user")
        if not user or not user.is_authenticated:
            await self._refuse(CLOSE_NOT_AUTHENTICATED)
            return
        slug = self.scope.get("url_route", {}).get("kwargs", {}).get("workspace_slug")
        try:
            workspace_id, slot_taken = await self._open_workspace(
                user_id=user.id, slug=slug, path=self.scope.get("path", "")
            )
        except Exception as exc:
            _log_failure("PPM realtime events socket could not be opened", exc)
            await self._refuse(CLOSE_INTERNAL_ERROR)
            return
        if workspace_id is None:
            await self._refuse(CLOSE_FORBIDDEN)
            return
        if not slot_taken:
            await self._refuse(CLOSE_TOO_MANY)
            return
        self.user_id = str(user.id)
        self.workspace_id = workspace_id
        self.slot_taken = True
        session = self.scope.get("session")
        self.session_key = getattr(session, "session_key", None) if session is not None else None
        await self.accept()
        self.monitor_task = asyncio.create_task(self._monitor_access())

    async def _refuse(self, code):
        # Accept first: a close before the handshake reaches the browser as 1006 without the code, and the client could
        # not tell «stop reconnecting» (4401/4403/4404/4429) from a network failure.
        self.closing = True
        await self.accept()
        await self.close(code=code)

    async def disconnect(self, code):
        self.closing = True
        self._cancel_tasks()
        await self._leave_all()

    def _cancel_tasks(self):
        current = asyncio.current_task()
        for task in (self.monitor_task, self.flush_task):
            if task is not None and task is not current:
                task.cancel()
        self.monitor_task = None
        self.flush_task = None

    async def _leave_all(self):
        project_ids = list(self.subscriptions)
        self.subscriptions.clear()
        self.pending.clear()
        if self.channel_layer is not None:
            for project_id in project_ids:
                try:
                    await self.channel_layer.group_discard(project_events_group_name(project_id), self.channel_name)
                except Exception as exc:
                    # Redis is unreachable: the membership expires by itself (group_expiry).
                    _log_failure("PPM realtime events could not leave a project group", exc)
        if self.slot_taken:
            self.slot_taken = False
            await sync_to_async(limits.release_socket_slot, thread_sensitive=False)(self.user_id, self.connection_id)

    async def _close(self, code):
        if self.closing:
            return
        self.closing = True
        self._cancel_tasks()
        await self._leave_all()
        await self.close(code=code)

    # ---------------- client messages ----------------

    async def receive(self, text_data=None, bytes_data=None, **kwargs):
        if self.closing or self.workspace_id is None:
            return
        if not self._within_message_rate():
            await self._close(CLOSE_TOO_MANY)
            return
        if text_data is None:
            return
        if len(text_data) > PPM_REALTIME_MAX_MESSAGE_CHARS:
            await self._close(CLOSE_MESSAGE_TOO_BIG)
            return
        try:
            content = json.loads(text_data)
        except ValueError:
            return
        if not isinstance(content, dict):
            return
        message_type = content.get("type")
        try:
            if message_type == "ping":
                await self.send_json({"type": "pong"})
            elif message_type == "subscribe":
                await self._subscribe(content.get("project_ids"))
            elif message_type == "unsubscribe":
                await self._unsubscribe(content.get("project_ids"))
            # Anything else is not part of the protocol and is ignored (it still counts against the message rate).
        except Exception as exc:
            # Database or Redis trouble: close with a code the client retries, never with a traceback to the socket.
            _log_failure("PPM realtime events message failed", exc)
            await self._close(CLOSE_INTERNAL_ERROR)

    def _within_message_rate(self):
        now = time.monotonic()
        window_start = now - PPM_REALTIME_CLIENT_MESSAGE_WINDOW_SECONDS
        while self.message_times and self.message_times[0] < window_start:
            self.message_times.popleft()
        self.message_times.append(now)
        return len(self.message_times) <= PPM_REALTIME_MAX_CLIENT_MESSAGES

    def _within_access_check_budget(self, count):
        now = time.monotonic()
        while self.access_check_times and self.access_check_times[0] < now - 60:
            self.access_check_times.popleft()
        if len(self.access_check_times) + count > PPM_REALTIME_MAX_ACCESS_CHECKS_PER_MINUTE:
            return False
        self.access_check_times.extend([now] * count)
        return True

    async def _subscribe(self, raw_project_ids):
        # Longer than a socket may ever hold: refused before any parsing.
        if isinstance(raw_project_ids, list) and len(raw_project_ids) > PPM_REALTIME_MAX_SUBSCRIPTIONS:
            await self._close(CLOSE_TOO_MANY)
            return
        requested, malformed = _parse_project_ids(raw_project_ids)
        new_ids = [project_id for project_id in requested if project_id not in self.subscriptions]
        if len(self.subscriptions) + len(new_ids) > PPM_REALTIME_MAX_SUBSCRIPTIONS:
            await self._close(CLOSE_TOO_MANY)
            return
        scopes = {}
        if new_ids:
            if not self._within_access_check_budget(len(new_ids)):
                await self._close(CLOSE_TOO_MANY)
                return
            ended, scopes = await self._read_access(new_ids, audit_subscription=True)
            if self.closing:
                return
            if ended:
                await self._close(CLOSE_NOT_AUTHENTICATED if ended == _SIGNED_OUT else CLOSE_FORBIDDEN)
                return
        granted, denied = [], []
        for project_id in requested:
            if project_id in self.subscriptions:
                granted.append(project_id)
                continue
            scope = scopes.get(project_id)
            if scope is None:
                denied.append(project_id)
                continue
            self.subscriptions[project_id] = scope
            await self.channel_layer.group_add(project_events_group_name(project_id), self.channel_name)
            granted.append(project_id)
        if self.closing:
            return
        await self.send_json({"type": "subscribed", "project_ids": granted, "denied": denied + malformed})

    async def _unsubscribe(self, raw_project_ids):
        if isinstance(raw_project_ids, list) and len(raw_project_ids) > PPM_REALTIME_MAX_SUBSCRIPTIONS:
            await self._close(CLOSE_TOO_MANY)
            return
        requested, _ = _parse_project_ids(raw_project_ids)
        for project_id in requested:
            if self.subscriptions.pop(project_id, None) is None:
                continue
            self._drop_pending(project_id)
            await self.channel_layer.group_discard(project_events_group_name(project_id), self.channel_name)

    # ---------------- access ----------------

    async def _monitor_access(self):
        try:
            while True:
                await asyncio.sleep(_next_check_interval())
                if self.closing or not await self._recheck(list(self.subscriptions), periodic=True):
                    return
        except asyncio.CancelledError:
            return
        except Exception as exc:
            _log_failure("PPM realtime events access check failed", exc)
            await self._close(CLOSE_INTERNAL_ERROR)

    async def _recheck(self, project_ids, *, periodic):
        """Re-read access; False when the socket was closed (signed out → 4401, no workspace → 4403)."""
        ended, scopes = await self._read_access(project_ids, renew_slot=periodic)
        if self.closing:
            return False
        if ended:
            await self._close(CLOSE_NOT_AUTHENTICATED if ended == _SIGNED_OUT else CLOSE_FORBIDDEN)
            return False
        for project_id, scope in scopes.items():
            if project_id not in self.subscriptions:
                continue
            if scope is None:
                await self._revoke(project_id)
                continue
            self.subscriptions[project_id] = scope
            if periodic:
                await self.channel_layer.group_add(project_events_group_name(project_id), self.channel_name)
        return True

    async def _revoke(self, project_id):
        if self.subscriptions.pop(project_id, None) is None:
            return
        self._drop_pending(project_id)
        await self.channel_layer.group_discard(project_events_group_name(project_id), self.channel_name)
        await self.send_json({"type": "access_revoked", "project_id": project_id})

    @database_sync_to_async
    def _open_workspace(self, *, user_id, slug, path):
        """(workspace id, socket slot taken); workspace id None — no access to the workspace."""
        user = User.objects.filter(id=user_id, is_active=True).first()
        if user is None or not slug:
            return None, False
        workspace_id = Workspace.objects.filter(slug=slug).values_list("id", flat=True).first()
        if workspace_id is None:
            return None, False
        global_admin = is_ppm_global_admin(user=user)
        if not global_admin and not is_workspace_member(user, workspace_id):
            return None, False
        if not limits.claim_socket_slot(user.id, self.connection_id):
            return str(workspace_id), False
        if global_admin:
            try:
                _audit(user, "realtime_events_connect", workspace_id=workspace_id, path=path)
            except Exception:
                limits.release_socket_slot(user.id, self.connection_id)
                raise
        return str(workspace_id), True

    @database_sync_to_async
    def _read_access(self, project_ids, *, audit_subscription=False, renew_slot=False):
        """(why the socket must end or None, project id → what it may see — None: nothing).

        A fixed handful of queries for any number of projects: person, session, global admin, workspace membership,
        projects, project roles.
        """
        user = User.objects.filter(id=self.user_id, is_active=True).first()
        if user is None:
            return _NO_WORKSPACE, {}
        if not session_is_valid(self.session_key, user):
            return _SIGNED_OUT, {}
        global_admin = is_ppm_global_admin(user=user)
        if not global_admin and not is_workspace_member(user, self.workspace_id):
            return _NO_WORKSPACE, {}
        scopes = project_scopes(user, self.workspace_id, project_ids, global_admin=global_admin, workspace_member=True)
        granted = [project_id for project_id in project_ids if scopes.get(project_id) is not None]
        if audit_subscription and global_admin and granted:
            _audit(
                user,
                "realtime_events_subscribe",
                workspace_id=self.workspace_id,
                path=self.scope.get("path", ""),
                metadata={"project_ids": granted},
            )
        if renew_slot:
            limits.renew_socket_slot(self.user_id, self.connection_id)
        return None, scopes

    # ---------------- events ----------------

    async def ppm_project_event(self, event):
        if self.closing:
            return
        project_id = event.get("project_id")
        changes = event.get("changes")
        if project_id not in self.subscriptions or not isinstance(changes, dict):
            return
        if "project" in changes:
            # Members, roles or «guests see everything» may have changed: re-read access before telling anything.
            try:
                still_open = await self._recheck([project_id], periodic=False)
            except Exception as exc:
                _log_failure("PPM realtime events access check failed", exc)
                await self._close(CLOSE_INTERNAL_ERROR)
                return
            if not still_open or project_id not in self.subscriptions:
                return
        creators = event.get("visibility")
        creators = creators if isinstance(creators, dict) else {}
        at = event.get("at") if isinstance(event.get("at"), str) else None
        for entity, bucket in changes.items():
            if entity not in ENTITIES or not isinstance(bucket, dict):
                continue
            for item_id, action in bucket.items():
                if isinstance(item_id, str) and action in ACTIONS:
                    creator = creators.get(item_id) if entity == "issue" else None
                    self._buffer(project_id, entity, item_id, action, creator, at)
        if self.pending and self.flush_task is None:
            self.flush_task = asyncio.create_task(self._flush_later())

    def _buffer(self, project_id, entity, item_id, action, creator, at):
        bucket = self.pending.setdefault((project_id, entity), {})
        known = bucket.get(item_id)
        if known is None:
            bucket[item_id] = [action, creator, at]
            return
        if ACTION_STRENGTH[action] > ACTION_STRENGTH[known[0]]:
            known[0] = action
        if known[1] is None:
            known[1] = creator
        if at and (known[2] is None or at > known[2]):
            known[2] = at

    def _drop_pending(self, project_id):
        for key in [key for key in self.pending if key[0] == project_id]:
            self.pending.pop(key, None)

    async def _flush_later(self):
        try:
            await asyncio.sleep(PPM_REALTIME_COALESCE_SECONDS)
            # Changes from now on wait for the next window: never more than one event per id every window.
            self.flush_task = None
            await self._flush()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            _log_failure("PPM realtime events could not be sent", exc)

    async def _flush(self):
        pending, self.pending = self.pending, {}
        for (project_id, entity), bucket in pending.items():
            if self.closing:
                return
            # Read at send time: access may have narrowed while the events waited.
            scope = self.subscriptions.get(project_id)
            if scope is None or (scope == OWN_WORK_ITEMS and entity in ("cycle", "module")):
                continue
            by_action = {}
            for item_id, (action, creator, at) in bucket.items():
                if scope == OWN_WORK_ITEMS and entity == "issue" and creator != self.user_id:
                    continue
                by_action.setdefault(action, []).append((item_id, at))
            for action in EVENT_ACTION_ORDER:
                items = by_action.get(action, [])
                for start in range(0, len(items), PPM_REALTIME_MAX_IDS_PER_EVENT):
                    chunk = items[start : start + PPM_REALTIME_MAX_IDS_PER_EVENT]
                    # The time of the latest change among the ids this socket actually gets.
                    times = [at for _, at in chunk if at]
                    self.seq += 1
                    await self.send_json(
                        {
                            "type": "event",
                            "project_id": project_id,
                            "entity": entity,
                            "action": action,
                            "ids": [item_id for item_id, _ in chunk],
                            "seq": self.seq,
                            "at": max(times) if times else timezone.now().isoformat(),
                        }
                    )


def _next_check_interval():
    # Not a secret — only a spread of the re-check times.
    jitter = random.random() * PPM_REALTIME_ACCESS_CHECK_JITTER
    return PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS * (1 - jitter)


def _parse_project_ids(value):
    """Canonical project ids in request order without repeats, plus the refused strings as they were sent."""
    if not isinstance(value, list):
        return [], []
    requested, malformed = [], []
    seen, seen_malformed = set(), set()
    for item in value:
        if not isinstance(item, str):
            continue
        try:
            project_id = str(uuid.UUID(item))
        except ValueError:
            refused = item[:DENIED_ID_MAX_CHARS]
            if refused not in seen_malformed:
                seen_malformed.add(refused)
                malformed.append(refused)
            continue
        if project_id not in seen:
            seen.add(project_id)
            requested.append(project_id)
    return requested, malformed


def _audit(user, action, *, workspace_id, path="", metadata=None):
    registry = PpmGlobalAdmin.objects.filter(user=user, revoked_at__isnull=True).first()
    if registry is None:
        return
    PpmGlobalAdminAudit.objects.create(
        global_admin=registry,
        action=action,
        workspace_id=workspace_id,
        method="WS",
        path=str(path)[:500],
        request_id=uuid.uuid4(),
        metadata=metadata or {},
    )


def _log_failure(message, exc):
    # Without the exception text: a Redis or database error may carry connection details.
    frames = traceback.extract_tb(exc.__traceback__)
    location = f"{PurePath(frames[-1].filename).name}:{frames[-1].lineno}" if frames else ""
    logger.warning(message, extra={"error_type": type(exc).__name__, "error_location": location})
