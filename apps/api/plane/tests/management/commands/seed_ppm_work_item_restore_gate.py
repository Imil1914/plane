"""Create one canonical Plane Work Item for the disposable AF1.2 restore drill."""

import json

from django.core.management.base import BaseCommand, CommandError

from plane.db.models import Issue, Project, ProjectMember, State, StateGroup, Workspace
from plane.tests.management.commands.seed_ppm_canvas_browser_gate import _require_disposable_database


WORK_ITEM_NAME = "AF1.2 проверка восстановления задачи"
STATE_NAME = "AF1.2 Backlog"


class Command(BaseCommand):
    help = "Seed one synthetic Plane Work Item in a disposable AF1.2 project."

    def add_arguments(self, parser):
        parser.add_argument("--workspace-id", required=True)
        parser.add_argument("--project-id", required=True)

    def handle(self, *args, **options):
        _require_disposable_database()
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
        if Issue.objects.filter(project=project, name=WORK_ITEM_NAME).exists():
            raise CommandError("AF1.2 synthetic Work Item already exists.")

        state = State.objects.filter(project=project, default=True, deleted_at__isnull=True).first()
        if state is None:
            state = State(
                project=project,
                name=STATE_NAME,
                color="#60646C",
                group=StateGroup.BACKLOG.value,
                default=True,
            )
            state.save(created_by_id=owner.id)
        issue = Issue(
            project=project,
            state=state,
            name=WORK_ITEM_NAME,
            priority="medium",
            description_html="<p>Синтетическая проверка восстановления AF1.2.</p>",
        )
        issue.save(created_by_id=owner.id)
        self.stdout.write(json.dumps({"work_item_count": 1, "sequence_id": issue.sequence_id}, sort_keys=True))
