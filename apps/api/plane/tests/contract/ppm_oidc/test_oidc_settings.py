"""G2.2 R1 — настройки провайдера и мягкая деградация.

Dev-API владельца работает с ``uvicorn --reload`` на этом же дереве и без django-oauth-toolkit: там приложение
не подключается, маршрутов ``/auth/oidc/*`` нет, остальное работает. Проверяется и хелпер решения, и настоящий импорт
настроек/URL в отдельном процессе с «удалённой» библиотекой.
"""

import base64
import logging
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from django.conf import settings

from plane.ppm_oidc import conf
from plane.tests.contract.ppm_oidc.conftest import LIBRARY_INSTALLED


def _spec_finder(missing=()):
    def find_spec(name):
        return None if name in missing else object()

    return find_spec


def test_both_apps_are_installed_only_when_the_library_is_importable():
    assert conf.oidc_installed_apps(find_spec=_spec_finder()) == ["oauth2_provider", "plane.ppm_oidc"]
    assert conf.oidc_installed_apps(find_spec=_spec_finder(missing={"oauth2_provider"})) == []
    assert conf.oidc_installed_apps(find_spec=_spec_finder(missing={"jwcrypto"})) == []
    assert conf.oidc_installed_apps(find_spec=_spec_finder(missing={"oauthlib"})) == []

    def broken(name):
        raise ValueError(name)

    assert conf.oidc_installed_apps(find_spec=broken) == []


@pytest.mark.skipif(not LIBRARY_INSTALLED, reason="django-oauth-toolkit is not installed")
def test_this_image_has_the_library_and_the_apps_installed():
    assert "oauth2_provider" in settings.INSTALLED_APPS
    assert "plane.ppm_oidc" in settings.INSTALLED_APPS
    assert "plane.ppm_oidc.tasks" in settings.CELERY_IMPORTS


def test_g22_settings_exist_with_safe_defaults():
    # Все имена плана заданы (линия S2 читает их через getattr); по умолчанию единый вход выключен.
    for name in (
        "PPM_GIT_SSO_ENABLED",
        "PPM_OIDC_PRIVATE_KEY",
        "PPM_OIDC_PREVIOUS_PRIVATE_KEY",
        "PPM_OIDC_CLIENT_ID",
        "PPM_OIDC_CLIENT_SECRET",
        "PPM_OIDC_INTERNAL_URL",
        "PPM_FORGEJO_ADMIN_TOKEN",
        "PPM_FORGEJO_SSO_SOURCE_ID",
        "PPM_OIDC_FORGEJO_REDIRECT_URI",
        "OAUTH2_PROVIDER",
    ):
        assert hasattr(settings, name), name
    if "PPM_GIT_SSO_ENABLED" not in os.environ:
        assert settings.PPM_GIT_SSO_ENABLED is False
    if "PPM_OIDC_CLIENT_ID" not in os.environ:
        assert settings.PPM_OIDC_CLIENT_ID == "forgejo"
    if "PPM_OIDC_INTERNAL_URL" not in os.environ:
        assert settings.PPM_OIDC_INTERNAL_URL == "http://api:8000"
    # Частота по адресу клиента: на token/ — только неудачные аутентификации клиента (все входы идут с адреса самого
    # Git-сервера), authorize/ и continue/ — браузеры (офис за одним NAT).
    if "PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT" not in os.environ:
        assert settings.PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT == "10/minute"
    if "PPM_OIDC_AUTHORIZE_RATE_LIMIT" not in os.environ:
        assert settings.PPM_OIDC_AUTHORIZE_RATE_LIMIT == "120/minute"
    if "PPM_OIDC_CONTINUE_RATE_LIMIT" not in os.environ:
        assert settings.PPM_OIDC_CONTINUE_RATE_LIMIT == "60/minute"


def test_request_rates_are_validated_and_fall_back_to_the_default(caplog):
    assert conf.normalized_rate("10/minute") == "10/minute"
    assert conf.normalized_rate(" 5 / MIN ") == "5/min"
    assert conf.normalized_rate("120/h") == "120/h"
    for broken in ("", "lots", "10", "10/", "/minute", "0/minute", "-1/minute", "10/fortnight", "10/mango", None, 7):
        assert conf.normalized_rate(broken) == "", broken

    with caplog.at_level(logging.WARNING, logger="plane"):
        assert conf.rate_setting("lots", default="10/minute", name="PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT") == "10/minute"
    assert "PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT" in caplog.text
    assert conf.rate_setting(None, default="60/minute", name="X") == "60/minute"
    assert conf.rate_setting("3/second", default="60/minute", name="X") == "3/second"


def test_client_secret_hasher_is_appended_after_the_django_hashers():
    from django.conf import global_settings
    from django.contrib.auth.hashers import get_hasher

    assert settings.PASSWORD_HASHERS[: len(global_settings.PASSWORD_HASHERS)] == global_settings.PASSWORD_HASHERS
    assert settings.PASSWORD_HASHERS[-1] == conf.CLIENT_SECRET_HASHER_PATH
    # Пароли людей — по-прежнему PBKDF2.
    assert get_hasher("default").algorithm == "pbkdf2_sha256"
    assert get_hasher(conf.CLIENT_SECRET_HASHER).algorithm == conf.CLIENT_SECRET_HASHER


def test_client_secret_hasher_round_trip():
    from django.contrib.auth.hashers import check_password, identify_hasher, make_password

    secret = "0123456789abcdef" * 3
    encoded = make_password(secret, hasher=conf.CLIENT_SECRET_HASHER)
    assert encoded.startswith(conf.CLIENT_SECRET_HASHER + "$")
    assert secret not in encoded
    assert identify_hasher(encoded).algorithm == conf.CLIENT_SECRET_HASHER
    assert check_password(secret, encoded)
    assert not check_password(secret[:-1] + "0", encoded)
    assert not check_password("", encoded)
    # Соль у каждого хэша своя.
    assert make_password(secret, hasher=conf.CLIENT_SECRET_HASHER) != encoded
    summary = identify_hasher(encoded).safe_summary(encoded)
    assert all(secret not in str(value) for value in summary.values())


def test_private_key_is_read_from_base64_or_pem_and_garbage_is_ignored_without_echo(caplog, signing_keys):
    pem = signing_keys["current"]
    encoded = base64.b64encode(pem.encode("utf-8")).decode("ascii")

    assert conf.pem_from_setting(encoded) == pem.strip() + "\n"
    assert conf.pem_from_setting(f"  {encoded[:40]}\n{encoded[40:]}  ") == pem.strip() + "\n"
    assert conf.pem_from_setting(pem) == pem.strip() + "\n"
    assert conf.pem_from_setting("") == ""

    garbage = "not-a-key-" + "Zm9vYmFy" * 4
    with caplog.at_level(logging.ERROR, logger="plane"):
        assert conf.pem_from_setting(garbage, name="PPM_OIDC_PRIVATE_KEY") == ""
        assert conf.pem_from_setting(base64.b64encode(b"hello").decode(), name="PPM_OIDC_PRIVATE_KEY") == ""
    assert "PPM_OIDC_PRIVATE_KEY" in caplog.text
    assert garbage not in caplog.text


def test_redirect_uri_issuer_and_source_id_helpers():
    assert (
        conf.forgejo_redirect_uri("", "https://git.example.test/")
        == "https://git.example.test/user/oauth2/PPM/callback"
    )
    assert conf.forgejo_redirect_uri("https://other/cb", "https://git.example.test") == "https://other/cb"
    assert conf.forgejo_redirect_uri("", "") == ""
    assert conf.oidc_issuer("https://ppm.example.test/") == "https://ppm.example.test/auth/oidc"
    assert conf.oidc_issuer("") == ""
    assert conf.oidc_issuer("ppm.example.test") == ""
    assert conf.positive_int("7") == 7
    assert conf.positive_int("") is None
    assert conf.positive_int("x") is None
    assert conf.positive_int("-3") is None


def test_provider_settings_follow_r1():
    provider = conf.oauth2_provider_settings(
        issuer="https://ppm.example.test/auth/oidc", private_key="K", previous_private_key="P"
    )
    assert provider["OIDC_ENABLED"] is True
    assert provider["OIDC_ISS_ENDPOINT"] == "https://ppm.example.test/auth/oidc"
    assert provider["OIDC_RSA_PRIVATE_KEY"] == "K"
    assert provider["OIDC_RSA_PRIVATE_KEYS_INACTIVE"] == ["P"]
    assert set(provider["SCOPES"]) == {"openid", "profile", "email", "groups"}
    assert provider["AUTHORIZATION_CODE_EXPIRE_SECONDS"] == 60
    assert provider["ACCESS_TOKEN_EXPIRE_SECONDS"] == 300
    assert provider["ID_TOKEN_EXPIRE_SECONDS"] == 300
    assert provider["REFRESH_TOKEN_EXPIRE_SECONDS"] == 3600
    assert provider["PKCE_REQUIRED"] is False
    assert provider["COMPLIANT_BCP_RFC9700_PKCE_METHOD"] is True
    assert provider["COMPLIANT_BCP_RFC9700_TOKEN_STORAGE"] is True
    assert provider["OAUTH2_VALIDATOR_CLASS"] == "plane.ppm_oidc.validators.PpmOAuth2Validator"
    assert provider["OIDC_SERVER_CLASS"] == "plane.ppm_oidc.server.PpmOidcServer"
    assert conf.oauth2_provider_settings(issuer="", private_key="")["OIDC_RSA_PRIVATE_KEYS_INACTIVE"] == []


_WITHOUT_LIBRARY = textwrap.dedent(
    """
    import sys

    # Как в dev-API владельца: django-oauth-toolkit и jwcrypto не установлены (find_spec → None, import → ошибка).
    sys.modules["oauth2_provider"] = None
    sys.modules["jwcrypto"] = None

    import django
    django.setup()
    from django.conf import settings
    from django.urls import Resolver404, resolve

    assert "oauth2_provider" not in settings.INSTALLED_APPS, settings.INSTALLED_APPS
    assert "plane.ppm_oidc" not in settings.INSTALLED_APPS, settings.INSTALLED_APPS
    import plane.urls  # noqa: F401 — маршруты строятся без библиотеки
    import plane.ppm_oidc.tasks as tasks
    assert tasks.clear_expired_oidc_tokens() == "skipped"
    for path in ("/auth/oidc/authorize/", "/auth/oidc/.well-known/openid-configuration", "/auth/oidc/token/"):
        try:
            resolve(path)
        except Resolver404:
            pass
        else:
            raise AssertionError(path + " must not be mounted without the library")
    assert resolve("/auth/sign-in/").url_name == "sign-in"
    print("SOFT-DEGRADATION-OK")
    """
)


def test_settings_and_urls_import_without_the_library():
    # Настройки production (как у dev-API владельца) проверяются отдельно — в его образе без библиотеки (отчёт S1):
    # здесь они открыли бы файловый журнал в рабочем дереве.
    env = {
        **os.environ,
        "DJANGO_SETTINGS_MODULE": "plane.settings.test",
        "PPM_GIT_SSO_ENABLED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    result = subprocess.run(
        [sys.executable, "-c", _WITHOUT_LIBRARY],
        cwd=str(Path(settings.BASE_DIR).parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    assert "SOFT-DEGRADATION-OK" in result.stdout


_ENVIRONMENT_TO_SETTINGS = textwrap.dedent(
    """
    import django

    django.setup()
    from django.conf import settings

    provider = settings.OAUTH2_PROVIDER
    assert settings.PPM_GIT_SSO_ENABLED is True
    key = settings.PPM_OIDC_PRIVATE_KEY
    assert key.startswith("-----BEGIN ") and key.endswith("-----\\n")
    assert provider["OIDC_RSA_PRIVATE_KEY"] == settings.PPM_OIDC_PRIVATE_KEY
    assert provider["OIDC_RSA_PRIVATE_KEYS_INACTIVE"] == [settings.PPM_OIDC_PREVIOUS_PRIVATE_KEY]
    assert settings.PPM_OIDC_PREVIOUS_PRIVATE_KEY != settings.PPM_OIDC_PRIVATE_KEY
    assert provider["OIDC_ISS_ENDPOINT"] == "https://ppm.example.test/auth/oidc"
    assert settings.PPM_OIDC_CLIENT_SECRET == "f" * 48
    assert settings.PPM_FORGEJO_ADMIN_TOKEN == "a" * 40
    assert settings.PPM_FORGEJO_SSO_SOURCE_ID == 7
    assert settings.PPM_OIDC_FORGEJO_REDIRECT_URI == "https://git.example.test/user/oauth2/PPM/callback"
    assert settings.PPM_OIDC_INTERNAL_URL == "http://api:8000"
    from plane.ppm_oidc import state

    assert state.configuration_problems() == [], state.configuration_problems()
    print("ENVIRONMENT-OK")
    """
)


def test_environment_reaches_the_provider_settings(tmp_path, signing_keys):
    # Как в комплекте: ключ — base64 PEM одной строкой; прежний ключ и секреты — через _FILE.
    current = base64.b64encode(signing_keys["current"].encode("utf-8")).decode("ascii")
    previous_file = tmp_path / "previous-key"
    previous_file.write_text(base64.b64encode(signing_keys["previous"].encode("utf-8")).decode("ascii"))
    secret_file = tmp_path / "client-secret"
    secret_file.write_text("f" * 48 + "\n")
    env = {
        **os.environ,
        "DJANGO_SETTINGS_MODULE": "plane.settings.test",
        "PYTHONDONTWRITEBYTECODE": "1",
        "WEB_URL": "https://ppm.example.test/",
        "PPM_GIT_SSO_ENABLED": "1",
        "PPM_OIDC_PRIVATE_KEY": current,
        "PPM_OIDC_PREVIOUS_PRIVATE_KEY_FILE": str(previous_file),
        "PPM_OIDC_CLIENT_SECRET_FILE": str(secret_file),
        "PPM_FORGEJO_ADMIN_TOKEN": "a" * 40,
        "PPM_FORGEJO_SSO_SOURCE_ID": "7",
        "PPM_FORGEJO_PUBLIC_URL": "https://git.example.test/",
    }
    for name in ("PPM_OIDC_FORGEJO_REDIRECT_URI", "PPM_OIDC_INTERNAL_URL", "PPM_OIDC_CLIENT_SECRET", "APP_BASE_URL"):
        env.pop(name, None)
    result = subprocess.run(
        [sys.executable, "-c", _ENVIRONMENT_TO_SETTINGS],
        cwd=str(Path(settings.BASE_DIR).parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-3000:]
    assert "ENVIRONMENT-OK" in result.stdout
    # Ключ не печатается ни при каких условиях.
    assert signing_keys["current"].splitlines()[1] not in result.stdout + result.stderr


_COLLECT_WITHOUT_LIBRARY = textwrap.dedent(
    """
    import sys

    sys.modules["oauth2_provider"] = None
    sys.modules["jwcrypto"] = None
    import pytest

    raise SystemExit(pytest.main(["--collect-only", "-q", "-o", "addopts=", "-p", "no:cacheprovider", sys.argv[1]]))
    """
)


def test_the_tests_collect_without_the_library():
    directory = Path(__file__).resolve().parent
    env = {**os.environ, "DJANGO_SETTINGS_MODULE": "plane.settings.test", "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run(
        [sys.executable, "-c", _COLLECT_WITHOUT_LIBRARY, str(directory)],
        cwd=str(Path(settings.BASE_DIR).parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, output[-3000:]
    assert not re.search(r"\b\d+ errors?\b|ImportError|ModuleNotFoundError", output), output[-3000:]
    assert "test_oidc_settings.py::test_provider_settings_follow_r1" in output
    assert "test_oidc_token.py::" not in output
