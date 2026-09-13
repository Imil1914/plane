from enum import Enum

from plane.db.models import Project, ProjectMember, WorkspaceMember
from plane.db.models.project import ROLE


class PpmCanvasAccess(str, Enum):
    DENY = "deny"
    EDIT = "edit"
    READ = "read"


def get_ppm_canvas_access(*, user, workspace_id, project_id):
    if not user or not user.is_authenticated:
        return PpmCanvasAccess.DENY

    project_exists = Project.objects.filter(
        id=project_id,
        workspace_id=workspace_id,
        deleted_at__isnull=True,
    ).exists()
    if not project_exists:
        return PpmCanvasAccess.DENY

    workspace_member_exists = WorkspaceMember.objects.filter(
        workspace_id=workspace_id,
        member=user,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()
    if not workspace_member_exists:
        return PpmCanvasAccess.DENY

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
        return PpmCanvasAccess.EDIT
    if role == ROLE.GUEST.value:
        return PpmCanvasAccess.READ
    return PpmCanvasAccess.DENY
