"""RC-F1 (D-2): версия источника задачи для живой карточки Холста.

Было: версия = `issue.updated_at`, а штатная задача Plane `issue_activity` после каждого изменения делает
`issue.updated_at = now(); save()` — карточка принимала одно изменение за загрузку страницы, дальше 409.
Стало: версия — отпечаток полей задачи (`plane.ppm_canvas.work_item_version`); конфликт — только если поля карточки
действительно изменились в другом месте; версии старого формата (время) — правило R-F1d.
"""

import csv
import io
import json
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.bgtasks.issue_activities_task import issue_activity as plane_issue_activity
from plane.db.models import Issue, IssueActivity, IssueAssignee, State
from plane.ppm_brain.adapters import load_work_item
from plane.ppm_canvas.models import PpmCanvasBinding, PpmCanvasBindingStatus, PpmCanvasEntityType
from plane.ppm_canvas.services import get_or_create_active_canvas, get_or_create_default_board
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def card_project():
    owner = make_user("card-owner")
    member = make_user("card-member")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    project = ProjectFactory(workspace=workspace, identifier=f"CRD{uuid.uuid4().hex[:4].upper()}")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    backlog = State.objects.create(
        name="Backlog", color="#60646C", group="backlog", default=True, project=project, created_by=owner
    )
    started = State.objects.create(name="In progress", color="#F59E0B", group="started", project=project)
    issue = Issue(name="Карточка на холсте", project=project, state=backlog, priority="none")
    issue.save(created_by_id=owner.id)
    return owner, member, workspace, project, backlog, started, issue


def project_path(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}"


def projection(api_client, workspace, project, issue):
    response = api_client.get(f"{project_path(workspace, project)}/projections/work_item/{issue.id}/")
    assert response.status_code == status.HTTP_200_OK, response.data
    return response.data


def card_patch(api_client, workspace, project, issue, payload):
    """Правка с карточки; задачи журнала Plane перехватываются и возвращаются, чтобы выполнить их как воркер."""
    with (
        patch("plane.ppm_canvas.views.issue_activity") as activity,
        patch("plane.ppm_canvas.views.model_activity"),
    ):
        response = api_client.patch(
            f"{project_path(workspace, project)}/work-items/{issue.id}/", payload, format="json"
        )
    return response, [call.kwargs for call in activity.delay.call_args_list]


def run_plane_activity_worker(activity_calls):
    """Выполняет штатную задачу Plane `issue_activity` так, как её выполнил бы Celery-воркер после ответа API:
    она пишет журнал и двигает `issue.updated_at`."""
    for kwargs in activity_calls:
        plane_issue_activity(**kwargs)


def plane_patch(api_client, workspace, project, issue, payload):
    """Правка задачи штатным API Plane (другое представление: страница задачи, список, доска Plane); успех — 204."""
    return api_client.patch(
        f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/", payload, format="json"
    )


def test_live_card_accepts_consecutive_edits_while_plane_activity_moves_updated_at(api_client, card_project):
    owner, _, workspace, project, _, started, issue = card_project
    api_client.force_authenticate(user=owner)
    source = projection(api_client, workspace, project, issue)

    first, activity = card_patch(
        api_client, workspace, project, issue, {"source_version": source["source_version"], "state_id": str(started.id)}
    )
    assert first.status_code == status.HTTP_200_OK, first.data
    before_worker = Issue.objects.get(id=issue.id).updated_at
    run_plane_activity_worker(activity)
    assert Issue.objects.get(id=issue.id).updated_at > before_worker, "the Plane activity job must move updated_at"
    assert IssueActivity.objects.filter(issue_id=issue.id, field="state").exists()

    second, activity = card_patch(
        api_client, workspace, project, issue, {"source_version": first.data["source_version"], "priority": "high"}
    )
    assert second.status_code == status.HTTP_200_OK, second.data
    run_plane_activity_worker(activity)
    third, _ = card_patch(
        api_client,
        workspace,
        project,
        issue,
        {"source_version": second.data["source_version"], "due_date": "2026-10-15", "assignee_ids": [str(owner.id)]},
    )

    assert third.status_code == status.HTTP_200_OK, third.data
    issue.refresh_from_db()
    assert issue.state_id == started.id
    assert issue.priority == "high"
    assert issue.target_date.isoformat() == "2026-10-15"
    assert [assignee["id"] for assignee in third.data["display"]["assignees"]] == [str(owner.id)]


def test_card_field_changed_elsewhere_conflicts_once_then_the_refreshed_card_works(api_client, card_project):
    owner, member, workspace, project, _, started, issue = card_project
    api_client.force_authenticate(user=owner)
    stale_source = projection(api_client, workspace, project, issue)

    api_client.force_authenticate(user=member)
    other = plane_patch(api_client, workspace, project, issue, {"priority": "urgent"})
    assert other.status_code == status.HTTP_204_NO_CONTENT, other.content

    api_client.force_authenticate(user=owner)
    stale, _ = card_patch(
        api_client,
        workspace,
        project,
        issue,
        {"source_version": stale_source["source_version"], "state_id": str(started.id)},
    )
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "WORK_ITEM_VERSION_CONFLICT"
    fresh_version = stale.data["error"]["details"]["current_source_version"]
    assert fresh_version == projection(api_client, workspace, project, issue)["source_version"]

    retried, _ = card_patch(
        api_client, workspace, project, issue, {"source_version": fresh_version, "state_id": str(started.id)}
    )
    assert retried.status_code == status.HTTP_200_OK, retried.data
    issue.refresh_from_db()
    assert (issue.priority, issue.state_id) == ("urgent", started.id)


@pytest.mark.parametrize(
    "change",
    [
        {"name": "Переименована в другом представлении"},
        {"start_date": "2026-10-01"},
        {"target_date": "2026-10-20"},
    ],
)
def test_every_card_field_changed_elsewhere_is_a_conflict(api_client, card_project, change):
    owner, member, workspace, project, _, _, issue = card_project
    api_client.force_authenticate(user=owner)
    stale_source = projection(api_client, workspace, project, issue)

    api_client.force_authenticate(user=member)
    assert plane_patch(api_client, workspace, project, issue, change).status_code == status.HTTP_204_NO_CONTENT

    api_client.force_authenticate(user=owner)
    stale, _ = card_patch(
        api_client, workspace, project, issue, {"source_version": stale_source["source_version"], "priority": "low"}
    )
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "WORK_ITEM_VERSION_CONFLICT"


def test_reassignment_elsewhere_conflicts_and_the_card_shows_only_current_assignees(api_client, card_project):
    owner, member, workspace, project, _, _, issue = card_project
    IssueAssignee.objects.create(issue=issue, assignee=owner, workspace=workspace, project=project)
    api_client.force_authenticate(user=owner)
    stale_source = projection(api_client, workspace, project, issue)
    assert [assignee["id"] for assignee in stale_source["display"]["assignees"]] == [str(owner.id)]

    api_client.force_authenticate(user=member)
    moved = plane_patch(api_client, workspace, project, issue, {"assignee_ids": [str(member.id)]})
    assert moved.status_code == status.HTTP_204_NO_CONTENT, moved.content

    api_client.force_authenticate(user=owner)
    fresh = projection(api_client, workspace, project, issue)
    # Plane снимает исполнителя мягким удалением строки IssueAssignee — снятый не показывается и не входит в версию.
    assert [assignee["id"] for assignee in fresh["display"]["assignees"]] == [str(member.id)]
    stale, _ = card_patch(
        api_client, workspace, project, issue, {"source_version": stale_source["source_version"], "priority": "low"}
    )
    assert stale.status_code == status.HTTP_409_CONFLICT

    api_client.force_authenticate(user=member)
    unassign = plane_patch(api_client, workspace, project, issue, {"assignee_ids": []})
    assert unassign.status_code == status.HTTP_204_NO_CONTENT, unassign.content
    api_client.force_authenticate(user=owner)
    unassigned = projection(api_client, workspace, project, issue)
    assert unassigned["display"]["assignees"] == []
    assert unassigned["source_version"] != fresh["source_version"]


def test_view_filter_export_and_card_audit_see_only_current_assignees(api_client, card_project):
    """Снятый в Plane исполнитель (мягко удалённая строка IssueAssignee) не находится фильтром «Исполнитель» вида
    «Задачи», не попадает в CSV и в «было» журнала правки с карточки (иначе Plane записал бы его снятие ещё раз)."""
    owner, member, workspace, project, _, _, issue = card_project
    IssueAssignee.objects.create(issue=issue, assignee=owner, workspace=workspace, project=project)
    api_client.force_authenticate(user=member)
    moved = plane_patch(api_client, workspace, project, issue, {"assignee_ids": [str(member.id)]})
    assert moved.status_code == status.HTTP_204_NO_CONTENT, moved.content

    api_client.force_authenticate(user=owner)
    board = api_client.get(f"{project_path(workspace, project)}/canvas/").data["board_id"]
    view_url = f"{project_path(workspace, project)}/canvas/boards/{board}/work-items-view/"
    by_owner = api_client.get(view_url, {"assignee_ids": str(owner.id)})
    by_member = api_client.get(view_url, {"assignee_ids": str(member.id)})
    exported = api_client.get(f"{view_url}export/csv/")

    assert by_owner.status_code == by_member.status_code == exported.status_code == status.HTTP_200_OK
    assert by_owner.data["results"] == []
    assert by_owner.data["summary"]["total"] == 0
    assert [item["identity"]["entity_id"] for item in by_member.data["results"]] == [str(issue.id)]
    rows = list(csv.reader(io.StringIO(exported.content.decode("utf-8-sig"))))
    assert rows[1][4] == member.display_name

    source = projection(api_client, workspace, project, issue)
    updated, activity = card_patch(
        api_client, workspace, project, issue, {"source_version": source["source_version"], "priority": "low"}
    )
    assert updated.status_code == status.HTTP_200_OK, updated.data
    assert json.loads(activity[0]["current_instance"])["assignee_ids"] == [str(member.id)]


def test_board_reads_current_assignees_of_all_live_cards_in_one_query(api_client, card_project):
    """Версия и исполнители каждой карточки — из одной предзагрузки на запрос, а не запроса на карточку (опрос
    привязок идёт каждые 30 с на каждой открытой доске)."""
    owner, member, workspace, project, backlog, _, first = card_project
    canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=owner.id)
    board = get_or_create_default_board(canvas=canvas, user_id=owner.id)
    api_client.force_authenticate(user=owner)

    def put_card(issue, index):
        for assignee in (owner, member):
            IssueAssignee.objects.create(issue=issue, assignee=assignee, workspace=workspace, project=project)
        PpmCanvasBinding.objects.create(
            workspace_id=workspace.id,
            project_id=project.id,
            canvas=canvas,
            board=board,
            shape_id=f"shape:card-{index}",
            entity_type=PpmCanvasEntityType.WORK_ITEM,
            entity_id=issue.id,
            status=PpmCanvasBindingStatus.ACTIVE,
            client_operation_id=uuid.uuid4(),
            operation_fingerprint=f"rc-f1-card-{index}",
            created_by=owner.id,
        )

    def read_board():
        with CaptureQueriesContext(connection) as queries:
            response = api_client.get(f"{project_path(workspace, project)}/canvas/bindings/")
        assert response.status_code == status.HTTP_200_OK, response.data
        return response.data["bindings"], sum('"issue_assignees"' in query["sql"] for query in queries.captured_queries)

    put_card(first, 0)
    few, few_queries = read_board()
    for index in range(1, 6):
        issue = Issue(name=f"Карточка {index}", project=project, state=backlog)
        issue.save(created_by_id=owner.id)
        put_card(issue, index)
    many, many_queries = read_board()

    assert len(few) == 1 and len(many) == 6
    assert few_queries == many_queries == 1
    both = {str(owner.id), str(member.id)}
    for binding in many:
        assert {assignee["id"] for assignee in binding["source"]["display"]["assignees"]} == both
        assert binding["source_version"].startswith("wi1:")


def test_description_change_elsewhere_is_not_a_card_conflict_but_moves_the_source_version(api_client, card_project):
    owner, member, workspace, project, _, _, issue = card_project
    api_client.force_authenticate(user=owner)
    source = projection(api_client, workspace, project, issue)

    api_client.force_authenticate(user=member)
    edited = plane_patch(api_client, workspace, project, issue, {"description_html": "<p>Новое описание</p>"})
    assert edited.status_code == status.HTTP_204_NO_CONTENT, edited.content

    api_client.force_authenticate(user=owner)
    updated, _ = card_patch(
        api_client, workspace, project, issue, {"source_version": source["source_version"], "priority": "medium"}
    )
    assert updated.status_code == status.HTTP_200_OK, updated.data
    # Описание на карточке не видно, но его индексирует Мозг: версия источника сменилась, и цитата поиска,
    # сделанная до правки описания, помечается «изменился после поиска».
    assert updated.data["source_version"] != source["source_version"]


def test_one_version_for_projection_bindings_patch_response_and_brain_index(api_client, card_project):
    owner, _, workspace, project, _, started, issue = card_project
    api_client.force_authenticate(user=owner)
    bound = api_client.post(
        f"{project_path(workspace, project)}/canvas/bindings/",
        {
            "shape_id": "shape:version",
            "entity_type": "work_item",
            "entity_id": str(issue.id),
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )
    assert bound.status_code == status.HTTP_201_CREATED, bound.data
    source = projection(api_client, workspace, project, issue)
    brain = load_work_item(workspace_id=workspace.id, project_id=project.id, source_id=issue.id)

    assert source["source_version"].startswith("wi1:")
    assert len(source["source_version"]) <= 64
    assert bound.data["source_version"] == source["source_version"] == brain.source_version
    assert PpmCanvasBinding.objects.get(id=bound.data["binding_id"]).source_version == source["source_version"]

    # Журнал активности, комментарии и связи двигают только `updated_at` — версия не меняется.
    Issue.objects.filter(id=issue.id).update(updated_at=timezone.now() + timedelta(seconds=5))
    assert projection(api_client, workspace, project, issue)["source_version"] == source["source_version"]

    updated, _ = card_patch(
        api_client, workspace, project, issue, {"source_version": source["source_version"], "state_id": str(started.id)}
    )
    assert updated.status_code == status.HTTP_200_OK, updated.data
    after = projection(api_client, workspace, project, issue)
    assert updated.data["source_version"] == after["source_version"] != source["source_version"]
    assert (
        after["source_version"]
        == load_work_item(workspace_id=workspace.id, project_id=project.id, source_id=issue.id).source_version
    )
    assert PpmCanvasBinding.objects.get(id=bound.data["binding_id"]).source_version == after["source_version"]


def test_legacy_timestamp_version_follows_the_old_rule_and_upgrades_the_card(api_client, card_project):
    """R-F1d: версия-время из вкладки, открытой до обновления. Равна текущему `updated_at` (задачу с тех пор не
    сохраняли) — изменение принимается; иначе — один 409 с версией нового формата, по которой следующее изменение
    проходит. Ничего не теряется: отклонённое изменение не записано, принятое — записано один раз."""
    owner, _, workspace, project, _, started, issue = card_project
    api_client.force_authenticate(user=owner)
    issue.refresh_from_db()

    untouched, activity = card_patch(
        api_client, workspace, project, issue, {"source_version": issue.updated_at.isoformat(), "priority": "low"}
    )
    assert untouched.status_code == status.HTTP_200_OK, untouched.data
    assert untouched.data["source_version"].startswith("wi1:")

    issue.refresh_from_db()
    legacy_after_own_edit = issue.updated_at.isoformat()
    run_plane_activity_worker(activity)
    stale, _ = card_patch(
        api_client, workspace, project, issue, {"source_version": legacy_after_own_edit, "state_id": str(started.id)}
    )
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "WORK_ITEM_VERSION_CONFLICT"
    upgraded = stale.data["error"]["details"]["current_source_version"]
    assert upgraded.startswith("wi1:")
    issue.refresh_from_db()
    assert issue.state_id != started.id

    retried, _ = card_patch(
        api_client, workspace, project, issue, {"source_version": upgraded, "state_id": str(started.id)}
    )
    assert retried.status_code == status.HTTP_200_OK, retried.data
    issue.refresh_from_db()
    assert (issue.priority, issue.state_id) == ("low", started.id)

    for garbage in ("", "not-a-version", "wi1:", "2026-13-45T99:99:99"):
        rejected, _ = card_patch(api_client, workspace, project, issue, {"source_version": garbage, "priority": "high"})
        assert rejected.status_code in {status.HTTP_400_BAD_REQUEST, status.HTTP_409_CONFLICT}, garbage
    issue.refresh_from_db()
    assert issue.priority == "low"
