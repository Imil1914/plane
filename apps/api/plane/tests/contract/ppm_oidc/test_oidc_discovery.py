"""G2.2 R2 — публичный и внутренний discovery, JWKS (текущий и прежний ключ), закрытые точки.

Forgejo скачивает discovery по внутреннему адресу API (``http://api:8000``), а браузер человека ходит только по
публичным: поэтому во внутреннем документе ``issuer`` и ``authorization_endpoint`` — публичные, остальное — внутреннее.
Forgejo сверяет ``iss`` токена с ``issuer`` discovery (иначе 500), поэтому ``issuer`` в обоих документах одинаков.
"""

import json

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.test import Client
from jwcrypto import jwk

from plane.tests.contract.ppm_oidc.conftest import INTERNAL_URL, ISSUER

pytestmark = pytest.mark.django_db


def _get_json(path):
    response = Client().get(path)
    assert response.status_code == 200, (path, response.status_code)
    assert response["Content-Type"].startswith("application/json")
    return json.loads(response.content)


def test_public_discovery_is_standard_and_all_addresses_are_public(git_client):
    document = _get_json("/auth/oidc/.well-known/openid-configuration")

    assert document["issuer"] == ISSUER
    assert document["authorization_endpoint"] == f"{ISSUER}/authorize/"
    assert document["token_endpoint"] == f"{ISSUER}/token/"
    assert document["userinfo_endpoint"] == f"{ISSUER}/userinfo/"
    assert document["jwks_uri"] == f"{ISSUER}/jwks/"
    assert document["response_types_supported"] == ["code"]
    assert document["id_token_signing_alg_values_supported"] == ["RS256"]
    assert document["code_challenge_methods_supported"] == ["S256"]
    assert set(document["scopes_supported"]) == {"openid", "profile", "email", "groups"}
    assert set(document["token_endpoint_auth_methods_supported"]) == {"client_secret_basic", "client_secret_post"}
    assert {"sub", "name", "email", "email_verified", "nickname", "preferred_username", "groups"} <= set(
        document["claims_supported"]
    )
    # R2: выход, отзыв, интроспекция и регистрация клиентов не публикуются.
    for absent in ("end_session_endpoint", "revocation_endpoint", "introspection_endpoint", "registration_endpoint"):
        assert absent not in document


def test_internal_discovery_keeps_browser_addresses_public_and_back_channel_internal(git_client):
    document = _get_json("/auth/oidc/internal/.well-known/openid-configuration")

    assert document["issuer"] == ISSUER
    assert document["authorization_endpoint"] == f"{ISSUER}/authorize/"
    assert document["token_endpoint"] == f"{INTERNAL_URL}/auth/oidc/token/"
    assert document["userinfo_endpoint"] == f"{INTERNAL_URL}/auth/oidc/userinfo/"
    assert document["jwks_uri"] == f"{INTERNAL_URL}/auth/oidc/jwks/"


def test_discovery_answers_with_and_without_trailing_slash(git_client):
    assert _get_json("/auth/oidc/.well-known/openid-configuration/")["issuer"] == ISSUER
    assert _get_json("/auth/oidc/internal/.well-known/openid-configuration/")["issuer"] == ISSUER


def test_jwks_publishes_current_and_previous_public_keys_only(git_client, signing_keys):
    document = _get_json("/auth/oidc/jwks/")
    current = jwk.JWK.from_pem(signing_keys["current"].encode())
    previous = jwk.JWK.from_pem(signing_keys["previous"].encode())

    kids = [key["kid"] for key in document["keys"]]
    assert kids == [current.thumbprint(), previous.thumbprint()]
    for key in document["keys"]:
        assert key["kty"] == "RSA"
        assert key["alg"] == "RS256"
        assert key["use"] == "sig"
        # Только открытая часть ключа.
        assert not {"d", "p", "q", "dp", "dq", "qi"} & set(key)


def test_jwks_without_previous_key_has_one_key(git_client, settings, signing_keys):
    settings.PPM_OIDC_PREVIOUS_PRIVATE_KEY = ""
    settings.OAUTH2_PROVIDER = {**settings.OAUTH2_PROVIDER, "OIDC_RSA_PRIVATE_KEYS_INACTIVE": []}
    assert len(_get_json("/auth/oidc/jwks/")["keys"]) == 1


@pytest.mark.parametrize(
    "path",
    [
        "/auth/oidc/revoke_token/",
        "/auth/oidc/introspect/",
        "/auth/oidc/logout/",
        "/auth/oidc/applications/",
        "/auth/oidc/authorized_tokens/",
        "/auth/oidc/device-authorization/",
        "/auth/oidc/register/",
        "/auth/oidc/.well-known/jwks.json",
        "/auth/oidc/.well-known/oauth-authorization-server",
    ],
)
def test_toolkit_endpoints_outside_the_plan_are_not_mounted(git_client, path):
    assert Client().get(path).status_code == 404
    assert Client().post(path).status_code == 404
