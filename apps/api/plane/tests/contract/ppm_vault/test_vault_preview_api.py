import datetime
import io
import random
import uuid
import warnings
import zipfile
from unittest.mock import patch
from xml.etree import ElementTree

import pytest
from botocore.exceptions import ClientError
from django.core.files.uploadedfile import SimpleUploadedFile
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.utils.datetime import CALENDAR_MAC_1904
from rest_framework import status

from plane.ppm_vault import preview as vault_preview
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"


def make_user():
    marker = uuid.uuid4().hex
    return UserFactory(username=f"preview-{marker}", email=f"preview-{marker}@plane.test")


@pytest.fixture
def vault_project(settings, tmp_path):
    settings.PPM_LOCAL_ASSET_UPLOADS = True
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "private-vault")
    settings.CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": f"ppm-preview-{uuid.uuid4().hex}",
        }
    }
    user = make_user()
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="PRV")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    return user, workspace, project


def vault_url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/vault/{suffix}"


def upload(api_client, workspace, project, name, payload):
    response = api_client.post(
        vault_url(workspace, project, "files/"),
        {"file": SimpleUploadedFile(name, payload, content_type="application/octet-stream")},
        format="multipart",
    )
    assert response.status_code == status.HTTP_201_CREATED, response.data
    return response.data["id"]


def preview(api_client, workspace, project, entry_id):
    return api_client.get(vault_url(workspace, project, f"entries/{entry_id}/preview/"))


def zip_bytes(members, compression=zipfile.ZIP_DEFLATED):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def docx_bytes(body_xml, *, doctype=""):
    document = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>{doctype}'
        f'<w:document xmlns:w="{W_NS}"><w:body>{body_xml}</w:body></w:document>'
    )
    styles = (
        f'<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="{W_NS}">'
        '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>'
        "</w:styles>"
    )
    return zip_bytes({"word/document.xml": document, "word/styles.xml": styles})


def paragraph(text, style=None, numbered=False):
    properties = ""
    if style or numbered:
        style_xml = f'<w:pStyle w:val="{style}"/>' if style else ""
        numbering = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' if numbered else ""
        properties = f"<w:pPr>{style_xml}{numbering}</w:pPr>"
    return f'<w:p>{properties}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def pptx_bytes(slides_in_order):
    relationships = []
    slide_ids = []
    members = {}
    for position, (file_number, title, body) in enumerate(slides_in_order, start=2):
        relationships.append(
            f'<Relationship Id="rId{position}" Type="{SLIDE_REL}" Target="slides/slide{file_number}.xml"/>'
        )
        slide_ids.append(f'<p:sldId id="{254 + position}" r:id="rId{position}"/>')
        members[f"ppt/slides/slide{file_number}.xml"] = (
            f'<p:sld xmlns:p="{P_NS}" xmlns:a="{A_NS}"><p:cSld><p:spTree>'
            '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr>'
            f"</p:nvSpPr><p:txBody><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp>"
            '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr>'
            f"</p:nvSpPr><p:txBody><a:p><a:r><a:t>{body}</a:t></a:r></a:p></p:txBody></p:sp>"
            "</p:spTree></p:cSld></p:sld>"
        )
    members["ppt/presentation.xml"] = (
        f'<p:presentation xmlns:p="{P_NS}" xmlns:r="{R_NS}"><p:sldIdLst>{"".join(slide_ids)}</p:sldIdLst>'
        "</p:presentation>"
    )
    members["ppt/_rels/presentation.xml.rels"] = (
        f'<Relationships xmlns="{REL_NS}">{"".join(relationships)}</Relationships>'
    )
    return zip_bytes(members)


def xlsx_bytes(rows, cols, *, sheet_title="Бюджет"):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_title
    for row in range(1, rows + 1):
        for col in range(1, cols + 1):
            sheet.cell(row=row, column=col, value=f"R{row}C{col}")
    sheet["A1"] = "Статья"
    sheet["B1"] = 1250.0
    sheet["C1"] = "=B1*2"
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_docx_preview_builds_sanitized_html_with_headings_lists_and_tables(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    table = (
        "<w:tbl><w:tr><w:tc>" + paragraph("Срок") + "</w:tc><w:tc>" + paragraph("Октябрь") + "</w:tc></w:tr></w:tbl>"
    )
    body = (
        paragraph("План запуска", style="1")
        + paragraph("Обычный текст &lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;")
        + paragraph("Первый пункт", numbered=True)
        + paragraph("Второй пункт", numbered=True)
        + table
    )
    entry_id = upload(api_client, workspace, project, "План.docx", docx_bytes(body))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response["Cache-Control"] == "private, no-store"
    assert response.data["kind"] == "docx"
    assert response.data["entry_id"] == entry_id
    assert response.data["version"] == 1
    assert response.data["truncated"] is False
    html = response.data["html"]
    assert "<h1>План запуска</h1>" in html
    assert "<ul><li>Первый пункт</li><li>Второй пункт</li></ul>" in html
    assert "<table><tbody><tr><td>Срок</td><td>Октябрь</td></tr></tbody></table>" in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;" in html
    assert "<script" not in html
    assert "<img" not in html


def test_docx_external_entity_is_never_resolved(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    doctype = '<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    body = "<w:p><w:r><w:t>до &xxe; после</w:t></w:r></w:p>"
    entry_id = upload(api_client, workspace, project, "xxe.docx", docx_bytes(body, doctype=doctype))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "docx"
    assert "root:" not in response.data["html"]
    assert "до" in response.data["html"]


def test_xlsx_preview_returns_values_only_within_200_by_50(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "Бюджет.xlsx", xlsx_bytes(205, 52))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    assert response.data["truncated"] is True
    sheet = response.data["sheets"][0]
    assert sheet["name"] == "Бюджет"
    assert len(sheet["rows"]) == 200
    assert {len(row) for row in sheet["rows"]} == {50}
    assert sheet["rows"][0][:3] == ["Статья", "1250", ""]
    assert sheet["rows"][199][49] == "R200C50"


def test_xlsx_sheet_name_is_capped_and_charged_to_the_output_budget(api_client, vault_project):
    # ~worksheet.title (_xlsx_payload): unlike every other piece of text in the payload, the sheet
    # name never passed through budget.take, so a single several-hundred-KB name reached the
    # response (and got cached for up to cache_seconds) with no relation to output_max_chars.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    members = archive_members(xlsx_bytes(3, 3))
    huge_name = "".join(random.Random(1).choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") for _ in range(700 * 1024))
    workbook_xml = members["xl/workbook.xml"].decode("utf-8")
    assert workbook_xml.count('name="Бюджет"') == 1
    members["xl/workbook.xml"] = workbook_xml.replace('name="Бюджет"', f'name="{huge_name}"', 1).encode("utf-8")
    entry_id = upload(api_client, workspace, project, "Огромное имя листа.xlsx", zip_bytes(members))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    assert response.data["truncated"] is True
    name = response.data["sheets"][0]["name"]
    assert name == huge_name[: vault_preview.XLSX_SHEET_NAME_MAX_CHARS] + "…"
    assert len(name) < len(huge_name)
    assert len(response.content) < vault_preview.preview_limits()["output_max_chars"]


def test_pptx_preview_follows_presentation_slide_order(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    payload = pptx_bytes([(2, "Введение", "Цель проекта"), (1, "Итоги", "Что сделано")])
    entry_id = upload(api_client, workspace, project, "Доклад.pptx", payload)

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "pptx"
    assert response.data["slides"] == [
        {"index": 1, "title": "Введение", "text": "Цель проекта"},
        {"index": 2, "title": "Итоги", "text": "Что сделано"},
    ]


def test_text_markdown_and_unsupported_kinds(api_client, vault_project, settings):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    settings.PPM_VAULT_PREVIEW_TEXT_MAX_BYTES = 64
    csv_id = upload(api_client, workspace, project, "data.csv", "имя;сумма\nАнна;10\n".encode("utf-8"))
    long_id = upload(api_client, workspace, project, "long.txt", b"x" * 200)
    legacy_id = upload(api_client, workspace, project, "legacy.txt", "Привет".encode("cp1251"))
    markdown = api_client.post(
        vault_url(workspace, project, "markdown/"),
        {"name": "README", "content": "# Заголовок"},
        format="json",
    )
    image_id = upload(api_client, workspace, project, "scheme.png", b"\x89PNG\r\n\x1a\n" + b"image")
    old_word_id = upload(api_client, workspace, project, "old.doc", b"\xd0\xcf\x11\xe0legacy")

    csv_preview = preview(api_client, workspace, project, csv_id)
    long_preview = preview(api_client, workspace, project, long_id)
    legacy_preview = preview(api_client, workspace, project, legacy_id)
    markdown_preview = preview(api_client, workspace, project, markdown.data["id"])
    image_preview = preview(api_client, workspace, project, image_id)
    old_word_preview = preview(api_client, workspace, project, old_word_id)

    assert csv_preview.data["kind"] == "text"
    assert csv_preview.data["text"] == "имя;сумма\nАнна;10\n"
    assert csv_preview.data["encoding"] == "utf-8"
    assert long_preview.data["truncated"] is True
    assert long_preview.data["text"] == "x" * 64
    assert legacy_preview.data["text"] == "Привет"
    assert legacy_preview.data["encoding"] == "windows-1251"
    assert markdown_preview.data["kind"] == "text"
    assert markdown_preview.data["text"] == "# Заголовок"
    assert image_preview.data == {**image_preview.data, "kind": "unsupported", "reason": "type"}
    assert old_word_preview.data["kind"] == "unsupported"
    assert old_word_preview.data["reason"] == "type"


def test_zip_bomb_and_hostile_archives_are_refused_without_500(api_client, vault_project, settings):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    bomb = zip_bytes({"word/document.xml": b"\x00" * (21 * 1024 * 1024)})
    assert len(bomb) < 64 * 1024
    bomb_id = upload(api_client, workspace, project, "bomb.docx", bomb)
    garbage_id = upload(api_client, workspace, project, "garbage.xlsx", b"not a zip archive")
    encrypted_id = upload(
        api_client, workspace, project, "secret.docx", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64
    )
    settings.PPM_VAULT_PREVIEW_ZIP_MAX_MEMBERS = 10
    crowded_id = upload(
        api_client,
        workspace,
        project,
        "crowded.pptx",
        zip_bytes({f"ppt/slides/slide{index}.xml": "<x/>" for index in range(20)}),
    )

    responses = {
        name: preview(api_client, workspace, project, entry_id)
        for name, entry_id in {
            "bomb": bomb_id,
            "garbage": garbage_id,
            "encrypted": encrypted_id,
            "crowded": crowded_id,
        }.items()
    }

    assert {name: response.status_code for name, response in responses.items()} == {
        "bomb": 200,
        "garbage": 200,
        "encrypted": 200,
        "crowded": 200,
    }
    assert {name: (response.data["kind"], response.data["reason"]) for name, response in responses.items()} == {
        "bomb": ("unsupported", "limits"),
        "garbage": ("unsupported", "invalid"),
        "encrypted": ("unsupported", "encrypted"),
        "crowded": ("unsupported", "limits"),
    }


def test_member_that_inflates_past_its_declared_size_is_rejected(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"<" * (256 * 1024))
        archive.filelist[0].file_size = 16
    entry_id = upload(api_client, workspace, project, "forged.docx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "invalid"


def test_exhausted_time_budget_returns_truncated_preview(api_client, vault_project, settings):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "Долгий.docx", docx_bytes(paragraph("Текст")))
    settings.PPM_VAULT_PREVIEW_TIME_BUDGET_MS = -1

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "docx"
    assert response.data["html"] == ""
    assert response.data["truncated"] is True


def test_source_over_preview_limit_is_not_read(api_client, vault_project, settings):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "big.txt", b"a" * 128)
    settings.PPM_VAULT_PREVIEW_SOURCE_MAX_BYTES = 64

    with patch.object(vault_preview, "open_private_object") as opened:
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "too_large"
    opened.assert_not_called()


def test_preview_is_cached_by_version_hash_and_refreshed_by_new_version(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "notes.txt", "первая версия".encode("utf-8"))

    with patch.object(vault_preview, "open_private_object", wraps=vault_preview.open_private_object) as opened:
        first = preview(api_client, workspace, project, entry_id)
        second = preview(api_client, workspace, project, entry_id)
        replaced = api_client.put(
            vault_url(workspace, project, f"entries/{entry_id}/file/"),
            {
                "base_version": "1",
                "file": SimpleUploadedFile("notes.txt", "вторая версия".encode("utf-8"), content_type="text/plain"),
            },
            format="multipart",
        )
        third = preview(api_client, workspace, project, entry_id)

    assert first.data["text"] == second.data["text"] == "первая версия"
    assert replaced.status_code == status.HTTP_200_OK
    assert third.data["version"] == 2
    assert third.data["text"] == "вторая версия"
    assert opened.call_count == 2


def test_preview_uses_vault_read_permissions(api_client, vault_project):
    owner, workspace, project = vault_project
    guest = make_user()
    outsider = make_user()
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=15)
    other_project = ProjectFactory(workspace=workspace, identifier="PRV2")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=owner, role=20)
    api_client.force_authenticate(user=owner)
    entry_id = upload(api_client, workspace, project, "secret.txt", b"private text")
    trashed_id = upload(api_client, workspace, project, "trashed.txt", b"gone")
    api_client.delete(vault_url(workspace, project, f"entries/{trashed_id}/"))

    foreign = api_client.get(vault_url(workspace, other_project, f"entries/{entry_id}/preview/"))
    trashed = preview(api_client, workspace, project, trashed_id)
    api_client.force_authenticate(user=guest)
    guest_response = preview(api_client, workspace, project, entry_id)
    api_client.force_authenticate(user=outsider)
    outsider_response = preview(api_client, workspace, project, entry_id)
    api_client.force_authenticate(user=None)
    anonymous = preview(api_client, workspace, project, entry_id)

    assert foreign.status_code == status.HTTP_404_NOT_FOUND
    assert foreign.data["error"]["code"] == "VAULT_ENTRY_NOT_FOUND"
    assert trashed.status_code == status.HTTP_404_NOT_FOUND
    assert guest_response.status_code == status.HTTP_200_OK
    assert guest_response.data["text"] == "private text"
    assert outsider_response.status_code == status.HTTP_403_FORBIDDEN
    assert outsider_response.data["error"]["code"] == "VAULT_PERMISSION_DENIED"
    assert "private text" not in str(outsider_response.data)
    assert anonymous.status_code == status.HTTP_401_UNAUTHORIZED


# --- Round 1 fixes (security review, PoC-driven) ------------------------------------------------


def test_bzip2_member_is_rejected_before_decompression(api_client, vault_project):
    # zipfile only bounds decompressed *output* to the requested read size for STORED/DEFLATED;
    # for BZIP2 it decompresses a whole chunk of *input* in one call, so a small, highly
    # compressible BZIP2 member (2 MiB of zeros compresses to a few hundred bytes) with a lied
    # declared size would previously be decompressed in full before our size cap ever saw it.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_BZIP2) as archive:
        with archive.open("word/document.xml", "w") as handle:
            handle.write(b"\x00" * (2 * 1024 * 1024))
        archive.getinfo("word/document.xml").file_size = 16
    entry_id = upload(api_client, workspace, project, "bzip2.docx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "limits"


def test_xlsx_member_that_inflates_past_its_declared_size_is_rejected(api_client, vault_project, settings):
    # Before the fix, _xlsx_payload handed openpyxl the raw bytes directly, and openpyxl reads
    # parts with a plain ZipFile.read() that ignores our settings entirely: a member whose
    # declared size understates its real content (here, [Content_Types].xml) would be inflated
    # in full regardless of PPM_VAULT_PREVIEW_ZIP_MAX_UNCOMPRESSED_BYTES.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    settings.PPM_VAULT_PREVIEW_ZIP_MAX_UNCOMPRESSED_BYTES = 20 * 1024
    source = zipfile.ZipFile(io.BytesIO(xlsx_bytes(5, 5)))
    forged_manifest = source.read("[Content_Types].xml") + b" " * (64 * 1024)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for info in source.infolist():
            payload = forged_manifest if info.filename == "[Content_Types].xml" else source.read(info.filename)
            archive.writestr(info.filename, payload)
        archive.getinfo("[Content_Types].xml").file_size = 16
    entry_id = upload(api_client, workspace, project, "forged.xlsx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    # Either outcome is an acceptable safe refusal: our own cap trips first ("limits"), or
    # zipfile's own truncate-to-declared-size bookkeeping notices the CRC mismatch before that
    # ("invalid") — the property under test is that reading this member is bounded to our cap
    # either way (never the full ~65 KiB of real content, let alone a PoC-scale payload), and
    # that neither path raises an unhandled exception (no 500).
    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] in {"limits", "invalid"}


def test_preview_returns_503_when_compute_slots_are_exhausted(api_client, vault_project):
    # The compute-slot gate only guards actual docx/xlsx/pptx parsing (round 3 narrowed its
    # scope), so this must be an Office file — a .txt upload would bypass the semaphore entirely
    # and the test would pass for the wrong reason (or not exercise the gate at all).
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "busy.docx", docx_bytes(paragraph("Занято")))

    vault_preview.PREVIEW_COMPUTE_SLOTS.acquire()
    vault_preview.PREVIEW_COMPUTE_SLOTS.acquire()
    try:
        response = preview(api_client, workspace, project, entry_id)
    finally:
        vault_preview.PREVIEW_COMPUTE_SLOTS.release()
        vault_preview.PREVIEW_COMPUTE_SLOTS.release()

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data["error"]["code"] == "VAULT_STORAGE_FAILED"


def test_storage_read_error_that_is_not_oserror_maps_to_503(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "cloud.txt", b"data")

    class _FailingReader:
        def read(self, *args, **kwargs):
            raise ClientError({"Error": {"Code": "InternalError", "Message": "boom"}}, "GetObject")

        def close(self):
            pass

    with patch.object(vault_preview, "open_private_object", return_value=_FailingReader()):
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data["error"]["code"] == "VAULT_STORAGE_FAILED"


def test_storage_open_failure_maps_to_503(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "offline.txt", b"data")

    with patch.object(vault_preview, "open_private_object", return_value=None):
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data["error"]["code"] == "VAULT_STORAGE_FAILED"


def test_time_truncated_preview_is_cached_with_a_short_ttl(api_client, vault_project, settings):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "Долгий2.docx", docx_bytes(paragraph("Текст")))
    settings.PPM_VAULT_PREVIEW_TIME_BUDGET_MS = -1

    with patch.object(vault_preview.cache, "set", wraps=vault_preview.cache.set) as cache_set:
        response = preview(api_client, workspace, project, entry_id)

    assert response.data["truncated"] is True
    assert cache_set.call_count == 1
    _, _, timeout = cache_set.call_args[0]
    assert timeout <= vault_preview.UNSTABLE_CACHE_TTL_SECONDS


def test_invalid_preview_is_cached_with_a_short_ttl(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "garbage2.xlsx", b"not a zip archive")

    with patch.object(vault_preview.cache, "set", wraps=vault_preview.cache.set) as cache_set:
        response = preview(api_client, workspace, project, entry_id)

    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "invalid"
    assert cache_set.call_count == 1
    _, _, timeout = cache_set.call_args[0]
    assert timeout <= vault_preview.UNSTABLE_CACHE_TTL_SECONDS


def test_empty_docx_paragraphs_do_not_count_toward_the_block_limit(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    filler = paragraph("") * (vault_preview.DOCX_MAX_BLOCKS + 500)
    body = paragraph("Начало") + filler + paragraph("Конец")
    entry_id = upload(api_client, workspace, project, "Пробелы.docx", docx_bytes(body))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "docx"
    assert response.data["truncated"] is False
    assert "<p>Начало</p>" in response.data["html"]
    assert "<p>Конец</p>" in response.data["html"]


def test_encrypted_zip_member_flag_is_rejected(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", "<irrelevant/>")
        archive.getinfo("word/document.xml").flag_bits |= 0x1
    entry_id = upload(api_client, workspace, project, "flagged.docx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "encrypted"


def test_folder_entry_has_no_preview(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    created = api_client.post(vault_url(workspace, project, "folders/"), {"name": "Папка"}, format="json")
    assert created.status_code == status.HTTP_201_CREATED, created.data

    response = preview(api_client, workspace, project, created.data["id"])

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == "VAULT_INVALID_FILE_TYPE"


def test_pptx_ignores_external_and_path_traversal_relationships(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    payload = pptx_bytes([(1, "Единственный", "Текст")])
    source = zipfile.ZipFile(io.BytesIO(payload))
    rels = source.read("ppt/_rels/presentation.xml.rels").decode()
    hostile_rels = rels.replace(
        "</Relationships>",
        f'<Relationship Id="rIdExternal" Type="{SLIDE_REL}" Target="http://evil.example/x.xml" '
        'TargetMode="External"/>'
        f'<Relationship Id="rIdTraversal" Type="{SLIDE_REL}" Target="../../../etc/passwd"/>'
        "</Relationships>",
    )
    presentation = source.read("ppt/presentation.xml").decode()
    hostile_presentation = presentation.replace(
        "</p:sldIdLst>",
        '<p:sldId id="900" r:id="rIdExternal"/><p:sldId id="901" r:id="rIdTraversal"/></p:sldIdLst>',
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for info in source.infolist():
            if info.filename == "ppt/_rels/presentation.xml.rels":
                archive.writestr(info.filename, hostile_rels)
            elif info.filename == "ppt/presentation.xml":
                archive.writestr(info.filename, hostile_presentation)
            else:
                archive.writestr(info.filename, source.read(info.filename))
    entry_id = upload(api_client, workspace, project, "hostile.pptx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "pptx"
    assert response.data["slides"] == [{"index": 1, "title": "Единственный", "text": "Текст"}]


# --- Round 2 fix (residual PoC case D: honest xlsx, one row of ~1.1M cells) ----------------------


def test_xlsx_worksheet_part_over_the_tree_cap_is_rejected(api_client, vault_project):
    # An honestly declared (not forged) worksheet part can still be adversarial: a single row of
    # ~1.1M small numeric cells is only ~2 MiB compressed but tens of MiB of XML, well under the
    # archive-wide zip_max_uncompressed_bytes yet expensive for openpyxl's read-only row
    # materialization regardless of max_col. This must be rejected on the worksheet part's own
    # (much smaller) cap before openpyxl ever sees it.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    source = zipfile.ZipFile(io.BytesIO(xlsx_bytes(5, 5)))
    rng = random.Random(11)
    rows = []
    size = 0
    while size < 6 * 1024 * 1024:
        row = f"<row><c><v>{rng.randrange(1000)}</v></c></row>"
        rows.append(row)
        size += len(row)
    huge_sheet = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>" + "".join(rows) + "</sheetData></worksheet>"
    ).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for info in source.infolist():
            payload = huge_sheet if info.filename == "xl/worksheets/sheet1.xml" else source.read(info.filename)
            archive.writestr(info.filename, payload)
    entry_id = upload(api_client, workspace, project, "huge-sheet.xlsx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "limits"


# --- Round 3 fixes (re-review: name-based cap bypass, weak repack test, amplification) ----------


def test_xlsx_worksheet_part_under_a_nonstandard_name_is_still_capped(api_client, vault_project):
    # openpyxl finds worksheet/sharedStrings parts via [Content_Types].xml and the workbook's own
    # relationships, not by a fixed path, so round 2's name-based cap (xl/worksheets/*.xml,
    # xl/sharedStrings.xml) could be bypassed by simply storing the sheet under a different member
    # name while updating the references to match. The cap must apply to every repacked member.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    source = zipfile.ZipFile(io.BytesIO(xlsx_bytes(5, 5)))
    members = {info.filename: source.read(info.filename) for info in source.infolist()}
    del members["xl/worksheets/sheet1.xml"]
    new_path = "xl/data/sheet1.xml"
    for name in ("xl/_rels/workbook.xml.rels", "[Content_Types].xml"):
        text = members[name].decode()
        assert "/xl/worksheets/sheet1.xml" in text, (name, text)
        members[name] = text.replace("/xl/worksheets/sheet1.xml", "/" + new_path).encode()
    rng = random.Random(13)
    rows = []
    size = 0
    while size < 6 * 1024 * 1024:
        row = f"<row><c><v>{rng.randrange(1000)}</v></c></row>"
        rows.append(row)
        size += len(row)
    members[new_path] = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>" + "".join(rows) + "</sheetData></worksheet>"
    ).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    entry_id = upload(api_client, workspace, project, "renamed-sheet.xlsx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "limits"


def test_xlsx_repacks_every_member_as_stored_before_handing_to_openpyxl(api_client, vault_project):
    # A test that only asserts the final "limits"/"invalid" outcome can pass on the old code too
    # (zipfile's own declared-size truncation plus a CRC mismatch already produces a safe refusal
    # for some forged inputs, independent of whether we repack at all — see round 1's report).
    # This instead verifies the repack mechanism itself: openpyxl must receive the repacked,
    # uncompressed in-memory archive, never the original compressed bytes.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    original = xlsx_bytes(3, 3)
    entry_id = upload(api_client, workspace, project, "normal.xlsx", original)

    with patch("openpyxl.load_workbook", wraps=load_workbook) as spy:
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    spy.assert_called_once()
    handed_bytes = spy.call_args[0][0].getvalue()
    assert handed_bytes != original
    repacked = zipfile.ZipFile(io.BytesIO(handed_bytes))
    assert repacked.infolist()
    assert {info.compress_type for info in repacked.infolist()} == {zipfile.ZIP_STORED}


# --- Round 4 fixes (duplicate names, allowlisted xlsx package, budget TTL, gate scope) ---------

S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
CHART_SHEET_PARTS = ("xl/chartsheets/", "xl/drawings/", "xl/charts/", "xl/media/")


def zip_entries(entries, compression=zipfile.ZIP_DEFLATED):
    # Writes entries in order and keeps repeated names (zipfile only warns about them), which is
    # exactly what a crafted archive's central directory can contain.
    buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with zipfile.ZipFile(buffer, "w", compression) as archive:
            for name, content in entries:
                archive.writestr(name, content)
    return buffer.getvalue()


def archive_members(payload):
    source = zipfile.ZipFile(io.BytesIO(payload))
    return {info.filename: source.read(info.filename) for info in source.infolist()}


def relationships(rels_xml):
    return [
        (rel.get("Id"), rel.get("Type"), rel.get("Target"))
        for rel in ElementTree.fromstring(rels_xml).iter(f"{{{REL_NS}}}Relationship")
    ]


def handed_package(spy):
    # The in-memory package preview.py handed to openpyxl.load_workbook (round 3 spy pattern).
    return archive_members(spy.call_args[0][0].getvalue())


def parts_with_root(package, localname):
    roots = [ElementTree.fromstring(data) for name, data in package.items() if name.endswith(".xml")]
    return [root for root in roots if root.tag.rsplit("}", 1)[-1] == localname]


def elements(root, localname):
    return [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == localname]


def _same_name_docx_entries():
    members = archive_members(docx_bytes(paragraph("Текст")))
    document = members.pop("word/document.xml")
    return list(members.items()) + [("word/document.xml", b"")] * 40 + [("word/document.xml", document)]


def _same_name_xlsx_entries():
    members = archive_members(xlsx_bytes(3, 3))
    sheet = members.pop("xl/worksheets/sheet1.xml")
    return list(members.items()) + [("xl/worksheets/sheet1.xml", b"")] * 40 + [("xl/worksheets/sheet1.xml", sheet)]


def _case_variant_xlsx_entries():
    members = archive_members(xlsx_bytes(3, 3))
    return list(members.items()) + [("XL/Workbook.XML", members["xl/workbook.xml"])]


def _separator_variant_docx_entries():
    members = archive_members(docx_bytes(paragraph("Текст")))
    return list(members.items()) + [("word\\document.xml", members["word/document.xml"])]


def _leading_slash_docx_entries():
    members = archive_members(docx_bytes(paragraph("Текст")))
    return list(members.items()) + [("/word/document.xml", members["word/document.xml"])]


@pytest.mark.parametrize(
    ("filename", "build_entries"),
    [
        ("same-name.docx", _same_name_docx_entries),
        ("same-name.xlsx", _same_name_xlsx_entries),
        ("case-variant.xlsx", _case_variant_xlsx_entries),
        ("separator-variant.docx", _separator_variant_docx_entries),
        ("leading-slash.docx", _leading_slash_docx_entries),
    ],
)
def test_duplicate_part_names_are_rejected_before_any_member_is_read(
    api_client, vault_project, filename, build_entries
):
    # zipfile resolves a name to the LAST central-directory entry carrying it, so N entries with
    # one name were read N times while _open_archive's declared-size total counted each (mostly
    # empty) entry once: a 0.43 MiB upload reached 1.79 GiB. OPC part names are case-insensitive,
    # so names that differ only by case, "\" vs "/" or a leading "/" are duplicates as well.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, filename, zip_entries(build_entries()))

    with patch.object(vault_preview, "_read_member", wraps=vault_preview._read_member) as read_member:
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "limits"
    assert read_member.call_count == 0


def test_rereading_one_part_is_charged_against_the_total_uncompressed_budget(api_client, vault_project, settings):
    # The central-directory total only covers each member once; every actual read is charged to
    # the same budget, so one slide listed ten times cannot be decompressed ten times for free.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    settings.PPM_VAULT_PREVIEW_ZIP_MAX_UNCOMPRESSED_BYTES = 16 * 1024
    members = archive_members(pptx_bytes([(1, "Слайд", "т" * 1500)]))
    members["ppt/presentation.xml"] = members["ppt/presentation.xml"].replace(
        b"</p:sldIdLst>",
        "".join(f'<p:sldId id="{300 + index}" r:id="rId2"/>' for index in range(9)).encode() + b"</p:sldIdLst>",
    )
    assert sum(len(data) for data in members.values()) < 16 * 1024
    entry_id = upload(api_client, workspace, project, "Повторы.pptx", zip_bytes(members))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "unsupported"
    assert response.data["reason"] == "limits"


def chartsheet_workbook_members():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Данные"
    for value in range(1, 6):
        sheet.append([value, f"строка {value}"])
    chartsheet = workbook.create_chartsheet("Диаграмма")
    chart = BarChart()
    chart.add_data(Reference(sheet, min_col=1, min_row=1, max_row=5))
    chartsheet.add_chart(chart)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return archive_members(buffer.getvalue())


def test_xlsx_package_for_openpyxl_has_no_chartsheets_or_charts_and_each_sheet_once(api_client, vault_project):
    # openpyxl parses a chartsheet (and every chart of its drawing) once per <sheet> referencing
    # it, inside load_workbook where the time budget is never checked: 100 references to one small
    # chartsheet ran out of memory. Only worksheets found through the workbook's relationships
    # reach openpyxl, and each worksheet part only once however many <sheet> entries point to it.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    members = chartsheet_workbook_members()
    members["xl/media/image1.png"] = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 16
    assert all(any(name.startswith(prefix) for name in members) for prefix in CHART_SHEET_PARTS)
    rels = relationships(members["xl/_rels/workbook.xml.rels"])
    worksheet_id = next(rel_id for rel_id, rel_type, _ in rels if rel_type.endswith("/worksheet"))
    chartsheet_type, chartsheet_target = next((t, target) for _, t, target in rels if t.endswith("/chartsheet"))
    members["xl/_rels/workbook.xml.rels"] = members["xl/_rels/workbook.xml.rels"].replace(
        b"</Relationships>",
        "".join(
            f'<Relationship Id="rChart{index}" Type="{chartsheet_type}" Target="{chartsheet_target}"/>'
            for index in range(60)
        ).encode()
        + b"</Relationships>",
    )
    extra_sheets = [
        f'<sheet xmlns:r="{R_NS}" name="Диаграмма {index}" sheetId="{100 + index}" r:id="rChart{index}"/>'
        for index in range(60)
    ] + [
        f'<sheet xmlns:r="{R_NS}" name="Копия {index}" sheetId="{200 + index}" r:id="{worksheet_id}"/>'
        for index in range(30)
    ]
    members["xl/workbook.xml"] = members["xl/workbook.xml"].replace(
        b"</sheets>", "".join(extra_sheets).encode() + b"</sheets>"
    )
    entry_id = upload(api_client, workspace, project, "Диаграммы.xlsx", zip_bytes(members))

    with patch("openpyxl.load_workbook", wraps=load_workbook) as spy:
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    assert [sheet["name"] for sheet in response.data["sheets"]] == ["Данные"]
    assert response.data["sheets"][0]["rows"][:2] == [["1", "строка 1"], ["2", "строка 2"]]
    package = handed_package(spy)
    assert [name for name in package if name.startswith(CHART_SHEET_PARTS)] == []
    (workbook_part,) = parts_with_root(package, "workbook")
    assert len(elements(workbook_part, "sheet")) == 1


def test_xlsx_hands_at_most_twenty_worksheets_to_openpyxl(api_client, vault_project):
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    workbook = Workbook()
    for index in range(1, 26):
        sheet = workbook.active if index == 1 else workbook.create_sheet()
        sheet.title = f"Лист {index}"
        sheet["A1"] = index
    buffer = io.BytesIO()
    workbook.save(buffer)
    entry_id = upload(api_client, workspace, project, "Много листов.xlsx", buffer.getvalue())

    with patch("openpyxl.load_workbook", wraps=load_workbook) as spy:
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    assert response.data["truncated"] is True
    assert [sheet["name"] for sheet in response.data["sheets"]] == [f"Лист {index}" for index in range(1, 6)]
    (workbook_part,) = parts_with_root(handed_package(spy), "workbook")
    assert [sheet.get("name") for sheet in elements(workbook_part, "sheet")] == [f"Лист {i}" for i in range(1, 21)]


def test_xlsx_worksheet_is_resolved_through_relationships_with_parent_segments_and_case(api_client, vault_project):
    # Parts are found through relationships (never by member name): the target is resolved against
    # the source part's folder with "../" collapsed and matched case-insensitively, as OPC requires.
    # [Content_Types].xml still names the old path on purpose.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    members = archive_members(xlsx_bytes(3, 3))
    members["xl/data/s1.xml"] = members.pop("xl/worksheets/sheet1.xml")
    rels = members["xl/_rels/workbook.xml.rels"]
    assert b'Target="/xl/worksheets/sheet1.xml"' in rels
    members["xl/_rels/workbook.xml.rels"] = rels.replace(
        b'Target="/xl/worksheets/sheet1.xml"', b'Target="../xl/DATA/S1.xml"'
    )
    entry_id = upload(api_client, workspace, project, "Перенесённый лист.xlsx", zip_bytes(members))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    assert response.data["sheets"][0]["name"] == "Бюджет"
    assert response.data["sheets"][0]["rows"][0][:3] == ["Статья", "1250", ""]


def test_xlsx_with_a_large_embedded_image_still_previews(api_client, vault_project):
    # Media are never read for a values preview, so a picture bigger than the per-part cap no
    # longer costs an ordinary workbook its preview.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    members = archive_members(xlsx_bytes(3, 3))
    members["xl/media/image1.png"] = random.Random(17).randbytes(3 * 1024 * 1024).hex().encode()
    assert len(members["xl/media/image1.png"]) > vault_preview.XML_TREE_MAX_BYTES
    entry_id = upload(api_client, workspace, project, "С картинкой.xlsx", zip_bytes(members))

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    assert response.data["sheets"][0]["rows"][0][:3] == ["Статья", "1250", ""]


def test_xlsx_dates_and_the_1904_date_system_survive_the_rebuilt_package(api_client, vault_project):
    # Workbook properties reach openpyxl reduced to the date system and styles to "which cell
    # formats are dates" — all a values preview reads. Dates must still come out as dates, in the
    # right epoch, for built-in (14) and custom (>= 164) formats alike.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    workbook = Workbook()
    workbook.epoch = CALENDAR_MAC_1904
    sheet = workbook.active
    sheet["A1"] = datetime.date(2026, 9, 25)
    sheet["B1"] = datetime.datetime(2026, 9, 25, 13, 30)
    sheet["B1"].number_format = "dd.mm.yyyy hh:mm"
    sheet["C1"] = 1250.5
    sheet["C1"].number_format = "#,##0.00"
    sheet["D1"] = datetime.date(2026, 1, 2)
    sheet["D1"].number_format = "mm-dd-yy"
    buffer = io.BytesIO()
    workbook.save(buffer)
    entry_id = upload(api_client, workspace, project, "Даты.xlsx", buffer.getvalue())

    response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["sheets"][0]["rows"] == [["2026-09-25", "2026-09-25 13:30:00", "1250.5", "2026-01-02"]]


def test_xlsx_defined_names_and_named_styles_never_reach_openpyxl(api_client, vault_project):
    # Inside load_workbook, where the time budget is never checked, openpyxl 3.1.2 parses print
    # titles with a regex that is quadratic in the defined name's length (32 KiB ~ 3.5 s, 128 KiB
    # ~ 50 s) and expands every named style against the whole custom number-format list. A values
    # preview needs neither, so neither is handed over.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    members = archive_members(xlsx_bytes(3, 3))
    assert b"<definedNames/>" in members["xl/workbook.xml"]
    titles = f'<definedName name="_xlnm.Print_Titles" localSheetId="0">{"a" * (32 * 1024)}</definedName>'
    members["xl/workbook.xml"] = members["xl/workbook.xml"].replace(
        b"<definedNames/>", f"<definedNames>{titles}</definedNames>".encode()
    )
    count = 4000
    number_formats = "".join(f'<numFmt numFmtId="{164 + index % 50}" formatCode="0.0"/>' for index in range(count))
    named_style_formats = '<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/>' * count
    named_styles = "".join(f'<cellStyle name="s{index}" xfId="{index}"/>' for index in range(count))
    members["xl/styles.xml"] = (
        f'<styleSheet xmlns="{S_NS}"><numFmts count="{count}">{number_formats}</numFmts>'
        '<fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
        f'<borders count="1"><border/></borders><cellStyleXfs count="{count}">{named_style_formats}</cellStyleXfs>'
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
        f'<cellStyles count="{count}">{named_styles}</cellStyles></styleSheet>'
    ).encode()
    entry_id = upload(api_client, workspace, project, "Метаданные.xlsx", zip_bytes(members))

    with patch("openpyxl.load_workbook", wraps=load_workbook) as spy:
        response = preview(api_client, workspace, project, entry_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "xlsx"
    assert response.data["sheets"][0]["rows"][0][:3] == ["Статья", "1250", ""]
    package = handed_package(spy)
    (workbook_part,) = parts_with_root(package, "workbook")
    assert elements(workbook_part, "definedName") == []
    (styles_part,) = parts_with_root(package, "styleSheet")
    assert elements(styles_part, "numFmt") == []
    assert len(elements(styles_part, "cellStyle")) <= 1


def test_time_budget_limits_get_a_short_ttl_but_size_limits_keep_the_full_one(api_client, vault_project, settings):
    # Running out of time depends on server load at that moment, not on the file, so such a
    # "limits" must not stick in the cache for a day; a size/structure "limits" is deterministic.
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    slow_id = upload(api_client, workspace, project, "Медленно.xlsx", xlsx_bytes(3, 3))
    bomb_id = upload(
        api_client, workspace, project, "bomb2.docx", zip_bytes({"word/document.xml": b"\x00" * (21 * 1024 * 1024)})
    )
    settings.PPM_VAULT_PREVIEW_TIME_BUDGET_MS = -1

    with patch.object(vault_preview.cache, "set", wraps=vault_preview.cache.set) as cache_set:
        slow = preview(api_client, workspace, project, slow_id)
        bomb = preview(api_client, workspace, project, bomb_id)

    assert (slow.data["kind"], slow.data["reason"]) == ("unsupported", "limits")
    assert (bomb.data["kind"], bomb.data["reason"]) == ("unsupported", "limits")
    slow_call, bomb_call = cache_set.call_args_list
    assert slow_call.args[2] <= vault_preview.UNSTABLE_CACHE_TTL_SECONDS
    assert bomb_call.args[2] == vault_preview.preview_limits()["cache_seconds"]


def test_text_preview_does_not_wait_for_a_compute_slot(api_client, vault_project):
    # The compute-slot gate covers only docx/xlsx/pptx parsing: with both slots taken, plain text
    # still previews (the 503 counterpart is test_preview_returns_503_when_compute_slots_are_exhausted).
    user, workspace, project = vault_project
    api_client.force_authenticate(user=user)
    entry_id = upload(api_client, workspace, project, "free.txt", "без очереди".encode("utf-8"))

    vault_preview.PREVIEW_COMPUTE_SLOTS.acquire()
    vault_preview.PREVIEW_COMPUTE_SLOTS.acquire()
    try:
        response = preview(api_client, workspace, project, entry_id)
    finally:
        vault_preview.PREVIEW_COMPUTE_SLOTS.release()
        vault_preview.PREVIEW_COMPUTE_SLOTS.release()

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "text"
    assert response.data["text"] == "без очереди"
