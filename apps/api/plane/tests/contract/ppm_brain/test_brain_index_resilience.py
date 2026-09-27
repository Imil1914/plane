"""RC-F1 (D-1): индексация Мозга и задачи с исполнителями.

До исправления `adapters.load_work_item` звал `user.get_full_name()`, которого у `plane.db.models.User` нет: любое
сохранение задачи с исполнителем через API Plane возвращало 500 (данные уже сохранены, задачи журнала активности не
ставились), `reconcile_project` обрывался на первой назначенной задаче. Кроме исправления причины, сбой индексации
после фиксации транзакции больше не влияет на сохранение: колбэк `on_commit` его ловит и пишет в лог без содержимого.
"""

import logging
import uuid
from unittest.mock import patch

import pytest
from django.db import transaction
from rest_framework import status

from plane.db.models import Issue, IssueAssignee, State
from plane.ppm_brain.adapters import load_work_item
from plane.ppm_brain.models import PpmIndexJob, PpmIndexJobStatus, PpmKnowledgeIndexState, PpmKnowledgeSource
from plane.ppm_brain.models import PpmKnowledgeSourceType
from plane.ppm_brain.services import process_index_job, reconcile_project, retrieve_chunks
from plane.ppm_vault.models import PpmVaultEntry
from plane.ppm_vault.services import create_markdown, get_or_create_project_vault
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract]

PRIVATE_MARKER = "private-person@example.test"


def make_user(prefix, **fields):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test", **fields)


@pytest.fixture
def assigned_project(settings, tmp_path):
    settings.PPM_LOCAL_ASSET_UPLOADS = True
    settings.PPM_VAULT_STORAGE_ROOT = str(tmp_path / "private-vault")
    owner = make_user("brain-owner", first_name="Анна", last_name="Петрова")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    project = ProjectFactory(workspace=workspace, identifier=f"ASG{uuid.uuid4().hex[:5].upper()}")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    state = State.objects.create(
        workspace=workspace,
        project=project,
        name="В работе",
        color="#22c55e",
        group="started",
        default=True,
    )
    return owner, workspace, project, state


def make_assigned_issue(*, project, state, assignees, name="Собрать стенд ASSIGNED-MARKER"):
    issue = Issue.objects.create(
        workspace=project.workspace,
        project=project,
        state=state,
        name=name,
        description_html="<p>Проверка индексации назначенной задачи.</p>",
        priority="high",
    )
    for assignee in assignees:
        IssueAssignee.objects.create(
            issue=issue,
            assignee=assignee,
            workspace=project.workspace,
            project=project,
        )
    return issue


def issue_url(workspace, project, issue):
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/"


def work_item_source(project, issue):
    return PpmKnowledgeSource.objects.get(
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=str(issue.id),
    )


@pytest.mark.django_db
def test_work_item_with_assignees_is_indexed_with_their_names(assigned_project):
    owner, workspace, project, state = assigned_project
    # Без имени и фамилии — отображаемое имя (Plane заполняет его из почты при сохранении пользователя).
    nameless = make_user("brain-nameless", first_name="", last_name="")
    issue = make_assigned_issue(project=project, state=state, assignees=[owner, nameless])

    document = load_work_item(workspace_id=workspace.id, project_id=project.id, source_id=issue.id)

    body = document.parts[0].text
    assignees_line = next(line for line in body.splitlines() if line.startswith("Исполнители: "))
    assert "Анна Петрова" in assignees_line
    assert nameless.display_name in assignees_line


@pytest.mark.django_db
def test_reconcile_project_indexes_a_project_with_assigned_work_items(assigned_project):
    owner, workspace, project, state = assigned_project
    assigned = make_assigned_issue(project=project, state=state, assignees=[owner])
    unassigned = make_assigned_issue(project=project, state=state, assignees=[], name="Без исполнителя FREE-MARKER")

    jobs = reconcile_project(workspace_id=workspace.id, project_id=project.id)
    for job in jobs:
        process_index_job(job.id, worker_id="rc-f1-reconcile")

    assert len(jobs) == 2
    assert work_item_source(project, assigned).index_state == PpmKnowledgeIndexState.READY
    assert work_item_source(project, unassigned).index_state == PpmKnowledgeIndexState.READY
    found = retrieve_chunks(workspace_id=workspace.id, project_id=project.id, query="ASSIGNED-MARKER Петрова")
    assert found and found[0]["source_id"] == str(assigned.id)


@pytest.mark.django_db(transaction=True)
def test_saving_an_assigned_work_item_through_plane_succeeds_and_refreshes_the_index(api_client, assigned_project):
    """Как в живом API: запрос без внешней транзакции, `on_commit` выполняется сразу внутри `issue.save()`."""
    owner, workspace, project, state = assigned_project
    issue = make_assigned_issue(project=project, state=state, assignees=[owner])
    api_client.force_authenticate(user=owner)

    renamed = api_client.patch(
        issue_url(workspace, project, issue), {"name": "Собрать стенд RENAMED-MARKER"}, format="json"
    )
    reassigned = api_client.patch(
        issue_url(workspace, project, issue), {"assignee_ids": [str(owner.id)]}, format="json"
    )

    # Штатный PATCH задачи Plane отвечает 204 без тела.
    assert renamed.status_code == status.HTTP_204_NO_CONTENT, renamed.content
    assert reassigned.status_code == status.HTTP_204_NO_CONTENT, reassigned.content
    source = work_item_source(project, issue)
    document = load_work_item(workspace_id=workspace.id, project_id=project.id, source_id=issue.id)
    assert source.source_version == document.source_version
    job = PpmIndexJob.objects.get(source=source, requested_version=document.source_version)
    processed = process_index_job(job.id, worker_id="rc-f1-patch")
    assert processed.status == PpmIndexJobStatus.READY
    found = retrieve_chunks(workspace_id=workspace.id, project_id=project.id, query="RENAMED-MARKER Петрова")
    assert found and found[0]["source_id"] == str(issue.id)


@pytest.mark.django_db(transaction=True)
def test_indexing_failure_after_commit_is_logged_without_details_and_keeps_the_save(
    api_client, assigned_project, caplog
):
    owner, workspace, project, state = assigned_project
    issue = make_assigned_issue(project=project, state=state, assignees=[owner])
    api_client.force_authenticate(user=owner)

    def broken_indexer(**kwargs):
        raise RuntimeError(f"indexer exploded for {PRIVATE_MARKER}")

    caplog.set_level(logging.INFO)
    with patch("plane.ppm_brain.signals.request_source_index", side_effect=broken_indexer) as indexer:
        response = api_client.patch(
            issue_url(workspace, project, issue), {"name": "Сохранено несмотря на сбой"}, format="json"
        )

    assert response.status_code == status.HTTP_204_NO_CONTENT, response.content
    assert indexer.called
    issue.refresh_from_db()
    assert issue.name == "Сохранено несмотря на сбой"
    failures = [record for record in caplog.records if getattr(record, "ppm_brain_operation", None)]
    assert failures, "the failed indexing must be logged"
    failure = failures[0]
    assert failure.levelno == logging.ERROR
    assert failure.ppm_brain_operation == "index_work_item"
    assert failure.source_id == str(issue.id)
    assert failure.error_type == "RuntimeError"
    assert failure.exc_info is None
    for record in caplog.records:
        assert PRIVATE_MARKER not in record.getMessage()
        assert PRIVATE_MARKER not in str(vars(record))


@pytest.mark.django_db
def test_failed_brain_hook_neither_raises_on_commit_nor_skips_later_hooks(
    assigned_project, django_capture_on_commit_callbacks
):
    """Внутри транзакции колбэки выполняются при фиксации: упавший колбэк Мозга не должен ни поднимать исключение
    вызывающему, ни обрывать следующие `on_commit`-колбэки той же транзакции (например, задачи журнала Plane)."""
    owner, workspace, project, state = assigned_project
    issue = make_assigned_issue(project=project, state=state, assignees=[owner])
    later_hooks = []

    with patch("plane.ppm_brain.signals.request_source_index", side_effect=RuntimeError(PRIVATE_MARKER)):
        with django_capture_on_commit_callbacks(execute=True):
            issue.name = "Сохранено внутри транзакции"
            issue.save()
            transaction.on_commit(lambda: later_hooks.append("plane activity"))

    issue.refresh_from_db()
    assert issue.name == "Сохранено внутри транзакции"
    assert later_hooks == ["plane activity"]


@pytest.mark.django_db
def test_failed_brain_hook_never_breaks_vault_or_delete_saves(assigned_project, django_capture_on_commit_callbacks):
    owner, workspace, project, state = assigned_project
    issue = make_assigned_issue(project=project, state=state, assignees=[owner])
    vault = get_or_create_project_vault(workspace_id=workspace.id, project_id=project.id, user_id=owner.id)

    with (
        patch("plane.ppm_brain.signals.request_source_index", side_effect=RuntimeError(PRIVATE_MARKER)),
        patch("plane.ppm_brain.signals.exclude_source", side_effect=RuntimeError(PRIVATE_MARKER)),
    ):
        with django_capture_on_commit_callbacks(execute=True):
            entry = create_markdown(
                vault=vault,
                parent_id=None,
                name="Протокол.md",
                content="# Протокол\nСбой индексации не мешает сохранению.",
                user_id=owner.id,
            )
        with django_capture_on_commit_callbacks(execute=True):
            issue.delete()

    assert PpmVaultEntry.objects.filter(id=entry.id).exists()
    assert Issue.all_objects.get(id=issue.id).deleted_at is not None
