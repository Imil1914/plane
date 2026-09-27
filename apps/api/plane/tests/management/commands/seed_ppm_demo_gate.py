"""RC-1: create the synthetic ROBOT/BIO demo space (golden test space of doc 16) for the browser release gate
and the owner's acceptance.

Registered only by ``plane.settings.test`` and guarded like the AF1.2 fixture commands: explicit
``PPM_E2E_ALLOW_SEED=1`` approval and a disposable test database (``test_*`` or host ``test-db``) on every run. The
one exception is an already provisioned RC stack for the owner's acceptance (run there with
``DJANGO_SETTINGS_MODULE=plane.settings.test``): it needs the explicit ``--allow-provisioned-stack`` flag as well, an
existing PPM instance, and the command warns on stderr which database it writes to. Existing data is never touched:
everything lives in one new ``ppm-demo-*`` workspace with new ``@ppm.test`` accounts. Passwords come from
``PPM_DEMO_*_PASSWORD`` and are never printed; stdout carries only IDs, the slug and e-mails as ``PPM_DEMO_*`` JSON.

The gate runs this command inside its ``api-browser-gate`` container (``Dockerfile.dev``, ``requirements/local.txt``
without the test-only packages), so it may import only what the application itself depends on.
"""

import json
import os
import re
import uuid
from datetime import timedelta

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

from plane.db.models import (
    Cycle,
    CycleIssue,
    Issue,
    IssueAssignee,
    IssueRelation,
    Module,
    ModuleIssue,
    Profile,
    Project,
    ProjectMember,
    State,
    User,
    Workspace,
    WorkspaceMember,
)
from plane.db.models.state import DEFAULT_STATES
from plane.license.models import Instance
from plane.ppm_brain.services import PpmBrainConflict, process_index_job, reconcile_project
from plane.ppm_canvas.services import create_canvas_board, get_or_create_active_canvas
from plane.ppm_vault.services import create_folder, create_markdown, create_pdf, get_or_create_project_vault


ROLES = ("OWNER", "ROBOT_MEMBER", "BIO_MEMBER", "ROBOT_VIEWER", "OUTSIDER")
DISPLAY_NAMES = {
    "OWNER": "Руководитель ROBOT (демо)",
    "ROBOT_MEMBER": "Участник ROBOT (демо)",
    "BIO_MEMBER": "Участник BIO (демо)",
    "ROBOT_VIEWER": "Наблюдатель ROBOT (демо)",
    "OUTSIDER": "Посторонний (демо)",
}
# Workspace role of each account; the outsider is a workspace member without any project access.
WORKSPACE_ROLES = {"OWNER": 20, "ROBOT_MEMBER": 15, "BIO_MEMBER": 15, "ROBOT_VIEWER": 5, "OUTSIDER": 15}
BIO_MARKER = "BIO-ISOLATION-MARKER"

# (key, name, state, priority, direction, in the current sprint, assignee role, target date offset in days,
# description). Assigned items also cover the RC-F1 D-1 regression (indexing an assignee used to crash).
ROBOT_ITEMS = (
    (
        "encoders",
        "Калибровка энкодеров суставов",
        "In Progress",
        "high",
        "Механика",
        True,
        "ROBOT_MEMBER",
        3,
        "Прогнать калибровку шести осей и записать поправки в паспорт привода.",
    ),
    (
        "gripper",
        "Прошивка контроллера захвата",
        "Todo",
        "medium",
        "Электроника",
        True,
        "ROBOT_MEMBER",
        6,
        "Обновить прошивку и проверить токовую защиту схвата.",
    ),
    (
        "kinematics",
        "Кинематическая модель шести осей",
        "Done",
        "high",
        "ПО управления",
        True,
        "OWNER",
        -2,
        "Прямая и обратная кинематика согласованы с механикой.",
    ),
    (
        "repeatability",
        "Тест повторяемости позиционирования",
        "In Progress",
        "urgent",
        "ПО управления",
        True,
        "OWNER",
        -1,
        "Серия из 50 циклов, допуск ±0,05 мм. Ждёт калибровки энкодеров.",
    ),
    (
        "cable",
        "Кабель-канал плеча",
        "Todo",
        "low",
        "Механика",
        True,
        None,
        5,
        "Развести кабели так, чтобы они не мешали повороту плеча.",
    ),
    (
        "force",
        "Датчик усилия в схвате",
        "Backlog",
        "medium",
        "Электроника",
        False,
        None,
        None,
        "Подобрать датчик и место установки; в текущий спринт не взят.",
    ),
)
BIO_ITEMS = (
    (
        "culture",
        "Посев рабочей культуры",
        "In Progress",
        "high",
        "Культивирование",
        True,
        "BIO_MEMBER",
        4,
        f"Метка изоляции {BIO_MARKER}: она никогда не должна появляться в данных ROBOT.",
    ),
    (
        "ph",
        "Калибровка pH-датчика",
        "Todo",
        "medium",
        "Контроль качества",
        True,
        "BIO_MEMBER",
        6,
        "Двухточечная калибровка перед каждым посевом.",
    ),
    (
        "sterile",
        "Протокол стерилизации биореактора",
        "Done",
        "medium",
        "Контроль качества",
        True,
        "OWNER",
        -3,
        "Автоклав 121 °C, 20 минут, контроль индикаторами.",
    ),
    (
        "growth",
        "Кривая роста культуры",
        "Backlog",
        "low",
        "Культивирование",
        False,
        None,
        None,
        "Снять кривую роста после стабилизации посева.",
    ),
)
PROJECTS = {
    "ROBOT": {
        "name": "ROBOT — Манипулятор",
        "description": "Синтетический демо-проект: шестиосевой манипулятор (данные вымышлены).",
        "sprint": "Спринт 1 — сборка прототипа",
        "items": ROBOT_ITEMS,
        "blocked": ("repeatability", "encoders"),
        "members": {"OWNER": 20, "ROBOT_MEMBER": 15, "ROBOT_VIEWER": 5},
    },
    "BIO": {
        "name": "BIO — Биореактор",
        "description": "Синтетический демо-проект для проверки изоляции (данные вымышлены).",
        "sprint": "Спринт BIO-1",
        "items": BIO_ITEMS,
        "blocked": None,
        "members": {"OWNER": 20, "BIO_MEMBER": 15},
    },
}
ROBOT_SPEC_MD = (
    "# Техническое задание ROBOT\n\n"
    "Шестиосевой манипулятор для демонстрации PPM. Все данные синтетические.\n\n"
    "- Повторяемость позиционирования: ±0,05 мм.\n"
    "- Грузоподъёмность схвата: 2 кг.\n\n"
    "Результаты испытаний: [[Журнал испытаний]].\n"
)
ROBOT_LOG_MD = (
    "# Журнал испытаний\n\n"
    "| Дата | Испытание | Итог |\n|---|---|---|\n"
    "| день 1 | Калибровка энкодеров, оси 1–3 | в работе |\n\n"
    "Требования: [[Техническое задание ROBOT]].\n"
)
BIO_PROTOCOL_MD = f"# Протокол BIO\n\nМетка изоляции {BIO_MARKER}. Этот текст виден только участникам проекта BIO.\n"


def _require_explicit_approval():
    if (
        os.environ.get("DJANGO_SETTINGS_MODULE") != "plane.settings.test"
        or "plane.tests" not in settings.INSTALLED_APPS
        or os.environ.get("PPM_E2E_ALLOW_SEED") != "1"
    ):
        raise CommandError("The demo seed requires plane.settings.test and explicit PPM_E2E_ALLOW_SEED=1 approval.")


def _is_disposable_database():
    name = str(connection.settings_dict.get("NAME") or "")
    host = str(connection.settings_dict.get("HOST") or "")
    return name.startswith("test_") or host == "test-db"


def _database_label():
    # Database name and host only — never the user or the password of the connection.
    name = connection.settings_dict.get("NAME") or "?"
    host = connection.settings_dict.get("HOST") or "localhost"
    return f"«{name}» on «{host}»"


def _read_passwords():
    passwords = {role: os.environ.get(f"PPM_DEMO_{role}_PASSWORD", "") for role in ROLES}
    if any(len(password) < 16 for password in passwords.values()):
        raise CommandError("Provide five PPM_DEMO_*_PASSWORD values of at least 16 characters.")
    if len(set(passwords.values())) != len(ROLES):
        raise CommandError("Demo account passwords must be distinct.")
    return passwords


def _ensure_test_instance():
    # Called only for a disposable test database; a provisioned stack must bring its own instance.
    if Instance.objects.exists():
        return
    Instance.objects.create(
        instance_name="PPM demo browser gate",
        instance_id=f"ppm-demo-{uuid.uuid4().hex}",
        current_version="v1.4.2",
        latest_version="v1.4.2",
        last_checked_at=timezone.now(),
        is_setup_done=True,
        is_test=True,
        is_telemetry_enabled=False,
        is_support_required=False,
    )


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
    profile, _ = Profile.objects.get_or_create(user=user)
    profile.is_onboarded = True
    profile.language = "ru"
    profile.save(update_fields=["is_onboarded", "language"])
    return user


def _pdf(text):
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    body = b"%PDF-1.4\n"
    offsets = []
    for index, value in enumerate(objects, start=1):
        offsets.append(len(body))
        body += f"{index} 0 obj\n".encode() + value + b"\nendobj\n"
    xref = len(body)
    body += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    body += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    body += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return body


class Command(BaseCommand):
    help = "Seed the synthetic ROBOT/BIO demo space (5 roles, sprint, directions, boards, Vault, Brain index)."

    def add_arguments(self, parser):
        parser.add_argument("--slug", required=True, help="New ppm-demo-* workspace slug for this demo space.")
        parser.add_argument(
            "--allow-provisioned-stack",
            action="store_true",
            help="Also allow a provisioned, non-test database (the local RC stack for the owner's acceptance).",
        )

    def handle(self, *args, **options):
        _require_explicit_approval()
        disposable = _is_disposable_database()
        if not disposable and not options.get("allow_provisioned_stack"):
            raise CommandError(
                "The demo seed runs only on a disposable test database (test_* or host test-db); pass "
                "--allow-provisioned-stack to seed an already provisioned RC stack."
            )
        slug = options["slug"]
        if len(slug) > 47 or not re.fullmatch(r"ppm-demo-[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            raise CommandError("The demo workspace slug must be a new ppm-demo-<lowercase-words> slug (≤ 47 chars).")
        passwords = _read_passwords()
        emails = {role: f"{slug}-{role.lower().replace('_', '-')}@ppm.test" for role in ROLES}
        if Workspace.objects.filter(slug=slug).exists() or User.objects.filter(email__in=emails.values()).exists():
            raise CommandError("The demo workspace or its accounts already exist; use a new ppm-demo-* slug.")
        if not disposable:
            if not Instance.objects.exists():
                raise CommandError("Set up the PPM instance of the provisioned stack before seeding the demo space.")
            self.stderr.write(
                f"WARNING: --allow-provisioned-stack: seeding the synthetic ROBOT/BIO demo space into the provisioned "
                f"database {_database_label()} — new workspace {slug} and five @ppm.test accounts; existing data is "
                "not changed and passwords are not printed."
            )

        # One transaction: a failed seed leaves no half-built workspace behind (only an orphan Vault object file).
        with transaction.atomic():
            if disposable:
                _ensure_test_instance()
            users = {role: _create_user(emails[role], DISPLAY_NAMES[role], passwords[role]) for role in ROLES}
            workspace = Workspace.objects.create(name="PPM демо ROBOT/BIO", slug=slug, owner=users["OWNER"])
            for role in ROLES:
                WorkspaceMember.objects.create(workspace=workspace, member=users[role], role=WORKSPACE_ROLES[role])
            Profile.objects.filter(user__in=users.values()).update(last_workspace_id=workspace.id)
            projects = {
                identifier: self._seed_project(workspace, users, identifier, spec)
                for identifier, spec in PROJECTS.items()
            }
            owner = users["OWNER"]
            self._seed_vault(projects["ROBOT"], owner, robot=True)
            self._seed_vault(projects["BIO"], owner, robot=False)
            for project in projects.values():
                self._index_project(project, owner)

        self.stdout.write(
            json.dumps(
                {
                    "PPM_DEMO_WORKSPACE_SLUG": slug,
                    "PPM_DEMO_WORKSPACE_ID": str(workspace.id),
                    "PPM_DEMO_ROBOT_PROJECT_ID": str(projects["ROBOT"].id),
                    "PPM_DEMO_BIO_PROJECT_ID": str(projects["BIO"].id),
                    **{f"PPM_DEMO_{role}_EMAIL": emails[role] for role in ROLES},
                },
                sort_keys=True,
            )
        )

    def _seed_project(self, workspace, users, identifier, spec):
        owner = users["OWNER"]
        project = Project.objects.create(
            workspace=workspace,
            name=spec["name"],
            identifier=identifier,
            description=spec["description"],
            network=0,
            project_lead=owner,
            cycle_view=True,
            module_view=True,
        )
        for role, project_role in spec["members"].items():
            ProjectMember.objects.create(workspace=workspace, project=project, member=users[role], role=project_role)
        # The same default workflow as the project creation API.
        State.objects.bulk_create(
            [
                State(
                    name=state["name"],
                    color=state["color"],
                    project=project,
                    workspace=workspace,
                    sequence=state["sequence"],
                    group=state["group"],
                    default=state.get("default", False),
                    created_by=owner,
                )
                for state in DEFAULT_STATES
            ]
        )
        states = {state.name: state for state in State.objects.filter(project=project)}

        today = timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)
        sprint = Cycle(
            project=project,
            name=spec["sprint"],
            description="Текущий спринт демо-данных.",
            start_date=today - timedelta(days=7),
            end_date=today + timedelta(days=7, hours=23, minutes=59),
            owned_by=owner,
        )
        sprint.save(created_by_id=owner.id)
        directions = {}
        items = {}
        for key, name, state, priority, direction, in_sprint, assignee, target, description in spec["items"]:
            if direction not in directions:
                module = Module(project=project, name=direction, status="in-progress", lead=owner)
                module.save(created_by_id=owner.id)
                directions[direction] = module
            item = Issue(
                project=project,
                state=states[state],
                name=name,
                priority=priority,
                description_html=f"<p>{description}</p>",
                start_date=(today - timedelta(days=5)).date() if in_sprint else None,
                target_date=(today + timedelta(days=target)).date() if target is not None else None,
            )
            item.save(created_by_id=owner.id)
            items[key] = item
            ModuleIssue.objects.create(project=project, module=directions[direction], issue=item)
            if in_sprint:
                CycleIssue.objects.create(project=project, cycle=sprint, issue=item)
            if assignee:
                IssueAssignee.objects.create(project=project, issue=item, assignee=users[assignee])
        if spec["blocked"]:
            blocked, blocker = spec["blocked"]
            IssueRelation.objects.create(
                project=project, issue=items[blocked], related_issue=items[blocker], relation_type="blocked_by"
            )

        canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=owner.id)
        if not canvas.default_board_id:
            raise CommandError("The demo project could not initialize its default board.")
        if identifier == "ROBOT":
            create_canvas_board(
                canvas=canvas,
                name="Совместная работа ROBOT",
                user_id=owner.id,
                client_operation_id=uuid.uuid4(),
            )
        return project

    def _seed_vault(self, project, owner, *, robot):
        vault = get_or_create_project_vault(workspace_id=project.workspace_id, project_id=project.id, user_id=owner.id)
        folder = create_folder(vault=vault, parent_id=None, name="Документы", user_id=owner.id)
        if not robot:
            create_markdown(
                vault=vault, parent_id=folder.id, name="Протокол BIO.md", content=BIO_PROTOCOL_MD, user_id=owner.id
            )
            return
        create_markdown(
            vault=vault,
            parent_id=folder.id,
            name="Техническое задание ROBOT.md",
            content=ROBOT_SPEC_MD,
            user_id=owner.id,
        )
        create_markdown(
            vault=vault, parent_id=folder.id, name="Журнал испытаний.md", content=ROBOT_LOG_MD, user_id=owner.id
        )
        create_pdf(
            vault=vault,
            parent_id=folder.id,
            uploaded_file=SimpleUploadedFile(
                "Паспорт привода.pdf",
                _pdf("ROBOT drive passport: synthetic data for the PPM demo"),
                content_type="application/pdf",
            ),
            user_id=owner.id,
        )

    def _index_project(self, project, owner):
        jobs = reconcile_project(
            workspace_id=project.workspace_id, project_id=project.id, requested_by=owner.id, dispatch=False
        )
        for job in jobs:
            try:
                process_index_job(job.id, worker_id="ppm-demo-seed")
            except PpmBrainConflict:
                # A running worker already claimed this job; the final state is checked by the gate itself.
                continue
