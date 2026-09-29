# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.utils import timezone

# Module imports
from plane.db.models import (
    ProjectMember,
    ProjectMemberInvite,
    WorkspaceMember,
    WorkspaceMemberInvite,
)
from plane.utils.cache import invalidate_cache_directly
from plane.bgtasks.event_tracking_task import track_event
from plane.utils.analytics_events import USER_JOINED_WORKSPACE


def process_workspace_project_invitations(user):
    """This function takes in User and adds him to all workspace and projects that the user has accepted invited of"""

    # Check if user has any accepted invites for workspace and add them to workspace
    workspace_member_invites = WorkspaceMemberInvite.objects.filter(email=user.email, accepted=True)

    WorkspaceMember.objects.bulk_create(
        [
            WorkspaceMember(
                workspace_id=workspace_member_invite.workspace_id,
                member=user,
                role=workspace_member_invite.role,
            )
            for workspace_member_invite in workspace_member_invites
        ],
        ignore_conflicts=True,
    )

    for workspace_member_invite in workspace_member_invites:
        invalidate_cache_directly(
            path=f"/api/workspaces/{str(workspace_member_invite.workspace.slug)}/members/",
            url_params=False,
            user=False,
            multiple=True,
        )
        track_event.delay(
            user_id=user.id,
            event_name=USER_JOINED_WORKSPACE,
            slug=workspace_member_invite.workspace.slug,
            event_properties={
                "user_id": user.id,
                "workspace_id": workspace_member_invite.workspace.id,
                "workspace_slug": workspace_member_invite.workspace.slug,
                "role": workspace_member_invite.role,
                "joined_at": str(timezone.now().isoformat()),
            },
        )

    # Check if user has any project invites
    project_member_invites = ProjectMemberInvite.objects.filter(email=user.email, accepted=True)

    # Add user to workspace
    WorkspaceMember.objects.bulk_create(
        [
            WorkspaceMember(
                workspace_id=project_member_invite.workspace_id,
                role=(project_member_invite.role if project_member_invite.role in [5, 15] else 15),
                member=user,
                created_by_id=project_member_invite.created_by_id,
            )
            for project_member_invite in project_member_invites
        ],
        ignore_conflicts=True,
    )

    # Now add the users to project
    ProjectMember.objects.bulk_create(
        [
            ProjectMember(
                workspace_id=project_member_invite.workspace_id,
                role=(project_member_invite.role if project_member_invite.role in [5, 15] else 15),
                member=user,
                created_by_id=project_member_invite.created_by_id,
            )
            for project_member_invite in project_member_invites
        ],
        ignore_conflicts=True,
    )

    # G2.2 R16: bulk writes send no model signals — code access on PPM's Git server follows the new project
    # memberships (after the commit, ≈5 s later; a no-op unless single sign-on is configured). Only when there were
    # invitations to projects: a sign-in without them changes no team.
    invited_project_ids = [invite.project_id for invite in project_member_invites if invite.project_id]
    if invited_project_ids:
        from plane.ppm_git.forgejo_access import schedule_access_sync

        schedule_access_sync(user_ids=[user.id], project_ids=invited_project_ids)

    # Delete all the invites
    workspace_member_invites.delete()
    project_member_invites.delete()
