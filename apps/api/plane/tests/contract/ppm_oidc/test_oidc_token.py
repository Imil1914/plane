"""G2.2 R3, R5, R9 — обмен кода на токены (token/), как его делает Forgejo 15.

Forgejo (x/oauth2) аутентифицируется ``client_secret_basic`` (при отказе — ``client_secret_post``), PKCE S256 шлёт
всегда, кроме первого входа после регистрации источника. До выдачи токенов PPM обеспечивает учётку человека на
Git-сервере (контракт линии S2): без учётки — ``server_error`` без подробностей, код причины — в журнале PPM.
"""

import logging
from datetime import timedelta

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.utils import timezone
from freezegun import freeze_time
from oauth2_provider.models import get_access_token_model, get_grant_model, get_id_token_model

from plane.ppm_oidc import login
from plane.tests.contract.ppm_oidc.conftest import (
    CLIENT_SECRET,
    REDIRECT_URI,
    authorize,
    code_from,
    exchange,
    make_person,
    pkce_pair,
    token_json,
)

pytestmark = pytest.mark.django_db


def _code(browser, **params):
    return code_from(authorize(browser, **params))


@pytest.mark.parametrize("auth", ["basic", "post"])
def test_code_is_exchanged_with_client_secret_basic_and_post(git_client, browser, person, forgejo_access, auth):
    response = exchange(_code(browser), auth=auth)

    assert response.status_code == 200, response.content
    assert response["Cache-Control"] == "no-store"
    body = token_json(response)
    assert body["token_type"] == "Bearer"
    assert body["expires_in"] == 300
    assert body["access_token"] and body["refresh_token"] and body["id_token"]
    assert set(body["scope"].split()) == {"openid", "profile", "email", "groups"}
    # Токены хранятся только как SHA-256 (RFC 9700): в дампе базы нет рабочего токена.
    stored = get_access_token_model().objects.get(user=person)
    assert stored.token == ""
    assert body["access_token"] not in (stored.token_checksum or "")


def test_pkce_is_verified_when_sent(git_client, browser, forgejo_access):
    verifier, challenge = pkce_pair()
    code = _code(browser, code_challenge=challenge, code_challenge_method="S256")
    assert exchange(code, verifier=verifier).status_code == 200


def test_wrong_pkce_verifier_is_refused(git_client, browser, forgejo_access):
    _verifier, challenge = pkce_pair()
    code = _code(browser, code_challenge=challenge, code_challenge_method="S256")
    response = exchange(code, verifier=pkce_pair()[0])
    assert response.status_code == 400
    assert token_json(response)["error"] == "invalid_grant"
    assert forgejo_access.calls == []


def test_missing_pkce_verifier_is_refused_when_a_challenge_was_sent(git_client, browser, forgejo_access):
    _verifier, challenge = pkce_pair()
    code = _code(browser, code_challenge=challenge, code_challenge_method="S256")
    response = exchange(code)
    assert response.status_code == 400
    assert token_json(response)["error"] in {"invalid_request", "invalid_grant"}
    assert forgejo_access.calls == []


def test_code_without_pkce_is_accepted(git_client, browser, forgejo_access):
    # Первый вход после регистрации источника Forgejo идёт без PKCE (research/forgejo-facts.md §4).
    assert exchange(_code(browser)).status_code == 200


def test_wrong_secret_and_unknown_client_are_refused(git_client, browser, forgejo_access):
    code = _code(browser)
    for response in (
        exchange(code, secret=CLIENT_SECRET[:-1] + "0"),
        exchange(code, auth="post", secret="x" * 48),
        exchange(code, client_id="someone-else"),
        exchange(code, auth="none"),
    ):
        assert response.status_code == 401, response.content
        body = token_json(response)
        assert body["error"] == "invalid_client"
        assert CLIENT_SECRET not in response.content.decode()
    assert forgejo_access.calls == []
    # Код не потрачен неудачными попытками клиента.
    assert exchange(code).status_code == 200


def test_other_application_cannot_use_the_token_endpoint(git_client, browser, forgejo_access):
    from oauth2_provider.models import get_application_model

    get_application_model().objects.create(
        client_id="other-client",
        client_secret="other-secret-" + "0" * 40,
        client_type="confidential",
        authorization_grant_type="authorization-code",
        redirect_uris=REDIRECT_URI,
        algorithm="RS256",
        name="other",
    )
    response = exchange(_code(browser), client_id="other-client", secret="other-secret-" + "0" * 40)
    assert response.status_code == 401
    assert token_json(response)["error"] == "invalid_client"


def test_redirect_uri_must_match(git_client, browser, forgejo_access):
    response = exchange(_code(browser), redirect_uri="https://evil.example.test/cb")
    assert response.status_code == 400
    assert token_json(response)["error"] in {"invalid_request", "invalid_grant"}
    assert forgejo_access.calls == []


def test_code_is_single_use(git_client, browser, forgejo_access):
    code = _code(browser)
    assert exchange(code).status_code == 200
    replay = exchange(code)
    assert replay.status_code == 400
    assert token_json(replay)["error"] == "invalid_grant"


def test_code_lives_sixty_seconds(git_client, browser, forgejo_access):
    code = _code(browser)
    with freeze_time(timezone.now() + timedelta(seconds=61)):
        response = exchange(code)
    assert response.status_code == 400
    assert token_json(response)["error"] == "invalid_grant"


@pytest.mark.parametrize(
    "grant_type, extra",
    [
        ("password", {"username": "a@b.c", "password": "x"}),
        ("client_credentials", {}),
        ("urn:ietf:params:oauth:grant-type:device_code", {}),
        ("implicit", {}),
        ("", {}),
    ],
)
def test_other_grant_types_are_unsupported(git_client, grant_type, extra):
    response = exchange("x", grant_type=grant_type, extra=extra)
    assert response.status_code == 400
    assert token_json(response)["error"] == "unsupported_grant_type"


def test_git_server_account_is_ensured_before_any_token_is_issued(git_client, browser, person, forgejo_access):
    assert exchange(_code(browser)).status_code == 200
    assert forgejo_access.calls[0] == ("ensure", person.id, 0)
    assert forgejo_access.calls[1] == ("apply", person.id, login.ACCESS_BUDGET_SECONDS, 0)
    assert len(forgejo_access.calls) == 2


def test_account_failure_refuses_the_sign_in_with_server_error_only(
    git_client, browser, person, forgejo_access, caplog
):
    forgejo_access.ensure_error = forgejo_access.ForgejoAccessError(
        "FORGEJO_UNAVAILABLE", "Forgejo не отвечает: секрет"
    )
    code = _code(browser)
    with caplog.at_level(logging.INFO):
        response = exchange(code)

    assert response.status_code == 500
    assert token_json(response) == {"error": "server_error"}
    assert "FORGEJO_UNAVAILABLE" in caplog.text
    assert "секрет" not in caplog.text
    assert not get_access_token_model().objects.filter(user=person).exists()
    assert not get_id_token_model().objects.filter(user=person).exists()
    # Отклонённый код больше не работает.
    forgejo_access.ensure_error = None
    assert token_json(exchange(code))["error"] == "invalid_grant"


def test_unexpected_account_error_is_a_server_error_too(git_client, browser, forgejo_access, caplog):
    forgejo_access.ensure_error = RuntimeError("boom with token=abc")
    with caplog.at_level(logging.INFO):
        response = exchange(_code(browser))
    assert response.status_code == 500
    assert token_json(response) == {"error": "server_error"}
    assert login.ACCOUNT_FAILED in caplog.text
    assert "token=abc" not in caplog.text


def test_missing_access_module_refuses_the_sign_in(git_client, browser, monkeypatch, caplog):
    def missing():
        raise ModuleNotFoundError("No module named 'plane.ppm_git.forgejo_access'")

    monkeypatch.setattr("plane.ppm_oidc.login.load_access_module", missing)
    with caplog.at_level(logging.INFO):
        response = exchange(_code(browser))
    assert response.status_code == 500
    assert token_json(response) == {"error": "server_error"}
    assert login.ACCESS_MODULE_MISSING in caplog.text


def test_unconfigured_access_module_refuses_the_sign_in(git_client, browser, forgejo_access, caplog):
    forgejo_access.configured = False
    with caplog.at_level(logging.INFO):
        response = exchange(_code(browser))
    assert response.status_code == 500
    assert login.ACCESS_NOT_CONFIGURED in caplog.text
    assert [call[0] for call in forgejo_access.calls] == []


def test_access_not_applied_in_time_does_not_block_the_sign_in(git_client, browser, forgejo_access):
    forgejo_access.apply_result = False
    assert exchange(_code(browser)).status_code == 200


def test_access_error_does_not_block_the_sign_in_and_is_left_to_the_sync(git_client, browser, person, forgejo_access):
    forgejo_access.apply_error = forgejo_access.ForgejoAccessError("FORGEJO_TIMEOUT", "slow")
    assert exchange(_code(browser)).status_code == 200
    assert ("schedule", (person.id,)) in forgejo_access.calls


def test_person_switched_off_after_authorization_gets_no_tokens(git_client, browser, person, forgejo_access):
    code = _code(browser)
    # Массовое отключение без сигналов (как исключение из пространства).
    type(person).objects.filter(pk=person.pk).update(is_active=False)
    response = exchange(code)
    assert response.status_code == 400
    assert token_json(response)["error"] == "invalid_grant"
    assert forgejo_access.calls == []
    assert not get_grant_model().objects.filter(code=code).exists()


def test_bot_code_cannot_be_exchanged(git_client, forgejo_access):
    bot = make_person("robot", is_bot=True)
    grant_model = get_grant_model()
    grant = grant_model.objects.create(
        user=bot,
        application=git_client,
        code="bot-code-" + "x" * 30,
        expires=timezone.now() + timedelta(seconds=60),
        redirect_uri=REDIRECT_URI,
        scope="openid profile email groups",
    )
    response = exchange(grant.code)
    assert response.status_code == 400
    assert token_json(response)["error"] == "invalid_grant"
    assert forgejo_access.calls == []


def test_refresh_token_works_for_an_active_person_only(git_client, browser, person, forgejo_access):
    tokens = token_json(exchange(_code(browser)))
    refreshed = exchange(
        None, grant_type="refresh_token", redirect_uri=None, extra={"refresh_token": tokens["refresh_token"]}
    )
    assert refreshed.status_code == 200, refreshed.content
    new_tokens = token_json(refreshed)

    type(person).objects.filter(pk=person.pk).update(is_active=False)
    refused = exchange(
        None, grant_type="refresh_token", redirect_uri=None, extra={"refresh_token": new_tokens["refresh_token"]}
    )
    assert refused.status_code == 400
    assert token_json(refused)["error"] == "invalid_grant"


def test_token_request_parameters_are_hidden_from_error_reports(git_client, browser, forgejo_access):
    response = exchange(_code(browser), auth="post")
    assert response.status_code == 200
    hidden = set(response.wsgi_request.sensitive_post_parameters)
    assert {"code", "code_verifier", "refresh_token", "client_secret"} <= hidden


def test_token_endpoint_never_runs_the_slow_password_hasher(git_client, browser, forgejo_access, monkeypatch):
    # Секрет клиента — случайные 192 бита: быстрый солёный HMAC вместо PBKDF2 (≈0,3 с CPU на каждую проверку).
    from django.contrib.auth.hashers import PBKDF2PasswordHasher

    def slow_hasher_called(*args, **kwargs):
        raise AssertionError("PBKDF2 must not run on /auth/oidc/token/")

    code = _code(browser)
    monkeypatch.setattr(PBKDF2PasswordHasher, "encode", slow_hasher_called)
    monkeypatch.setattr(PBKDF2PasswordHasher, "verify", slow_hasher_called)
    assert exchange(code, secret="0" * 48).status_code == 401
    assert exchange(code, auth="post", secret="1" * 48).status_code == 401
    assert exchange("made-up-code").status_code == 400
    assert exchange(code).status_code == 200
