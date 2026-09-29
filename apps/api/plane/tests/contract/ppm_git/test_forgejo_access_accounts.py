"""G2.2 R9–R10 — учётка на Git-сервере в момент входа (`forgejo_access.ensure_account_for_login`).

Поддельный admin API Forgejo 15 (`forgejo_admin_fake.py`) отвечает как живой: поиск по (`source_id`, `login_name`)
перед созданием, перенятие только локальной не-админской учётки с той же основной подтверждённой почтой, создание с
`must_change_password: false` без пароля, имя из почты с суффиксом при занятости (людьми и организациями), сверка
имени и почты PATCH-ем, повтор после сбоя не создаёт вторую учётку. Служебные учётки PPM не трогает никогда.
"""

import uuid

import pytest
import requests

from plane.db.models import User
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_git import forgejo_access
from plane.ppm_git.forgejo_access import (
    ForgejoAccessError,
    ensure_account_for_login,
    forgejo_sso_is_configured,
    forgejo_username_for,
)
from plane.ppm_git.forgejo_admin import ForgejoAdminClient
from plane.ppm_git.models import PpmForgejoAccount, PpmForgejoSyncRun, PpmGitAudit
from plane.tests.contract.ppm_git.forgejo_admin_fake import ADMIN_TOKEN, SOURCE_ID, SSO_SETTINGS, FakeForgejoAdminApi
from plane.tests.contract.ppm_git.forgejo_fake import FakeResponse
from plane.tests.factories import UserFactory

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


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
    """Background syncs are recorded, never sent to a broker; the engine's cache keys start empty."""
    calls = []
    monkeypatch.setattr(
        "plane.ppm_git.tasks.sync_forgejo_access_task.apply_async", lambda *args, **kwargs: calls.append(kwargs)
    )
    forgejo_access.clear_access_cache()
    yield calls
    forgejo_access.clear_access_cache()


def person(email, *, display_name="", first_name="Иван", last_name="Петров", **extra):
    return UserFactory(
        email=email,
        username=uuid.uuid4().hex,
        display_name=display_name,
        first_name=first_name,
        last_name=last_name,
        **extra,
    )


def test_first_login_creates_an_account_bound_to_the_person(api):
    user = person("Ivan.Petrov@example.test", display_name="Иван Петров")

    account = ensure_account_for_login(user)

    created = api.user("ivan.petrov")
    assert created is not None
    assert (created["source_id"], created["login_name"]) == (SOURCE_ID, str(user.id))
    assert created["must_change_password"] is False
    assert created["full_name"] == "Иван Петров"
    assert created["email"] == "ivan.petrov@example.test"  # Plane keeps e-mails in lowercase
    body = api.calls("POST", r"^/admin/users$")[0]["body"]
    assert body["must_change_password"] is False and "password" not in body
    assert (account.user_id, account.username, account.forgejo_user_id) == (user.id, "ivan.petrov", created["id"])
    assert account.adopted is False and account.prohibited is False
    audit = PpmGitAudit.objects.get(action="forgejo.access.account_created")
    assert audit.actor_id is None and audit.workspace_id is None and audit.project_id is None
    assert audit.target_id == account.id and audit.metadata["username"] == "ivan.petrov"
    assert forgejo_username_for(user) == "ivan.petrov"


def test_second_login_finds_the_same_account_and_changes_nothing(api):
    user = person("ivan@example.test", display_name="Иван")
    first = ensure_account_for_login(user)
    writes = len(api.writes())

    second = ensure_account_for_login(user)

    assert second.pk == first.pk
    assert len(api.writes()) == writes
    assert len(api.calls("GET", r"^/admin/users$")) == 2  # the search by (source_id, login_name) comes first
    assert [account["login"] for account in api.accounts.values() if account.get("login_name") == str(user.id)] == [
        "ivan"
    ]


def test_retry_after_a_failure_does_not_create_a_second_account(api):
    user = person("ivan@example.test")
    api.inject("GET", r"^/admin/users$", requests.ConnectionError("down"))

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    assert caught.value.code == "GIT_PROVIDER_UNAVAILABLE"
    assert caught.value.message == "Git-сервер недоступен."
    assert PpmForgejoAccount.objects.count() == 0
    run = PpmForgejoSyncRun.objects.get()
    assert run.status == "error" and run.problems[0]["message"] == "Git-сервер недоступен."
    assert ADMIN_TOKEN not in str(run.problems)

    # The account was created on the Git server, but PPM did not record it (the answer was lost).
    api.add_user("ivan", email="ivan@example.test", source_id=SOURCE_ID, login_name=str(user.id))
    account = ensure_account_for_login(user)

    assert account.username == "ivan"
    assert api.calls("POST", r"^/admin/users$") == []


def test_a_local_account_with_the_same_email_is_never_adopted(api):
    local = api.add_user("ivan", email="ivan@example.test", full_name="Старое имя")
    before = dict(local)
    user = person("IVAN@example.test", display_name="Иван Петров")

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    # Forgejo keeps e-mails unique (422, live v15): the name gets a suffix, the e-mail refuses the sign-in.
    assert caught.value.code == "FORGEJO_EMAIL_TAKEN"
    assert caught.value.message == (
        "Почта ivan@example.test уже занята локальной учёткой Forgejo ivan — администратору нужно освободить её."
    )
    assert [item["body"]["username"] for item in api.calls("POST", r"^/admin/users$")] == ["ivan-2"]
    assert api.calls("PATCH", r"^/admin/users/") == []
    assert dict(local) == before and (local["source_id"], local["login_name"]) == (0, "")
    assert PpmForgejoAccount.objects.count() == 0
    run = PpmForgejoSyncRun.objects.get()
    assert run.status == "partial"
    assert (run.problems[0]["kind"], run.problems[0]["subject"]) == ("account", "ivan@example.test")
    assert not PpmGitAudit.objects.exists()


@pytest.mark.parametrize(
    ("owner", "holder"),
    [
        ({"login": "boss", "is_admin": True}, "локальной учёткой Forgejo boss"),
        ({"login": "ppm-bot", "is_admin": False}, "локальной учёткой Forgejo ppm-bot"),
        ({"login": "git-admin", "is_admin": False}, "локальной учёткой Forgejo git-admin"),
        (
            {"login": "sso-other", "is_admin": False, "source_id": SOURCE_ID, "login_name": "other-person"},
            "учёткой Forgejo sso-other",
        ),
        ({"login": "secondary", "is_admin": False, "secondary": True}, "локальной учёткой Forgejo secondary"),
        ({"login": "unverified", "is_admin": False, "verified": False}, "локальной учёткой Forgejo unverified"),
    ],
)
def test_an_email_held_by_any_other_account_refuses_the_sign_in(api, owner, holder):
    email = "shared@example.test"
    existing = api.find(owner["login"])
    if existing is not None:
        existing["emails"] = [{"email": email, "primary": True, "verified": True}]
        existing["email"] = email
        existing["is_admin"] = owner["is_admin"]
    elif owner.get("secondary"):
        api.add_user(owner["login"], email="main@example.test", extra_emails=[email])
    else:
        api.add_user(
            owner["login"],
            email=email,
            is_admin=owner["is_admin"],
            source_id=owner.get("source_id", 0),
            login_name=owner.get("login_name", ""),
            verified=owner.get("verified", True),
        )
    before = {account_id: dict(account) for account_id, account in api.accounts.items()}
    user = person(email)

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    assert caught.value.code == "FORGEJO_EMAIL_TAKEN"
    assert caught.value.message == f"Почта {email} уже занята {holder} — администратору нужно освободить её."
    assert api.calls("PATCH", r"^/admin/users/") == []
    assert {account_id: dict(account) for account_id, account in api.accounts.items()} == before
    assert PpmForgejoAccount.objects.count() == 0
    run = PpmForgejoSyncRun.objects.get()
    assert run.problems[0]["kind"] == "account" and run.problems[0]["subject"] == email


def test_an_account_unbound_by_hand_is_not_bound_again(api):
    user = person("ivan@example.test")
    first = ensure_account_for_login(user)
    unbound = api.user("ivan")
    unbound.update(source_id=0, login_name="")  # an administrator turned it into a local account

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    assert caught.value.code == "FORGEJO_EMAIL_TAKEN"
    assert "локальной учёткой Forgejo ivan" in caught.value.message
    assert (unbound["source_id"], unbound["login_name"]) == (0, "")
    assert [item["path"] for item in api.calls("PATCH", r"^/admin/users/")] == []
    assert PpmForgejoAccount.objects.get(pk=first.pk).last_error_code == "FORGEJO_EMAIL_TAKEN"


def test_an_administrator_ppm_did_not_make_is_left_alone(api):
    user = person("ivan@example.test", display_name="Иван Петров")
    bound = api.add_user(
        "ivan",
        email="old@example.test",
        full_name="Старое имя",
        is_admin=True,
        source_id=SOURCE_ID,
        login_name=str(user.id),
        prohibit_login=True,
    )
    before = dict(bound)

    account = ensure_account_for_login(user)

    assert account.username == "ivan" and account.admin_granted is False
    assert api.calls("PATCH", r"^/admin/users/") == []
    assert dict(bound) == before
    run = PpmForgejoSyncRun.objects.get()
    assert run.status == "ok"
    assert run.problems[0]["level"] == "warning"
    assert "администратор Git-сервера, назначенный не PPM" in run.problems[0]["message"]


def test_the_token_owner_is_never_used_for_a_sign_in_whatever_its_name(api):
    api.bot["login"] = "svc-robot"  # the service account under another name: protected for what it is
    user = person("ivan@example.test")
    api.bot.update(source_id=SOURCE_ID, login_name=str(user.id))
    before = dict(api.bot)

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    assert caught.value.code == "FORGEJO_ACCOUNT_PROTECTED"
    assert "svc-robot" in caught.value.message
    assert api.writes() == []
    assert dict(api.bot) == before
    assert PpmForgejoAccount.objects.count() == 0


def test_name_collision_with_a_user_and_an_organization_gets_a_suffix(api):
    api.add_user("ivan", email="other-ivan@example.test")
    api.add_org("ivan-2")
    user = person("ivan@example.test")

    account = ensure_account_for_login(user)

    assert account.username == "ivan-3"
    assert api.user("ivan")["login_name"] == "" and api.user("ivan")["source_id"] == 0
    assert api.calls("PATCH", r"^/admin/users/ivan$") == []


@pytest.mark.parametrize(
    ("email", "expected"),
    [
        ("admin@example.test", "admin-2"),
        ("Ivan..Petrov+tag@example.test", "ivan.petrovtag"),
        ("-_.ivan._-@example.test", "ivan"),
        ("Élodie@example.test", "elodie"),
        ("иван@пример.рф", "person"),
        ("robots.txt@example.test", "robots.txt-2"),
        ("photo.png@example.test", "photo.png-2"),
        (f"{'a' * 45}@example.test", "a" * 39),
    ],
)
def test_username_follows_the_email_and_forgejo_rules(api, email, expected):
    user = person(email)

    account = ensure_account_for_login(user)

    assert account.username == expected
    assert len(account.username) <= 39


def test_long_name_keeps_the_suffix_within_39_characters(api):
    api.add_user("b" * 39, email="first@example.test")
    user = person(f"{'b' * 50}@example.test")

    account = ensure_account_for_login(user)

    assert account.username == "b" * 37 + "-2"


def test_profile_is_reconciled_but_the_name_never_changes(api):
    user = person("ivan@example.test", display_name="Иван")
    ensure_account_for_login(user)
    User.objects.filter(id=user.id).update(display_name="Иван Петров", email="ivan.petrov@example.test")
    user.refresh_from_db()

    account = ensure_account_for_login(user)

    remote = api.user("ivan")
    assert (remote["full_name"], remote["email"]) == ("Иван Петров", "ivan.petrov@example.test")
    assert account.username == "ivan"
    patch = api.calls("PATCH", r"^/admin/users/ivan$")[-1]["body"]
    assert patch == {
        "source_id": SOURCE_ID,
        "login_name": str(user.id),
        "full_name": "Иван Петров",
        "email": "ivan.petrov@example.test",
    }
    assert PpmGitAudit.objects.filter(action="forgejo.access.account_updated").count() == 1


def test_login_restores_a_prohibited_account_and_grants_admin(api):
    user = person("ivan@example.test")
    ensure_account_for_login(user)
    api.user("ivan")["prohibit_login"] = True
    PpmGlobalAdmin.objects.create(user=user, reason="test")

    account = ensure_account_for_login(user)

    remote = api.user("ivan")
    assert remote["prohibit_login"] is False and remote["is_admin"] is True
    assert account.prohibited is False and account.admin_granted is True
    actions = set(PpmGitAudit.objects.values_list("action", flat=True))
    assert {"forgejo.access.login_restored", "forgejo.access.admin_granted"} <= actions


@pytest.mark.parametrize(
    "state",
    [{"is_active": False}, {"is_bot": True}],
)
def test_only_active_people_get_an_account(api, state):
    user = person("ivan@example.test", **state)

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    assert caught.value.code == "FORGEJO_ACCOUNT_NOT_ALLOWED"
    assert api.requests == []


def test_person_without_email_gets_no_account(api):
    user = person("ivan@example.test")
    User.objects.filter(id=user.id).update(email=None)
    user.refresh_from_db()

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    assert caught.value.code == "FORGEJO_ACCOUNT_NOT_ALLOWED"
    assert api.requests == []


def test_without_sso_nothing_happens_and_new_tables_are_not_read(settings, django_assert_num_queries):
    for name, value in SSO_SETTINGS.items():
        setattr(settings, name, value)
    settings.PPM_GIT_SSO_ENABLED = False
    user = person("ivan@example.test")

    assert forgejo_sso_is_configured() is False
    with django_assert_num_queries(0):
        assert forgejo_username_for(user) is None
    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)
    assert caught.value.code == "FORGEJO_SSO_NOT_CONFIGURED"


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("PPM_GIT_SSO_ENABLED", "0"),
        ("PPM_FORGEJO_ADMIN_TOKEN", ""),
        ("PPM_FORGEJO_SSO_SOURCE_ID", 0),
        ("PPM_FORGEJO_SSO_SOURCE_ID", "abc"),
        ("PPM_FORGEJO_TOKEN", ""),
    ],
)
def test_configuration_needs_every_value(settings, name, value):
    for key, item in SSO_SETTINGS.items():
        setattr(settings, key, item)
    assert forgejo_sso_is_configured() is True
    setattr(settings, name, value)

    assert forgejo_sso_is_configured() is False


def test_configuration_accepts_environment_strings(settings):
    for key, item in SSO_SETTINGS.items():
        setattr(settings, key, item)
    settings.PPM_GIT_SSO_ENABLED = "1"
    settings.PPM_FORGEJO_SSO_SOURCE_ID = " 7 "

    assert forgejo_sso_is_configured() is True


def test_several_accounts_bound_to_one_person_keep_the_recorded_one(api):
    user = person("ivan@example.test")
    first = api.add_user("ivan", email="ivan@example.test", source_id=SOURCE_ID, login_name=str(user.id))
    api.add_user("ivan-copy", email="copy@example.test", source_id=SOURCE_ID, login_name=str(user.id))

    account = ensure_account_for_login(user)

    assert account.forgejo_user_id == first["id"]
    run = PpmForgejoSyncRun.objects.get()
    assert run.problems[0]["level"] == "warning"
    assert "несколько учёток" in run.problems[0]["message"]
    assert api.calls("PATCH", r"^/admin/users/ivan-copy$") == []


def test_account_deleted_on_the_git_server_comes_back_with_the_same_name(api):
    user = person("ivan@example.test")
    first = ensure_account_for_login(user)
    del api.accounts[first.forgejo_user_id]

    account = ensure_account_for_login(user)

    assert account.pk == first.pk and account.username == "ivan"
    assert account.forgejo_user_id != first.forgejo_user_id
    assert api.user("ivan")["login_name"] == str(user.id)


def test_rate_limited_login_is_refused_with_a_safe_code(api):
    user = person("ivan@example.test")
    api.inject("GET", r"^/admin/users$", FakeResponse(429, {"message": "slow"}, {"Retry-After": "30"}))

    with pytest.raises(ForgejoAccessError) as caught:
        ensure_account_for_login(user)

    assert caught.value.code == "GIT_PROVIDER_RATE_LIMITED"
    assert PpmForgejoAccount.objects.count() == 0
