"""UX2.1 U1/U5 — who may open the project events socket, what a subscription grants and how abuse is limited."""

import json
import uuid
from datetime import timedelta
from importlib import import_module

import pytest
from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from django.apps import apps
from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.contrib.auth.models import AnonymousUser
from django.test import override_settings
from django.utils import timezone

from plane.db.models import ProjectMember, WorkspaceMember
from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminAudit
from plane.ppm_canvas.routing import websocket_urlpatterns
from plane.ppm_canvas.services import get_or_create_active_canvas
from plane.ppm_realtime import consumers, limits

from .realtime_helpers import IN_MEMORY_CHANNEL_LAYER, EventsSocket, make_user, open_socket, open_subscribed


pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]

ACCEPT = {"type": "websocket.accept", "subprotocol": None}


def test_app_is_installed_and_events_are_enabled_by_default():
    assert apps.is_installed("plane.ppm_realtime")
    assert settings.PPM_REALTIME_EVENTS_ENABLED is True


def test_events_route_shares_the_websocket_list_with_canvas_presence():
    names = [pattern.name for pattern in websocket_urlpatterns]
    assert "ppm-canvas-presence" in names
    assert "ppm-project-events" in names


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_canvas_presence_still_answers_through_the_common_routes(world):
    board = get_or_create_active_canvas(
        workspace_id=world.workspace.id, project_id=world.project.id, user_id=world.owner.id
    ).default_board
    path = f"/ws/ppm/v1/workspaces/{world.workspace.id}/projects/{world.project.id}/canvas/boards/{board.id}/presence/"

    async def scenario():
        socket = EventsSocket(world.member, world.workspace.slug, path=path)
        assert (await socket.connect())["type"] == "websocket.accept"
        assert (await socket.receive())["type"] == "presence.ready"
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_anonymous_socket_is_closed_with_4401(world):
    async def scenario():
        socket, first = await open_socket(AnonymousUser(), world.workspace.slug)
        # Accept first: a close before the handshake reaches the browser as 1006, not as a code it can act on.
        assert first == ACCEPT
        assert await socket.receive() == {"type": "websocket.close", "code": 4401}
        await socket.disconnect(4401)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_outsider_unknown_workspace_and_disabled_account_are_closed_with_4403(world):
    world.member.is_active = False
    world.member.save(update_fields=["is_active"])

    async def scenario():
        for user, slug in (
            (world.outsider, world.workspace.slug),
            (world.owner, f"missing-{uuid.uuid4().hex[:8]}"),
            (world.owner, world.other_workspace.slug),
            (world.member, world.workspace.slug),
        ):
            socket, first = await open_socket(user, slug)
            assert first == ACCEPT
            assert await socket.receive() == {"type": "websocket.close", "code": 4403}
            await socket.disconnect(4403)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_member_subscribes_to_own_projects_and_pings(world):
    async def scenario():
        socket, subscribed = await open_subscribed(
            world.member, world.workspace.slug, world.project.id, world.open_project.id
        )
        assert subscribed == {
            "type": "subscribed",
            "project_ids": [str(world.project.id), str(world.open_project.id)],
            "denied": [],
        }
        await socket.send({"type": "ping"})
        assert await socket.receive() == {"type": "pong"}
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_subscribe_denies_projects_without_read_access(world):
    missing_project = uuid.uuid4()

    async def scenario():
        socket, subscribed = await open_subscribed(
            world.member,
            world.workspace.slug,
            world.project.id,
            world.closed_project.id,
            world.foreign_project.id,
            missing_project,
            world.project.id,
        )
        assert subscribed == {
            "type": "subscribed",
            "project_ids": [str(world.project.id)],
            "denied": [str(world.closed_project.id), str(world.foreign_project.id), str(missing_project)],
        }
        # Garbage ids are refused as they were sent; the socket stays usable.
        await socket.send({"type": "subscribe", "project_ids": ["not-a-uuid", str(world.project.id)]})
        assert await socket.receive() == {
            "type": "subscribed",
            "project_ids": [str(world.project.id)],
            "denied": ["not-a-uuid"],
        }
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_guests_subscribe_with_or_without_view_all_features(world):
    async def scenario():
        socket, subscribed = await open_subscribed(
            world.guest, world.workspace.slug, world.project.id, world.open_project.id, world.closed_project.id
        )
        assert subscribed["project_ids"] == [str(world.project.id), str(world.open_project.id)]
        assert subscribed["denied"] == [str(world.closed_project.id)]
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_global_admin_reaches_any_workspace_and_is_audited(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 0.05)
    global_admin = make_user("global-admin")
    registry = PpmGlobalAdmin.objects.create(user=global_admin, reason="UX2.1 realtime audit gate")
    assert not WorkspaceMember.objects.filter(member=global_admin).exists()

    async def scenario():
        socket, subscribed = await open_subscribed(
            global_admin, world.workspace.slug, world.project.id, world.closed_project.id, world.foreign_project.id
        )
        assert subscribed["project_ids"] == [str(world.project.id), str(world.closed_project.id)]
        assert subscribed["denied"] == [str(world.foreign_project.id)]

        await database_sync_to_async(PpmGlobalAdmin.objects.filter(pk=registry.pk).update)(revoked_at=timezone.now())
        closed, _ = await socket.receive_until(lambda item: item.get("type") == "websocket.close")
        assert closed == {"type": "websocket.close", "code": 4403}
        await socket.disconnect(4403)

    async_to_sync(scenario)()

    audit = list(
        PpmGlobalAdminAudit.objects.filter(global_admin=registry)
        .order_by("created_at")
        .values("action", "workspace_id", "project_id", "method", "metadata")
    )
    assert [item["action"] for item in audit] == ["realtime_events_connect", "realtime_events_subscribe"]
    assert all(item["workspace_id"] == world.workspace.id and item["method"] == "WS" for item in audit)
    assert audit[1]["metadata"] == {"project_ids": [str(world.project.id), str(world.closed_project.id)]}


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_more_than_fifty_projects_close_with_4429(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_MAX_SUBSCRIPTIONS", 2)

    async def scenario():
        socket, subscribed = await open_subscribed(
            world.member, world.workspace.slug, world.project.id, world.open_project.id
        )
        assert len(subscribed["project_ids"]) == 2
        # Re-subscribing the same projects is not a new subscription.
        assert (await socket.subscribe(world.project.id))["project_ids"] == [str(world.project.id)]
        await socket.send({"type": "subscribe", "project_ids": [str(uuid.uuid4())]})
        assert await socket.receive() == {"type": "websocket.close", "code": 4429}
        await socket.disconnect(4429)

    async_to_sync(scenario)()


def test_limits_and_intervals_of_the_card():
    # UX2.1 U1/U4: ≤ 50 projects per socket, access re-read every 15 s, one event per item per 250 ms; limits of
    # review round 1: 200 access checks a minute per socket, 10 sockets per person.
    assert consumers.PPM_REALTIME_MAX_SUBSCRIPTIONS == 50
    assert consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS == 15
    assert consumers.PPM_REALTIME_COALESCE_SECONDS == 0.25
    assert consumers.PPM_REALTIME_MAX_ACCESS_CHECKS_PER_MINUTE == 200
    assert limits.PPM_REALTIME_MAX_SOCKETS_PER_USER == 10


def test_access_rechecks_are_spread_but_never_later_than_15_seconds():
    intervals = [consumers._next_check_interval() for _ in range(200)]
    assert all(12 <= interval <= 15 for interval in intervals)
    assert len({round(interval, 3) for interval in intervals}) > 1


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_message_flood_closes_with_4429(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_MAX_CLIENT_MESSAGES", 5)

    async def scenario():
        socket, first = await open_socket(world.member, world.workspace.slug)
        assert first == ACCEPT
        for _ in range(5):
            await socket.send({"type": "ping"})
            assert await socket.receive() == {"type": "pong"}
        await socket.send({"type": "ping"})
        assert await socket.receive() == {"type": "websocket.close", "code": 4429}
        await socket.disconnect(4429)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_oversized_message_closes_with_1009(world):
    async def scenario():
        socket, first = await open_socket(world.member, world.workspace.slug)
        assert first == ACCEPT
        await socket.send({"type": "subscribe", "project_ids": ["x" * 40_000]})
        assert await socket.receive() == {"type": "websocket.close", "code": 1009}
        await socket.disconnect(1009)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_malformed_messages_are_ignored(world):
    async def scenario():
        socket, first = await open_socket(world.member, world.workspace.slug)
        assert first == ACCEPT
        for payload in ("{not json", json.dumps(["ping"]), json.dumps({"type": "presence.cursor"}), "null"):
            await socket.send(payload)
        await socket.communicator.send_input({"type": "websocket.receive", "bytes": b"\x00\x01"})
        assert await socket.nothing(0.3)
        # A subscribe without a list subscribes nothing but still answers.
        await socket.send({"type": "subscribe", "project_ids": "all"})
        assert await socket.receive() == {"type": "subscribed", "project_ids": [], "denied": []}
        await socket.send({"type": "ping"})
        assert await socket.receive() == {"type": "pong"}
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER, PPM_REALTIME_EVENTS_ENABLED=False)
def test_disabled_flag_closes_with_4404(world):
    async def scenario():
        socket, first = await open_socket(world.member, world.workspace.slug)
        assert first == ACCEPT
        assert await socket.receive() == {"type": "websocket.close", "code": 4404}
        await socket.disconnect(4404)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS={})
def test_missing_channel_layer_closes_with_4404(world):
    async def scenario():
        socket, first = await open_socket(world.member, world.workspace.slug)
        assert first == ACCEPT
        assert await socket.receive() == {"type": "websocket.close", "code": 4404}
        await socket.disconnect(4404)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_failure_while_checking_access_closes_with_1011_without_details(world, monkeypatch, caplog):
    secret = "postgres://ppm:secret-that-must-not-appear@db/plane"

    def broken_scope(*args, **kwargs):
        raise RuntimeError(secret)

    monkeypatch.setattr("plane.ppm_realtime.consumers.project_scopes", broken_scope)

    async def scenario():
        socket, first = await open_socket(world.member, world.workspace.slug)
        assert first == ACCEPT
        await socket.send({"type": "subscribe", "project_ids": [str(world.project.id)]})
        assert await socket.receive() == {"type": "websocket.close", "code": 1011}
        await socket.disconnect(1011)

    async_to_sync(scenario)()
    assert "PPM realtime events message failed" in caplog.text
    assert secret not in caplog.text


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_workspace_membership_loss_closes_with_4403(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 0.05)

    async def scenario():
        socket, subscribed = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        assert subscribed["project_ids"] == [str(world.project.id)]
        # Plane removes people from a workspace with a queryset update — no model signal reaches the socket.
        await database_sync_to_async(
            WorkspaceMember.objects.filter(workspace=world.workspace, member=world.member).update
        )(is_active=False)
        closed, _ = await socket.receive_until(lambda item: item.get("type") == "websocket.close")
        assert closed == {"type": "websocket.close", "code": 4403}
        await socket.disconnect(4403)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_disabled_account_during_connection_closes_with_4403(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 0.05)

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await database_sync_to_async(type(world.member).objects.filter(pk=world.member.pk).update)(is_active=False)
        closed, _ = await socket.receive_until(lambda item: item.get("type") == "websocket.close")
        assert closed == {"type": "websocket.close", "code": 4403}
        await socket.disconnect(4403)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_project_access_loss_revokes_only_that_project(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 0.05)

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id, world.open_project.id)
        await database_sync_to_async(ProjectMember.objects.filter(project=world.project, member=world.member).update)(
            is_active=False
        )
        revoked, _ = await socket.receive_until(lambda item: item.get("type") == "access_revoked")
        assert revoked == {"type": "access_revoked", "project_id": str(world.project.id)}
        await socket.send({"type": "ping"})
        assert await socket.receive() == {"type": "pong"}
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_more_than_fifty_ids_in_one_message_close_with_4429_before_parsing(world, monkeypatch):
    parsed = []
    original = consumers._parse_project_ids
    monkeypatch.setattr(
        "plane.ppm_realtime.consumers._parse_project_ids", lambda value: parsed.append(1) or original(value)
    )

    async def scenario():
        for message_type in ("subscribe", "unsubscribe"):
            socket, first = await open_socket(world.member, world.workspace.slug)
            assert first == ACCEPT
            await socket.send({"type": message_type, "project_ids": [str(uuid.uuid4()) for _ in range(51)]})
            assert await socket.receive() == {"type": "websocket.close", "code": 4429}
            await socket.disconnect(4429)

    async_to_sync(scenario)()
    assert parsed == []


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_access_check_budget_counts_denied_projects_too(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_MAX_ACCESS_CHECKS_PER_MINUTE", 3)

    async def scenario():
        socket, subscribed = await open_subscribed(
            world.member, world.workspace.slug, world.project.id, world.closed_project.id
        )
        assert subscribed["denied"] == [str(world.closed_project.id)]
        # Already subscribed: no new check.
        assert (await socket.subscribe(world.project.id))["project_ids"] == [str(world.project.id)]
        await socket.unsubscribe(world.project.id)
        await socket.send({"type": "subscribe", "project_ids": [str(world.project.id), str(world.open_project.id)]})
        assert await socket.receive() == {"type": "websocket.close", "code": 4429}
        await socket.disconnect(4429)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_one_person_may_hold_a_limited_number_of_sockets(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.limits.PPM_REALTIME_MAX_SOCKETS_PER_USER", 2)

    async def scenario():
        first, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        second, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        third, accepted = await open_socket(world.member, world.workspace.slug)
        assert accepted == ACCEPT
        assert await third.receive() == {"type": "websocket.close", "code": 4429}
        await third.disconnect(4429)
        # Another person is not affected.
        colleague, _ = await open_subscribed(world.owner, world.workspace.slug, world.project.id)
        # A closed socket gives its place back.
        await first.disconnect()
        again, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        for socket in (second, colleague, again):
            await socket.disconnect()

    async_to_sync(scenario)()


def signed_in_session(user):
    store = import_module(settings.SESSION_ENGINE).SessionStore()
    store[SESSION_KEY] = str(user.pk)
    store[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
    store[HASH_SESSION_KEY] = user.get_session_auth_hash()
    store.create()
    return store


@pytest.mark.parametrize("ending", ["sign_out", "expiry", "password_change", "another_person"])
@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_ended_browser_session_closes_the_socket_with_4401(world, monkeypatch, ending):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 0.05)
    session = signed_in_session(world.member)
    Session = session.get_model_class()

    @database_sync_to_async
    def end_session():
        if ending == "sign_out":
            Session.objects.filter(session_key=session.session_key).delete()
        elif ending == "expiry":
            Session.objects.filter(session_key=session.session_key).update(
                expire_date=timezone.now() - timedelta(seconds=1)
            )
        elif ending == "password_change":
            world.member.set_password(f"new-{uuid.uuid4().hex}")
            world.member.save()
        else:
            store = import_module(settings.SESSION_ENGINE).SessionStore(session_key=session.session_key)
            store[SESSION_KEY] = str(world.owner.pk)
            store.save()

    async def scenario():
        socket, subscribed = await open_subscribed(
            world.member, world.workspace.slug, world.project.id, session=session
        )
        assert subscribed["project_ids"] == [str(world.project.id)]
        # The session is valid: the periodic re-checks keep the socket open.
        assert await socket.nothing(0.3)
        await end_session()
        closed, _ = await socket.receive_until(lambda item: item.get("type") == "websocket.close")
        assert closed == {"type": "websocket.close", "code": 4401}
        await socket.disconnect(4401)

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_database_failure_while_opening_closes_with_1011_without_details(world, monkeypatch, caplog):
    secret = "postgres://ppm:secret-that-must-not-appear@db/plane"

    def broken_membership(*args, **kwargs):
        raise RuntimeError(secret)

    monkeypatch.setattr("plane.ppm_realtime.consumers.is_workspace_member", broken_membership)

    async def scenario():
        socket, first = await open_socket(world.member, world.workspace.slug)
        assert first == ACCEPT
        assert await socket.receive() == {"type": "websocket.close", "code": 1011}
        await socket.disconnect(1011)

    async_to_sync(scenario)()
    assert "PPM realtime events socket could not be opened" in caplog.text
    assert secret not in caplog.text
