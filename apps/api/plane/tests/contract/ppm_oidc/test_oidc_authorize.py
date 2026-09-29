"""G2.2 R3, R5, R6 — точка authorize/.

С сессией PPM человек получает код сразу, без экрана согласия (Git-сервер — доверенный клиент). Без сессии запрос
сохраняется, а человек уходит на вход PPM с ``next_path=/auth/oidc/continue/<id>/``. Чужой клиент и чужой redirect
URI — страница ошибки без перенаправления (иначе точка стала бы открытым редиректором). Боты и люди без почты —
``access_denied`` на callback Forgejo.
"""

from urllib.parse import parse_qs, urlsplit

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.test import Client
from oauth2_provider.models import get_application_model, get_grant_model

from plane.ppm_oidc import continuation
from plane.tests.contract.ppm_oidc.conftest import (
    CLIENT_ID,
    REDIRECT_URI,
    WEB_URL,
    authorize,
    code_from,
    make_person,
    pkce_pair,
    redirect_params,
)
from plane.utils.path_validator import get_safe_redirect_url, validate_next_path

pytestmark = pytest.mark.django_db


def _sign_in_redirect_id(response):
    """``/?next_path=/auth/oidc/continue/<id>/`` на вход PPM → ``<id>``."""
    assert response.status_code == 302, response.content[:300]
    location = urlsplit(response["Location"])
    assert f"{location.scheme}://{location.netloc}" == WEB_URL
    assert location.path == "/"
    params = parse_qs(location.query)
    assert list(params) == ["next_path"]
    next_path = params["next_path"][0]
    assert next_path.startswith("/auth/oidc/continue/") and next_path.endswith("/")
    return next_path[len("/auth/oidc/continue/") : -1]


def test_signed_in_person_gets_a_code_at_once(git_client, browser, person):
    response = authorize(browser, state="state-123")

    params = redirect_params(response)
    assert params["state"] == "state-123"
    assert params["code"]
    assert "iss" not in params
    grant = get_grant_model().objects.get(code=params["code"])
    assert grant.user_id == person.id
    assert grant.application.client_id == CLIENT_ID
    assert (grant.expires - grant.created).total_seconds() == pytest.approx(60, abs=2)


def test_code_carries_the_pkce_challenge_when_sent(git_client, browser):
    _verifier, challenge = pkce_pair()
    code = code_from(authorize(browser, code_challenge=challenge, code_challenge_method="S256"))
    grant = get_grant_model().objects.get(code=code)
    assert grant.code_challenge == challenge
    assert grant.code_challenge_method == "S256"


def test_plain_pkce_is_refused(git_client, browser):
    params = redirect_params(authorize(browser, code_challenge="a" * 43, code_challenge_method="plain"))
    assert params["error"] == "invalid_request"
    assert not get_grant_model().objects.exists()


def test_anonymous_request_is_kept_and_the_person_is_sent_to_the_ppm_sign_in(git_client):
    anonymous = Client()
    response = authorize(anonymous, state="keep-me")

    continue_id = _sign_in_redirect_id(response)
    assert continuation.is_well_formed(continue_id)
    # Штатная проверка next_path пропускает путь продолжения как есть.
    assert validate_next_path(continuation.continue_path(continue_id)) == continuation.continue_path(continue_id)
    cookie = response.cookies[continuation.BINDING_COOKIE]
    assert cookie["httponly"] is True
    assert cookie["path"] == "/auth/oidc/"
    assert cookie["samesite"] == "Lax"
    assert int(cookie["max-age"]) == 600
    entry = continuation.load(continue_id, cookie.value)
    assert "state=keep-me" in entry["query"]
    assert not get_grant_model().objects.exists()


def test_sign_in_goes_to_the_web_app_origin_when_it_is_separate(git_client, settings):
    settings.APP_BASE_URL = "https://app.example.test"
    response = authorize(Client())
    assert response.status_code == 302
    location = urlsplit(response["Location"])
    assert f"{location.scheme}://{location.netloc}" == "https://app.example.test"
    assert parse_qs(location.query)["next_path"][0].startswith("/auth/oidc/continue/")


def test_every_continue_id_passes_the_standard_next_path_check(settings):
    settings.WEB_URL = WEB_URL
    settings.APP_BASE_URL = None
    for _ in range(300):
        continue_id = continuation.remember("client_id=forgejo", continuation.new_binding())
        path = continuation.continue_path(continue_id)
        assert validate_next_path(path) == path
        assert get_safe_redirect_url(WEB_URL, path) == f"{WEB_URL}/?next_path={path}"


def test_two_git_server_tabs_in_one_browser_share_the_binding(git_client):
    anonymous = Client()
    first = _sign_in_redirect_id(authorize(anonymous, state="one"))
    second = _sign_in_redirect_id(authorize(anonymous, state="two"))
    binding = anonymous.cookies[continuation.BINDING_COOKIE].value
    assert continuation.load(first, binding) is not None
    assert continuation.load(second, binding) is not None


def test_unknown_client_gets_an_error_page_and_no_redirect(git_client):
    for client in (Client(), None):
        if client is None:
            client = Client()
            client.force_login(make_person("bob"))
        response = authorize(client, client_id="someone-else")
        assert response.status_code == 400
        assert "Location" not in response
        body = response.content.decode()
        assert "invalid_client" in body or "invalid_request" in body
        assert "Не удалось выполнить вход через PPM" in body


def test_other_application_in_the_table_is_refused(git_client, browser):
    get_application_model().objects.create(
        client_id="other-client",
        client_type="confidential",
        authorization_grant_type="authorization-code",
        redirect_uris="https://evil.example.test/cb",
        algorithm="RS256",
        skip_authorization=True,
        name="other",
    )
    response = authorize(browser, client_id="other-client", redirect_uri="https://evil.example.test/cb")
    assert response.status_code == 400
    assert "evil.example.test" not in response.get("Location", "")
    assert not get_grant_model().objects.exists()


@pytest.mark.parametrize(
    "redirect_uri",
    [
        "https://evil.example.test/user/oauth2/PPM/callback",
        f"{REDIRECT_URI}/../../evil",
        f"{REDIRECT_URI}?next=https://evil.example.test",
        "https://git.example.test/user/oauth2/Other/callback",
    ],
)
def test_foreign_redirect_uri_gets_an_error_page_and_no_redirect(git_client, browser, redirect_uri):
    for client in (browser, Client()):
        response = authorize(client, redirect_uri=redirect_uri)
        assert response.status_code == 400
        assert "Location" not in response
    assert not get_grant_model().objects.exists()


def test_bot_gets_access_denied(git_client):
    bot = make_person("bot", is_bot=True)
    client = Client()
    client.force_login(bot)
    params = redirect_params(authorize(client, state="bot-state"))
    assert params == {"error": "access_denied", "state": "bot-state"}
    assert not get_grant_model().objects.exists()


def test_person_without_email_gets_access_denied(git_client):
    nobody = make_person("noemail")
    type(nobody).objects.filter(pk=nobody.pk).update(email="")
    client = Client()
    client.force_login(nobody)
    params = redirect_params(authorize(client, state="s"))
    assert params["error"] == "access_denied"


def test_inactive_person_is_treated_as_signed_out(git_client):
    inactive = make_person("inactive")
    client = Client()
    client.force_login(inactive)
    type(inactive).objects.filter(pk=inactive.pk).update(is_active=False)
    response = authorize(client)
    _sign_in_redirect_id(response)
    assert not get_grant_model().objects.exists()


def test_prompt_none_without_session_answers_login_required(git_client):
    params = redirect_params(authorize(Client(), prompt="none", state="silent"))
    assert params == {"error": "login_required", "state": "silent"}


def test_prompt_none_with_session_issues_a_code(git_client, browser):
    assert code_from(authorize(browser, prompt="none"))


@pytest.mark.parametrize("signed_in", [True, False])
def test_prompt_login_answers_login_required_without_a_loop(git_client, browser, signed_in):
    client = browser if signed_in else Client()
    params = redirect_params(authorize(client, prompt="login", state="again"))
    assert params == {"error": "login_required", "state": "again"}


def test_authorize_accepts_only_get(git_client, browser):
    assert browser.post("/auth/oidc/authorize/", {"client_id": CLIENT_ID}).status_code == 405
