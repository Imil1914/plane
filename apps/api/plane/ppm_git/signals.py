"""G2.2 R16 — changes in PPM that move code access on the Git server schedule a synchronization (``forgejo_access``).

Membership and roles (project, workspace), people, PPM global administrators, Forgejo connections, projects and
workspaces. Every handler returns at once unless single sign-on is configured — the settings alone decide, so the
owner's dev API (without migration 0009) never reads a new table — and only schedules: the work runs ≈5 s after the
transaction commits, one task for a burst of changes. Saves that touch nothing access depends on (view preferences,
synchronization bookkeeping, last activity) schedule nothing.

Bulk writes send no signal at all. The two that add people to projects call ``schedule_access_sync`` themselves:
``ProjectMemberViewSet.create`` (the main way to add members — ``bulk_update``/``bulk_create``) and
``process_workspace_project_invitations`` (sign-in with accepted invitations). The other bulk changes come together
with a signalled save of the same person (leaving a workspace, self-deactivation, a workspace role lowered to guest —
the person's scope finds every team to leave or change); anything else is caught by the full reconciliation (every
10 minutes).
"""

from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from plane.db.models import Project, ProjectMember, User, Workspace, WorkspaceMember
from plane.ppm_canvas.models import PpmGlobalAdmin

from . import forgejo_access
from .models import PpmForgejoAccount, PpmGitConnection, PpmGitConnectionStatus, PpmGitInstallation, PpmGitProvider


MEMBER_FIELDS = frozenset({"role", "is_active", "deleted_at", "member", "member_id", "project", "project_id"})
WORKSPACE_MEMBER_FIELDS = frozenset({"role", "is_active", "deleted_at", "member", "member_id", "workspace"})
USER_FIELDS = frozenset({"is_active", "is_bot", "email", "display_name", "first_name", "last_name"})
PROJECT_FIELDS = frozenset({"identifier", "name", "deleted_at", "workspace", "workspace_id"})
WORKSPACE_FIELDS = frozenset({"name", "slug", "deleted_at"})
CONNECTION_FIELDS = frozenset(
    {"provider_repository_id", "provider_full_name", "installation", "installation_id", "repository", "project_id"}
)
# A synchronization moves a connection between the active states (syncing, error, …) all the time; only leaving the
# project changes who reaches the repository.
LEAVING_STATUSES = frozenset({PpmGitConnectionStatus.DISCONNECTED, PpmGitConnectionStatus.REVOKED})


def _off(kwargs):
    return kwargs.get("raw") or not forgejo_access.forgejo_sso_is_configured()


def _touches(update_fields, fields):
    return update_fields is None or bool(set(update_fields) & fields)


def _has_account(user_id):
    return PpmForgejoAccount.objects.filter(user_id=user_id).exists()


@receiver(post_save, sender=ProjectMember, dispatch_uid="ppm_git_forgejo_access_project_member_saved")
def project_member_saved(sender, instance, update_fields=None, **kwargs):
    if _off(kwargs) or not _touches(update_fields, MEMBER_FIELDS):
        return
    forgejo_access.schedule_access_sync(project_ids=[instance.project_id])


@receiver(post_delete, sender=ProjectMember, dispatch_uid="ppm_git_forgejo_access_project_member_deleted")
def project_member_deleted(sender, instance, **kwargs):
    if _off(kwargs):
        return
    forgejo_access.schedule_access_sync(project_ids=[instance.project_id])


@receiver(post_save, sender=WorkspaceMember, dispatch_uid="ppm_git_forgejo_access_workspace_member_saved")
def workspace_member_saved(sender, instance, update_fields=None, **kwargs):
    # Leaving a workspace deactivates the person's project memberships with a bulk update: the person's scope finds the
    # teams to leave through the Git server itself.
    if _off(kwargs) or not _touches(update_fields, WORKSPACE_MEMBER_FIELDS) or instance.member_id is None:
        return
    forgejo_access.schedule_access_sync(user_ids=[instance.member_id])


@receiver(post_delete, sender=WorkspaceMember, dispatch_uid="ppm_git_forgejo_access_workspace_member_deleted")
def workspace_member_deleted(sender, instance, **kwargs):
    if _off(kwargs) or instance.member_id is None:
        return
    forgejo_access.schedule_access_sync(user_ids=[instance.member_id])


@receiver(post_save, sender=User, dispatch_uid="ppm_git_forgejo_access_user_saved")
def user_saved(sender, instance, update_fields=None, **kwargs):
    # Every sign-in saves the person: only people with a Git server account and a change that matters are scheduled.
    if _off(kwargs) or not _touches(update_fields, USER_FIELDS) or not _has_account(instance.id):
        return
    forgejo_access.schedule_access_sync(user_ids=[instance.id])


@receiver(post_delete, sender=User, dispatch_uid="ppm_git_forgejo_access_user_deleted")
def user_deleted(sender, instance, **kwargs):
    # The account row outlives the person (a plain UUID): the synchronization locks the account out.
    if _off(kwargs) or not _has_account(instance.id):
        return
    forgejo_access.schedule_access_sync(user_ids=[instance.id])


@receiver(post_save, sender=PpmGlobalAdmin, dispatch_uid="ppm_git_forgejo_access_global_admin_saved")
@receiver(post_delete, sender=PpmGlobalAdmin, dispatch_uid="ppm_git_forgejo_access_global_admin_deleted")
def global_admin_changed(sender, instance, **kwargs):
    if _off(kwargs):
        return
    forgejo_access.schedule_access_sync(user_ids=[instance.user_id])


def _forgejo_connection(instance):
    provider = PpmGitInstallation.objects.filter(id=instance.installation_id).values_list("provider", flat=True).first()
    return provider == PpmGitProvider.FORGEJO


@receiver(post_save, sender=PpmGitConnection, dispatch_uid="ppm_git_forgejo_access_connection_saved")
def connection_saved(sender, instance, update_fields=None, **kwargs):
    if _off(kwargs):
        return
    fields = set(update_fields) if update_fields is not None else None
    moved = fields is None or bool(fields & CONNECTION_FIELDS)
    left = fields is not None and "status" in fields and instance.status in LEAVING_STATUSES
    if not (moved or left) or not _forgejo_connection(instance):
        return
    forgejo_access.schedule_access_sync(project_ids=[instance.project_id])


@receiver(post_delete, sender=PpmGitConnection, dispatch_uid="ppm_git_forgejo_access_connection_deleted")
def connection_deleted(sender, instance, **kwargs):
    if _off(kwargs) or not _forgejo_connection(instance):
        return
    forgejo_access.schedule_access_sync(project_ids=[instance.project_id])


@receiver(post_save, sender=Project, dispatch_uid="ppm_git_forgejo_access_project_saved")
def project_saved(sender, instance, update_fields=None, **kwargs):
    # A new key renames the project's teams, a new name rewrites their descriptions, a (soft) deletion removes them.
    if _off(kwargs) or not _touches(update_fields, PROJECT_FIELDS):
        return
    forgejo_access.schedule_access_sync(project_ids=[instance.id])


@receiver(post_delete, sender=Project, dispatch_uid="ppm_git_forgejo_access_project_deleted")
def project_deleted(sender, instance, **kwargs):
    if _off(kwargs):
        return
    forgejo_access.schedule_access_sync(project_ids=[instance.id])


@receiver(post_save, sender=Workspace, dispatch_uid="ppm_git_forgejo_access_workspace_saved")
def workspace_saved(sender, instance, update_fields=None, **kwargs):
    if _off(kwargs) or not _touches(update_fields, WORKSPACE_FIELDS):
        return
    forgejo_access.schedule_access_sync(workspace_ids=[instance.id])


@receiver(post_delete, sender=Workspace, dispatch_uid="ppm_git_forgejo_access_workspace_deleted")
def workspace_deleted(sender, instance, **kwargs):
    if _off(kwargs):
        return
    forgejo_access.schedule_access_sync(workspace_ids=[instance.id])
