"""Create disposable, project-scoped accounts for the AF1.2 browser gate.

This command is deliberately registered only by ``plane.settings.test``.
It never runs against the normal local or production settings.
"""

import json
import os
import re
import uuid

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

from plane.db.models import Profile, Project, ProjectMember, User, Workspace, WorkspaceMember
from plane.license.models import Instance
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_canvas.services import get_or_create_active_canvas


ROLES = ("OWNER", "MEMBER", "GUEST", "GLOBAL")
PROJECT_ROLES = {"OWNER": 20, "MEMBER": 15, "GUEST": 5}


def _require_disposable_database():
    database_name = str(connection.settings_dict.get("NAME") or "")
    database_host = str(connection.settings_dict.get("HOST") or "")
    if (
        os.environ.get("DJANGO_SETTINGS_MODULE") != "plane.settings.test"
        or "plane.tests" not in settings.INSTALLED_APPS
        or os.environ.get("PPM_E2E_ALLOW_SEED") != "1"
        or not (database_name.startswith("test_") or database_host == "test-db")
    ):
        raise CommandError("AF1.2 fixture requires explicit approval and a disposable test database.")


def _read_passwords():
    passwords = {role: os.environ.get(f"PPM_E2E_{role}_PASSWORD", "") for role in ROLES}
    if any(len(password) < 16 for password in passwords.values()):
        raise CommandError("Provide four distinct PPM_E2E_*_PASSWORD values of at least 16 characters.")
    if len(set(passwords.values())) != len(ROLES):
        raise CommandError("AF1.2 fixture passwords must be distinct.")
    return passwords


def _create_user(email, display_name, password):
    user = User(
        email=email,
        username=email,
        display_name=display_name,
        first_name=display_name,
        is_active=True,
        is_email_verified=True,
        is_email_valid=True,
    )
    user.set_password(password)
    user.save()
    return user


class Command(BaseCommand):
    help = "Seed an isolated AF1.2 browser fixture in the disposable test database only."

    def add_arguments(self, parser):
        parser.add_argument("--slug", required=True, help="Unique af12-* workspace slug for this test run.")

    def handle(self, *args, **options):
        _require_disposable_database()
        slug = options["slug"]
        if not re.fullmatch(r"af12-[a-z0-9-]{1,39}", slug) or slug.endswith("-"):
            raise CommandError("The fixture workspace slug must be a valid, unique af12-* test slug.")
        passwords = _read_passwords()
        emails = {role: f"{slug}-{role.lower()}@ppm.test" for role in ROLES}

        with transaction.atomic():
            if Workspace.objects.filter(slug=slug).exists() or User.objects.filter(email__in=emails.values()).exists():
                raise CommandError("The fixture slug or test accounts already exist; use a new disposable slug.")

            instance = Instance.objects.first()
            if instance and not instance.is_test:
                raise CommandError("The disposable database contains a non-test Plane instance.")
            if not instance:
                Instance.objects.create(
                    instance_name="PPM AF1.2 browser fixture",
                    instance_id=f"ppm-af12-{uuid.uuid4().hex}",
                    current_version="v1.4.2",
                    latest_version="v1.4.2",
                    last_checked_at=timezone.now(),
                    is_setup_done=True,
                    is_test=True,
                    is_telemetry_enabled=False,
                    is_support_required=False,
                )

            users = {role: _create_user(emails[role], f"AF1.2 {role.title()}", passwords[role]) for role in ROLES}
            workspace = Workspace.objects.create(name=f"AF1.2 fixture {slug}", slug=slug, owner=users["OWNER"])
            for role in PROJECT_ROLES:
                WorkspaceMember.objects.create(workspace=workspace, member=users[role], role=PROJECT_ROLES[role])
                profile, _ = Profile.objects.get_or_create(user=users[role])
                profile.is_onboarded = True
                profile.last_workspace_id = workspace.id
                profile.language = "ru"
                profile.save(update_fields=["is_onboarded", "last_workspace_id", "language"])
            global_profile, _ = Profile.objects.get_or_create(user=users["GLOBAL"])
            global_profile.is_onboarded = True
            global_profile.language = "ru"
            global_profile.save(update_fields=["is_onboarded", "language"])
            PpmGlobalAdmin.objects.create(user=users["GLOBAL"], reason="AF1.2 disposable browser gate")

            project = Project.objects.create(
                workspace=workspace,
                name="AF1.2 collaboration fixture",
                identifier="AF12",
                network=0,
                project_lead=users["OWNER"],
            )
            other_project = Project.objects.create(
                workspace=workspace,
                name="AF1.2 isolation fixture",
                identifier="AF12X",
                network=0,
                project_lead=users["OWNER"],
            )
            memberships = {}
            for role in PROJECT_ROLES:
                memberships[role] = ProjectMember.objects.create(
                    workspace=workspace,
                    project=project,
                    member=users[role],
                    role=PROJECT_ROLES[role],
                )
            ProjectMember.objects.create(workspace=workspace, project=other_project, member=users["OWNER"], role=20)
            canvas = get_or_create_active_canvas(
                workspace_id=workspace.id, project_id=project.id, user_id=users["OWNER"].id
            )
            other_canvas = get_or_create_active_canvas(
                workspace_id=workspace.id, project_id=other_project.id, user_id=users["OWNER"].id
            )
            if not canvas.default_board_id or not other_canvas.default_board_id:
                raise CommandError("AF1.2 fixture could not initialize both project boards.")

        self.stdout.write(
            json.dumps(
                {
                    "PPM_E2E_WORKSPACE_SLUG": slug,
                    "PPM_E2E_WORKSPACE_ID": str(workspace.id),
                    "PPM_E2E_PROJECT_ID": str(project.id),
                    "PPM_E2E_OTHER_PROJECT_ID": str(other_project.id),
                    "PPM_E2E_OTHER_BOARD_ID": str(other_canvas.default_board_id),
                    "PPM_E2E_MEMBER_MEMBERSHIP_ID": str(memberships["MEMBER"].id),
                    "PPM_E2E_GUEST_MEMBERSHIP_ID": str(memberships["GUEST"].id),
                    **{f"PPM_E2E_{role}_EMAIL": emails[role] for role in ROLES},
                },
                sort_keys=True,
            )
        )
