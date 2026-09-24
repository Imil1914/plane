# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework import status

from plane.db.models import FileAsset


@pytest.mark.contract
@pytest.mark.django_db
def test_local_avatar_upload_is_saved_served_and_attached(session_client, create_user, tmp_path):
    avatar = SimpleUploadedFile(
        "avatar.png",
        b"\x89PNG\r\n\x1a\nppm-local-avatar",
        content_type="image/png",
    )

    with override_settings(PPM_LOCAL_ASSET_UPLOADS=True, BASE_DIR=str(tmp_path)):
        created = session_client.post(
            "/api/assets/v2/user-assets/",
            {"entity_type": "USER_AVATAR", "entity_identifier": "", "file": avatar},
            format="multipart",
        )

        assert created.status_code == status.HTTP_201_CREATED
        asset = FileAsset.objects.get(id=created.data["asset_id"])
        assert asset.is_uploaded is True
        assert asset.storage_metadata["ppm_local_path"].startswith(str(tmp_path))

        create_user.refresh_from_db()
        assert create_user.avatar_asset_id == asset.id

        served = session_client.get(created.data["asset_url"])
        assert served.status_code == status.HTTP_200_OK
        assert b"".join(served.streaming_content).startswith(b"\x89PNG")
