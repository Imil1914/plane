"""Protected PPM roles and invalid invitations in Plane's project roster."""

import uuid
from unittest.mock import patch

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models import ProjectMember
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def setup_project():
    marker = uuid.uuid4().hex
    owner = UserFactory(username=f"roster-owner-{marker}")
    lead = UserFactory(username=f"roster-lead-{marker}")
    global_admin = UserFactory(username=f"roster-global-{marker}")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=15)
    project = ProjectFactory(workspace=workspace, identifier="RSTR")
    ProjectMemberFactory(workspace=workspace, project=project, member=lead, role=20)
    PpmGlobalAdmin.objects.create(user=global_admin, reason="Project roster contract test")
    return owner, lead, global_admin, workspace, project


def test_roster_only_labels_protected_registry_users_as_global_admin(api_client):
    owner, lead, global_admin, workspace, project = setup_project()
    api_client.force_authenticate(user=lead)

    response = api_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/")

    assert response.status_code == status.HTTP_200_OK, response.data
    by_user = {str(entry["member"]): entry for entry in response.data}
    assert str(owner.id) not in by_user
    assert by_user[str(lead.id)]["role"] == 20
    assert by_user[str(global_admin.id)]["role"] == 20
    assert by_user[str(global_admin.id)]["id"] is None


def test_revoked_global_admin_disappears_from_project_roster(api_client):
    _, lead, global_admin, workspace, project = setup_project()
    PpmGlobalAdmin.objects.filter(user=global_admin).update(revoked_at=timezone.now())
    api_client.force_authenticate(user=lead)

    response = api_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/")

    assert response.status_code == status.HTTP_200_OK, response.data
    assert str(global_admin.id) not in {str(entry["member"]) for entry in response.data}


def test_inviting_non_workspace_user_returns_validation_error(api_client):
    _, lead, _, workspace, project = setup_project()
    candidate = UserFactory(username=f"roster-candidate-{uuid.uuid4().hex}")
    api_client.force_authenticate(user=lead)

    response = api_client.post(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/",
        {"members": [{"member_id": str(candidate.id), "role": 15}]},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    assert "workspace" in response.data["error"].lower()


def test_workspace_owner_without_protected_role_can_join_project(api_client):
    owner, lead, _, workspace, project = setup_project()
    api_client.force_authenticate(user=lead)

    with patch("plane.app.views.project.member.project_add_user_email.delay"):
        response = api_client.post(
            f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/",
            {"members": [{"member_id": str(owner.id), "role": 15}]},
            format="json",
        )

    assert response.status_code == status.HTTP_201_CREATED, response.data
    assert any(str(entry["member"]) == str(owner.id) and entry["role"] == 15 for entry in response.data)


def test_protected_global_admin_cannot_be_assigned_a_project_role(api_client):
    _, lead, global_admin, workspace, project = setup_project()
    api_client.force_authenticate(user=lead)

    response = api_client.post(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/",
        {"members": [{"member_id": str(global_admin.id), "role": 15}]},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    assert "global administrator" in response.data["error"].lower()


@pytest.mark.parametrize(
    "payload",
    [
        {"members": "invalid"},
        {"members": [None]},
        {"members": [{"member_id": "invalid", "role": 15}]},
        {"members": [{"member_id": str(uuid.uuid4()), "role": 999}]},
    ],
)
def test_malformed_project_invitation_is_rejected(api_client, payload):
    _, lead, _, workspace, project = setup_project()
    api_client.force_authenticate(user=lead)

    response = api_client.post(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/",
        payload,
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    assert ProjectMember.objects.filter(project=project).count() == 1


@pytest.mark.parametrize("role", ["invalid", 999])
def test_global_admin_cannot_assign_invalid_project_role(api_client, role):
    _, lead, global_admin, workspace, project = setup_project()
    target = ProjectMember.objects.get(project=project, member=lead)
    api_client.force_authenticate(user=global_admin)

    response = api_client.patch(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/{target.id}/",
        {"role": role},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
    target.refresh_from_db()
    assert target.role == 20
