"""G2.2 R5, R7 и выключатель — защита провайдера.

- ``PPM_GIT_SSO_ENABLED`` ≠ 1 (или неполная настройка) — все точки ``/auth/oidc/*`` отвечают 404;
- по адресу клиента (последний элемент X-Forwarded-For) ограничены continue/ и authorize/, а на token/ считаются
  только неудачные аутентификации клиента (``invalid_client``); выключатель — важнее;
- коды, токены, секрет клиента и ключ подписи не попадают в журналы (весь поток — под caplog на DEBUG);
- отключение пользователя удаляет его токены и гранты; просроченные токены удаляет ежедневная задача.
"""

import base64
import logging
from datetime import timedelta
from urllib.parse import urlencode

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.test import Client
from django.utils import timezone
from oauth2_provider.models import (
    get_access_token_model,
    get_grant_model,
    get_id_token_model,
    get_refresh_token_model,
)

from plane.ppm_oidc.tasks import clear_expired_oidc_tokens
from plane.tests.contract.ppm_oidc.conftest import (
    CLIENT_SECRET,
    REDIRECT_URI,
    authorize,
    code_from,
    exchange,
    make_person,
    sign_in_to_git_server,
    token_json,
)

pytestmark = pytest.mark.django_db

ALL_ENDPOINTS = [
    ("get", "/auth/oidc/.well-known/openid-configuration"),
    ("get", "/auth/oidc/internal/.well-known/openid-configuration"),
    ("get", "/auth/oidc/jwks/"),
    ("get", "/auth/oidc/authorize/?client_id=forgejo&response_type=code"),
    ("post", "/auth/oidc/token/"),
    ("get", "/auth/oidc/userinfo/"),
    ("get", "/auth/oidc/continue/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/"),
]


@pytest.mark.parametrize("method, path", ALL_ENDPOINTS)
def test_switch_off_answers_404_everywhere(git_client, settings, method, path):
    settings.PPM_GIT_SSO_ENABLED = False
    client = Client()
    client.force_login(make_person("switch"))
    assert getattr(client, method)(path).status_code == 404


@pytest.mark.parametrize("missing", ["PPM_OIDC_PRIVATE_KEY", "PPM_OIDC_CLIENT_SECRET", "PPM_OIDC_FORGEJO_REDIRECT_URI"])
def test_incomplete_configuration_answers_404_and_names_the_setting(git_client, settings, missing, caplog):
    from plane.ppm_oidc import state

    setattr(settings, missing, "")
    state._reported_problems = None
    with caplog.at_level(logging.WARNING):
        assert Client().get("/auth/oidc/.well-known/openid-configuration").status_code == 404
        assert Client().get("/auth/oidc/jwks/").status_code == 404
    assert missing in caplog.text
    assert "BEGIN" not in caplog.text
    assert CLIENT_SECRET not in caplog.text


def test_made_up_codes_through_the_git_server_do_not_block_real_sign_ins(git_client, browser, settings, forgejo_access):
    # Любой может заставить Forgejo обменять выдуманный код (его callback открыт): все такие обмены приходят с адреса
    # самого Git-сервера с верным секретом — считать их значило бы дать постороннему выключить вход всей организации.
    settings.PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT = "3/minute"
    for number in range(20):
        response = exchange(f"made-up-code-{number}")
        assert response.status_code == 400
        assert token_json(response)["error"] == "invalid_grant"
    assert exchange(code_from(authorize(browser))).status_code == 200


def test_wrong_client_secret_is_throttled_after_the_threshold(git_client, browser, settings, forgejo_access):
    settings.PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT = "3/minute"
    code = code_from(authorize(browser))
    for _ in range(3):
        assert exchange(code, secret="0" * 48).status_code == 401
    limited = exchange(code, secret="0" * 48)
    assert limited.status_code == 429
    assert token_json(limited)["error"] == "temporarily_unavailable"
    assert 1 <= int(limited["Retry-After"]) <= 61
    # Пока адрес ждёт, секрет не проверяется вовсе — и верный тоже.
    assert exchange(code).status_code == 429
    # Другой адрес считается отдельно; код не потрачен.
    assert exchange(code, remote_addr="172.20.0.77").status_code == 200


def test_unknown_client_and_missing_authentication_count_as_failures(git_client, settings):
    settings.PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT = "2/minute"
    assert exchange("x", client_id="someone-else").status_code == 401
    assert exchange("x", auth="none").status_code == 401
    assert exchange("x").status_code == 429


def test_spoofed_forwarded_for_does_not_escape_the_count(git_client, settings, forgejo_access):
    # Ключ — последний элемент X-Forwarded-For (его дописал прокси перед PPM), а не первый, который пишет клиент.
    settings.PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT = "2/minute"
    for spoofed in ("1.1.1.1", "2.2.2.2"):
        assert exchange("x", secret="0" * 48, forwarded_for=f"{spoofed}, 203.0.113.7").status_code == 401
    assert exchange("x", secret="0" * 48, forwarded_for="3.3.3.3, 203.0.113.7").status_code == 429
    # Настоящий другой клиент за тем же прокси — отдельный счёт.
    assert exchange("x", secret="0" * 48, forwarded_for="1.1.1.1, 203.0.113.8").status_code == 401


def test_forwarded_for_rules_of_the_client_address():
    from django.test import RequestFactory

    from plane.ppm_oidc.throttling import client_address

    factory = RequestFactory()
    assert client_address(factory.get("/", REMOTE_ADDR="10.0.0.2")) == "10.0.0.2"
    assert client_address(factory.get("/", REMOTE_ADDR="10.0.0.2", HTTP_X_FORWARDED_FOR="9.9.9.9")) == "9.9.9.9"
    request = factory.get("/", REMOTE_ADDR="10.0.0.2", HTTP_X_FORWARDED_FOR="6.6.6.6, 198.51.100.4 ")
    assert client_address(request) == "198.51.100.4"
    # Мусор в заголовке — адрес соединения.
    assert client_address(factory.get("/", REMOTE_ADDR="10.0.0.2", HTTP_X_FORWARDED_FOR="x, not-an-ip")) == "10.0.0.2"
    assert client_address(factory.get("/", REMOTE_ADDR="10.0.0.2", HTTP_X_FORWARDED_FOR=" ")) == "10.0.0.2"


@pytest.mark.parametrize(
    "setting_name",
    ["PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT", "PPM_OIDC_CONTINUE_RATE_LIMIT", "PPM_OIDC_AUTHORIZE_RATE_LIMIT"],
)
def test_invalid_rate_setting_falls_back_to_the_default(git_client, browser, settings, forgejo_access, setting_name):
    setattr(settings, setting_name, "lots")
    assert exchange(code_from(authorize(browser))).status_code == 200
    assert Client().get("/auth/oidc/continue/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/").status_code == 410
    assert exchange("x", secret="0" * 48).status_code == 401


def test_continue_rate_is_limited(git_client, settings):
    settings.PPM_OIDC_CONTINUE_RATE_LIMIT = "2/minute"
    client = Client()
    for _ in range(2):
        assert client.get("/auth/oidc/continue/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/").status_code == 410
    limited = client.get("/auth/oidc/continue/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/")
    assert limited.status_code == 429
    assert "Слишком много попыток" in limited.content.decode()


def test_anonymous_authorize_rate_is_limited(git_client, settings):
    settings.PPM_OIDC_AUTHORIZE_RATE_LIMIT = "2/minute"
    client = Client()
    for _ in range(2):
        assert authorize(client).status_code == 302
    assert authorize(client).status_code == 429


def test_signed_in_authorize_rate_is_limited_too(git_client, browser, settings):
    # С сессией каждый запрос пишет код в базу.
    settings.PPM_OIDC_AUTHORIZE_RATE_LIMIT = "2/minute"
    for _ in range(2):
        code_from(authorize(browser))
    assert authorize(browser).status_code == 429
    assert get_grant_model().objects.count() == 2


def test_switch_off_wins_over_the_rate_limit(git_client, settings):
    settings.PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT = "1/minute"
    exchange("nope", secret="0" * 48)
    assert exchange("nope").status_code == 429
    settings.PPM_GIT_SSO_ENABLED = False
    assert exchange("nope").status_code == 404


def test_git_server_posts_without_csrf_token(git_client, browser, forgejo_access):
    # Forgejo — сервер, у него нет ни cookie сессии, ни CSRF-токена PPM.
    code = code_from(authorize(browser))
    strict = Client(enforce_csrf_checks=True)
    response = strict.post(
        "/auth/oidc/token/",
        urlencode({"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI}),
        content_type="application/x-www-form-urlencoded",
        HTTP_AUTHORIZATION="Basic " + base64.b64encode(f"forgejo:{CLIENT_SECRET}".encode()).decode(),
    )
    assert response.status_code == 200, response.content
    access_token = token_json(response)["access_token"]
    userinfo = strict.post("/auth/oidc/userinfo/", HTTP_AUTHORIZATION=f"Bearer {access_token}")
    assert userinfo.status_code == 200, userinfo.content


def test_library_loggers_are_held_at_warning():
    for name in ("oauth2_provider", "oauthlib", "oauthlib.oauth2.rfc6749.grant_types.authorization_code"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING, name


def test_secrets_never_reach_the_logs(git_client, browser, forgejo_access, signing_keys, caplog):
    caplog.set_level(logging.DEBUG)
    code = code_from(authorize(browser))
    tokens = token_json(exchange(code))
    Client().get("/auth/oidc/userinfo/", HTTP_AUTHORIZATION=f"Bearer {tokens['access_token']}")
    exchange(code)  # повтор кода
    exchange(code_from(authorize(browser)), secret="wrong-" + CLIENT_SECRET)
    anonymous = Client()
    next_path = authorize(anonymous)["Location"].split("next_path=", 1)[1]
    anonymous.get(next_path)

    secrets_seen = [
        code,
        tokens["access_token"],
        tokens["refresh_token"],
        tokens["id_token"],
        CLIENT_SECRET,
        next_path.rstrip("/").rsplit("/", 1)[1],
        signing_keys["current"].splitlines()[1],
    ]
    for record in caplog.records:
        text = f"{record.getMessage()} {record.__dict__}"
        for secret in secrets_seen:
            assert secret not in text, (record.name, record.levelname)
    # Журнал запросов при этом был: пути без query, id продолжения замаскирован.
    request_paths = [record.getMessage() for record in caplog.records if record.name == "plane.api.request"]
    assert any("/auth/oidc/token/" in line for line in request_paths), request_paths
    assert any("/auth/oidc/continue/[redacted]/" in line for line in request_paths), request_paths


def test_switching_a_person_off_deletes_their_git_server_tokens(git_client, browser, person, forgejo_access):
    sign_in_to_git_server(browser)
    code_from(authorize(browser))  # ещё не обменянный код
    other_client = Client()
    other = make_person("other")
    other_client.force_login(other)
    sign_in_to_git_server(other_client)

    person.is_active = False
    person.save()

    for model in (get_access_token_model(), get_refresh_token_model(), get_id_token_model(), get_grant_model()):
        assert not model.objects.filter(user=person).exists(), model.__name__
    assert get_access_token_model().objects.filter(user=other).exists()


def test_tokens_stay_when_single_sign_on_is_off(git_client, browser, person, forgejo_access, settings):
    sign_in_to_git_server(browser)
    settings.PPM_GIT_SSO_ENABLED = False
    person.is_active = False
    person.save()
    assert get_access_token_model().objects.filter(user=person).exists()


def test_daily_task_removes_expired_codes_and_tokens(git_client, browser, person, forgejo_access):
    sign_in_to_git_server(browser)
    live_code = code_from(authorize(browser))
    expired_code = code_from(authorize(browser))
    get_grant_model().objects.filter(code=expired_code).update(expires=timezone.now() - timedelta(minutes=1))
    get_access_token_model().objects.filter(user=person).update(expires=timezone.now() - timedelta(hours=2))

    assert clear_expired_oidc_tokens() == "cleared"

    assert get_grant_model().objects.filter(code=live_code).exists()
    assert not get_grant_model().objects.filter(code=expired_code).exists()
    assert not get_refresh_token_model().objects.filter(user=person).exists()
    assert not get_access_token_model().objects.filter(user=person).exists()
