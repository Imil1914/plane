"""G2.2 R4, R5 — ID token и userinfo: то, по чему Forgejo находит и узнаёт человека.

Forgejo не проверяет подпись, но требует ``iss`` = ``issuer`` discovery, ``aud`` = client_id, ``exp`` (без него —
паника и 500) и тот же ``sub`` в userinfo; утверждения userinfo перекрывают утверждения ID token.
"""

import json

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.test import Client
from jwcrypto import jwk, jwt

from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.tests.contract.ppm_oidc.conftest import CLIENT_ID, ISSUER, make_person, sign_in_to_git_server

pytestmark = pytest.mark.django_db


def _verified_claims(id_token):
    keyset = jwk.JWKSet.from_json(Client().get("/auth/oidc/jwks/").content.decode())
    token = jwt.JWT(jwt=id_token, key=keyset, algs=["RS256"])
    header = json.loads(token.header)
    return header, json.loads(token.claims)


def _userinfo(access_token, **extra):
    return Client().get("/auth/oidc/userinfo/", HTTP_AUTHORIZATION=f"Bearer {access_token}", **extra)


def test_id_token_is_signed_and_carries_what_forgejo_requires(git_client, browser, person, signing_keys):
    tokens = sign_in_to_git_server(browser)
    header, claims = _verified_claims(tokens["id_token"])
    person.refresh_from_db()

    assert header["alg"] == "RS256"
    assert header["kid"] == jwk.JWK.from_pem(signing_keys["current"].encode()).thumbprint()
    assert claims["iss"] == ISSUER
    assert claims["aud"] == CLIENT_ID
    assert claims["sub"] == str(person.id)
    assert claims["exp"] - claims["iat"] == pytest.approx(300, abs=5)
    assert claims["auth_time"] == int(person.last_login.timestamp())
    assert claims["name"] == "Алиса Петрова"
    assert claims["email"] == person.email
    assert claims["email_verified"] is True
    assert claims["nickname"] == claims["preferred_username"] == person.email.split("@")[0]
    assert claims["groups"] == []


def test_userinfo_returns_the_same_subject_and_claims(git_client, browser, person):
    tokens = sign_in_to_git_server(browser)
    response = _userinfo(tokens["access_token"])

    assert response.status_code == 200, response.content
    info = json.loads(response.content)
    _header, id_claims = _verified_claims(tokens["id_token"])
    assert info["sub"] == id_claims["sub"] == str(person.id)
    for claim in ("name", "email", "email_verified", "nickname", "preferred_username", "groups"):
        assert info[claim] == id_claims[claim], claim


def test_global_administrator_is_in_the_ppm_admins_group(git_client, person):
    PpmGlobalAdmin.objects.create(user=person, reason="G2.2 S1 test")
    client = Client()
    client.force_login(person)
    tokens = sign_in_to_git_server(client)
    assert json.loads(_userinfo(tokens["access_token"]).content)["groups"] == ["ppm-admins"]


def test_revoked_global_administrator_is_not_in_the_group(git_client, person):
    from django.utils import timezone

    PpmGlobalAdmin.objects.create(user=person, reason="G2.2 S1 test", revoked_at=timezone.now())
    client = Client()
    client.force_login(person)
    tokens = sign_in_to_git_server(client)
    assert json.loads(_userinfo(tokens["access_token"]).content)["groups"] == []


def test_name_falls_back_to_first_and_last_name(git_client):
    someone = make_person("nameless", first_name="Иван", last_name="Иванов")
    type(someone).objects.filter(pk=someone.pk).update(display_name="")
    client = Client()
    client.force_login(someone)
    tokens = sign_in_to_git_server(client)
    assert json.loads(_userinfo(tokens["access_token"]).content)["name"] == "Иван Иванов"


def test_git_server_name_is_omitted_while_unknown(git_client, browser, person, forgejo_access, monkeypatch):
    monkeypatch.setattr(forgejo_access, "forgejo_username_for", lambda user: None)
    tokens = sign_in_to_git_server(browser)
    info = json.loads(_userinfo(tokens["access_token"]).content)
    assert "nickname" not in info and "preferred_username" not in info
    assert info["sub"] == str(person.id)


def test_claims_follow_the_granted_scopes(git_client, browser):
    tokens = sign_in_to_git_server(browser, scope="openid")
    info = json.loads(_userinfo(tokens["access_token"]).content)
    assert set(info) == {"sub"}


def test_userinfo_refuses_a_switched_off_person(git_client, browser, person):
    tokens = sign_in_to_git_server(browser)
    type(person).objects.filter(pk=person.pk).update(is_active=False)
    response = _userinfo(tokens["access_token"])
    assert response.status_code == 401
    assert "invalid_token" in response.get("WWW-Authenticate", "")


def test_userinfo_refuses_a_token_in_the_query_string(git_client, browser):
    tokens = sign_in_to_git_server(browser)
    response = Client().get(f"/auth/oidc/userinfo/?access_token={tokens['access_token']}")
    assert response.status_code == 400
    assert json.loads(response.content)["error"] == "invalid_request"


def test_userinfo_without_a_token_is_unauthorized(git_client):
    assert Client().get("/auth/oidc/userinfo/").status_code == 401
    assert _userinfo("not-a-token").status_code == 401


def test_userinfo_refuses_a_token_of_another_application(git_client, person):
    from datetime import timedelta

    from django.utils import timezone
    from oauth2_provider.models import get_access_token_model, get_application_model

    other = get_application_model().objects.create(
        client_id="other-client",
        client_type="confidential",
        authorization_grant_type="authorization-code",
        redirect_uris="https://other.example.test/cb",
        algorithm="RS256",
        name="other",
    )
    get_access_token_model().objects.create(
        user=person,
        application=other,
        token="other-application-token-" + "x" * 20,
        expires=timezone.now() + timedelta(minutes=5),
        scope="openid profile email groups",
    )
    response = _userinfo("other-application-token-" + "x" * 20)
    assert response.status_code == 401


def test_email_verified_is_the_real_state_in_ppm(git_client):
    unverified = make_person("unverified", is_email_verified=False)
    client = Client()
    client.force_login(unverified)
    tokens = sign_in_to_git_server(client)
    _header, claims = _verified_claims(tokens["id_token"])
    assert claims["email_verified"] is False
    assert json.loads(_userinfo(tokens["access_token"]).content)["email_verified"] is False
