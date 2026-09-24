import json
import uuid

import pytest
from asgiref.sync import async_to_sync
from asgiref.testing import ApplicationCommunicator
from channels.layers import get_channel_layer
from channels.db import database_sync_to_async
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import ProjectMember
from plane.ppm_canvas.consumers import PpmCanvasPresenceConsumer
from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminAudit
from plane.ppm_canvas.realtime import canvas_presence_group_name
from plane.ppm_canvas.services import get_or_create_active_canvas
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]

IN_MEMORY_CHANNEL_LAYER = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(
        username=f"{prefix}-{marker}",
        email=f"{prefix}-{marker}@plane.test",
        display_name=f"{prefix.title()} user",
    )


@pytest.fixture
def presence_project():
    owner = make_user("owner")
    member = make_user("member")
    guest = make_user("guest")
    outsider = make_user("outsider")
    workspace = WorkspaceFactory(owner=owner)
    project = ProjectFactory(workspace=workspace, identifier="RTM")
    for user, role in ((owner, 20), (member, 15), (guest, 5)):
        WorkspaceMemberFactory(workspace=workspace, member=user, role=role)
        ProjectMemberFactory(workspace=workspace, project=project, member=user, role=role)
    canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=owner.id)
    return {
        "owner": owner,
        "member": member,
        "guest": guest,
        "outsider": outsider,
        "workspace": workspace,
        "project": project,
        "board": canvas.default_board,
    }


def consumer_scope(*, user, workspace, project, board):
    path = f"/ws/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/boards/{board.id}/presence/"
    return {
        "type": "websocket",
        "path": path,
        "query_string": b"",
        "headers": [],
        "subprotocols": [],
        "user": user,
        "url_route": {
            "kwargs": {
                "workspace_id": str(workspace.id),
                "project_id": str(project.id),
                "board_id": str(board.id),
            }
        },
    }


async def connect_client(*, user, workspace, project, board):
    communicator = ApplicationCommunicator(
        PpmCanvasPresenceConsumer.as_asgi(),
        consumer_scope(user=user, workspace=workspace, project=project, board=board),
    )
    await communicator.send_input({"type": "websocket.connect"})
    accepted = await communicator.receive_output(timeout=1)
    return communicator, accepted


async def receive_json(communicator, *, timeout=1):
    output = await communicator.receive_output(timeout=timeout)
    if output["type"] == "websocket.close":
        return {"type": "websocket.close", "code": output.get("code")}
    assert output["type"] == "websocket.send"
    return json.loads(output["text"])


async def receive_until(communicator, predicate, *, attempts=8):
    seen = []
    for _ in range(attempts):
        message = await receive_json(communicator)
        seen.append(message)
        if predicate(message):
            return message, seen
    raise AssertionError(f"Expected realtime message was not received: {seen}")


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_room_is_board_scoped_and_exposes_no_email(presence_project):
    async def scenario():
        first, first_accept = await connect_client(
            user=presence_project["owner"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert first_accept["type"] == "websocket.accept"
        ready = await receive_json(first)
        assert ready["type"] == "presence.ready"
        assert ready["protocol"] == 1
        assert ready["board_version"] == 0
        assert ready["self"]["access"] == "edit"
        assert "email" not in ready["self"]

        second, second_accept = await connect_client(
            user=presence_project["member"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert second_accept["type"] == "websocket.accept"

        joined, _ = await receive_until(
            first,
            lambda item: item.get("type") == "presence.joined"
            and item.get("participant", {}).get("user_id") == str(presence_project["member"].id),
        )
        assert joined["participant"]["display_name"] == "Member user"

        snapshot, seen = await receive_until(
            second,
            lambda item: item.get("type") == "presence.snapshot"
            and item.get("participant", {}).get("user_id") == str(presence_project["owner"].id),
        )
        assert snapshot["participant"]["access"] == "edit"
        assert all("email" not in item.get("participant", {}) for item in seen)

        await first.send_input({"type": "websocket.disconnect", "code": 1000})
        left, _ = await receive_until(
            second,
            lambda item: item.get("type") == "presence.left"
            and item.get("user_id") == str(presence_project["owner"].id),
        )
        assert left["connection_id"] == ready["self"]["connection_id"]
        await second.send_input({"type": "websocket.disconnect", "code": 1000})
        await first.wait(timeout=1)
        await second.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_ready_reports_current_board_version_after_reconnect(presence_project):
    board = presence_project["board"]
    workspace = presence_project["workspace"]
    project = presence_project["project"]

    @database_sync_to_async
    def save_while_disconnected():
        client = APIClient()
        client.force_authenticate(user=presence_project["owner"])
        response = client.put(
            f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/boards/{board.id}/snapshot/",
            {
                "schema_version": 2,
                "base_version": 0,
                "snapshot": {
                    "document": {
                        "store": {
                            "shape:missed": {
                                "id": "shape:missed",
                                "typeName": "shape",
                                "type": "ppm-canvas-node",
                            }
                        }
                    },
                    "session": {},
                },
                "client_operation_id": str(uuid.uuid4()),
            },
            format="json",
        )
        return response.status_code, response.data

    async def scenario():
        first, accepted = await connect_client(
            user=presence_project["owner"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert accepted["type"] == "websocket.accept"
        ready = await receive_json(first)
        assert ready["board_version"] == 0
        await first.send_input({"type": "websocket.disconnect", "code": 1000})
        await first.wait(timeout=1)

        code, saved = await save_while_disconnected()
        assert code == 200
        assert saved["version"] == 1

        second, accepted = await connect_client(
            user=presence_project["owner"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert accepted["type"] == "websocket.accept"
        ready = await receive_json(second)
        assert ready["board_version"] == saved["version"]
        await second.send_input({"type": "websocket.disconnect", "code": 1000})
        await second.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_denies_non_member_and_cross_project_board(presence_project):
    other_project = ProjectFactory(workspace=presence_project["workspace"], identifier="OTH")
    ProjectMemberFactory(
        workspace=presence_project["workspace"],
        project=other_project,
        member=presence_project["owner"],
        role=20,
    )

    async def scenario():
        outsider, outsider_result = await connect_client(
            user=presence_project["outsider"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert outsider_result == {"type": "websocket.close", "code": 4403}
        await outsider.wait(timeout=1)

        cross_project, cross_project_result = await connect_client(
            user=presence_project["owner"],
            workspace=presence_project["workspace"],
            project=other_project,
            board=presence_project["board"],
        )
        assert cross_project_result == {"type": "websocket.close", "code": 4403}
        await cross_project.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_global_admin_presence_cross_workspace_is_audited_and_revoked(presence_project):
    global_admin = make_user("global-admin")
    registry = PpmGlobalAdmin.objects.create(user=global_admin, reason="AF1.2 realtime audit gate")
    other_owner = make_user("other-owner")
    other_workspace = WorkspaceFactory(owner=other_owner)
    other_project = ProjectFactory(workspace=other_workspace, identifier="GWS")
    other_canvas = get_or_create_active_canvas(
        workspace_id=other_workspace.id,
        project_id=other_project.id,
        user_id=other_owner.id,
    )
    other_board = other_canvas.default_board
    assert not ProjectMember.objects.filter(member=global_admin).exists()

    async def scenario():
        first, first_accept = await connect_client(
            user=global_admin,
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert first_accept["type"] == "websocket.accept"
        assert (await receive_json(first))["self"]["access"] == "edit"

        second, second_accept = await connect_client(
            user=global_admin,
            workspace=other_workspace,
            project=other_project,
            board=other_board,
        )
        assert second_accept["type"] == "websocket.accept"
        assert (await receive_json(second))["self"]["access"] == "edit"

        await database_sync_to_async(PpmGlobalAdmin.objects.filter(pk=registry.pk).update)(revoked_at=timezone.now())
        for socket in (first, second):
            await socket.send_input({"type": "websocket.receive", "text": json.dumps({"type": "presence.heartbeat"})})
            revoked, _ = await receive_until(socket, lambda item: item.get("type") == "presence.revoked")
            assert revoked["type"] == "presence.revoked"
            assert await socket.receive_output(timeout=1) == {"type": "websocket.close", "code": 4403}
            await socket.wait(timeout=1)

    async_to_sync(scenario)()

    events = list(
        PpmGlobalAdminAudit.objects.filter(global_admin=registry, action="canvas_presence_connect")
        .order_by("project_id")
        .values("workspace_id", "project_id", "method", "metadata")
    )
    assert len(events) == 2
    assert {
        (event["workspace_id"], event["project_id"], event["method"], event["metadata"]["board_id"])
        for event in events
    } == {
        (
            presence_project["workspace"].id,
            presence_project["project"].id,
            "WS",
            str(presence_project["board"].id),
        ),
        (other_workspace.id, other_project.id, "WS", str(other_board.id)),
    }


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_guest_is_read_only_and_heartbeat_revokes_removed_member(presence_project):
    async def scenario():
        guest, accepted = await connect_client(
            user=presence_project["guest"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert accepted["type"] == "websocket.accept"
        ready = await receive_json(guest)
        assert ready["self"]["access"] == "read"

        await database_sync_to_async(ProjectMember.objects.filter(member=presence_project["guest"]).update)(
            is_active=False
        )
        await guest.send_input({"type": "websocket.receive", "text": json.dumps({"type": "presence.heartbeat"})})
        revoked, _ = await receive_until(guest, lambda item: item.get("type") == "presence.revoked")
        assert revoked["type"] == "presence.revoked"
        closed = await guest.receive_output(timeout=1)
        assert closed == {"type": "websocket.close", "code": 4403}
        await guest.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_role_downgrade_invalidates_editor_socket(presence_project):
    async def scenario():
        member, accepted = await connect_client(
            user=presence_project["member"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert accepted["type"] == "websocket.accept"
        ready = await receive_json(member)
        assert ready["self"]["access"] == "edit"

        await database_sync_to_async(ProjectMember.objects.filter(member=presence_project["member"]).update)(role=5)
        await member.send_input({"type": "websocket.receive", "text": json.dumps({"type": "presence.heartbeat"})})
        revoked, _ = await receive_until(member, lambda item: item.get("type") == "presence.revoked")
        assert revoked["type"] == "presence.revoked"
        assert await member.receive_output(timeout=1) == {"type": "websocket.close", "code": 4403}
        await member.wait(timeout=1)

        read_only, accepted_again = await connect_client(
            user=presence_project["member"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert accepted_again["type"] == "websocket.accept"
        assert (await receive_json(read_only))["self"]["access"] == "read"
        await read_only.send_input({"type": "websocket.disconnect", "code": 1000})
        await read_only.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_heartbeat_refreshes_long_lived_group_membership(presence_project):
    async def scenario():
        owner, accepted = await connect_client(
            user=presence_project["owner"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert accepted["type"] == "websocket.accept"
        await receive_until(owner, lambda item: item.get("type") == "presence.ready")

        channel_layer = get_channel_layer()
        original_group_add = channel_layer.group_add
        refreshed = []

        async def tracked_group_add(group, channel):
            refreshed.append((group, channel))
            await original_group_add(group, channel)

        channel_layer.group_add = tracked_group_add
        try:
            await owner.send_input({"type": "websocket.receive", "text": json.dumps({"type": "presence.heartbeat"})})
            acknowledgement, _ = await receive_until(owner, lambda item: item.get("type") == "presence.heartbeat_ack")
            assert acknowledgement["type"] == "presence.heartbeat_ack"
            assert refreshed and refreshed[0][0] == canvas_presence_group_name(
                project_id=presence_project["project"].id,
                board_id=presence_project["board"].id,
            )
        finally:
            channel_layer.group_add = original_group_add

        await owner.send_input({"type": "websocket.disconnect", "code": 1000})
        await owner.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_cursor_is_validated_and_broadcast_without_payload_passthrough(presence_project):
    async def scenario():
        owner, owner_accept = await connect_client(
            user=presence_project["owner"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        member, member_accept = await connect_client(
            user=presence_project["member"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert owner_accept["type"] == "websocket.accept"
        assert member_accept["type"] == "websocket.accept"
        await receive_until(owner, lambda item: item.get("type") == "presence.ready")
        await receive_until(member, lambda item: item.get("type") == "presence.ready")

        await owner.send_input(
            {
                "type": "websocket.receive",
                "text": json.dumps({"type": "presence.cursor", "cursor": {"x": 12, "y": 24, "unexpected": "secret"}}),
            }
        )
        invalid, _ = await receive_until(owner, lambda item: item.get("type") == "presence.error")
        assert invalid["error"]["code"] == "INVALID_CURSOR"

        await owner.send_input(
            {
                "type": "websocket.receive",
                "text": json.dumps({"type": "presence.cursor", "cursor": {"x": 12, "y": 24}}),
            }
        )
        cursor, _ = await receive_until(
            member,
            lambda item: item.get("type") == "presence.cursor"
            and item.get("user_id") == str(presence_project["owner"].id),
        )
        assert cursor["cursor"] == {"x": 12.0, "y": 24.0, "pointer_down": False}
        assert set(cursor) == {"type", "connection_id", "user_id", "display_name", "cursor"}

        await owner.send_input({"type": "websocket.disconnect", "code": 1000})
        await member.send_input({"type": "websocket.disconnect", "code": 1000})
        await owner.wait(timeout=1)
        await member.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_presence_forwards_board_change_without_snapshot_payload(presence_project):
    async def scenario():
        member, accepted = await connect_client(
            user=presence_project["member"],
            workspace=presence_project["workspace"],
            project=presence_project["project"],
            board=presence_project["board"],
        )
        assert accepted["type"] == "websocket.accept"
        await receive_until(member, lambda item: item.get("type") == "presence.ready")

        operation_id = uuid.uuid4()
        await get_channel_layer().group_send(
            canvas_presence_group_name(
                project_id=presence_project["project"].id,
                board_id=presence_project["board"].id,
            ),
            {
                "type": "canvas.board.changed",
                "board_id": str(presence_project["board"].id),
                "version": 7,
                "content_hash": "a" * 64,
                "saved_at": "2026-09-22T12:00:00+00:00",
                "saved_by": str(presence_project["owner"].id),
                "client_operation_id": str(operation_id),
                "snapshot": {"must_not": "leave the server"},
            },
        )
        changed, _ = await receive_until(member, lambda item: item.get("type") == "canvas.board.changed")
        assert changed == {
            "type": "canvas.board.changed",
            "board_id": str(presence_project["board"].id),
            "version": 7,
            "content_hash": "a" * 64,
            "saved_at": "2026-09-22T12:00:00+00:00",
            "saved_by": str(presence_project["owner"].id),
            "client_operation_id": str(operation_id),
        }

        await member.send_input({"type": "websocket.disconnect", "code": 1000})
        await member.wait(timeout=1)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_two_members_receive_real_save_and_stale_writer_cannot_overwrite(presence_project):
    board = presence_project["board"]
    workspace = presence_project["workspace"]
    project = presence_project["project"]
    board_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/boards/{board.id}/"
    snapshot_url = f"{board_url}snapshot/"
    first_operation_id = uuid.uuid4()

    @database_sync_to_async
    def request_as(user, method, *, base_version=0, label="saved"):
        client = APIClient()
        client.force_authenticate(user=user)
        if method == "get":
            response = client.get(board_url)
        else:
            response = client.put(
                snapshot_url,
                {
                    "schema_version": 2,
                    "base_version": base_version,
                    "snapshot": {
                        "document": {
                            "store": {
                                f"shape:{label}": {
                                    "id": f"shape:{label}",
                                    "typeName": "shape",
                                    "type": "ppm-canvas-node",
                                }
                            }
                        },
                        "session": {},
                    },
                    "client_operation_id": str(first_operation_id if label == "saved" else uuid.uuid4()),
                },
                format="json",
            )
        return response.status_code, response.data

    async def scenario():
        owner, accepted = await connect_client(
            user=presence_project["owner"], workspace=workspace, project=project, board=board
        )
        assert accepted["type"] == "websocket.accept"
        ready, _ = await receive_until(owner, lambda item: item.get("type") == "presence.ready")
        assert ready["board_version"] == 0

        member, accepted = await connect_client(
            user=presence_project["member"], workspace=workspace, project=project, board=board
        )
        assert accepted["type"] == "websocket.accept"
        await receive_until(member, lambda item: item.get("type") == "presence.ready")

        code, saved = await request_as(presence_project["owner"], "put")
        assert code == 200
        assert saved["version"] == 1
        changed, _ = await receive_until(member, lambda item: item.get("type") == "canvas.board.changed")
        assert changed["board_id"] == str(board.id)
        assert changed["version"] == saved["version"]
        assert changed["content_hash"] == saved["content_hash"]
        assert changed["saved_by"] == str(presence_project["owner"].id)
        assert changed["client_operation_id"] == str(first_operation_id)
        assert "snapshot" not in changed

        code, reloaded = await request_as(presence_project["member"], "get")
        assert code == 200
        assert reloaded["version"] == 1
        assert "shape:saved" in reloaded["snapshot"]["document"]["store"]

        code, rejected = await request_as(presence_project["member"], "put", label="stale")
        assert code == 409
        assert rejected["error"]["code"] == "CANVAS_VERSION_CONFLICT"
        assert rejected["error"]["details"]["current_version"] == 1
        code, unchanged = await request_as(presence_project["member"], "get")
        assert code == 200
        assert unchanged["version"] == 1
        assert "shape:saved" in unchanged["snapshot"]["document"]["store"]
        assert "shape:stale" not in unchanged["snapshot"]["document"]["store"]

        await owner.send_input({"type": "websocket.disconnect", "code": 1000})
        await member.send_input({"type": "websocket.disconnect", "code": 1000})
        await owner.wait(timeout=1)
        await member.wait(timeout=1)

    async_to_sync(scenario)()
