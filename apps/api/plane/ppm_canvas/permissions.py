from enum import Enum

from plane.db.models import Project, ProjectMember, WorkspaceMember
from plane.db.models.project import ROLE
from plane.ppm_core.permissions import is_ppm_global_admin


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

    if is_ppm_global_admin(user=user):
        return PpmCanvasAccess.EDIT

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


def get_ppm_canvas_capabilities(*, user, workspace_id, project_id):
    access = get_ppm_canvas_access(user=user, workspace_id=workspace_id, project_id=project_id)
    if access == PpmCanvasAccess.DENY:
        return {
            "read": False,
            "edit": False,
            "create_board": False,
            "rename_board": False,
            "reorder_boards": False,
            "duplicate_board": False,
            "archive_board": False,
            "restore_board": False,
            "manage_canvas": False,
        }

    is_global_admin = is_ppm_global_admin(user=user)
    role = None
    if not is_global_admin:
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
    can_edit = access == PpmCanvasAccess.EDIT
    can_manage_lifecycle = is_global_admin or role == ROLE.ADMIN.value
    return {
        "read": True,
        "edit": can_edit,
        "create_board": can_edit,
        "rename_board": can_edit,
        "reorder_boards": can_edit,
        "duplicate_board": can_edit,
        "archive_board": can_manage_lifecycle,
        "restore_board": can_manage_lifecycle,
        "manage_canvas": can_manage_lifecycle,
    }
