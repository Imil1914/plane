"""G2.2 R3 — команда ``manage.py ppm_oidc_client --ensure | --disable | --status``.

Команда идемпотентно приводит единственное приложение OAuth2 (Git-сервер) к окружению, другие приложения не создаёт и
не трогает, секреты и ключ не печатает. Её вызывает ``git-bootstrap`` комплекта (линия S3).
"""

import io

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.contrib.auth.hashers import check_password, identify_hasher
from django.core.management import call_command
from django.core.management.base import CommandError
from oauth2_provider.models import get_access_token_model, get_application_model

from plane.tests.contract.ppm_oidc.conftest import CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, sign_in_to_git_server

pytestmark = pytest.mark.django_db

Application = get_application_model()


def _run(*args):
    out, err = io.StringIO(), io.StringIO()
    call_command("ppm_oidc_client", *args, stdout=out, stderr=err)
    return out.getvalue() + err.getvalue()


def _assert_no_secrets(output, application=None, signing_keys=None):
    assert CLIENT_SECRET not in output
    assert "PRIVATE KEY" not in output
    if application is not None:
        assert application.client_secret not in output
    if signing_keys is not None:
        assert signing_keys["current"].splitlines()[1] not in output


def test_ensure_creates_the_git_server_client(oidc_settings, signing_keys):
    output = _run("--ensure")

    application = Application.objects.get(client_id=CLIENT_ID)
    assert application.client_type == Application.CLIENT_CONFIDENTIAL
    assert application.authorization_grant_type == Application.GRANT_AUTHORIZATION_CODE
    assert application.redirect_uris == REDIRECT_URI
    assert application.algorithm == Application.RS256_ALGORITHM
    assert application.skip_authorization is True
    assert application.hash_client_secret is True
    assert application.user is None
    # В базе — только хэш секрета, быстрым солёным HMAC (секрет случайный, PBKDF2 здесь ничего не защищает).
    assert identify_hasher(application.client_secret).algorithm == "ppm_oidc_hmac_sha256"
    assert check_password(CLIENT_SECRET, application.client_secret)
    assert "создан" in output
    _assert_no_secrets(output, application, signing_keys)


def test_ensure_is_idempotent(oidc_settings):
    _run("--ensure")
    first = Application.objects.get(client_id=CLIENT_ID)
    output = _run("--ensure")
    second = Application.objects.get(client_id=CLIENT_ID)

    assert Application.objects.count() == 1
    assert second.client_secret == first.client_secret
    assert second.updated == first.updated
    assert "соответствует окружению" in output


def test_ensure_brings_a_drifted_client_back_to_the_environment(oidc_settings):
    _run("--ensure")
    Application.objects.filter(client_id=CLIENT_ID).update(
        redirect_uris="https://evil.example.test/cb",
        skip_authorization=False,
        algorithm="HS256",
        client_type="public",
    )
    application = Application.objects.get(client_id=CLIENT_ID)
    application.client_secret = "stale-secret-" + "0" * 40
    application.save()

    output = _run("--ensure")

    application.refresh_from_db()
    assert application.redirect_uris == REDIRECT_URI
    assert application.skip_authorization is True
    assert application.algorithm == Application.RS256_ALGORITHM
    assert application.client_type == Application.CLIENT_CONFIDENTIAL
    assert check_password(CLIENT_SECRET, application.client_secret)
    assert "обновлён" in output
    _assert_no_secrets(output, application)


def test_rotated_secret_replaces_the_old_one(oidc_settings, git_client, browser, settings, forgejo_access):
    new_secret = "a" * 48
    settings.PPM_OIDC_CLIENT_SECRET = new_secret
    output = _run("--ensure")
    application = Application.objects.get(client_id=CLIENT_ID)
    assert check_password(new_secret, application.client_secret)
    assert not check_password(CLIENT_SECRET, application.client_secret)
    assert new_secret not in output


def test_other_applications_are_never_touched(oidc_settings):
    other = Application.objects.create(
        client_id="other-client",
        client_type="public",
        authorization_grant_type="implicit",
        redirect_uris="https://other.example.test/cb",
        name="other",
    )
    _run("--ensure")
    _run("--disable")
    _run("--ensure")

    other_after = Application.objects.get(pk=other.pk)
    assert (other_after.client_type, other_after.redirect_uris, other_after.updated) == (
        other.client_type,
        other.redirect_uris,
        other.updated,
    )
    assert Application.objects.filter(client_id=CLIENT_ID).count() == 1


def test_disable_removes_the_client_and_its_tokens_and_repeats_quietly(git_client, browser, person, forgejo_access):
    sign_in_to_git_server(browser)
    assert get_access_token_model().objects.filter(user=person).exists()

    output = _run("--disable")
    assert not Application.objects.filter(client_id=CLIENT_ID).exists()
    assert not get_access_token_model().objects.filter(user=person).exists()
    assert "отключён" in output

    assert "не найден" in _run("--disable")


def test_status_reports_without_secrets(oidc_settings, signing_keys):
    before = _run("--status")
    assert "нет" in before
    _run("--ensure")
    after = _run("--status")

    assert CLIENT_ID in after
    assert REDIRECT_URI in after
    assert "соответствует окружению" in after
    _assert_no_secrets(after, Application.objects.get(client_id=CLIENT_ID), signing_keys)


def test_status_names_what_is_missing(oidc_settings, settings):
    settings.PPM_OIDC_PRIVATE_KEY = ""
    settings.PPM_OIDC_CLIENT_SECRET = ""
    output = _run("--status")
    assert "PPM_OIDC_PRIVATE_KEY" in output
    assert "PPM_OIDC_CLIENT_SECRET" in output


@pytest.mark.parametrize("missing", ["PPM_OIDC_CLIENT_SECRET", "PPM_OIDC_PRIVATE_KEY", "PPM_OIDC_FORGEJO_REDIRECT_URI"])
def test_ensure_refuses_an_incomplete_environment(oidc_settings, settings, missing):
    setattr(settings, missing, "")
    with pytest.raises(CommandError) as error:
        _run("--ensure")
    assert missing in str(error.value)
    assert not Application.objects.filter(client_id=CLIENT_ID).exists()


@pytest.mark.parametrize(
    "secret", ["short", "a" * 31, "0123456789abcdef" * 3 + "g", "correct horse battery staple, 32+"]
)
def test_secret_that_is_not_32_hex_digits_is_refused(oidc_settings, settings, secret):
    settings.PPM_OIDC_CLIENT_SECRET = secret
    with pytest.raises(CommandError) as error:
        _run("--ensure")
    assert "PPM_OIDC_CLIENT_SECRET" in str(error.value)
    assert secret not in str(error.value)


def test_secret_hashed_earlier_with_pbkdf2_still_works_and_ensure_rewrites_it(git_client, browser, forgejo_access):
    from django.contrib.auth.hashers import make_password

    from plane.tests.contract.ppm_oidc.conftest import authorize, code_from, exchange

    Application.objects.filter(pk=git_client.pk).update(
        client_secret=make_password(CLIENT_SECRET, hasher="pbkdf2_sha256")
    )
    assert "прежнего формата" in _run("--status")
    assert exchange(code_from(authorize(browser))).status_code == 200

    output = _run("--ensure")
    application = Application.objects.get(pk=git_client.pk)
    assert identify_hasher(application.client_secret).algorithm == "ppm_oidc_hmac_sha256"
    assert check_password(CLIENT_SECRET, application.client_secret)
    assert "обновлён: секрет" in output
    assert "соответствует окружению" in _run("--ensure")
    assert exchange(code_from(authorize(browser))).status_code == 200


def test_exactly_one_action_is_required(oidc_settings):
    with pytest.raises(CommandError):
        _run()
    with pytest.raises(CommandError):
        _run("--ensure", "--disable")


def test_redirect_uri_the_toolkit_refuses_is_a_clear_error(oidc_settings, settings):
    # Абсолютный http(s)-адрес, но имя хоста с дефиса валидатор DOT отвергает — ошибка модели, не трассировка.
    settings.PPM_OIDC_FORGEJO_REDIRECT_URI = "https://-git.example.test/user/oauth2/PPM/callback"
    with pytest.raises(CommandError) as error:
        _run("--ensure")
    assert "не сохранён" in str(error.value)
    assert CLIENT_SECRET not in str(error.value)
    assert not Application.objects.filter(client_id=CLIENT_ID).exists()
