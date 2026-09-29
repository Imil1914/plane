"""G2.2 R15a — a PPM global administrator switches a person off and back on (administration center, «Пользователи»).

Switching off: ``is_active=False`` together with the logout time (Plane's own mark of an explicitly deactivated
account, which its sign-in already refuses), a ``PpmUserSuspension`` row (only such a person can be switched back on,
and neither signing in — ``refuses_sign_in`` — nor saving a stale ``User`` — ``keep_switched_off`` — switches them
back on), every session of the person ended (PPM and /god-mode sessions share the ``sessions`` table). The person is
saved with a signalled ``save`` on purpose: line S1 then deletes the codes and tokens issued to the Git server, line
S2a schedules the access synchronization that sets ``prohibit_login`` there and leaves the PPM teams (R15).
Memberships stay as they are — switching back on returns the person to their projects and to their code.

Plane's self-deactivation (``DELETE /api/users/me/``) is not this: that person is inactive without a row, the center
neither switches them off again nor on.
"""

from django.db import transaction
from django.utils import timezone

from plane.db.models import Session, User
from plane.license.models import InstanceAdmin
from plane.ppm_canvas.models import PpmGlobalAdmin

from .models import PpmUserSuspension

REASON_MAX_LENGTH = 500

PROTECTED_MESSAGES = {
    "self": "Нельзя отключить самого себя.",
    "global_admin": "Главного администратора PPM отключить нельзя.",
    "instance_admin": "Администратора экземпляра PPM отключить нельзя.",
    "bot": "Служебную учётную запись отключить нельзя.",
}


class SuspensionRefused(Exception):
    """An action the center refuses — the view turns it into ``ppm_error_response``."""

    def __init__(self, code, message, status_code, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


def protected_ids(user_ids):
    """(global administrators of PPM, administrators of the PPM instance) among ``user_ids``."""
    user_ids = list(user_ids)
    global_admins = set(
        PpmGlobalAdmin.objects.filter(user_id__in=user_ids, revoked_at__isnull=True).values_list("user_id", flat=True)
    )
    instance_admins = set(InstanceAdmin.objects.filter(user_id__in=user_ids).values_list("user_id", flat=True))
    return global_admins, instance_admins


def protection_reason(user, *, actor_id, global_admin_ids, instance_admin_ids):
    """Why ``user`` may not be switched off by ``actor_id`` — ``None`` when nothing protects the person."""
    if user.pk == actor_id:
        return "self"
    if user.pk in global_admin_ids:
        return "global_admin"
    if user.pk in instance_admin_ids:
        return "instance_admin"
    if user.is_bot:
        return "bot"
    return None


def suspensions_of(users):
    """``{user_id: switched off at}`` among ``users``. Only inactive people are looked up: a page of active people never
    reads the table (the owner's dev API runs this code before migration ppm_core 0001 is applied)."""
    inactive = [user.pk for user in users if not user.is_active]
    if not inactive:
        return {}
    return dict(PpmUserSuspension.objects.filter(user_id__in=inactive).values_list("user_id", "created_at"))


def _locked_user(user_id):
    user = User.objects.select_for_update().filter(pk=user_id).first()
    if user is None:
        raise SuspensionRefused("ADMIN_USER_NOT_FOUND", "Пользователь не найден.", 404)
    return user


def suspend_user(user_id, *, actor, reason=""):
    """Switches the person off. Returns ``(user, change)``; ``change`` is ``None`` when the person already was."""
    with transaction.atomic():
        user = _locked_user(user_id)
        global_admin_ids, instance_admin_ids = protected_ids([user.pk])
        kind = protection_reason(
            user, actor_id=actor.pk, global_admin_ids=global_admin_ids, instance_admin_ids=instance_admin_ids
        )
        if kind:
            raise SuspensionRefused("ADMIN_USER_PROTECTED", PROTECTED_MESSAGES[kind], 403, {"reason": kind})
        suspended = PpmUserSuspension.objects.filter(user=user).exists()
        if not user.is_active:
            if suspended:
                return user, None
            raise SuspensionRefused(
                "ADMIN_USER_DEACTIVATED",
                "Пользователь сам деактивировал учётную запись — отключать нечего.",
                409,
            )
        # A mark left on an active person (switched back on outside the center) is replaced, not trusted.
        PpmUserSuspension.objects.filter(user=user).delete()
        PpmUserSuspension.objects.create(user=user, suspended_by=actor.pk, reason=reason)
        user.is_active = False
        user.last_logout_time = timezone.now()
        user.save(update_fields=["is_active", "last_logout_time", "updated_at"])
        sessions_ended, _ = Session.objects.filter(user_id=str(user.pk)).delete()
        return user, {"sessions_ended": sessions_ended}


def resume_user(user_id):
    """Switches the person back on. Returns ``(user, change)``; ``change`` is ``None`` when the person already was.

    The mark goes first: while it is there, ``keep_switched_off`` keeps any save of the person switched off."""
    with transaction.atomic():
        user = _locked_user(user_id)
        suspension = PpmUserSuspension.objects.filter(user=user).first()
        if suspension is None:
            if user.is_active:
                return user, None
            raise SuspensionRefused(
                "ADMIN_USER_NOT_SUSPENDED",
                "Пользователь сам деактивировал учётную запись — включить её из центра администратора нельзя.",
                409,
            )
        suspended_at = suspension.created_at
        suspension.delete()
        if not user.is_active:
            user.is_active = True
            user.save(update_fields=["is_active", "updated_at"])
        return user, {"suspended_at": suspended_at.isoformat()}


def keep_switched_off(sender, instance, raw=False, update_fields=None, **kwargs):
    """``pre_save`` of ``User``: a save never switches back on a person whom a PPM global administrator switched off.

    A request of the person that started before «Отключить» committed — a password change, a profile edit, the profile
    sync of a sign-in — holds the old ``User`` (``is_active=True``) and saves it whole afterwards. While the mark is
    there, such a save keeps the person switched off, the logout time as stored; everything else it changes is saved.
    Only «Включить» (``resume_user``, the mark goes first) and ``manage.py activate_user`` (the same way) switch the
    person back on.

    The row is read under a lock, so a switch-off still in progress is waited for, not missed. An active row — every
    ordinary save — ends it there: the suspension table is read only for an inactive person (the owner's dev API runs
    this before migration ppm_core 0001 is applied).
    """
    if raw or instance._state.adding or not instance.is_active:
        return
    if update_fields is not None and "is_active" not in update_fields:
        return
    with transaction.atomic():
        stored = (
            User.objects.select_for_update(no_key=True)
            .filter(pk=instance.pk)
            .values("is_active", "last_logout_time")
            .first()
        )
    if stored is None or stored["is_active"]:
        return
    if not PpmUserSuspension.objects.filter(user_id=instance.pk).exists():
        return
    instance.is_active = False
    instance.last_logout_time = stored["last_logout_time"]


def refuses_sign_in(user):
    """True for a person switched off by a PPM global administrator — every sign-in method asks before switching an
    inactive account on (``Adapter.save_user_data``).

    Reads the person's row again: ``user`` may have been read by a sign-in that started before the switch-off landed.
    The suspension table is read only for an inactive person, so an ordinary sign-in never touches it.
    """
    if user is None or user.pk is None:
        return False
    is_active = User.objects.filter(pk=user.pk).values_list("is_active", flat=True).first()
    if is_active is not False:
        return False
    return PpmUserSuspension.objects.filter(user_id=user.pk).exists()
