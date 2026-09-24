import json
import uuid
from io import BytesIO, StringIO
from pathlib import Path

import pytest
from botocore.exceptions import ClientError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from rest_framework.test import APIClient

from plane.db.models import FileAsset, Issue, Project, ProjectMember, User, Workspace, WorkspaceMember
from plane.license.models import Instance
from plane.ppm_canvas.models import PpmCanvasVersion, PpmGlobalAdmin, PpmProjectCanvas
from plane.ppm_vault.models import PpmVaultVersion
from plane.tests.management.commands.ppm_asset_restore_support import ASSET_CONTENT, ASSET_HASH, guarded_asset_client


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def test_browser_gate_fixture_is_isolated_and_never_prints_passwords(monkeypatch):
    slug = f"af12-ci-{uuid.uuid4().hex[:10]}"
    passwords = {
        "OWNER": "fixture-owner-password",
        "MEMBER": "fixture-member-password",
        "GUEST": "fixture-guest-password",
        "GLOBAL": "fixture-global-password",
    }
    monkeypatch.setenv("PPM_E2E_ALLOW_SEED", "1")
    for role, password in passwords.items():
        monkeypatch.setenv(f"PPM_E2E_{role}_PASSWORD", password)

    output = StringIO()
    call_command("seed_ppm_canvas_browser_gate", slug=slug, stdout=output)
    result = json.loads(output.getvalue())
    assert result["PPM_E2E_WORKSPACE_SLUG"] == slug
    assert not any(password in output.getvalue() for password in passwords.values())

    workspace = Workspace.objects.get(id=result["PPM_E2E_WORKSPACE_ID"])
    instance = Instance.objects.get()
    assert instance.is_test and instance.is_setup_done and not instance.is_telemetry_enabled
    project_id = result["PPM_E2E_PROJECT_ID"]
    other_project_id = result["PPM_E2E_OTHER_PROJECT_ID"]
    assert workspace.owner.email == result["PPM_E2E_OWNER_EMAIL"]
    assert PpmProjectCanvas.objects.filter(workspace_id=workspace.id, project_id=project_id).exists()
    assert PpmProjectCanvas.objects.filter(workspace_id=workspace.id, project_id=other_project_id).exists()

    for role, expected_role in (("OWNER", 20), ("MEMBER", 15), ("GUEST", 5)):
        user = User.objects.get(email=result[f"PPM_E2E_{role}_EMAIL"])
        assert user.check_password(passwords[role])
        assert user.profile.is_onboarded
        assert user.profile.last_workspace_id == workspace.id
        assert ProjectMember.objects.get(project_id=project_id, member=user).role == expected_role
        assert not PpmGlobalAdmin.objects.filter(user=user).exists()
        if role != "OWNER":
            assert not ProjectMember.objects.filter(project_id=other_project_id, member=user).exists()

    global_admin = User.objects.get(email=result["PPM_E2E_GLOBAL_EMAIL"])
    assert global_admin.check_password(passwords["GLOBAL"])
    assert global_admin.profile.is_onboarded
    assert not ProjectMember.objects.filter(member=global_admin).exists()
    assert not WorkspaceMember.objects.filter(member=global_admin).exists()
    assert PpmGlobalAdmin.objects.filter(user=global_admin, revoked_at__isnull=True).exists()

    member = User.objects.get(email=result["PPM_E2E_MEMBER_EMAIL"])
    client = APIClient()
    client.force_authenticate(user=member)
    denied = client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{other_project_id}/canvas/")
    assert denied.status_code == 403

    with pytest.raises(CommandError, match="already exist"):
        call_command("seed_ppm_canvas_browser_gate", slug=slug, stdout=StringIO())
    assert ProjectMember.objects.filter(project_id=project_id).count() == 3


def test_browser_gate_fixture_requires_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("PPM_E2E_ALLOW_SEED", raising=False)
    with pytest.raises(CommandError, match="disposable test database"):
        call_command("seed_ppm_canvas_browser_gate", slug=f"af12-ci-{uuid.uuid4().hex[:10]}", stdout=StringIO())


def test_asset_restore_guard_rejects_non_disposable_object_store(monkeypatch):
    monkeypatch.setenv("AWS_S3_ENDPOINT_URL", "https://storage.example.invalid")
    monkeypatch.setenv("AWS_S3_BUCKET_NAME", "ppm-af12-source")
    with pytest.raises(CommandError, match="not the disposable MinIO"):
        guarded_asset_client()


def test_vault_restore_seed_rejects_non_disposable_storage(monkeypatch, settings, tmp_path):
    monkeypatch.setenv("PPM_E2E_ALLOW_SEED", "1")
    settings.PPM_LOCAL_ASSET_UPLOADS = True
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "ordinary-vault")
    with pytest.raises(CommandError, match="disposable local storage root"):
        call_command(
            "seed_ppm_vault_restore_gate",
            workspace_id=str(uuid.uuid4()),
            project_id=str(uuid.uuid4()),
            stdout=StringIO(),
        )


def test_restore_gate_checks_saved_history_roles_and_corruption(monkeypatch, settings, tmp_path):
    slug = f"af12-ci-{uuid.uuid4().hex[:10]}"
    monkeypatch.setenv("PPM_E2E_ALLOW_SEED", "1")
    settings.PPM_LOCAL_ASSET_UPLOADS = True
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "ppm-af12-vault-source")
    for role in ("OWNER", "MEMBER", "GUEST", "GLOBAL"):
        monkeypatch.setenv(f"PPM_E2E_{role}_PASSWORD", f"fixture-{role.lower()}-password")
    seed_output = StringIO()
    call_command("seed_ppm_canvas_browser_gate", slug=slug, stdout=seed_output)
    fixture = json.loads(seed_output.getvalue())
    options = {
        "workspace_id": fixture["PPM_E2E_WORKSPACE_ID"],
        "project_id": fixture["PPM_E2E_PROJECT_ID"],
        "other_project_id": fixture["PPM_E2E_OTHER_PROJECT_ID"],
    }
    with pytest.raises(CommandError, match="saved, non-empty Canvas history"):
        call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)

    owner = User.objects.get(email=fixture["PPM_E2E_OWNER_EMAIL"])
    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.put(
        f"/api/ppm/v1/workspaces/{options['workspace_id']}/projects/{options['project_id']}/canvas/",
        {
            "schema_version": 2,
            "base_version": 0,
            "snapshot": {
                "document": {
                    "store": {"shape:backup": {"id": "shape:backup", "typeName": "shape", "type": "ppm-canvas-node"}}
                },
                "session": {},
            },
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert response.status_code == 200

    vault_output = StringIO()
    call_command(
        "seed_ppm_vault_restore_gate",
        workspace_id=options["workspace_id"],
        project_id=options["project_id"],
        stdout=vault_output,
    )
    assert json.loads(vault_output.getvalue()) == {"file_count": 1, "markdown_count": 1, "version_count": 4}

    with pytest.raises(CommandError, match="synthetic Work Item is missing"):
        call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)
    work_item_output = StringIO()
    call_command(
        "seed_ppm_work_item_restore_gate",
        workspace_id=options["workspace_id"],
        project_id=options["project_id"],
        stdout=work_item_output,
    )
    assert json.loads(work_item_output.getvalue()) == {"work_item_count": 1, "sequence_id": 1}

    with pytest.raises(CommandError, match="synthetic Plane attachment is missing"):
        call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)

    objects = {}

    class FakeObjectClient:
        def put_object(self, *, Bucket, Key, Body, ContentType):
            assert ContentType == "text/plain"
            objects[(Bucket, Key)] = Body

        def get_object(self, *, Bucket, Key):
            if (Bucket, Key) not in objects:
                raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
            return {"Body": BytesIO(objects[(Bucket, Key)])}

    object_client = FakeObjectClient()
    monkeypatch.setattr(
        "plane.tests.management.commands.seed_ppm_asset_restore_gate.guarded_asset_client",
        lambda: (object_client, "ppm-af12-source"),
    )
    monkeypatch.setattr(
        "plane.tests.management.commands.verify_ppm_canvas_restore_gate.guarded_asset_client",
        lambda *, restored=False: (object_client, "ppm-af12-restore" if restored else "ppm-af12-source"),
    )
    asset_output = StringIO()
    call_command(
        "seed_ppm_asset_restore_gate",
        workspace_id=options["workspace_id"],
        project_id=options["project_id"],
        stdout=asset_output,
    )
    assert json.loads(asset_output.getvalue()) == {"attachment_count": 1, "content_sha256": ASSET_HASH}

    verify_output = StringIO()
    call_command("verify_ppm_canvas_restore_gate", stdout=verify_output, **options)
    evidence = json.loads(verify_output.getvalue())
    assert evidence["board_count"] == 2
    assert evidence["version_count"] == 1
    assert evidence["vault_entry_count"] == 2
    assert evidence["vault_version_count"] == 4
    assert evidence["work_item_count"] == 1
    assert evidence["plane_attachment_count"] == 1
    assert len(evidence["digest"]) == 64
    object_key = next(key for bucket, key in objects if bucket == "ppm-af12-source")
    with pytest.raises(CommandError, match="Plane attachment object missing"):
        call_command("verify_ppm_canvas_restore_gate", asset_storage="restore", stdout=StringIO(), **options)
    objects[("ppm-af12-restore", object_key)] = objects[("ppm-af12-source", object_key)]
    restored_asset_output = StringIO()
    call_command("verify_ppm_canvas_restore_gate", asset_storage="restore", stdout=restored_asset_output, **options)
    assert restored_asset_output.getvalue() == verify_output.getvalue()

    asset = FileAsset.objects.get(issue__name="AF1.2 проверка восстановления задачи")
    attachment_paths = (
        (f"/api/workspaces/{slug}/projects/{options['project_id']}/issues/{asset.issue_id}/issue-attachments/", False),
        (
            f"/api/assets/v2/workspaces/{slug}/projects/{options['project_id']}/issues/{asset.issue_id}/attachments/",
            True,
        ),
        (
            f"/api/v1/workspaces/{slug}/projects/{options['project_id']}/issues/{asset.issue_id}/issue-attachments/",
            True,
        ),
    )
    client.force_authenticate(user=User.objects.get(email=fixture["PPM_E2E_GUEST_EMAIL"]))
    for path, supports_patch in attachment_paths:
        assert client.get(path).status_code == 403
        assert client.get(f"{path}{asset.id}/").status_code == 403
        assert client.post(path, {}, format="json").status_code == 403
        assert client.patch(f"{path}{asset.id}/", {}, format="json").status_code == (403 if supports_patch else 405)
        assert client.delete(f"{path}{asset.id}/").status_code == 403

    guest = User.objects.get(email=fixture["PPM_E2E_GUEST_EMAIL"])
    guest_issue = Issue(
        project_id=options["project_id"],
        state_id=asset.issue.state_id,
        name="AF1.2 гостевая тестовая задача",
    )
    guest_issue.save(created_by_id=guest.id)
    guest_paths = (
        f"/api/workspaces/{slug}/projects/{options['project_id']}/issues/{guest_issue.id}/issue-attachments/",
        f"/api/assets/v2/workspaces/{slug}/projects/{options['project_id']}/issues/{guest_issue.id}/attachments/",
        f"/api/v1/workspaces/{slug}/projects/{options['project_id']}/issues/{guest_issue.id}/issue-attachments/",
    )
    for path in guest_paths:
        assert client.get(path).status_code == 200
    for path in guest_paths[1:]:
        assert client.get(f"{path}{asset.id}/").status_code == 404
    Project.objects.filter(id=options["project_id"]).update(guest_view_all_features=True)
    try:
        for path, _ in attachment_paths:
            assert client.get(path).status_code == 200
    finally:
        Project.objects.filter(id=options["project_id"]).update(guest_view_all_features=False)

    login_options = {**options, "expected_database": connection.settings_dict["NAME"]}
    login_output = StringIO()
    call_command("verify_ppm_restore_login_gate", stdout=login_output, **login_options)
    assert "4 synthetic roles" in login_output.getvalue()
    monkeypatch.setenv("PPM_E2E_MEMBER_PASSWORD", "incorrect-member-password")
    with pytest.raises(CommandError, match="password session login failed"):
        call_command("verify_ppm_restore_login_gate", stdout=StringIO(), **login_options)
    monkeypatch.setenv("PPM_E2E_MEMBER_PASSWORD", "fixture-member-password")

    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "ppm-af12-vault-restore")
    with pytest.raises(CommandError, match="Vault object missing"):
        call_command("verify_ppm_canvas_restore_gate", vault_storage="restore", stdout=StringIO(), **options)
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "ppm-af12-vault-source")

    original_object = objects.pop(("ppm-af12-source", object_key))
    try:
        with pytest.raises(CommandError, match="Plane attachment object missing"):
            call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)
    finally:
        objects[("ppm-af12-source", object_key)] = original_object
    objects[("ppm-af12-source", object_key)] = b"corrupted synthetic attachment"
    try:
        with pytest.raises(CommandError, match="Plane attachment object checksum"):
            call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)
    finally:
        objects[("ppm-af12-source", object_key)] = original_object
    assert original_object == ASSET_CONTENT

    with pytest.raises(CommandError, match="wrong database"):
        call_command(
            "verify_ppm_canvas_restore_gate", expected_database="test_af12_wrong", stdout=StringIO(), **options
        )

    file_version = PpmVaultVersion.objects.get(entry__name="af12-backup-proof.txt", version=1)
    file_path = Path(settings.PPM_VAULT_STORAGE_ROOT) / file_version.object_key
    original_file = file_path.read_bytes()
    try:
        file_path.write_bytes(b"corrupted synthetic backup proof\n")
        with pytest.raises(CommandError, match="Vault content checksum"):
            call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)
    finally:
        file_path.write_bytes(original_file)

    Issue.objects.filter(project_id=options["project_id"], name="AF1.2 проверка восстановления задачи").update(
        priority="low"
    )
    with pytest.raises(CommandError, match="Work Item state"):
        call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)
    Issue.objects.filter(project_id=options["project_id"], name="AF1.2 проверка восстановления задачи").update(
        priority="medium"
    )

    PpmCanvasVersion.objects.filter(board__project_id=options["project_id"]).update(content_hash="0" * 64)
    with pytest.raises(CommandError, match="checksum"):
        call_command("verify_ppm_canvas_restore_gate", stdout=StringIO(), **options)
