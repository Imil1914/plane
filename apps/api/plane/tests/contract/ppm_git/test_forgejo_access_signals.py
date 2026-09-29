"""G2.2 R16 — когда синхронизируются доступы: сигналы, отложенная задача со склейкой, полная сверка по расписанию.

Без единого входа (dev-API владельца без миграции 0009) сигналы и задачи ничего не делают и не читают новые таблицы.
С единым входом изменения членства, ролей, людей, глобальных администраторов, подключений Forgejo, проектов и
пространств ставят одну отложенную (≈5 с) задачу на затронутый круг; события за это время склеиваются.
"""

import importlib
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from plane.celery import app as celery_app
from plane.db.models import User
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_git import forgejo_access, tasks
from plane.ppm_git.forgejo_admin import ForgejoAdminClient
from plane.ppm_git.models import (
    PpmForgejoAccount,
    PpmGitAudit,
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitRepository,
)
from plane.tests.contract.ppm_git.forgejo_admin_fake import SSO_SETTINGS, FakeForgejoAdminApi
from plane.tests.contract.ppm_git.forgejo_fake import PUBLIC_URL
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def sso(settings):
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)
    return settings


@pytest.fixture
def api(sso, monkeypatch):
    api = FakeForgejoAdminApi()
    monkeypatch.setattr(
        forgejo_access, "ForgejoAdminClient", lambda: ForgejoAdminClient(session=api, page_size=api.page_size)
    )
    return api


@pytest.fixture(autouse=True)
def scheduled(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "plane.ppm_git.tasks.sync_forgejo_access_task.apply_async", lambda *args, **kwargs: calls.append(kwargs)
    )
    forgejo_access.clear_access_cache()
    yield calls
    forgejo_access.clear_access_cache()


def person(email, **extra):
    return UserFactory(email=email, username=uuid.uuid4().hex, **extra)


def connection_for(project, *, provider="forgejo", full_name="team-alpha/app"):
    actor = uuid.uuid4()
    installation = PpmGitInstallation.objects.create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        provider=provider,
        provider_installation_id=1 if provider == "forgejo" else 81001,
        provider_account_id=2,
        account_login="ppm-bot",
        created_by=actor,
        updated_by=actor,
    )
    record = PpmGitRepository.objects.create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        name="app",
        normalized_name="app",
        provider=provider,
        provider_repository_id=1,
        provider_full_name=full_name,
        canonical_url=f"{PUBLIC_URL}/{full_name}",
        clone_https=f"{PUBLIC_URL}/{full_name}.git",
        created_by=actor,
        updated_by=actor,
    )
    return PpmGitConnection.objects.create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        installation=installation,
        repository=record,
        provider_repository_id=1,
        provider_full_name=full_name,
        created_by=actor,
        updated_by=actor,
    )


def test_without_sso_signals_do_nothing_and_read_no_new_table(
    settings, monkeypatch, django_capture_on_commit_callbacks
):
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)
    settings.PPM_GIT_SSO_ENABLED = False
    calls = []
    monkeypatch.setattr(forgejo_access, "schedule_access_sync", lambda **kwargs: calls.append(kwargs))

    with CaptureQueriesContext(connection) as queries, django_capture_on_commit_callbacks(execute=True):
        user = person("ivan@example.test")
        workspace = WorkspaceFactory(slug="team-alpha")
        WorkspaceMemberFactory(workspace=workspace, member=user, role=15)
        project = ProjectFactory(workspace=workspace, identifier="APP")
        member = ProjectMemberFactory(project=project, member=user, role=15)
        member.role = 20
        member.save()
        grant = PpmGlobalAdmin.objects.create(user=user, reason="test")
        grant.delete()
        connection_for(project)
        project.name = "Новое имя"
        project.save()
        member.delete(soft=False)
        user.first_name = "Пётр"
        user.save()

    assert calls == []
    assert not [query["sql"] for query in queries.captured_queries if "ppm_forgejo" in query["sql"]]


def test_changes_schedule_one_coalesced_sync(sso, scheduled, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        workspace = WorkspaceFactory(slug="team-alpha")
        project = ProjectFactory(workspace=workspace, identifier="APP")
    with django_capture_on_commit_callbacks(execute=True):
        member = ProjectMemberFactory(project=project, member=person("dev@example.test"), role=15)
    with django_capture_on_commit_callbacks(execute=True):
        member.role = 20
        member.save(update_fields=["role"])

    pending = forgejo_access.pending_scope()
    assert str(workspace.id) in pending["workspace_ids"]
    assert pending["project_ids"] == [str(project.id)]
    assert len(scheduled) == 1
    assert scheduled[0]["countdown"] == 5 and scheduled[0]["kwargs"] == {"scope": {}}


def test_what_schedules_which_scope(sso, django_capture_on_commit_callbacks):
    workspace = WorkspaceFactory(slug="team-alpha")
    ProjectFactory(workspace=workspace, identifier="APP")
    user = person("dev@example.test")
    PpmForgejoAccount.objects.create(user_id=user.id, forgejo_user_id=10, username="dev")
    stranger = person("stranger@example.test")
    forgejo_access.clear_access_cache()

    with django_capture_on_commit_callbacks(execute=True):
        membership = WorkspaceMemberFactory(workspace=workspace, member=user, role=15)
        PpmGlobalAdmin.objects.create(user=user, reason="test")
        user.last_name = "Петров"
        user.save()
        stranger.last_name = "Чужой"
        stranger.save()

    pending = forgejo_access.pending_scope()
    assert pending["user_ids"] == [str(user.id)]
    assert pending["project_ids"] == []
    membership.is_active = False
    with django_capture_on_commit_callbacks(execute=True):
        membership.save()
    assert forgejo_access.pending_scope()["user_ids"] == [str(user.id)]


def test_preferences_and_sync_bookkeeping_do_not_schedule(sso, django_capture_on_commit_callbacks):
    workspace = WorkspaceFactory(slug="team-alpha")
    project = ProjectFactory(workspace=workspace, identifier="APP")
    member = ProjectMemberFactory(project=project, member=person("dev@example.test"), role=15)
    github = connection_for(project, provider="github", full_name="org/app")
    forgejo = connection_for(ProjectFactory(workspace=workspace, identifier="WEB"))
    forgejo_access.clear_access_cache()

    with django_capture_on_commit_callbacks(execute=True):
        member.view_props = {"filters": {}}
        member.save(update_fields=["view_props"])
        github.status = "disconnected"
        github.save(update_fields=["status"])
        forgejo.status = "syncing"
        forgejo.save(update_fields=["status", "last_sync_at"])
        user = User.objects.get(id=member.member_id)
        user.last_active = user.date_joined
        user.save(update_fields=["last_active"])

    pending = forgejo_access.pending_scope()
    assert (pending["user_ids"], pending["project_ids"], pending["workspace_ids"], pending["full"]) == (
        [],
        [],
        [],
        False,
    )

    with django_capture_on_commit_callbacks(execute=True):
        forgejo.status = "disconnected"
        forgejo.save(update_fields=["status", "disconnected_at"])

    assert forgejo_access.pending_scope()["project_ids"] == [str(forgejo.project_id)]


def test_the_task_runs_the_pending_scope_once(api, django_capture_on_commit_callbacks):
    workspace = WorkspaceFactory(slug="team-alpha", name="Альфа")
    project = ProjectFactory(workspace=workspace, identifier="APP")
    user = person("dev@example.test")
    WorkspaceMemberFactory(workspace=workspace, member=user, role=15)
    forgejo_access.ensure_account_for_login(user)
    forgejo_access.clear_access_cache()

    with django_capture_on_commit_callbacks(execute=True):
        ProjectMemberFactory(project=project, member=user, role=15)

    tasks.sync_forgejo_access_task(scope={})

    assert api.members(api.team("team-alpha", "APP")) == ["dev"]
    assert forgejo_access.pending_scope()["project_ids"] == []
    writes = len(api.writes())
    tasks.sync_forgejo_access_task(scope={})
    assert len(api.writes()) == writes


def test_tasks_do_nothing_without_sso(settings, monkeypatch):
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)
    settings.PPM_GIT_SSO_ENABLED = False
    api = FakeForgejoAdminApi()
    monkeypatch.setattr(forgejo_access, "ForgejoAdminClient", lambda: ForgejoAdminClient(session=api))

    assert tasks.sync_forgejo_access_task(scope={"full": True}) is None
    assert tasks.reconcile_forgejo_access() is None
    forgejo_access.schedule_access_sync(user_ids=[uuid.uuid4()], full=True)

    assert api.requests == []
    assert forgejo_access.pending_scope()["user_ids"] == []


def test_full_scope_runs_the_reconcile(api, scheduled, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        forgejo_access.schedule_access_sync(full=True)

    assert forgejo_access.pending_scope()["full"] is True
    tasks.sync_forgejo_access_task(scope={})

    assert forgejo_access.pending_scope()["full"] is False
    assert api.calls("GET", r"^/admin/users$")  # the full reconcile lists every account of the source


def test_beat_runs_the_reconcile_every_ten_minutes():
    entry = celery_app.conf.beat_schedule["ppm-git-forgejo-access-reconcile"]

    assert entry["task"] == "plane.ppm_git.tasks.reconcile_forgejo_access"
    assert entry["schedule"].run_every == timedelta(minutes=10)
    # G2.2 R1 (line S1): expired OAuth2 tokens of the Git server client are cleared daily at 04:00 UTC.
    tokens = celery_app.conf.beat_schedule["ppm-oidc-clear-expired-tokens"]
    assert tokens["task"] == "plane.ppm_oidc.tasks.clear_expired_oidc_tokens"
    assert (tokens["schedule"].hour, tokens["schedule"].minute) == ({4}, {0})
    assert importlib.import_module("plane.ppm_oidc.tasks").clear_expired_oidc_tokens.name == tokens["task"]


def test_audit_accepts_system_rows():
    row = PpmGitAudit.objects.create(
        workspace_id=None,
        project_id=None,
        actor_id=None,
        action="forgejo.access.account_created",
        target_type="forgejo_account",
        request_id=uuid.uuid4(),
    )

    assert PpmGitAudit.objects.get(id=row.id).actor_id is None


def test_scheduling_never_breaks_the_change_that_triggered_it(sso, monkeypatch, django_capture_on_commit_callbacks):
    def broken(*args, **kwargs):
        raise RuntimeError("broker is down")

    monkeypatch.setattr("plane.ppm_git.tasks.sync_forgejo_access_task.apply_async", broken)
    workspace = WorkspaceFactory(slug="team-alpha")

    with django_capture_on_commit_callbacks(execute=True):
        project = ProjectFactory(workspace=workspace, identifier="APP")

    assert project.pk is not None
    # The failed attempt leaves no stale «already scheduled» mark: the next change schedules again.
    calls = []
    monkeypatch.setattr(
        "plane.ppm_git.tasks.sync_forgejo_access_task.apply_async", lambda *args, **kwargs: calls.append(kwargs)
    )
    with django_capture_on_commit_callbacks(execute=True):
        project.identifier = "WEB"
        project.save()

    assert len(calls) == 1
    assert str(project.id) in forgejo_access.pending_scope()["project_ids"]


def test_adding_people_to_a_project_through_the_api_schedules_the_project(
    sso, scheduled, api_client, django_capture_on_commit_callbacks
):
    # The main path (ProjectMemberViewSet.create) writes memberships in bulk — no model signal; it schedules itself.
    lead = person("lead@example.test")
    newcomer = person("newcomer@example.test")
    workspace = WorkspaceFactory(slug="team-alpha", owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    WorkspaceMemberFactory(workspace=workspace, member=newcomer, role=15)
    project = ProjectFactory(workspace=workspace, identifier="APP")
    ProjectMemberFactory(project=project, member=lead, role=20)
    forgejo_access.clear_access_cache()
    scheduled.clear()
    api_client.force_authenticate(user=lead)

    with (
        patch("plane.app.views.project.member.project_add_user_email.delay"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = api_client.post(
            f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/",
            {"members": [{"member_id": str(newcomer.id), "role": 15}]},
            format="json",
        )

    assert response.status_code == 201, response.data
    assert forgejo_access.pending_scope()["project_ids"] == [str(project.id)]
    assert len(scheduled) == 1


def test_signing_in_without_project_invitations_schedules_nothing(sso, django_capture_on_commit_callbacks):
    from plane.authentication.utils.workspace_project_join import process_workspace_project_invitations
    from plane.db.models import WorkspaceMemberInvite

    user = person("invited@example.test")
    workspace = WorkspaceFactory(slug="team-alpha")
    WorkspaceMemberInvite.objects.create(
        workspace=workspace, email=user.email, accepted=True, role=15, token="invitation-token"
    )
    forgejo_access.clear_access_cache()

    with (
        patch("plane.authentication.utils.workspace_project_join.track_event.delay"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        process_workspace_project_invitations(user)

    pending = forgejo_access.pending_scope()
    assert (pending["user_ids"], pending["project_ids"]) == ([], [])


def test_signing_in_with_project_invitations_schedules_the_person_and_projects(
    sso, monkeypatch, django_capture_on_commit_callbacks
):
    from plane.authentication.utils.workspace_project_join import process_workspace_project_invitations
    from plane.db.models import ProjectMember, ProjectMemberInvite

    user = person("invited@example.test")
    workspace = WorkspaceFactory(slug="team-alpha")
    project = ProjectFactory(workspace=workspace, identifier="APP")
    ProjectMemberInvite.objects.create(
        project=project, workspace=workspace, email=user.email, accepted=True, role=15, token="invitation-token"
    )
    forgejo_access.clear_access_cache()
    # Upstream Plane builds these memberships without a project (NOT NULL): the insert itself is left out here, the
    # hook after it is what is checked.
    monkeypatch.setattr(ProjectMember.objects, "bulk_create", lambda *args, **kwargs: [])

    with django_capture_on_commit_callbacks(execute=True):
        process_workspace_project_invitations(user)

    pending = forgejo_access.pending_scope()
    assert (pending["user_ids"], pending["project_ids"]) == ([str(user.id)], [str(project.id)])
