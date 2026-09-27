"""RC-1: the synthetic ROBOT/BIO demo space for the browser release gate and the owner's acceptance."""

import json
import re
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from plane.db.models import (
    CycleIssue,
    Issue,
    IssueAssignee,
    IssueRelation,
    Module,
    ModuleIssue,
    Project,
    ProjectMember,
    State,
    User,
    Workspace,
    WorkspaceMember,
)
from plane.license.models import Instance
from plane.ppm_brain.models import PpmKnowledgeIndexState, PpmKnowledgeSource
from plane.ppm_canvas.models import PpmCanvasBoard, PpmGlobalAdmin, PpmProjectCanvas
from plane.ppm_vault.models import PpmVaultEntry, PpmVaultEntryKind
from plane.ppm_vault.storage import open_private_object


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

ROLES = ("OWNER", "ROBOT_MEMBER", "BIO_MEMBER", "ROBOT_VIEWER", "OUTSIDER")
BIO_MARKER = "BIO-ISOLATION-MARKER"
SLUG = "ppm-demo-contract"


@pytest.fixture
def demo_passwords(monkeypatch, settings, tmp_path):
    settings.PPM_LOCAL_ASSET_UPLOADS = True
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "ppm-demo-vault")
    monkeypatch.setenv("PPM_E2E_ALLOW_SEED", "1")
    passwords = {role: f"demo-{role.lower().replace('_', '-')}-password" for role in ROLES}
    for role, password in passwords.items():
        monkeypatch.setenv(f"PPM_DEMO_{role}_PASSWORD", password)
    return passwords


def run_seed(slug=SLUG, **options):
    output = StringIO()
    call_command("seed_ppm_demo_gate", slug=slug, stdout=output, **options)
    return output.getvalue()


@pytest.fixture
def provisioned_database(monkeypatch):
    """The command sees an ordinary (non test_*, non test-db) database, like a provisioned RC stack."""
    monkeypatch.setitem(connection.settings_dict, "NAME", "plane")
    monkeypatch.setitem(connection.settings_dict, "HOST", "plane-db")


def knowledge_url(workspace_id, project_id, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace_id}/projects/{project_id}/knowledge/{suffix}"


def test_demo_seed_requires_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("PPM_E2E_ALLOW_SEED", raising=False)
    with pytest.raises(CommandError, match="PPM_E2E_ALLOW_SEED"):
        run_seed()
    assert not Workspace.objects.filter(slug=SLUG).exists()


def test_demo_seed_requires_five_distinct_strong_passwords(demo_passwords, monkeypatch):
    monkeypatch.setenv("PPM_DEMO_OUTSIDER_PASSWORD", "short")
    with pytest.raises(CommandError, match="PPM_DEMO_"):
        run_seed()
    monkeypatch.setenv("PPM_DEMO_OUTSIDER_PASSWORD", demo_passwords["OWNER"])
    with pytest.raises(CommandError, match="distinct"):
        run_seed()
    assert not User.objects.filter(email__startswith=f"{SLUG}-").exists()


@pytest.mark.parametrize(
    "slug",
    ["robot", "ppm-demo-", "ppm-demo-UPPER", "af12-ci-demo", "ppm-demo--x", "ppm-demo-a--b", f"ppm-demo-{'a' * 39}"],
)
def test_demo_seed_rejects_non_synthetic_slugs(demo_passwords, slug):
    with pytest.raises(CommandError, match="ppm-demo-"):
        run_seed(slug)


def test_demo_seed_builds_isolated_robot_and_bio_space(demo_passwords):
    raw = run_seed()
    result = json.loads(raw)

    # The gate turns every key into an environment variable; values never carry secrets.
    assert all(re.fullmatch(r"PPM_DEMO_[A-Z_]+", key) for key in result)
    assert all(isinstance(value, str) and not re.search(r"[\r\n=]", value) for value in result.values())
    assert not any(password in raw for password in demo_passwords.values())
    assert result["PPM_DEMO_WORKSPACE_SLUG"] == SLUG

    workspace = Workspace.objects.get(id=result["PPM_DEMO_WORKSPACE_ID"], slug=SLUG)
    robot = Project.objects.get(id=result["PPM_DEMO_ROBOT_PROJECT_ID"], workspace=workspace)
    bio = Project.objects.get(id=result["PPM_DEMO_BIO_PROJECT_ID"], workspace=workspace)
    assert (robot.identifier, robot.name) == ("ROBOT", "ROBOT — Манипулятор")
    assert bio.identifier == "BIO"
    for project in (robot, bio):
        assert project.cycle_view and project.module_view and project.network == 0

    users = {role: User.objects.get(email=result[f"PPM_DEMO_{role}_EMAIL"]) for role in ROLES}
    for role, user in users.items():
        assert user.email.endswith("@ppm.test")
        assert user.check_password(demo_passwords[role])
        assert user.profile.is_onboarded and user.profile.language == "ru"
        assert user.profile.last_workspace_id == workspace.id
        assert not PpmGlobalAdmin.objects.filter(user=user).exists()
    assert workspace.owner == users["OWNER"]
    workspace_roles = {
        member.member_id: member.role for member in WorkspaceMember.objects.filter(workspace=workspace, is_active=True)
    }
    assert workspace_roles == {
        users["OWNER"].id: 20,
        users["ROBOT_MEMBER"].id: 15,
        users["BIO_MEMBER"].id: 15,
        users["ROBOT_VIEWER"].id: 5,
        users["OUTSIDER"].id: 15,
    }

    def project_roles(project):
        return {
            member.member_id: member.role for member in ProjectMember.objects.filter(project=project, is_active=True)
        }

    assert project_roles(robot) == {users["OWNER"].id: 20, users["ROBOT_MEMBER"].id: 15, users["ROBOT_VIEWER"].id: 5}
    assert project_roles(bio) == {users["OWNER"].id: 20, users["BIO_MEMBER"].id: 15}

    now = timezone.now()
    for project, minimum_items in ((robot, 6), (bio, 3)):
        states = State.objects.filter(project=project, is_triage=False)
        assert states.count() >= 2 and states.filter(default=True).count() == 1
        items = Issue.issue_objects.filter(project=project)
        assert items.count() >= minimum_items
        sprint_items = CycleIssue.objects.filter(
            cycle__project=project, cycle__start_date__lte=now, cycle__end_date__gte=now
        )
        assert sprint_items.count() >= 3
        directions = Module.objects.filter(project=project)
        assert directions.count() >= 2
        assert ModuleIssue.objects.filter(module__project=project).count() == items.count()
    assert IssueRelation.objects.filter(project=robot, relation_type="blocked_by").exists()

    # Assigned Work Items (the RC-F1 D-1 regression: indexing an assignee used to crash on User.get_full_name).
    def assigned(project, role):
        return IssueAssignee.objects.filter(
            issue__project=project, assignee=users[role], deleted_at__isnull=True
        ).count()

    assert assigned(robot, "ROBOT_MEMBER") >= 2 and assigned(robot, "OWNER") >= 1
    assert assigned(bio, "BIO_MEMBER") >= 2
    assert assigned(robot, "BIO_MEMBER") == 0 and assigned(bio, "ROBOT_MEMBER") == 0

    canvases = {canvas.project_id: canvas for canvas in PpmProjectCanvas.objects.filter(workspace_id=workspace.id)}
    assert canvases[robot.id].default_board_id and canvases[bio.id].default_board_id
    assert PpmCanvasBoard.objects.filter(project_id=robot.id, status="active").count() == 2

    robot_entries = PpmVaultEntry.objects.filter(project_id=robot.id, status="active")
    assert robot_entries.filter(kind=PpmVaultEntryKind.FOLDER).exists()
    assert robot_entries.filter(kind=PpmVaultEntryKind.MARKDOWN).count() >= 2
    pdf = robot_entries.get(kind=PpmVaultEntryKind.PDF)
    with open_private_object(pdf.current_version.object_key) as stored_pdf:
        assert stored_pdf.read().startswith(b"%PDF-")
    bio_notes = PpmVaultEntry.objects.filter(project_id=bio.id, status="active", kind=PpmVaultEntryKind.MARKDOWN)
    assert any(BIO_MARKER in entry.current_version.content_text for entry in bio_notes)

    # The BIO marker exists only in BIO data.
    assert not Issue.objects.filter(project=robot, description_html__contains=BIO_MARKER).exists()
    assert not PpmVaultEntry.objects.filter(
        project_id=robot.id, current_version__content_text__contains=BIO_MARKER
    ).exists()
    assert Issue.objects.filter(project=bio, description_html__contains=BIO_MARKER).exists()

    for project in (robot, bio):
        sources = PpmKnowledgeSource.objects.filter(project_id=project.id)
        assert (
            sources.count()
            == Issue.issue_objects.filter(project=project).count()
            + PpmVaultEntry.objects.filter(
                project_id=project.id, status="active", kind__in=[PpmVaultEntryKind.MARKDOWN, PpmVaultEntryKind.PDF]
            ).count()
        )
        assert set(sources.values_list("index_state", flat=True)) == {PpmKnowledgeIndexState.READY}

    client = APIClient()
    client.force_authenticate(user=users["ROBOT_MEMBER"])
    for suffix in ("canvas/", "vault/", "knowledge/sources/"):
        denied = client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{bio.id}/{suffix}")
        assert denied.status_code in (403, 404)
    robot_search = client.post(knowledge_url(workspace.id, robot.id, "query/"), {"query": BIO_MARKER}, format="json")
    assert robot_search.status_code == 200 and BIO_MARKER not in json.dumps(robot_search.data, ensure_ascii=False)
    by_assignee = client.post(
        knowledge_url(workspace.id, robot.id, "query/"), {"query": "Участник ROBOT"}, format="json"
    )
    assert by_assignee.status_code == 200
    assert any(
        result["source_type"] == "work_item" and "Исполнители" in result["excerpt"]
        for result in by_assignee.data["results"]
    )
    client.force_authenticate(user=users["BIO_MEMBER"])
    bio_search = client.post(knowledge_url(workspace.id, bio.id, "query/"), {"query": BIO_MARKER}, format="json")
    assert bio_search.status_code == 200 and BIO_MARKER in json.dumps(bio_search.data, ensure_ascii=False)
    client.force_authenticate(user=users["OUTSIDER"])
    assert client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{robot.id}/canvas/").status_code == 403
    client.force_authenticate(user=users["ROBOT_VIEWER"])
    viewer_canvas = client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{robot.id}/canvas/")
    assert viewer_canvas.status_code == 200 and viewer_canvas.data["access"] == "read"
    client.force_authenticate(user=users["OWNER"])
    discovered = client.get(f"/api/workspaces/{SLUG}/projects/")
    assert {project["identifier"] for project in discovered.data} == {"ROBOT", "BIO"}

    with pytest.raises(CommandError, match="already exist"):
        run_seed()
    assert Project.objects.filter(workspace=workspace).count() == 2


def test_demo_seed_refuses_a_non_test_database_without_the_explicit_flag(demo_passwords, provisioned_database):
    Instance.objects.create(
        instance_name="Provisioned RC",
        instance_id="ppm-rc-provisioned",
        current_version="v1.4.2",
        latest_version="v1.4.2",
        last_checked_at=timezone.now(),
        is_setup_done=True,
        is_test=False,
    )
    with pytest.raises(CommandError, match="--allow-provisioned-stack"):
        run_seed()
    assert not Workspace.objects.filter(slug=SLUG).exists()
    assert not User.objects.filter(email__startswith=f"{SLUG}-").exists()


def test_demo_seed_on_a_test_database_needs_no_flag_and_prints_no_warning(demo_passwords):
    errors = StringIO()
    output = StringIO()
    call_command("seed_ppm_demo_gate", slug=SLUG, stdout=output, stderr=errors)
    assert json.loads(output.getvalue())["PPM_DEMO_WORKSPACE_SLUG"] == SLUG
    assert errors.getvalue() == ""


def test_demo_seed_seeds_a_provisioned_stack_only_with_the_flag(demo_passwords, provisioned_database):
    # A provisioned stack must already have its instance; the seed never creates one outside a test database.
    with pytest.raises(CommandError, match="instance"):
        run_seed(allow_provisioned_stack=True)
    assert not Workspace.objects.filter(slug=SLUG).exists()

    Instance.objects.create(
        instance_name="Provisioned RC",
        instance_id="ppm-rc-provisioned",
        current_version="v1.4.2",
        latest_version="v1.4.2",
        last_checked_at=timezone.now(),
        is_setup_done=True,
        is_test=False,
    )
    errors = StringIO()
    output = StringIO()
    call_command("seed_ppm_demo_gate", slug=SLUG, allow_provisioned_stack=True, stdout=output, stderr=errors)
    warning = errors.getvalue()
    assert "plane" in warning and "plane-db" in warning and "WARNING" in warning
    assert json.loads(output.getvalue())["PPM_DEMO_WORKSPACE_SLUG"] == SLUG
    printed = output.getvalue() + warning
    assert not any(password in printed for password in demo_passwords.values())
    assert Instance.objects.count() == 1 and not Instance.objects.get().is_test
