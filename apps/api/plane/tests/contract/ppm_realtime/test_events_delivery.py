"""UX2.1 U2/U3/U4 — what reaches a subscribed socket: short events without data, per project, guests filtered,
coalesced per 250 ms, stopped when access goes away."""

import asyncio
import os
import threading
import uuid

import pytest
from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from django.test import override_settings
from rest_framework.test import APIClient

from plane.db.models import Project, ProjectMember
from plane.ppm_realtime.publish import publish_project_event

from .realtime_helpers import (
    EVENT_KEYS,
    IN_MEMORY_CHANNEL_LAYER,
    group_event,
    group_name,
    make_cycle,
    make_issue,
    make_states,
    open_socket,
    open_subscribed,
    put_in_cycle,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db(transaction=True)]


def by_entity_action(received):
    """{(entity, action): ids} of the events among received (time, message) pairs."""
    result = {}
    for _, message in received:
        if message.get("type") == "event":
            result.setdefault((message["entity"], message["action"]), []).extend(message["ids"])
    return result


async def send_group(project_id, entity, action, ids, **kwargs):
    await get_channel_layer().group_send(group_name(project_id), group_event(project_id, entity, action, ids, **kwargs))


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_event_reaches_only_subscribers_of_that_project(world):
    issue_id = uuid.uuid4()

    async def scenario():
        subscriber, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        other_project, _ = await open_subscribed(world.member, world.workspace.slug, world.open_project.id)
        not_subscribed, first = await open_socket(world.owner, world.workspace.slug)
        assert first["type"] == "websocket.accept"

        await send_group(world.project.id, "issue", "updated", [issue_id], visibility={issue_id: world.owner.id})
        event = await subscriber.receive()
        assert event["type"] == "event"
        assert (event["project_id"], event["entity"], event["action"], event["ids"]) == (
            str(world.project.id),
            "issue",
            "updated",
            [str(issue_id)],
        )
        assert await other_project.nothing()
        assert await not_subscribed.nothing(0.1)
        for socket in (subscriber, other_project, not_subscribed):
            await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_event_carries_no_work_item_data_and_no_service_fields(world):
    issue_id = uuid.uuid4()

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await send_group(
            world.project.id,
            "issue",
            "created",
            [issue_id],
            visibility={issue_id: world.owner.id},
            name="Секретная задача",
            description_html="<p>данные</p>",
            actor_id=str(world.owner.id),
        )
        event = await socket.receive()
        assert set(event) == EVENT_KEYS
        assert event["seq"] == 1
        assert event["at"] == "2026-09-29T12:00:00+00:00"
        assert "visibility" not in event and "name" not in event and "actor_id" not in event
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_burst_is_coalesced_into_one_event_per_action_with_the_strongest_action(world):
    first, second, third = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    cycle_id = uuid.uuid4()
    creators = {first: world.owner.id, second: world.owner.id, third: world.owner.id}

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await send_group(world.project.id, "issue", "updated", [first], visibility=creators)
        await send_group(world.project.id, "issue", "updated", [first, second], visibility=creators)
        await send_group(world.project.id, "issue", "deleted", [second], visibility=creators)
        await send_group(world.project.id, "issue", "created", [third], visibility=creators)
        await send_group(world.project.id, "issue", "updated", [third], visibility=creators)
        await send_group(world.project.id, "cycle", "updated", [cycle_id])
        await send_group(world.project.id, "cycle", "updated", [cycle_id])

        received = await socket.receive_events()
        grouped = by_entity_action(received)
        assert grouped == {
            ("issue", "updated"): [str(first)],
            ("issue", "deleted"): [str(second)],
            ("issue", "created"): [str(third)],
            ("cycle", "updated"): [str(cycle_id)],
        }
        assert [message["seq"] for _, message in received] == [1, 2, 3, 4]

        # The next change after the window is a new event.
        await send_group(world.project.id, "issue", "updated", [first], visibility=creators)
        later = await socket.receive()
        assert (later["action"], later["ids"], later["seq"]) == ("updated", [str(first)], 5)
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_no_more_than_one_event_per_item_every_250_ms(world):
    issue_id = uuid.uuid4()

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        # Arrival times are taken while the changes keep coming, not after they have all been queued.
        collector = asyncio.create_task(socket.receive_events())
        for _ in range(12):
            await send_group(world.project.id, "issue", "updated", [issue_id], visibility={issue_id: world.owner.id})
            await asyncio.sleep(0.05)
        received = await collector
        times = [at for at, message in received if message.get("type") == "event"]
        assert 2 <= len(times) <= 4
        assert all(later - earlier >= 0.2 for earlier, later in zip(times, times[1:]))
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_large_batch_is_split_into_events_of_limited_size(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_MAX_IDS_PER_EVENT", 3)
    ids = [uuid.uuid4() for _ in range(7)]

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await send_group(world.project.id, "issue", "deleted", ids, visibility={value: None for value in ids})
        received = await socket.receive_events()
        sizes = [len(message["ids"]) for _, message in received]
        assert sizes == [3, 3, 1]
        assert [value for _, message in received for value in message["ids"]] == [str(value) for value in ids]
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_guest_without_view_all_gets_only_own_work_items(world):
    own, foreign, unknown, other_foreign = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    visibility = {own: world.guest.id, foreign: world.owner.id, unknown: None, other_foreign: world.member.id}

    async def scenario():
        guest, _ = await open_subscribed(world.guest, world.workspace.slug, world.project.id)
        member, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await send_group(world.project.id, "issue", "updated", [own, foreign, unknown], visibility=visibility)
        await send_group(world.project.id, "issue", "created", [other_foreign], visibility=visibility)
        await send_group(world.project.id, "cycle", "updated", [uuid.uuid4()])
        await send_group(world.project.id, "module", "created", [uuid.uuid4()])
        await send_group(world.project.id, "project", "updated", [world.project.id])

        guest_events = by_entity_action(await guest.receive_events())
        # Only the guest's own work item (REST shows such a guest only what they created) and the project itself.
        assert guest_events == {
            ("issue", "updated"): [str(own)],
            ("project", "updated"): [str(world.project.id)],
        }
        member_events = by_entity_action(await member.receive_events())
        assert member_events[("issue", "updated")] == [str(own), str(foreign), str(unknown)]
        assert member_events[("issue", "created")] == [str(other_foreign)]
        assert {key[0] for key in member_events} == {"issue", "cycle", "module", "project"}
        for socket in (guest, member):
            await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_guest_with_view_all_gets_every_event(world):
    foreign = uuid.uuid4()

    async def scenario():
        guest, _ = await open_subscribed(world.guest, world.workspace.slug, world.open_project.id)
        await send_group(world.open_project.id, "issue", "updated", [foreign], visibility={foreign: world.owner.id})
        await send_group(world.open_project.id, "cycle", "updated", [uuid.uuid4()])
        grouped = by_entity_action(await guest.receive_events())
        assert set(grouped) == {("issue", "updated"), ("cycle", "updated")}
        await guest.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_guest_filter_follows_the_project_setting(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 3600)

    async def scenario():
        guest, _ = await open_subscribed(world.guest, world.workspace.slug, world.project.id)
        await send_group(world.project.id, "cycle", "updated", [uuid.uuid4()])
        assert await guest.nothing()

        # Turning «guests see everything» on is a project change: the socket re-reads its access at once.
        await database_sync_to_async(Project.objects.filter(pk=world.project.pk).update)(guest_view_all_features=True)
        await send_group(world.project.id, "project", "updated", [world.project.id])
        await send_group(world.project.id, "cycle", "updated", [uuid.uuid4()])
        grouped = by_entity_action(await guest.receive_events())
        assert set(grouped) == {("project", "updated"), ("cycle", "updated")}
        await guest.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_unsubscribe_stops_events(world):
    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await socket.unsubscribe(world.project.id)
        await socket.send({"type": "ping"})
        assert await socket.receive() == {"type": "pong"}
        await send_group(world.project.id, "issue", "updated", [uuid.uuid4()])
        assert await socket.nothing()
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_revoked_project_stops_events_within_the_check_interval(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 0.05)

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await database_sync_to_async(ProjectMember.objects.filter(project=world.project, member=world.member).update)(
            is_active=False
        )
        revoked, _ = await socket.receive_until(lambda item: item.get("type") == "access_revoked")
        assert revoked["project_id"] == str(world.project.id)
        await send_group(world.project.id, "issue", "updated", [uuid.uuid4()])
        assert await socket.nothing()
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_membership_change_revokes_before_the_next_check(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 3600)

    @database_sync_to_async
    def remove_member_like_the_api():
        membership = ProjectMember.objects.get(project=world.project, member=world.member)
        membership.is_active = False
        membership.save()

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await remove_member_like_the_api()
        revoked, seen = await socket.receive_until(lambda item: item.get("type") == "access_revoked")
        assert revoked["project_id"] == str(world.project.id)
        assert all(item.get("type") != "event" for item in seen)
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_access_check_refreshes_group_membership(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_ACCESS_CHECK_INTERVAL_SECONDS", 0.05)

    async def scenario():
        channel_layer = get_channel_layer()
        refreshed = []
        original_group_add = channel_layer.group_add

        async def tracked_group_add(group, channel):
            refreshed.append(group)
            await original_group_add(group, channel)

        channel_layer.group_add = tracked_group_add
        try:
            socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
            assert await socket.nothing(0.3)
            # Redis forgets group members after ``group_expiry``: the periodic check adds the socket again.
            assert refreshed.count(group_name(world.project.id)) >= 2
        finally:
            channel_layer.group_add = original_group_add
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_published_change_reaches_a_subscriber(world):
    issue_id = uuid.uuid4()

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await database_sync_to_async(publish_project_event)(
            world.project.id, "issue", "deleted", [issue_id], visibility={issue_id: world.owner.id}
        )
        event = await socket.receive()
        assert (event["entity"], event["action"], event["ids"]) == ("issue", "deleted", [str(issue_id)])
        await socket.disconnect()

    async_to_sync(scenario)()


@pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs the Redis channel layer of the test stack")
def test_redis_layer_carries_an_event_published_outside_any_event_loop(world):
    """Production path of Celery workers: a plain thread, no event loop, channels_redis between processes."""
    assert "RedisChannelLayer" in type(get_channel_layer()).__name__
    issue_id = uuid.uuid4()
    failures = []

    def worker_publication():
        try:
            publish_project_event(world.project.id, "issue", "moved", [issue_id], visibility={issue_id: None})
        except Exception as exc:  # pragma: no cover - reported below
            failures.append(exc)

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        worker = threading.Thread(target=worker_publication)
        worker.start()
        await asyncio.get_running_loop().run_in_executor(None, worker.join)
        event = await socket.receive(timeout=3)
        assert (event["entity"], event["action"], event["ids"]) == ("issue", "moved", [str(issue_id)])
        await socket.disconnect()

    async_to_sync(scenario)()
    assert failures == []


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_change_by_one_member_reaches_the_other_through_the_api(world):
    states = make_states(world.project)
    issue = make_issue(world.project, world.owner, state=states["backlog"])
    cycle = make_cycle(world.project, world.owner)
    put_in_cycle(issue, cycle)

    @database_sync_to_async
    def move_to_started():
        client = APIClient()
        client.force_authenticate(user=world.owner)
        return client.patch(
            f"/api/workspaces/{world.workspace.slug}/projects/{world.project.id}/issues/{issue.id}/",
            {"state_id": str(states["started"].id)},
            format="json",
        ).status_code

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        assert await move_to_started() == 204
        grouped = by_entity_action(await socket.receive_events())
        assert grouped[("issue", "updated")] == [str(issue.id)]
        # The sprint of the item changes its numbers and charts: its id comes along.
        assert grouped[("cycle", "updated")] == [str(cycle.id)]
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_line_b_item_by_item_bulk_reaches_subscribers_in_few_batches(world, monkeypatch):
    monkeypatch.setattr("plane.ppm_realtime.consumers.PPM_REALTIME_COALESCE_SECONDS", 2.0)
    states = make_states(world.project)
    issues = [make_issue(world.project, world.owner, name=f"Задача {n}", state=states["backlog"]) for n in range(8)]

    @database_sync_to_async
    def bulk_status_then_delete():
        # «Статус» and «Удалить» of the bulk bar send one request per work item (apps/web bulk-actions.ts).
        client = APIClient()
        client.force_authenticate(user=world.owner)
        base = f"/api/workspaces/{world.workspace.slug}/projects/{world.project.id}/issues"
        codes = [
            client.patch(f"{base}/{issue.id}/", {"state_id": str(states["started"].id)}, format="json").status_code
            for issue in issues[:5]
        ]
        codes += [client.delete(f"{base}/{issue.id}/").status_code for issue in issues[5:]]
        return codes

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        assert await bulk_status_then_delete() == [204] * 8
        received = await socket.receive_events(quiet=2.5)
        grouped = by_entity_action(received)
        assert sorted(grouped[("issue", "updated")]) == sorted(str(issue.id) for issue in issues[:5])
        assert sorted(grouped[("issue", "deleted")]) == sorted(str(issue.id) for issue in issues[5:])
        assert len([message for _, message in received if message["entity"] == "issue"]) == 2
        await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_guest_sees_own_work_item_change_but_not_a_colleagues(world):
    own = make_issue(world.project, world.guest, name="Моя задача")
    foreign = make_issue(world.project, world.owner, name="Чужая задача")

    @database_sync_to_async
    def rename(issue, name):
        client = APIClient()
        client.force_authenticate(user=world.owner)
        return client.patch(
            f"/api/workspaces/{world.workspace.slug}/projects/{world.project.id}/issues/{issue.id}/",
            {"name": name},
            format="json",
        ).status_code

    async def scenario():
        guest, _ = await open_subscribed(world.guest, world.workspace.slug, world.project.id)
        assert await rename(foreign, "Чужая задача 2") == 204
        assert await guest.nothing(0.6)
        assert await rename(own, "Моя задача 2") == 204
        event = await guest.receive()
        assert (event["entity"], event["action"], event["ids"]) == ("issue", "updated", [str(own.id)])
        await guest.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_event_time_comes_from_the_items_the_socket_gets(world):
    own, foreign = uuid.uuid4(), uuid.uuid4()
    visibility = {own: world.guest.id, foreign: world.owner.id}

    async def scenario():
        guest, _ = await open_subscribed(world.guest, world.workspace.slug, world.project.id)
        member, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        await send_group(
            world.project.id, "issue", "updated", [own], visibility=visibility, at="2026-09-29T12:00:01+00:00"
        )
        await send_group(
            world.project.id, "issue", "updated", [foreign], visibility=visibility, at="2026-09-29T12:00:09+00:00"
        )
        # The guest does not learn when a colleague's item changed — not even through the time of its own event.
        [(_, guest_event)] = await guest.receive_events()
        assert (guest_event["ids"], guest_event["at"]) == ([str(own)], "2026-09-29T12:00:01+00:00")
        [(_, member_event)] = await member.receive_events()
        assert (member_event["ids"], member_event["at"]) == ([str(own), str(foreign)], "2026-09-29T12:00:09+00:00")
        for socket in (guest, member):
            await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_one_message_with_sprints_and_directions_becomes_events_per_entity(world):
    issue_id, cycle_id, module_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    async def scenario():
        member, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)
        guest, _ = await open_subscribed(world.guest, world.workspace.slug, world.project.id)
        await send_group(
            world.project.id,
            "issue",
            "moved",
            [issue_id],
            visibility={issue_id: world.guest.id},
            cycle_ids=[cycle_id],
            module_ids=[module_id],
        )
        assert by_entity_action(await member.receive_events()) == {
            ("issue", "moved"): [str(issue_id)],
            ("cycle", "updated"): [str(cycle_id)],
            ("module", "updated"): [str(module_id)],
        }
        # The guest's own item — without the sprint and direction it cannot see.
        assert by_entity_action(await guest.receive_events()) == {("issue", "moved"): [str(issue_id)]}
        for socket in (member, guest):
            await socket.disconnect()

    async_to_sync(scenario)()


@override_settings(CHANNEL_LAYERS=IN_MEMORY_CHANNEL_LAYER)
def test_sprint_boards_learn_both_the_sprint_left_and_the_sprint_entered(world):
    """The web client re-reads a sprint board only when its id is in a ``cycle`` event: every membership change names
    the sprint the item left and the one it entered."""
    states = make_states(world.project)
    issue = make_issue(world.project, world.owner, state=states["backlog"])
    sprint_a = make_cycle(world.project, world.owner, name="Спринт A")
    sprint_b = make_cycle(world.project, world.owner, name="Спринт B")
    put_in_cycle(issue, sprint_a)
    base = f"/api/workspaces/{world.workspace.slug}/projects/{world.project.id}"

    @database_sync_to_async
    def call(method, path, data=None):
        client = APIClient()
        client.force_authenticate(user=world.owner)
        return getattr(client, method)(f"{base}{path}", data, format="json").status_code

    async def scenario():
        socket, _ = await open_subscribed(world.member, world.workspace.slug, world.project.id)

        # «Спринт» in the bulk bar or the sprint picker of the item: A → B.
        assert await call("post", f"/cycles/{sprint_b.id}/cycle-issues/", {"issues": [str(issue.id)]}) == 201
        grouped = by_entity_action(await socket.receive_events())
        assert grouped[("issue", "moved")] == [str(issue.id)]
        assert sorted(grouped[("cycle", "updated")]) == sorted([str(sprint_a.id), str(sprint_b.id)])

        # «Без спринта»: the item leaves B.
        assert await call("delete", f"/cycles/{sprint_b.id}/cycle-issues/{issue.id}/") == 204
        assert by_entity_action(await socket.receive_events()) == {
            ("issue", "moved"): [str(issue.id)],
            ("cycle", "updated"): [str(sprint_b.id)],
        }

        # Back into A, then the item is deleted: A's numbers change again.
        assert await call("post", f"/cycles/{sprint_a.id}/cycle-issues/", {"issues": [str(issue.id)]}) == 201
        assert by_entity_action(await socket.receive_events())[("cycle", "updated")] == [str(sprint_a.id)]
        assert await call("delete", f"/issues/{issue.id}/") == 204
        assert by_entity_action(await socket.receive_events()) == {
            ("issue", "deleted"): [str(issue.id)],
            ("cycle", "updated"): [str(sprint_a.id)],
        }
        await socket.disconnect()

    async_to_sync(scenario)()
