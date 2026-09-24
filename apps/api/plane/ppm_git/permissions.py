from plane.db.models import ProjectMember
from plane.db.models.project import ROLE
from plane.ppm_core.permissions import PpmProjectAccess, get_ppm_project_access, is_ppm_global_admin


def get_ppm_git_capabilities(*, user, workspace_id, project_id):
    access = get_ppm_project_access(user=user, workspace_id=workspace_id, project_id=project_id)
    if access == PpmProjectAccess.DENY:
        return access, {
            "read": False,
            "manage_repositories": False,
            "manage_links": False,
            "manage_provider": False,
            "manage_write_actions": False,
        }

    if is_ppm_global_admin(user=user, workspace_id=workspace_id):
        return access, {
            "read": True,
            "manage_repositories": True,
            "manage_links": True,
            "manage_provider": True,
            "manage_write_actions": True,
        }

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
    return access, {
        "read": True,
        "manage_repositories": role == ROLE.ADMIN.value,
        "manage_links": role in (ROLE.ADMIN.value, ROLE.MEMBER.value),
        "manage_provider": role == ROLE.ADMIN.value,
        "manage_write_actions": role in (ROLE.ADMIN.value, ROLE.MEMBER.value),
    }
