from plane.db.models import ProjectMember
from plane.db.models.project import ROLE
from plane.ppm_core.permissions import PpmProjectAccess, get_ppm_project_access, is_ppm_global_admin

from .forgejo_access import forgejo_sso_is_configured


def get_ppm_git_capabilities(*, user, workspace_id, project_id):
    access = get_ppm_project_access(user=user, workspace_id=workspace_id, project_id=project_id)
    if access == PpmProjectAccess.DENY:
        return access, {
            "read": False,
            "manage_repositories": False,
            "manage_links": False,
            "manage_provider": False,
            "manage_write_actions": False,
            "manage_git_server": False,
            "connect_git_server_repositories": False,
        }

    if is_ppm_global_admin(user=user, workspace_id=workspace_id):
        return access, {
            "read": True,
            "manage_repositories": True,
            "manage_links": True,
            "manage_provider": True,
            "manage_write_actions": True,
            # G2.1: repositories of PPM's own Git server are connected and disconnected only by a PPM global
            # administrator — its service account sees the code of every team.
            "manage_git_server": True,
            # G2.2 R17: the global administrator connects any repository of the Git server, as in G2.1.
            "connect_git_server_repositories": True,
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
        "manage_git_server": False,
        # G2.2 R17: with single sign-on the project administrator connects and disconnects the repositories of the
        # workspace's organization they administer on the Git server (each connect is checked there as that person).
        # The check is settings only — no database, no network.
        "connect_git_server_repositories": role == ROLE.ADMIN.value and forgejo_sso_is_configured(),
    }
