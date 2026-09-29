"""G2.2 R6 — возврат на Git-сервер после входа в PPM (``/auth/oidc/continue/<id>/``).

Человек, не вошедший в PPM, нажал «Войти через PPM» на Git-сервере → вход PPM → continue один раз воспроизводит
сохранённый запрос → код → Forgejo. Устаревшая, чужая или повторная ссылка — понятная страница по-русски со ссылкой
на Git-сервер, статус 410, без 500 и без петли.
"""

from urllib.parse import parse_qs, urlsplit

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.core.cache import cache
from django.test import Client

from plane.ppm_oidc import continuation
from plane.tests.contract.ppm_oidc.conftest import GIT_URL, ISSUER, authorize, code_from, make_person

pytestmark = pytest.mark.django_db

EXPIRED_TEXT = "Ссылка для входа устарела. Вернитесь на Git-сервер и нажмите «Войти через PPM» ещё раз"


def _start(client, **params):
    response = authorize(client, **params)
    assert response.status_code == 302
    next_path = parse_qs(urlsplit(response["Location"]).query)["next_path"][0]
    return next_path


def _assert_expired_page(response):
    assert response.status_code == 410
    body = response.content.decode()
    assert EXPIRED_TEXT in body
    assert f'href="{GIT_URL}' in body
    assert "Location" not in response


def test_continue_brings_the_signed_in_person_back_to_the_same_authorization(git_client):
    browser = Client()
    next_path = _start(browser, state="round-trip")

    # Без сессии — снова на вход с тем же next_path (запрос не потрачен).
    again = browser.get(next_path)
    assert again.status_code == 302
    assert parse_qs(urlsplit(again["Location"]).query)["next_path"] == [next_path]

    person = make_person("carol")
    browser.force_login(person)
    replay = browser.get(next_path)
    assert replay.status_code == 302
    target = urlsplit(replay["Location"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == f"{ISSUER}/authorize/"
    assert parse_qs(target.query)["state"] == ["round-trip"]

    # Следующий шаг браузера — authorize с сессией: код для вошедшего человека.
    code = code_from(browser.get(f"/auth/oidc/authorize/?{target.query}"))
    from oauth2_provider.models import get_grant_model

    assert get_grant_model().objects.get(code=code).user_id == person.id


def test_continue_link_works_once(git_client):
    browser = Client()
    next_path = _start(browser)
    browser.force_login(make_person("dave"))
    assert browser.get(next_path).status_code == 302
    _assert_expired_page(browser.get(next_path))


def test_continue_link_from_another_browser_is_refused_and_not_spent(git_client):
    owner = Client()
    next_path = _start(owner)

    stranger = Client()
    stranger.force_login(make_person("mallory"))
    _assert_expired_page(stranger.get(next_path))
    stranger.cookies[continuation.BINDING_COOKIE] = continuation.new_binding()
    _assert_expired_page(stranger.get(next_path))

    owner.force_login(make_person("erin"))
    assert owner.get(next_path).status_code == 302


def test_expired_or_unknown_continue_link_shows_the_page(git_client):
    browser = Client()
    next_path = _start(browser)
    continue_id = next_path.rstrip("/").rsplit("/", 1)[1]
    cache.delete(continuation._cache_key(continue_id))  # истекли 10 минут
    browser.force_login(make_person("frank"))
    _assert_expired_page(browser.get(next_path))
    _assert_expired_page(browser.get(f"/auth/oidc/continue/{continuation.new_binding()}/"))
    _assert_expired_page(browser.get("/auth/oidc/continue/short/"))


def test_anonymous_bounces_stop_before_a_loop(git_client):
    browser = Client()
    next_path = _start(browser)
    for _ in range(continuation.MAX_ANONYMOUS_VISITS):
        assert browser.get(next_path).status_code == 302
    _assert_expired_page(browser.get(next_path))


def test_continue_accepts_only_get(git_client):
    browser = Client()
    next_path = _start(browser)
    assert browser.post(next_path).status_code == 405
