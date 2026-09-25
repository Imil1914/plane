from enum import Enum

from django.conf import settings

from plane.db.models import Project, ProjectMember, WorkspaceMember
from plane.db.models.project import ROLE
from plane.ppm_canvas.models import PpmGlobalAdmin


class PpmProjectAccess(str, Enum):
    DENY = "deny"
    EDIT = "edit"
    READ = "read"


def is_ppm_global_admin(*, user, workspace_id=None, workspace_slug=None):
    """Return whether the user has the protected platform-wide PPM role."""
    if not user or not user.is_authenticated or not user.is_active:
        return False
    if not getattr(settings, "PPM_GLOBAL_ADMIN_ENABLED", True):
        return False
    return PpmGlobalAdmin.objects.filter(user=user, revoked_at__isnull=True).exists()


def get_ppm_project_access(*, user, workspace_id, project_id):
    """Resolve project capabilities from Plane membership only."""
    if not user or not user.is_authenticated or not user.is_active:
        return PpmProjectAccess.DENY

    project_exists = Project.objects.filter(
        id=project_id,
        workspace_id=workspace_id,
        deleted_at__isnull=True,
    ).exists()
    if not project_exists:
        return PpmProjectAccess.DENY

    if is_ppm_global_admin(user=user, workspace_id=workspace_id):
        return PpmProjectAccess.EDIT

    workspace_member_exists = WorkspaceMember.objects.filter(
        workspace_id=workspace_id,
        member=user,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()
    if not workspace_member_exists:
        return PpmProjectAccess.DENY

    role = (
        ProjectMember.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            member=user,
            is_active=True,
            deleted_at__isnull=True,
        )
        .values_list("role", flat=True)
        .first()
    )
    if role in (ROLE.ADMIN.value, ROLE.MEMBER.value):
        return PpmProjectAccess.EDIT
    if role == ROLE.GUEST.value:
        return PpmProjectAccess.READ
    return PpmProjectAccess.DENY
