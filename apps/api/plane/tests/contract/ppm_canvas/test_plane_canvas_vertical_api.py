"""Exercise the Plane-to-Canvas path through both public HTTP APIs."""

import uuid
from unittest.mock import patch

import pytest
from rest_framework import status

from plane.db.models import Issue, Project, State
from plane.ppm_canvas.models import PpmGlobalAdmin, PpmCanvasBinding
from plane.tests.factories import UserFactory, WorkspaceFactory, WorkspaceMemberFactory


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def test_native_project_issue_and_canvas_projection_share_one_source(api_client):
    marker = uuid.uuid4().hex
    admin = UserFactory(username=f"vertical-admin-{marker}")
    lead = UserFactory(username=f"vertical-lead-{marker}")
    outsider = UserFactory(username=f"vertical-outsider-{marker}")
    workspace = WorkspaceFactory(owner=admin)
    for user in (admin, lead, outsider):
        WorkspaceMemberFactory(workspace=workspace, member=user, role=20 if user == admin else 15)
    PpmGlobalAdmin.objects.create(user=admin, reason="Backend contract test")

    native_projects_url = f"/api/workspaces/{workspace.slug}/projects/"
    api_client.force_authenticate(user=admin)
    with patch("plane.app.views.project.base.model_activity.delay"):
        created_project = api_client.post(
            native_projects_url,
            {"name": "Canvas integration", "identifier": "CINT"},
            format="json",
        )
    assert created_project.status_code == status.HTTP_201_CREATED, created_project.data
    project = Project.objects.get(id=created_project.data["id"])

    with patch("plane.app.views.project.member.project_add_user_email.delay"):
        invited = api_client.post(
            f"{native_projects_url}{project.id}/members/",
            {"members": [{"member_id": str(lead.id), "role": 15}]},
            format="json",
        )
    assert invited.status_code == status.HTTP_201_CREATED, invited.data

    api_client.force_authenticate(user=lead)
    native_issues_url = f"{native_projects_url}{project.id}/issues/"
    initial_state = State.objects.get(project=project, default=True)
    with (
        patch("plane.app.views.issue.base.issue_activity.delay"),
        patch("plane.app.views.issue.base.model_activity.delay"),
        patch("plane.app.views.issue.base.issue_description_version_task.delay"),
    ):
        created_issue = api_client.post(
            native_issues_url,
            {"name": "From Plane", "state_id": str(initial_state.id)},
            format="json",
        )
    assert created_issue.status_code == status.HTTP_201_CREATED, created_issue.data
    issue = Issue.objects.get(id=created_issue.data["id"])

    canvas_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/canvas/"
    binding_url = f"{canvas_url}bindings/"
    board = api_client.get(canvas_url)
    assert board.status_code == status.HTTP_200_OK, board.data
    shape_id = "shape:plane-canvas-vertical"
    binding = api_client.post(
        binding_url,
        {
            "shape_id": shape_id,
            "entity_type": "work_item",
            "entity_id": str(issue.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert binding.status_code == status.HTTP_201_CREATED, binding.data
    saved = api_client.put(
        canvas_url,
        {
            "schema_version": 2,
            "base_version": 0,
            "snapshot": {
                "document": {"store": {shape_id: {"id": shape_id, "typeName": "shape", "type": "ppm-canvas-node"}}}
            },
            "client_operation_id": str(uuid.uuid4()),
            "binding_changes": {"activate": [binding.data["binding_id"]], "remove": []},
        },
        format="json",
    )
    assert saved.status_code == status.HTTP_200_OK, saved.data

    with (
        patch("plane.app.views.issue.base.issue_activity.delay"),
        patch("plane.app.views.issue.base.model_activity.delay"),
        patch("plane.app.views.issue.base.issue_description_version_task.delay"),
    ):
        renamed = api_client.patch(f"{native_issues_url}{issue.id}/", {"name": "Updated in Plane"}, format="json")
    assert renamed.status_code == status.HTTP_204_NO_CONTENT, renamed.data
    projection = api_client.get(binding_url)
    assert projection.status_code == status.HTTP_200_OK, projection.data
    assert projection.data["bindings"][0]["source"]["display"]["title"] == "Updated in Plane"
    assert PpmCanvasBinding.objects.filter(project_id=project.id, entity_id=issue.id).count() == 1

    api_client.force_authenticate(user=outsider)
    assert api_client.get(canvas_url).status_code == status.HTTP_403_FORBIDDEN
    assert api_client.get(native_issues_url).status_code == status.HTTP_403_FORBIDDEN

    api_client.force_authenticate(user=admin)
    assert api_client.get(canvas_url).status_code == status.HTTP_200_OK
