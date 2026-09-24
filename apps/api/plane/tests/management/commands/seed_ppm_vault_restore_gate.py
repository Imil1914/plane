"""Create versioned synthetic Vault data in the disposable AF1.2 backup drill."""

import json
from pathlib import Path

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management.base import BaseCommand, CommandError
from rest_framework.test import APIClient

from plane.db.models import Project, ProjectMember, Workspace
from plane.ppm_vault.storage import local_vault_root, use_local_vault_storage
from plane.tests.management.commands.seed_ppm_canvas_browser_gate import _require_disposable_database


FILE_NAME = "af12-backup-proof.txt"
FILE_CONTENTS = (b"PPM AF1.2 isolated file version 1\n", b"PPM AF1.2 isolated file version 2\n")
MARKDOWN_NAME = "af12-backup-proof.md"
MARKDOWN_CONTENTS = ("# AF1.2 isolated note v1\n", "# AF1.2 isolated note v2\n")


def require_disposable_vault_root(*, restored=False):
    expected_name = "ppm-af12-vault-restore" if restored else "ppm-af12-vault-source"
    root = local_vault_root()
    if not use_local_vault_storage() or root.name != expected_name or not root.is_relative_to(Path("/tmp")):
        raise CommandError("AF1.2 Vault drill requires its disposable local storage root.")
    return root


class Command(BaseCommand):
    help = "Seed synthetic versioned Vault entries in the disposable AF1.2 project."

    def add_arguments(self, parser):
        parser.add_argument("--workspace-id", required=True)
        parser.add_argument("--project-id", required=True)

    def handle(self, *args, **options):
        _require_disposable_database()
        require_disposable_vault_root()
        workspace = Workspace.objects.filter(id=options["workspace_id"], slug__startswith="af12-").first()
        project = Project.objects.filter(id=options["project_id"], workspace=workspace).first() if workspace else None
        if project is None:
            raise CommandError("AF1.2 disposable project is missing.")
        owner = workspace.owner
        if (
            not owner.email.endswith("@ppm.test")
            or not ProjectMember.objects.filter(project=project, member=owner, role=20, is_active=True).exists()
        ):
            raise CommandError("AF1.2 synthetic project owner is missing.")

        client = APIClient()
        client.force_authenticate(user=owner)
        base_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/vault/"
        file_response = client.post(
            f"{base_url}files/",
            {"file": SimpleUploadedFile(FILE_NAME, FILE_CONTENTS[0], content_type="text/plain")},
            format="multipart",
        )
        if file_response.status_code != 201:
            raise CommandError(f"AF1.2 synthetic Vault file creation failed ({file_response.status_code}).")
        file_id = file_response.data["id"]
        replaced = client.put(
            f"{base_url}entries/{file_id}/file/",
            {"base_version": "1", "file": SimpleUploadedFile(FILE_NAME, FILE_CONTENTS[1], content_type="text/plain")},
            format="multipart",
        )
        if replaced.status_code != 200 or replaced.data.get("version") != 2:
            raise CommandError(f"AF1.2 synthetic Vault file version failed ({replaced.status_code}).")

        markdown_response = client.post(
            f"{base_url}markdown/",
            {"name": MARKDOWN_NAME, "content": MARKDOWN_CONTENTS[0]},
            format="json",
        )
        if markdown_response.status_code != 201:
            raise CommandError(f"AF1.2 synthetic Vault note creation failed ({markdown_response.status_code}).")
        markdown_id = markdown_response.data["id"]
        updated = client.put(
            f"{base_url}entries/{markdown_id}/content/",
            {"base_version": 1, "content": MARKDOWN_CONTENTS[1]},
            format="json",
        )
        if updated.status_code != 200 or updated.data.get("version") != 2:
            raise CommandError(f"AF1.2 synthetic Vault note version failed ({updated.status_code}).")

        self.stdout.write(json.dumps({"file_count": 1, "markdown_count": 1, "version_count": 4}, sort_keys=True))
