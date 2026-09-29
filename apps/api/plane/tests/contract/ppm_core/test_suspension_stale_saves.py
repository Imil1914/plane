"""G2.2 R15a, ревью безопасности (раунд 1) — «Отключить» не откатывается запросом, который уже шёл.

Запрос человека, начатый до «Отключить» (смена или установка пароля, правка профиля, синхронизация профиля при входе),
держит в памяти прежнего ``User`` с ``is_active=True`` и сохраняет его целиком уже после отключения. Пока есть пометка
``PpmUserSuspension``, такое сохранение оставляет человека отключённым (и время выхода — из базы); включает только
«Включить» (пометка снимается первой) и ``manage.py activate_user`` — тем же путём. Смена пароля отключённым новой
сессии не выдаёт.
"""

import io
import uuid
from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.app.serializers import UserSerializer
from plane.db.models import Profile, Session, User
from plane.license.models import Instance
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_core.models import PpmUserSuspension
from plane.ppm_core.suspension import suspend_user

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

PASSWORD = "Str0ng-Pass!42-stale"
NEW_PASSWORD = "An0ther-Str0ng-Pass!77-stale"
DEACTIVATED = "USER_ACCOUNT_DEACTIVATED"


@pytest.fixture(autouse=True)
def clean_sign_in_throttle():
    cache.delete_pattern("throttle_authentication_*")
    yield
    cache.delete_pattern("throttle_authentication_*")


def make(prefix, **fields):
    marker = uuid.uuid4().hex[:10]
    person = User.objects.create(email=f"{prefix}-{marker}@ppm.test", username=f"{prefix}-{marker}", **fields)
    person.set_password(PASSWORD)
    person.save()
    Profile.objects.get_or_create(user=person)
    return person


@pytest.fixture
def admin(db):
    admin = make("admin")
    PpmGlobalAdmin.objects.create(user=admin, reason="Владелец PPM")
    return admin


@pytest.fixture
def person(db):
    return make("person")


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


def signed_in(user):
    browser = Client()
    browser.force_login(user)
    return browser


def admin_row(admin, person):
    api = APIClient()
    api.force_authenticate(user=admin)
    rows = api.get("/api/ppm/v1/admin/users/?page_size=100").data["results"]
    row = next(row for row in rows if row["user_id"] == str(person.id))
    return row["is_active"], row["is_suspended"], row["can_suspend"], row["can_resume"]


def logout_time_of(person):
    return User.objects.values_list("last_logout_time", flat=True).get(pk=person.pk)


def assert_still_switched_off(admin, person, logout_time):
    person.refresh_from_db()
    assert person.is_active is False
    assert person.last_logout_time == logout_time
    assert PpmUserSuspension.objects.filter(user=person).exists()
    assert not Session.objects.filter(user_id=str(person.pk)).exists()
    assert admin_row(admin, person) == (False, True, False, True)


# --- сцены пробы ревьюера ---------------------------------------------------------------------------------------


def test_password_change_in_flight_neither_switches_on_nor_signs_in(admin, person):
    browser = signed_in(person)
    real_check = User.check_password
    switched_off = []

    def check_while_the_admin_switches_off(self, raw_password):
        result = real_check(self, raw_password)
        if not switched_off:
            suspend_user(person.id, actor=admin, reason="посреди смены пароля")
            switched_off.append(logout_time_of(person))
        return result

    with patch.object(User, "check_password", check_while_the_admin_switches_off):
        response = browser.post(
            "/auth/change-password/",
            {"old_password": PASSWORD, "new_password": NEW_PASSWORD},
            content_type="application/json",
        )

    assert switched_off
    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json()["error_message"] == DEACTIVATED
    assert_still_switched_off(admin, person, switched_off[0])
    assert browser.get("/api/users/me/").status_code == status.HTTP_401_UNAUTHORIZED


def test_profile_edit_in_flight_does_not_switch_the_person_back_on(admin, person, instance):
    browser = signed_in(person)
    real_validate = UserSerializer.validate_first_name
    switched_off = []

    def validate_while_the_admin_switches_off(self, value):
        if not switched_off:
            suspend_user(person.id, actor=admin, reason="посреди правки профиля")
            switched_off.append(logout_time_of(person))
        return real_validate(self, value)

    with patch.object(UserSerializer, "validate_first_name", validate_while_the_admin_switches_off):
        browser.patch("/api/users/me/", {"first_name": "Иван"}, content_type="application/json")

    assert switched_off
    assert_still_switched_off(admin, person, switched_off[0])
    # …and a password sign-in afterwards is still refused.
    signer = Client(HTTP_USER_AGENT="Mozilla/5.0 (PPM tests)")
    sign_in = signer.post("/auth/sign-in/", {"email": person.email, "password": PASSWORD})
    assert sign_in.status_code == 302
    assert DEACTIVATED in sign_in.url, sign_in.url
    assert "_auth_user_id" not in signer.session
    person.refresh_from_db()
    assert person.is_active is False


def test_setting_a_first_password_in_flight_does_not_sign_in(admin):
    person = make("autoset", is_password_autoset=True)
    browser = signed_in(person)
    switched_off = []

    def score_while_the_admin_switches_off(password):
        if not switched_off:
            suspend_user(person.id, actor=admin, reason="посреди установки пароля")
            switched_off.append(logout_time_of(person))
        return {"score": 4}

    with patch("plane.authentication.views.common.zxcvbn", score_while_the_admin_switches_off):
        response = browser.post("/auth/set-password/", {"password": NEW_PASSWORD}, content_type="application/json")

    assert switched_off
    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json()["error_message"] == DEACTIVATED
    assert_still_switched_off(admin, person, switched_off[0])


# --- сохранение устаревшего объекта -----------------------------------------------------------------------------


def test_a_stale_full_save_keeps_the_other_changes_but_not_the_switch(admin, person):
    stale = User.objects.get(pk=person.pk)
    suspend_user(person.id, actor=admin)
    logout_time = logout_time_of(person)

    stale.first_name = "Пётр"
    stale.last_logout_time = None
    stale.save()

    person.refresh_from_db()
    assert (person.is_active, person.last_logout_time, person.first_name) == (False, logout_time, "Пётр")
    assert stale.is_active is False


@pytest.mark.parametrize("fields", [["is_active"], ["is_active", "last_logout_time"], ["first_name"]])
def test_a_stale_partial_save_never_switches_on(admin, person, fields):
    original_first_name = person.first_name
    stale = User.objects.get(pk=person.pk)
    suspend_user(person.id, actor=admin)
    logout_time = logout_time_of(person)

    stale.first_name = "Пётр"
    stale.last_logout_time = None
    stale.save(update_fields=fields)

    person.refresh_from_db()
    assert (person.is_active, person.last_logout_time) == (False, logout_time)
    assert person.first_name == ("Пётр" if "first_name" in fields else original_first_name)


def test_a_person_without_the_mark_is_switched_on_by_plane_as_before(person):
    """Plane's own activation of an inactive account (no PPM mark) is untouched."""
    User.objects.filter(pk=person.pk).update(is_active=False)
    person.refresh_from_db()

    person.is_active = True
    person.save()

    person.refresh_from_db()
    assert person.is_active is True


def test_an_ordinary_save_never_reads_the_suspension_table(person):
    """The owner's dev API runs this code before migration ppm_core 0001 is applied."""
    person.first_name = "Анна"
    with CaptureQueriesContext(connection) as queries:
        person.save()

    assert not [query["sql"] for query in queries.captured_queries if "ppm_user_suspensions" in query["sql"]]


# --- операторская команда ----------------------------------------------------------------------------------------


def test_activate_user_switches_a_suspended_person_back_on_like_the_center(admin, person):
    suspend_user(person.id, actor=admin)
    out = io.StringIO()

    call_command("activate_user", person.email, stdout=out)

    person.refresh_from_db()
    assert person.is_active is True
    assert not PpmUserSuspension.objects.filter(user=person).exists()
    assert "switched off in the PPM admin center" in out.getvalue()


def test_activate_user_still_activates_a_person_without_the_mark(person):
    User.objects.filter(pk=person.pk).update(is_active=False, last_logout_time=timezone.now())
    out = io.StringIO()

    call_command("activate_user", person.email, stdout=out)

    person.refresh_from_db()
    assert person.is_active is True
    assert out.getvalue().strip().endswith("User activated successfully")
