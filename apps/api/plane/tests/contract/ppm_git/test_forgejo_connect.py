"""G2.1 R7/R9 — подключение репозиториев нашего Git-сервера (Forgejo) по HTTP-контракту раздела «Код».

Список, подключение и отключение репозиториев Forgejo — только глобальный администратор PPM (`manage_git_server`);
РП, участник и чужой проект получают 403, а в запросы к Forgejo, логи и аудит ничего не уходит. Обзор отдаёт
`providers` и `capabilities.manage_git_server`. Хосту Git-сервера доверяется ровно по `PPM_FORGEJO_PUBLIC_URL`.
"""

import json
import uuid
from unittest.mock import patch

import pytest
from django.core.cache import cache
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_git.models import (
    PpmGitAudit,
    PpmGitConnection,
    PpmGitDelivery,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitObject,
    PpmGitRepository,
)
from plane.ppm_git.provider_services import create_delivery, process_delivery, synchronize_connection
from plane.ppm_git.providers.base import PpmGitProviderError
from plane.ppm_git.services import PpmGitError, normalize_git_object_url
from plane.ppm_git.webhooks import body_sha256, parse_forgejo_webhook, parse_github_webhook
from plane.tests.contract.ppm_git.forgejo_fake import (
    PUBLIC_URL,
    TOKEN,
    WEBHOOK_SECRET,
    FakeResponse,
    webhook_fixture,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

APP = f"{PUBLIC_URL}/team-alpha/app"
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


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def people(forgejo):
    """A project KEY: its lead (РП, project admin), a member, a guest, a PPM global admin and an outsider."""
    lead = make_user("lead")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="KEY")
    ProjectMemberFactory(workspace=workspace, project=project, member=lead, role=20)
    member = make_user("member")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    outsider = make_user("outsider")
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=20)
    other_project = ProjectFactory(workspace=workspace, identifier="OUT")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=outsider, role=20)
    admin = make_user("global")
    PpmGlobalAdmin.objects.create(user=admin, reason="G2.1 contract test")
    state = State.objects.create(
        name="Backlog", color="#60646C", group="backlog", default=True, project=project, created_by=lead
    )
    issues = []
    for number in range(1, 6):
        issue = Issue(name=f"Задача {number}", project=project, state=state)
        issue.save(created_by_id=lead.id)
        issues.append(issue)
    cache.clear()
    return {
        "workspace": workspace,
        "project": project,
        "lead": lead,
        "member": member,
        "outsider": outsider,
        "admin": admin,
        "issues": issues,
    }


def git_url(people, suffix=""):
    return f"/api/ppm/v1/workspaces/{people['workspace'].id}/projects/{people['project'].id}/git/{suffix}"


def as_user(api_client, user):
    api_client.force_authenticate(user=user)
    return api_client


def connect(api_client, people, provider_repository_id=1, *, capture=None):
    with patch("plane.ppm_git.views.reconcile_git_connection_task.delay") as enqueue:
        if capture is not None:
            with capture(execute=True):
                response = api_client.post(
                    git_url(people, "providers/forgejo/repositories/"),
                    {"provider_repository_id": provider_repository_id},
                    format="json",
                )
        else:
            response = api_client.post(
                git_url(people, "providers/forgejo/repositories/"),
                {"provider_repository_id": provider_repository_id},
                format="json",
            )
    return response, enqueue


# --- the global administrator lists and connects -------------------------------------------------------------------


def test_global_admin_lists_the_git_server_repositories(api_client, people, forgejo):
    as_user(api_client, people["admin"])

    listing = api_client.get(git_url(people, "providers/forgejo/repositories/"))
    searched = api_client.get(git_url(people, "providers/forgejo/repositories/"), {"search": "app", "page": 1})

    assert listing.status_code == status.HTTP_200_OK
    assert (listing.data["page"], listing.data["has_next"]) == (1, False)
    assert [item["full_name"] for item in listing.data["results"]] == [
        "dev1/sandbox",
        "team-alpha/app",
        "team-alpha/legacy",
    ]
    assert all(set(item) == CONTRACT_KEYS for item in listing.data["results"])
    app = listing.data["results"][1]
    assert app == {
        "provider_repository_id": 1,
        "full_name": "team-alpha/app",
        "name": "app",
        "owner": "team-alpha",
        "description": "Приложение команды",
        "private": True,
        "archived": False,
        "default_branch": "main",
        "html_url": APP,
        "clone_https": f"{APP}.git",
        "clone_ssh": "ssh://git@git.ppm-g21-a2.localhost:2222/team-alpha/app.git",
        "updated_at": "2026-09-28T13:32:16+00:00",
        "connected": False,
    }
    assert (listing.data["results"][2]["archived"], listing.data["results"][2]["description"]) == (True, "")
    assert [item["name"] for item in searched.data["results"]] == ["app"]
    assert ("/repos/search", {"q": "app", "page": 1, "limit": 50, "sort": "alpha", "order": "asc"}) in forgejo.requests


def test_listing_pages_follow_the_contract(api_client, people, forgejo):
    forgejo.page_size = 2
    as_user(api_client, people["admin"])

    first = api_client.get(git_url(people, "providers/forgejo/repositories/"), {"page": 1})
    second = api_client.get(git_url(people, "providers/forgejo/repositories/"), {"page": "2"})
    broken = api_client.get(git_url(people, "providers/forgejo/repositories/"), {"page": "zero"})

    assert ([item["name"] for item in first.data["results"]], first.data["has_next"]) == (["sandbox", "app"], True)
    assert ([item["name"] for item in second.data["results"]], second.data["has_next"]) == (["legacy"], False)
    assert broken.status_code == status.HTTP_400_BAD_REQUEST
    assert broken.data["error"]["code"] == "GIT_INVALID_FIELD"


def test_global_admin_connects_a_repository(api_client, people, forgejo, django_capture_on_commit_callbacks):
    as_user(api_client, people["admin"])

    response, enqueue = connect(api_client, people, capture=django_capture_on_commit_callbacks)

    assert response.status_code == status.HTTP_201_CREATED
    assert set(response.data) == {"repository", "connection"}
    repository = PpmGitRepository.objects.get(project_id=people["project"].id)
    connection = PpmGitConnection.objects.get(project_id=people["project"].id)
    installation = PpmGitInstallation.objects.get(project_id=people["project"].id)
    assert response.data["repository"]["id"] == str(repository.id)
    assert response.data["connection"]["id"] == str(connection.id)
    assert (installation.provider, installation.provider_installation_id) == ("forgejo", 1)
    assert (installation.provider_account_id, installation.account_login) == (2, "ppm-bot")
    assert installation.permissions == {"metadata": "read", "contents": "read", "pull_requests": "read"}
    assert installation.events == ["push", "pull_request", "create", "delete", "repository"]
    assert (repository.provider, repository.provider_repository_id, repository.provider_full_name) == (
        "forgejo",
        1,
        "team-alpha/app",
    )
    assert (repository.canonical_url, repository.clone_https) == (APP, f"{APP}.git")
    assert repository.clone_ssh == "ssh://git@git.ppm-g21-a2.localhost:2222/team-alpha/app.git"
    assert (repository.visibility, repository.default_branch, repository.is_default) == ("private", "main", True)
    assert (connection.status, connection.installation_id, connection.provider_repository_id) == (
        "active",
        installation.id,
        1,
    )
    enqueue.assert_called_once_with(str(connection.id))
    audit = PpmGitAudit.objects.get(action="forgejo.repository.connect")
    assert (audit.actor_id, audit.target_id) == (people["admin"].id, connection.id)
    # PPM only read Forgejo.
    assert {path for path, _ in forgejo.requests} == {"/repositories/1", "/user"}

    listing = api_client.get(git_url(people, "providers/forgejo/repositories/"))
    overview = api_client.get(git_url(people))
    assert {item["name"]: item["connected"] for item in listing.data["results"]} == {
        "sandbox": False,
        "app": True,
        "legacy": False,
    }
    assert [item["provider"] for item in overview.data["installations"]] == ["forgejo"]
    assert overview.data["repositories"][0]["provider"] == "forgejo"


def test_connect_conflicts_missing_archived_invalid_and_waits(api_client, people, forgejo):
    as_user(api_client, people["admin"])
    first, _ = connect(api_client, people)

    again, _ = connect(api_client, people)
    missing, _ = connect(api_client, people, 999)
    archived, _ = connect(api_client, people, 4)
    invalid, _ = connect(api_client, people, "abc")
    forgejo.inject(r"/repositories/3$", FakeResponse(429, {"message": "slow"}, {"Retry-After": "30"}))
    waiting, _ = connect(api_client, people, 3)
    forgejo.inject(r"/repositories/3$", FakeResponse(500, {"message": "boom"}))
    down, _ = connect(api_client, people, 3)

    assert first.status_code == status.HTTP_201_CREATED
    assert (again.status_code, again.data["error"]["code"]) == (409, "GIT_REPOSITORY_CONFLICT")
    assert (missing.status_code, missing.data["error"]["code"]) == (404, "GIT_REPOSITORY_NOT_FOUND")
    assert (archived.status_code, archived.data["error"]["code"]) == (400, "GIT_REPOSITORY_ARCHIVED")
    assert (invalid.status_code, invalid.data["error"]["code"]) == (400, "GIT_REPOSITORY_INVALID")
    assert (waiting.status_code, waiting.data["error"]["code"]) == (429, "GIT_PROVIDER_RATE_LIMITED")
    assert waiting.data["error"]["details"] == {"retry_after_seconds": 30}
    assert (down.status_code, down.data["error"]["code"]) == (502, "GIT_PROVIDER_UNAVAILABLE")
    assert PpmGitConnection.objects.filter(project_id=people["project"].id).count() == 1
    assert PpmGitRepository.objects.filter(project_id=people["project"].id).count() == 1


@pytest.mark.parametrize("missing", ["PPM_FORGEJO_TOKEN", "PPM_FORGEJO_URL"])
def test_unconfigured_git_server_is_reported_to_the_admin(api_client, people, forgejo, settings, missing):
    setattr(settings, missing, "")
    as_user(api_client, people["admin"])

    listing = api_client.get(git_url(people, "providers/forgejo/repositories/"))
    connected, _ = connect(api_client, people)
    overview = api_client.get(git_url(people))

    assert (listing.status_code, listing.data["error"]["code"]) == (400, "FORGEJO_NOT_CONFIGURED")
    assert (connected.status_code, connected.data["error"]["code"]) == (400, "FORGEJO_NOT_CONFIGURED")
    assert overview.data["providers"]["forgejo"]["configured"] is False
    assert forgejo.requests == []


# --- everybody else: 403, and nothing reaches Forgejo, the logs or the audit ---------------------------------------


@pytest.mark.parametrize("who", ["lead", "member", "outsider"])
def test_project_lead_member_and_outsider_cannot_list_connect_or_disconnect(api_client, people, forgejo, caplog, who):
    as_user(api_client, people["admin"])
    connect(api_client, people)
    connection = PpmGitConnection.objects.get(project_id=people["project"].id)
    forgejo.requests.clear()
    caplog.clear()
    audits = PpmGitAudit.objects.count()
    as_user(api_client, people[who])

    listing = api_client.get(git_url(people, "providers/forgejo/repositories/"), {"search": "app"})
    connected, _ = connect(api_client, people, 3)
    disconnected = api_client.delete(git_url(people, f"connections/{connection.id}/"))

    for response in (listing, connected, disconnected):
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert response.data["error"]["code"] == "GIT_PERMISSION_DENIED"
        assert "team-alpha" not in response.content.decode() and "sandbox" not in response.content.decode()
    connection.refresh_from_db()
    assert connection.status == "active"
    assert forgejo.requests == []
    assert PpmGitAudit.objects.count() == audits
    assert "team-alpha" not in caplog.text and "sandbox" not in caplog.text


def test_project_lead_may_refresh_but_not_disconnect_a_git_server_repository(api_client, people, forgejo):
    as_user(api_client, people["admin"])
    connect(api_client, people)
    connection = PpmGitConnection.objects.get(project_id=people["project"].id)
    as_user(api_client, people["lead"])

    with patch("plane.ppm_git.views.reconcile_git_connection_task.delay") as enqueue:
        refreshed = api_client.post(git_url(people, f"connections/{connection.id}/"), format="json")
    removed = api_client.delete(git_url(people, f"connections/{connection.id}/"))
    missing = api_client.delete(git_url(people, f"connections/{uuid.uuid4()}/"))

    assert refreshed.status_code == status.HTTP_202_ACCEPTED
    enqueue.assert_called_once_with(str(connection.id))
    assert PpmGitAudit.objects.filter(action="forgejo.repository.sync", actor_id=people["lead"].id).exists()
    assert removed.status_code == status.HTTP_403_FORBIDDEN
    assert missing.status_code == status.HTTP_404_NOT_FOUND


def test_global_admin_disconnects_keeps_history_and_reconnects(api_client, people, forgejo):
    as_user(api_client, people["admin"])
    connect(api_client, people)
    connection = PpmGitConnection.objects.get(project_id=people["project"].id)
    synchronize_connection(connection.id)
    stored = PpmGitObject.objects.filter(connection=connection).count()
    PpmGitConnection.objects.filter(id=connection.id).update(
        sync_cursor={"commits_since": "2026-09-28T13:00:00+00:00", "halted": {"code": "GIT_REPOSITORY_DELETED"}}
    )

    removed = api_client.delete(git_url(people, f"connections/{connection.id}/"))
    connection.refresh_from_db()
    assert removed.status_code == status.HTTP_204_NO_CONTENT
    assert connection.status == "disconnected"
    assert PpmGitObject.objects.filter(connection=connection).count() == stored > 0
    assert PpmGitAudit.objects.filter(action="forgejo.repository.disconnect", target_id=connection.id).exists()

    again, _ = connect(api_client, people)
    connection.refresh_from_db()
    assert again.status_code == status.HTTP_201_CREATED
    assert again.data["connection"]["id"] == str(connection.id)
    assert connection.status == "active"
    # A new connection starts synchronizing: the halt of the old one does not carry over, the commit cursor does.
    assert connection.sync_cursor == {"commits_since": "2026-09-28T13:00:00+00:00"}


def test_a_renamed_repository_is_reported_and_reconnected_in_place(api_client, people, forgejo):
    as_user(api_client, people["admin"])
    connect(api_client, people)
    connection = PpmGitConnection.objects.get(project_id=people["project"].id)
    synchronize_connection(connection.id)
    forgejo.repository().name = "app-renamed"

    with pytest.raises(PpmGitProviderError) as exc_info:
        synchronize_connection(connection.id)
    connection.refresh_from_db()
    assert exc_info.value.code == "GIT_REPOSITORY_MOVED"
    assert (connection.status, connection.last_error_code) == ("error", "GIT_REPOSITORY_MOVED")

    # «Подключите его заново» must work: the same connection is updated in place, not refused as «already connected».
    again, _ = connect(api_client, people)

    connection.refresh_from_db()
    repository = PpmGitRepository.objects.get(id=connection.repository_id)
    assert again.status_code == status.HTTP_201_CREATED
    assert again.data["connection"]["id"] == str(connection.id)
    assert (connection.status, connection.provider_full_name) == ("active", "team-alpha/app-renamed")
    assert repository.canonical_url == f"{PUBLIC_URL}/team-alpha/app-renamed"
    synchronize_connection(connection.id)
    connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("active", "")
    assert PpmGitObject.objects.filter(
        connection=connection, canonical_url__startswith=f"{PUBLIC_URL}/team-alpha/app-renamed/"
    ).exists()


# --- the overview (R9) --------------------------------------------------------------------------------------------


def test_overview_reports_both_providers_and_the_git_server_capability(api_client, people, forgejo, settings):
    settings.PPM_GITHUB_APP_CONFIGURED = False

    as_user(api_client, people["admin"])
    admin_view = api_client.get(git_url(people))
    as_user(api_client, people["lead"])
    lead_view = api_client.get(git_url(people))
    settings.PPM_FORGEJO_TOKEN = ""
    settings.PPM_FORGEJO_PUBLIC_URL = ""
    unconfigured = api_client.get(git_url(people))

    # G2.2 adds the single sign-on fields (additive; without single sign-on they are off and empty).
    assert admin_view.data["providers"] == {
        "github": {"configured": False},
        "forgejo": {
            "configured": True,
            "public_url": PUBLIC_URL,
            "sso_enabled": False,
            "username": None,
            "sso_login_url": None,
        },
    }
    assert admin_view.data["capabilities"]["manage_git_server"] is True
    assert lead_view.data["capabilities"]["manage_git_server"] is False
    assert lead_view.data["capabilities"]["manage_provider"] is True
    # G2.2 R17: without single sign-on only the PPM global administrator connects repositories of the Git server.
    assert admin_view.data["capabilities"]["connect_git_server_repositories"] is True
    assert lead_view.data["capabilities"]["connect_git_server_repositories"] is False
    # The RC.1 GitHub summary stays as it was.
    assert admin_view.data["provider"]["provider"] == "github"
    assert admin_view.data["provider"]["mode"] == "github_app"
    assert unconfigured.data["providers"]["forgejo"] == {
        "configured": False,
        "public_url": None,
        "sso_enabled": False,
        "username": None,
        "sso_login_url": None,
    }
    for response in (admin_view, lead_view):
        text = json.dumps(response.data, default=str)
        assert TOKEN not in text and WEBHOOK_SECRET not in text


# --- the trusted Git server host ----------------------------------------------------------------------------------


def manual_repository(api_client, people, **overrides):
    payload = {
        "name": "App",
        "canonical_url": APP,
        "clone_https": f"{APP}.git",
        "default_branch": "main",
        **overrides,
    }
    return api_client.post(git_url(people, "repositories/"), payload, format="json")


def test_only_the_configured_git_server_host_is_trusted(api_client, people, forgejo, settings):
    as_user(api_client, people["admin"])

    manual = manual_repository(api_client, people)
    manual_forgejo = manual_repository(api_client, people, provider="forgejo")
    manual_local = manual_repository(
        api_client,
        people,
        canonical_url="https://other.localhost/team/app",
        clone_https="https://other.localhost/team/app.git",
    )
    connected, _ = connect(api_client, people)

    # A manual (G0.1) record never gets the trust, even named «forgejo»; the connect flow does.
    assert (manual.status_code, manual.data["error"]["code"]) == (400, "GIT_UNSAFE_URL")
    assert (manual_forgejo.status_code, manual_forgejo.data["error"]["code"]) == (400, "GIT_UNSAFE_URL")
    assert (manual_local.status_code, manual_local.data["error"]["code"]) == (400, "GIT_UNSAFE_URL")
    assert connected.status_code == status.HTTP_201_CREATED
    repository = PpmGitRepository.objects.get(project_id=people["project"].id)

    # An existing Forgejo record keeps the trust (for example «Сделать основным»); manual links to its objects too.
    patched = api_client.patch(
        git_url(people, f"repositories/{repository.id}/"), {"default_branch": "trunk"}, format="json"
    )
    link = api_client.post(
        git_url(people, "links/"),
        {
            "repository_id": str(repository.id),
            "work_item_id": str(people["issues"][0].id),
            "object_type": "pull_request",
            "ref": "3",
            "title": "KEY-1 — вручную",
            "canonical_url": f"{APP}/pulls/3",
        },
        format="json",
    )
    assert patched.status_code == status.HTTP_200_OK
    assert link.status_code == status.HTTP_201_CREATED

    # Exactly the host and the port: another port or another local host in a Forgejo answer is refused.
    for foreign in ("https://git.ppm-g21-a2.localhost:8443/team-alpha/app/commit/1", "https://other.localhost/x/y/z"):
        with pytest.raises(PpmGitError) as exc_info:
            normalize_git_object_url(foreign, repository=repository)
        assert exc_info.value.code in {"GIT_UNSAFE_URL", "GIT_URL_SCOPE_MISMATCH"}
    settings.PPM_FORGEJO_PUBLIC_URL = "https://git.example.test"
    with pytest.raises(PpmGitError) as exc_info:
        normalize_git_object_url(f"{APP}/commit/1", repository=repository)
    assert exc_info.value.code == "GIT_UNSAFE_URL"


def test_a_forgejo_answer_on_a_foreign_local_host_is_refused(api_client, people, forgejo):
    forgejo.public_url = "https://git.somewhere-else.localhost"
    as_user(api_client, people["admin"])

    response, _ = connect(api_client, people)

    assert (response.status_code, response.data["error"]["code"]) == (400, "GIT_UNSAFE_URL")
    assert not PpmGitRepository.objects.filter(project_id=people["project"].id).exists()
    assert not PpmGitConnection.objects.filter(project_id=people["project"].id).exists()


def test_a_manual_g01_record_is_adopted_by_its_canonical_url(api_client, people, forgejo, settings):
    public = "https://git.example.test"
    settings.PPM_FORGEJO_PUBLIC_URL = public
    forgejo.public_url = public
    forgejo.ssh_host = "git.example.test:2222"
    as_user(api_client, people["lead"])
    manual = manual_repository(
        api_client,
        people,
        canonical_url=f"{public}/team-alpha/app",
        clone_https=f"{public}/team-alpha/app.git",
    )
    as_user(api_client, people["admin"])

    connected, _ = connect(api_client, people)

    assert manual.status_code == status.HTTP_201_CREATED
    assert manual.data["provider"] == "generic"
    assert connected.status_code == status.HTTP_201_CREATED
    repository = PpmGitRepository.objects.get(project_id=people["project"].id)
    assert str(repository.id) == manual.data["id"] == connected.data["repository"]["id"]
    assert (repository.provider, repository.provider_repository_id, repository.is_default) == ("forgejo", 1, True)
    assert repository.clone_ssh == "ssh://git@git.example.test:2222/team-alpha/app.git"


# --- fix round 1: `connected` in the list is exactly the «already connected» 409 ---------------------------------


def listed(api_client, people, provider_repository_id=1):
    listing = api_client.get(git_url(people, "providers/forgejo/repositories/"))
    return next(item for item in listing.data["results"] if item["provider_repository_id"] == provider_repository_id)


def move_to_state(api_client, people, forgejo, connection, state):
    if state == "renamed":
        forgejo.repository().name = "app-renamed"
    elif state == "halted":
        PpmGitConnection.objects.filter(id=connection.id).update(
            status="error", sync_cursor={"halted": {"code": "GIT_REPOSITORY_DELETED"}}
        )
    elif state == "disconnected":
        assert api_client.delete(git_url(people, f"connections/{connection.id}/")).status_code == 204
    elif state == "record_archived_earlier":
        # A connection left on an archived record (a project manager could archive it before fix round 1).
        PpmGitRepository.objects.filter(id=connection.repository_id).update(status="archived", is_default=False)
    elif state == "archived_by_admin":
        assert api_client.delete(git_url(people, f"repositories/{connection.repository_id}/")).status_code == 204


@pytest.mark.parametrize(
    "state",
    ["active", "renamed", "halted", "disconnected", "record_archived_earlier", "archived_by_admin"],
)
def test_listed_connected_is_exactly_the_already_connected_conflict(api_client, people, forgejo, state):
    as_user(api_client, people["admin"])
    connect(api_client, people)
    connection = PpmGitConnection.objects.get(project_id=people["project"].id)
    synchronize_connection(connection.id)
    stored = PpmGitObject.objects.filter(connection=connection).count()
    move_to_state(api_client, people, forgejo, connection, state)

    row = listed(api_client, people)
    again, _ = connect(api_client, people)

    assert row["connected"] is (again.status_code == status.HTTP_409_CONFLICT)
    assert row["connected"] is (state == "active")
    if state != "active":
        # Connected again in place: the same record and connection, the history comes back with them.
        assert again.status_code == status.HTTP_201_CREATED, again.data
        assert again.data["connection"]["id"] == str(connection.id)
        assert again.data["repository"]["id"] == str(connection.repository_id)
        connection.refresh_from_db()
        repository = PpmGitRepository.objects.get(id=connection.repository_id)
        assert (connection.status, repository.status, repository.is_default) == ("active", "active", True)
        assert repository.provider_full_name == row["full_name"]
        assert "halted" not in connection.sync_cursor
        assert PpmGitObject.objects.filter(connection=connection).count() == stored > 0
        assert listed(api_client, people)["connected"] is True


# --- fix round 1: a Git-server repository is removed from a project only by a PPM global administrator ----------


def test_project_lead_cannot_archive_a_connected_git_server_repository(api_client, people, forgejo):
    as_user(api_client, people["admin"])
    connected, _ = connect(api_client, people)
    repository_id = connected.data["repository"]["id"]
    connection_id = connected.data["connection"]["id"]
    as_user(api_client, people["lead"])

    refused = api_client.delete(git_url(people, f"repositories/{repository_id}/"))

    assert refused.status_code == status.HTTP_403_FORBIDDEN
    assert (refused.data["error"]["code"], refused.data["error"]["message"]) == (
        "GIT_SERVER_ADMIN_REQUIRED",
        "Репозиторий Git-сервера убирает администратор PPM.",
    )
    assert PpmGitRepository.objects.get(id=repository_id).status == "active"
    assert PpmGitConnection.objects.get(id=connection_id).status == "active"
    assert not PpmGitAudit.objects.filter(action="repository.archive").exists()

    # Once the administrator disconnected it, the record is an ordinary one again.
    as_user(api_client, people["admin"])
    assert api_client.delete(git_url(people, f"connections/{connection_id}/")).status_code == 204
    as_user(api_client, people["lead"])
    assert api_client.delete(git_url(people, f"repositories/{repository_id}/")).status_code == 204


def test_admin_archive_disconnects_and_a_new_connect_restores_the_record(api_client, people, forgejo):
    as_user(api_client, people["admin"])
    connected, _ = connect(api_client, people)
    connection = PpmGitConnection.objects.get(id=connected.data["connection"]["id"])
    synchronize_connection(connection.id)
    stored = PpmGitObject.objects.filter(connection=connection).count()

    archived = api_client.delete(git_url(people, f"repositories/{connection.repository_id}/"))

    connection.refresh_from_db()
    repository = PpmGitRepository.objects.get(id=connection.repository_id)
    assert archived.status_code == status.HTTP_204_NO_CONTENT
    assert (repository.status, connection.status) == ("archived", "disconnected")
    assert PpmGitAudit.objects.filter(action="repository.archive", target_id=repository.id).exists()
    assert PpmGitAudit.objects.filter(action="forgejo.repository.disconnect", target_id=connection.id).exists()
    # Nothing is synchronized into the archived record any more.
    synchronize_connection(connection.id)
    assert PpmGitObject.objects.filter(connection=connection).count() == stored

    again, _ = connect(api_client, people)

    connection.refresh_from_db()
    repository.refresh_from_db()
    assert again.status_code == status.HTTP_201_CREATED
    assert (again.data["repository"]["id"], again.data["connection"]["id"]) == (str(repository.id), str(connection.id))
    assert (repository.status, repository.archived_at, repository.is_default) == ("active", None, True)
    assert connection.status == "active"
    assert PpmGitRepository.objects.filter(project_id=people["project"].id).count() == 1
    overview = api_client.get(git_url(people))
    assert [item["id"] for item in overview.data["repositories"]] == [str(repository.id)]


def test_github_records_are_archived_by_the_project_lead_as_before(api_client, people, forgejo):
    lead = people["lead"]
    installation = PpmGitInstallation.objects.create(
        workspace_id=people["workspace"].id,
        project_id=people["project"].id,
        provider="github",
        provider_installation_id=81001,
        provider_account_id=71001,
        account_login="ppm-test-org",
        created_by=lead.id,
        updated_by=lead.id,
    )
    repository = PpmGitRepository.objects.create(
        workspace_id=people["workspace"].id,
        project_id=people["project"].id,
        name="github",
        normalized_name="github",
        provider="github",
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm",
        canonical_url="https://github.com/ppm-test-org/ppm",
        clone_https="https://github.com/ppm-test-org/ppm.git",
        is_default=True,
        created_by=lead.id,
        updated_by=lead.id,
    )
    connection = PpmGitConnection.objects.create(
        workspace_id=people["workspace"].id,
        project_id=people["project"].id,
        installation=installation,
        repository=repository,
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm",
        created_by=lead.id,
        updated_by=lead.id,
    )
    as_user(api_client, lead)

    archived = api_client.delete(git_url(people, f"repositories/{repository.id}/"))

    connection.refresh_from_db()
    assert archived.status_code == status.HTTP_204_NO_CONTENT
    assert PpmGitRepository.objects.get(id=repository.id).status == "archived"
    # RC.1 behaviour of GitHub records: archiving does not touch the connection.
    assert connection.status == "active"


def test_a_manual_record_next_to_an_archived_connected_one_is_reported_not_merged(
    api_client, people, forgejo, settings
):
    public = "https://git.example.test"
    settings.PPM_FORGEJO_PUBLIC_URL = public
    forgejo.public_url = public
    forgejo.ssh_host = "git.example.test:2222"
    as_user(api_client, people["admin"])
    connected, _ = connect(api_client, people)
    api_client.delete(git_url(people, f"repositories/{connected.data['repository']['id']}/"))
    as_user(api_client, people["lead"])
    manual = manual_repository(
        api_client, people, canonical_url=f"{public}/team-alpha/app", clone_https=f"{public}/team-alpha/app.git"
    )
    as_user(api_client, people["admin"])

    row = listed(api_client, people)
    again, _ = connect(api_client, people)

    assert manual.status_code == status.HTTP_201_CREATED
    assert row["connected"] is False
    # Not a 409: the web client reads any 409 as «already connected» and would hide the reason.
    assert again.status_code == status.HTTP_400_BAD_REQUEST
    assert again.data["error"]["code"] == "GIT_REPOSITORY_RECORD_CONFLICT"
    assert "ручн" in again.data["error"]["message"]
    assert PpmGitRepository.objects.get(id=manual.data["id"]).status == "active"
    assert PpmGitRepository.objects.get(id=connected.data["repository"]["id"]).status == "archived"

    # Once the manual record is removed, the connected one comes back.
    as_user(api_client, people["lead"])
    assert api_client.delete(git_url(people, f"repositories/{manual.data['id']}/")).status_code == 204
    as_user(api_client, people["admin"])
    restored, _ = connect(api_client, people)
    assert restored.status_code == status.HTTP_201_CREATED
    assert restored.data["repository"]["id"] == connected.data["repository"]["id"]


# --- SSH switched off (controller ruling) -------------------------------------------------------------------------


def test_no_ssh_address_anywhere_while_ssh_is_off_and_back_when_on(api_client, people, forgejo, settings):
    as_user(api_client, people["admin"])
    connect(api_client, people)
    connection = PpmGitConnection.objects.get(project_id=people["project"].id)
    repository = connection.repository
    assert repository.clone_ssh

    settings.PPM_FORGEJO_SSH_ENABLED = False
    listing = api_client.get(git_url(people, "providers/forgejo/repositories/"))
    overview = api_client.get(git_url(people))
    detail = api_client.get(git_url(people, f"repositories/{repository.id}/"))
    synchronize_connection(connection.id)
    repository.refresh_from_db()

    assert {item["clone_ssh"] for item in listing.data["results"]} == {""}
    assert overview.data["repositories"][0]["clone_ssh"] == ""
    assert detail.data["clone_ssh"] == ""
    # The synchronization also clears the stored address.
    assert repository.clone_ssh == ""

    settings.PPM_FORGEJO_SSH_ENABLED = True
    synchronize_connection(connection.id)
    repository.refresh_from_db()
    assert repository.clone_ssh == "ssh://git@git.ppm-g21-a2.localhost:2222/team-alpha/app.git"


def test_connecting_while_ssh_is_off_stores_no_ssh_address(api_client, people, forgejo, settings):
    settings.PPM_FORGEJO_SSH_ENABLED = False
    as_user(api_client, people["admin"])

    response, _ = connect(api_client, people)

    assert response.data["repository"]["clone_ssh"] == ""
    assert PpmGitRepository.objects.get(project_id=people["project"].id).clone_ssh == ""


# --- the same numeric ids at GitHub and Forgejo ------------------------------------------------------------------


def test_github_and_forgejo_with_the_same_ids_never_touch_each_other(api_client, people, forgejo):
    project = people["project"]
    lead = people["lead"]
    installation = PpmGitInstallation.objects.create(
        workspace_id=people["workspace"].id,
        project_id=project.id,
        provider="github",
        provider_installation_id=1,
        provider_account_id=71001,
        account_login="ppm-test-org",
        permissions={"metadata": "read", "contents": "read", "pull_requests": "read"},
        events=["push", "pull_request"],
        created_by=lead.id,
        updated_by=lead.id,
    )
    github_repository = PpmGitRepository.objects.create(
        workspace_id=people["workspace"].id,
        project_id=project.id,
        name="github-app",
        normalized_name="github-app",
        provider="github",
        provider_repository_id=1,
        provider_full_name="team-alpha/app",
        canonical_url="https://github.com/team-alpha/app",
        clone_https="https://github.com/team-alpha/app.git",
        is_default=True,
        created_by=lead.id,
        updated_by=lead.id,
    )
    github_connection = PpmGitConnection.objects.create(
        workspace_id=people["workspace"].id,
        project_id=project.id,
        installation=installation,
        repository=github_repository,
        provider_repository_id=1,
        provider_full_name="team-alpha/app",
        created_by=lead.id,
        updated_by=lead.id,
    )
    as_user(api_client, people["admin"])

    listing = api_client.get(git_url(people, "providers/forgejo/repositories/"))
    connected, _ = connect(api_client, people)
    forgejo_connection = PpmGitConnection.objects.exclude(id=github_connection.id).get(project_id=project.id)
    event, raw_body = webhook_fixture("push_main_initial")
    forgejo_delivery, _ = create_delivery(
        provider="forgejo",
        delivery_id="same-delivery-id",
        event_name=event,
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=parse_forgejo_webhook(raw_body, event_name=event),
    )
    github_body = json.dumps(
        {
            "ref": "refs/heads/main",
            "after": "a" * 40,
            "installation": {"id": 1},
            "repository": {"id": 1, "full_name": "team-alpha/app"},
            "head_commit": {"id": "a" * 40, "timestamp": "2026-09-28T10:00:00Z"},
            "commits": [
                {
                    "id": "a" * 40,
                    "message": "KEY-1: GitHub",
                    "url": f"https://github.com/team-alpha/app/commit/{'a' * 40}",
                    "timestamp": "2026-09-28T10:00:00Z",
                    "author": {"username": "developer"},
                }
            ],
        }
    ).encode()
    github_delivery, _ = create_delivery(
        delivery_id="same-delivery-id",
        event_name="push",
        raw_body_hash=body_sha256(github_body),
        normalized_payload=parse_github_webhook(github_body, event_name="push"),
    )

    process_delivery(forgejo_delivery.id)
    process_delivery(github_delivery.id)

    # GitHub's repository 1 is connected, Forgejo's is not: the listing looks only at Forgejo connections.
    assert next(item for item in listing.data["results"] if item["provider_repository_id"] == 1)["connected"] is False
    assert connected.status_code == status.HTTP_201_CREATED
    assert {
        item.canonical_url.split("/")[2] for item in PpmGitObject.objects.filter(connection=forgejo_connection)
    } == {"git.ppm-g21-a2.localhost:19443"}
    assert {item.canonical_url.split("/")[2] for item in PpmGitObject.objects.filter(connection=github_connection)} == {
        "github.com"
    }
    assert PpmGitDelivery.objects.filter(provider_delivery_id="same-delivery-id").count() == 2
    assert PpmGitLink.objects.filter(repository=github_repository).count() == 1


# --- the receiver is not throttled like an anonymous client ---------------------------------------------------------


def test_a_burst_of_signed_deliveries_is_accepted(api_client, forgejo):
    import hashlib
    import hmac

    cache.clear()
    _, raw_body = webhook_fixture("push_tag")
    signature = hmac.new(WEBHOOK_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()

    with patch("plane.ppm_git.views.process_git_delivery_task.delay"):
        answers = [
            api_client.generic(
                "POST",
                "/api/ppm/v1/git/forgejo/webhook/",
                raw_body,
                content_type="application/json",
                HTTP_X_FORGEJO_EVENT="push",
                HTTP_X_FORGEJO_DELIVERY=f"burst-{number}",
                HTTP_X_FORGEJO_SIGNATURE=signature,
            ).status_code
            for number in range(45)
        ]

    # One push is several deliveries (push, create, pull request sync); the default anonymous rate is 30/minute.
    assert answers == [status.HTTP_202_ACCEPTED] * 45
