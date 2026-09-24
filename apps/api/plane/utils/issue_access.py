"""Project-scoped visibility check for Work Item child resources."""

from plane.db.models import Issue, ProjectMember
from plane.db.models.project import ROLE
from plane.ppm_core.permissions import is_ppm_global_admin


def user_can_view_issue(*, user, slug, project_id, issue_id):
    if user.is_anonymous:
        return False
    issue = (
        Issue.issue_objects.filter(id=issue_id, workspace__slug=slug, project_id=project_id)
        .select_related("project")
        .first()
    )
    if issue is None:
        return False
    if is_ppm_global_admin(user=user, workspace_slug=slug):
        return True
    role = (
        ProjectMember.objects.filter(
            workspace__slug=slug,
            project_id=project_id,
            member=user,
            is_active=True,
        )
        .values_list("role", flat=True)
        .first()
    )
    return role is not None and (
        role > ROLE.GUEST.value
        or (role == ROLE.GUEST.value and (issue.project.guest_view_all_features or issue.created_by_id == user.id))
    )
