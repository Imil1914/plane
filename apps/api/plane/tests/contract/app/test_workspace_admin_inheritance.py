# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest
from rest_framework import status

from plane.db.models import (
    Project,
    ProjectMember,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceMemberInvite,
)
from plane.ppm_core.permissions import PpmProjectAccess, get_ppm_project_access, is_ppm_global_admin
from plane.ppm_canvas.models import PpmGlobalAdmin


@pytest.mark.contract
@pytest.mark.django_db
def test_protected_global_admin_sees_every_workspace_with_admin_role(
    session_client,
    workspace,
    create_user,
):
    other_owner = User.objects.create_user(email="other-owner@example.com", username="other-owner")
    other_workspace = Workspace.objects.create(name="Other Workspace", slug="other-workspace", owner=other_owner)
    WorkspaceMember.objects.create(workspace=other_workspace, member=other_owner, role=20)
    PpmGlobalAdmin.objects.create(user=create_user, reason="Contract test bootstrap")

    response = session_client.get("/api/users/me/workspaces/")

    assert response.status_code == status.HTTP_200_OK
    by_id = {str(item["id"]): item for item in response.data}
    assert {str(workspace.id), str(other_workspace.id)}.issubset(by_id)
    assert by_id[str(workspace.id)]["role"] == 20
    assert by_id[str(other_workspace.id)]["role"] == 20


@pytest.mark.contract
@pytest.mark.django_db
def test_regular_user_workspace_list_remains_membership_scoped(
    session_client,
    workspace,
):
    participant = User.objects.create_user(email="workspace-list@example.com", username="workspace-list")
    WorkspaceMember.objects.create(workspace=workspace, member=participant, role=15)
    other_owner = User.objects.create_user(email="hidden-owner@example.com", username="hidden-owner")
    hidden_workspace = Workspace.objects.create(name="Hidden Workspace", slug="hidden-workspace", owner=other_owner)
    WorkspaceMember.objects.create(workspace=hidden_workspace, member=other_owner, role=20)
    session_client.force_authenticate(user=participant)

    response = session_client.get("/api/users/me/workspaces/")

    assert response.status_code == status.HTTP_200_OK
    assert {str(item["id"]) for item in response.data} == {str(workspace.id)}


@pytest.mark.contract
@pytest.mark.django_db
def test_protected_global_admin_inherits_every_project_without_project_membership(
    session_client,
    workspace,
    create_user,
    monkeypatch,
):
    monkeypatch.setattr("plane.app.views.project.base.recent_visited_task.delay", lambda **kwargs: None)
    PpmGlobalAdmin.objects.create(user=create_user, reason="Contract test bootstrap")
    project = Project.objects.create(
        name="Inherited admin project",
        identifier="IAP",
        workspace=workspace,
        created_by=create_user,
    )

    assert not ProjectMember.objects.filter(project=project, member=create_user).exists()
    assert (
        get_ppm_project_access(
            user=create_user,
            workspace_id=workspace.id,
            project_id=project.id,
        )
        == PpmProjectAccess.EDIT
    )

    project_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/")
    assert project_response.status_code == status.HTTP_200_OK
    assert project_response.data["member_role"] == 20

    roles_response = session_client.get(f"/api/users/me/workspaces/{workspace.slug}/project-roles/")
    assert roles_response.status_code == status.HTTP_200_OK
    assert roles_response.data[str(project.id)] == 20

    me_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/project-members/me/")
    assert me_response.status_code == status.HTTP_200_OK
    assert me_response.data["id"] is None
    assert me_response.data["role"] == 20


@pytest.mark.contract
@pytest.mark.django_db
def test_disabled_account_does_not_inherit_protected_global_access(session_client, workspace, create_user):
    admin = User.objects.create_user(email="disabled-global@example.com", username="disabled-global")
    PpmGlobalAdmin.objects.create(user=admin, reason="Contract test bootstrap")
    project = Project.objects.create(
        name="Disabled admin target",
        identifier="DAT",
        workspace=workspace,
        created_by=create_user,
    )
    admin.is_active = False
    admin.save(update_fields=["is_active"])

    assert is_ppm_global_admin(user=admin) is False
    assert get_ppm_project_access(user=admin, workspace_id=workspace.id, project_id=project.id) == PpmProjectAccess.DENY

    session_client.force_authenticate(user=admin)
    response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/")
    assert response.status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.contract
@pytest.mark.django_db
def test_project_settings_cannot_demote_or_remove_global_admin(
    session_client,
    workspace,
    create_user,
):
    PpmGlobalAdmin.objects.create(user=create_user, reason="Contract test bootstrap")
    project = Project.objects.create(
        name="Protected admin project",
        identifier="PAP",
        workspace=workspace,
        created_by=create_user,
    )
    owner_membership = ProjectMember.objects.create(
        workspace=workspace,
        project=project,
        member=create_user,
        role=20,
    )

    update_response = session_client.patch(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/{owner_membership.id}/",
        {"role": 15},
        format="json",
    )
    assert update_response.status_code == status.HTTP_400_BAD_REQUEST

    remove_response = session_client.delete(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/{owner_membership.id}/"
    )
    assert remove_response.status_code == status.HTTP_400_BAD_REQUEST

    owner_membership.refresh_from_db()
    assert owner_membership.role == 20
    assert owner_membership.is_active is True


@pytest.mark.contract
@pytest.mark.django_db
def test_workspace_admin_without_project_membership_cannot_access_project(
    session_client,
    workspace,
    create_user,
    monkeypatch,
):
    monkeypatch.setattr("plane.app.views.project.base.recent_visited_task.delay", lambda **kwargs: None)
    workspace_admin = User.objects.create_user(
        email="workspace-admin@example.com",
        username="workspace-admin",
    )
    WorkspaceMember.objects.create(workspace=workspace, member=workspace_admin, role=20)
    project = Project.objects.create(
        name="Owner-only project",
        identifier="OOP",
        workspace=workspace,
        created_by=create_user,
    )
    session_client.force_authenticate(user=workspace_admin)

    assert (
        get_ppm_project_access(
            user=workspace_admin,
            workspace_id=workspace.id,
            project_id=project.id,
        )
        == PpmProjectAccess.DENY
    )

    list_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/")
    assert list_response.status_code == status.HTTP_200_OK
    assert str(project.id) not in {str(item["id"]) for item in list_response.data}

    project_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/")
    assert project_response.status_code == status.HTTP_403_FORBIDDEN

    roles_response = session_client.get(f"/api/users/me/workspaces/{workspace.slug}/project-roles/")
    assert roles_response.status_code == status.HTTP_200_OK
    assert str(project.id) not in roles_response.data

    me_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/project-members/me/")
    assert me_response.status_code == status.HTTP_403_FORBIDDEN

    self_join_response = session_client.post(
        f"/api/users/me/workspaces/{workspace.slug}/projects/invitations/",
        {"project_ids": [str(project.id)]},
        format="json",
    )
    assert self_join_response.status_code == status.HTTP_403_FORBIDDEN
    assert not ProjectMember.objects.filter(project=project, member=workspace_admin, is_active=True).exists()


@pytest.mark.contract
@pytest.mark.django_db
def test_project_lead_and_member_are_scoped_to_assigned_projects(
    session_client,
    workspace,
    create_user,
    monkeypatch,
):
    monkeypatch.setattr("plane.app.views.project.base.recent_visited_task.delay", lambda **kwargs: None)
    monkeypatch.setattr("plane.app.views.project.base.model_activity.delay", lambda **kwargs: None)
    assigned_project = Project.objects.create(
        name="Assigned project",
        identifier="ASP",
        workspace=workspace,
        created_by=create_user,
    )
    unrelated_project = Project.objects.create(
        name="Unrelated project",
        identifier="UNP",
        workspace=workspace,
        created_by=create_user,
    )
    project_lead = User.objects.create_user(email="lead@example.com", username="lead")
    WorkspaceMember.objects.create(workspace=workspace, member=project_lead, role=15)
    ProjectMember.objects.create(workspace=workspace, project=assigned_project, member=project_lead, role=20)
    session_client.force_authenticate(user=project_lead)

    list_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/")
    assert list_response.status_code == status.HTTP_200_OK
    assert {str(item["id"]) for item in list_response.data} == {str(assigned_project.id)}

    update_response = session_client.patch(
        f"/api/workspaces/{workspace.slug}/projects/{assigned_project.id}/",
        {"name": "Renamed by project lead"},
        format="json",
    )
    assert update_response.status_code == status.HTTP_200_OK

    unrelated_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{unrelated_project.id}/")
    assert unrelated_response.status_code == status.HTTP_403_FORBIDDEN

    member = User.objects.create_user(email="participant@example.com", username="participant")
    WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
    ProjectMember.objects.create(workspace=workspace, project=assigned_project, member=member, role=15)
    session_client.force_authenticate(user=member)

    member_read_response = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{assigned_project.id}/")
    assert member_read_response.status_code == status.HTTP_200_OK
    member_update_response = session_client.patch(
        f"/api/workspaces/{workspace.slug}/projects/{assigned_project.id}/",
        {"name": "Forbidden rename"},
        format="json",
    )
    assert member_update_response.status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.contract
@pytest.mark.django_db
def test_only_global_admin_can_create_projects(session_client, workspace):
    participant = User.objects.create_user(email="project-creator@example.com", username="project-creator")
    WorkspaceMember.objects.create(workspace=workspace, member=participant, role=15)
    session_client.force_authenticate(user=participant)

    response = session_client.post(
        f"/api/workspaces/{workspace.slug}/projects/",
        {"name": "Forbidden project", "identifier": "FRB"},
        format="json",
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert not Project.objects.filter(workspace=workspace, identifier="FRB").exists()


@pytest.mark.contract
@pytest.mark.django_db
def test_global_admin_role_cannot_be_granted_by_workspace_invitation(
    session_client,
    workspace,
):
    invitation = WorkspaceMemberInvite.objects.create(
        email="candidate@example.com",
        workspace=workspace,
        token="candidate-token",
        role=15,
        created_by=workspace.owner,
    )

    response = session_client.patch(
        f"/api/workspaces/{workspace.slug}/invitations/{invitation.id}/",
        {"role": 20},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    invitation.refresh_from_db()
    assert invitation.role == 15


@pytest.mark.contract
@pytest.mark.django_db
def test_project_lead_can_send_project_invitation(
    session_client,
    workspace,
    create_user,
    monkeypatch,
):
    project = Project.objects.create(
        name="Invitation project",
        identifier="IVP",
        workspace=workspace,
        created_by=create_user,
    )
    project_lead = User.objects.create_user(email="invite-lead@example.com", username="invite-lead")
    WorkspaceMember.objects.create(workspace=workspace, member=project_lead, role=15)
    ProjectMember.objects.create(workspace=workspace, project=project, member=project_lead, role=20)
    sent_invitations = []
    monkeypatch.setattr(
        "plane.app.views.project.invite.project_invitation.delay",
        lambda *args: sent_invitations.append(args),
    )
    session_client.force_authenticate(user=project_lead)

    response = session_client.post(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/invitations/",
        {"emails": [{"email": "new-participant@example.com", "role": 15}]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert len(sent_invitations) == 1
    assert sent_invitations[0][0] == "new-participant@example.com"
