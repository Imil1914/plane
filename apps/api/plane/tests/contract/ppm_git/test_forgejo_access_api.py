"""G2.2 R17–R19 — руководитель проекта подключает репозитории Git-сервера, центр администратора видит доступы.

R17: глобальный администратор PPM подключает любой репозиторий Git-сервера, как в G2.1; при едином входе администратор
проекта (20) видит и подключает только репозитории организации своего пространства, где у его учётки права
администратора (создал сам — Forgejo делает создателя collaborator-администратором, — или через команду
`<КЛЮЧ>-admin`). Список — admin sudo `GET /user/repos` (не больше 20 страниц, минуту в кэше на человека); `POST`
перепроверяет право на самом сервере — репозиторий по id и право человека на него, — не доверяя ни клиенту, ни кэшу.
Нет учётки на Git-сервере — 409 `FORGEJO_ACCOUNT_REQUIRED`; чужой или недоступный репозиторий — 403/404 без названий.
Отключает тот, кто может подключать. Обзор «Код» отдаёт `sso_enabled`, `username`, `sso_login_url` и
`connect_git_server_repositories` без запросов к Forgejo.

R18–R19: статус доступов и «Синхронизировать сейчас» — только глобальному администратору (иначе 403
`GIT_PERMISSION_DENIED`) и только при включённом центре администратора (иначе 404), форма из плана (все пять чисел —
всегда), без секретов; запуск сверки — не чаще раза в 30 с (429 `GIT_SYNC_RATE_LIMITED` с
`details.retry_after_seconds` и заголовком `Retry-After`).
"""

import json
import re
import uuid
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import unquote

import pytest
import requests
from django.core.cache import cache
from django.db import connection as database
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminAudit
from plane.ppm_git import forgejo_access, forgejo_access_status, provider_services
from plane.ppm_git.forgejo_access import apply_user_access, ensure_account_for_login
from plane.ppm_git.forgejo_admin import ForgejoAdminClient
from plane.ppm_git.models import (
    PpmForgejoAccount,
    PpmForgejoOrganization,
    PpmForgejoSyncRun,
    PpmGitAudit,
    PpmGitConnection,
    PpmGitRepository,
)
from plane.tests.contract.ppm_git.forgejo_admin_fake import (
    ACCESS_ORDER,
    ADMIN_TOKEN,
    SSO_SETTINGS,
    FakeForgejoAdminApi,
)
from plane.tests.contract.ppm_git.forgejo_fake import (
    INTERNAL_URL,
    PUBLIC_URL,
    TOKEN,
    WEBHOOK_SECRET,
    FakeRepository,
    FakeResponse,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

REPOSITORIES = "providers/forgejo/repositories/"
STATUS_URL = "/api/ppm/v1/git/forgejo/access/status/"
SYNC_URL = "/api/ppm/v1/git/forgejo/access/sync/"
ACCOUNT_REQUIRED_TEXT = "Сначала войдите на Git-сервер кнопкой «Войти через PPM» — здесь появятся ваши репозитории."
# The item of the connect dialog — exactly the G2.1 shape (`test_forgejo_connect.CONTRACT_KEYS`).
CONTRACT_KEYS = {
    "provider_repository_id",
    "full_name",
    "name",
    "owner",
    "description",
    "private",
    "archived",
    "default_branch",
    "html_url",
    "clone_https",
    "clone_ssh",
    "updated_at",
    "connected",
}
# The numbers of the admin centre (plan «G2.2»): always in `counts`, null when the run does not know them.
COUNT_KEYS = ("accounts", "organizations", "teams", "repositories", "changes")
# Names the lead must never learn from a refused connect (repositories and owners they do not administer).
FOREIGN_NAMES = ("sandbox", "dev1", "docs", "secret", "other-team", "tools", "hidden")
SECRETS = (ADMIN_TOKEN, TOKEN, WEBHOOK_SECRET)
LEAD_LISTING = ("GET", "/user/repos", "lead")


class GitServerAdminApi(FakeForgejoAdminApi):
    """The admin API fake of line S2a plus what R17 reads: direct collaborators — Forgejo 15 makes the creator of an
    organization repository its collaborator with admin rights (`modules/repository/create.go#L139-L149`) — the fields
    of the connect dialog (description, archive flag), and `…/collaborators/{name}/permission` as live
    (`GetRepoPermissions`: an unknown person is 404, the mode is reported as it is — `owner` included). Ids are chosen
    by the test, so that the read-only provider fake of G2.1 (`forgejo` fixture) knows the same repository."""

    def add_repository(self, owner, name, *, repository_id, private=True, collaborators=None, **fields):
        repository = {
            "id": repository_id,
            "owner_id": self.find(owner)["id"],
            "name": name,
            "private": private,
            "collaborators": {self.find(login)["id"]: mode for login, mode in (collaborators or {}).items()},
            "description": fields.get("description", ""),
            "archived": fields.get("archived", False),
        }
        self.repositories[repository_id] = repository
        return repository

    def _access(self, person, repository):
        mode = super()._access(person, repository)
        direct = repository.get("collaborators", {}).get(person["id"], "none") if person else "none"
        return direct if ACCESS_ORDER[direct] > ACCESS_ORDER[mode] else mode

    def _repository_json(self, repository, viewer):
        payload = super()._repository_json(repository, viewer)
        payload.update(description=repository.get("description", ""), archived=repository.get("archived", False))
        return payload

    def _dispatch(self, method, path, params, body, doer):
        match = re.fullmatch(r"/repos/([^/]+)/([^/]+)/collaborators/([^/]+)/permission", path)
        if match and method == "GET":
            person = self.user(unquote(match.group(3)))
            if person is None:
                return FakeResponse(404, {"message": "GetUserByName", "errors": []})
            mode = self._access(person, self.repository(f"{match.group(1)}/{match.group(2)}"))
            return FakeResponse(200, {"permission": mode, "role_name": mode, "user": self._user_json(person)})
        return super()._dispatch(method, path, params, body, doer)


@pytest.fixture(autouse=True)
def scheduled(monkeypatch):
    """Nothing leaves the process: the delayed access synchronization (R16) and the G2.1 connection reconciliation
    are recorded instead of queued; the cache (locks, the dialog's listings, the sync window) starts empty."""
    calls = []
    monkeypatch.setattr(
        "plane.ppm_git.tasks.sync_forgejo_access_task.apply_async", lambda *args, **kwargs: calls.append(kwargs)
    )
    monkeypatch.setattr("plane.ppm_git.views.reconcile_git_connection_task.delay", lambda *args, **kwargs: None)
    cache.clear()
    yield calls
    cache.clear()


@pytest.fixture
def git_server(settings, monkeypatch, forgejo):
    """PPM's Git server with single sign-on: the admin API (access engine, admin sudo) and the read-only API of G2.1
    (connect flow) are two in-memory Forgejo 15 fakes."""
    admin = GitServerAdminApi()
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)

    def client():
        return ForgejoAdminClient(session=admin, page_size=admin.page_size)

    monkeypatch.setattr(forgejo_access, "ForgejoAdminClient", client)
    monkeypatch.setattr(provider_services, "ForgejoAdminClient", client)
    return SimpleNamespace(admin=admin, provider=forgejo)


def person(email, **extra):
    return UserFactory(email=email, username=uuid.uuid4().hex, display_name=email.split("@")[0].title(), **extra)


@pytest.fixture
def world(git_server):
    """Workspace «team-alpha» (its organization on the Git server has the same name) with project APP: its lead
    (project administrator, signed in on the Git server — account, organization and teams exist), a member and a guest
    (never signed in); a PPM global administrator outside the project; the administrator of another project of the
    workspace («чужой проект»). Repositories of the Git server, seen by the lead:

    - 1 `team-alpha/app` — the lead created it (admin collaborator); 4 `team-alpha/legacy` — through the team
      `APP-admin`: both listed (legacy is archived: listed as such, G2.1 refuses to connect it);
    - 7 `team-alpha/docs` — write access only; 3 `dev1/sandbox` — admin of a personal repository; 9 `other-team/tools` —
      admin in another organization: visible to the lead, refused (403);
    - 6 `other-team/secret`, 8 `team-alpha/hidden` — no access at all: 404, like a missing one.
    """
    owner = person("owner@example.test")
    workspace = WorkspaceFactory(slug="team-alpha", name="Команда Альфа", owner=owner)
    project = ProjectFactory(workspace=workspace, identifier="APP", name="Приложение")
    other = ProjectFactory(workspace=workspace, identifier="OUT", name="Другой проект")
    people = {}
    for key, role in (("lead", 20), ("member", 15), ("guest", 5)):
        user = person(f"{key}@example.test")
        WorkspaceMemberFactory(workspace=workspace, member=user, role=15 if role == 20 else role)
        ProjectMemberFactory(project=project, member=user, role=role)
        people[key] = user
    stranger = person("stranger@example.test")
    WorkspaceMemberFactory(workspace=workspace, member=stranger, role=20)
    ProjectMemberFactory(project=other, member=stranger, role=20)
    admin = person("root@example.test")
    PpmGlobalAdmin.objects.create(user=admin, reason="G2.2 S2b contract test")

    ensure_account_for_login(people["lead"])
    assert apply_user_access(people["lead"]) is True

    api = git_server.admin
    api.add_user("dev1", email="dev1@example.test")
    api.add_org("other-team")
    api.add_repository(
        "team-alpha", "app", repository_id=1, collaborators={"lead": "admin"}, description="Приложение команды"
    )
    api.add_repository("team-alpha", "legacy", repository_id=4, archived=True)
    api.team("team-alpha", "APP-admin")["repositories"].add(4)
    api.add_repository("team-alpha", "docs", repository_id=7, collaborators={"lead": "write"})
    api.add_repository("dev1", "sandbox", repository_id=3, collaborators={"lead": "admin"})
    api.add_repository("other-team", "tools", repository_id=9, collaborators={"lead": "admin"})
    api.add_repository("other-team", "secret", repository_id=6)
    api.add_repository("team-alpha", "hidden", repository_id=8)
    api.requests.clear()
    git_server.provider.requests.clear()
    return SimpleNamespace(
        workspace=workspace,
        project=project,
        other=other,
        admin=admin,
        stranger=stranger,
        api=api,
        forgejo=git_server.provider,
        **people,
    )


def git_url(world, suffix=""):
    return f"/api/ppm/v1/workspaces/{world.workspace.id}/projects/{world.project.id}/git/{suffix}"


def as_user(api_client, user):
    api_client.force_authenticate(user=user)
    return api_client


def connect(api_client, world, provider_repository_id):
    return api_client.post(
        git_url(world, REPOSITORIES), {"provider_repository_id": provider_repository_id}, format="json"
    )


def admin_requests(world):
    return [(item["method"], item["path"], item["sudo"]) for item in world.api.requests]


def checked_on_server(repository_id, full_name):
    """The requests of the connect check: the repository by id, then the lead's permission on it (no sudo)."""
    return [
        ("GET", f"/repositories/{repository_id}", None),
        ("GET", f"/repos/{full_name}/collaborators/lead/permission", None),
    ]


def error_code(response):
    return response.status_code, response.data["error"]["code"]


def names(response):
    return [item["full_name"] for item in response.data["results"]]


# --- R17: who may connect -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("who", "single_sign_on", "allowed"),
    [
        ("admin", True, True),
        ("lead", True, True),
        ("member", True, False),
        ("guest", True, False),
        ("admin", False, True),
        ("lead", False, False),
    ],
)
def test_who_may_connect_follows_role_and_single_sign_on(api_client, world, settings, who, single_sign_on, allowed):
    settings.PPM_GIT_SSO_ENABLED = single_sign_on
    as_user(api_client, getattr(world, who))

    overview = api_client.get(git_url(world))
    listing = api_client.get(git_url(world, REPOSITORIES))

    assert overview.status_code == status.HTTP_200_OK
    assert overview.data["capabilities"]["connect_git_server_repositories"] is allowed
    # G2.1 `manage_git_server` does not change: the PPM global administrator only.
    assert overview.data["capabilities"]["manage_git_server"] is (who == "admin")
    if allowed:
        assert listing.status_code == status.HTTP_200_OK
    else:
        assert error_code(listing) == (403, "GIT_PERMISSION_DENIED")


def test_the_administrator_of_another_project_gets_nothing(api_client, world):
    as_user(api_client, world.lead)
    connect(api_client, world, 1)
    connection = PpmGitConnection.objects.get(project_id=world.project.id)
    world.api.requests.clear()
    as_user(api_client, world.stranger)

    responses = [
        api_client.get(git_url(world)),
        api_client.get(git_url(world, REPOSITORIES)),
        connect(api_client, world, 1),
        api_client.delete(git_url(world, f"connections/{connection.id}/")),
    ]

    for response in responses:
        assert error_code(response) == (403, "GIT_PERMISSION_DENIED")
    connection.refresh_from_db()
    assert connection.status == "active"
    assert world.api.requests == []


# --- R17: the project administrator's list ------------------------------------------------------------------------


def test_project_admin_lists_only_repositories_they_administer_in_the_workspace_organization(api_client, world):
    as_user(api_client, world.lead)

    listing = api_client.get(git_url(world, REPOSITORIES))

    assert listing.status_code == status.HTTP_200_OK
    results = listing.data["results"]
    # Not docs (write only), not sandbox (personal) nor tools (another organization), not what the lead cannot see.
    assert names(listing) == ["team-alpha/app", "team-alpha/legacy"]
    assert (listing.data["page"], listing.data["has_next"]) == (1, False)
    assert all(set(item) == CONTRACT_KEYS for item in results)
    assert results[0] == {
        "provider_repository_id": 1,
        "full_name": "team-alpha/app",
        "name": "app",
        "owner": "team-alpha",
        "description": "Приложение команды",
        "private": True,
        "archived": False,
        "default_branch": "main",
        "html_url": f"{PUBLIC_URL}/team-alpha/app",
        "clone_https": f"{PUBLIC_URL}/team-alpha/app.git",
        "clone_ssh": "",
        "updated_at": None,
        "connected": False,
    }
    assert (results[1]["provider_repository_id"], results[1]["archived"]) == (4, True)
    # Asked as the person (admin sudo) — one listing of their repositories; the read-only token is not used.
    assert admin_requests(world) == [LEAD_LISTING]
    assert world.forgejo.requests == []


def test_project_admin_list_searches_pages_and_marks_connected_from_one_listing(api_client, world, monkeypatch):
    as_user(api_client, world.lead)
    assert connect(api_client, world, 1).status_code == status.HTTP_201_CREATED
    monkeypatch.setattr(provider_services, "FORGEJO_LISTING_PAGE_SIZE", 1)

    first = api_client.get(git_url(world, REPOSITORIES), {"page": 1})
    second = api_client.get(git_url(world, REPOSITORIES), {"page": "2"})
    searched = api_client.get(git_url(world, REPOSITORIES), {"search": " LEG "})
    broken = api_client.get(git_url(world, REPOSITORIES), {"page": "zero"})

    assert [(item["name"], item["connected"]) for item in first.data["results"]] == [("app", True)]
    assert (first.data["page"], first.data["has_next"]) == (1, True)
    assert [(item["name"], item["connected"]) for item in second.data["results"]] == [("legacy", False)]
    assert (second.data["page"], second.data["has_next"]) == (2, False)
    assert [item["name"] for item in searched.data["results"]] == ["legacy"]
    assert error_code(broken) == (400, "GIT_INVALID_FIELD")
    # Paging and searching the dialog read the person's listing once (kept a minute), not the Git server each time.
    assert admin_requests(world).count(LEAD_LISTING) == 1


def test_project_admin_list_reads_at_most_twenty_pages_and_is_kept_a_minute(api_client, world, monkeypatch):
    assert (provider_services.FORGEJO_LISTING_MAX_PAGES, provider_services.FORGEJO_LISTING_CACHE_SECONDS) == (20, 60)
    # The lead reaches five repositories; two per page — three pages.
    world.api.page_size = 2
    monkeypatch.setattr(provider_services, "FORGEJO_LISTING_MAX_PAGES", 2)
    as_user(api_client, world.lead)

    too_many = api_client.get(git_url(world, REPOSITORIES))
    stopped = admin_requests(world)
    world.api.requests.clear()
    monkeypatch.setattr(provider_services, "FORGEJO_LISTING_MAX_PAGES", 3)
    listing = api_client.get(git_url(world, REPOSITORIES))
    read = admin_requests(world)
    again = api_client.get(git_url(world, REPOSITORIES), {"search": "app"})

    assert error_code(too_many) == (400, "FORGEJO_TOO_MANY_REPOSITORIES")
    assert stopped == [LEAD_LISTING] * 2  # no request past the limit
    assert names(listing) == ["team-alpha/app", "team-alpha/legacy"]
    assert read == [LEAD_LISTING] * 3
    assert names(again) == ["team-alpha/app"]
    assert admin_requests(world) == read  # the second look came from the kept listing
    kept = cache.keys(f"{provider_services.FORGEJO_LISTING_CACHE_PREFIX}*")
    assert len(kept) == 1 and 0 < cache.ttl(kept[0]) <= 60


def test_project_admin_without_an_account_on_the_git_server_is_asked_to_sign_in(api_client, world):
    newcomer = person("newcomer@example.test")
    WorkspaceMemberFactory(workspace=world.workspace, member=newcomer, role=15)
    ProjectMemberFactory(project=world.project, member=newcomer, role=20)
    as_user(api_client, newcomer)

    listing = api_client.get(git_url(world, REPOSITORIES))
    connected = connect(api_client, world, 1)

    for response in (listing, connected):
        assert error_code(response) == (409, "FORGEJO_ACCOUNT_REQUIRED")
        assert response.data["error"]["message"] == ACCOUNT_REQUIRED_TEXT
    assert world.api.requests == [] and world.forgejo.requests == []
    assert not PpmGitConnection.objects.filter(project_id=world.project.id).exists()


def test_before_the_workspace_organization_exists_nothing_is_offered(api_client, world):
    PpmForgejoOrganization.objects.filter(workspace_id=world.workspace.id).delete()
    as_user(api_client, world.lead)

    listing = api_client.get(git_url(world, REPOSITORIES))
    connected = connect(api_client, world, 1)

    assert listing.status_code == status.HTTP_200_OK
    assert (listing.data["results"], listing.data["has_next"]) == ([], False)
    # Nothing to ask the Git server for the list; a connect is still checked there (and refused: no organization yet).
    assert error_code(connected) == (403, "GIT_PERMISSION_DENIED")
    assert admin_requests(world) == checked_on_server(1, "team-alpha/app")
    assert not PpmGitConnection.objects.filter(project_id=world.project.id).exists()


def test_an_account_deleted_on_the_git_server_asks_to_sign_in_again(api_client, world):
    del world.api.accounts[world.api.user("lead")["id"]]
    as_user(api_client, world.lead)

    listing = api_client.get(git_url(world, REPOSITORIES))
    connected = connect(api_client, world, 1)

    assert error_code(listing) == (409, "FORGEJO_ACCOUNT_REQUIRED")
    assert error_code(connected) == (409, "FORGEJO_ACCOUNT_REQUIRED")
    assert admin_requests(world) == [LEAD_LISTING, *checked_on_server(1, "team-alpha/app")]
    assert not PpmGitConnection.objects.filter(project_id=world.project.id).exists()


def test_project_admin_list_reports_a_git_server_that_waits_or_is_down(api_client, world):
    as_user(api_client, world.lead)
    world.api.inject("GET", r"^/user/repos$", FakeResponse(429, {"message": "slow"}, {"Retry-After": "30"}))
    waiting = api_client.get(git_url(world, REPOSITORIES))
    world.api.inject("GET", r"^/user/repos$", requests.ConnectionError(f"{INTERNAL_URL} token {ADMIN_TOKEN}"))
    down = api_client.get(git_url(world, REPOSITORIES))

    assert error_code(waiting) == (429, "GIT_PROVIDER_RATE_LIMITED")
    assert waiting.data["error"]["details"] == {"retry_after_seconds": 30}
    assert error_code(down) == (502, "GIT_PROVIDER_UNAVAILABLE")
    assert ADMIN_TOKEN not in down.content.decode()
    # A failed listing is not kept: the next look asks the Git server again.
    assert admin_requests(world) == [LEAD_LISTING] * 2


# --- R17: connecting, checked on the server -----------------------------------------------------------------------


def test_project_admin_connects_a_repository_checked_on_the_git_server(
    api_client, world, django_capture_on_commit_callbacks
):
    as_user(api_client, world.lead)

    with django_capture_on_commit_callbacks(execute=True):
        response = connect(api_client, world, 1)

    assert response.status_code == status.HTTP_201_CREATED
    assert set(response.data) == {"repository", "connection"}
    connection = PpmGitConnection.objects.get(project_id=world.project.id)
    assert (connection.status, connection.provider_repository_id, connection.provider_full_name) == (
        "active",
        1,
        "team-alpha/app",
    )
    assert response.data["connection"]["id"] == str(connection.id)
    audit = PpmGitAudit.objects.get(action="forgejo.repository.connect")
    assert (audit.actor_id, audit.target_id) == (world.lead.id, connection.id)
    # The right is checked on the server — the repository by id and the lead's permission on it — and only then the
    # read-only connect flow of G2.1 runs; the dialog's listing is not read.
    assert admin_requests(world) == checked_on_server(1, "team-alpha/app")
    assert {path for path, _ in world.forgejo.requests} == {"/repositories/1", "/user"}
    # The project's access synchronization is scheduled: the repository goes into the project's teams.
    assert forgejo_access.pending_scope()["project_ids"] == [str(world.project.id)]
    forgejo_access.run_access_sync()
    assert "team-alpha/app" in world.api.team_repositories(world.api.team("team-alpha", "APP-admin"))


def test_project_admin_cannot_connect_a_foreign_or_unreachable_repository(api_client, world):
    as_user(api_client, world.lead)
    audits = PpmGitAudit.objects.count()

    outside = connect(api_client, world, 3)  # dev1/sandbox: administered, but personal — outside the organization
    write_only = connect(api_client, world, 7)  # team-alpha/docs: in the organization, write access only
    invisible = connect(api_client, world, 6)  # other-team/secret: not visible to the lead
    hidden = connect(api_client, world, 8)  # team-alpha/hidden: in the organization, no access at all
    missing = connect(api_client, world, 999)
    invalid = connect(api_client, world, "abc")

    assert error_code(outside) == (403, "GIT_PERMISSION_DENIED")
    assert error_code(write_only) == (403, "GIT_PERMISSION_DENIED")
    for response in (invisible, hidden, missing):
        assert error_code(response) == (404, "GIT_REPOSITORY_NOT_FOUND")
    assert error_code(invalid) == (400, "GIT_REPOSITORY_INVALID")
    for response in (outside, write_only, invisible, hidden, missing, invalid):
        text = response.content.decode()
        assert not any(name in text for name in FOREIGN_NAMES)
    # Every refusal came from the server-side check; the read-only connect flow never ran, nothing was recorded.
    assert admin_requests(world) == [
        *checked_on_server(3, "dev1/sandbox"),
        *checked_on_server(7, "team-alpha/docs"),
        *checked_on_server(6, "other-team/secret"),
        *checked_on_server(8, "team-alpha/hidden"),
        ("GET", "/repositories/999", None),
    ]
    assert world.forgejo.requests == []
    assert not PpmGitConnection.objects.filter(project_id=world.project.id).exists()
    assert not PpmGitRepository.objects.filter(project_id=world.project.id).exists()
    assert PpmGitAudit.objects.count() == audits


def test_a_repository_of_another_organization_is_refused_even_to_its_administrator(api_client, world):
    as_user(api_client, world.lead)

    listing = api_client.get(git_url(world, REPOSITORIES))
    refused = connect(api_client, world, 9)  # other-team/tools: the lead administers it

    assert "other-team/tools" not in names(listing)
    assert error_code(refused) == (403, "GIT_PERMISSION_DENIED")
    assert not any(name in refused.content.decode() for name in ("tools", "other-team"))
    assert admin_requests(world) == [LEAD_LISTING, *checked_on_server(9, "other-team/tools")]
    assert world.forgejo.requests == []
    assert not PpmGitConnection.objects.filter(project_id=world.project.id).exists()


def test_a_right_revoked_after_the_list_is_refused_on_connect(api_client, world):
    as_user(api_client, world.lead)
    listed = api_client.get(git_url(world, REPOSITORIES))
    collaborators = world.api.repositories[1]["collaborators"]
    lead_id = world.api.user("lead")["id"]

    collaborators[lead_id] = "write"  # admin taken away on the Git server after the dialog listed the repository
    downgraded = connect(api_client, world, 1)
    del collaborators[lead_id]  # and then any access at all
    removed = connect(api_client, world, 1)
    shown = api_client.get(git_url(world, REPOSITORIES))

    assert "team-alpha/app" in names(listed)
    assert error_code(downgraded) == (403, "GIT_PERMISSION_DENIED")
    assert error_code(removed) == (404, "GIT_REPOSITORY_NOT_FOUND")
    # The dialog's kept listing may still show it for up to a minute — a connect never relies on it.
    assert "team-alpha/app" in names(shown)
    assert not PpmGitConnection.objects.filter(project_id=world.project.id).exists()
    assert world.forgejo.requests == []


def test_an_owner_of_the_workspace_organization_may_connect_its_repository(api_client, world):
    organization = world.api.org("team-alpha")
    world.api.teams[organization["owners_team"]]["members"].add(world.api.user("lead")["id"])
    world.forgejo.add_repository(FakeRepository(id=8, owner="team-alpha", name="hidden"))
    # Forgejo reports an owner of the organization as `owner` (`perm.AccessModeOwner`) — as good as `admin` here.
    assert provider_services.ForgejoAdminClient().repository_permission("team-alpha/hidden", "lead") == "owner"
    world.api.requests.clear()
    as_user(api_client, world.lead)

    connected = connect(api_client, world, 8)  # team-alpha/hidden: reached as an owner of the organization

    assert connected.status_code == status.HTTP_201_CREATED
    assert connected.data["connection"]["provider_full_name"] == "team-alpha/hidden"
    assert admin_requests(world) == checked_on_server(8, "team-alpha/hidden")


def test_global_admin_connects_any_repository_as_in_g21_without_an_account(api_client, world):
    as_user(api_client, world.admin)

    listing = api_client.get(git_url(world, REPOSITORIES))
    connected = connect(api_client, world, 3)

    assert names(listing) == ["dev1/sandbox", "team-alpha/app", "team-alpha/legacy"]
    assert connected.status_code == status.HTTP_201_CREATED
    assert connected.data["connection"]["provider_repository_id"] == 3
    # No admin sudo and no Git server account for the global administrator: G2.1 as it was.
    assert world.api.requests == []
    assert not PpmForgejoAccount.objects.filter(user_id=world.admin.id).exists()


# --- R17: disconnecting — the same right --------------------------------------------------------------------------


def test_project_admin_disconnects_and_reconnects_with_single_sign_on(
    api_client, world, settings, django_capture_on_commit_callbacks
):
    as_user(api_client, world.lead)
    connect(api_client, world, 1)
    connection = PpmGitConnection.objects.get(project_id=world.project.id)
    forgejo_access.clear_access_cache()
    as_user(api_client, world.member)
    by_member = api_client.delete(git_url(world, f"connections/{connection.id}/"))
    as_user(api_client, world.lead)

    with django_capture_on_commit_callbacks(execute=True):
        removed = api_client.delete(git_url(world, f"connections/{connection.id}/"))
    connection.refresh_from_db()

    assert error_code(by_member) == (403, "GIT_PERMISSION_DENIED")
    assert removed.status_code == status.HTTP_204_NO_CONTENT
    assert connection.status == "disconnected"
    assert PpmGitAudit.objects.filter(
        action="forgejo.repository.disconnect", actor_id=world.lead.id, target_id=connection.id
    ).exists()
    assert forgejo_access.pending_scope()["project_ids"] == [str(world.project.id)]

    again = connect(api_client, world, 1)
    connection.refresh_from_db()
    assert again.status_code == status.HTTP_201_CREATED
    assert again.data["connection"]["id"] == str(connection.id)
    assert connection.status == "active"

    # Without single sign-on the project administrator is back to G2.1: only a PPM global administrator disconnects.
    settings.PPM_GIT_SSO_ENABLED = False
    refused = api_client.delete(git_url(world, f"connections/{connection.id}/"))
    connection.refresh_from_db()
    assert error_code(refused) == (403, "GIT_PERMISSION_DENIED")
    assert connection.status == "active"


def test_project_admin_removes_a_git_server_repository_from_the_project_with_single_sign_on(
    api_client, world, django_capture_on_commit_callbacks
):
    as_user(api_client, world.lead)
    connect(api_client, world, 1)
    connection = PpmGitConnection.objects.get(project_id=world.project.id)
    forgejo_access.clear_access_cache()

    with django_capture_on_commit_callbacks(execute=True):
        removed = api_client.delete(git_url(world, f"repositories/{connection.repository_id}/"))

    connection.refresh_from_db()
    assert removed.status_code == status.HTTP_204_NO_CONTENT
    assert connection.status == "disconnected"
    assert PpmGitRepository.objects.get(id=connection.repository_id).status == "archived"
    assert forgejo_access.pending_scope()["project_ids"] == [str(world.project.id)]


# --- the «Код» overview -------------------------------------------------------------------------------------------


def test_overview_reports_single_sign_on_and_the_git_server_name_without_asking_forgejo(api_client, world, settings):
    as_user(api_client, world.lead)
    lead_view = api_client.get(git_url(world))
    as_user(api_client, world.member)
    member_view = api_client.get(git_url(world))
    settings.PPM_GIT_SSO_ENABLED = False
    as_user(api_client, world.lead)
    with CaptureQueriesContext(database) as queries:
        off_view = api_client.get(git_url(world))

    assert lead_view.data["providers"]["forgejo"] == {
        "configured": True,
        "public_url": PUBLIC_URL,
        "sso_enabled": True,
        "username": "lead",
        "sso_login_url": f"{PUBLIC_URL}/user/oauth2/PPM",
    }
    assert member_view.data["providers"]["forgejo"] == {
        "configured": True,
        "public_url": PUBLIC_URL,
        "sso_enabled": True,
        "username": None,
        "sso_login_url": f"{PUBLIC_URL}/user/oauth2/PPM",
    }
    assert off_view.data["providers"]["forgejo"] == {
        "configured": True,
        "public_url": PUBLIC_URL,
        "sso_enabled": False,
        "username": None,
        "sso_login_url": None,
    }
    assert lead_view.data["capabilities"]["connect_git_server_repositories"] is True
    assert member_view.data["capabilities"]["connect_git_server_repositories"] is False
    assert off_view.data["capabilities"]["connect_git_server_repositories"] is False
    # The name comes from PPM's own record: the overview never asks the Git server; without single sign-on it does
    # not even read the access tables (the owner's dev API runs without migration 0009).
    assert world.api.requests == [] and world.forgejo.requests == []
    assert not any("ppm_forgejo_" in query["sql"] for query in queries.captured_queries)
    for response in (lead_view, member_view, off_view):
        text = json.dumps(response.data, default=str)
        assert not any(secret in text for secret in SECRETS)


# --- R18–R19: the admin centre --------------------------------------------------------------------------------------


@pytest.fixture
def answering(monkeypatch):
    """The Git server answers the status probe (the probe itself: `test_reachability_…`)."""
    monkeypatch.setattr(forgejo_access_status, "forgejo_server_answers", lambda: True)


def test_access_status_and_sync_are_for_global_administrators_only(api_client, world, scheduled):
    for who in ("lead", "member", "guest", "stranger"):
        as_user(api_client, getattr(world, who))
        answered = api_client.get(STATUS_URL)
        synced = api_client.post(SYNC_URL, format="json")
        assert error_code(answered) == (403, "GIT_PERMISSION_DENIED")
        assert error_code(synced) == (403, "GIT_PERMISSION_DENIED")
    api_client.force_authenticate(user=None)
    anonymous = [api_client.get(STATUS_URL), api_client.post(SYNC_URL, format="json")]

    assert [error_code(response) for response in anonymous] == [(401, "AUTHENTICATION_REQUIRED")] * 2
    assert scheduled == []
    assert forgejo_access.pending_scope()["full"] is False
    assert world.api.requests == []


def test_status_and_sync_are_gone_while_the_admin_centre_is_switched_off(
    api_client, world, settings, answering, scheduled
):
    settings.PPM_ADMIN_CENTER_ENABLED = False
    as_user(api_client, world.admin)
    answered = api_client.get(STATUS_URL)
    synced = api_client.post(SYNC_URL, format="json")
    api_client.force_authenticate(user=None)
    anonymous = api_client.get(STATUS_URL)

    # As the rest of the admin centre (`PpmAdminAPIView`): 404, before anything else.
    assert [response.status_code for response in (answered, synced, anonymous)] == [404, 404, 404]
    assert scheduled == []
    assert not PpmGlobalAdminAudit.objects.filter(action="git_server_sync_requested").exists()


def test_access_status_shows_the_last_full_reconciliation_without_secrets(api_client, world, answering):
    run = forgejo_access.run_full_reconcile()
    as_user(api_client, world.admin)

    response = api_client.get(STATUS_URL)

    assert response.status_code == status.HTTP_200_OK
    data = response.data
    assert set(data) == {"configured", "sso_enabled", "reachable", "last_full_sync", "problems", "forgejo_admin_url"}
    assert (data["configured"], data["sso_enabled"], data["reachable"]) == (True, True, True)
    # Forgejo 15 keeps its site administration at /admin (`routers/web/web.go`), not Gitea's /-/admin.
    assert data["forgejo_admin_url"] == f"{PUBLIC_URL}/admin"
    last = data["last_full_sync"]
    assert set(last) == {"started_at", "finished_at", "status", "counts"}
    assert (last["started_at"], last["finished_at"], last["status"]) == (
        run.started_at.isoformat(),
        run.finished_at.isoformat(),
        "ok",
    )
    counts = last["counts"]
    assert {key: counts[key] for key in COUNT_KEYS} == {
        "accounts": 1,
        "organizations": 1,
        "teams": 1,
        "repositories": 0,
        "changes": run.counts["changes"],
    }
    assert all(isinstance(value, int) and not isinstance(value, bool) for value in counts.values())
    assert data["problems"] == []
    text = json.dumps(data, default=str)
    assert not any(secret in text for secret in SECRETS)


def make_run(minutes_ago, problems=(), *, kind="scoped", status_="partial", counts=None):
    started = timezone.now() - timedelta(minutes=minutes_ago)
    return PpmForgejoSyncRun.objects.create(
        kind=kind,
        status=status_,
        started_at=started,
        finished_at=started + timedelta(seconds=2),
        counts={"changes": 0} if counts is None else counts,
        problems=[
            {
                "at": (started + timedelta(seconds=index)).isoformat(),
                "kind": kind_,
                "subject": subject,
                "message": message,
                "level": level,
            }
            for index, (kind_, subject, message, level) in enumerate(problems)
        ],
    )


def test_access_status_counts_are_always_the_five_of_the_plan(api_client, world, answering):
    make_run(
        20,
        kind="full",
        status_="ok",
        counts={"accounts": 3, "organizations": 1, "teams": 2, "repositories": 4, "changes": 0, "members_added": 0},
    )
    # The latest full reconciliation was stopped by an error: it recorded what it changed, but no totals.
    make_run(
        5,
        [("forgejo", "Git-сервер", "Git-сервер недоступен.", "error")],
        kind="full",
        status_="error",
        counts={"changes": 1, "members_added": 1},
    )
    as_user(api_client, world.admin)

    last = api_client.get(STATUS_URL).data["last_full_sync"]

    assert last["status"] == "error"
    assert {key: last["counts"][key] for key in COUNT_KEYS} == {
        "accounts": None,
        "organizations": None,
        "teams": None,
        "repositories": None,
        "changes": 1,
    }
    # The engine's own counters stay visible in the API.
    assert last["counts"]["members_added"] == 1


def test_access_status_lists_recent_distinct_problems_newest_first(api_client, world, answering):
    outside = (
        "repository",
        "dev1/sandbox",
        "Доступ к dev1/sandbox настраивается вручную: он вне организации пространства",
    )
    make_run(30, [("account", "new@example.test", "Почта new@example.test занята.", "error"), (*outside, "warning")])
    make_run(10, [(*outside, "warning")], kind="full")
    make_run(5, [("project", "APP «Приложение»", "Git-сервер не выполнил запрос.", "error")])
    make_run(1, [("account", "lead", "Учётка lead удалена на Git-сервере.", "warning")])
    as_user(api_client, world.admin)

    problems = api_client.get(STATUS_URL).data["problems"]

    # Newest first; a problem later runs met again is listed once, at its latest time.
    assert [(item["kind"], item["subject"], item["level"]) for item in problems] == [
        ("account", "lead", "warning"),
        ("project", "APP «Приложение»", "error"),
        ("repository", "dev1/sandbox", "warning"),
        ("account", "new@example.test", "error"),
    ]
    assert problems[2]["at"] > problems[3]["at"]
    assert all({"at", "kind", "subject", "message"} <= set(item) for item in problems)
    assert problems[2]["message"] == outside[2]


def test_access_status_keeps_at_most_fifty_problems(api_client, world, answering):
    make_run(20, [("team", f"OLD-{index}", "Команда удалена на Git-сервере.", "warning") for index in range(10)])
    make_run(1, [("team", f"T-{index:02d}", "Команда удалена на Git-сервере.", "warning") for index in range(60)])
    as_user(api_client, world.admin)

    problems = api_client.get(STATUS_URL).data["problems"]

    assert len(problems) == 50
    assert [item["subject"] for item in problems[:2]] == ["T-59", "T-58"]
    assert not any(item["subject"].startswith("OLD-") for item in problems)


def test_access_status_without_single_sign_on_reads_no_access_table(api_client, world, settings, answering, scheduled):
    make_run(3, [("account", "a@example.test", "Почта занята.", "error")], kind="full")
    settings.PPM_GIT_SSO_ENABLED = False
    as_user(api_client, world.admin)

    with CaptureQueriesContext(database) as queries:
        answered = api_client.get(STATUS_URL)
    synced = api_client.post(SYNC_URL, format="json")

    assert answered.data == {
        "configured": True,
        "sso_enabled": False,
        "reachable": True,
        "last_full_sync": None,
        "problems": [],
        "forgejo_admin_url": f"{PUBLIC_URL}/admin",
    }
    assert not any("ppm_forgejo_" in query["sql"] for query in queries.captured_queries)
    assert error_code(synced) == (400, "FORGEJO_SSO_NOT_CONFIGURED")
    assert scheduled == []


def test_access_status_of_an_unconfigured_git_server(api_client, world, settings, monkeypatch):
    settings.PPM_FORGEJO_TOKEN = ""
    settings.PPM_FORGEJO_PUBLIC_URL = ""
    monkeypatch.setattr(
        forgejo_access_status, "forgejo_server_answers", lambda: pytest.fail("no probe without a Git server")
    )
    as_user(api_client, world.admin)

    data = api_client.get(STATUS_URL).data

    assert (data["configured"], data["sso_enabled"], data["reachable"]) == (False, False, False)
    assert (data["last_full_sync"], data["problems"], data["forgejo_admin_url"]) == (None, [], None)


class Probe:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


@pytest.mark.parametrize(
    ("answer", "reachable"),
    [
        (FakeResponse(200, {"version": "15.0.9+gitea-1.22.0"}), True),
        # With REQUIRE_SIGNIN_VIEW (as in the bundle) Forgejo refuses an anonymous API call — but it answers.
        (FakeResponse(403, {"message": "Only signed in user is allowed to call APIs."}), True),
        (FakeResponse(401, {"message": "unauthorized"}), True),
        (FakeResponse(404, {"message": "not found"}), False),
        (FakeResponse(429, {"message": "slow down"}), False),
        (FakeResponse(502, {"message": "bad gateway"}), False),
        (requests.ConnectionError("refused"), False),
        (requests.Timeout("slow"), False),
    ],
)
def test_reachability_is_one_quick_request_without_any_token(git_server, answer, reachable):
    probe = Probe(answer)

    assert forgejo_access_status.forgejo_server_answers(session=probe) is reachable
    [(url, options)] = probe.calls
    assert url == f"{INTERNAL_URL}/api/v1/version"
    assert "Authorization" not in (options.get("headers") or {})
    assert max(options["timeout"]) <= 3
    assert options.get("allow_redirects") is False


def test_reachability_asks_nothing_without_a_git_server(git_server, settings):
    settings.PPM_FORGEJO_URL = ""
    probe = Probe(FakeResponse(200, {}))

    assert forgejo_access_status.forgejo_server_answers(session=probe) is False
    assert probe.calls == []


def test_sync_now_schedules_a_full_reconciliation_at_most_every_30_seconds(
    api_client, world, monkeypatch, scheduled, django_capture_on_commit_callbacks
):
    moment = [1_000_000.0]
    monkeypatch.setattr(forgejo_access_status, "_now", lambda: moment[0])
    as_user(api_client, world.admin)

    with django_capture_on_commit_callbacks(execute=True):
        first = api_client.post(SYNC_URL, format="json")
    moment[0] += 12.2
    second = api_client.post(SYNC_URL, format="json")
    moment[0] += 18
    third = api_client.post(SYNC_URL, format="json")

    assert first.status_code == status.HTTP_202_ACCEPTED
    assert first.data == {"scheduled": True}
    assert forgejo_access.pending_scope()["full"] is True
    assert len(scheduled) == 1 and scheduled[0]["countdown"] == forgejo_access.SYNC_DELAY_SECONDS
    assert error_code(second) == (429, "GIT_SYNC_RATE_LIMITED")
    assert second.data["error"]["details"] == {"retry_after_seconds": 18}
    assert second["Retry-After"] == "18"
    assert third.status_code == status.HTTP_202_ACCEPTED
    assert (
        PpmGlobalAdminAudit.objects.filter(action="git_server_sync_requested", global_admin__user=world.admin).count()
        == 2
    )
    # Asking for a synchronization reaches the Git server only through the scheduled task.
    assert world.api.requests == []
