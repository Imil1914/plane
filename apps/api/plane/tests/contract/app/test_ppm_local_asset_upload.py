# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework import status

from plane.app.views.asset.v2 import _save_ppm_local_asset
from plane.db.models import FileAsset
from plane.tests.factories import ProjectFactory, ProjectMemberFactory, WorkspaceFactory, WorkspaceMemberFactory


@pytest.mark.contract
@pytest.mark.django_db
def test_local_avatar_upload_is_saved_served_and_attached(session_client, create_user, tmp_path):
    content = b"\x89PNG\r\n\x1a\nppm-local-avatar"
    avatar = SimpleUploadedFile(
        "avatar.png",
        content,
        content_type="image/png",
    )

    with override_settings(PPM_LOCAL_ASSET_UPLOADS=True, BASE_DIR=str(tmp_path)):
        created = session_client.post(
            "/api/assets/v2/user-assets/",
            {"entity_type": "USER_AVATAR", "entity_identifier": "", "file": avatar, "size": "1"},
            format="multipart",
        )

        assert created.status_code == status.HTTP_201_CREATED
        asset = FileAsset.objects.get(id=created.data["asset_id"])
        assert asset.is_uploaded is True
        assert asset.size == len(content)
        assert asset.storage_metadata["ppm_local_path"].startswith(str(tmp_path))

        create_user.refresh_from_db()
        assert create_user.avatar_asset_id == asset.id

        served = session_client.get(created.data["asset_url"])
        assert served.status_code == status.HTTP_200_OK
        assert b"".join(served.streaming_content).startswith(b"\x89PNG")


@pytest.mark.contract
@pytest.mark.django_db
def test_local_avatar_rejects_spoofed_image_type_without_leaving_file(session_client, tmp_path):
    avatar = SimpleUploadedFile("avatar.png", b"\x89PNG\r\n\x1a\ncontent", content_type="image/jpeg")

    with override_settings(PPM_LOCAL_ASSET_UPLOADS=True, BASE_DIR=str(tmp_path)):
        response = session_client.post(
            "/api/assets/v2/user-assets/",
            {"entity_type": "USER_AVATAR", "file": avatar},
            format="multipart",
        )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert FileAsset.objects.count() == 0
    assert not list((tmp_path / "uploads" / "ppm-local-assets").iterdir())


@pytest.mark.contract
@pytest.mark.django_db
def test_presigned_avatar_rejects_invalid_size_without_creating_asset(session_client):
    response = session_client.post(
        "/api/assets/v2/user-assets/",
        {"entity_type": "USER_AVATAR", "name": "avatar.png", "type": "image/png", "size": "invalid"},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert FileAsset.objects.count() == 0


@pytest.mark.contract
@pytest.mark.django_db
def test_local_workspace_logo_uses_actual_file_size(session_client, create_user, tmp_path):
    workspace = WorkspaceFactory(owner=create_user)
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    content = b"GIF89a" + b"content"
    logo = SimpleUploadedFile("logo.gif", content, content_type="image/gif")

    with override_settings(PPM_LOCAL_ASSET_UPLOADS=True, BASE_DIR=str(tmp_path)):
        response = session_client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/",
            {"entity_type": "WORKSPACE_LOGO", "entity_identifier": str(workspace.id), "file": logo, "size": "1"},
            format="multipart",
        )

    assert response.status_code == status.HTTP_201_CREATED
    asset = FileAsset.objects.get(id=response.data["asset_id"])
    assert asset.size == len(content)
    workspace.refresh_from_db()
    assert workspace.logo_asset_id == asset.id


@override_settings(FILE_SIZE_LIMIT=16)
def test_local_writer_rejects_oversized_stream_and_removes_partial_file(tmp_path):
    class OversizedUpload:
        def chunks(self):
            yield b"\x89PNG\r\n\x1a\n"
            yield b"a" * 20

    with override_settings(BASE_DIR=str(tmp_path)), pytest.raises(ValueError, match="size exceeds"):
        _save_ppm_local_asset(OversizedUpload(), "oversized.png", "image/png")

    assert not list((tmp_path / "uploads" / "ppm-local-assets").iterdir())


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("declared_size", ["invalid", "17", "0"])
def test_project_asset_rejects_bad_size_without_creating_asset(session_client, create_user, declared_size):
    workspace = WorkspaceFactory(owner=create_user)
    project = ProjectFactory(workspace=workspace, identifier="IMG")
    WorkspaceMemberFactory(workspace=workspace, member=create_user, role=20)
    ProjectMemberFactory(workspace=workspace, project=project, member=create_user, role=20)

    with override_settings(FILE_SIZE_LIMIT=16):
        response = session_client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/",
            {
                "entity_type": "PROJECT_COVER",
                "entity_identifier": str(project.id),
                "type": "image/png",
                "size": declared_size,
            },
            format="json",
        )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert FileAsset.objects.count() == 0
