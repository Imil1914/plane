import uuid
from urllib.parse import unquote

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework import status

from plane.ppm_vault.models import PpmVaultEntry
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

PNG = b"\x89PNG\r\n\x1a\n" + b"pasted-screenshot"
GIF = b"GIF89a" + b"\x01\x00\x01\x00\x00\x00\x00;"


def make_user():
    marker = uuid.uuid4().hex
    return UserFactory(username=f"paste-{marker}", email=f"paste-{marker}@plane.test")


@pytest.fixture
def vault_project(settings, tmp_path):
    settings.PPM_LOCAL_ASSET_UPLOADS = True
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "private-vault")
    user = make_user()
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="PST")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    return user, workspace, project


def upload(api_client, workspace, project, name, payload, content_type="application/octet-stream"):
    return api_client.post(
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/vault/files/",
        {"file": SimpleUploadedFile(name, payload, content_type=content_type)},
        format="multipart",
    )


def entry_url(workspace, project, entry_id):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/vault/entries/{entry_id}/"


def file_url(workspace, project, entry_id, *, download=False):
    suffix = "?download=1" if download else ""
    return f"{entry_url(workspace, project, entry_id)}file/{suffix}"


def test_pasted_image_keeps_client_name_and_duplicate_gets_deterministic_conflict(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)

    created = upload(api_client, workspace, project, "Вставка-2026-09-25-153012.png", PNG, "image/png")
    duplicate = upload(api_client, workspace, project, "вставка-2026-09-25-153012.PNG", PNG, "image/png")
    retried = upload(
        api_client,
        workspace,
        project,
        duplicate.data["error"]["details"]["suggested_name"],
        PNG,
        "image/png",
    )
    second_duplicate = upload(api_client, workspace, project, "Вставка-2026-09-25-153012.png", PNG, "image/png")

    assert created.status_code == status.HTTP_201_CREATED
    assert created.data["name"] == "Вставка-2026-09-25-153012.png"
    assert created.data["kind"] == "image"
    assert duplicate.status_code == status.HTTP_409_CONFLICT
    assert duplicate.data["error"]["code"] == "VAULT_NAME_CONFLICT"
    assert duplicate.data["error"]["details"] == {
        "name": "вставка-2026-09-25-153012.PNG",
        "suggested_name": "вставка-2026-09-25-153012 (2).PNG",
    }
    assert retried.status_code == status.HTTP_201_CREATED
    assert second_duplicate.data["error"]["details"]["suggested_name"] == "Вставка-2026-09-25-153012 (3).png"
    assert PpmVaultEntry.objects.filter(project_id=project.id, kind="image").count() == 2


def test_gif_is_accepted_only_with_gif_signature(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)

    gif = upload(api_client, workspace, project, "анимация.gif", GIF, "image/gif")
    fake = upload(api_client, workspace, project, "fake.gif", PNG, "image/gif")
    served = api_client.get(
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/vault/entries/{gif.data['id']}/file/"
    )

    assert gif.status_code == status.HTTP_201_CREATED
    assert gif.data["kind"] == "image"
    assert gif.data["mime_type"] == "image/gif"
    assert served["Content-Type"] == "image/gif"
    assert served["Content-Security-Policy"] == "default-src 'none'; sandbox"
    assert fake.status_code == status.HTTP_400_BAD_REQUEST
    assert fake.data["error"]["code"] == "VAULT_INVALID_FILE_TYPE"


def test_code_files_are_stored_as_utf8_plain_text(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)

    script = upload(api_client, workspace, project, "robot.py", "print('Привет')\n".encode("utf-8"))
    binary = upload(api_client, workspace, project, "tool.py", b"\x00\x01\x02ELF")
    legacy = upload(api_client, workspace, project, "old.js", "var s = 'Привет';".encode("cp1251"))
    markup = upload(api_client, workspace, project, "page.html", b"<script>alert(1)</script>")

    assert script.status_code == status.HTTP_201_CREATED
    assert script.data["kind"] == "file"
    assert script.data["mime_type"] == "text/plain"
    assert script.data["extension"] == "py"
    assert [binary.status_code, legacy.status_code, markup.status_code] == [400, 400, 400]
    assert {binary.data["error"]["code"], legacy.data["error"]["code"], markup.data["error"]["code"]} == {
        "VAULT_INVALID_FILE_TYPE"
    }


def test_image_limit_stays_at_file_size_limit_and_reports_it(api_client, vault_project, settings):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    settings.FILE_SIZE_LIMIT = 32

    oversized = upload(api_client, workspace, project, "big.png", PNG + b"x" * 64, "image/png")

    assert oversized.status_code == status.HTTP_400_BAD_REQUEST
    assert oversized.data["error"]["code"] == "VAULT_FILE_TOO_LARGE"
    assert oversized.data["error"]["details"] == {"size_bytes": len(PNG) + 64, "limit_bytes": 32}
    assert not PpmVaultEntry.objects.filter(project_id=project.id, kind="image").exists()


# --- C5 (controller ruling): GET …/vault/entries/<id>/file/?download=1 --------------------------------------------


def test_file_download_uses_real_filename_and_leaves_plain_file_unchanged(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    name = "Отчёт по продажам (июнь).csv"
    payload = "имя;сумма\nАнна;10\n".encode("utf-8")

    created = upload(api_client, workspace, project, name, payload, "text/csv")
    plain = api_client.get(file_url(workspace, project, created.data["id"]))
    downloaded = api_client.get(file_url(workspace, project, created.data["id"], download=True))

    assert created.status_code == status.HTTP_201_CREATED
    # Without download=1 the existing behaviour (identifier-based filename) is unchanged.
    assert plain.status_code == status.HTTP_200_OK
    assert plain["Content-Disposition"] == f'attachment; filename="{created.data["id"]}.csv"'
    # With download=1 the client gets the real name back, UTF-8-encoded per RFC 6266/5987.
    assert downloaded.status_code == status.HTTP_200_OK
    disposition = downloaded["Content-Disposition"]
    assert disposition.startswith("attachment; filename*=utf-8''") or disposition.startswith(
        "attachment; filename*=UTF-8''"
    )
    encoded_name = disposition.split("filename*=", 1)[1].split("''", 1)[1]
    assert unquote(encoded_name) == name
    assert b"".join(downloaded.streaming_content) == payload
    assert downloaded["Cache-Control"] == "private, no-store"
    assert downloaded["Content-Security-Policy"] == "default-src 'none'; sandbox"


def test_file_download_uses_same_permissions_as_plain_file(api_client, vault_project):
    owner, workspace, project = vault_project
    guest = make_user()
    outsider = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=15)
    other_project = ProjectFactory(workspace=workspace, identifier="PST2")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=owner, role=20)
    api_client.force_authenticate(user=owner)
    created = upload(api_client, workspace, project, "секрет.txt", "тайна".encode("utf-8"), "text/plain")
    trashed = upload(api_client, workspace, project, "trashed.txt", b"gone", "text/plain")
    api_client.delete(entry_url(workspace, project, trashed.data["id"]))

    foreign = api_client.get(file_url(workspace, other_project, created.data["id"], download=True))
    trashed_response = api_client.get(file_url(workspace, project, trashed.data["id"], download=True))
    api_client.force_authenticate(user=guest)
    guest_response = api_client.get(file_url(workspace, project, created.data["id"], download=True))
    api_client.force_authenticate(user=outsider)
    outsider_response = api_client.get(file_url(workspace, project, created.data["id"], download=True))
    api_client.force_authenticate(user=None)
    anonymous = api_client.get(file_url(workspace, project, created.data["id"], download=True))

    assert foreign.status_code == status.HTTP_404_NOT_FOUND
    assert foreign.data["error"]["code"] == "VAULT_ENTRY_NOT_FOUND"
    assert trashed_response.status_code == status.HTTP_404_NOT_FOUND
    assert guest_response.status_code == status.HTTP_200_OK
    assert b"".join(guest_response.streaming_content) == "тайна".encode("utf-8")
    assert outsider_response.status_code == status.HTTP_403_FORBIDDEN
    assert outsider_response.data["error"]["code"] == "VAULT_PERMISSION_DENIED"
    assert anonymous.status_code == status.HTTP_401_UNAUTHORIZED
