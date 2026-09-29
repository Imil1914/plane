"""UX2.1 U4/U5 — what is published and when: after commit, from model signals and from the bulk writes that bypass
them, one message per batch, never breaking the request."""

import uuid
from datetime import datetime, timedelta

import pytest
from django.db import transaction
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from plane.bgtasks.issue_automation_task import archive_old_issues, close_old_issues
from plane.bgtasks.deletion_task import soft_delete_related_objects
from plane.db.models import (
    APIToken,
    Cycle,
    CycleIssue,
    Issue,
    IssueAssignee,
    IssueLabel,
    Label,
    Module,
    ModuleIssue,
    Project,
    ProjectMember,
    WorkspaceMember,
)
from plane.ppm_realtime.publish import publish_project_event
from plane.tests.factories import WorkspaceMemberFactory

from .realtime_helpers import (
    FailingLayer,
    GROUP_MESSAGE_TYPE,
    group_name,
    make_cycle,
    make_user,
    make_issue,
    make_module,
    make_states,
    put_in_cycle,
    put_in_module,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def api(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def project_url(world, project=None):
    project = project or world.project
    return f"/api/workspaces/{world.workspace.slug}/projects/{project.id}"


def ids(*items):
    return sorted(str(getattr(item, "id", item)) for item in items)


# ---------------- publish_project_event ----------------


def test_publication_waits_for_commit_and_is_forgotten_on_rollback(world, recorded, django_capture_on_commit_callbacks):
    issue_id = uuid.uuid4()
    with django_capture_on_commit_callbacks() as callbacks:
        publish_project_event(world.project.id, "issue", "updated", [issue_id], visibility={issue_id: world.owner.id})
        assert recorded.sent == []
    assert len(callbacks) == 1
    callbacks[0]()
    [(group, message)] = recorded.sent
    assert group == group_name(world.project.id) == f"ppm-events-project-{world.project.id}"
    assert set(message) == {"type", "project_id", "changes", "visibility", "at"}
    assert (message["type"], message["project_id"], message["changes"]) == (
        GROUP_MESSAGE_TYPE,
        str(world.project.id),
        {"issue": {str(issue_id): "updated"}},
    )
    assert message["visibility"] == {str(issue_id): str(world.owner.id)}
    assert datetime.fromisoformat(message["at"]).tzinfo is not None

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        try:
            with transaction.atomic():
                publish_project_event(world.project.id, "issue", "deleted", [issue_id])
                raise RuntimeError("rolled back")
        except RuntimeError:
            pass
    assert recorded.sent == []


def test_ids_are_unique_strings_and_empty_or_invalid_calls_publish_nothing(
    world, recorded, django_capture_on_commit_callbacks, caplog
):
    cycle_id = uuid.uuid4()
    with django_capture_on_commit_callbacks(execute=True):
        publish_project_event(str(world.project.id), "cycle", "updated", [cycle_id, str(cycle_id), None])
        publish_project_event(world.project.id, "cycle", "updated", [])
        publish_project_event(world.project.id, "comment", "updated", [uuid.uuid4()])
        publish_project_event(world.project.id, "issue", "archived", [uuid.uuid4()])
        publish_project_event("not-a-project", "issue", "updated", [uuid.uuid4()])
        publish_project_event(world.project.id, "cycle", "updated", ["not-a-uuid"])
    assert recorded.events() == [("cycle", "updated", [str(cycle_id)])]
    assert "visibility" not in recorded.sent[0][1]
    assert "PPM realtime event was not published" in caplog.text


def test_publication_is_off_with_the_flag(world, recorded, django_capture_on_commit_callbacks):
    with override_settings(PPM_REALTIME_EVENTS_ENABLED=False), django_capture_on_commit_callbacks(execute=True):
        publish_project_event(world.project.id, "cycle", "updated", [uuid.uuid4()])
        make_issue(world.project, world.owner)
        make_cycle(world.project, world.owner)
    assert recorded.sent == []


@override_settings(CHANNEL_LAYERS={})
def test_publication_without_a_channel_layer_is_a_no_op(world, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        publish_project_event(world.project.id, "cycle", "updated", [uuid.uuid4()])
        issue = make_issue(world.project, world.owner)
    assert Issue.objects.filter(pk=issue.pk).exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("failure", ["layer", "group_send"])
def test_failed_publication_keeps_the_saved_change_and_logs_no_details(world, monkeypatch, caplog, failure):
    # Autocommit, as in production: the after-commit publication runs inside the request itself.
    secret = "redis://:secret-that-must-not-appear@valkey:6379/0"
    if failure == "layer":

        def broken_layer(*args, **kwargs):
            raise RuntimeError(secret)

        monkeypatch.setattr("plane.ppm_realtime.publish.get_channel_layer", broken_layer)
    else:
        monkeypatch.setattr("plane.ppm_realtime.publish.get_channel_layer", lambda *a, **k: FailingLayer(secret))
    issue = make_issue(world.project, world.owner)

    response = api(world.owner).patch(f"{project_url(world)}/issues/{issue.id}/", {"name": "Сохранено"}, format="json")
    assert response.status_code == 204
    assert Issue.objects.get(pk=issue.pk).name == "Сохранено"
    assert "PPM realtime event publish failed after commit" in caplog.text
    assert secret not in caplog.text


def test_work_item_events_carry_creators_of_this_project_only(world, recorded, django_capture_on_commit_callbacks):
    own = make_issue(world.project, world.guest)
    elsewhere = make_issue(world.open_project, world.owner)
    with django_capture_on_commit_callbacks(execute=True):
        publish_project_event(world.project.id, "issue", "moved", [own.id, elsewhere.id, uuid.uuid4()])
    [(_, message)] = recorded.sent
    assert message["changes"] == {"issue": {str(own.id): "moved"}}
    assert message["visibility"] == {str(own.id): str(world.guest.id)}


# ---------------- model signals ----------------


def test_work_item_signals(world, recorded, django_capture_on_commit_callbacks):
    cycle = make_cycle(world.project, world.owner)
    module = make_module(world.project)

    with django_capture_on_commit_callbacks(execute=True):
        issue = make_issue(world.project, world.member)
    assert recorded.events() == [("issue", "created", ids(issue))]
    assert recorded.sent[0][1]["visibility"] == {str(issue.id): str(world.member.id)}

    put_in_cycle(issue, cycle)
    put_in_module(issue, module)
    issue = Issue.objects.get(pk=issue.pk)
    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        issue.name = "Переименована"
        issue.save()
    # The name changes no numbers: the item alone.
    assert recorded.events() == [("issue", "updated", ids(issue))]

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        issue.priority = "urgent"
        issue.save()
    # One message: the item and the sprint and direction whose numbers and charts it changed.
    assert len(recorded.sent) == 1
    assert recorded.events() == [
        ("issue", "updated", ids(issue)),
        ("cycle", "updated", ids(cycle)),
        ("module", "updated", ids(module)),
    ]

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        # issue_activity bumps updated_at after every journal entry — nothing visible changed.
        issue.updated_at = timezone.now()
        issue.save(update_fields=["updated_at"])
    assert recorded.sent == []

    with django_capture_on_commit_callbacks(execute=True):
        issue.delete()
    assert recorded.events() == [
        ("issue", "deleted", ids(issue)),
        ("cycle", "updated", ids(cycle)),
        ("module", "updated", ids(module)),
    ]

    gone = make_issue(world.project, world.owner)
    gone_id = gone.id  # a hard delete clears the primary key of the instance
    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        gone.delete(soft=False)
    assert recorded.events() == [("issue", "deleted", ids(gone_id))]
    assert recorded.sent[0][1]["visibility"] == {str(gone_id): str(world.owner.id)}


def test_hard_delete_of_already_deleted_rows_is_silent(world, recorded, django_capture_on_commit_callbacks):
    issue = make_issue(world.project, world.owner)
    cycle = make_cycle(world.project, world.owner)
    Issue.all_objects.filter(pk=issue.pk).update(deleted_at=timezone.now())
    issue.refresh_from_db()
    cycle.deleted_at = timezone.now()
    with django_capture_on_commit_callbacks(execute=True):
        # hard_delete() purges what users already saw deleted weeks ago.
        Issue.all_objects.filter(pk=issue.pk).delete()
        cycle.delete(soft=False)
    assert recorded.sent == []


@pytest.mark.parametrize("kind", ["cycle", "module"])
def test_sprint_and_direction_signals(world, recorded, django_capture_on_commit_callbacks, kind):
    create = (
        (lambda: make_cycle(world.project, world.owner)) if kind == "cycle" else (lambda: make_module(world.project))
    )
    with django_capture_on_commit_callbacks(execute=True):
        item = create()
    assert recorded.events() == [(kind, "created", ids(item))]

    for change in ({"name": "Новое имя"}, {"archived_at": timezone.now()}):
        recorded.clear()
        with django_capture_on_commit_callbacks(execute=True):
            for field, value in change.items():
                setattr(item, field, value)
            item.save()
        assert recorded.events() == [(kind, "updated", ids(item))]

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        item.delete()
    assert recorded.events() == [(kind, "deleted", ids(item))]

    other = create()
    other_id = other.id  # a hard delete clears the primary key of the instance
    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        other.delete(soft=False)
    assert recorded.events() == [(kind, "deleted", ids(other_id))]


def test_sprint_membership_signals(world, recorded, django_capture_on_commit_callbacks):
    issue = make_issue(world.project, world.owner)
    first, second = make_cycle(world.project, world.owner, name="Первый"), make_cycle(world.project, world.owner)

    with django_capture_on_commit_callbacks(execute=True):
        membership = put_in_cycle(issue, first)
    assert recorded.events() == [("issue", "moved", ids(issue)), ("cycle", "updated", ids(first))]

    recorded.clear()
    membership = CycleIssue.objects.get(pk=membership.pk)
    with django_capture_on_commit_callbacks(execute=True):
        membership.cycle = second
        membership.save()
    assert recorded.events() == [("issue", "moved", ids(issue)), ("cycle", "updated", ids(first, second))]

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        membership.delete()
    assert recorded.events() == [("issue", "moved", ids(issue)), ("cycle", "updated", ids(second))]


def test_direction_membership_signals(world, recorded, django_capture_on_commit_callbacks):
    issue = make_issue(world.project, world.owner)
    module = make_module(world.project)
    with django_capture_on_commit_callbacks(execute=True):
        membership = put_in_module(issue, module)
    assert recorded.events() == [("issue", "moved", ids(issue)), ("module", "updated", ids(module))]

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        membership.delete()
    assert recorded.events() == [("issue", "moved", ids(issue)), ("module", "updated", ids(module))]


def test_assignee_and_label_signals(world, recorded, django_capture_on_commit_callbacks):
    issue = make_issue(world.project, world.owner)
    label = Label.objects.create(name="Срочно", project=world.project, workspace=world.workspace)
    with django_capture_on_commit_callbacks(execute=True):
        assignee = IssueAssignee.objects.create(
            issue=issue, assignee=world.member, project=world.project, workspace=world.workspace
        )
        IssueLabel.objects.create(issue=issue, label=label, project=world.project, workspace=world.workspace)
    assert recorded.ids("issue", "updated") == ids(issue, issue)

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        assignee.delete()
    assert recorded.events() == [("issue", "updated", ids(issue))]


def test_hard_deletes_of_links_publish_like_soft_ones(world, recorded, django_capture_on_commit_callbacks):
    issue = make_issue(world.project, world.owner)
    cycle = make_cycle(world.project, world.owner)
    module = make_module(world.project)
    cycle_link = put_in_cycle(issue, cycle)
    module_link = put_in_module(issue, module)
    assignee = IssueAssignee.objects.create(
        issue=issue, assignee=world.member, project=world.project, workspace=world.workspace
    )
    with django_capture_on_commit_callbacks(execute=True):
        cycle_link.delete(soft=False)
        module_link.delete(soft=False)
        assignee.delete(soft=False)
    assert recorded.events() == [
        ("issue", "moved", ids(issue)),
        ("cycle", "updated", ids(cycle)),
        ("issue", "moved", ids(issue)),
        ("module", "updated", ids(module)),
        ("issue", "updated", ids(issue)),
    ]


def test_member_removal_and_project_deletion(world, recorded, django_capture_on_commit_callbacks):
    membership = ProjectMember.objects.get(project=world.project, member=world.guest)
    with django_capture_on_commit_callbacks(execute=True):
        membership.delete(soft=False)
    assert recorded.events() == [("project", "updated", ids(world.project))]

    recorded.clear()
    project = Project.objects.get(pk=world.open_project.pk)
    with django_capture_on_commit_callbacks(execute=True):
        project.delete()
    assert recorded.events() == [("project", "deleted", ids(project))]


def test_project_signals(world, recorded, django_capture_on_commit_callbacks):
    project = Project.objects.get(pk=world.project.pk)
    with django_capture_on_commit_callbacks(execute=True):
        project.name = f"Переименован {uuid.uuid4().hex[:6]}"
        project.save()
    assert recorded.events() == [("project", "updated", ids(project))]

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        project.archived_at = timezone.now()
        project.save()
    assert recorded.events() == [("project", "updated", ids(project))]


def test_membership_signals_skip_personal_preferences(world, recorded, django_capture_on_commit_callbacks):
    membership = ProjectMember.objects.get(project=world.project, member=world.member)
    with django_capture_on_commit_callbacks(execute=True):
        membership.preferences = {"pages": {"block_display": False}}
        membership.view_props = {"filters": {}}
        membership.save()
    assert recorded.sent == []

    for change in ({"role": 5}, {"is_active": False}):
        membership = ProjectMember.objects.get(pk=membership.pk)
        recorded.clear()
        with django_capture_on_commit_callbacks(execute=True):
            for field, value in change.items():
                setattr(membership, field, value)
            membership.save()
        assert recorded.events() == [("project", "updated", ids(world.project))]

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        ProjectMember.objects.create(project=world.closed_project, member=world.member, role=15)
    assert recorded.events() == [("project", "updated", ids(world.closed_project))]


# ---------------- bulk writes that bypass signals ----------------


@pytest.fixture
def board(world):
    states = make_states(world.project)
    issues = [make_issue(world.project, world.owner, name=f"Задача {n}", state=states["backlog"]) for n in range(4)]
    cycle = make_cycle(world.project, world.owner)
    module = make_module(world.project)
    put_in_cycle(issues[0], cycle)
    put_in_module(issues[1], module)
    return states, issues, cycle, module


def test_bulk_delete_publishes_one_batch(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, cycle, module = board
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.owner).delete(
            f"{project_url(world)}/bulk-delete-issues/",
            {"issue_ids": [str(issue.id) for issue in issues]},
            format="json",
        )
    assert response.status_code == 200
    assert recorded.count("issue", "deleted") == 1
    assert recorded.ids("issue", "deleted") == ids(*issues)
    assert recorded.ids("cycle", "updated") == ids(cycle)
    assert recorded.ids("module", "updated") == ids(module)


def test_bulk_dates_publish_one_batch(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, _, _ = board
    updates = [{"id": str(issue.id), "start_date": "2026-10-01", "target_date": "2026-10-09"} for issue in issues]
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(f"{project_url(world)}/issue-dates/", {"updates": updates}, format="json")
    assert response.status_code == 200
    assert recorded.events() == [("issue", "updated", ids(*issues))]


def test_archive_and_unarchive_move_the_work_item(world, recorded, django_capture_on_commit_callbacks, board):
    states, issues, cycle, _ = board
    done = issues[0]
    Issue.objects.filter(pk=done.pk).update(state=states["completed"])
    with django_capture_on_commit_callbacks(execute=True):
        archived = api(world.member).post(f"{project_url(world)}/issues/{done.id}/archive/")
    assert archived.status_code == 200
    # The model signal sees archived_at change: one message, «moved», with the sprint.
    assert len(recorded.sent) == 1
    assert recorded.ids("issue", "moved") == ids(done)
    # The archived item leaves its sprint: the sprint's numbers change.
    assert set(recorded.ids("cycle", "updated")) == {str(cycle.id)}

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        restored = api(world.member).delete(f"{project_url(world)}/issues/{done.id}/archive/")
    assert restored.status_code == 204
    assert recorded.ids("issue", "moved") == ids(done)


def test_bulk_archive_publishes_one_batch(world, recorded, django_capture_on_commit_callbacks, board):
    states, issues, cycle, module = board
    Issue.objects.filter(pk__in=[issue.pk for issue in issues]).update(state=states["completed"])
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(
            f"{project_url(world)}/bulk-archive-issues/",
            {"issue_ids": [str(issue.id) for issue in issues]},
            format="json",
        )
    assert response.status_code == 200
    assert recorded.count("issue", "moved") == 1
    assert recorded.ids("issue", "moved") == ids(*issues)
    assert recorded.ids("cycle", "updated") == ids(cycle)
    assert recorded.ids("module", "updated") == ids(module)


def test_sub_items_assignment_publishes_children_and_parent(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, _, _ = board
    parent, children = issues[0], issues[1:]
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(
            f"{project_url(world)}/issues/{parent.id}/sub-issues/",
            {"sub_issue_ids": [str(child.id) for child in children]},
            format="json",
        )
    assert response.status_code == 200
    assert recorded.count("issue", "updated") == 1
    assert recorded.ids("issue", "updated") == ids(parent, *children)


def test_adding_to_a_sprint_publishes_one_batch_for_new_and_moved_items(
    world, recorded, django_capture_on_commit_callbacks, board
):
    _, issues, old_cycle, _ = board
    new_cycle = make_cycle(world.project, world.owner, name="Новый спринт")
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(
            f"{project_url(world)}/cycles/{new_cycle.id}/cycle-issues/",
            {"issues": [str(issue.id) for issue in issues]},
            format="json",
        )
    assert response.status_code == 201
    assert recorded.count("issue", "moved") == 1
    assert recorded.ids("issue", "moved") == ids(*issues)
    assert recorded.ids("cycle", "updated") == ids(new_cycle, old_cycle)


def test_removing_from_a_sprint_publishes(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, cycle, _ = board
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).delete(f"{project_url(world)}/cycles/{cycle.id}/cycle-issues/{issues[0].id}/")
    assert response.status_code == 204
    assert recorded.ids("issue", "moved") == ids(issues[0])
    assert recorded.ids("cycle", "updated") == ids(cycle)


def test_transfer_publishes_the_unfinished_items_once(world, recorded, django_capture_on_commit_callbacks, board):
    states, issues, cycle, _ = board
    for issue in issues[1:]:
        put_in_cycle(issue, cycle)
    Issue.objects.filter(pk=issues[3].pk).update(state=states["completed"])
    next_cycle = make_cycle(world.project, world.owner, name="Следующий")
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(
            f"{project_url(world)}/cycles/{cycle.id}/transfer-issues/",
            {"new_cycle_id": str(next_cycle.id)},
            format="json",
        )
    assert response.status_code == 200
    assert recorded.count("issue", "moved") == 1
    assert recorded.ids("issue", "moved") == ids(*issues[:3])
    assert set(recorded.ids("cycle", "updated")) == {str(cycle.id), str(next_cycle.id)}


def test_deleting_a_sprint_moves_its_items(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, cycle, _ = board
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.owner).delete(f"{project_url(world)}/cycles/{cycle.id}/")
    assert response.status_code == 204
    assert recorded.ids("cycle", "deleted") == ids(cycle)
    assert recorded.ids("issue", "moved") == ids(issues[0])


def test_adding_to_a_direction_publishes_one_batch(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, _, module = board
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(
            f"{project_url(world)}/modules/{module.id}/issues/",
            {"issues": [str(issue.id) for issue in issues]},
            format="json",
        )
    assert response.status_code == 201
    assert recorded.count("issue", "moved") == 1
    assert recorded.ids("issue", "moved") == ids(*issues)
    assert recorded.ids("module", "updated") == ids(module)


def test_directions_of_one_item_publish_added_and_removed(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, _, module = board
    other = make_module(world.project, name="Другое")
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(
            f"{project_url(world)}/issues/{issues[1].id}/modules/",
            {"modules": [str(other.id)], "removed_modules": [str(module.id)]},
            format="json",
        )
    assert response.status_code == 201
    assert recorded.ids("issue", "moved") == ids(issues[1])
    assert recorded.ids("module", "updated") == ids(module, other)
    assert not ModuleIssue.objects.filter(issue=issues[1], module=module).exists()


def test_removing_from_a_direction_publishes(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, _, module = board
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).delete(f"{project_url(world)}/modules/{module.id}/issues/{issues[1].id}/")
    assert response.status_code == 204
    assert recorded.ids("issue", "moved") == ids(issues[1])
    assert recorded.ids("module", "updated") == ids(module)


def test_deleting_a_direction_moves_its_items(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, _, module = board
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.owner).delete(f"{project_url(world)}/modules/{module.id}/")
    assert response.status_code == 204
    assert recorded.ids("module", "deleted") == ids(module)
    assert recorded.ids("issue", "moved") == ids(issues[1])


def test_automatic_archive_and_close_publish_one_batch_per_project(
    world, recorded, django_capture_on_commit_callbacks, board
):
    states, issues, cycle, module = board
    Project.objects.filter(pk=world.project.pk).update(archive_in=1, close_in=1)
    stale = timezone.now() - timedelta(days=45)
    Issue.objects.filter(pk__in=[issues[0].pk, issues[1].pk]).update(state=states["completed"], updated_at=stale)
    Issue.objects.filter(pk__in=[issues[2].pk, issues[3].pk]).update(updated_at=stale)
    # Automation only touches items whose sprint and direction are over.
    Cycle.objects.filter(pk=cycle.pk).update(end_date=timezone.now() - timedelta(days=1))
    Module.objects.filter(pk=module.pk).update(target_date=(timezone.now() - timedelta(days=1)).date())

    with django_capture_on_commit_callbacks(execute=True):
        archive_old_issues()
    assert recorded.count("issue", "moved") == 1
    assert recorded.ids("issue", "moved") == ids(issues[0], issues[1])

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        close_old_issues()
    assert recorded.count("issue", "updated") == 1
    assert recorded.ids("issue", "updated") == ids(issues[2], issues[3])


# ---------------- review round 1 ----------------


def test_one_work_item_change_is_one_group_message(world, recorded, django_capture_on_commit_callbacks, board):
    states, issues, cycle, module = board
    put_in_module(issues[0], module)
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).patch(
            f"{project_url(world)}/issues/{issues[0].id}/", {"state_id": str(states["started"].id)}, format="json"
        )
    assert response.status_code == 204
    assert len(recorded.sent) == 1
    assert recorded.events() == [
        ("issue", "updated", ids(issues[0])),
        ("cycle", "updated", ids(cycle)),
        ("module", "updated", ids(module)),
    ]


def test_description_autosave_does_not_touch_sprints_and_directions(
    world, recorded, django_capture_on_commit_callbacks, board
):
    _, issues, _, _ = board
    for text in ("<p>Черн</p>", "<p>Черновик описания</p>"):
        with django_capture_on_commit_callbacks(execute=True):
            response = api(world.member).patch(
                f"{project_url(world)}/issues/{issues[0].id}/", {"description_html": text}, format="json"
            )
        assert response.status_code == 204
    assert recorded.events() == [("issue", "updated", ids(issues[0])), ("issue", "updated", ids(issues[0]))]


def test_directions_of_one_item_keep_accepting_an_empty_list(
    world, recorded, django_capture_on_commit_callbacks, board
):
    _, issues, _, module = board
    url = f"{project_url(world)}/issues/{issues[1].id}/modules/"
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(url, {"modules": None, "removed_modules": [str(module.id)]}, format="json")
    assert response.status_code == 201
    assert recorded.ids("module", "updated") == ids(module)

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.member).post(url, {"modules": [str(module.id)]}, format="json")
    assert response.status_code == 201
    assert recorded.ids("module", "updated") == ids(module)


def test_soft_delete_cascade_is_one_message(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, cycle, module = board
    parent, child = issues[0], issues[1]
    Issue.objects.filter(pk=child.pk).update(parent=parent)
    IssueAssignee.objects.create(issue=parent, assignee=world.member, project=world.project, workspace=world.workspace)
    Issue.objects.get(pk=parent.pk).delete()
    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        # What the Celery task does after the delete: link, assignee and sub-item saved one by one.
        soft_delete_related_objects("db", "issue", parent.pk)
    assert len(recorded.sent) == 1
    assert recorded.events() == [
        ("issue", "deleted", ids(child)),
        ("cycle", "updated", ids(cycle)),
        ("module", "updated", ids(module)),
    ]


def test_bulk_member_changes_outside_signals_publish_the_projects(world, recorded, django_capture_on_commit_callbacks):
    newcomer = make_user("newcomer")
    WorkspaceMemberFactory(workspace=world.workspace, member=newcomer, role=15)
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.owner).post(
            f"{project_url(world)}/members/", {"members": [{"member_id": str(newcomer.id), "role": 15}]}, format="json"
        )
    assert response.status_code in (200, 201)
    assert recorded.ids("project", "updated") == ids(world.project)

    membership = WorkspaceMember.objects.get(workspace=world.workspace, member=world.member)
    members_url = f"/api/workspaces/{world.workspace.slug}/members/{membership.id}/"
    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.owner).patch(members_url, {"role": 5}, format="json")
    assert response.status_code == 200
    # Lowered to a guest by a queryset update: the person's projects re-read access at once.
    assert recorded.ids("project", "updated") == ids(world.project, world.open_project)

    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        response = api(world.owner).delete(members_url)
    assert response.status_code == 204
    assert recorded.ids("project", "updated") == ids(world.project, world.open_project)


def test_public_api_bulk_links_publish_one_message(world, recorded, django_capture_on_commit_callbacks, board):
    _, issues, old_cycle, _ = board
    token = APIToken.objects.create(user=world.owner, workspace=world.workspace)
    client = APIClient()
    client.credentials(HTTP_X_API_KEY=token.token)
    base = f"/api/v1/workspaces/{world.workspace.slug}/projects/{world.project.id}"

    new_cycle = make_cycle(world.project, world.owner, name="Через API")
    with django_capture_on_commit_callbacks(execute=True):
        response = client.post(
            f"{base}/cycles/{new_cycle.id}/cycle-issues/",
            {"issues": [str(issue.id) for issue in issues]},
            format="json",
        )
    assert response.status_code == 200
    assert recorded.count("issue", "moved") == 1
    assert recorded.ids("issue", "moved") == ids(*issues)
    assert recorded.ids("cycle", "updated") == ids(new_cycle, old_cycle)

    other = make_module(world.project, name="Через API")
    recorded.clear()
    with django_capture_on_commit_callbacks(execute=True):
        response = client.post(
            f"{base}/modules/{other.id}/module-issues/",
            {"issues": [str(issues[2].id), str(issues[3].id)]},
            format="json",
        )
    assert response.status_code == 200
    assert recorded.count("issue", "moved") == 1
    assert recorded.ids("issue", "moved") == ids(issues[2], issues[3])
    assert recorded.ids("module", "updated") == ids(other)
