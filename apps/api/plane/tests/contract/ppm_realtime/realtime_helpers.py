"""UX2.1 — shared helpers for the project events channel tests (not collected: no ``test_`` prefix)."""

import json
import time
import uuid
from types import SimpleNamespace

from asgiref.testing import ApplicationCommunicator
from channels.routing import URLRouter

from plane.db.models import Cycle, CycleIssue, Issue, Module, ModuleIssue, State
from plane.ppm_canvas.routing import websocket_urlpatterns
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


IN_MEMORY_CHANNEL_LAYER = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
GROUP_MESSAGE_TYPE = "ppm.project.event"
EVENT_KEYS = {"type", "project_id", "entity", "action", "ids", "seq", "at"}


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(
        username=f"{prefix}-{marker}",
        email=f"{prefix}-{marker}@plane.test",
        display_name=f"{prefix.title()} user",
    )


def make_states(project):
    """One state per group; «Бэклог» is the project default."""
    states = {}
    for sequence, group in enumerate(("backlog", "unstarted", "started", "completed", "cancelled")):
        states[group] = State.objects.create(
            name=f"{group}-{uuid.uuid4().hex[:6]}",
            project=project,
            workspace=project.workspace,
            group=group,
            color="#3A3A3A",
            sequence=sequence * 1000,
            default=group == "backlog",
        )
    return states


def make_issue(project, author, *, name="Задача", state=None):
    """``BaseModel.save`` replaces ``created_by`` with the request user (none in tests) unless it is passed to save."""
    issue = Issue(name=name, project=project, workspace=project.workspace, state=state)
    issue.save(created_by_id=author.id)
    return issue


def make_cycle(project, owner, *, name="Спринт"):
    return Cycle.objects.create(name=name, project=project, workspace=project.workspace, owned_by=owner)


def make_module(project, *, name="Направление"):
    return Module.objects.create(name=name, project=project, workspace=project.workspace)


def put_in_cycle(issue, cycle):
    return CycleIssue.objects.create(issue=issue, cycle=cycle, project=issue.project, workspace=issue.workspace)


def put_in_module(issue, module):
    return ModuleIssue.objects.create(issue=issue, module=module, project=issue.project, workspace=issue.workspace)


def build_world():
    """A workspace with three projects (guests see only their own items in ``project``, everything in ``open_project``;
    ``closed_project`` has only the owner) and a second workspace with its own project."""
    marker = uuid.uuid4().hex[:8]
    owner = make_user("owner")
    member = make_user("member")
    guest = make_user("guest")
    outsider = make_user("outsider")
    other_owner = make_user("other-owner")

    workspace = WorkspaceFactory(owner=owner, slug=f"rt-{marker}")
    project = ProjectFactory(workspace=workspace, name=f"Realtime {marker}", identifier="RTM")
    open_project = ProjectFactory(
        workspace=workspace, name=f"Open {marker}", identifier="RTO", guest_view_all_features=True
    )
    closed_project = ProjectFactory(workspace=workspace, name=f"Closed {marker}", identifier="RTC")
    for user, role in ((owner, 20), (member, 15), (guest, 5)):
        WorkspaceMemberFactory(workspace=workspace, member=user, role=role)
        for target in (project, open_project):
            ProjectMemberFactory(workspace=workspace, project=target, member=user, role=role)
    ProjectMemberFactory(workspace=workspace, project=closed_project, member=owner, role=20)

    other_workspace = WorkspaceFactory(owner=other_owner, slug=f"rt-other-{marker}")
    WorkspaceMemberFactory(workspace=other_workspace, member=other_owner, role=20)
    foreign_project = ProjectFactory(workspace=other_workspace, name=f"Foreign {marker}", identifier="RTF")
    ProjectMemberFactory(workspace=other_workspace, project=foreign_project, member=other_owner, role=20)

    return SimpleNamespace(
        owner=owner,
        member=member,
        guest=guest,
        outsider=outsider,
        other_owner=other_owner,
        workspace=workspace,
        project=project,
        open_project=open_project,
        closed_project=closed_project,
        other_workspace=other_workspace,
        foreign_project=foreign_project,
    )


def events_path(slug):
    return f"/ws/ppm/v1/workspaces/{slug}/events/"


class EventsSocket:
    """One browser tab's events socket, routed through the common ``websocket_urlpatterns`` served by ``plane.asgi``.

    The session middleware of ``plane.asgi`` puts the signed-in user into the scope; here the user is injected directly.
    """

    def __init__(self, user, slug, *, path=None, session=None):
        router = URLRouter(websocket_urlpatterns)
        injected = {"user": user} if session is None else {"user": user, "session": session}

        async def application(scope, receive, send):
            return await router({**scope, **injected}, receive, send)

        self.communicator = ApplicationCommunicator(
            application,
            {
                "type": "websocket",
                "path": path or events_path(slug),
                "query_string": b"",
                "headers": [],
                "subprotocols": [],
            },
        )

    async def connect(self):
        """First output of the consumer: ``websocket.accept`` or ``websocket.close``."""
        await self.communicator.send_input({"type": "websocket.connect"})
        return await self.communicator.receive_output(timeout=1)

    async def send(self, payload):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        await self.communicator.send_input({"type": "websocket.receive", "text": text})

    async def receive(self, timeout=1):
        output = await self.communicator.receive_output(timeout=timeout)
        if output["type"] == "websocket.close":
            return {"type": "websocket.close", "code": output.get("code")}
        assert output["type"] == "websocket.send", output
        return json.loads(output["text"])

    async def receive_until(self, predicate, *, attempts=10, timeout=1):
        seen = []
        for _ in range(attempts):
            message = await self.receive(timeout=timeout)
            seen.append(message)
            if predicate(message):
                return message, seen
        raise AssertionError(f"Expected realtime message was not received: {seen}")

    async def receive_events(self, *, quiet=0.6, limit=50):
        """All messages until the socket stays quiet for ``quiet`` seconds, with their arrival times."""
        received = []
        while len(received) < limit:
            if await self.communicator.receive_nothing(timeout=quiet, interval=0.01):
                break
            message = await self.receive()
            received.append((time.monotonic(), message))
        return received

    async def nothing(self, timeout=0.5):
        return await self.communicator.receive_nothing(timeout=timeout, interval=0.01)

    async def subscribe(self, *project_ids):
        await self.send({"type": "subscribe", "project_ids": [str(project_id) for project_id in project_ids]})
        message = await self.receive()
        assert message["type"] == "subscribed", message
        return message

    async def unsubscribe(self, *project_ids):
        await self.send({"type": "unsubscribe", "project_ids": [str(project_id) for project_id in project_ids]})

    async def disconnect(self, code=1000):
        await self.communicator.send_input({"type": "websocket.disconnect", "code": code})
        await self.communicator.wait(timeout=1)


async def open_socket(user, slug, *, session=None):
    socket = EventsSocket(user, slug, session=session)
    first = await socket.connect()
    return socket, first


async def open_subscribed(user, slug, *project_ids, session=None):
    socket, first = await open_socket(user, slug, session=session)
    assert first["type"] == "websocket.accept", first
    subscribed = await socket.subscribe(*project_ids)
    return socket, subscribed


def group_name(project_id):
    return f"ppm-events-project-{uuid.UUID(str(project_id))}"


ENTITY_ORDER = ("issue", "cycle", "module", "project")
ACTION_ORDER = ("created", "updated", "moved", "deleted")


def group_event(
    project_id,
    entity,
    action,
    ids,
    *,
    visibility=None,
    cycle_ids=(),
    module_ids=(),
    at="2026-09-29T12:00:00+00:00",
    **extra,
):
    """The internal group message as ``publish.py`` sends it after commit: every entity of one commit at once."""
    changes = {entity: {str(value): action for value in ids}}
    for plan_entity, plan_ids in (("cycle", cycle_ids), ("module", module_ids)):
        for value in plan_ids:
            changes.setdefault(plan_entity, {})[str(value)] = "updated"
    message = {"type": GROUP_MESSAGE_TYPE, "project_id": str(project_id), "changes": changes, "at": at, **extra}
    if visibility is not None:
        message["visibility"] = {str(key): (str(value) if value else None) for key, value in visibility.items()}
    return message


def message_events(message):
    """(entity, action, sorted ids) of one group message, in a fixed order."""
    result = []
    for entity in ENTITY_ORDER:
        bucket = message["changes"].get(entity, {})
        for action in ACTION_ORDER:
            ids = sorted(item_id for item_id, item_action in bucket.items() if item_action == action)
            if ids:
                result.append((entity, action, ids))
    return result


class RecordingLayer:
    """Channel layer stand-in for publication tests: remembers every group message."""

    def __init__(self):
        self.sent = []

    async def group_send(self, group, message):
        self.sent.append((group, message))

    def events(self):
        """(entity, action, sorted ids) of every published message, in order."""
        return [event for _, message in self.sent for event in message_events(message)]

    def ids(self, entity, action):
        return sorted(
            item_id
            for _, message in self.sent
            for item_id, item_action in message["changes"].get(entity, {}).items()
            if item_action == action
        )

    def count(self, entity, action):
        """How many group messages carry this entity and action."""
        return sum(1 for _, message in self.sent if action in message["changes"].get(entity, {}).values())

    def clear(self):
        self.sent.clear()


class FailingLayer:
    def __init__(self, secret):
        self.secret = secret

    async def group_send(self, group, message):
        raise RuntimeError(self.secret)
