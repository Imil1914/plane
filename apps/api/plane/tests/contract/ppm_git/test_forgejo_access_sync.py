"""G2.2 R11–R16 — доступы к коду на Git-сервере по модели PPM (`forgejo_access`), поддельный Forgejo 15.

Пространство → частная организация (перенимается, если уже есть; имя, занятое человеком, — с суффиксом), проект →
команды `<КЛЮЧ>-admin` / `<КЛЮЧ>` / `<КЛЮЧ>-read` по ролям (создаются, когда нужны, не-admin — с `units_map`),
репозитории проекта (активные подключения, лежащие в организации) — во всех его командах, уход и отключение убирают
доступ, глобальные администраторы PPM — администраторы Git-сервера. Полная сверка откатывает ручные правки, ловит
массовые изменения без сигналов, второй прогон ничего не меняет. Чужие учётки и команда Owners не трогаются.
"""

import time
import uuid
from types import SimpleNamespace

import pytest
import requests
from django.utils import timezone

from plane.db.models import Project, ProjectMember, User, WorkspaceMember
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_git import forgejo_access
from plane.ppm_git.forgejo_access import (
    apply_user_access,
    ensure_account_for_login,
    run_access_sync,
    run_full_reconcile,
)
from plane.ppm_git.forgejo_admin import TEAM_UNITS, ForgejoAdminClient
from plane.ppm_git.models import (
    PpmForgejoAccount,
    PpmForgejoOrganization,
    PpmForgejoTeam,
    PpmGitAudit,
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitRepository,
)
from plane.tests.contract.ppm_git.forgejo_admin_fake import SOURCE_ID, SSO_SETTINGS, FakeForgejoAdminApi
from plane.tests.contract.ppm_git.forgejo_fake import PUBLIC_URL, FakeResponse
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

OUTSIDE = "Доступ к {} настраивается вручную: он вне организации пространства"


@pytest.fixture
def api(settings, monkeypatch):
    api = FakeForgejoAdminApi()
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)
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
    return UserFactory(email=email, username=uuid.uuid4().hex, display_name=email.split("@")[0].title(), **extra)


@pytest.fixture
def world(api):
    owner = person("owner@example.test")
    workspace = WorkspaceFactory(slug="team-alpha", name="Команда Альфа", owner=owner)
    project = ProjectFactory(workspace=workspace, identifier="APP", name="Приложение")
    people = {}
    for key, role in (("lead", 20), ("dev", 15), ("guest", 5)):
        user = person(f"{key}@example.test")
        WorkspaceMemberFactory(workspace=workspace, member=user, role=15 if role == 20 else role)
        ProjectMemberFactory(project=project, member=user, role=role)
        people[key] = user
    people["outsider"] = person("outsider@example.test")
    WorkspaceMemberFactory(workspace=workspace, member=people["outsider"], role=15)
    return SimpleNamespace(workspace=workspace, project=project, **people)


def login(user):
    ensure_account_for_login(user)
    return apply_user_access(user)


def login_all(world):
    for user in (world.lead, world.dev, world.guest):
        assert login(user) is True


def teams(api, key="APP", org="team-alpha"):
    return api.team(org, f"{key}-admin"), api.team(org, key), api.team(org, f"{key}-read")


def project_scope(project):
    return {"project_ids": [str(project.id)]}


def connect(api, project, repository, *, status="active"):
    actor = uuid.uuid4()
    installation, _ = PpmGitInstallation.objects.get_or_create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        provider="forgejo",
        provider_installation_id=1,
        defaults={
            "provider_account_id": api.bot["id"],
            "account_login": "ppm-bot",
            "created_by": actor,
            "updated_by": actor,
        },
    )
    owner = api.accounts[repository["owner_id"]]["login"]
    full_name = f"{owner}/{repository['name']}"
    record = PpmGitRepository.objects.create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        name=repository["name"],
        normalized_name=full_name.lower(),
        provider="forgejo",
        provider_repository_id=repository["id"],
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
        provider_repository_id=repository["id"],
        provider_full_name=full_name,
        status=status,
        created_by=actor,
        updated_by=actor,
    )


def actions():
    return list(PpmGitAudit.objects.order_by("created_at").values_list("action", flat=True))


def test_login_builds_the_organization_and_teams_by_role(api, world):
    login_all(world)

    organization = api.org("team-alpha")
    assert organization["visibility"] == "private" and organization["full_name"] == "Команда Альфа"
    admin, write, read = teams(api)
    assert (admin["permission"], admin["can_create_org_repo"]) == ("admin", True)
    assert (write["permission"], write["can_create_org_repo"]) == ("write", False)
    assert (read["permission"], read["can_create_org_repo"]) == ("read", False)
    assert write["units_map"] == {unit: "write" for unit in TEAM_UNITS}
    assert read["units_map"] == {unit: "read" for unit in TEAM_UNITS}
    assert not any(team["includes_all_repositories"] for team in (admin, write, read))
    assert (api.members(admin), api.members(write), api.members(read)) == (["lead"], ["dev"], ["guest"])
    assert write["description"] == "PPM: Запись проекта «Приложение». Состав ведёт PPM — не меняйте вручную"
    assert admin["description"] == "PPM: Администратор проекта «Приложение». Состав ведёт PPM — не меняйте вручную"
    assert read["description"] == "PPM: Чтение проекта «Приложение». Состав ведёт PPM — не меняйте вручную"
    # Teams appear only when needed: the admin team came with the lead's first sign-in, alone.
    creations = [item["body"]["name"] for item in api.calls("POST", r"^/orgs/team-alpha/teams$")]
    assert creations == ["APP-admin", "APP", "APP-read"]
    assert PpmForgejoOrganization.objects.get().name == "team-alpha"
    assert set(PpmForgejoTeam.objects.values_list("role", "name")) == {
        ("admin", "APP-admin"),
        ("write", "APP"),
        ("read", "APP-read"),
    }
    assert actions().count("forgejo.access.organization_created") == 1
    assert actions().count("forgejo.access.team_created") == 3
    assert actions().count("forgejo.access.member_added") == 3
    assert api.user("outsider") is None
    assert api.members(api.teams[organization["owners_team"]]) == ["ppm-bot"]


def test_sync_never_creates_accounts(api, world):
    run = run_full_reconcile()

    assert api.writes() == []
    assert run.kind == "full" and run.status == "ok"
    assert PpmForgejoAccount.objects.count() == 0


def test_repositories_follow_the_connections_of_the_project(api, world):
    login_all(world)
    app = api.add_repository("team-alpha", "app")
    sandbox = api.add_repository("dev", "sandbox")
    api.add_org("elsewhere")
    library = api.add_repository("elsewhere", "lib")
    connection = connect(api, world.project, app)
    connect(api, world.project, sandbox)
    connect(api, world.project, library)

    run = run_access_sync(project_scope(world.project))

    for team in teams(api):
        assert api.team_repositories(team) == ["team-alpha/app"]
    messages = [problem["message"] for problem in run.problems]
    assert OUTSIDE.format("dev/sandbox") in messages
    assert OUTSIDE.format("elsewhere/lib") in messages
    assert {problem["level"] for problem in run.problems} == {"warning"}
    assert run.status == "ok"
    assert run.counts["repositories_added"] == 3

    PpmGitConnection.objects.filter(id=connection.id).update(status="disconnected")
    run_access_sync(project_scope(world.project))

    for team in teams(api):
        assert api.team_repositories(team) == []
    assert app["id"] in api.repositories
    assert actions().count("forgejo.access.repository_removed") == 3


def test_role_change_moves_the_person_between_teams(api, world):
    login_all(world)
    ProjectMember.objects.filter(project=world.project, member=world.dev).update(role=20)

    run_access_sync(project_scope(world.project))

    admin, write, read = teams(api)
    assert (api.members(admin), api.members(write), api.members(read)) == (["dev", "lead"], [], ["guest"])


def test_bulk_removals_without_signals_are_caught_by_the_full_reconcile(api, world):
    login_all(world)
    ProjectMember.objects.filter(project=world.project, member=world.dev).update(is_active=False)
    WorkspaceMember.objects.filter(workspace=world.workspace, member=world.guest).update(is_active=False)

    run = run_full_reconcile()

    admin, write, read = teams(api)
    assert (api.members(admin), api.members(write), api.members(read)) == (["lead"], [], [])
    assert run.counts["members_removed"] == 2
    assert api.user("dev")["prohibit_login"] is False


def test_user_scope_leaves_teams_found_through_sudo(api, world):
    login_all(world)
    ProjectMember.objects.filter(project=world.project, member=world.dev).update(is_active=False)

    run_access_sync({"user_ids": [str(world.dev.id)]})

    assert api.members(api.team("team-alpha", "APP")) == []
    assert api.calls("GET", r"^/user/teams$")[-1]["sudo"] == "dev"


def test_disabled_person_is_locked_out_and_comes_back(api, world):
    login_all(world)
    User.objects.filter(id=world.dev.id).update(is_active=False)

    run_full_reconcile()

    assert api.user("dev")["prohibit_login"] is True
    assert api.members(api.team("team-alpha", "APP")) == []
    assert PpmForgejoAccount.objects.get(user_id=world.dev.id).prohibited is True
    assert "forgejo.access.login_prohibited" in actions()

    User.objects.filter(id=world.dev.id).update(is_active=True)
    run_full_reconcile()

    assert api.user("dev")["prohibit_login"] is False
    assert api.members(api.team("team-alpha", "APP")) == ["dev"]
    assert "forgejo.access.login_restored" in actions()


def test_deleted_person_is_locked_out(api, world):
    login_all(world)
    account = PpmForgejoAccount.objects.get(user_id=world.guest.id)
    # A hard deletion cascades to the memberships; the account row (a plain UUID) outlives the person.
    User.objects.filter(id=world.guest.id).delete()

    run_full_reconcile()

    assert api.user(account.username)["prohibit_login"] is True
    assert api.members(api.team("team-alpha", "APP-read")) == []


def test_global_administrator_is_granted_and_revoked(api, world):
    login(world.dev)
    grant = PpmGlobalAdmin.objects.create(user=world.dev, reason="test")

    run_access_sync({"user_ids": [str(world.dev.id)]})
    assert api.user("dev")["is_admin"] is True
    assert PpmForgejoAccount.objects.get(user_id=world.dev.id).admin_granted is True

    PpmGlobalAdmin.objects.filter(id=grant.id).update(revoked_at=timezone.now())
    run_access_sync({"user_ids": [str(world.dev.id)]})
    assert api.user("dev")["is_admin"] is False
    assert PpmForgejoAccount.objects.get(user_id=world.dev.id).admin_granted is False
    assert {"forgejo.access.admin_granted", "forgejo.access.admin_revoked"} <= set(actions())


def test_accounts_ppm_did_not_create_are_never_touched(api, world):
    # R14: a local account of the «Быстрый» mode, the service account, the emergency administrator — their flags
    # and their team memberships stay as they are, even in PPM's teams.
    stranger = api.add_user("stranger", email="stranger@example.test", is_admin=True)
    login_all(world)
    PpmGlobalAdmin.objects.create(user=world.lead, reason="test")
    team = api.team("team-alpha", "APP")
    for login in ("stranger", "git-admin", "ppm-bot"):
        team["members"].add(api.find(login)["id"])
    snapshot = {login: dict(api.user(login)) for login in ("ppm-bot", "git-admin", "stranger")}

    run_full_reconcile()

    touched = {item["path"] for item in api.calls("PATCH", r"^/admin/users/")}
    assert not touched & {"/admin/users/ppm-bot", "/admin/users/git-admin", "/admin/users/stranger"}
    assert {login: dict(api.user(login)) for login in snapshot} == snapshot
    assert api.members(team) == ["dev", "git-admin", "ppm-bot", "stranger"]
    assert stranger["id"] in team["members"]


def test_manual_changes_of_ppm_teams_are_rolled_back(api, world):
    login_all(world)
    app = api.add_repository("team-alpha", "app")
    connect(api, world.project, app)
    run_access_sync(project_scope(world.project))
    admin, write, read = teams(api)
    write.update(
        permission="admin",
        units_map={unit: "admin" for unit in TEAM_UNITS},
        description="правка руками",
        can_create_org_repo=True,
        includes_all_repositories=True,
    )
    read["units_map"] = {**read["units_map"], "repo.code": "write", "repo.actions": "read"}
    admin["name"] = "renamed-by-hand"
    stranger = api.add_user("stranger", email="stranger@example.test")
    write["members"].add(stranger["id"])
    write["members"].add(api.user("guest")["id"])  # a PPM account PPM did not put there
    secret = api.add_repository("team-alpha", "secret")
    write["repositories"].add(secret["id"])
    owners = api.teams[api.org("team-alpha")["owners_team"]]
    owners_before = (dict(owners), set(owners["members"]))

    run = run_full_reconcile()

    admin, write, read = teams(api)
    assert admin is not None and admin["permission"] == "admin"
    assert (write["permission"], write["can_create_org_repo"], write["includes_all_repositories"]) == (
        "write",
        False,
        False,
    )
    assert write["units_map"] == {unit: "write" for unit in TEAM_UNITS}
    assert read["units_map"] == {unit: "read" for unit in TEAM_UNITS}
    assert write["description"].startswith("PPM: Запись проекта")
    # PPM's own account leaves; an account PPM does not keep stays (R14).
    assert api.members(write) == ["dev", "stranger"]
    assert api.team_repositories(write) == ["team-alpha/app"]
    assert (dict(owners), set(owners["members"])) == owners_before
    assert run.counts["teams_updated"] + run.counts["teams_renamed"] == 3
    assert run.counts["members_removed"] == 1
    assert "forgejo.access.team_renamed" in actions()


def test_an_administrator_ppm_did_not_make_keeps_everything(api, world):
    login_all(world)
    dev = api.user("dev")
    dev["is_admin"] = True  # made an administrator on the Git server by hand
    ProjectMember.objects.filter(project=world.project, member=world.dev).update(is_active=False)
    User.objects.filter(id=world.dev.id).update(display_name="Новое имя", is_active=False)

    run = run_full_reconcile()

    assert api.calls("PATCH", r"^/admin/users/dev$") == []
    assert (dev["is_admin"], dev["prohibit_login"]) == (True, False)
    assert api.members(api.team("team-alpha", "APP")) == ["dev"]
    warning = next(problem for problem in run.problems if problem["subject"] == "dev")
    assert warning["level"] == "warning" and "назначенный не PPM" in warning["message"]
    assert run.status == "ok"


def test_project_key_change_renames_the_teams(api, world):
    login_all(world)
    before = {team["id"] for team in teams(api)}
    Project.objects.filter(id=world.project.id).update(identifier="WEB")

    run_access_sync(project_scope(world.project))

    renamed = teams(api, "WEB")
    assert all(renamed) and {team["id"] for team in renamed} == before
    assert not any(teams(api, "APP"))
    assert set(PpmForgejoTeam.objects.values_list("name", flat=True)) == {"WEB-admin", "WEB", "WEB-read"}
    assert actions().count("forgejo.access.team_renamed") == 3


def test_deleted_project_loses_its_teams_but_not_its_repositories(api, world):
    login_all(world)
    app = api.add_repository("team-alpha", "app")
    connect(api, world.project, app)
    run_access_sync(project_scope(world.project))
    Project.all_objects.filter(id=world.project.id).update(deleted_at=timezone.now())

    run_access_sync(project_scope(world.project))

    assert [team["name"] for team in api.org_teams("team-alpha")] == ["Owners"]
    assert PpmForgejoTeam.objects.count() == 0
    assert app["id"] in api.repositories
    assert actions().count("forgejo.access.team_deleted") == 3


def test_second_full_reconcile_changes_nothing(api, world):
    login_all(world)
    connect(api, world.project, api.add_repository("team-alpha", "app"))
    run_full_reconcile()
    writes = len(api.writes())

    run = run_full_reconcile()

    assert run.counts["changes"] == 0
    assert len(api.writes()) == writes
    assert run.status == "ok"
    assert (run.counts["accounts"], run.counts["organizations"], run.counts["teams"], run.counts["repositories"]) == (
        3,
        1,
        3,
        1,
    )
    assert run.started_at <= run.finished_at


def test_existing_organization_is_adopted_without_touching_owners(api, world):
    api.add_org("team-alpha", owner="git-admin", description="Старая организация", location="Москва")

    assert login(world.lead) is True

    record = PpmForgejoOrganization.objects.get()
    assert record.adopted is True and record.name == "team-alpha"
    organization = api.org("team-alpha")
    assert organization["full_name"] == "Команда Альфа" and organization["visibility"] == "private"
    assert (organization["description"], organization["location"]) == ("Старая организация", "Москва")
    assert api.members(api.teams[organization["owners_team"]]) == ["git-admin"]
    assert api.members(api.team("team-alpha", "APP-admin")) == ["lead"]
    assert "forgejo.access.organization_adopted" in actions()


def test_organization_name_taken_by_a_person_gets_a_suffix(api, world):
    api.add_user("team-alpha", email="someone@example.test")

    assert login(world.lead) is True

    assert PpmForgejoOrganization.objects.get().name == "team-alpha-2"
    assert api.org("team-alpha-2") is not None
    assert api.calls("PATCH", r"^/admin/users/team-alpha$") == []


def test_a_team_ppm_does_not_manage_is_never_taken_over(api, world):
    api.add_org("team-alpha", owner="ppm-bot")
    foreign = api.add_team(
        "team-alpha", "APP-admin", permission="write", members=["git-admin"], description="Команда подрядчика"
    )
    before = (dict(foreign), set(foreign["members"]), set(foreign["repositories"]))

    assert login(world.lead) is True

    ours = api.team("team-alpha", "APP-admin-ppm")
    assert ours is not None and ours["id"] != foreign["id"]
    assert (ours["permission"], ours["can_create_org_repo"]) == ("admin", True)
    assert api.members(ours) == ["lead"]
    assert (dict(foreign), set(foreign["members"]), set(foreign["repositories"])) == before
    run = forgejo_access.PpmForgejoSyncRun.objects.order_by("-started_at").first()
    assert {"kind": "team", "subject": "APP-admin", "level": "warning"}.items() <= run.problems[0].items()
    assert run.problems[0]["message"] == (
        "Команда APP-admin в организации team-alpha не управляется PPM — PPM создал APP-admin-ppm"
    )
    assert "forgejo.access.team_adopted" not in actions()

    again = run_full_reconcile()

    assert again.counts["changes"] == 0
    assert api.team("team-alpha", "APP-admin-ppm")["id"] == ours["id"]
    assert PpmForgejoTeam.objects.get(role="admin").name == "APP-admin-ppm"


def test_a_team_described_by_ppm_is_recovered_after_a_lost_answer(api, world):
    api.add_org("team-alpha", owner="ppm-bot")
    lost = api.add_team(
        "team-alpha",
        "APP-admin",
        permission="admin",
        description="PPM: Администратор проекта «Приложение». Состав ведёт PPM — не меняйте вручную",
    )

    assert login(world.lead) is True

    assert api.team("team-alpha", "APP-admin")["id"] == lost["id"]
    assert api.team("team-alpha", "APP-admin-ppm") is None
    assert api.members(lost) == ["lead"]
    assert "forgejo.access.team_adopted" in actions()


def test_a_new_key_taken_by_a_team_ppm_does_not_manage_gets_the_suffix(api, world):
    login_all(world)
    foreign = api.add_team("team-alpha", "WEB", permission="read", description="Чужая команда")
    Project.objects.filter(id=world.project.id).update(identifier="WEB")

    run = run_access_sync(project_scope(world.project))

    assert api.team("team-alpha", "WEB")["id"] == foreign["id"] and api.members(foreign) == []
    assert api.members(api.team("team-alpha", "WEB-ppm")) == ["dev"]
    assert api.members(api.team("team-alpha", "WEB-admin")) == ["lead"]
    assert "PPM назвал свою команду WEB-ppm" in " ".join(problem["message"] for problem in run.problems)
    assert run_full_reconcile().counts["changes"] == 0


def test_login_budget_leaves_the_rest_to_a_background_sync(
    api, world, scheduled, monkeypatch, django_capture_on_commit_callbacks
):
    ensure_account_for_login(world.lead)
    api.seconds_per_request = 1.0
    monkeypatch.setattr(forgejo_access, "_monotonic", lambda: api.clock)

    first = len(api.requests)

    with django_capture_on_commit_callbacks(execute=True):
        assert apply_user_access(world.lead, budget_seconds=3) is False

    # Every request was bounded by what was left of the budget, and none started once it was spent.
    assert [item["timeout"] for item in api.requests[first:]] == [(3, 3), (2, 2), (1, 1)]
    assert scheduled and scheduled[-1]["countdown"] == 5
    assert str(world.lead.id) in forgejo_access.pending_scope()["user_ids"]

    api.seconds_per_request = 0.0
    run_access_sync({})

    assert api.members(api.team("team-alpha", "APP-admin")) == ["lead"]
    assert forgejo_access.pending_scope()["user_ids"] == []


def test_one_failing_team_does_not_stop_the_others(api, world):
    for user in (world.lead, world.dev, world.guest):
        ensure_account_for_login(user)
    api.inject("POST", r"^/orgs/team-alpha/teams$", FakeResponse(500, {"message": "internal"}))

    run = run_access_sync(project_scope(world.project))

    assert run.status == "partial"
    assert [problem["kind"] for problem in run.problems] == ["team"]
    assert api.team("team-alpha", "APP-admin") is None
    assert api.members(api.team("team-alpha", "APP")) == ["dev"]
    assert api.members(api.team("team-alpha", "APP-read")) == ["guest"]


@pytest.mark.parametrize(
    ("failure", "countdown", "message"),
    [
        (requests.ConnectionError("down"), 30, "Git-сервер недоступен. PPM повторит синхронизацию позже."),
        (
            FakeResponse(503, {"message": "maintenance"}),
            60,
            "Git-сервер просит подождать. PPM повторит синхронизацию позже.",
        ),
        (
            FakeResponse(429, {"message": "slow"}, {"Retry-After": "120"}),
            120,
            "Git-сервер просит подождать. PPM повторит синхронизацию позже.",
        ),
    ],
)
def test_outage_stops_the_run_and_retries_later(api, world, scheduled, failure, countdown, message):
    login_all(world)
    api.inject("GET", r"^/teams/\d+$", failure)

    run = run_access_sync(project_scope(world.project))

    assert run.status == "error"
    assert run.problems[-1]["message"] == message
    assert scheduled[-1]["countdown"] == countdown
    pending = forgejo_access.pending_scope()
    assert str(world.project.id) in pending["project_ids"] and pending["attempts"] == 1


def test_full_reconcile_outage_is_recorded_without_raising(api, world):
    login_all(world)
    api.inject("GET", r"^/admin/users$", requests.ConnectionError("down"))

    run = run_full_reconcile()

    assert run.kind == "full" and run.status == "error"
    assert run.problems[-1]["message"] == "Git-сервер недоступен. PPM повторит синхронизацию позже."


def test_one_reconcile_at_a_time(api, world):
    login_all(world)
    requests_before = len(api.requests)
    token = forgejo_access._acquire_lock(60, wait_seconds=0)

    try:
        assert run_full_reconcile() is None
    finally:
        forgejo_access._release_lock(token)

    assert len(api.requests) == requests_before
    assert run_full_reconcile() is not None


def test_account_deleted_on_the_git_server_is_a_warning(api, world):
    login_all(world)
    account = PpmForgejoAccount.objects.get(user_id=world.guest.id)
    del api.accounts[account.forgejo_user_id]
    for team in api.teams.values():
        team["members"].discard(account.forgejo_user_id)

    run = run_full_reconcile()

    assert run.status == "ok"
    problem = next(problem for problem in run.problems if problem["kind"] == "account")
    assert problem["level"] == "warning" and problem["subject"] == account.username
    assert api.members(api.team("team-alpha", "APP-read")) == []


def test_non_ascii_project_key_gets_a_forgejo_team_name(api, world):
    Project.objects.filter(id=world.project.id).update(identifier="ПРО")

    assert login(world.lead) is True

    marker = world.project.id.hex[:6]
    assert api.team("team-alpha", f"P-{marker}-admin") is not None


def test_long_project_name_keeps_the_description_within_255_bytes(api, world):
    Project.objects.filter(id=world.project.id).update(name="Очень длинное название проекта " * 6)
    login_all(world)

    run_full_reconcile()
    run = run_full_reconcile()

    admin, write, read = teams(api)
    for team in (admin, write, read):
        assert len(team["description"].encode("utf-8")) <= 255
        assert "�" not in team["description"]
        assert team["description"].endswith("». Состав ведёт PPM — не меняйте вручную")
    assert run.counts["changes"] == 0


def test_audit_rows_have_no_secrets(api, world):
    login_all(world)
    connect(api, world.project, api.add_repository("team-alpha", "app"))
    run_full_reconcile()

    text = str(list(PpmGitAudit.objects.values("metadata", "action", "target_type")))
    assert SSO_SETTINGS["PPM_FORGEJO_ADMIN_TOKEN"] not in text
    assert SSO_SETTINGS["PPM_FORGEJO_TOKEN"] not in text
    assert set(PpmGitAudit.objects.values_list("actor_id", flat=True)) == {None}
    assert {action.split(".")[0] + "." + action.split(".")[1] for action in actions()} == {"forgejo.access"}


def test_a_failure_of_ppm_itself_never_breaks_the_sign_in(api, world, monkeypatch, django_capture_on_commit_callbacks):
    ensure_account_for_login(world.lead)

    def broken(self, scope):
        raise RuntimeError("bug")

    monkeypatch.setattr(forgejo_access._Run, "apply_scope", broken)
    with django_capture_on_commit_callbacks(execute=True):
        assert apply_user_access(world.lead) is False

    run = forgejo_access.PpmForgejoSyncRun.objects.order_by("-started_at").first()
    assert run.status == "error"
    assert run.problems[-1]["message"] == "Синхронизация прервана внутренней ошибкой PPM — подробности в журнале API."
    assert str(world.lead.id) in forgejo_access.pending_scope()["user_ids"]


def test_a_failure_of_ppm_itself_refuses_the_account_with_a_safe_code(api, world, monkeypatch):
    def broken(self, user):
        raise RuntimeError("bug")

    monkeypatch.setattr(forgejo_access._Run, "ensure_account", broken)

    with pytest.raises(forgejo_access.ForgejoAccessError) as caught:
        ensure_account_for_login(world.lead)

    assert caught.value.code == "FORGEJO_ACCESS_FAILED"
    assert "RuntimeError" not in caught.value.message and "bug" not in caught.value.message


def test_a_zero_budget_applies_nothing_while_the_person_waits(api, world, django_capture_on_commit_callbacks):
    ensure_account_for_login(world.lead)
    before = len(api.requests)

    with django_capture_on_commit_callbacks(execute=True):
        assert apply_user_access(world.lead, budget_seconds=0) is False

    assert len(api.requests) == before
    assert str(world.lead.id) in forgejo_access.pending_scope()["user_ids"]


def test_waiting_for_the_lock_is_part_of_the_budget(api, world, django_capture_on_commit_callbacks):
    ensure_account_for_login(world.lead)
    token = forgejo_access._acquire_lock(60, wait_seconds=0)
    before = len(api.requests)
    started = time.monotonic()
    try:
        with django_capture_on_commit_callbacks(execute=True):
            assert apply_user_access(world.lead, budget_seconds=0.3) is False
    finally:
        forgejo_access._release_lock(token)

    assert time.monotonic() - started < 1.0
    assert len(api.requests) == before
    assert str(world.lead.id) in forgejo_access.pending_scope()["user_ids"]


def test_a_request_cut_by_the_end_of_the_budget_is_not_an_outage(
    api, world, monkeypatch, django_capture_on_commit_callbacks
):
    ensure_account_for_login(world.lead)
    monkeypatch.setattr(forgejo_access, "_monotonic", lambda: api.clock)
    api.seconds_per_request = 10.0  # the request waits until its (budget-bounded) timeout runs out
    api.inject("GET", r"^/admin/users$", requests.ReadTimeout("timed out"))

    with django_capture_on_commit_callbacks(execute=True):
        assert apply_user_access(world.lead, budget_seconds=5) is False

    assert not forgejo_access.PpmForgejoSyncRun.objects.filter(status="error").exists()
    assert str(world.lead.id) in forgejo_access.pending_scope()["user_ids"]


def test_problems_name_projects_and_people_not_uuids(api, world):
    for user in (world.lead, world.dev, world.guest):
        ensure_account_for_login(user)
    api.inject("POST", r"^/orgs$", FakeResponse(500, {"message": "internal"}))

    run = run_access_sync(project_scope(world.project))

    assert (run.problems[0]["kind"], run.problems[0]["subject"]) == ("project", "APP «Приложение»")
    account = PpmForgejoAccount.objects.get(user_id=world.dev.id)
    del api.accounts[account.forgejo_user_id]

    run = run_access_sync({"user_ids": [str(world.dev.id)]})

    assert [problem["subject"] for problem in run.problems] == ["dev"]
    for problem in forgejo_access.PpmForgejoSyncRun.objects.values_list("problems", flat=True):
        for item in problem:
            assert str(world.project.id) not in item["subject"] and str(world.dev.id) not in item["subject"]


def test_a_crash_puts_the_scope_back_in_the_queue(api, world, scheduled, monkeypatch):
    def broken(self, scope):
        raise RuntimeError("bug")

    monkeypatch.setattr(forgejo_access._Run, "apply_scope", broken)

    run = run_access_sync(project_scope(world.project))

    assert run.status == "error"
    pending = forgejo_access.pending_scope()
    assert pending["project_ids"] == [str(world.project.id)] and pending["attempts"] == 1
    assert scheduled[-1]["countdown"] == 30


def test_another_account_bound_to_the_person_by_hand_is_left_alone(api, world):
    login_all(world)
    PpmGlobalAdmin.objects.create(user=world.dev, reason="test")
    run_full_reconcile()  # PPM makes the person's account an administrator
    record = PpmForgejoAccount.objects.get(user_id=world.dev.id)
    assert record.admin_granted is True
    api.user("dev").update(source_id=0, login_name="")  # unbound by hand…
    other = api.add_user(  # …and another administrator bound to the person instead
        "dev-new", email="dev-new@example.test", is_admin=True, source_id=SOURCE_ID, login_name=str(world.dev.id)
    )
    team = api.team("team-alpha", "APP")
    team["members"].add(other["id"])
    PpmGlobalAdmin.objects.filter(user=world.dev).update(revoked_at=timezone.now())
    before = dict(other)

    run = run_full_reconcile()

    assert api.calls("PATCH", r"^/admin/users/dev-new$") == []
    assert dict(other) == before and other["is_admin"] is True
    assert other["id"] in team["members"]
    assert [problem["message"] for problem in run.problems if "сменилась вручную" in problem["message"]] == [
        "Учётка на Git-сервере для dev@example.test сменилась вручную (была dev, теперь dev-new) — проверьте привязку"
    ]
    assert PpmForgejoAccount.objects.get(user_id=world.dev.id).forgejo_user_id == record.forgejo_user_id


def test_a_grant_made_meanwhile_is_not_overwritten_by_the_run_snapshot(api, world, monkeypatch):
    login_all(world)
    api.user("dev")["is_admin"] = True  # granted by PPM in a sign-in running at the same time
    original = forgejo_access._Run.records
    granted = []

    def records_then_a_sign_in_grants(self):
        rows = original(self)
        if not granted:  # once, right after the run took its snapshot of the rows
            granted.append(True)
            PpmForgejoAccount.objects.filter(user_id=world.dev.id).update(admin_granted=True)
        return rows

    monkeypatch.setattr(forgejo_access._Run, "records", records_then_a_sign_in_grants)

    run_full_reconcile()

    assert PpmForgejoAccount.objects.get(user_id=world.dev.id).admin_granted is True


def test_accounts_ppm_does_not_keep_in_its_teams_are_reported_once_per_run(api, world):
    login_all(world)
    stranger = api.add_user("stranger", email="stranger@example.test")  # a local account added to the team by hand
    team = api.team("team-alpha", "APP")
    team["members"].add(stranger["id"])

    # The person and the project in one run: the team is looked at through both, the warning comes once.
    run = run_access_sync({"user_ids": [str(world.dev.id)], "project_ids": [str(world.project.id)]})

    assert stranger["id"] in team["members"]
    reported = [problem for problem in run.problems if problem["kind"] == "team"]
    assert reported == [
        {
            "at": reported[0]["at"],
            "kind": "team",
            "subject": "APP / stranger",
            "message": "В команде APP есть учётка stranger, которую ведёт не PPM — уберите её в Forgejo, если доступ "
            "не нужен",
            "level": "warning",
        }
    ]
    assert run.status == "ok"

    again = run_full_reconcile()

    assert [problem["subject"] for problem in again.problems if problem["kind"] == "team"] == ["APP / stranger"]
    assert again.counts["changes"] == 0 and stranger["id"] in team["members"]
