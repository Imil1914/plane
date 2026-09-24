"""Seed one synthetic Plane Work Item attachment in disposable MinIO."""

import json
from uuid import uuid4

from botocore.exceptions import BotoCoreError, ClientError
from django.core.management.base import BaseCommand, CommandError

from plane.db.models import FileAsset, Issue, Project, Workspace
from plane.tests.management.commands.ppm_asset_restore_support import (
    ASSET_CONTENT,
    ASSET_HASH,
    ASSET_NAME,
    guarded_asset_client,
)
from plane.tests.management.commands.seed_ppm_canvas_browser_gate import _require_disposable_database
from plane.tests.management.commands.seed_ppm_work_item_restore_gate import WORK_ITEM_NAME


class Command(BaseCommand):
    help = "Seed a synthetic Plane attachment in disposable AF1.2 object storage."

    def add_arguments(self, parser):
        parser.add_argument("--workspace-id", required=True)
        parser.add_argument("--project-id", required=True)

    def handle(self, *args, **options):
        _require_disposable_database()
        client, bucket = guarded_asset_client()
        workspace = Workspace.objects.filter(id=options["workspace_id"], slug__startswith="af12-").first()
        project = Project.objects.filter(id=options["project_id"], workspace=workspace).first() if workspace else None
        if project is None or not workspace.owner.email.endswith("@ppm.test"):
            raise CommandError("AF1.2 disposable project is missing.")
        work_item = Issue.objects.filter(project=project, name=WORK_ITEM_NAME).first()
        if work_item is None:
            raise CommandError("AF1.2 synthetic Work Item is missing.")
        if FileAsset.objects.filter(issue=work_item, entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT).exists():
            raise CommandError("AF1.2 synthetic Plane attachment already exists.")

        asset_key = f"{workspace.id}/{uuid4().hex}-{ASSET_NAME}"
        try:
            client.put_object(Bucket=bucket, Key=asset_key, Body=ASSET_CONTENT, ContentType="text/plain")
        except (BotoCoreError, ClientError) as exc:
            raise CommandError("AF1.2 disposable Plane attachment upload failed.") from exc
        asset = FileAsset(
            workspace=workspace,
            project=project,
            issue=work_item,
            asset=asset_key,
            attributes={"name": ASSET_NAME, "type": "text/plain", "size": len(ASSET_CONTENT)},
            size=len(ASSET_CONTENT),
            is_uploaded=True,
            entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
        )
        asset.save(created_by_id=workspace.owner_id)
        self.stdout.write(json.dumps({"attachment_count": 1, "content_sha256": ASSET_HASH}, sort_keys=True))
