import uuid

from django.conf import settings
from django.db import models


class PpmUserSuspension(models.Model):
    """G2.2 R15a: a person switched off by a PPM global administrator in the administration center.

    Plane knows only ``User.is_active``, which a person who deactivates their own account (``DELETE /api/users/me/``)
    loses too. This row is what makes the difference: only such a person may be switched back on by the center, and
    signing in never switches them back on (``plane.authentication.adapter.base.Adapter.save_user_data``). One row per
    person while switched off; «Включить» deletes it — the history stays in the center's audit.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="ppm_suspension",
    )
    # The global administrator's user id — a plain UUID, as ``PpmGlobalAdmin.created_by``: outlives that person.
    suspended_by = models.UUIDField(null=True, blank=True)
    reason = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ppm_user_suspensions"
