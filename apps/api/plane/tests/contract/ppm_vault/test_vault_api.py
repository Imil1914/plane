import io
import json
import uuid
import zipfile

import pytest
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework import status

from plane.db.models import Page, ProjectPage
from plane.ppm_vault.models import (
    PpmProjectVault,
    PpmVaultEntry,
    PpmVaultEntryAlias,
    PpmVaultLink,
    PpmVaultTransferRecord,
    PpmVaultVersion,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user():
    marker = uuid.uuid4().hex
    return UserFactory(username=f"vault-{marker}", email=f"vault-{marker}@plane.test")


@pytest.fixture
def vault_project(settings, tmp_path):
    settings.PPM_LOCAL_ASSET_UPLOADS = True
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "private-vault")
    user = make_user()
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="VLT")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    return user, workspace, project


def vault_url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/vault/{suffix}"


def authenticate(api_client, user):
    api_client.force_authenticate(user=user)


def markdown(api_client, workspace, project, *, name="README.md", parent_id=None, content="# PPM"):
    return api_client.post(
        vault_url(workspace, project, "markdown/"),
        {"name": name, "parent_id": parent_id, "content": content},
        format="json",
    )


def test_one_vault_per_project_and_folder_tree(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)

    first = api_client.get(vault_url(workspace, project))
    second = api_client.get(vault_url(workspace, project, "tree/"))
    folder = api_client.post(vault_url(workspace, project, "folders/"), {"name": "Документы"}, format="json")
    note = markdown(api_client, workspace, project, name="План", parent_id=folder.data["id"])
    tree = api_client.get(vault_url(workspace, project))

    assert first.status_code == status.HTTP_200_OK
    assert second.data["vault_id"] == first.data["vault_id"]
    assert PpmProjectVault.objects.filter(project_id=project.id).count() == 1
    assert folder.status_code == status.HTTP_201_CREATED
    assert note.data["name"] == "План.md"
    assert tree.data["entries"][0]["children"][0]["name"] == "План.md"
    assert tree.data["index_policy_values"] == ["inherit", "include", "exclude"]


def test_markdown_versions_survive_reload_and_stale_save_conflicts(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    created = markdown(api_client, workspace, project)
    content_url = vault_url(workspace, project, f"entries/{created.data['id']}/content/")

    saved = api_client.put(content_url, {"base_version": 1, "content": "# Версия 2"}, format="json")
    stale = api_client.put(content_url, {"base_version": 1, "content": "# Потерянное"}, format="json")
    reloaded = api_client.get(content_url)

    assert saved.status_code == status.HTTP_200_OK
    assert saved.data["version"] == 2
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "VAULT_VERSION_CONFLICT"
    assert stale.data["error"]["details"]["current_version"] == 2
    assert reloaded.data["content"] == "# Версия 2"
    assert PpmVaultVersion.objects.filter(entry_id=created.data["id"]).count() == 2
    version = PpmVaultVersion.objects.filter(entry_id=created.data["id"]).first()
    version.content_text = "mutated"
    with pytest.raises(ValidationError, match="immutable"):
        version.save()


def test_pdf_is_private_and_object_key_has_no_original_name(api_client, vault_project, settings):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    uploaded = SimpleUploadedFile("Секретный план.pdf", b"%PDF-1.4\nPPM private\n%%EOF", content_type="application/pdf")

    created = api_client.post(vault_url(workspace, project, "pdf/"), {"file": uploaded}, format="multipart")
    entry = PpmVaultEntry.objects.get(id=created.data["id"])
    version = entry.versions.get(version=1)
    downloaded = api_client.get(vault_url(workspace, project, f"entries/{entry.id}/pdf/"))

    assert created.status_code == status.HTTP_201_CREATED
    assert created.data["mime_type"] == "application/pdf"
    assert "Секретный" not in version.object_key
    assert "plan" not in version.object_key.casefold()
    assert str(entry.id) in version.object_key
    assert downloaded.status_code == status.HTTP_200_OK
    assert downloaded["Cache-Control"] == "private, no-store"
    assert downloaded["Content-Disposition"] == f'inline; filename="{entry.id}.pdf"'


def test_invalid_pdf_and_oversize_do_not_publish_entry(api_client, vault_project, settings):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    settings.PPM_VAULT_PDF_MAX_BYTES = 12

    invalid = SimpleUploadedFile("fake.pdf", b"not a pdf", content_type="application/pdf")
    oversized = SimpleUploadedFile("large.pdf", b"%PDF-" + b"x" * 20, content_type="application/pdf")
    invalid_response = api_client.post(vault_url(workspace, project, "pdf/"), {"file": invalid}, format="multipart")
    large_response = api_client.post(vault_url(workspace, project, "pdf/"), {"file": oversized}, format="multipart")

    assert invalid_response.status_code == status.HTTP_400_BAD_REQUEST
    assert large_response.status_code == status.HTTP_400_BAD_REQUEST
    assert not PpmVaultEntry.objects.exclude(kind="folder").exists()


def test_image_and_reference_upload_are_private_and_replace_is_versioned(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    image = SimpleUploadedFile(
        "scheme.png",
        b"\x89PNG\r\n\x1a\n" + b"ppm-image",
        content_type="image/png",
    )
    created = api_client.post(vault_url(workspace, project, "files/"), {"file": image}, format="multipart")
    entry_id = created.data["id"]
    served = api_client.get(vault_url(workspace, project, f"entries/{entry_id}/file/"))

    replacement = SimpleUploadedFile(
        "scheme-v2.png",
        b"\x89PNG\r\n\x1a\n" + b"ppm-image-v2",
        content_type="image/png",
    )
    replaced = api_client.put(
        vault_url(workspace, project, f"entries/{entry_id}/file/"),
        {"base_version": "1", "file": replacement},
        format="multipart",
    )
    stale = api_client.put(
        vault_url(workspace, project, f"entries/{entry_id}/file/"),
        {
            "base_version": "1",
            "file": SimpleUploadedFile(
                "scheme-v3.png",
                b"\x89PNG\r\n\x1a\n" + b"ppm-image-v3",
                content_type="image/png",
            ),
        },
        format="multipart",
    )

    assert created.status_code == status.HTTP_201_CREATED
    assert created.data["kind"] == "image"
    assert created.data["mime_type"] == "image/png"
    assert served.status_code == status.HTTP_200_OK
    assert served["Cache-Control"] == "private, no-store"
    assert served["Content-Security-Policy"] == "default-src 'none'; sandbox"
    assert replaced.status_code == status.HTTP_200_OK
    assert replaced.data["version"] == 2
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "VAULT_VERSION_CONFLICT"
    assert PpmVaultVersion.objects.filter(entry_id=entry_id).count() == 2


def test_active_svg_and_mismatched_image_are_rejected(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    svg = SimpleUploadedFile(
        "active.svg",
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        content_type="image/svg+xml",
    )
    disguised = SimpleUploadedFile("fake.png", b"not-a-png", content_type="image/png")

    svg_response = api_client.post(vault_url(workspace, project, "files/"), {"file": svg}, format="multipart")
    image_response = api_client.post(
        vault_url(workspace, project, "files/"),
        {"file": disguised},
        format="multipart",
    )

    assert svg_response.status_code == status.HTTP_400_BAD_REQUEST
    assert image_response.status_code == status.HTTP_400_BAD_REQUEST
    assert svg_response.data["error"]["code"] == "VAULT_INVALID_FILE_TYPE"
    assert image_response.data["error"]["code"] == "VAULT_INVALID_FILE_TYPE"
    assert not PpmVaultEntry.objects.exclude(kind="folder").exists()


def test_viewer_can_read_but_cannot_write_and_outsider_is_denied(api_client, vault_project):
    owner, workspace, project = vault_project
    viewer = make_user()
    outsider = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=viewer, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=viewer, role=5)

    authenticate(api_client, owner)
    created = markdown(api_client, workspace, project)
    authenticate(api_client, viewer)
    allowed = api_client.get(vault_url(workspace, project))
    forbidden = markdown(api_client, workspace, project, name="viewer.md")
    authenticate(api_client, outsider)
    denied = api_client.get(vault_url(workspace, project))

    assert allowed.status_code == status.HTTP_200_OK
    assert allowed.data["access"] == "read"
    assert forbidden.status_code == status.HTTP_403_FORBIDDEN
    assert denied.status_code == status.HTTP_403_FORBIDDEN
    assert PpmVaultEntry.objects.filter(id=created.data["id"]).exists()


def test_index_policy_and_soft_delete_are_explicit(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    created = markdown(api_client, workspace, project)
    entry_url = vault_url(workspace, project, f"entries/{created.data['id']}/")

    indexed = api_client.patch(entry_url, {"index_policy": "exclude"}, format="json")
    deleted = api_client.delete(entry_url)
    hidden = api_client.get(entry_url)

    assert indexed.data["index_policy"] == "exclude"
    assert deleted.status_code == status.HTTP_204_NO_CONTENT
    assert hidden.status_code == status.HTTP_404_NOT_FOUND
    assert PpmVaultEntry.objects.get(id=created.data["id"]).status == "trashed"


def test_wiki_links_backlinks_graph_and_missing_states(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    target = markdown(api_client, workspace, project, name="Решение.md", content="# Решение")
    source = markdown(
        api_client,
        workspace,
        project,
        name="План.md",
        content="См. [[Решение|ADR]] и [[Не найдено]].",
    )

    backlinks = api_client.get(vault_url(workspace, project, f"entries/{target.data['id']}/backlinks/"))
    source_links = api_client.get(vault_url(workspace, project, f"entries/{source.data['id']}/backlinks/"))
    graph = api_client.get(vault_url(workspace, project, "graph/"))

    assert backlinks.status_code == status.HTTP_200_OK
    assert backlinks.data["incoming"][0]["source_entry"]["id"] == source.data["id"]
    assert {item["status"] for item in source_links.data["outgoing"]} == {"resolved", "missing"}
    assert len(graph.data["nodes"]) == 2
    assert {edge["status"] for edge in graph.data["edges"]} == {"resolved", "missing"}
    assert PpmVaultLink.objects.filter(project_id=project.id).count() == 2


def test_wiki_link_reports_ambiguity_but_prefers_same_folder(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    folder_a = api_client.post(vault_url(workspace, project, "folders/"), {"name": "А"}, format="json")
    folder_b = api_client.post(vault_url(workspace, project, "folders/"), {"name": "Б"}, format="json")
    target_a = markdown(api_client, workspace, project, name="Дубль.md", parent_id=folder_a.data["id"])
    markdown(api_client, workspace, project, name="Дубль.md", parent_id=folder_b.data["id"])
    root_source = markdown(api_client, workspace, project, name="Корень.md", content="[[Дубль]]")
    local_source = markdown(
        api_client,
        workspace,
        project,
        name="Локальный.md",
        parent_id=folder_a.data["id"],
        content="[[Дубль]]",
    )

    root_links = api_client.get(vault_url(workspace, project, f"entries/{root_source.data['id']}/backlinks/"))
    local_links = api_client.get(vault_url(workspace, project, f"entries/{local_source.data['id']}/backlinks/"))

    assert root_links.data["outgoing"][0]["status"] == "ambiguous"
    assert root_links.data["outgoing"][0]["target_entry_id"] is None
    assert local_links.data["outgoing"][0]["status"] == "resolved"
    assert local_links.data["outgoing"][0]["target_entry_id"] == target_a.data["id"]


def test_rename_and_move_keep_entry_id_and_resolve_old_wiki_path(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    folder = api_client.post(vault_url(workspace, project, "folders/"), {"name": "Архив"}, format="json")
    target = markdown(api_client, workspace, project, name="Решение.md", content="# Решение")
    source = markdown(api_client, workspace, project, name="План.md", content="[[Решение]]")

    changed = api_client.patch(
        vault_url(workspace, project, f"entries/{target.data['id']}/"),
        {"name": "Решение 2026.md", "parent_id": folder.data["id"]},
        format="json",
    )
    backlinks = api_client.get(vault_url(workspace, project, f"entries/{target.data['id']}/backlinks/"))

    assert changed.status_code == status.HTTP_200_OK
    assert changed.data["id"] == target.data["id"]
    assert changed.data["path"] == "Архив/Решение 2026.md"
    assert backlinks.data["incoming"][0]["source_entry"]["id"] == source.data["id"]
    assert PpmVaultEntryAlias.objects.filter(entry_id=target.data["id"], normalized_path="решение.md").exists()


def test_folder_cannot_be_moved_into_its_descendant(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    parent = api_client.post(vault_url(workspace, project, "folders/"), {"name": "Родитель"}, format="json")
    child = api_client.post(
        vault_url(workspace, project, "folders/"),
        {"name": "Дочерняя", "parent_id": parent.data["id"]},
        format="json",
    )

    moved = api_client.patch(
        vault_url(workspace, project, f"entries/{parent.data['id']}/"),
        {"parent_id": child.data["id"]},
        format="json",
    )

    assert moved.status_code == status.HTTP_409_CONFLICT
    assert moved.data["error"]["code"] == "VAULT_MOVE_CYCLE"


def test_version_history_restore_creates_new_current_version(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    created = markdown(api_client, workspace, project, content="# Один")
    entry_id = created.data["id"]
    api_client.put(
        vault_url(workspace, project, f"entries/{entry_id}/content/"),
        {"base_version": 1, "content": "# Два"},
        format="json",
    )

    versions = api_client.get(vault_url(workspace, project, f"entries/{entry_id}/versions/"))
    restored = api_client.post(
        vault_url(workspace, project, f"entries/{entry_id}/versions/1/restore/"),
        {"base_version": 2},
        format="json",
    )
    content = api_client.get(vault_url(workspace, project, f"entries/{entry_id}/content/"))

    assert [item["version"] for item in versions.data["versions"]] == [2, 1]
    assert restored.status_code == status.HTTP_200_OK
    assert restored.data["version"] == 3
    assert content.data["content"] == "# Один"
    assert PpmVaultVersion.objects.filter(entry_id=entry_id).count() == 3


def test_binary_version_restore_copies_old_private_object(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    first_payload = b"\x89PNG\r\n\x1a\n" + b"first"
    created = api_client.post(
        vault_url(workspace, project, "files/"),
        {"file": SimpleUploadedFile("scheme.png", first_payload, content_type="image/png")},
        format="multipart",
    )
    entry_id = created.data["id"]
    api_client.put(
        vault_url(workspace, project, f"entries/{entry_id}/file/"),
        {
            "base_version": "1",
            "file": SimpleUploadedFile(
                "scheme-v2.png",
                b"\x89PNG\r\n\x1a\nsecond",
                content_type="image/png",
            ),
        },
        format="multipart",
    )

    restored = api_client.post(
        vault_url(workspace, project, f"entries/{entry_id}/versions/1/restore/"),
        {"base_version": 2},
        format="json",
    )
    downloaded = api_client.get(vault_url(workspace, project, f"entries/{entry_id}/file/"))

    assert restored.status_code == status.HTTP_200_OK
    assert restored.data["version"] == 3
    assert b"".join(downloaded.streaming_content) == first_payload
    assert PpmVaultVersion.objects.filter(entry_id=entry_id).count() == 3


def test_trash_listing_and_restore_preserve_material(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    created = markdown(api_client, workspace, project, name="Возврат.md")
    entry_url = vault_url(workspace, project, f"entries/{created.data['id']}/")
    api_client.delete(entry_url)

    trash = api_client.get(vault_url(workspace, project, "trash/"))
    restored = api_client.post(
        vault_url(workspace, project, f"entries/{created.data['id']}/restore/"),
        {},
        format="json",
    )
    visible = api_client.get(entry_url)

    assert trash.status_code == status.HTTP_200_OK
    assert trash.data["entries"][0]["id"] == created.data["id"]
    assert restored.data["status"] == "active"
    assert visible.status_code == status.HTTP_200_OK


def test_export_zip_has_plain_tree_and_manifest(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    folder = api_client.post(vault_url(workspace, project, "folders/"), {"name": "Документы"}, format="json")
    note = markdown(
        api_client,
        workspace,
        project,
        name="План.md",
        parent_id=folder.data["id"],
        content="# Экспорт PPM",
    )

    exported = api_client.get(vault_url(workspace, project, "export/"))
    payload = b"".join(exported.streaming_content)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
        manifest = json.loads(archive.read("ppm-vault-manifest.json"))
        content = archive.read("Документы/План.md").decode("utf-8")

    assert exported.status_code == status.HTTP_200_OK
    assert "Документы/" in names
    assert content == "# Экспорт PPM"
    assert manifest["schema_version"] == 1
    assert manifest["entries"][1]["id"] == note.data["id"]
    assert all(".." not in name for name in names)


def test_export_rejects_archive_over_configured_limit(api_client, vault_project, settings):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    settings.PPM_VAULT_EXPORT_MAX_BYTES = 8
    markdown(api_client, workspace, project, name="Большой.md", content="Содержимое длиннее лимита")

    exported = api_client.get(vault_url(workspace, project, "export/"))

    assert exported.status_code == status.HTTP_400_BAD_REQUEST
    assert exported.data["error"]["code"] == "VAULT_EXPORT_TOO_LARGE"


def test_page_markdown_transfer_records_provenance(api_client, vault_project):
    user, workspace, project = vault_project
    authenticate(api_client, user)
    page = Page.objects.create(
        workspace=workspace,
        name="Совместный план",
        description_html="<p>Текст документа</p>",
        owned_by=user,
    )
    ProjectPage.objects.create(workspace=workspace, project=project, page=page)

    pages = api_client.get(vault_url(workspace, project, "transfers/pages/"))
    imported = api_client.post(
        vault_url(workspace, project, f"transfers/pages/{page.id}/import/"),
        {},
        format="json",
    )
    entry_id = imported.data["entry"]["id"]
    exported = api_client.post(
        vault_url(workspace, project, f"entries/{entry_id}/export-page/"),
        {},
        format="json",
    )
    transfers = api_client.get(vault_url(workspace, project, f"entries/{entry_id}/transfers/"))

    assert pages.data["pages"][0]["id"] == str(page.id)
    assert imported.status_code == status.HTTP_201_CREATED
    assert imported.data["entry"]["name"] == "Совместный план.md"
    assert exported.status_code == status.HTTP_201_CREATED
    assert exported.data["page"]["name"] == "Совместный план"
    assert {item["direction"] for item in transfers.data["transfers"]} == {"page_to_vault", "vault_to_page"}
    assert PpmVaultTransferRecord.objects.filter(entry_id=entry_id).count() == 2


def test_cross_project_page_import_and_trash_restore_are_denied(api_client, vault_project):
    owner, workspace, project = vault_project
    viewer = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=viewer, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=viewer, role=5)
    other_project = ProjectFactory(workspace=workspace, identifier="VLT2")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=owner, role=20)
    page = Page.objects.create(workspace=workspace, name="Чужой", owned_by=owner)
    ProjectPage.objects.create(workspace=workspace, project=other_project, page=page)
    authenticate(api_client, viewer)

    denied_import = api_client.post(
        vault_url(workspace, project, f"transfers/pages/{page.id}/import/"),
        {},
        format="json",
    )
    denied_trash = api_client.get(vault_url(workspace, project, "trash/"))

    authenticate(api_client, owner)
    hidden_cross_project_page = api_client.post(
        vault_url(workspace, project, f"transfers/pages/{page.id}/import/"),
        {},
        format="json",
    )

    assert denied_import.status_code == status.HTTP_403_FORBIDDEN
    assert denied_trash.status_code == status.HTTP_403_FORBIDDEN
    assert hidden_cross_project_page.status_code == status.HTTP_404_NOT_FOUND
    assert hidden_cross_project_page.data["error"]["code"] == "VAULT_PAGE_NOT_FOUND"
