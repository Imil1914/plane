"""File mutations must follow project edit rights, not merely workspace membership."""

from unittest.mock import patch
from uuid import uuid4

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import DraftIssue, FileAsset, Issue, IssueComment, Page, ProjectPage
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

STORAGE_PATH = "plane.app.views.asset.v2.S3Storage"


def authenticated_client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def asset_roles(create_user):
    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="AR")
    ProjectMemberFactory(workspace=workspace, project=project, member=create_user, role=20)

    guest = UserFactory(username=f"asset-guest-{uuid4().hex[:10]}")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)

    outsider = UserFactory(username=f"asset-outsider-{uuid4().hex[:10]}")
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=15)

    asset = FileAsset.objects.create(
        asset=f"{workspace.id}/cover.png",
        size=16,
        attributes={"name": "cover.png", "type": "image/png", "size": 16},
        workspace=workspace,
        project=project,
        created_by=create_user,
        entity_type=FileAsset.EntityTypeContext.PROJECT_COVER,
        is_uploaded=True,
    )
    return workspace, project, asset, guest, outsider


@pytest.mark.parametrize(
    ("route", "method", "payload"),
    [
        ("project", "post", {"name": "new.png", "type": "image/png", "size": 16, "entity_type": "PROJECT_COVER"}),
        ("project_detail", "patch", {}),
        ("project_detail", "delete", None),
        ("project_bulk", "post", {"asset_ids": []}),
        (
            "workspace",
            "post",
            {"name": "new.png", "type": "image/png", "size": 16, "entity_type": "PROJECT_COVER"},
        ),
        ("workspace_detail", "patch", {}),
        ("workspace_detail", "delete", None),
        ("restore", "post", {}),
    ],
)
def test_project_guest_cannot_mutate_asset(asset_roles, route, method, payload):
    workspace, project, asset, guest, _ = asset_roles
    urls = {
        "project": f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/",
        "project_detail": f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{asset.id}/",
        "project_bulk": f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{uuid4()}/bulk/",
        "workspace": f"/api/assets/v2/workspaces/{workspace.slug}/",
        "workspace_detail": f"/api/assets/v2/workspaces/{workspace.slug}/{asset.id}/",
        "restore": f"/api/assets/v2/workspaces/{workspace.slug}/restore/{asset.id}/",
    }
    if route == "workspace":
        payload = {**payload, "entity_identifier": str(project.id)}
    client = authenticated_client(guest)

    with patch(STORAGE_PATH) as storage:
        response = getattr(client, method)(urls[route], payload, format="json")

    assert response.status_code == status.HTTP_403_FORBIDDEN
    storage.assert_not_called()
    asset.refresh_from_db()
    assert asset.is_deleted is False
    assert asset.is_uploaded is True


def test_project_guest_can_still_read_asset(asset_roles):
    workspace, project, asset, guest, _ = asset_roles
    with patch(STORAGE_PATH) as storage:
        storage.return_value.generate_presigned_url.return_value = "https://signed.example/cover"
        response = authenticated_client(guest).get(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{asset.id}/"
        )

    assert response.status_code == status.HTTP_302_FOUND


def test_project_member_can_start_upload_through_both_routes(asset_roles, create_user):
    workspace, project, _, _, _ = asset_roles
    payload = {"name": "new.png", "type": "image/png", "size": 16, "entity_type": "PROJECT_COVER"}
    client = authenticated_client(create_user)
    with patch(STORAGE_PATH) as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://upload.example", "fields": {}}
        project_response = client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/", payload, format="json"
        )
        workspace_response = client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/",
            {**payload, "entity_identifier": str(project.id)},
            format="json",
        )

    assert project_response.status_code == status.HTTP_200_OK
    assert workspace_response.status_code == status.HTTP_200_OK


def test_project_asset_restore_requires_edit_access(asset_roles, create_user):
    workspace, _, asset, guest, outsider = asset_roles
    asset.is_deleted = True
    asset.deleted_at = timezone.now()
    asset.save(update_fields=["is_deleted", "deleted_at"])
    url = f"/api/assets/v2/workspaces/{workspace.slug}/restore/{asset.id}/"

    assert authenticated_client(guest).post(url, {}, format="json").status_code == status.HTTP_403_FORBIDDEN
    assert authenticated_client(outsider).post(url, {}, format="json").status_code == status.HTTP_403_FORBIDDEN
    assert authenticated_client(create_user).post(url, {}, format="json").status_code == status.HTTP_204_NO_CONTENT


def test_asset_existence_is_hidden_from_other_projects(asset_roles):
    workspace, _, asset, guest, outsider = asset_roles
    url = f"/api/assets/v2/workspaces/{workspace.slug}/check/{asset.id}/"

    assert authenticated_client(guest).get(url).data == {"exists": True}
    assert authenticated_client(outsider).get(url).data == {"exists": False}


def test_duplicate_asset_denies_cross_project_source(asset_roles):
    workspace, project, asset, _, outsider = asset_roles
    url = f"/api/assets/v2/workspaces/{workspace.slug}/duplicate-assets/{asset.id}/"
    with patch(STORAGE_PATH) as storage:
        response = authenticated_client(outsider).post(
            url,
            {"project_id": str(project.id), "entity_type": "PROJECT_COVER", "entity_id": str(project.id)},
            format="json",
        )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    storage.assert_not_called()


def test_duplicate_asset_denies_guest_destination(asset_roles):
    workspace, project, asset, guest, _ = asset_roles
    url = f"/api/assets/v2/workspaces/{workspace.slug}/duplicate-assets/{asset.id}/"
    with patch(STORAGE_PATH) as storage:
        response = authenticated_client(guest).post(
            url,
            {"project_id": str(project.id), "entity_type": "PROJECT_COVER", "entity_id": str(project.id)},
            format="json",
        )

    assert response.status_code == status.HTTP_403_FORBIDDEN
    storage.assert_not_called()


def test_workspace_member_cannot_change_workspace_logo(asset_roles):
    workspace, _, _, _, outsider = asset_roles
    logo = FileAsset.objects.create(
        asset=f"{workspace.id}/logo.png",
        size=16,
        attributes={"name": "logo.png", "type": "image/png", "size": 16},
        workspace=workspace,
        created_by=outsider,
        entity_type=FileAsset.EntityTypeContext.WORKSPACE_LOGO,
        is_uploaded=True,
    )
    url = f"/api/assets/v2/workspaces/{workspace.slug}/{logo.id}/"

    assert authenticated_client(outsider).delete(url).status_code == status.HTTP_403_FORBIDDEN
    logo.refresh_from_db()
    assert logo.is_deleted is False


def test_legacy_key_route_hides_other_project_asset(asset_roles):
    workspace, _, asset, guest, outsider = asset_roles
    url = f"/api/workspaces/file-assets/{workspace.id}/cover.png/"

    assert authenticated_client(guest).get(url).status_code == status.HTTP_200_OK
    assert authenticated_client(outsider).get(url).status_code == status.HTTP_403_FORBIDDEN
    assert authenticated_client(outsider).delete(url).status_code == status.HTTP_403_FORBIDDEN
    asset.refresh_from_db()
    assert asset.is_deleted is False


def test_legacy_key_route_requires_edit_for_delete_and_restore(asset_roles, create_user):
    workspace, _, asset, guest, outsider = asset_roles
    url = f"/api/workspaces/file-assets/{workspace.id}/cover.png/"
    restore_url = f"/api/workspaces/file-assets/{workspace.id}/cover.png/restore/"

    assert authenticated_client(guest).delete(url).status_code == status.HTTP_403_FORBIDDEN
    assert authenticated_client(create_user).delete(url).status_code == status.HTTP_204_NO_CONTENT
    asset.refresh_from_db()
    assert asset.is_deleted is True
    assert authenticated_client(guest).post(restore_url).status_code == status.HTTP_403_FORBIDDEN
    assert authenticated_client(outsider).post(restore_url).status_code == status.HTTP_403_FORBIDDEN
    assert authenticated_client(create_user).post(restore_url).status_code == status.HTTP_204_NO_CONTENT
    asset.refresh_from_db()
    assert asset.is_deleted is False


def test_legacy_upload_cannot_target_guest_project(asset_roles):
    workspace, project, _, guest, _ = asset_roles
    upload = SimpleUploadedFile("new.png", b"\x89PNG\r\n\x1a\n" + b"x" * 16, content_type="image/png")

    response = authenticated_client(guest).post(
        f"/api/workspaces/{workspace.slug}/file-assets/",
        {"asset": upload, "project": str(project.id), "entity_type": "PROJECT_COVER"},
        format="multipart",
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert not FileAsset.objects.filter(workspace=workspace, created_by=guest).exists()


@pytest.fixture
def cross_project_entities(asset_roles, create_user):
    workspace, own_project, source_asset, _, _ = asset_roles
    other_project = ProjectFactory(workspace=workspace, identifier="OTHER")
    own_issue = Issue.objects.create(name="Own issue", workspace=workspace, project=own_project)
    other_issue = Issue.objects.create(name="Other issue", workspace=workspace, project=other_project)
    other_comment = IssueComment.objects.create(
        workspace=workspace, project=other_project, issue=other_issue, comment_html="Other comment"
    )
    return workspace, own_project, source_asset, own_issue, other_issue, other_comment


@pytest.mark.parametrize(
    ("entity_type", "entity_index"),
    [("ISSUE_DESCRIPTION", 4), ("COMMENT_DESCRIPTION", 5)],
)
def test_workspace_upload_cannot_bind_entity_from_other_project(
    cross_project_entities, create_user, entity_type, entity_index
):
    workspace, _, _, _, _, _ = cross_project_entities
    entity = cross_project_entities[entity_index]
    with patch(STORAGE_PATH) as storage:
        response = authenticated_client(create_user).post(
            f"/api/assets/v2/workspaces/{workspace.slug}/",
            {
                "name": "foreign.png",
                "type": "image/png",
                "size": 16,
                "entity_type": entity_type,
                "entity_identifier": str(entity.id),
            },
            format="json",
        )

    assert response.status_code == status.HTTP_403_FORBIDDEN
    storage.assert_not_called()
    entity_field = "comment_id" if entity_type == "COMMENT_DESCRIPTION" else "issue_id"
    assert not FileAsset.objects.filter(workspace=workspace, **{entity_field: entity.id}).exists()


def test_workspace_upload_binds_own_issue_to_real_project(cross_project_entities, create_user):
    workspace, own_project, _, own_issue, _, _ = cross_project_entities
    with patch(STORAGE_PATH) as storage:
        storage.return_value.generate_presigned_post.return_value = {"url": "https://upload.example", "fields": {}}
        response = authenticated_client(create_user).post(
            f"/api/assets/v2/workspaces/{workspace.slug}/",
            {
                "name": "own.png",
                "type": "image/png",
                "size": 16,
                "entity_type": "ISSUE_DESCRIPTION",
                "entity_identifier": str(own_issue.id),
            },
            format="json",
        )

    assert response.status_code == status.HTTP_200_OK
    asset = FileAsset.objects.get(id=response.data["asset_id"])
    assert asset.project_id == own_project.id
    assert asset.issue_id == own_issue.id


def test_project_upload_cannot_bind_other_project_issue(cross_project_entities, create_user):
    workspace, own_project, _, _, other_issue, _ = cross_project_entities
    with patch(STORAGE_PATH) as storage:
        response = authenticated_client(create_user).post(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{own_project.id}/",
            {
                "name": "foreign.png",
                "type": "image/png",
                "size": 16,
                "entity_type": "ISSUE_DESCRIPTION",
                "entity_identifier": str(other_issue.id),
            },
            format="json",
        )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    storage.assert_not_called()


def test_bulk_upload_cannot_bind_other_project_issue(cross_project_entities, create_user):
    workspace, own_project, _, _, other_issue, _ = cross_project_entities
    staged = FileAsset.objects.create(
        workspace=workspace,
        project=own_project,
        created_by=create_user,
        asset=f"{workspace.id}/staged.png",
        size=16,
        entity_type="ISSUE_DESCRIPTION",
    )
    response = authenticated_client(create_user).post(
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{own_project.id}/{other_issue.id}/bulk/",
        {"asset_ids": [str(staged.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    staged.refresh_from_db()
    assert staged.issue_id is None


def test_duplicate_cannot_bind_other_project_issue(cross_project_entities, create_user):
    workspace, own_project, source_asset, _, other_issue, _ = cross_project_entities
    with patch(STORAGE_PATH) as storage:
        response = authenticated_client(create_user).post(
            f"/api/assets/v2/workspaces/{workspace.slug}/duplicate-assets/{source_asset.id}/",
            {"project_id": str(own_project.id), "entity_type": "ISSUE_DESCRIPTION", "entity_id": str(other_issue.id)},
            format="json",
        )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    storage.assert_not_called()


def test_legacy_upload_cannot_bind_other_project_issue(cross_project_entities, create_user):
    workspace, own_project, _, _, other_issue, _ = cross_project_entities
    upload = SimpleUploadedFile("foreign.png", b"\x89PNG\r\n\x1a\n" + b"x" * 16, content_type="image/png")
    response = authenticated_client(create_user).post(
        f"/api/workspaces/{workspace.slug}/file-assets/",
        {
            "asset": upload,
            "project": str(own_project.id),
            "issue": str(other_issue.id),
            "entity_type": "ISSUE_ATTACHMENT",
        },
        format="multipart",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert not FileAsset.objects.filter(workspace=workspace, issue=other_issue).exists()


def test_project_upload_cannot_bind_other_project_page(cross_project_entities, create_user):
    workspace, own_project, _, _, _, _ = cross_project_entities
    other_project = ProjectFactory(workspace=workspace, identifier="PAGES")
    page = Page.objects.create(workspace=workspace, owned_by=create_user, name="Other project page")
    ProjectPage.objects.create(workspace=workspace, project=other_project, page=page)
    payload = {
        "name": "foreign.png",
        "type": "image/png",
        "size": 16,
        "entity_type": "PAGE_DESCRIPTION",
        "entity_identifier": str(page.id),
    }

    with patch(STORAGE_PATH) as storage:
        project_response = authenticated_client(create_user).post(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{own_project.id}/", payload, format="json"
        )
        workspace_response = authenticated_client(create_user).post(
            f"/api/assets/v2/workspaces/{workspace.slug}/", payload, format="json"
        )

    assert project_response.status_code == status.HTTP_404_NOT_FOUND
    assert workspace_response.status_code == status.HTTP_403_FORBIDDEN
    storage.assert_not_called()


def test_project_upload_cannot_bind_other_project_draft(cross_project_entities, create_user):
    workspace, own_project, _, _, _, _ = cross_project_entities
    other_project = ProjectFactory(workspace=workspace, identifier="DRAFTS")
    draft = DraftIssue.objects.create(workspace=workspace, project=other_project, name="Other project draft")
    with patch(STORAGE_PATH) as storage:
        response = authenticated_client(create_user).post(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{own_project.id}/",
            {
                "name": "foreign.png",
                "type": "image/png",
                "size": 16,
                "entity_type": "DRAFT_ISSUE_DESCRIPTION",
                "entity_identifier": str(draft.id),
            },
            format="json",
        )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    storage.assert_not_called()
