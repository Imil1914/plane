"""G2.2 R8 — клиент администрирования Forgejo (`ppm_git/forgejo_admin.py`) на поддельном admin API Forgejo 15.

Тела запросов совпадают с тем, что принимает живой Forgejo 15.0.9 (отчёт S2a §0): учётка создаётся с `source_id` и
`login_name` без пароля и с `must_change_password: false`, в каждом PATCH учётки есть `source_id` и `login_name`,
не-admin команды — только с `units_map`, PATCH организации пересылает описание, сайт и место. Ошибки — безопасные
коды и тексты, токен администрирования нигде не остаётся.
"""

import logging

import pytest
import requests

from plane.ppm_git.forgejo_admin import TEAM_UNITS, ForgejoAdminClient
from plane.ppm_git.providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from plane.tests.contract.ppm_git.forgejo_admin_fake import ADMIN_TOKEN, SOURCE_ID, SSO_SETTINGS, FakeForgejoAdminApi
from plane.tests.contract.ppm_git.forgejo_fake import FakeResponse

pytestmark = [pytest.mark.contract]


@pytest.fixture
def api(settings):
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)
    return FakeForgejoAdminApi()


@pytest.fixture
def client(api):
    return ForgejoAdminClient(session=api, page_size=api.page_size)


def test_create_user_body_is_exactly_what_live_forgejo_accepts(api, client):
    created = client.create_user(
        username="ivan.petrov",
        email="ivan.petrov@example.test",
        full_name="Иван Петров",
        source_id=SOURCE_ID,
        login_name="9b0c7a1e-0000-4000-8000-000000000001",
    )

    request = api.calls("POST", r"^/admin/users$")[0]
    assert request["body"] == {
        "username": "ivan.petrov",
        "email": "ivan.petrov@example.test",
        "full_name": "Иван Петров",
        "source_id": SOURCE_ID,
        "login_name": "9b0c7a1e-0000-4000-8000-000000000001",
        "must_change_password": False,
    }
    assert "password" not in request["body"]
    assert created["login"] == "ivan.petrov"
    assert created["source_id"] == SOURCE_ID
    assert created["login_name"] == "9b0c7a1e-0000-4000-8000-000000000001"
    assert api.user("ivan.petrov")["must_change_password"] is False


@pytest.mark.parametrize(
    ("username", "email", "code"),
    [
        ("git-admin", "someone@example.test", "FORGEJO_NAME_TAKEN"),
        ("GIT-ADMIN", "someone@example.test", "FORGEJO_NAME_TAKEN"),
        ("admin", "someone@example.test", "FORGEJO_NAME_INVALID"),
        ("bob.keys", "someone@example.test", "FORGEJO_NAME_INVALID"),
        ("a..b", "someone@example.test", "FORGEJO_NAME_INVALID"),
        ("free-name", "GIT-ADMIN@git.invalid", "FORGEJO_EMAIL_TAKEN"),
    ],
)
def test_create_user_refusals_are_classified_without_forgejo_text(client, username, email, code):
    with pytest.raises(PpmGitProviderError) as caught:
        client.create_user(username=username, email=email, full_name="", source_id=SOURCE_ID, login_name="x")

    assert caught.value.code == code
    assert "exists" not in caught.value.message and "in use" not in caught.value.message
    assert caught.value.http_status == 422


def test_unknown_source_is_a_configuration_problem(client):
    with pytest.raises(PpmGitProviderError) as caught:
        client.create_user(username="someone", email="s@example.test", full_name="", source_id=99, login_name="x")

    assert caught.value.code == "FORGEJO_SSO_SOURCE_MISSING"
    assert "git-bootstrap" in caught.value.message


def test_edit_user_always_sends_source_id_and_login_name(api, client):
    api.add_user("maria", email="maria@example.test", source_id=SOURCE_ID, login_name="sub-1")

    client.edit_user("maria", source_id=SOURCE_ID, login_name="sub-1", prohibit_login=True)
    client.edit_user("maria", source_id=SOURCE_ID, login_name="sub-1", full_name="Мария", admin=False)

    bodies = [item["body"] for item in api.calls("PATCH", r"^/admin/users/maria$")]
    assert bodies == [
        {"source_id": SOURCE_ID, "login_name": "sub-1", "prohibit_login": True},
        {"source_id": SOURCE_ID, "login_name": "sub-1", "full_name": "Мария", "admin": False},
    ]
    assert api.user("maria")["prohibit_login"] is True


def test_edit_user_taken_email_is_classified(api, client):
    api.add_user("maria", email="maria@example.test", source_id=SOURCE_ID, login_name="sub-1")

    with pytest.raises(PpmGitProviderError) as caught:
        client.edit_user("maria", source_id=SOURCE_ID, login_name="sub-1", email="git-admin@git.invalid")

    assert caught.value.code == "FORGEJO_EMAIL_TAKEN"
    assert caught.value.http_status == 400


def test_user_lookups(api, client):
    api.add_user("ivan", email="Ivan@Example.test", source_id=SOURCE_ID, login_name="sub-ivan")
    api.add_user("ivan-twin", email="twin@example.test", source_id=SOURCE_ID, login_name="sub-ivan")
    api.add_org("team-alpha")

    assert [item["login"] for item in client.find_users_by_login(SOURCE_ID, "sub-ivan")] == ["ivan", "ivan-twin"]
    assert client.find_users_by_login(SOURCE_ID, "SUB-IVAN") == []
    assert client.get_user("IVAN")["email"] == "Ivan@Example.test"
    assert client.get_user("team-alpha")["login"] == "team-alpha"  # an organization is a taken name too
    assert client.get_user("nobody") is None
    owners = client.find_email_owners("ivan@example.test")
    assert owners == [
        {
            "email": "Ivan@Example.test",
            "user_id": api.user("ivan")["id"],
            "username": "ivan",
            "primary": True,
            "verified": True,
        }
    ]
    # A substring or a similar address is not the address.
    assert client.find_email_owners("van@example.test") == []


def test_organization_edit_resends_the_fields_forgejo_would_clear(api, client):
    api.add_org("team-alpha", description="Описание", website="https://example.test", location="Москва")

    organization = client.get_organization("team-alpha")
    client.edit_organization(organization, full_name="Альфа", visibility="private")

    assert api.calls("PATCH", r"^/orgs/team-alpha$")[0]["body"] == {
        "full_name": "Альфа",
        "visibility": "private",
        "description": "Описание",
        "website": "https://example.test",
        "location": "Москва",
    }
    assert api.org("team-alpha")["description"] == "Описание"
    assert client.get_organization("ivan") is None


def test_create_organization_is_private(api, client):
    created = client.create_organization(name="team-beta", full_name="Бета")

    assert api.calls("POST", r"^/orgs$")[0]["body"] == {
        "username": "team-beta",
        "full_name": "Бета",
        "visibility": "private",
    }
    assert created["name"] == "team-beta"
    assert api.org("team-beta")["visibility"] == "private"


def test_teams_non_admin_only_with_units_map(api, client):
    api.add_org("team-alpha", owner="ppm-bot")

    write = client.create_team("team-alpha", name="APP", description="d", permission="write", can_create_org_repo=False)
    admin = client.create_team(
        "team-alpha", name="APP-admin", description="d", permission="admin", can_create_org_repo=True
    )

    bodies = [item["body"] for item in api.calls("POST", r"^/orgs/team-alpha/teams$")]
    assert bodies[0] == {
        "name": "APP",
        "description": "d",
        "permission": "write",
        "units_map": {unit: "write" for unit in TEAM_UNITS},
        "includes_all_repositories": False,
        "can_create_org_repo": False,
    }
    assert "units_map" not in bodies[1]
    assert bodies[1]["can_create_org_repo"] is True
    assert write["units_map"] == {unit: "write" for unit in TEAM_UNITS}
    assert admin["permission"] == "admin"
    assert set(TEAM_UNITS) == {"repo.code", "repo.pulls", "repo.issues", "repo.releases", "repo.wiki"}

    with pytest.raises(PpmGitProviderError) as caught:
        client.create_team("team-alpha", name="app", description="", permission="read", can_create_org_repo=False)
    assert caught.value.code == "FORGEJO_TEAM_EXISTS"


def test_team_rename_conflict_is_not_an_outage(api, client):
    api.add_org("team-alpha", owner="ppm-bot")
    first = api.add_team("team-alpha", "APP")
    api.add_team("team-alpha", "WEB")

    with pytest.raises(PpmGitProviderError) as caught:
        client.edit_team(first["id"], name="web", description="", permission="write", can_create_org_repo=False)

    assert caught.value.code == "FORGEJO_TEAM_EXISTS"
    assert not isinstance(caught.value, PpmGitProviderRateLimited)


def test_team_members_repositories_and_idempotent_removals(api, client):
    api.add_org("team-alpha", owner="ppm-bot")
    api.add_repository("team-alpha", "app")
    team = api.add_team("team-alpha", "APP")
    api.add_user("ivan", email="ivan@example.test")

    client.add_team_member(team["id"], "ivan")
    client.add_team_repository(team["id"], "team-alpha", "app")
    members = client.list_team_members(team["id"])
    assert [member["login"] for member in members] == ["ivan"]
    # What an administrator sees: PPM decides from it whether a member is its own account.
    assert {"source_id", "login_name", "is_admin"} <= set(members[0])
    assert [item["full_name"] for item in client.list_team_repositories(team["id"])] == ["team-alpha/app"]

    client.remove_team_member(team["id"], "ivan")
    client.remove_team_member(team["id"], "ivan")
    client.remove_team_repository(team["id"], "team-alpha", "app")
    assert client.list_team_members(team["id"]) == []
    assert client.delete_team(team["id"]) is True
    assert client.delete_team(team["id"]) is False
    assert client.get_team(team["id"]) is None


def test_sudo_listings_act_as_the_person(api, client):
    api.add_org("team-alpha", owner="ppm-bot")
    api.add_repository("team-alpha", "app")
    api.add_user("ivan", email="ivan@example.test", prohibit_login=True)
    team = api.add_team("team-alpha", "APP", members=["ivan"], repositories=["team-alpha/app"])

    teams = client.list_user_teams("ivan")
    repositories = client.list_user_repositories("ivan")
    whole = client.list_repositories_as("ivan")

    assert [(item["id"], item["organization"]) for item in teams] == [(team["id"], "team-alpha")]
    assert repositories[0]["full_name"] == "team-alpha/app"
    assert repositories[0]["permissions"] == {"admin": False, "push": True, "pull": True}
    # The whole answers (line S2b's connect dialog normalizes them itself), with the person's own permissions.
    assert whole[0]["full_name"] == "team-alpha/app" and whole[0]["permissions"]["push"] is True
    assert {"html_url", "clone_url", "default_branch", "archived", "description", "owner"} <= set(whole[0])
    assert {item["sudo"] for item in api.requests if item["path"].startswith("/user/")} == {"ivan"}
    assert all(item["sudo"] is None for item in api.requests if not item["path"].startswith("/user/"))


def test_pages_by_page_and_limit_until_total_count(api, settings):
    for index in range(7):
        api.add_user(f"person{index}", email=f"p{index}@example.test", source_id=SOURCE_ID, login_name=f"sub-{index}")
    client = ForgejoAdminClient(session=api, page_size=3)

    found = client.list_source_users(SOURCE_ID)

    assert len(found) == 7
    pages = [item["params"]["page"] for item in api.calls("GET", r"^/admin/users$")]
    assert pages == [1, 2, 3]
    assert {item["params"]["limit"] for item in api.calls("GET", r"^/admin/users$")} == {3}


def test_wrong_token_never_reaches_an_exception_or_a_log(api, settings, caplog):
    settings.PPM_FORGEJO_ADMIN_TOKEN = "wrong-admin-token-value-0000000000000000"
    client = ForgejoAdminClient(session=api)

    with caplog.at_level(logging.DEBUG), pytest.raises(PpmGitProviderError) as caught:
        client.get_user("ivan")

    assert caught.value.code == "GIT_PROVIDER_AUTH_FAILED"
    assert "git-bootstrap --rotate-token" in caught.value.message
    text = f"{caught.value!r} {caught.value.message} {caplog.text}"
    assert "wrong-admin-token-value" not in text
    assert ADMIN_TOKEN not in repr(client) and ADMIN_TOKEN not in str(vars(client))


def test_transport_errors_and_waits(api, client):
    api.inject("GET", r"^/users/", requests.ConnectionError(f"boom token {ADMIN_TOKEN}"))
    with pytest.raises(PpmGitProviderError) as caught:
        client.get_user("ivan")
    assert caught.value.code == "GIT_PROVIDER_UNAVAILABLE"
    # No exception chain: a transport error may describe the request it failed on (`raise … from None`).
    assert caught.value.__cause__ is None and caught.value.__suppress_context__ is True
    assert ADMIN_TOKEN not in f"{caught.value!r} {caught.value.message}"
    assert caught.value.http_status is None

    api.inject("GET", r"^/users/", FakeResponse(429, {"message": "slow down"}, {"Retry-After": "17"}))
    with pytest.raises(PpmGitProviderRateLimited) as waited:
        client.get_user("ivan")
    assert waited.value.retry_after_seconds == 17

    api.inject("GET", r"^/users/", FakeResponse(503, {"message": "maintenance"}))
    with pytest.raises(PpmGitProviderRateLimited):
        client.get_user("ivan")

    api.inject("GET", r"^/users/", FakeResponse(500, {"message": "internal"}))
    with pytest.raises(PpmGitProviderError) as failed:
        client.get_user("ivan")
    assert failed.value.code == "GIT_PROVIDER_UNAVAILABLE"
    assert failed.value.http_status == 500


def test_not_configured_without_admin_token(api, settings):
    settings.PPM_FORGEJO_ADMIN_TOKEN = ""

    with pytest.raises(PpmGitProviderError) as caught:
        ForgejoAdminClient(session=api).get_user("ivan")

    assert caught.value.code == "GIT_PROVIDER_NOT_CONFIGURED"
    assert api.requests == []


def test_every_request_can_be_bounded_by_the_caller(api, client):
    timeouts = iter([(1.5, 1.5), (0.2, 0.2)])
    client.request_timeout = lambda: next(timeouts)

    client.get_user("git-admin")
    client.get_user("ppm-bot")

    assert [item["timeout"] for item in api.requests] == [(1.5, 1.5), (0.2, 0.2)]

    class Stop(Exception):
        pass

    def stop():
        raise Stop()

    client.request_timeout = stop
    with pytest.raises(Stop):
        client.get_user("git-admin")
    assert len(api.requests) == 2


def test_repositories_as_a_person_come_page_by_page(api, settings):
    api.add_org("team-alpha", owner="ppm-bot")
    api.add_user("ivan", email="ivan@example.test")
    for index in range(5):
        api.add_repository("team-alpha", f"repo-{index}")
    api.add_team("team-alpha", "APP", members=["ivan"], repositories=[f"team-alpha/repo-{index}" for index in range(5)])
    client = ForgejoAdminClient(session=api, page_size=2)

    found = client.list_repositories_as("ivan")

    assert [item["name"] for item in found] == [f"repo-{index}" for index in range(5)]
    assert [item["params"]["page"] for item in api.calls("GET", r"^/user/repos$")] == [1, 2, 3]
    assert {item["sudo"] for item in api.calls("GET", r"^/user/repos$")} == {"ivan"}
    with pytest.raises(PpmGitProviderError) as caught:
        client.list_repositories_as("nobody")
    assert caught.value.code == "GIT_PROVIDER_NOT_FOUND"


@pytest.mark.parametrize("username", ["", "   ", None])
def test_sudo_never_falls_back_to_the_token_owner(api, client, username):
    # Without the header a request would act as ppm-bot, a site administrator: a blank name stops before it.
    with pytest.raises(ValueError):
        client.list_repositories_as(username)
    with pytest.raises(ValueError):
        client.list_user_teams(username)
    with pytest.raises(ValueError):
        client.list_user_repositories(username)

    assert api.requests == []
