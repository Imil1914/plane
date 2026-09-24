"""Read-only integrity check for the disposable AF1.2 backup/restore drill."""

import hashlib
import json

from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from rest_framework.test import APIClient

from plane.db.models import FileAsset, Issue, IssueSequence, Project, ProjectMember, StateGroup, Workspace
from plane.ppm_canvas.models import PpmCanvasBoard, PpmCanvasOperation, PpmCanvasVersion
from plane.ppm_canvas.schema import canvas_snapshot_hash
from plane.ppm_vault.models import PpmVaultEntry, PpmVaultVersion
from plane.ppm_vault.storage import open_private_object
from plane.tests.management.commands.ppm_asset_restore_support import (
    ASSET_CONTENT,
    ASSET_HASH,
    ASSET_NAME,
    guarded_asset_client,
    read_asset_object,
)
from plane.tests.management.commands.seed_ppm_canvas_browser_gate import _require_disposable_database
from plane.tests.management.commands.seed_ppm_vault_restore_gate import (
    FILE_CONTENTS,
    FILE_NAME,
    MARKDOWN_CONTENTS,
    MARKDOWN_NAME,
    require_disposable_vault_root,
)
from plane.tests.management.commands.seed_ppm_work_item_restore_gate import WORK_ITEM_NAME


class Command(BaseCommand):
    help = "Verify AF1.2 Canvas, Vault, Work Item, Plane attachment and roles after restore."

    def add_arguments(self, parser):
        parser.add_argument("--workspace-id", required=True)
        parser.add_argument("--project-id", required=True)
        parser.add_argument("--other-project-id", required=True)
        parser.add_argument("--expected-database")
        parser.add_argument("--vault-storage", choices=("source", "restore"), default="source")
        parser.add_argument("--asset-storage", choices=("source", "restore"), default="source")

    def handle(self, *args, **options):
        _require_disposable_database()
        if options["expected_database"] and connection.settings_dict["NAME"] != options["expected_database"]:
            raise CommandError("AF1.2 restore verification connected to the wrong database.")
        require_disposable_vault_root(restored=options["vault_storage"] == "restore")
        workspace = Workspace.objects.filter(id=options["workspace_id"], slug__startswith="af12-").first()
        if workspace is None:
            raise CommandError("AF1.2 disposable workspace is missing.")
        project_ids = [options["project_id"], options["other_project_id"]]
        projects = list(Project.objects.filter(id__in=project_ids, workspace=workspace).order_by("id"))
        if len(projects) != 2 or projects[0].id == projects[1].id:
            raise CommandError("Both distinct AF1.2 projects must exist in the same workspace.")

        memberships = list(
            ProjectMember.objects.filter(project_id=options["project_id"], is_active=True)
            .select_related("member")
            .order_by("role", "member_id")
        )
        by_role = {membership.role: membership.member for membership in memberships}
        if (
            len(memberships) != 3
            or set(by_role) != {5, 15, 20}
            or any(not user.email.endswith("@ppm.test") for user in by_role.values())
            or workspace.owner_id != by_role[20].id
        ):
            raise CommandError("AF1.2 synthetic project roles are missing or inconsistent.")
        other_memberships = list(ProjectMember.objects.filter(project_id=options["other_project_id"], is_active=True))
        if len(other_memberships) != 1 or other_memberships[0].member_id != by_role[20].id:
            raise CommandError("The second AF1.2 project must remain owner-only.")

        boards = list(PpmCanvasBoard.objects.filter(project_id__in=project_ids).order_by("project_id", "id"))
        if not boards or {str(board.project_id) for board in boards} != set(project_ids):
            raise CommandError("Both AF1.2 projects must retain their Canvas boards.")
        versions = list(PpmCanvasVersion.objects.filter(board__in=boards).order_by("board_id", "version", "id"))
        if not versions:
            raise CommandError("The backup drill requires a saved, non-empty Canvas history.")
        current_versions = {board.id: 0 for board in boards}
        for version in versions:
            if version.content_hash != canvas_snapshot_hash(version.snapshot_json):
                raise CommandError("AF1.2 Canvas snapshot checksum does not match its stored version.")
            current_versions[version.board_id] = max(current_versions[version.board_id], version.version)
        if any(board.current_version != current_versions[board.id] for board in boards):
            raise CommandError("AF1.2 board current version does not match restored history.")

        canvas_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project_ids[0]}/canvas/"
        other_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project_ids[1]}/canvas/"
        client = APIClient()
        for role, expected_access in ((20, "edit"), (15, "edit"), (5, "read")):
            client.force_authenticate(user=by_role[role])
            response = client.get(canvas_url)
            if response.status_code != 200 or response.data.get("access") != expected_access:
                raise CommandError("AF1.2 Canvas API role access was not restored.")
        client.force_authenticate(user=by_role[15])
        if client.get(other_url).status_code != 403:
            raise CommandError("AF1.2 cross-project isolation was not restored.")

        vault_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project_ids[0]}/vault/"
        vault_entries = list(
            PpmVaultEntry.objects.filter(project_id=project_ids[0], name__in=(FILE_NAME, MARKDOWN_NAME))
            .select_related("current_version")
            .order_by("name")
        )
        if len(vault_entries) != 2 or {entry.name for entry in vault_entries} != {FILE_NAME, MARKDOWN_NAME}:
            raise CommandError("AF1.2 synthetic Vault entries are missing.")
        vault_versions = []
        for entry in vault_entries:
            entry_versions = list(PpmVaultVersion.objects.filter(entry=entry).order_by("version"))
            if len(entry_versions) != 2 or [version.version for version in entry_versions] != [1, 2]:
                raise CommandError("AF1.2 synthetic Vault version history is incomplete.")
            if (
                entry.current_version_id != entry_versions[-1].id
                or entry.content_hash != entry_versions[-1].content_hash
            ):
                raise CommandError("AF1.2 Vault current version does not match its history.")
            expected_contents = FILE_CONTENTS if entry.name == FILE_NAME else MARKDOWN_CONTENTS
            for version, expected in zip(entry_versions, expected_contents, strict=True):
                if entry.name == FILE_NAME:
                    try:
                        with open_private_object(version.object_key) as file_obj:
                            content = file_obj.read()
                    except OSError as exc:
                        raise CommandError("AF1.2 Vault object missing after restore.") from exc
                else:
                    content = version.content_text.encode("utf-8")
                    expected = expected.encode("utf-8")
                if (
                    content != expected
                    or version.size_bytes != len(content)
                    or version.content_hash != hashlib.sha256(content).hexdigest()
                ):
                    raise CommandError("AF1.2 Vault content checksum or size does not match its version.")
                vault_versions.append(version)

        client.force_authenticate(user=by_role[5])
        for entry in vault_entries:
            suffix = "" if entry.name == FILE_NAME else "content/"
            response = client.get(f"{vault_url}entries/{entry.id}/{suffix}")
            if response.status_code != 200:
                raise CommandError("AF1.2 Vault guest read access was not restored.")
            if entry.name == MARKDOWN_NAME and response.data.get("content") != MARKDOWN_CONTENTS[-1]:
                raise CommandError("AF1.2 Vault API did not return the restored note.")
            if entry.name == FILE_NAME and response.data.get("version") != 2:
                raise CommandError("AF1.2 Vault API did not return the restored file version.")
        client.force_authenticate(user=by_role[15])
        other_vault_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project_ids[1]}/vault/"
        if client.get(other_vault_url).status_code != 403:
            raise CommandError("AF1.2 Vault cross-project isolation was not restored.")

        work_items = list(Issue.objects.filter(project_id=project_ids[0], name=WORK_ITEM_NAME).select_related("state"))
        if len(work_items) != 1:
            raise CommandError("AF1.2 synthetic Work Item is missing.")
        work_item = work_items[0]
        if (
            work_item.created_by_id != by_role[20].id
            or work_item.state is None
            or work_item.state.group != StateGroup.BACKLOG.value
            or work_item.priority != "medium"
            or work_item.sequence_id < 1
            or work_item.is_draft
            or work_item.archived_at is not None
            or not IssueSequence.objects.filter(
                issue=work_item, project_id=project_ids[0], sequence=work_item.sequence_id
            ).exists()
        ):
            raise CommandError("AF1.2 Work Item state or sequence was not restored.")
        work_item_url = f"/api/workspaces/{workspace.slug}/projects/{project_ids[0]}/issues/{work_item.id}/"
        for role in (20, 15):
            client.force_authenticate(user=by_role[role])
            response = client.get(work_item_url)
            if response.status_code != 200 or response.data.get("name") != WORK_ITEM_NAME:
                raise CommandError("AF1.2 Work Item API access was not restored.")
        client.force_authenticate(user=by_role[5])
        if client.get(work_item_url).status_code != 403:
            raise CommandError("AF1.2 guest unexpectedly read another user's Work Item.")

        assets = list(
            FileAsset.objects.filter(issue=work_item, entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT)
        )
        if len(assets) != 1:
            raise CommandError("AF1.2 synthetic Plane attachment is missing.")
        asset = assets[0]
        if (
            not asset.is_uploaded
            or asset.is_deleted
            or asset.workspace_id != workspace.id
            or str(asset.project_id) != project_ids[0]
            or asset.created_by_id != by_role[20].id
            or asset.attributes.get("name") != ASSET_NAME
            or asset.size != len(ASSET_CONTENT)
        ):
            raise CommandError("AF1.2 Plane attachment metadata was not restored.")
        object_client, bucket = guarded_asset_client(restored=options["asset_storage"] == "restore")
        content = read_asset_object(object_client, bucket, asset.asset.name)
        if content != ASSET_CONTENT or hashlib.sha256(content).hexdigest() != ASSET_HASH:
            raise CommandError("AF1.2 Plane attachment object checksum does not match.")
        attachment_url = (
            f"/api/workspaces/{workspace.slug}/projects/{project_ids[0]}/issues/{work_item.id}/issue-attachments/"
        )
        for role in (20, 15):
            client.force_authenticate(user=by_role[role])
            response = client.get(attachment_url)
            if response.status_code != 200 or not any(str(item.get("id")) == str(asset.id) for item in response.data):
                raise CommandError("AF1.2 Plane attachment API access was not restored.")
        client.force_authenticate(user=by_role[5])
        if client.get(attachment_url).status_code != 403:
            raise CommandError("AF1.2 guest unexpectedly listed another user's Plane attachment.")

        operations = list(
            PpmCanvasOperation.objects.filter(canvas__project_id__in=project_ids).order_by(
                "canvas_id", "client_operation_id"
            )
        )
        evidence = {
            "boards": [
                [str(board.id), str(board.project_id), board.name, board.status, board.current_version]
                for board in boards
            ],
            "memberships": [
                [str(item.project_id), str(item.member_id), item.role] for item in memberships + other_memberships
            ],
            "operations": [
                [str(item.canvas_id), str(item.client_operation_id), item.operation_type, item.operation_fingerprint]
                for item in operations
            ],
            "versions": [
                [str(item.board_id), item.version, item.schema_version, item.content_hash] for item in versions
            ],
            "vault_entries": [
                [str(entry.id), entry.name, str(entry.current_version_id), entry.content_hash]
                for entry in vault_entries
            ],
            "vault_versions": [
                [str(item.entry_id), item.version, item.object_key, item.content_hash] for item in vault_versions
            ],
            "work_item": [
                str(work_item.id),
                str(work_item.state_id),
                work_item.sequence_id,
                work_item.priority,
                work_item.description_stripped,
                str(work_item.created_by_id),
            ],
            "plane_attachment": [
                str(asset.id),
                str(asset.issue_id),
                asset.asset.name,
                len(content),
                ASSET_HASH,
            ],
        }
        digest = hashlib.sha256(json.dumps(evidence, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        self.stdout.write(
            json.dumps(
                {
                    "board_count": len(boards),
                    "digest": digest,
                    "operation_count": len(operations),
                    "version_count": len(versions),
                    "vault_entry_count": len(vault_entries),
                    "vault_version_count": len(vault_versions),
                    "work_item_count": len(work_items),
                    "plane_attachment_count": len(assets),
                },
                sort_keys=True,
            )
        )
