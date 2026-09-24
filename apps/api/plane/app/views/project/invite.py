# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import jwt
from datetime import datetime

# Django imports
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.conf import settings
from django.utils import timezone

# Third Party imports
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import AllowAny

# Module imports
from .base import BaseViewSet, BaseAPIView
from plane.app.serializers import (
    ProjectMemberInviteSerializer,
    ProjectMemberInvitePublicSerializer,
)
from plane.app.permissions import allow_permission, ROLE
from plane.db.models import (
    ProjectMember,
    Workspace,
    ProjectMemberInvite,
    WorkspaceMember,
)
from plane.utils.host import base_host
from plane.bgtasks.project_invitation_task import project_invitation


class ProjectInvitationsViewset(BaseViewSet):
    serializer_class = ProjectMemberInviteSerializer
    model = ProjectMemberInvite

    search_fields = []

    def get_queryset(self):
        return self.filter_queryset(
            super()
            .get_queryset()
            .filter(workspace__slug=self.kwargs.get("slug"))
            .filter(project_id=self.kwargs.get("project_id"))
            .select_related("project")
            .select_related("workspace", "workspace__owner")
        )

    @allow_permission([ROLE.ADMIN])
    def create(self, request, slug, project_id):
        emails = request.data.get("emails", [])

        # Check if email is provided
        if not emails:
            return Response({"error": "Emails are required"}, status=status.HTTP_400_BAD_REQUEST)

        for email in emails:
            workspace_role = (
                WorkspaceMember.objects.filter(workspace__slug=slug, member__email=email.get("email"), is_active=True)
                .values_list("role", flat=True)
                .first()
            )

            if workspace_role == ROLE.GUEST.value and workspace_role != email.get("role", ROLE.GUEST.value):
                return Response({"error": "You cannot invite a user with different role than workspace role"})

        workspace = Workspace.objects.get(slug=slug)

        project_invitations = []
        for email in emails:
            try:
                validate_email(email.get("email"))
                project_invitations.append(
                    ProjectMemberInvite(
                        email=email.get("email").strip().lower(),
                        project_id=project_id,
                        workspace_id=workspace.id,
                        token=jwt.encode(
                            {"email": email, "timestamp": datetime.now().timestamp()},
                            settings.SECRET_KEY,
                            algorithm="HS256",
                        ),
                        role=email.get("role", 5),
                        created_by=request.user,
                    )
                )
            except ValidationError:
                return Response(
                    {
                        "error": f"Invalid email - {email} provided a valid email address is required to send the invite"  # noqa: E501
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Create workspace member invite
        project_invitations = ProjectMemberInvite.objects.bulk_create(
            project_invitations, batch_size=10, ignore_conflicts=True
        )
        current_site = base_host(request=request, is_app=True)

        # Send invitations
        for invitation in project_invitations:
            project_invitation.delay(
                invitation.email,
                project_id,
                invitation.token,
                current_site,
                request.user.email,
            )

        return Response({"message": "Email sent successfully"}, status=status.HTTP_200_OK)


class UserProjectInvitationsViewset(BaseViewSet):
    serializer_class = ProjectMemberInviteSerializer
    model = ProjectMemberInvite

    def get_queryset(self):
        return self.filter_queryset(
            super()
            .get_queryset()
            .filter(email=self.request.user.email)
            .select_related("workspace", "workspace__owner", "project")
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def create(self, request, slug):
        return Response(
            {"error": "Project access requires an invitation from the project lead."},
            status=status.HTTP_403_FORBIDDEN,
        )


class ProjectJoinEndpoint(BaseAPIView):
    permission_classes = [AllowAny]

    def post(self, request, slug, project_id, pk):
        project_invite = ProjectMemberInvite.objects.get(pk=pk, project_id=project_id, workspace__slug=slug)

        token = request.data.get("token", "")

        # Validate the token to verify the user received the invitation email
        if not token or project_invite.token != token:
            return Response(
                {"error": "You do not have permission to join the project"},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Require an authenticated session — the accepting user must be the
        # person who was invited.  Without this check an attacker who knows the
        # invitee email and obtains the token can hijack the project membership
        # (GHSA-g36h-p63v-g9c7).
        if not request.user.is_authenticated:
            return Response(
                {"error": "Authentication required to accept project invitation"},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        if request.user.email.lower() != project_invite.email.lower():
            return Response(
                {"error": "You do not have permission to accept this invitation"},
                status=status.HTTP_403_FORBIDDEN,
            )

        if project_invite.responded_at is None:
            accepted = request.data.get("accepted", False)
            if not isinstance(accepted, bool):
                return Response(
                    {"error": "`accepted` must be a boolean"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            project_invite.accepted = accepted
            project_invite.responded_at = timezone.now()
            project_invite.save()

            if project_invite.accepted:
                # Use the authenticated user directly — they've already been
                # validated as the invite recipient above.
                user = request.user

                # Check if user is a part of workspace
                workspace_member = WorkspaceMember.objects.filter(workspace__slug=slug, member=user).first()
                # Add him to workspace
                if workspace_member is None:
                    _ = WorkspaceMember.objects.create(
                        workspace_id=project_invite.workspace_id,
                        member=user,
                        role=(15 if project_invite.role >= 15 else project_invite.role),
                    )
                else:
                    # Else make him active
                    workspace_member.is_active = True
                    workspace_member.save()

                # Check if the user was already a member of project then activate the user
                project_member = ProjectMember.objects.filter(
                    workspace_id=project_invite.workspace_id,
                    project_id=project_id,
                    member=user,
                ).first()
                if project_member is None:
                    # Create a Project Member
                    _ = ProjectMember.objects.create(
                        project_id=project_id,
                        member=user,
                        role=project_invite.role,
                    )
                else:
                    project_member.is_active = True
                    project_member.role = project_invite.role
                    project_member.save()

                return Response(
                    {"message": "Project Invitation Accepted"},
                    status=status.HTTP_200_OK,
                )

            return Response(
                {"message": "Project Invitation was not accepted"},
                status=status.HTTP_200_OK,
            )

        return Response(
            {"error": "You have already responded to the invitation request"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    def get(self, request, slug, project_id, pk):
        project_invitation = ProjectMemberInvite.objects.get(workspace__slug=slug, project_id=project_id, pk=pk)
        serializer = ProjectMemberInvitePublicSerializer(project_invitation)
        return Response(serializer.data, status=status.HTTP_200_OK)
