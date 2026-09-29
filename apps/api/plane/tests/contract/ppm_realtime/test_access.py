"""UX2.1 — the batched read rule of the events socket is exactly the Canvas rule, in a fixed number of queries."""

import uuid

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from plane.db.models import Project, ProjectMember, WorkspaceMember
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_canvas.permissions import PpmCanvasAccess, get_ppm_canvas_access
from plane.ppm_realtime.access import EVERYTHING, OWN_WORK_ITEMS, project_scopes
from plane.tests.factories import ProjectFactory, ProjectMemberFactory, WorkspaceMemberFactory

from .realtime_helpers import make_user


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def canvas_scope(user, workspace_id, project_id):
    """What ``get_ppm_canvas_access`` answers, in the terms of the events socket."""
    access = get_ppm_canvas_access(user=user, workspace_id=workspace_id, project_id=project_id)
    if access == PpmCanvasAccess.DENY:
        return None
    if access == PpmCanvasAccess.EDIT:
        return EVERYTHING
    view_all = Project.all_objects.filter(id=project_id).values_list("guest_view_all_features", flat=True).first()
    return EVERYTHING if view_all else OWN_WORK_ITEMS


def arrange(world, case):
    """A person and the state of their memberships for one case of the rule."""
    person = make_user(f"case-{case}")
    project = world.project
    if case == "outsider":
        return person
    WorkspaceMemberFactory(workspace=world.workspace, member=person, role=15 if case != "guest" else 5)
    if case in ("admin", "member", "guest", "inactive_member", "deleted_member"):
        role = {"admin": 20, "member": 15, "guest": 5}.get(case, 15)
        membership = ProjectMemberFactory(workspace=world.workspace, project=project, member=person, role=role)
        if case == "inactive_member":
            ProjectMember.objects.filter(pk=membership.pk).update(is_active=False)
        if case == "deleted_member":
            ProjectMember.all_objects.filter(pk=membership.pk).update(deleted_at=timezone.now())
    if case == "inactive_workspace_member":
        ProjectMemberFactory(workspace=world.workspace, project=project, member=person, role=15)
        WorkspaceMember.objects.filter(workspace=world.workspace, member=person).update(is_active=False)
    if case == "disabled_account":
        ProjectMemberFactory(workspace=world.workspace, project=project, member=person, role=15)
        type(person).objects.filter(pk=person.pk).update(is_active=False)
        person.refresh_from_db()
    if case == "global_admin":
        PpmGlobalAdmin.objects.create(user=person, reason="UX2.1 access rule")
    return person


CASES = [
    "admin",
    "member",
    "guest",
    "inactive_member",
    "deleted_member",
    "no_project_membership",
    "inactive_workspace_member",
    "disabled_account",
    "outsider",
    "global_admin",
]


@pytest.mark.parametrize("case", CASES)
def test_batched_rule_matches_the_canvas_rule(world, case):
    person = arrange(world, case)
    deleted_project = ProjectFactory(
        workspace=world.workspace, name=f"Deleted {uuid.uuid4().hex[:6]}", identifier="RTD"
    )
    ProjectMemberFactory(workspace=world.workspace, project=deleted_project, member=person, role=20)
    Project.all_objects.filter(pk=deleted_project.pk).update(deleted_at=timezone.now())
    archived_project = ProjectFactory(
        workspace=world.workspace, name=f"Archived {uuid.uuid4().hex[:6]}", identifier="RTA"
    )
    ProjectMemberFactory(workspace=world.workspace, project=archived_project, member=person, role=5)
    Project.objects.filter(pk=archived_project.pk).update(archived_at=timezone.now())
    projects = [
        world.project,
        world.open_project,
        world.closed_project,
        world.foreign_project,
        deleted_project,
        archived_project,
    ]
    if case == "guest":
        ProjectMemberFactory(workspace=world.workspace, project=world.open_project, member=person, role=5)

    expected = {str(project.id): canvas_scope(person, world.workspace.id, project.id) for project in projects}
    missing = str(uuid.uuid4())
    expected[missing] = None
    assert project_scopes(person, world.workspace.id, [*expected]) == expected


def test_guest_scope_follows_view_all_features(world):
    guest_scopes = project_scopes(world.guest, world.workspace.id, [world.project.id, world.open_project.id])
    assert guest_scopes == {str(world.project.id): OWN_WORK_ITEMS, str(world.open_project.id): EVERYTHING}


@pytest.mark.parametrize("count", [1, 20])
def test_any_number_of_projects_costs_the_same_few_queries(world, count):
    projects = [world.project, world.open_project]
    for index in range(count - len(projects) if count > len(projects) else 0):
        extra = ProjectFactory(
            workspace=world.workspace, name=f"Extra {index} {uuid.uuid4().hex[:4]}", identifier=f"X{index}"
        )
        ProjectMemberFactory(workspace=world.workspace, project=extra, member=world.member, role=15)
        projects.append(extra)
    ids = [str(project.id) for project in projects[:count]]
    with CaptureQueriesContext(connection) as queries:
        scopes = project_scopes(world.member, world.workspace.id, ids)
    assert all(scope == EVERYTHING for scope in scopes.values())
    # projects, global admin, workspace membership, roles — whatever the number of projects.
    assert len(queries.captured_queries) <= 4


@pytest.mark.parametrize("count", [1, 20])
def test_periodic_recheck_of_a_socket_costs_the_same_few_queries(world, count):
    """Person, session, global admin, workspace membership, projects, roles — for 1 or 20 subscriptions."""
    from importlib import import_module

    from django.conf import settings
    from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY

    from plane.ppm_realtime.consumers import PpmProjectEventsConsumer

    store = import_module(settings.SESSION_ENGINE).SessionStore()
    store[SESSION_KEY] = str(world.member.pk)
    store[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
    store[HASH_SESSION_KEY] = world.member.get_session_auth_hash()
    store.create()
    projects = [world.project, world.open_project]
    for index in range(max(count - len(projects), 0)):
        extra = ProjectFactory(
            workspace=world.workspace, name=f"Recheck {index} {uuid.uuid4().hex[:4]}", identifier=f"R{index}"
        )
        ProjectMemberFactory(workspace=world.workspace, project=extra, member=world.member, role=15)
        projects.append(extra)
    consumer = PpmProjectEventsConsumer()
    consumer.user_id = str(world.member.id)
    consumer.workspace_id = str(world.workspace.id)
    consumer.session_key = store.session_key
    consumer.connection_id = uuid.uuid4().hex
    consumer.scope = {"path": "/ws/ppm/v1/workspaces/probe/events/"}

    with CaptureQueriesContext(connection) as queries:
        # The plain function behind database_sync_to_async: the queries run right here, in the test transaction.
        ended, scopes = PpmProjectEventsConsumer.__dict__["_read_access"].func(
            consumer, [str(project.id) for project in projects[:count]]
        )
    assert ended is None
    assert len(scopes) == count and all(scope == EVERYTHING for scope in scopes.values())
    assert len(queries.captured_queries) <= 6
