"""G2.2 R15a — «Отключить» / «Включить» пользователя в центре администратора PPM.

Только глобальный администратор PPM (остальным — 403, выключатель центра — 404). Нельзя себя, глобальных
администраторов PPM, администраторов экземпляра PPM (/god-mode) и служебные учётки. Отключение: ``is_active=False``,
время выхода, пометка ``PpmUserSuspension`` (отличает отключение администратором от самостоятельной деактивации
Plane), все сессии человека завершаются (PPM и /god-mode живут в одной таблице ``sessions``), членство в пространствах
и проектах не трогается — «Включить» возвращает человека к работе как было; аудит центра. Список пользователей отдаёт
признак «отключён администратором» и что с человеком можно сделать.
"""

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.db import connection
from django.test import Client, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.db.models import Profile, ProjectMember, Session, User, WorkspaceMember
from plane.license.models import Instance, InstanceAdmin
from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminAudit
from plane.ppm_core.models import PpmUserSuspension
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]

USERS = "/api/ppm/v1/admin/users/"


def suspend_url(user_id):
    return f"{USERS}{user_id}/suspend/"


def resume_url(user_id):
    return f"{USERS}{user_id}/resume/"


def make_user(prefix, **fields):
    marker = uuid.uuid4().hex[:10]
    return UserFactory(email=f"{prefix}-{marker}@ppm.test", username=f"{prefix}-{marker}", **fields)


def signed_in(user):
    """A browser of ``user`` already signed in to PPM (a real row in ``sessions``)."""
    client = Client()
    client.force_login(user)
    return client


def make_instance_admin(user):
    instance = Instance.objects.first() or Instance.objects.create(
        instance_name="PPM",
        instance_id=uuid.uuid4().hex,
        current_version="1.0.0",
        last_checked_at=timezone.now(),
        is_setup_done=True,
    )
    return InstanceAdmin.objects.create(user=user, instance=instance)


@pytest.fixture
def people(db):
    admin = make_user("admin", display_name="Главный")
    PpmGlobalAdmin.objects.create(user=admin, reason="Владелец PPM")
    member = make_user("member", display_name="Иван Петров")
    workspace = WorkspaceFactory(owner=admin, name="Робототехника")
    WorkspaceMemberFactory(workspace=workspace, member=admin, role=20)
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    project = ProjectFactory(workspace=workspace, identifier="ROBOT", name="Робот")
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    return SimpleNamespace(admin=admin, member=member, workspace=workspace, project=project)


@pytest.fixture
def as_admin(api_client, people):
    api_client.force_authenticate(user=people.admin)
    return api_client


# --- права ------------------------------------------------------------------------------------------------------


def test_only_a_global_administrator_switches_people_off_and_on(api_client, people):
    workspace_admin = make_user("workspace-admin")
    WorkspaceMemberFactory(workspace=people.workspace, member=workspace_admin, role=20)
    api_client.force_authenticate(user=workspace_admin)

    refused = [api_client.post(suspend_url(people.member.id)), api_client.post(resume_url(people.member.id))]
    api_client.force_authenticate(user=None)
    anonymous = api_client.post(suspend_url(people.member.id))

    assert [response.status_code for response in refused] == [status.HTTP_403_FORBIDDEN] * 2
    assert anonymous.status_code == status.HTTP_401_UNAUTHORIZED
    assert anonymous.data["error"]["code"] == "AUTHENTICATION_REQUIRED"
    people.member.refresh_from_db()
    assert people.member.is_active is True
    assert not PpmUserSuspension.objects.exists()


def test_revoked_global_administrator_is_refused(api_client, people):
    PpmGlobalAdmin.objects.filter(user=people.admin).update(revoked_at=timezone.now())
    api_client.force_authenticate(user=people.admin)

    response = api_client.post(suspend_url(people.member.id))

    assert response.status_code == status.HTTP_403_FORBIDDEN
    people.member.refresh_from_db()
    assert people.member.is_active is True


@override_settings(PPM_ADMIN_CENTER_ENABLED=False)
def test_admin_center_switch_hides_both_actions(as_admin, people):
    suspended = as_admin.post(suspend_url(people.member.id))
    resumed = as_admin.post(resume_url(people.member.id))

    assert suspended.status_code == resumed.status_code == status.HTTP_404_NOT_FOUND
    people.member.refresh_from_db()
    assert people.member.is_active is True
    assert PpmGlobalAdmin.objects.filter(user=people.admin, revoked_at__isnull=True).exists()


# --- кого нельзя ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["self", "global_admin", "instance_admin", "bot"])
def test_protected_people_cannot_be_switched_off(as_admin, people, kind):
    if kind == "self":
        target = people.admin
    elif kind == "global_admin":
        target = make_user("second-admin")
        PpmGlobalAdmin.objects.create(user=target, reason="Второй администратор")
    elif kind == "instance_admin":
        target = make_user("god-mode")
        make_instance_admin(target)
    else:
        target = make_user("seed-bot", is_bot=True, bot_type="WORKSPACE_SEED")

    response = as_admin.post(suspend_url(target.id))

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert response.data["error"]["code"] == "ADMIN_USER_PROTECTED"
    assert response.data["error"]["details"] == {"reason": kind}
    assert response.data["error"]["message"]
    target.refresh_from_db()
    assert target.is_active is True
    assert not PpmUserSuspension.objects.filter(user=target).exists()
    assert not PpmGlobalAdminAudit.objects.filter(action="user_suspended").exists()


def test_unknown_person_is_404(as_admin):
    missing = uuid.uuid4()

    for response in (as_admin.post(suspend_url(missing)), as_admin.post(resume_url(missing))):
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert response.data["error"]["code"] == "ADMIN_USER_NOT_FOUND"


@pytest.mark.parametrize("reason", ["x" * 501, 42, ["Уволился"]])
def test_reason_is_optional_text_up_to_500_characters(as_admin, people, reason):
    response = as_admin.post(suspend_url(people.member.id), {"reason": reason}, format="json")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == "ADMIN_SUSPEND_REASON_INVALID"
    people.member.refresh_from_db()
    assert people.member.is_active is True


def test_person_who_deactivated_their_own_account_is_not_touched(as_admin, people):
    """Plane's own «Деактивировать аккаунт» works as before: the center neither suspends nor re-enables such a person
    (the account lost its memberships and password — it is not a switch to flip back)."""
    member = people.member
    Profile.objects.get_or_create(user=member)
    with patch("plane.app.views.user.base.user_deactivation_email"):
        assert signed_in(member).delete("/api/users/me/").status_code == status.HTTP_204_NO_CONTENT

    suspended = as_admin.post(suspend_url(member.id))
    resumed = as_admin.post(resume_url(member.id))

    assert suspended.status_code == status.HTTP_409_CONFLICT
    assert suspended.data["error"]["code"] == "ADMIN_USER_DEACTIVATED"
    assert resumed.status_code == status.HTTP_409_CONFLICT
    assert resumed.data["error"]["code"] == "ADMIN_USER_NOT_SUSPENDED"
    member.refresh_from_db()
    assert member.is_active is False
    assert not PpmUserSuspension.objects.exists()


# --- отключение и включение -------------------------------------------------------------------------------------


def test_switching_off_locks_the_person_out_and_ends_every_session(as_admin, people):
    member = people.member
    laptop, phone = signed_in(member), signed_in(member)
    bystander = make_user("bystander")
    bystander_browser = signed_in(bystander)
    assert laptop.get("/api/users/me/").status_code == status.HTTP_200_OK

    response = as_admin.post(suspend_url(member.id), {"reason": "  Уволился  "}, format="json")

    assert response.status_code == status.HTTP_200_OK
    row = response.data
    assert row["user_id"] == str(member.id)
    assert (row["is_active"], row["is_suspended"], row["can_suspend"], row["can_resume"]) == (False, True, False, True)
    assert row["suspended_at"] is not None
    member.refresh_from_db()
    assert member.is_active is False
    assert member.last_logout_time is not None
    suspension = PpmUserSuspension.objects.get(user=member)
    assert suspension.suspended_by == people.admin.id
    assert suspension.reason == "Уволился"
    # Every session of the person is gone, nobody else's.
    assert not Session.objects.filter(user_id=str(member.id)).exists()
    assert laptop.get("/api/users/me/").status_code == status.HTTP_401_UNAUTHORIZED
    assert phone.get("/api/users/me/").status_code == status.HTTP_401_UNAUTHORIZED
    assert bystander_browser.get("/api/users/me/").status_code == status.HTTP_200_OK
    # Memberships stay: «Включить» brings the person back to their projects (and to their code, R15).
    assert WorkspaceMember.objects.get(workspace=people.workspace, member=member).is_active is True
    assert ProjectMember.objects.get(project=people.project, member=member).is_active is True
    audit = PpmGlobalAdminAudit.objects.get(action="user_suspended")
    assert audit.global_admin.user_id == people.admin.id
    assert audit.metadata == {
        "user_id": str(member.id),
        "email": member.email,
        "reason": "Уволился",
        "sessions_ended": 2,
    }


def test_switching_off_twice_changes_nothing_the_second_time(as_admin, people):
    first = as_admin.post(suspend_url(people.member.id))
    second = as_admin.post(suspend_url(people.member.id))

    assert first.status_code == second.status_code == status.HTTP_200_OK
    assert second.data["is_suspended"] is True
    assert PpmUserSuspension.objects.filter(user=people.member).count() == 1
    assert PpmGlobalAdminAudit.objects.filter(action="user_suspended").count() == 1


def test_switching_on_restores_the_person(as_admin, people):
    member = people.member
    as_admin.post(suspend_url(member.id), {"reason": "Отпуск"}, format="json")

    response = as_admin.post(resume_url(member.id))

    assert response.status_code == status.HTTP_200_OK
    row = response.data
    assert (row["is_active"], row["is_suspended"], row["can_suspend"], row["can_resume"]) == (True, False, True, False)
    assert row["suspended_at"] is None
    member.refresh_from_db()
    assert member.is_active is True
    assert not PpmUserSuspension.objects.filter(user=member).exists()
    audit = PpmGlobalAdminAudit.objects.get(action="user_resumed")
    assert audit.metadata["user_id"] == str(member.id)
    assert audit.metadata["email"] == member.email
    assert audit.metadata["suspended_at"]


def test_switching_on_an_active_person_changes_nothing(as_admin, people):
    response = as_admin.post(resume_url(people.member.id))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["is_active"] is True
    assert not PpmGlobalAdminAudit.objects.filter(action="user_resumed").exists()


def test_a_suspension_left_on_an_active_person_is_applied_again(as_admin, people):
    """A stale mark (the person was switched back on outside the center) never blocks switching off anew."""
    PpmUserSuspension.objects.create(user=people.member, suspended_by=people.admin.id)

    response = as_admin.post(suspend_url(people.member.id))

    assert response.status_code == status.HTTP_200_OK
    people.member.refresh_from_db()
    assert people.member.is_active is False
    assert PpmGlobalAdminAudit.objects.filter(action="user_suspended").count() == 1


# --- список пользователей ---------------------------------------------------------------------------------------


def test_user_list_tells_who_is_switched_off_and_what_can_be_done(as_admin, people):
    suspended = make_user("suspended")
    as_admin.post(suspend_url(suspended.id))
    deactivated = make_user("deactivated")
    User.objects.filter(pk=deactivated.pk).update(is_active=False, last_logout_time=timezone.now())
    second_admin = make_user("second-admin")
    PpmGlobalAdmin.objects.create(user=second_admin, reason="Второй администратор")
    god_mode = make_user("god-mode")
    make_instance_admin(god_mode)
    bot = make_user("seed-bot", is_bot=True, bot_type="WORKSPACE_SEED")

    response = as_admin.get(f"{USERS}?page_size=100")

    assert response.status_code == status.HTTP_200_OK
    rows = {row["user_id"]: row for row in response.data["results"]}

    def state(user):
        row = rows[str(user.id)]
        return row["is_active"], row["is_suspended"], row["can_suspend"], row["can_resume"]

    assert state(people.member) == (True, False, True, False)
    assert state(suspended) == (False, True, False, True)
    assert rows[str(suspended.id)]["suspended_at"] is not None
    assert state(deactivated) == (False, False, False, False)
    for protected in (people.admin, second_admin, god_mode, bot):
        assert state(protected)[2:] == (False, False), protected.email
    assert rows[str(people.member.id)]["suspended_at"] is None


def test_user_list_without_inactive_people_never_reads_the_suspension_table(as_admin, people):
    """The owner's dev API runs this code before migration ppm_core 0001 is applied: an ordinary list (nobody
    inactive on the page) must not touch the new table."""
    with CaptureQueriesContext(connection) as queries:
        response = as_admin.get(USERS)

    assert response.status_code == status.HTTP_200_OK
    assert not [query["sql"] for query in queries.captured_queries if "ppm_user_suspensions" in query["sql"]]
