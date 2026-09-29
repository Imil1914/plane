"""G2.2 R15a — отключённого администратором не пускает ни один способ входа, и вход не включает его обратно.

Все интерактивные способы Plane (пароль, код из письма, OAuth — в приложении и в публикациях) сходятся в
``Adapter.complete_login_or_signup``; включает неактивного человека только ``Adapter.save_user_data``. Вход в
/god-mode и ключи API проверяют ``is_active`` сами. Самостоятельная деактивация Plane и первый вход «выданной»
неактивной учётки работают как раньше.
"""

import json
import uuid
from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.db import connection
from django.test import Client, RequestFactory
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.authentication.adapter.base import Adapter
from plane.authentication.adapter.error import AUTHENTICATION_ERROR_CODES, AuthenticationException
from plane.db.models import Account, APIToken, User
from plane.license.models import Instance
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_core.models import PpmUserSuspension
from plane.settings.redis import redis_instance
from plane.tests.factories import UserFactory

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

PASSWORD = "Str0ng-Pass!42"
DEACTIVATED = "USER_ACCOUNT_DEACTIVATED"


@pytest.fixture(autouse=True)
def clean_sign_in_state():
    """Sign-in throttling and e-mail codes live in the shared cache and Redis — every test starts clean."""
    cache.delete_pattern("throttle_authentication_*")
    yield
    cache.delete_pattern("throttle_authentication_*")


@pytest.fixture
def instance(db):
    return Instance.objects.first() or Instance.objects.create(
        instance_name="PPM",
        instance_id=uuid.uuid4().hex,
        current_version="1.0.0",
        domain="http://localhost:8000",
        last_checked_at=timezone.now(),
        is_setup_done=True,
    )


def make_person(prefix="person"):
    marker = uuid.uuid4().hex[:10]
    person = UserFactory(email=f"{prefix}-{marker}@ppm.test", username=f"{prefix}-{marker}")
    person.set_password(PASSWORD)
    person.save()
    return person


@pytest.fixture
def admin_api(db):
    admin = make_person("admin")
    PpmGlobalAdmin.objects.create(user=admin, reason="Владелец PPM")
    client = APIClient()
    client.force_authenticate(user=admin)
    return client


@pytest.fixture
def suspended(instance, admin_api):
    person = make_person("suspended")
    response = admin_api.post(f"/api/ppm/v1/admin/users/{person.id}/suspend/")
    assert response.status_code == status.HTTP_200_OK, response.data
    person.refresh_from_db()
    return person


def browser():
    return Client(HTTP_USER_AGENT="Mozilla/5.0 (PPM tests)")


def assert_refused_and_still_off(response, client, person, code=DEACTIVATED):
    assert response.status_code == 302
    assert code in response.url, response.url
    assert "_auth_user_id" not in client.session
    person.refresh_from_db()
    assert person.is_active is False


def magic_code(email):
    with patch("plane.bgtasks.magic_link_code_task.magic_link.delay"):
        response = APIClient().post(reverse("magic-generate"), {"email": email}, format="json")
    assert response.status_code == status.HTTP_200_OK, response.data
    return json.loads(redis_instance().get(f"magic_{email}"))["token"]


def test_password_sign_in_is_refused_and_does_not_switch_the_person_back_on(suspended):
    client = browser()

    response = client.post(reverse("sign-in"), {"email": suspended.email, "password": PASSWORD})

    assert_refused_and_still_off(response, client, suspended)


def test_password_sign_in_to_published_boards_is_refused(suspended):
    client = browser()

    response = client.post(reverse("space-sign-in"), {"email": suspended.email, "password": PASSWORD})

    assert_refused_and_still_off(response, client, suspended)


def test_email_code_sign_in_is_refused(suspended):
    code = magic_code(suspended.email)
    client = browser()

    response = client.post(reverse("magic-sign-in"), {"email": suspended.email, "code": code})

    assert_refused_and_still_off(response, client, suspended)


class FakeGitHub:
    """GitHub's token, user and e-mail answers — the OAuth provider path up to PPM's own checks."""

    def __init__(self, email):
        self.email = email

    def post(self, url, *args, **kwargs):
        assert url == "https://github.com/login/oauth/access_token", url
        return self.Response({"access_token": "gho_test"})

    def get(self, url, *args, **kwargs):
        if url == "https://api.github.com/user":
            return self.Response({"id": 4242, "login": "suspended", "avatar_url": "", "name": "Отключённый"})
        assert url == "https://api.github.com/user/emails", url
        return self.Response([{"email": self.email, "primary": True, "verified": True}])

    class Response:
        status_code = 200

        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload


def test_oauth_sign_in_is_refused(suspended, monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "ppm-test-client")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "ppm-test-secret")
    monkeypatch.delenv("GITHUB_ORGANIZATION_ID", raising=False)
    github = FakeGitHub(suspended.email)
    monkeypatch.setattr("requests.post", github.post)
    monkeypatch.setattr("requests.get", github.get)
    client = browser()
    session = client.session
    session["state"] = "state-1"
    session.save()

    response = client.get(reverse("github-callback"), {"code": "code-1", "state": "state-1"})

    assert_refused_and_still_off(response, client, suspended)
    assert not Account.objects.filter(user=suspended).exists()


def test_admin_console_sign_in_is_refused(suspended):
    client = browser()

    response = client.post("/api/instances/admins/sign-in/", {"email": suspended.email, "password": PASSWORD})

    assert_refused_and_still_off(response, client, suspended, code="ADMIN_USER_DEACTIVATED")


def test_api_key_stops_working_while_switched_off(instance, admin_api):
    person = make_person("robot-owner")
    token = APIToken.objects.create(user=person, label="CI", token=f"plane_api_{uuid.uuid4().hex}")

    def me():
        return APIClient().get("/api/v1/users/me/", HTTP_X_API_KEY=token.token).status_code

    before = me()
    admin_api.post(f"/api/ppm/v1/admin/users/{person.id}/suspend/")
    switched_off = me()
    admin_api.post(f"/api/ppm/v1/admin/users/{person.id}/resume/")

    # APIKeyAuthentication sets no WWW-Authenticate header, so DRF answers a refused key with 403.
    assert (before, switched_off, me()) == (status.HTTP_200_OK, status.HTTP_403_FORBIDDEN, status.HTTP_200_OK)


def test_keys_deleted_as_the_runbook_says_stay_dead_after_switching_back_on(instance, admin_api):
    """RUNBOOK §6: «Отключить» keeps the person's API keys (refused while switched off, back with «Включить») — on
    dismissal the operator deletes them with the documented one-liner."""
    person = make_person("dismissed")
    token = APIToken.objects.create(user=person, label="CI", token=f"plane_api_{uuid.uuid4().hex}")
    admin_api.post(f"/api/ppm/v1/admin/users/{person.id}/suspend/")

    APIToken.objects.filter(user__email=person.email).delete()
    admin_api.post(f"/api/ppm/v1/admin/users/{person.id}/resume/")

    response = APIClient().get("/api/v1/users/me/", HTTP_X_API_KEY=token.token)
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_switched_back_on_the_person_signs_in_again(suspended, admin_api):
    assert admin_api.post(f"/api/ppm/v1/admin/users/{suspended.id}/resume/").status_code == status.HTTP_200_OK
    client = browser()

    response = client.post(reverse("sign-in"), {"email": suspended.email, "password": PASSWORD})

    assert response.status_code == 302
    assert "error_code" not in response.url, response.url
    assert client.session["_auth_user_id"] == str(suspended.id)


def test_refused_without_relying_on_the_logout_time(suspended):
    """Plane refuses a deactivated account only while ``last_logout_time`` is set and otherwise *activates* it on
    sign-in (``save_user_data``). PPM's own mark is enough on its own."""
    User.objects.filter(pk=suspended.pk).update(last_logout_time=None)
    client = browser()

    response = client.post(reverse("sign-in"), {"email": suspended.email, "password": PASSWORD})

    assert_refused_and_still_off(response, client, suspended)


def test_a_sign_in_in_progress_does_not_switch_the_person_back_on(suspended):
    """The person's row was read by a sign-in before the switch-off landed (a stale ``is_active=True`` in memory)."""
    stale = User.objects.get(pk=suspended.pk)
    stale.is_active = True
    request = RequestFactory().post("/auth/sign-in/", REMOTE_ADDR="10.0.0.1", HTTP_USER_AGENT="Mozilla/5.0 (PPM tests)")

    with pytest.raises(AuthenticationException) as refused:
        Adapter(request=request, provider="email").save_user_data(stale)

    assert refused.value.error_code == AUTHENTICATION_ERROR_CODES[DEACTIVATED]
    suspended.refresh_from_db()
    assert suspended.is_active is False
    assert PpmUserSuspension.objects.filter(user=suspended).exists()


# --- как раньше -------------------------------------------------------------------------------------------------


def test_an_ordinary_sign_in_never_reads_the_suspension_table(instance):
    """The owner's dev API runs this code before migration ppm_core 0001 is applied: signing in an active person
    must not touch the new table."""
    person = make_person("ordinary")
    client = browser()

    with CaptureQueriesContext(connection) as queries:
        response = client.post(reverse("sign-in"), {"email": person.email, "password": PASSWORD})

    assert response.status_code == 302
    assert "error_code" not in response.url, response.url
    assert not [query["sql"] for query in queries.captured_queries if "ppm_user_suspensions" in query["sql"]]


def test_plane_self_deactivation_still_refuses_sign_in(instance):
    person = make_person("left")
    User.objects.filter(pk=person.pk).update(is_active=False, last_logout_time=timezone.now())
    client = browser()

    response = client.post(reverse("sign-in"), {"email": person.email, "password": PASSWORD})

    assert_refused_and_still_off(response, client, person)


def test_an_issued_inactive_account_is_still_activated_by_its_first_sign_in(instance):
    """Plane activates an account that was created inactive and never deactivated (no logout time, no PPM mark)."""
    person = make_person("issued")
    User.objects.filter(pk=person.pk).update(is_active=False, last_logout_time=None)
    client = browser()

    with patch("plane.authentication.adapter.base.user_activation_email.delay"):
        response = client.post(reverse("sign-in"), {"email": person.email, "password": PASSWORD})

    assert response.status_code == 302
    assert "error_code" not in response.url, response.url
    person.refresh_from_db()
    assert person.is_active is True
