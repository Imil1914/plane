import json
import time
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.db.models import Cycle, CycleIssue, Issue, IssueActivity, State
from plane.ppm_canvas.changes import SHAPE_TIME_PROBE_BUDGET
from plane.ppm_canvas.models import PpmCanvasBinding, PpmCanvasBoard, PpmCanvasVersion
from plane.ppm_canvas.services import (
    create_canvas_board,
    duplicate_canvas_board,
    get_or_create_active_canvas,
    save_canvas_snapshot,
)
from plane.ppm_git.models import (
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitLinkOrigin,
    PpmGitObject,
    PpmGitRepository,
)
from plane.ppm_vault.models import PpmVaultEntry, PpmVaultVersion
from plane.ppm_vault.services import create_markdown, get_or_create_project_vault, trash_entry, update_markdown
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix, display_name=""):
    marker = uuid.uuid4().hex
    user = UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")
    if display_name:
        user.display_name = display_name
        user.save(update_fields=["display_name"])
    return user


def add_member(env, user, role):
    WorkspaceMemberFactory(workspace=env.workspace, member=user, role=role)
    ProjectMemberFactory(workspace=env.workspace, project=env.project, member=user, role=role)
    return user


@pytest.fixture
def board_env():
    lead = make_user("lead", "Анна")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="LMP")
    ProjectMemberFactory(workspace=workspace, project=project, member=lead, role=20)
    backlog = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=lead,
    )
    canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=lead.id)
    return SimpleNamespace(
        lead=lead,
        workspace=workspace,
        project=project,
        backlog=backlog,
        canvas=canvas,
        board=canvas.default_board,
        since=timezone.now() - timedelta(days=2),
    )


def at(env, hours):
    return env.since + timedelta(hours=hours)


def ms(moment):
    """Время узла PPM пишет клиент (`new Date().toISOString()`) — с точностью до миллисекунд."""
    return moment.replace(microsecond=moment.microsecond // 1000 * 1000)


def js_iso(moment):
    return ms(moment).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def create_issue(env, name, *, creator=None):
    issue = Issue(name=name, project=env.project, state=env.backlog)
    issue.save(created_by_id=(creator or env.lead).id)
    return issue


def identifier(issue):
    return f"LMP-{issue.sequence_id}"


def node_record(shape_id, *, kind="note", author=None, created, updated=None, title="", extra=None, x=0):
    node = {
        "schema_version": 2,
        "kind": kind,
        "author_id": str(author.id) if author else "local-user",
        "created_at": js_iso(created),
        "updated_at": js_iso(updated or created),
        "title": title,
        "body": "секретный текст карточки",
        "visual": {"color": "neutral", "width": 240, "height": 160},
        **(extra or {}),
    }
    return {
        "id": shape_id,
        "typeName": "shape",
        "type": "ppm-canvas-node",
        "x": x,
        "y": 0,
        "props": {"w": 240, "h": 160, "node": json.dumps(node, ensure_ascii=False)},
    }


def native_record(shape_id, shape_type, *, x=0):
    return {"id": shape_id, "typeName": "shape", "type": shape_type, "x": x, "y": 0, "props": {}}


def card(shape_id, env, kind="work_item_ref"):
    return node_record(shape_id, kind=kind, author=env.lead, created=env.since - timedelta(days=5))


def save_version(env, *records, moment, activate=(), board=None, user=None):
    target = PpmCanvasBoard.objects.get(pk=(board or env.board).pk)
    _, version, _ = save_canvas_snapshot(
        board=target,
        user_id=(user or env.lead).id,
        request_id=uuid.uuid4(),
        base_version=target.current_version,
        schema_version=2,
        snapshot={"document": {"store": {record["id"]: record for record in records}}},
        client_operation_id=uuid.uuid4(),
        binding_changes={"activate": [str(binding.id) for binding in activate], "remove": []},
    )
    PpmCanvasVersion.objects.filter(id=version.id).update(created_at=moment)
    return version


def bind(env, entity_type, entity_id, shape_id, *, board=None):
    return PpmCanvasBinding.objects.create(
        workspace_id=env.workspace.id,
        project_id=env.project.id,
        canvas=env.canvas,
        board=board or env.board,
        shape_id=shape_id,
        entity_type=entity_type,
        entity_id=entity_id,
        client_operation_id=uuid.uuid4(),
        operation_fingerprint=f"test-{shape_id}",
        created_by=env.lead.id,
    )


def activity(env, issue, *, field, moment, old="", new="", actor=None, verb="updated", epoch=None, row_id=None):
    row = IssueActivity.objects.create(
        id=row_id or uuid.uuid4(),
        issue=issue,
        project=env.project,
        workspace=env.workspace,
        verb=verb,
        field=field,
        old_value=old,
        new_value=new,
        actor=actor or env.lead,
        epoch=epoch if epoch is not None else moment.timestamp(),
        comment="",
    )
    IssueActivity.objects.filter(id=row.id).update(created_at=moment)
    return row


def git_repository(env):
    repository = PpmGitRepository.objects.create(
        workspace_id=env.workspace.id,
        project_id=env.project.id,
        name="PPM",
        normalized_name="ppm",
        provider="github",
        provider_repository_id=101,
        provider_full_name="ppm/ppm",
        canonical_url="https://github.com/ppm/ppm",
        clone_https="https://github.com/ppm/ppm.git",
        default_branch="main",
        created_by=env.lead.id,
        updated_by=env.lead.id,
    )
    installation = PpmGitInstallation.objects.create(
        workspace_id=env.workspace.id,
        project_id=env.project.id,
        provider_installation_id=201,
        provider_account_id=301,
        account_login="ppm",
        created_by=env.lead.id,
        updated_by=env.lead.id,
    )
    git_connection = PpmGitConnection.objects.create(
        workspace_id=env.workspace.id,
        project_id=env.project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=101,
        provider_full_name="ppm/ppm",
        created_by=env.lead.id,
        updated_by=env.lead.id,
    )
    return repository, git_connection


def pull_request(env, repository, git_connection, *, number, title, state, first_seen, updated, merged=None):
    git_object = PpmGitObject.objects.create(
        workspace_id=env.workspace.id,
        project_id=env.project.id,
        connection=git_connection,
        repository=repository,
        object_type="pull_request",
        provider_object_id=str(1000 + number),
        ref=str(number),
        title=title,
        canonical_url=f"https://github.com/ppm/ppm/pull/{number}",
        state=state,
        source_version=f"pr:{number}",
        provider_updated_at=updated,
        provider_merged_at=merged,
    )
    PpmGitObject.objects.filter(id=git_object.id).update(first_seen_at=first_seen)
    git_object.refresh_from_db()
    return git_object


def link_pull_request(env, repository, git_object, issue):
    return PpmGitLink.objects.create(
        workspace_id=env.workspace.id,
        project_id=env.project.id,
        repository=repository,
        git_object=git_object,
        work_item=issue,
        object_type="pull_request",
        ref=git_object.ref,
        title=git_object.title[:255],
        canonical_url=git_object.canonical_url,
        origin=PpmGitLinkOrigin.PROVIDER,
        created_by=env.lead.id,
        updated_by=env.lead.id,
    )


def changes_url(env, board=None):
    return (
        f"/api/ppm/v1/workspaces/{env.workspace.id}/projects/{env.project.id}"
        f"/canvas/boards/{(board or env.board).id}/changes/"
    )


def seen_url(env):
    return f"{changes_url(env).removesuffix('changes/')}me/seen/"


def get_changes(api_client, env, *, since, limit=None, board=None):
    params = {"since": since.isoformat()}
    if limit is not None:
        params["limit"] = limit
    return api_client.get(changes_url(env, board), params)


def test_feed_reports_task_field_changes_newest_first_with_stable_ids(api_client, board_env):
    env = board_env
    colleague = add_member(env, make_user("colleague", "Борис"), 15)
    task = create_issue(env, "Собрать карту")
    unrelated = create_issue(env, "Не на доске")
    binding = bind(env, "work_item", task.id, "shape:task")
    save_version(env, card("shape:task", env), moment=env.since - timedelta(hours=1), activate=[binding])
    activity(env, task, field="state", old="Backlog", new="Todo", moment=env.since - timedelta(minutes=5))
    state = activity(env, task, field="state", old="Backlog", new="In progress", actor=colleague, moment=at(env, 1))
    assignee = activity(env, task, field="assignees", old="", new="Борис", moment=at(env, 2))
    due = activity(env, task, field="target_date", old="", new="2026-10-01", moment=at(env, 3))
    priority = activity(env, task, field="priority", old="none", new="high", moment=at(env, 4))
    name = activity(env, task, field="name", old="Собрать карту", new="Собрать карту спринта", moment=at(env, 5))
    activity(env, task, field="description", old="<p>старое</p>", new="<p>секрет</p>", moment=at(env, 6))
    activity(env, task, field="comment", new="секрет", verb="created", moment=at(env, 6))
    activity(env, unrelated, field="state", old="Backlog", new="Done", moment=at(env, 7))
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since)
    again = get_changes(api_client, env, since=env.since)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["since"] == env.since.isoformat()
    assert response.data["truncated"] is False
    items = response.data["items"]
    assert [item["id"] for item in items] == [
        f"work_item.name:{name.id}",
        f"work_item.priority:{priority.id}",
        f"work_item.due:{due.id}",
        f"work_item.assignees:{assignee.id}",
        f"work_item.state:{state.id}",
    ]
    assert [item["id"] for item in again.data["items"]] == [item["id"] for item in items]
    assert items[-1] == {
        "id": f"work_item.state:{state.id}",
        "kind": "work_item.state",
        "occurred_at": at(env, 1).isoformat(),
        "actor": {"id": str(colleague.id), "display_name": "Борис"},
        "entity": {
            "type": "work_item",
            "id": str(task.id),
            "identifier": identifier(task),
            "title": "Собрать карту",
        },
        "shape_ids": ["shape:task"],
        "detail": {"field": "state", "old": "Backlog", "new": "In progress"},
    }
    assert items[3]["detail"] == {"field": "assignees", "old": None, "new": "Борис"}
    assert items[2]["detail"] == {"field": "due_date", "old": None, "new": "2026-10-01"}
    assert items[1]["detail"] == {"field": "priority", "old": "none", "new": "high"}
    assert items[0]["detail"] == {"field": "name", "old": "Собрать карту", "new": "Собрать карту спринта"}
    assert "секрет" not in json.dumps(response.data, ensure_ascii=False)


def test_feed_includes_tasks_of_the_sprint_frame_even_without_their_cards(api_client, board_env):
    env = board_env
    sprint = Cycle.objects.create(
        name="Спринт 12",
        project=env.project,
        owned_by=env.lead,
        start_date=env.since,
        end_date=env.since + timedelta(days=14),
    )
    next_sprint = Cycle.objects.create(
        name="Спринт 13",
        project=env.project,
        owned_by=env.lead,
        start_date=env.since + timedelta(days=14),
        end_date=env.since + timedelta(days=28),
    )
    in_sprint = create_issue(env, "Задача спринта")
    in_next_sprint = create_issue(env, "Задача следующего спринта")
    CycleIssue.objects.create(cycle=sprint, issue=in_sprint, project=env.project)
    CycleIssue.objects.create(cycle=next_sprint, issue=in_next_sprint, project=env.project)
    sprint_change = activity(env, in_sprint, field="state", old="Backlog", new="In progress", moment=at(env, 1))
    activity(env, in_next_sprint, field="state", old="Backlog", new="In progress", moment=at(env, 2))
    other_project = ProjectFactory(workspace=env.workspace, identifier="LMP2")
    ProjectMemberFactory(workspace=env.workspace, project=other_project, member=env.lead, role=20)
    other_state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=other_project,
        created_by=env.lead,
    )
    foreign_sprint = Cycle.objects.create(
        name="Чужой спринт",
        project=other_project,
        owned_by=env.lead,
        start_date=env.since,
        end_date=env.since + timedelta(days=14),
    )
    foreign_task = Issue(name="Чужая задача", project=other_project, state=other_state)
    foreign_task.save(created_by_id=env.lead.id)
    CycleIssue.objects.create(cycle=foreign_sprint, issue=foreign_task, project=other_project)
    foreign_change = IssueActivity.objects.create(
        issue=foreign_task,
        project=other_project,
        workspace=env.workspace,
        verb="updated",
        field="state",
        old_value="Backlog",
        new_value="Done",
        actor=env.lead,
        comment="",
    )
    IssueActivity.objects.filter(id=foreign_change.id).update(created_at=at(env, 3))
    api_client.force_authenticate(user=env.lead)

    without_frame = get_changes(api_client, env, since=env.since)
    save_version(
        env,
        node_record(
            "shape:sprint",
            kind="group",
            author=env.lead,
            created=env.since - timedelta(days=1),
            title="Спринт 12",
            extra={"map": {"role": "sprint", "cycle_id": str(sprint.id)}},
        ),
        # Рамка со спринтом другого проекта (например, скопированная с чужой доски) ничего не добавляет в ленту.
        node_record(
            "shape:foreign-sprint",
            kind="group",
            author=env.lead,
            created=env.since - timedelta(days=1),
            extra={"map": {"role": "sprint", "cycle_id": str(foreign_sprint.id)}},
        ),
        moment=env.since - timedelta(hours=1),
    )
    with_frame = get_changes(api_client, env, since=env.since)

    assert without_frame.status_code == status.HTTP_200_OK
    assert without_frame.data["items"] == []
    assert [(item["id"], item["shape_ids"]) for item in with_frame.data["items"]] == [
        (f"work_item.state:{sprint_change.id}", [])
    ]


def test_relation_rows_become_one_event_and_invisible_tasks_are_not_revealed(api_client, board_env):
    env = board_env
    guest = add_member(env, make_user("guest", "Гость"), 5)
    blocker = create_issue(env, "Блокер")
    blocked = create_issue(env, "Заблокированная")
    guest_task = create_issue(env, "Задача гостя", creator=guest)
    bindings = [
        bind(env, "work_item", blocker.id, "shape:blocker"),
        bind(env, "work_item", blocked.id, "shape:blocked"),
        bind(env, "work_item", guest_task.id, "shape:guest"),
    ]
    save_version(
        env,
        card("shape:blocker", env),
        card("shape:blocked", env),
        card("shape:guest", env),
        moment=env.since - timedelta(hours=1),
        activate=bindings,
    )
    added_epoch = at(env, 1).timestamp()
    added = [
        activity(env, blocked, field="blocked_by", new=identifier(blocker), moment=at(env, 1), epoch=added_epoch),
        activity(
            env,
            blocker,
            field="blocking",
            new=identifier(blocked),
            moment=at(env, 1) + timedelta(microseconds=7),
            epoch=added_epoch,
        ),
    ]
    removed_epoch = at(env, 2).timestamp()
    removed = [
        activity(
            env,
            blocked,
            field="blocked_by",
            old=identifier(blocker),
            verb="deleted",
            moment=at(env, 2),
            epoch=removed_epoch,
        ),
        activity(
            env,
            blocker,
            field="blocking",
            old=identifier(blocked),
            verb="deleted",
            moment=at(env, 2) + timedelta(microseconds=7),
            epoch=removed_epoch,
        ),
    ]
    activity(env, guest_task, field="relates_to", new=identifier(blocker), moment=at(env, 3))
    api_client.force_authenticate(user=env.lead)
    lead_view = get_changes(api_client, env, since=env.since)
    api_client.force_authenticate(user=guest)
    guest_view = get_changes(api_client, env, since=env.since)

    lead_items = lead_view.data["items"]
    assert [item["kind"] for item in lead_items] == ["work_item.relation"] * 3
    removed_item, added_item = lead_items[1], lead_items[2]
    # Главная строка связи — первая записанная (Plane пишет её для задачи, где связь изменили).
    assert added_item["id"] == f"work_item.relation:{added[0].id}"
    assert removed_item["id"] == f"work_item.relation:{removed[0].id}"
    assert sorted(added_item["shape_ids"]) == ["shape:blocked", "shape:blocker"]
    assert added_item["detail"]["old"] is None
    assert added_item["detail"]["new"] in {identifier(blocker), identifier(blocked)}
    assert added_item["detail"]["field"] in {"blocked_by", "blocking"}
    assert removed_item["detail"]["new"] is None
    assert removed_item["detail"]["old"] in {identifier(blocker), identifier(blocked)}
    assert lead_items[0]["detail"] == {"field": "relates_to", "old": None, "new": identifier(blocker)}
    guest_items = guest_view.data["items"]
    assert [item["entity"]["id"] for item in guest_items] == [str(guest_task.id)]
    assert guest_items[0]["detail"] == {"field": "relates_to", "old": None, "new": None}
    assert guest_items[0]["shape_ids"] == ["shape:guest"]
    assert identifier(blocker) not in json.dumps(guest_view.data, ensure_ascii=False)


def test_pull_requests_of_board_tasks_are_reported_when_opened_and_merged(api_client, board_env):
    env = board_env
    task = create_issue(env, "Задача с PR")
    elsewhere = create_issue(env, "Задача без карточки")
    binding = bind(env, "work_item", task.id, "shape:task")
    save_version(env, card("shape:task", env), moment=env.since - timedelta(hours=1), activate=[binding])
    repository, git_connection = git_repository(env)
    fresh = pull_request(
        env,
        repository,
        git_connection,
        number=7,
        title="LMP-1: живая карта",
        state="merged",
        first_seen=at(env, 1),
        updated=at(env, 3),
    )
    historical = pull_request(
        env,
        repository,
        git_connection,
        number=3,
        title="Старый PR",
        state="merged",
        first_seen=at(env, 1),
        updated=env.since - timedelta(days=5),
    )
    unrelated = pull_request(
        env,
        repository,
        git_connection,
        number=9,
        title="Чужой PR",
        state="open",
        first_seen=at(env, 2),
        updated=at(env, 2),
    )
    link_pull_request(env, repository, fresh, task)
    link_pull_request(env, repository, historical, task)
    link_pull_request(env, repository, unrelated, elsewhere)
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since)

    items = response.data["items"]
    assert [item["id"] for item in items] == [
        f"git.pull_request.merged:{fresh.id}",
        f"git.pull_request.opened:{fresh.id}",
    ]
    assert items[0]["occurred_at"] == at(env, 3).isoformat()
    assert items[1]["occurred_at"] == at(env, 1).isoformat()
    assert items[0]["entity"] == {
        "type": "pull_request",
        "id": str(fresh.id),
        "identifier": "#7",
        "title": "LMP-1: живая карта",
    }
    assert items[0]["actor"] is None
    assert items[0]["shape_ids"] == ["shape:task"]
    assert items[0]["detail"] == {"field": "work_items", "new": identifier(task)}


def test_new_versions_of_vault_files_on_the_board_are_reported(api_client, board_env):
    env = board_env
    vault = get_or_create_project_vault(workspace_id=env.workspace.id, project_id=env.project.id, user_id=env.lead.id)
    plan = create_markdown(vault=vault, parent_id=None, name="План.md", content="# v1", user_id=env.lead.id)
    draft = create_markdown(vault=vault, parent_id=None, name="Черновик.md", content="# v1", user_id=env.lead.id)
    removed = create_markdown(vault=vault, parent_id=None, name="Удалённый.md", content="# v1", user_id=env.lead.id)
    bindings = [bind(env, "vault_file", plan.id, "shape:plan"), bind(env, "vault_file", removed.id, "shape:removed")]
    save_version(
        env,
        card("shape:plan", env, "vault_file_ref"),
        card("shape:removed", env, "vault_file_ref"),
        moment=env.since - timedelta(hours=1),
        activate=bindings,
    )
    PpmVaultVersion.objects.filter(entry_id__in=[plan.id, draft.id, removed.id]).update(
        created_at=env.since - timedelta(days=1)
    )
    for entry in (plan, draft, removed):
        update_markdown(entry=entry, base_version=1, content="# v2 секретный абзац", user_id=env.lead.id)
    trash_entry(entry=PpmVaultEntry.objects.get(id=removed.id), user_id=env.lead.id)
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since)

    second = PpmVaultVersion.objects.get(entry_id=plan.id, version=2)
    assert response.data["items"] == [
        {
            "id": f"vault.version:{second.id}",
            "kind": "vault.version",
            "occurred_at": second.created_at.isoformat(),
            "actor": {"id": str(env.lead.id), "display_name": "Анна"},
            "entity": {"type": "vault_file", "id": str(plan.id), "title": "План.md"},
            "shape_ids": ["shape:plan"],
            "detail": {"field": "version", "old": "1", "new": "2"},
        }
    ]
    assert "секретный абзац" not in json.dumps(response.data, ensure_ascii=False)


def test_board_diff_reports_added_and_changed_cards_and_added_native_shapes(api_client, board_env):
    env = board_env
    colleague = add_member(env, make_user("colleague", "Борис"), 15)
    long_ago = env.since - timedelta(days=3)
    note = node_record("shape:note", author=env.lead, created=long_ago, title="План")
    untouched = node_record("shape:untouched", author=env.lead, created=long_ago, title="Без изменений")
    sticker = native_record("shape:sticker", "note")
    arrow = native_record("shape:arrow", "arrow")
    save_version(env, note, untouched, sticker, arrow, moment=env.since - timedelta(hours=2))
    edited_note = node_record(
        "shape:note", author=env.lead, created=long_ago, updated=at(env, 1), title="План v2", x=500
    )
    new_note = node_record("shape:new", author=colleague, created=at(env, 2), title="Новая заметка")
    moved_sticker = native_record("shape:sticker", "note", x=900)
    geo = native_record("shape:geo", "geo")
    kept = (edited_note, untouched, new_note, moved_sticker, arrow, geo)
    save_version(env, *kept, moment=at(env, 3))
    save_version(
        env,
        *kept,
        native_record("shape:text", "text"),
        native_record("shape:arrow-2", "arrow"),
        native_record("shape:pen", "draw"),
        moment=at(env, 5),
    )
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since)

    changed_id = f"board.node.changed:shape:note:{ms(at(env, 1)).isoformat()}"
    items = {item["id"]: item for item in response.data["items"]}
    assert set(items) == {
        changed_id,
        "board.node.added:shape:new",
        "board.node.added:shape:geo",
        "board.node.added:shape:text",
    }
    assert items[changed_id] == {
        "id": changed_id,
        "kind": "board.node.changed",
        "occurred_at": ms(at(env, 1)).isoformat(),
        # Автор правки — автор версии, сохранившей текущий `updated_at` карточки (S2a).
        "actor": {"id": str(env.lead.id), "display_name": "Анна"},
        "entity": {"type": "node", "id": "shape:note", "title": "План v2"},
        "shape_ids": ["shape:note"],
        "detail": {"field": "kind", "new": "note"},
    }
    assert items["board.node.added:shape:new"]["actor"] == {"id": str(colleague.id), "display_name": "Борис"}
    assert items["board.node.added:shape:new"]["occurred_at"] == ms(at(env, 2)).isoformat()
    assert items["board.node.added:shape:geo"]["detail"] == {"field": "shape_type", "new": "geo"}
    # Автор нативной фигуры — автор версии, в которой она появилась (S2a).
    assert items["board.node.added:shape:geo"]["actor"] == {"id": str(env.lead.id), "display_name": "Анна"}
    assert items["board.node.added:shape:geo"]["entity"] == {"type": "node", "id": "shape:geo"}
    # Время нативной фигуры — время версии, в которой она появилась (история версий неизменяема).
    assert items["board.node.added:shape:geo"]["occurred_at"] == at(env, 3).isoformat()
    assert items["board.node.added:shape:text"]["occurred_at"] == at(env, 5).isoformat()
    assert "секретный текст" not in json.dumps(response.data, ensure_ascii=False)


def test_foreign_author_ids_in_the_snapshot_do_not_reveal_user_names(api_client, board_env):
    env = board_env
    stranger = make_user("stranger", "Посторонний")
    # Первая версия — исходное содержимое доски (M-1), «добавленной» бывает только фигура из следующих версий.
    anchor = native_record("shape:anchor", "geo")
    save_version(env, anchor, moment=at(env, 1))
    save_version(
        env,
        anchor,
        node_record("shape:forged", author=stranger, created=at(env, 1), title="Подделка"),
        moment=at(env, 2),
    )
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since)

    assert [item["id"] for item in response.data["items"]] == ["board.node.added:shape:forged"]
    assert response.data["items"][0]["actor"] is None
    assert "Посторонний" not in json.dumps(response.data, ensure_ascii=False)


def test_feed_window_is_capped_at_30_days_and_items_at_the_limit(api_client, board_env):
    env = board_env
    task = create_issue(env, "Задача")
    binding = bind(env, "work_item", task.id, "shape:task")
    save_version(env, card("shape:task", env), moment=env.since - timedelta(hours=1), activate=[binding])
    for hours in (1, 2, 3):
        activity(env, task, field="priority", old="none", new="high", moment=at(env, hours))
    api_client.force_authenticate(user=env.lead)

    clamped = get_changes(api_client, env, since=timezone.now() - timedelta(days=45))
    limited = get_changes(api_client, env, since=env.since, limit=2)
    complete = get_changes(api_client, env, since=env.since)

    assert clamped.status_code == status.HTTP_200_OK
    until = datetime.fromisoformat(clamped.data["until"])
    assert datetime.fromisoformat(clamped.data["since"]) == until - timedelta(days=30)
    assert clamped.data["truncated"] is True
    # 30 дней назад доски ещё не было, но её карточка — из первой сохранённой версии, то есть исходное содержимое
    # доски (M-1): «добавленной» она не бывает ни при каком `since`.
    assert sorted(item["kind"] for item in clamped.data["items"]) == [
        "work_item.priority",
        "work_item.priority",
        "work_item.priority",
    ]
    assert [item["occurred_at"] for item in limited.data["items"]] == [
        at(env, 3).isoformat(),
        at(env, 2).isoformat(),
    ]
    assert limited.data["truncated"] is True
    assert len(complete.data["items"]) == 3
    assert complete.data["truncated"] is False


def test_feed_validates_parameters_and_access(api_client, board_env):
    env = board_env
    guest = add_member(env, make_user("guest"), 5)
    outsider = make_user("outsider")
    WorkspaceMemberFactory(workspace=env.workspace, member=outsider, role=15)
    extra, _ = create_canvas_board(
        canvas=env.canvas,
        name="Архивная",
        user_id=env.lead.id,
        client_operation_id=uuid.uuid4(),
    )
    PpmCanvasBoard.objects.filter(id=extra.id).update(status="archived", archived_at=timezone.now())
    api_client.force_authenticate(user=env.lead)

    missing_since = api_client.get(changes_url(env))
    bad_since = api_client.get(changes_url(env), {"since": "вчера"})
    too_many = api_client.get(changes_url(env), {"since": env.since.isoformat(), "limit": 201})
    zulu = api_client.get(changes_url(env), {"since": js_iso(env.since)})
    archived = get_changes(api_client, env, since=env.since, board=extra)
    api_client.force_authenticate(user=guest)
    guest_view = get_changes(api_client, env, since=env.since)
    api_client.force_authenticate(user=outsider)
    denied = get_changes(api_client, env, since=env.since)

    assert (missing_since.status_code, missing_since.data["error"]["code"]) == (400, "CANVAS_CHANGES_INVALID")
    assert "since" in missing_since.data["error"]["details"]
    assert (bad_since.status_code, bad_since.data["error"]["code"]) == (400, "CANVAS_CHANGES_INVALID")
    assert (too_many.status_code, too_many.data["error"]["code"]) == (400, "CANVAS_CHANGES_INVALID")
    assert zulu.status_code == status.HTTP_200_OK
    assert (archived.status_code, archived.data["error"]["code"]) == (404, "CANVAS_BOARD_NOT_FOUND")
    assert guest_view.status_code == status.HTTP_200_OK
    assert (denied.status_code, denied.data["error"]["code"]) == (403, "CANVAS_PERMISSION_DENIED")


def test_feed_survives_unreadable_cards_empty_boards_and_deleted_tasks(api_client, board_env):
    env = board_env
    task = create_issue(env, "Удалённая задача")
    binding = bind(env, "work_item", task.id, "shape:task")
    api_client.force_authenticate(user=env.lead)
    empty = get_changes(api_client, env, since=env.since)
    # Исходное содержимое доски (первая версия, M-1) — пустое; всё ниже появилось в следующей версии.
    save_version(env, moment=env.since - timedelta(hours=1))
    save_version(
        env,
        card("shape:task", env),
        {"id": "shape:broken", "typeName": "shape", "type": "ppm-canvas-node", "props": {"node": "{не json"}},
        {"id": "shape:odd", "typeName": "shape", "type": "ppm-canvas-node", "props": "oops"},
        {"id": "shape:untyped", "typeName": "shape"},
        {
            "id": "shape:legacy",
            "typeName": "shape",
            "type": "ppm-canvas-node",
            "props": {"node": json.dumps({"kind": "note", "created_at": "когда-то"})},
        },
        moment=at(env, 1),
        activate=[binding],
    )
    activity(env, task, field="state", old="Backlog", new="In progress", moment=at(env, 2))
    with patch("plane.db.mixins.soft_delete_related_objects"):
        task.delete()

    response = get_changes(api_client, env, since=env.since)

    assert empty.status_code == status.HTTP_200_OK
    assert empty.data["items"] == []
    assert response.status_code == status.HTTP_200_OK
    # Нечитаемые карточки и запись без типа пропускаются; карточка без времени — «добавлена» по сравнению с версией
    # на момент since (её не было) со временем версии; история удалённой задачи не показывается.
    assert sorted(item["id"] for item in response.data["items"]) == [
        "board.node.added:shape:legacy",
        "board.node.added:shape:task",
    ]
    assert {item["occurred_at"] for item in response.data["items"]} == {at(env, 1).isoformat()}


def populate(env, board, count, *, repository, git_connection, vault, prefix):
    records, bindings = [], []
    long_ago = env.since - timedelta(days=5)
    for index in range(count):
        task = create_issue(env, f"{prefix} задача {index}")
        bindings.append(bind(env, "work_item", task.id, f"shape:{prefix}-task-{index}", board=board))
        records.append(node_record(f"shape:{prefix}-task-{index}", kind="work_item_ref", created=long_ago))
        for hours, field in ((1, "state"), (2, "priority"), (3, "name")):
            activity(env, task, field=field, old="старое", new="новое", moment=at(env, hours))
        git_object = pull_request(
            env,
            repository,
            git_connection,
            number=len(prefix) * 1000 + index,
            title=f"PR {prefix} {index}",
            state="merged",
            first_seen=at(env, 1),
            updated=at(env, 2),
        )
        link_pull_request(env, repository, git_object, task)
        entry = create_markdown(
            vault=vault,
            parent_id=None,
            name=f"{prefix} файл {index}.md",
            content="# v1",
            user_id=env.lead.id,
        )
        bindings.append(bind(env, "vault_file", entry.id, f"shape:{prefix}-file-{index}", board=board))
        records.append(node_record(f"shape:{prefix}-file-{index}", kind="vault_file_ref", created=long_ago))
    base = [*records, node_record(f"shape:{prefix}-anchor", created=long_ago)]
    save_version(env, *base, moment=env.since - timedelta(hours=1), activate=bindings, board=board)
    added = [
        *(native_record(f"shape:{prefix}-sticker-{index}", "note") for index in range(count)),
        *(node_record(f"shape:{prefix}-new-{index}", author=env.lead, created=at(env, 4)) for index in range(count)),
    ]
    save_version(env, *base, *added, moment=at(env, 5), board=board)


def test_feed_query_count_does_not_grow_with_tasks_events_files_or_shapes(api_client, board_env):
    env = board_env
    repository, git_connection = git_repository(env)
    vault = get_or_create_project_vault(workspace_id=env.workspace.id, project_id=env.project.id, user_id=env.lead.id)
    small = env.board
    large, _ = create_canvas_board(
        canvas=env.canvas,
        name="Большая",
        user_id=env.lead.id,
        client_operation_id=uuid.uuid4(),
    )
    populate(env, small, 1, repository=repository, git_connection=git_connection, vault=vault, prefix="s")
    populate(env, large, 12, repository=repository, git_connection=git_connection, vault=vault, prefix="large")
    api_client.force_authenticate(user=env.lead)

    with CaptureQueriesContext(connection) as small_queries:
        small_response = get_changes(api_client, env, since=env.since, board=small)
    with CaptureQueriesContext(connection) as large_queries:
        large_response = get_changes(api_client, env, since=env.since, board=large)

    # На единицу: 3 изменения задачи, PR открыт и влит, версия файла, стикер и заметка на доске — 8 событий.
    assert len(small_response.data["items"]) == 8
    assert len(large_response.data["items"]) == 12 * 8
    assert len(large_queries.captured_queries) == len(small_queries.captured_queries)
    # ≈20 из них — общие проверки прав и холста любого эндпоинта доски, остальное — по одному запросу на источник.
    assert len(large_queries.captured_queries) <= 40


def test_feed_for_a_board_with_300_shapes_answers_within_a_second(api_client, board_env):
    env = board_env
    long_ago = env.since - timedelta(days=5)
    tasks = [create_issue(env, f"Задача {index}") for index in range(50)]
    bindings = [bind(env, "work_item", task.id, f"shape:task-{index}") for index, task in enumerate(tasks)]
    cards = [node_record(f"shape:task-{index}", kind="work_item_ref", created=long_ago) for index in range(50)]
    notes = [node_record(f"shape:note-{index}", author=env.lead, created=long_ago) for index in range(100)]
    save_version(env, *cards, *notes, moment=env.since - timedelta(hours=1), activate=bindings)
    edited = [
        node_record(f"shape:note-{index}", author=env.lead, created=long_ago, updated=at(env, 1)) for index in range(50)
    ]
    stickers = [native_record(f"shape:sticker-{index}", "note") for index in range(75)]
    shapes = [native_record(f"shape:geo-{index}", "geo") for index in range(75)]
    for step in range(10):
        visible_stickers = stickers[: 75 * (step + 1) // 10]
        save_version(env, *cards, *edited, *notes[50:], *visible_stickers, *shapes, moment=at(env, 2 + step))
    for task in tasks:
        activity(env, task, field="state", old="Backlog", new="In progress", moment=at(env, 3))
    api_client.force_authenticate(user=env.lead)

    started = time.perf_counter()
    response = get_changes(api_client, env, since=env.since)
    elapsed = time.perf_counter() - started

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["items"]) == 200
    assert response.data["truncated"] is True
    assert elapsed < 1.0


# ── AF2.2 S2a: время и автор фигур из отметок версий, настоящее время слияния PR ──


def resized(record, width):
    node = json.loads(record["props"]["node"])
    node["visual"]["width"] = width
    return {**record, "props": {**record["props"], "w": width, "node": json.dumps(node, ensure_ascii=False)}}


def version_marks(board):
    return list(
        PpmCanvasVersion.objects.filter(board=board)
        .order_by("version")
        .values_list("added_shape_ids", "changed_shape_ids")
    )


def by_id(response):
    return {item["id"]: item for item in response.data["items"]}


def test_saved_versions_record_added_shapes_and_changed_cards(board_env):
    env = board_env
    long_ago = env.since - timedelta(days=3)
    plan = node_record("shape:plan", author=env.lead, created=long_ago, title="План")
    broken = {"id": "shape:broken", "typeName": "shape", "type": "ppm-canvas-node", "props": {"node": "{не json"}}
    sticker = native_record("shape:sticker", "note")
    save_version(env, plan, broken, sticker, native_record("shape:arrow", "arrow"), moment=at(env, 1))
    # Перемещение и размер не меняют `updated_at` узла — это не правка; новая фигура — добавлена.
    moved = resized({**plan, "x": 400}, 320)
    save_version(env, moved, broken, {**sticker, "x": 90}, native_record("shape:geo", "geo"), moment=at(env, 2))
    edited = node_record("shape:plan", author=env.lead, created=long_ago, updated=at(env, 3), title="План v2")
    risks = node_record("shape:risks", author=env.lead, created=at(env, 3), title="Риски")
    save_version(env, edited, broken, risks, native_record("shape:geo", "geo"), moment=at(env, 3))
    # Нечитаемый узел сравнить нельзя — не правка; то же содержимое — ничего не отмечено.
    unreadable = {**broken, "props": {"node": "{всё ещё не json"}}
    save_version(env, edited, unreadable, risks, native_record("shape:geo", "geo"), moment=at(env, 4))
    # Та же фигура, возвращённая на доску (например, отменой удаления), снова «появилась».
    save_version(env, edited, unreadable, risks, native_record("shape:geo", "geo"), sticker, moment=at(env, 5))
    copy, _ = duplicate_canvas_board(
        board=PpmCanvasBoard.objects.get(pk=env.board.pk),
        name="Копия",
        user_id=env.lead.id,
        client_operation_id=uuid.uuid4(),
        request_id=uuid.uuid4(),
    )

    assert version_marks(env.board) == [
        (["shape:arrow", "shape:broken", "shape:plan", "shape:sticker"], []),
        (["shape:geo"], []),
        (["shape:risks"], ["shape:plan"]),
        ([], []),
        (["shape:sticker"], []),
    ]
    # Первая версия копии — все её фигуры добавлены (автор — тот, кто скопировал доску).
    assert version_marks(copy) == [
        (["shape:broken", "shape:geo", "shape:plan", "shape:risks", "shape:sticker"], []),
    ]


def test_native_shapes_get_the_time_and_author_of_the_version_that_added_them(api_client, board_env):
    env = board_env
    colleague = add_member(env, make_user("colleague", "Борис"), 15)
    stranger = make_user("stranger", "Посторонний")
    anchor = native_record("shape:anchor", "geo")
    save_version(env, anchor, moment=env.since - timedelta(hours=1))
    # Длинная история: 30 фигур появляются в разных версиях, между ними — сохранения без новых фигур. Деление пополам с
    # бюджетом в 12 шагов не различило бы их все; отметки версий дают точное время и автора каждой.
    shapes, authors = [], (env.lead, colleague, stranger)
    for index in range(30):
        shapes.append(native_record(f"shape:s-{index}", ("geo", "note", "text")[index % 3]))
        author = authors[index % 3]
        save_version(env, anchor, *shapes, moment=at(env, index + 1), user=author)
        save_version(env, {**anchor, "x": index}, *shapes, moment=at(env, index + 1.5), user=author)
    api_client.force_authenticate(user=env.lead)

    first = by_id(get_changes(api_client, env, since=env.since))
    save_version(env, anchor, *shapes, native_record("shape:late", "geo"), moment=at(env, 40), user=colleague)
    later = get_changes(api_client, env, since=env.since)

    actors = {
        env.lead.id: {"id": str(env.lead.id), "display_name": "Анна"},
        colleague.id: {"id": str(colleague.id), "display_name": "Борис"},
        stranger.id: None,
    }
    assert len(first) == 30
    for index in range(30):
        item = first[f"board.node.added:shape:s-{index}"]
        assert item["occurred_at"] == at(env, index + 1).isoformat()
        # Автор — только участник пространства: посторонний UUID автора версии не раскрывает имя.
        assert item["actor"] == actors[authors[index % 3].id]
    # История неизменяема: следующее сохранение не переставляет время и авторов уже показанных фигур.
    later_items = by_id(later)
    assert {key: later_items[key] for key in first} == first
    assert later_items["board.node.added:shape:late"]["occurred_at"] == at(env, 40).isoformat()
    assert later_items["board.node.added:shape:late"]["actor"] == actors[colleague.id]
    assert "Посторонний" not in json.dumps(later.data, ensure_ascii=False)


def test_card_changes_are_attributed_to_the_version_that_saved_the_current_edit(api_client, board_env):
    env = board_env
    colleague = add_member(env, make_user("colleague", "Борис"), 15)
    long_ago = env.since - timedelta(days=3)

    def card_at(shape_id, title, updated=None):
        return node_record(shape_id, author=env.lead, created=long_ago, updated=updated, title=title)

    save_version(
        env,
        card_at("shape:plan", "План"),
        card_at("shape:risks", "Риски"),
        card_at("shape:legacy", "Старое"),
        moment=env.since - timedelta(hours=1),
    )
    # Правка, сохранённая до S2a: у версии нет отметок, автор правки неизвестен.
    legacy = card_at("shape:legacy", "Старое v2", at(env, 1))
    old = save_version(env, card_at("shape:plan", "План"), card_at("shape:risks", "Риски"), legacy, moment=at(env, 1))
    PpmCanvasVersion.objects.filter(id=old.id).update(added_shape_ids=None, changed_shape_ids=None)
    plan = card_at("shape:plan", "План v2", at(env, 2))
    save_version(env, plan, card_at("shape:risks", "Риски"), legacy, moment=at(env, 2), user=colleague)
    # «Риски» правит Анна, затем Борис: событие описывает последнюю правку, поэтому её автор — Борис. Иначе своя ранняя
    # правка скрыла бы от Анны чужую позднюю (клиент прячет свои действия в режиме «с последнего просмотра»).
    risks_by_lead = card_at("shape:risks", "Риски v2", at(env, 3))
    save_version(env, {**plan, "x": 300}, risks_by_lead, legacy, moment=at(env, 3))
    risks_by_colleague = card_at("shape:risks", "Риски v3", at(env, 4))
    save_version(env, {**plan, "x": 300}, risks_by_colleague, legacy, moment=at(env, 4), user=colleague)
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since)

    boris = {"id": str(colleague.id), "display_name": "Борис"}
    items = {item["entity"]["id"]: item for item in response.data["items"]}
    assert set(items) == {"shape:plan", "shape:risks", "shape:legacy"}
    assert {item["kind"] for item in items.values()} == {"board.node.changed"}
    assert (items["shape:plan"]["occurred_at"], items["shape:plan"]["actor"]) == (ms(at(env, 2)).isoformat(), boris)
    assert items["shape:risks"]["id"] == f"board.node.changed:shape:risks:{ms(at(env, 4)).isoformat()}"
    assert items["shape:risks"]["actor"] == boris
    assert items["shape:legacy"]["actor"] is None


def test_versions_saved_before_the_marks_fall_back_to_a_bounded_stable_search(api_client, board_env):
    env = board_env
    anchor = native_record("shape:anchor", "geo")
    save_version(env, anchor, moment=env.since - timedelta(hours=1))
    shapes, appeared = [], {}
    for index in range(40):
        shapes.append(native_record(f"shape:old-{index}", "geo"))
        appeared[f"board.node.added:shape:old-{index}"] = at(env, index + 1)
        save_version(env, anchor, *shapes, moment=at(env, index + 1))
    # История до S2a — версии без отметок; после обновления доску сохранили ещё раз.
    PpmCanvasVersion.objects.filter(board=env.board).update(added_shape_ids=None, changed_shape_ids=None)
    save_version(env, {**anchor, "x": 5}, *shapes, moment=at(env, 45))
    api_client.force_authenticate(user=env.lead)

    with CaptureQueriesContext(connection) as queries:
        first = by_id(get_changes(api_client, env, since=env.since))
    # Выборка ключей версии — одна для базы и не больше SHAPE_TIME_PROBE_BUDGET шагов поиска (журнал запросов читается
    # до следующего запроса к API: начало запроса очищает его).
    key_queries = [query for query in queries.captured_queries if "jsonb_each" in query["sql"]]
    save_version(env, {**anchor, "x": 9}, *shapes, native_record("shape:new", "note"), moment=at(env, 46))
    later = by_id(get_changes(api_client, env, since=env.since))

    assert 1 < len(key_queries) <= SHAPE_TIME_PROBE_BUDGET + 1
    assert set(first) == set(appeared)
    exact = 0
    for event_id, moment in appeared.items():
        occurred_at = datetime.fromisoformat(first[event_id]["occurred_at"])
        # При исчерпании бюджета — нижняя граница диапазона + 1 версия: не позже настоящего времени и не «сейчас».
        assert at(env, 1) <= occurred_at <= moment
        exact += occurred_at == moment
        assert first[event_id]["actor"] is None
    assert 0 < exact < len(appeared)
    # Сетка поиска не зависит от текущей версии: новые сохранения не переставляют время старых фигур.
    assert {key: later[key] for key in first} == first
    assert later["board.node.added:shape:new"]["occurred_at"] == at(env, 46).isoformat()
    assert later["board.node.added:shape:new"]["actor"] == {"id": str(env.lead.id), "display_name": "Анна"}


def test_relation_event_uses_the_first_written_row_despite_plane_uninverted_fields(api_client, board_env):
    env = board_env
    design = create_issue(env, "Проектирование")
    build = create_issue(env, "Разработка")
    bindings = [bind(env, "work_item", design.id, "shape:design"), bind(env, "work_item", build.id, "shape:build")]
    save_version(
        env,
        card("shape:design", env),
        card("shape:build", env),
        moment=env.since - timedelta(hours=1),
        activate=bindings,
    )
    # Plane (`delete_issue_relation_activity`) обращает поле второй строки удаления только для blocked_by/blocking: у
    # start_*/finish_*/implements вторая задача получает то же поле, то есть неверное направление. Меньший UUID строки
    # выбрал бы её; главная строка — первая записанная.
    start_epoch = at(env, 1).timestamp()
    start = activity(
        env,
        design,
        field="start_before",
        old=identifier(build),
        verb="deleted",
        moment=at(env, 1),
        epoch=start_epoch,
        row_id=uuid.UUID(int=2**128 - 1),
    )
    activity(
        env,
        build,
        field="start_before",
        old=identifier(design),
        verb="deleted",
        moment=at(env, 1) + timedelta(microseconds=5),
        epoch=start_epoch,
        row_id=uuid.UUID(int=1),
    )
    implements_epoch = at(env, 2).timestamp()
    implements = activity(
        env,
        build,
        field="implements",
        old=identifier(design),
        verb="deleted",
        moment=at(env, 2),
        epoch=implements_epoch,
        row_id=uuid.UUID(int=2**128 - 2),
    )
    activity(
        env,
        design,
        field="implements",
        old=identifier(build),
        verb="deleted",
        moment=at(env, 2) + timedelta(microseconds=5),
        epoch=implements_epoch,
        row_id=uuid.UUID(int=2),
    )
    api_client.force_authenticate(user=env.lead)

    items = get_changes(api_client, env, since=env.since).data["items"]

    assert [(item["id"], item["entity"]["id"], item["detail"]) for item in items] == [
        (
            f"work_item.relation:{implements.id}",
            str(build.id),
            {"field": "implements", "old": identifier(design), "new": None},
        ),
        (
            f"work_item.relation:{start.id}",
            str(design.id),
            {"field": "start_before", "old": identifier(build), "new": None},
        ),
    ]
    assert all(sorted(item["shape_ids"]) == ["shape:build", "shape:design"] for item in items)


def test_merged_pull_request_does_not_resurface_after_the_mark_when_it_gets_activity(api_client, board_env):
    env = board_env
    task = create_issue(env, "Задача с PR")
    binding = bind(env, "work_item", task.id, "shape:task")
    save_version(env, card("shape:task", env), moment=env.since - timedelta(hours=1), activate=[binding])
    repository, git_connection = git_repository(env)
    merged = pull_request(
        env,
        repository,
        git_connection,
        number=7,
        title="LMP-1: живая карта",
        state="merged",
        first_seen=env.since - timedelta(days=1),
        updated=at(env, 1),
        merged=at(env, 1),
    )
    # Влит до начала окна, а комментарий пришёл в окне: ни «влит», ни «открыт».
    merged_earlier = pull_request(
        env,
        repository,
        git_connection,
        number=8,
        title="Давно влитый PR",
        state="merged",
        first_seen=at(env, 2),
        updated=at(env, 3),
        merged=env.since - timedelta(hours=5),
    )
    # PR, ещё не пересинхронизированный после обновления (времени слияния нет): как раньше — последнее обновление.
    not_synced = pull_request(
        env,
        repository,
        git_connection,
        number=9,
        title="PR до обновления",
        state="merged",
        first_seen=env.since - timedelta(days=1),
        updated=at(env, 4),
    )
    for git_object in (merged, merged_earlier, not_synced):
        link_pull_request(env, repository, git_object, task)
    api_client.force_authenticate(user=env.lead)

    before = get_changes(api_client, env, since=env.since)
    mark = api_client.put(seen_url(env))
    # Комментарий к влитому PR после отметки: reconcile переписывает только время обновления.
    PpmGitObject.objects.filter(id=merged.id).update(provider_updated_at=timezone.now())
    after = get_changes(api_client, env, since=datetime.fromisoformat(mark.data["seen_at"]))
    again = get_changes(api_client, env, since=env.since)

    expected = [
        (f"git.pull_request.merged:{not_synced.id}", at(env, 4).isoformat()),
        (f"git.pull_request.merged:{merged.id}", at(env, 1).isoformat()),
    ]
    assert mark.status_code == status.HTTP_200_OK
    assert [(item["id"], item["occurred_at"]) for item in before.data["items"]] == expected
    assert after.data["items"] == []
    assert [(item["id"], item["occurred_at"]) for item in again.data["items"]] == expected


def test_pull_request_linked_to_several_tasks_is_one_event_with_all_their_cards(api_client, board_env):
    env = board_env
    design = create_issue(env, "Макет")
    build = create_issue(env, "Сборка")
    repository, git_connection = git_repository(env)
    shared = pull_request(
        env,
        repository,
        git_connection,
        number=11,
        title="Общий PR",
        state="merged",
        first_seen=at(env, 1),
        updated=at(env, 2),
        merged=at(env, 2),
    )
    link_pull_request(env, repository, shared, build)
    link_pull_request(env, repository, shared, design)
    bindings = [
        bind(env, "work_item", design.id, "shape:design"),
        bind(env, "work_item", build.id, "shape:build"),
        bind(env, "pull_request", shared.id, "shape:pr"),
    ]
    save_version(
        env,
        card("shape:design", env),
        card("shape:build", env),
        card("shape:pr", env, "git_ref"),
        moment=env.since - timedelta(hours=1),
        activate=bindings,
    )
    api_client.force_authenticate(user=env.lead)

    items = get_changes(api_client, env, since=env.since).data["items"]

    assert [item["id"] for item in items] == [
        f"git.pull_request.merged:{shared.id}",
        f"git.pull_request.opened:{shared.id}",
    ]
    for item in items:
        assert item["shape_ids"] == ["shape:pr", "shape:design", "shape:build"]
        assert item["detail"] == {"field": "work_items", "new": f"{identifier(design)}, {identifier(build)}"}


def test_manual_pull_request_link_without_a_git_object_is_reported_as_opened(api_client, board_env):
    env = board_env
    task = create_issue(env, "Задача")
    repository, _ = git_repository(env)

    def manual_link(number, title):
        return PpmGitLink.objects.create(
            workspace_id=env.workspace.id,
            project_id=env.project.id,
            repository=repository,
            work_item=task,
            object_type="pull_request",
            ref=str(number),
            title=title,
            canonical_url=f"https://github.com/ppm/ppm/pull/{number}",
            origin=PpmGitLinkOrigin.MANUAL,
            created_by=env.lead.id,
            updated_by=env.lead.id,
        )

    fresh = manual_link(15, "Ручная ссылка на PR")
    old = manual_link(2, "Старая ссылка")
    PpmGitLink.objects.filter(id=fresh.id).update(created_at=at(env, 1))
    PpmGitLink.objects.filter(id=old.id).update(created_at=env.since - timedelta(days=1))
    bindings = [bind(env, "work_item", task.id, "shape:task"), bind(env, "pull_request", fresh.id, "shape:link")]
    save_version(
        env,
        card("shape:task", env),
        card("shape:link", env, "git_ref"),
        moment=env.since - timedelta(hours=1),
        activate=bindings,
    )
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since)

    assert response.data["items"] == [
        {
            "id": f"git.pull_request.opened:{fresh.id}",
            "kind": "git.pull_request.opened",
            "occurred_at": at(env, 1).isoformat(),
            "actor": None,
            "entity": {
                "type": "pull_request",
                "id": str(fresh.id),
                "title": "Ручная ссылка на PR",
                "identifier": "#15",
            },
            "shape_ids": ["shape:link", "shape:task"],
            "detail": {"field": "work_items", "new": identifier(task)},
        }
    ]


def test_restricted_guest_sees_pull_requests_and_sprint_tasks_of_own_tasks_only(api_client, board_env):
    env = board_env
    guest = add_member(env, make_user("guest", "Гость"), 5)
    own = create_issue(env, "Задача гостя", creator=guest)
    foreign = create_issue(env, "Чужая задача")
    sprint = Cycle.objects.create(
        name="Спринт",
        project=env.project,
        owned_by=env.lead,
        start_date=env.since,
        end_date=env.since + timedelta(days=14),
    )
    own_in_sprint = create_issue(env, "Задача спринта гостя", creator=guest)
    foreign_in_sprint = create_issue(env, "Чужая задача спринта")
    for issue in (own_in_sprint, foreign_in_sprint):
        CycleIssue.objects.create(cycle=sprint, issue=issue, project=env.project)
    bindings = [bind(env, "work_item", own.id, "shape:own"), bind(env, "work_item", foreign.id, "shape:foreign")]
    save_version(
        env,
        card("shape:own", env),
        card("shape:foreign", env),
        node_record(
            "shape:sprint",
            kind="group",
            author=env.lead,
            created=env.since - timedelta(days=1),
            extra={"map": {"role": "sprint", "cycle_id": str(sprint.id)}},
        ),
        moment=env.since - timedelta(hours=1),
        activate=bindings,
    )
    repository, git_connection = git_repository(env)
    shared = pull_request(
        env,
        repository,
        git_connection,
        number=21,
        title="Общий PR",
        state="open",
        first_seen=at(env, 1),
        updated=at(env, 1),
    )
    hidden = pull_request(
        env,
        repository,
        git_connection,
        number=22,
        title="Секретный PR",
        state="open",
        first_seen=at(env, 2),
        updated=at(env, 2),
    )
    link_pull_request(env, repository, shared, own)
    link_pull_request(env, repository, shared, foreign)
    link_pull_request(env, repository, hidden, foreign)
    own_change = activity(env, own_in_sprint, field="state", old="Backlog", new="In progress", moment=at(env, 3))
    activity(env, foreign_in_sprint, field="state", old="Backlog", new="Done", moment=at(env, 4))
    api_client.force_authenticate(user=guest)
    guest_view = get_changes(api_client, env, since=env.since)
    api_client.force_authenticate(user=env.lead)
    lead_view = get_changes(api_client, env, since=env.since)

    guest_items = guest_view.data["items"]
    assert [item["id"] for item in guest_items] == [
        f"work_item.state:{own_change.id}",
        f"git.pull_request.opened:{shared.id}",
    ]
    # Общий PR виден через задачу гостя, но чужая задача в нём не раскрывается.
    assert guest_items[1]["detail"] == {"field": "work_items", "new": identifier(own)}
    assert guest_items[1]["shape_ids"] == ["shape:own"]
    text = json.dumps(guest_view.data, ensure_ascii=False)
    assert "Секретный PR" not in text
    assert "Чужая задача" not in text
    assert identifier(foreign) not in text
    assert len(lead_view.data["items"]) == 4


# ── AF2.2 финальная волна (FW-S), M-1: первая сохранённая версия доски — её исходное содержимое ──


def new_board(env, name):
    board, _ = create_canvas_board(
        canvas=env.canvas,
        name=name,
        user_id=env.lead.id,
        client_operation_id=uuid.uuid4(),
    )
    return board


def test_initial_content_of_a_new_board_is_never_reported_as_added(api_client, board_env):
    env = board_env
    board = new_board(env, "Карта · Спринт 12")
    # Первое сохранение новой доски — собранная карта: рамка и карточки созданы в окне, плюс нативная фигура.
    frame = node_record("shape:frame", kind="group", author=env.lead, created=at(env, 1), title="Спринт 12")
    card_a = node_record("shape:a", author=env.lead, created=at(env, 1), title="A")
    sticker_b = native_record("shape:b", "note")
    save_version(env, frame, card_a, sticker_b, moment=at(env, 1), board=board)
    card_c = node_record("shape:c", author=env.lead, created=at(env, 2), title="C")
    geo_d = native_record("shape:d", "geo")
    save_version(env, frame, card_a, sticker_b, card_c, geo_d, moment=at(env, 2), board=board)
    api_client.force_authenticate(user=env.lead)

    before_first = get_changes(api_client, env, since=env.since, board=board)
    widest = get_changes(api_client, env, since=timezone.now() - timedelta(days=45), board=board)

    for response in (before_first, widest):
        assert response.status_code == status.HTTP_200_OK
        # «Добавлено» — только то, что появилось после исходного содержимого (версии 1), при любом `since`.
        assert sorted(item["id"] for item in response.data["items"]) == [
            "board.node.added:shape:c",
            "board.node.added:shape:d",
        ]
    items = by_id(before_first)
    assert items["board.node.added:shape:c"]["occurred_at"] == ms(at(env, 2)).isoformat()
    assert items["board.node.added:shape:d"]["occurred_at"] == at(env, 2).isoformat()


def test_a_board_copy_reports_nothing_as_added(api_client, board_env):
    env = board_env
    long_ago = env.since - timedelta(days=3)
    sticker = native_record("shape:sticker", "note")
    save_version(
        env,
        node_record("shape:note", author=env.lead, created=long_ago, title="План"),
        sticker,
        moment=env.since - timedelta(hours=1),
    )
    edited = node_record("shape:note", author=env.lead, created=long_ago, updated=at(env, 1), title="План v2")
    fresh = node_record("shape:fresh", author=env.lead, created=at(env, 2), title="Новая")
    save_version(env, edited, sticker, fresh, native_record("shape:geo", "geo"), moment=at(env, 2))
    copy, _ = duplicate_canvas_board(
        board=PpmCanvasBoard.objects.get(pk=env.board.pk),
        name="Копия",
        user_id=env.lead.id,
        client_operation_id=uuid.uuid4(),
        request_id=uuid.uuid4(),
    )
    PpmCanvasVersion.objects.filter(board=copy).update(created_at=at(env, 3))
    api_client.force_authenticate(user=env.lead)

    source = get_changes(api_client, env, since=env.since)
    copied = get_changes(api_client, env, since=env.since, board=copy)

    # Исходная доска — как прежде: «Новая» и фигура добавлены, «План» изменён.
    assert sorted(item["id"] for item in source.data["items"]) == [
        "board.node.added:shape:fresh",
        "board.node.added:shape:geo",
        f"board.node.changed:shape:note:{ms(at(env, 1)).isoformat()}",
    ]
    # Версия 1 копии — её исходное содержимое: ничего не «добавлено» и не «изменено» (правки были до копии и на другой
    # доске).
    assert copied.status_code == status.HTTP_200_OK
    assert copied.data["items"] == []


def test_after_the_first_version_the_board_diff_is_unchanged(api_client, board_env):
    env = board_env
    board = new_board(env, "Карта")
    card_a = node_record("shape:a", author=env.lead, created=at(env, 1), title="A")
    save_version(env, card_a, native_record("shape:b", "geo"), moment=at(env, 1), board=board)
    edited_a = node_record("shape:a", author=env.lead, created=at(env, 1), updated=at(env, 3), title="A v2")
    card_c = node_record("shape:c", author=env.lead, created=at(env, 3), title="C")
    save_version(
        env,
        edited_a,
        native_record("shape:b", "geo"),
        card_c,
        native_record("shape:d", "geo"),
        moment=at(env, 3),
        board=board,
    )
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=at(env, 2), board=board)

    # `since` после версии 1: сравнение с версией на момент `since`, как до M-1.
    assert sorted(item["id"] for item in response.data["items"]) == [
        "board.node.added:shape:c",
        "board.node.added:shape:d",
        f"board.node.changed:shape:a:{ms(at(env, 3)).isoformat()}",
    ]


def test_initial_cards_edited_later_are_reported_as_changed(api_client, board_env):
    env = board_env
    colleague = add_member(env, make_user("colleague", "Борис"), 15)
    board = new_board(env, "Карта")
    card_a = node_record("shape:a", author=env.lead, created=at(env, 1), title="A")
    card_b = node_record("shape:b", author=env.lead, created=at(env, 1), title="B")
    save_version(env, card_a, card_b, moment=at(env, 1), board=board)
    # Борис правит «A»; «B» только передвинули — это не правка.
    edited_a = node_record("shape:a", author=env.lead, created=at(env, 1), updated=at(env, 2), title="A v2")
    save_version(env, edited_a, {**card_b, "x": 300}, moment=at(env, 2), board=board, user=colleague)
    api_client.force_authenticate(user=env.lead)

    before_first = get_changes(api_client, env, since=env.since, board=board)
    after_first = get_changes(api_client, env, since=at(env, 1) + timedelta(minutes=1), board=board)

    changed_id = f"board.node.changed:shape:a:{ms(at(env, 2)).isoformat()}"
    for response in (before_first, after_first):
        assert [item["id"] for item in response.data["items"]] == [changed_id]
        assert response.data["items"][0]["occurred_at"] == ms(at(env, 2)).isoformat()
        assert response.data["items"][0]["actor"] == {"id": str(colleague.id), "display_name": "Борис"}
        assert response.data["items"][0]["entity"] == {"type": "node", "id": "shape:a", "title": "A v2"}


def test_a_board_without_saved_versions_has_an_empty_feed(api_client, board_env):
    env = board_env
    board = new_board(env, "Пустая")
    api_client.force_authenticate(user=env.lead)

    response = get_changes(api_client, env, since=env.since, board=board)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["items"] == []
    assert response.data["truncated"] is False


# ── AF2.2 финальная волна (FW-S), final-pass S2a ──


def test_a_shape_added_removed_and_restored_keeps_the_time_of_its_earliest_version(api_client, board_env):
    env = board_env
    colleague = add_member(env, make_user("colleague", "Борис"), 15)
    anchor = native_record("shape:anchor", "geo")
    save_version(env, anchor, moment=env.since - timedelta(hours=1))
    sticker = native_record("shape:sticker", "note")
    # Карточка PPM, вставленная со старым `created_at`, — тоже без своей метки времени.
    pasted = node_record("shape:pasted", author=env.lead, created=env.since - timedelta(days=3), title="Вставка")
    save_version(env, anchor, sticker, pasted, moment=at(env, 1), user=colleague)
    save_version(env, anchor, moment=at(env, 2))
    # Возвращены (например, отменой удаления) — версия снова отмечает их «появившимися».
    save_version(env, anchor, sticker, pasted, moment=at(env, 3))
    api_client.force_authenticate(user=env.lead)

    from_start = by_id(get_changes(api_client, env, since=env.since))
    after_removal = by_id(get_changes(api_client, env, since=at(env, 2) + timedelta(minutes=30)))

    boris = {"id": str(colleague.id), "display_name": "Борис"}
    anna = {"id": str(env.lead.id), "display_name": "Анна"}
    assert set(from_start) == set(after_removal) == {"board.node.added:shape:sticker", "board.node.added:shape:pasted"}
    # С начала окна — самая ранняя версия после `since`, где фигура появилась (правило S2a), а не версия возврата.
    for item in from_start.values():
        assert (item["occurred_at"], item["actor"]) == (at(env, 1).isoformat(), boris)
    # Если на момент `since` фигуры не было (удалена), «добавлена» — версией возврата.
    for item in after_removal.values():
        assert (item["occurred_at"], item["actor"]) == (at(env, 3).isoformat(), anna)


def test_a_pull_request_first_seen_already_merged_is_not_opened_after_the_merge(api_client, board_env):
    env = board_env
    task = create_issue(env, "Задача с PR")
    binding = bind(env, "work_item", task.id, "shape:task")
    save_version(env, card("shape:task", env), moment=env.since - timedelta(hours=1), activate=[binding])
    repository, git_connection = git_repository(env)
    # PPM впервые увидел PR уже влитым (репозиторий подключили позже, пропущен webhook).
    seen_merged = pull_request(
        env,
        repository,
        git_connection,
        number=31,
        title="Влит до первой синхронизации",
        state="merged",
        first_seen=at(env, 3),
        updated=at(env, 2),
        merged=at(env, 2),
    )
    # То же до пересинхронизации после S2a (времени слияния нет): последнее обновление раньше первого появления.
    seen_merged_legacy = pull_request(
        env,
        repository,
        git_connection,
        number=32,
        title="Влит, без времени слияния",
        state="merged",
        first_seen=at(env, 4),
        updated=at(env, 1.5),
    )
    # Обычный путь: PR увидели открытым, потом влили — оба события.
    regular = pull_request(
        env,
        repository,
        git_connection,
        number=33,
        title="Открыт, потом влит",
        state="merged",
        first_seen=at(env, 1),
        updated=at(env, 5),
        merged=at(env, 5),
    )
    for git_object in (seen_merged, seen_merged_legacy, regular):
        link_pull_request(env, repository, git_object, task)
    api_client.force_authenticate(user=env.lead)

    items = get_changes(api_client, env, since=env.since).data["items"]

    assert [(item["id"], item["occurred_at"]) for item in items] == [
        (f"git.pull_request.merged:{regular.id}", at(env, 5).isoformat()),
        (f"git.pull_request.merged:{seen_merged.id}", at(env, 2).isoformat()),
        (f"git.pull_request.merged:{seen_merged_legacy.id}", at(env, 1.5).isoformat()),
        (f"git.pull_request.opened:{regular.id}", at(env, 1).isoformat()),
    ]
