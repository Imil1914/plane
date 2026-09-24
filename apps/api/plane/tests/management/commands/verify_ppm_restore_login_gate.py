"""Exercise real session login against an isolated AF1.2 restored database."""

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.test import Client

from plane.db.models import FileAsset, Issue, Project, ProjectMember, User, Workspace, WorkspaceMember
from plane.ppm_canvas.models import PpmGlobalAdmin, PpmGlobalAdminAudit
from plane.tests.management.commands.seed_ppm_canvas_browser_gate import _read_passwords, _require_disposable_database
from plane.tests.management.commands.seed_ppm_work_item_restore_gate import WORK_ITEM_NAME


class Command(BaseCommand):
    help = "Verify password and CSRF login, project, Canvas and Vault access after AF1.2 restore."

    def add_arguments(self, parser):
        parser.add_argument("--workspace-id", required=True)
        parser.add_argument("--project-id", required=True)
        parser.add_argument("--other-project-id", required=True)
        parser.add_argument("--expected-database", required=True)

    def handle(self, *args, **options):
        _require_disposable_database()
        database_name = str(connection.settings_dict["NAME"])
        if database_name != options["expected_database"] or not database_name.startswith("test_"):
            raise CommandError("AF1.2 session gate connected to the wrong disposable database.")
        passwords = _read_passwords()
        workspace = Workspace.objects.filter(id=options["workspace_id"], slug__startswith="af12-").first()
        if workspace is None:
            raise CommandError("AF1.2 disposable workspace is missing.")
        project_ids = [options["project_id"], options["other_project_id"]]
        if Project.objects.filter(id__in=project_ids, workspace=workspace).count() != 2:
            raise CommandError("AF1.2 disposable projects are missing.")
        work_item = Issue.objects.filter(project_id=project_ids[0], name=WORK_ITEM_NAME).first()
        if work_item is None:
            raise CommandError("AF1.2 synthetic Work Item is missing.")
        attachment = FileAsset.objects.filter(
            issue=work_item, entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT, is_uploaded=True
        ).first()
        if attachment is None:
            raise CommandError("AF1.2 synthetic Plane attachment is missing.")

        canvas_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project_ids[0]}/canvas/"
        vault_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project_ids[0]}/vault/"
        other_canvas_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project_ids[1]}/canvas/"
        work_item_url = f"/api/workspaces/{workspace.slug}/projects/{project_ids[0]}/issues/{work_item.id}/"
        attachment_url = f"{work_item_url}issue-attachments/"
        checked = 0
        for role, expected_role, expected_access in (
            ("OWNER", 20, "edit"),
            ("MEMBER", 15, "edit"),
            ("GUEST", 5, "read"),
        ):
            email = f"{workspace.slug}-{role.lower()}@ppm.test"
            user = User.objects.filter(email=email, is_active=True).first()
            if (
                user is None
                or not ProjectMember.objects.filter(
                    project_id=project_ids[0], member=user, role=expected_role, is_active=True
                ).exists()
            ):
                raise CommandError("AF1.2 synthetic login role is missing.")
            client = Client(enforce_csrf_checks=True)
            if client.get("/api/users/me/").status_code == 200:
                raise CommandError("AF1.2 fresh session was unexpectedly authenticated.")
            csrf_response = client.get("/auth/get-csrf-token/")
            if csrf_response.status_code != 200:
                raise CommandError("AF1.2 CSRF bootstrap failed after restore.")
            csrf_token = csrf_response.json().get("csrf_token")
            if not isinstance(csrf_token, str) or not csrf_token:
                raise CommandError("AF1.2 CSRF bootstrap returned no token.")
            login_response = client.post(
                "/auth/sign-in/",
                {"email": email, "password": passwords[role]},
                HTTP_X_CSRFTOKEN=csrf_token,
                HTTP_USER_AGENT="PPM AF1.2 restore gate",
            )
            profile = client.get("/api/users/me/")
            if (
                login_response.status_code != 302
                or settings.SESSION_COOKIE_NAME not in client.cookies
                or profile.status_code != 200
                or profile.json().get("id") != str(user.id)
            ):
                raise CommandError("AF1.2 password session login failed after restore.")
            project_response = client.get(f"/api/workspaces/{workspace.slug}/projects/{project_ids[0]}/")
            canvas_response = client.get(canvas_url)
            vault_response = client.get(vault_url)
            if (
                project_response.status_code != 200
                or canvas_response.status_code != 200
                or canvas_response.json().get("access") != expected_access
                or vault_response.status_code != 200
                or vault_response.json().get("access") != expected_access
            ):
                raise CommandError("AF1.2 restored session lost project, Canvas or Vault access.")
            if role != "OWNER" and client.get(other_canvas_url).status_code != 403:
                raise CommandError("AF1.2 restored session crossed the project boundary.")
            work_item_response = client.get(work_item_url)
            attachment_response = client.get(attachment_url)
            if role == "GUEST":
                if work_item_response.status_code != 403 or attachment_response.status_code != 403:
                    raise CommandError("AF1.2 restored guest read another user's Work Item or attachment.")
            elif work_item_response.status_code != 200 or work_item_response.json().get("name") != WORK_ITEM_NAME:
                raise CommandError("AF1.2 restored session lost Work Item access.")
            elif attachment_response.status_code != 200 or not any(
                str(item.get("id")) == str(attachment.id) for item in attachment_response.json()
            ):
                raise CommandError("AF1.2 restored session lost Plane attachment access.")
            checked += 1

        global_user = User.objects.filter(email=f"{workspace.slug}-global@ppm.test", is_active=True).first()
        if (
            global_user is None
            or not PpmGlobalAdmin.objects.filter(user=global_user, revoked_at__isnull=True).exists()
            or ProjectMember.objects.filter(member=global_user).exists()
            or WorkspaceMember.objects.filter(member=global_user).exists()
        ):
            raise CommandError("AF1.2 protected global administrator fixture is missing or inherited membership.")
        global_client = Client(enforce_csrf_checks=True)
        if global_client.get("/api/users/me/").status_code == 200:
            raise CommandError("AF1.2 fresh global administrator session was unexpectedly authenticated.")
        csrf_response = global_client.get("/auth/get-csrf-token/")
        csrf_token = csrf_response.json().get("csrf_token") if csrf_response.status_code == 200 else None
        if not isinstance(csrf_token, str) or not csrf_token:
            raise CommandError("AF1.2 global administrator CSRF bootstrap failed after restore.")
        login_response = global_client.post(
            "/auth/sign-in/",
            {"email": global_user.email, "password": passwords["GLOBAL"]},
            HTTP_X_CSRFTOKEN=csrf_token,
            HTTP_USER_AGENT="PPM AF1.2 restore gate",
        )
        profile = global_client.get("/api/users/me/")
        if (
            login_response.status_code != 302
            or settings.SESSION_COOKIE_NAME not in global_client.cookies
            or profile.status_code != 200
            or profile.json().get("id") != str(global_user.id)
        ):
            raise CommandError("AF1.2 global administrator session login failed after restore.")
        access_response = global_client.get("/api/ppm/v1/admin/access/")
        if access_response.status_code != 200 or access_response.json().get("role") != "ppm_global_admin":
            raise CommandError("AF1.2 restored global administrator role is unavailable.")
        for path in (canvas_url, other_canvas_url):
            response = global_client.get(path)
            if response.status_code != 200 or response.json().get("access") != "edit":
                raise CommandError("AF1.2 restored global administrator lost project Canvas access.")
        if PpmGlobalAdminAudit.objects.filter(
            global_admin__user=global_user,
            action="project_api_access",
            project_id__in=project_ids,
        ).values("project_id").distinct().count() != 2:
            raise CommandError("AF1.2 restored global administrator access was not audited in both projects.")
        checked += 1

        self.stdout.write(self.style.SUCCESS(f"AF1.2 restored session login verified for {checked} synthetic roles."))
