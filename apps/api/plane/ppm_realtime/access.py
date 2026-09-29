"""UX2.1 — who may read what, for many projects at once, and whether the sign-in of a socket still holds.

``project_scopes`` is the Canvas read rule (``plane.ppm_canvas.permissions.get_ppm_canvas_access``) evaluated for any
number of projects in a fixed handful of queries, so that the 15-second re-check of a socket with 50 subscriptions does
not cost 200. ``test_access.py`` compares it with ``get_ppm_canvas_access`` role by role.
"""

from importlib import import_module

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.utils.crypto import constant_time_compare

from plane.db.models import Project, ProjectMember, WorkspaceMember
from plane.db.models.project import ROLE
from plane.ppm_core.permissions import is_ppm_global_admin


# What a subscription may see: everything, or — a guest without «guest_view_all_features» — own work items only.
EVERYTHING = "everything"
OWN_WORK_ITEMS = "own_work_items"


def is_workspace_member(user, workspace_id):
    return WorkspaceMember.objects.filter(
        workspace_id=workspace_id,
        member=user,
        is_active=True,
        deleted_at__isnull=True,
    ).exists()


def project_scopes(user, workspace_id, project_ids, *, global_admin=None, workspace_member=None):
    """project id → ``EVERYTHING`` | ``OWN_WORK_ITEMS`` | None (no read access), by the Canvas read rule.

    ``global_admin``/``workspace_member`` may be passed when the caller already knows them (one query each otherwise).
    Queries: projects, global admin, workspace membership, project roles — four at most, for any number of projects.
    """
    ids = [str(project_id) for project_id in project_ids]
    denied = dict.fromkeys(ids)
    if not ids or not user or not user.is_authenticated or not user.is_active:
        return denied
    projects = {
        str(project_id): sees_everything
        for project_id, sees_everything in Project.objects.filter(
            id__in=ids, workspace_id=workspace_id, deleted_at__isnull=True
        ).values_list("id", "guest_view_all_features")
    }
    if not projects:
        return denied
    if global_admin is None:
        global_admin = is_ppm_global_admin(user=user)
    if global_admin:
        return {project_id: EVERYTHING if project_id in projects else None for project_id in ids}
    if workspace_member is None:
        workspace_member = is_workspace_member(user, workspace_id)
    if not workspace_member:
        return denied
    roles = {}
    for project_id, role in (
        ProjectMember.objects.filter(
            workspace_id=workspace_id,
            project_id__in=list(projects),
            member=user,
            is_active=True,
            deleted_at__isnull=True,
        )
        .order_by("-created_at")
        .values_list("project_id", "role")
    ):
        roles.setdefault(str(project_id), role)
    scopes = {}
    for project_id in ids:
        role = roles.get(project_id) if project_id in projects else None
        if role in (ROLE.ADMIN.value, ROLE.MEMBER.value):
            scopes[project_id] = EVERYTHING
        elif role == ROLE.GUEST.value:
            # A guest: the REST API shows everything only with «guest_view_all_features», otherwise own items only.
            scopes[project_id] = EVERYTHING if projects[project_id] else OWN_WORK_ITEMS
        else:
            scopes[project_id] = None
    return scopes


def session_is_valid(session_key, user):
    """Is the browser session the socket signed in with still the user's session?

    Sign-out deletes it, expiry ends it, a password change invalidates its hash — the same checks as Django's
    ``get_user``, but read-only (a socket has no response to carry a new cookie, so nothing is rotated or flushed).
    A socket without a Django session (not opened by the browser stack) has nothing to verify.
    """
    if not session_key:
        return True
    data = import_module(settings.SESSION_ENGINE).SessionStore(session_key=session_key).load()
    if str(data.get(SESSION_KEY)) != str(user.pk):
        return False
    if data.get(BACKEND_SESSION_KEY) not in settings.AUTHENTICATION_BACKENDS:
        return False
    session_hash = data.get(HASH_SESSION_KEY)
    if not session_hash:
        return False
    if constant_time_compare(session_hash, user.get_session_auth_hash()):
        return True
    return any(
        constant_time_compare(session_hash, fallback_hash) for fallback_hash in user.get_session_auth_fallback_hash()
    )
