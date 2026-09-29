"""G2.2 S1 — общий стенд тестов OpenID Connect-провайдера PPM.

Провайдер настроен так, как его настраивает комплект: ключ подписи RS256 (и прежний — для ротации), единственный клиент
«forgejo», созданный командой ``ppm_oidc_client --ensure``, redirect URI Forgejo-источника «PPM». Модуль доступов
линии S2 (``plane.ppm_git.forgejo_access``) подменён поддельным по контракту плана — он записывает вызовы и то, были ли
уже выданы токены в момент вызова.
"""

import base64
import hashlib
import importlib.util
import io
import json
import secrets
import uuid
from urllib.parse import parse_qs, quote_plus, urlencode, urlsplit

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.core.cache import cache
from django.core.management import call_command
from django.test import Client

from plane.ppm_oidc import conf
from plane.tests.factories import UserFactory

WEB_URL = "https://ppm.example.test"
ISSUER = f"{WEB_URL}/auth/oidc"
GIT_URL = "https://git.example.test"
REDIRECT_URI = f"{GIT_URL}/user/oauth2/PPM/callback"
INTERNAL_URL = "http://api:8000"
CLIENT_ID = "forgejo"
CLIENT_SECRET = "5f1c0e7a9b3d4c2e8a6f0b1d3c5e7a9b2d4f6a8c0e1b3d5f"  # 48 hex, как генерирует комплект
SCOPE = "openid profile email groups"
# Модули тестов, которым нужна сама библиотека, пропускаются без неё (pytest.importorskip) — как в dev-образе владельца.
LIBRARY_INSTALLED = all(importlib.util.find_spec(name) for name in ("oauth2_provider", "jwcrypto", "oauthlib"))


def _rsa_pem(bits):
    key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("utf-8")


@pytest.fixture(scope="session")
def signing_keys():
    return {"current": _rsa_pem(2048), "previous": _rsa_pem(2048)}


@pytest.fixture(autouse=True)
def clean_oidc_cache():
    """Счётчики частоты и записи продолжения входа живут в кэше — каждый тест начинает с чистого листа."""
    cache.delete_pattern("*ppm_oidc*")
    yield
    cache.delete_pattern("*ppm_oidc*")


@pytest.fixture
def oidc_settings(settings, signing_keys):
    settings.WEB_URL = WEB_URL
    # Как в комплекте: web и API на одном адресе (APP_BASE_URL не задан — вход PPM на WEB_URL).
    settings.APP_BASE_URL = None
    settings.PPM_GIT_SSO_ENABLED = True
    settings.PPM_OIDC_CLIENT_ID = CLIENT_ID
    settings.PPM_OIDC_CLIENT_SECRET = CLIENT_SECRET
    settings.PPM_OIDC_PRIVATE_KEY = signing_keys["current"]
    settings.PPM_OIDC_PREVIOUS_PRIVATE_KEY = signing_keys["previous"]
    settings.PPM_OIDC_INTERNAL_URL = INTERNAL_URL
    settings.PPM_FORGEJO_PUBLIC_URL = GIT_URL
    settings.PPM_OIDC_FORGEJO_REDIRECT_URI = REDIRECT_URI
    settings.PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT = "1000/minute"
    settings.PPM_OIDC_CONTINUE_RATE_LIMIT = "1000/minute"
    settings.PPM_OIDC_AUTHORIZE_RATE_LIMIT = "1000/minute"
    settings.OAUTH2_PROVIDER = conf.oauth2_provider_settings(
        issuer=ISSUER,
        private_key=signing_keys["current"],
        previous_private_key=signing_keys["previous"],
    )
    return settings


class FakeForgejoAccess:
    """Контракт ``plane.ppm_git.forgejo_access`` (план G2.2) — без сети и без Forgejo."""

    class ForgejoAccessError(Exception):
        def __init__(self, code, message):
            super().__init__(message)
            self.code = code
            self.message = message

    def __init__(self):
        self.configured = True
        self.calls = []
        self.ensure_error = None
        self.apply_error = None
        self.apply_result = True
        self.usernames = {}

    def _tokens_of(self, user):
        from oauth2_provider.models import get_access_token_model, get_id_token_model

        return (
            get_access_token_model().objects.filter(user=user).count()
            + get_id_token_model().objects.filter(user=user).count()
        )

    def forgejo_sso_is_configured(self):
        return self.configured

    def ensure_account_for_login(self, user):
        self.calls.append(("ensure", user.id, self._tokens_of(user)))
        if self.ensure_error:
            raise self.ensure_error
        self.usernames.setdefault(user.id, user.email.split("@")[0])
        return object()

    def apply_user_access(self, user, *, budget_seconds=5.0):
        self.calls.append(("apply", user.id, budget_seconds, self._tokens_of(user)))
        if self.apply_error:
            raise self.apply_error
        return self.apply_result

    def forgejo_username_for(self, user):
        return self.usernames.get(user.id)

    def schedule_access_sync(self, *, user_ids=(), project_ids=(), workspace_ids=(), full=False):
        self.calls.append(("schedule", tuple(user_ids)))


@pytest.fixture
def forgejo_access(monkeypatch):
    fake = FakeForgejoAccess()
    monkeypatch.setattr("plane.ppm_oidc.login.load_access_module", lambda: fake)
    return fake


@pytest.fixture
def git_client(db, oidc_settings, forgejo_access):
    """Клиент «forgejo» — ровно так, как его заводит ``git-bootstrap`` комплекта."""
    from oauth2_provider.models import get_application_model

    call_command("ppm_oidc_client", "--ensure", stdout=io.StringIO(), stderr=io.StringIO())
    return get_application_model().objects.get(client_id=CLIENT_ID)


def make_person(prefix="person", **fields):
    marker = uuid.uuid4().hex[:10]
    return UserFactory(email=f"{prefix}-{marker}@ppm.test", username=f"{prefix}-{marker}", **fields)


@pytest.fixture
def person(db):
    return make_person("alice", display_name="Алиса Петрова", is_email_verified=True)


@pytest.fixture
def browser(person):
    """Браузер человека, уже вошедшего в PPM."""
    client = Client()
    client.force_login(person)
    return client


def pkce_pair():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
    return verifier, challenge


def authorize_query(**overrides):
    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPE,
        "state": f"st-{uuid.uuid4().hex}",
    }
    params.update(overrides)
    return urlencode({key: value for key, value in params.items() if value is not None})


def authorize(client, **overrides):
    return client.get(f"/auth/oidc/authorize/?{authorize_query(**overrides)}")


def redirect_params(response):
    """Параметры перенаправления на callback Forgejo (адрес обязан быть зарегистрированным redirect URI)."""
    assert response.status_code == 302, response.content[:500]
    location = urlsplit(response["Location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == REDIRECT_URI
    return {key: values[0] for key, values in parse_qs(location.query).items()}


def code_from(response):
    params = redirect_params(response)
    assert "error" not in params, params
    return params["code"]


def exchange(
    code,
    *,
    verifier=None,
    auth="basic",
    client_id=CLIENT_ID,
    secret=CLIENT_SECRET,
    redirect_uri=REDIRECT_URI,
    grant_type="authorization_code",
    remote_addr="172.20.0.9",
    forwarded_for=None,
    extra=None,
):
    """Обмен кода так, как его делает Forgejo (x/oauth2): form-urlencoded, client_secret_basic с QueryEscape."""
    data = {"grant_type": grant_type, "code": code, "redirect_uri": redirect_uri}
    if verifier:
        data["code_verifier"] = verifier
    headers = {"REMOTE_ADDR": remote_addr}
    if forwarded_for:
        headers["HTTP_X_FORWARDED_FOR"] = forwarded_for
    if auth == "basic":
        credentials = f"{quote_plus(client_id)}:{quote_plus(secret)}".encode("utf-8")
        headers["HTTP_AUTHORIZATION"] = f"Basic {base64.b64encode(credentials).decode('ascii')}"
    elif auth == "post":
        data.update(client_id=client_id, client_secret=secret)
    data.update(extra or {})
    return Client().post(
        "/auth/oidc/token/",
        urlencode({key: value for key, value in data.items() if value is not None}),
        content_type="application/x-www-form-urlencoded",
        **headers,
    )


def token_json(response):
    assert response["Content-Type"].startswith("application/json"), response["Content-Type"]
    return json.loads(response.content)


def sign_in_to_git_server(browser_client, **overrides):
    """Полный вход: authorize с сессией PPM → код → обмен (basic). Возвращает JSON ответа token/."""
    code = code_from(authorize(browser_client, **overrides))
    response = exchange(code)
    assert response.status_code == 200, response.content
    return token_json(response)
