"""G2.2 R5/R15a — отключение в центре администратора удаляет коды и токены, выданные Git-серверу при входе через PPM.

Удаляет их сигнал линии S1 (``plane.ppm_oidc.signals.revoke_git_server_tokens``) на сохранение неактивного
пользователя; здесь проверяется, что «Отключить» сохраняет человека так, что сигнал срабатывает. Стенд
OpenID Connect-провайдера — общий с тестами S1 (``tests/contract/ppm_oidc/conftest.py``); без библиотеки OAuth2
(dev-образ владельца) модуль пропускается.
"""

import pytest

pytest.importorskip("oauth2_provider")
pytest.importorskip("jwcrypto")

from django.test import Client
from oauth2_provider.models import (
    get_access_token_model,
    get_grant_model,
    get_id_token_model,
    get_refresh_token_model,
)
from rest_framework import status
from rest_framework.test import APIClient

from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.tests.contract.ppm_oidc.conftest import authorize, code_from, make_person, sign_in_to_git_server
from plane.tests.contract.ppm_oidc.conftest import (  # noqa: F401 — the S1 provider stand, requested by name
    clean_oidc_cache,
    forgejo_access,
    git_client,
    oidc_settings,
    signing_keys,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

TOKEN_MODELS = (get_access_token_model, get_refresh_token_model, get_id_token_model, get_grant_model)


def signed_in(person):
    browser = Client()
    browser.force_login(person)
    return browser


@pytest.mark.usefixtures("git_client")
def test_switching_off_deletes_the_git_server_tokens_of_that_person_only():
    person = make_person("alice", display_name="Алиса Петрова", is_email_verified=True)
    browser = signed_in(person)
    sign_in_to_git_server(browser)
    code_from(authorize(browser))  # a code the Git server has not exchanged yet
    other = make_person("other", is_email_verified=True)
    sign_in_to_git_server(signed_in(other))
    admin = make_person("admin")
    PpmGlobalAdmin.objects.create(user=admin, reason="Владелец PPM")
    admin_api = APIClient()
    admin_api.force_authenticate(user=admin)

    response = admin_api.post(f"/api/ppm/v1/admin/users/{person.id}/suspend/")

    assert response.status_code == status.HTTP_200_OK
    for model in TOKEN_MODELS:
        assert not model().objects.filter(user=person).exists(), model().__name__
    assert get_access_token_model().objects.filter(user=other).exists()
