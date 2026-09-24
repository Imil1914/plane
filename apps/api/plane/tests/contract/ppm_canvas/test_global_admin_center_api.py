import uuid

import pytest
from django.test import override_settings
from django.utils import timezone
from rest_framework import status

from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminAudit
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix="admin-center", password=None):
    marker = uuid.uuid4().hex
    user = UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")
    if password:
        user.set_password(password)
        user.save(update_fields=["password"])
    return user


@pytest.fixture
def admin_center_data():
    global_admin = make_user("global-admin", "PpmAdmin-2026!")
    regular_user = make_user("regular-user")
    first_owner = make_user("first-owner")
    second_owner = make_user("second-owner")
    first_workspace = WorkspaceFactory(owner=first_owner, name="Робототехника")
    second_workspace = WorkspaceFactory(owner=second_owner, name="Биоматериалы")
    WorkspaceMemberFactory(workspace=first_workspace, member=first_owner, role=20)
    WorkspaceMemberFactory(workspace=second_workspace, member=second_owner, role=20)
    WorkspaceMemberFactory(workspace=first_workspace, member=regular_user, role=15)
    first_project = ProjectFactory(
        workspace=first_workspace,
        name="Робот",
        identifier="ROBOT",
        project_lead=first_owner,
    )
    second_project = ProjectFactory(
        workspace=second_workspace,
        name="Сплав",
        identifier="ALLOY",
        project_lead=second_owner,
        archived_at=timezone.now(),
    )
    ProjectMemberFactory(workspace=first_workspace, project=first_project, member=first_owner, role=20)
    ProjectMemberFactory(workspace=first_workspace, project=first_project, member=regular_user, role=15)
    ProjectMemberFactory(workspace=second_workspace, project=second_project, member=second_owner, role=20)
    registry = PpmGlobalAdmin.objects.create(user=global_admin, reason="Владелец PPM")
    return {
        "global_admin": global_admin,
        "regular_user": regular_user,
        "first_workspace": first_workspace,
        "second_workspace": second_workspace,
        "first_project": first_project,
        "second_project": second_project,
        "registry": registry,
    }


def test_access_endpoint_exposes_only_protected_global_role(api_client, admin_center_data):
    api_client.force_authenticate(user=admin_center_data["regular_user"])
    regular = api_client.get("/api/ppm/v1/admin/access/")
    api_client.force_authenticate(user=admin_center_data["global_admin"])
    admin = api_client.get("/api/ppm/v1/admin/access/")

    assert regular.status_code == status.HTTP_200_OK
    assert regular.data["is_global_admin"] is False
    assert admin.status_code == status.HTTP_200_OK
    assert admin.data["is_global_admin"] is True
    assert admin.data["role"] == "ppm_global_admin"


def test_global_admin_searches_all_projects_and_sees_actual_integration_state(api_client, admin_center_data):
    api_client.force_authenticate(user=admin_center_data["global_admin"])

    all_projects = api_client.get("/api/ppm/v1/admin/projects/?page_size=10")
    filtered = api_client.get("/api/ppm/v1/admin/projects/?q=ALLOY")

    assert all_projects.status_code == status.HTTP_200_OK
    assert all_projects.data["pagination"]["total"] == 2
    assert {row["identifier"] for row in all_projects.data["results"]} == {"ROBOT", "ALLOY"}
    assert filtered.status_code == status.HTTP_200_OK
    assert filtered.data["results"][0]["status"] == "archived"
    assert filtered.data["results"][0]["integrations"]["canvas"]["status"] == "not_created"
    assert filtered.data["results"][0]["integrations"]["git"] == {
        "status": "not_configured",
        "available": False,
    }
    assert PpmGlobalAdminAudit.objects.filter(action="admin_projects_list").count() == 2


def test_global_admin_searches_users_without_exposing_credentials(api_client, admin_center_data):
    api_client.force_authenticate(user=admin_center_data["global_admin"])

    response = api_client.get("/api/ppm/v1/admin/users/?q=regular-user")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["pagination"]["total"] == 1
    user = response.data["results"][0]
    assert user["is_global_admin"] is False
    assert user["workspace_count"] == 1
    assert user["project_count"] == 1
    assert "password" not in user
    assert "token" not in user


def test_enter_project_returns_explicit_admin_mode_and_is_audited(api_client, admin_center_data):
    api_client.force_authenticate(user=admin_center_data["global_admin"])
    project = admin_center_data["second_project"]

    response = api_client.post(f"/api/ppm/v1/admin/projects/{project.id}/enter/", {}, format="json")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["admin_mode"] is True
    assert response.data["navigation_url"].endswith(f"/projects/{project.id}/overview?ppm_admin_mode=1")
    audit = PpmGlobalAdminAudit.objects.get(action="project_admin_mode_enter")
    assert audit.project_id == project.id
    assert audit.workspace_id == project.workspace_id


@pytest.mark.parametrize("endpoint", ["projects/", "users/", "audit/", "reauthenticate/"])
def test_project_roles_never_grant_admin_center_access(api_client, admin_center_data, endpoint):
    api_client.force_authenticate(user=admin_center_data["regular_user"])
    method = api_client.post if endpoint == "reauthenticate/" else api_client.get

    response = method(f"/api/ppm/v1/admin/{endpoint}")

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_revoked_global_admin_loses_direct_url_access(api_client, admin_center_data):
    registry = admin_center_data["registry"]
    registry.revoked_at = timezone.now()
    registry.revoked_by = admin_center_data["regular_user"].id
    registry.save(update_fields=["revoked_at", "revoked_by"])
    api_client.force_authenticate(user=admin_center_data["global_admin"])

    response = api_client.get("/api/ppm/v1/admin/projects/")

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_reauthentication_requires_current_password_and_expires(api_client, admin_center_data):
    api_client.force_authenticate(user=admin_center_data["global_admin"])

    invalid = api_client.post(
        "/api/ppm/v1/admin/reauthenticate/",
        {"password": "wrong-password"},
        format="json",
    )
    valid = api_client.post(
        "/api/ppm/v1/admin/reauthenticate/",
        {"password": "PpmAdmin-2026!"},
        format="json",
    )
    access = api_client.get("/api/ppm/v1/admin/access/")

    assert invalid.status_code == status.HTTP_403_FORBIDDEN
    assert invalid.data["error"]["code"] == "ADMIN_REAUTH_FAILED"
    assert valid.status_code == status.HTTP_200_OK
    assert valid.data["reauthenticated"] is True
    assert access.data["reauthenticated_until"] is not None
    assert PpmGlobalAdminAudit.objects.filter(action="admin_reauth_failed").exists()
    assert PpmGlobalAdminAudit.objects.filter(action="admin_reauth_succeeded").exists()


def test_invalid_pagination_is_rejected(api_client, admin_center_data):
    api_client.force_authenticate(user=admin_center_data["global_admin"])

    response = api_client.get("/api/ppm/v1/admin/projects/?page=0&page_size=1000")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == "ADMIN_INVALID_PAGINATION"


@override_settings(PPM_ADMIN_CENTER_ENABLED=False)
def test_admin_center_feature_flag_does_not_revoke_registry(api_client, admin_center_data):
    api_client.force_authenticate(user=admin_center_data["global_admin"])

    access = api_client.get("/api/ppm/v1/admin/access/")
    projects = api_client.get("/api/ppm/v1/admin/projects/")

    assert access.status_code == status.HTTP_200_OK
    assert access.data["is_global_admin"] is False
    assert projects.status_code == status.HTTP_404_NOT_FOUND
    assert PpmGlobalAdmin.objects.filter(id=admin_center_data["registry"].id, revoked_at__isnull=True).exists()
