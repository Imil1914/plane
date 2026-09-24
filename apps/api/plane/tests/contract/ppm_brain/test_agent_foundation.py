import json
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from plane.db.models import Issue, State
from plane.ppm_brain.agent_actions import (
    PpmAgentActionError,
    add_proposed_action,
    cancel_agent_run,
    claim_agent_run,
    create_agent_run,
    expire_stale_agent_runs,
    fail_agent_run,
    finish_agent_run,
    renew_agent_run_lease,
    review_agent_action,
    start_agent_tool_call,
    start_agent_run,
)
from plane.ppm_brain.agent_decomposer import run_work_decomposer
from plane.ppm_brain.agent_execution import execute_queued_agent_run
from plane.ppm_brain.agent_registry import (
    AGENT_REGISTRY,
    PpmAgentRegistryError,
    serialize_agent_registry,
    validate_agent_tool_call,
    validate_approved_action_tool_call,
)
from plane.ppm_brain.models import (
    PpmAgentAction,
    PpmAgentActionStatus,
    PpmAgentAuditEvent,
    PpmAgentCitation,
    PpmAgentKind,
    PpmAgentRun,
    PpmAgentRunStatus,
    PpmKnowledgeSourceType,
)
from plane.ppm_brain.services import process_index_job, request_source_index
from plane.ppm_brain.tasks import process_brain_agent_run_task, recover_queued_agent_runs_task
from plane.ppm_canvas.models import (
    PpmCanvasBinding,
    PpmCanvasBindingStatus,
    PpmCanvasEntityType,
    PpmCanvasSemanticEdge,
    PpmSemanticEdgeConfirmationStatus,
    PpmSemanticEdgeOrigin,
)
from plane.ppm_canvas.services import get_or_create_active_canvas, save_canvas_snapshot
from plane.ppm_vault.models import PpmVaultEntry
from plane.ppm_vault.services import create_markdown, get_or_create_project_vault
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def parse_sse_response(response):
    body = b"".join(response.streaming_content).decode("utf-8")
    events = []
    for block in body.strip().split("\n\n"):
        lines = block.splitlines()
        event = next((line.removeprefix("event: ") for line in lines if line.startswith("event: ")), "message")
        data = "\n".join(line.removeprefix("data: ") for line in lines if line.startswith("data: "))
        events.append((event, json.loads(data)))
    return events


@pytest.fixture
def agent_project():
    user = UserFactory(
        username=f"agent-{uuid.uuid4().hex}",
        email=f"agent-{uuid.uuid4().hex}@plane.test",
    )
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier=f"AGT{uuid.uuid4().hex[:5].upper()}")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    state = State.objects.create(
        workspace=workspace,
        project=project,
        name="В работе",
        color="#22c55e",
        group="started",
        default=True,
    )
    issue = Issue.objects.create(
        workspace=workspace,
        project=project,
        state=state,
        name="Проверить безопасные предложения",
        description_html="<p>Источник AGENT-SOURCE-ONE.</p>",
        priority="high",
    )
    source, job = request_source_index(
        workspace_id=workspace.id,
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=issue.id,
        requested_by=user.id,
    )
    process_index_job(job.id, worker_id="agent-foundation-test")
    source.refresh_from_db()
    return user, workspace, project, issue, source


def test_registry_contains_four_agents_and_never_exposes_apply_tools_to_them():
    registry = serialize_agent_registry()

    assert set(AGENT_REGISTRY) == set(PpmAgentKind.values)
    assert len(registry) == 4
    assert all(tool["mode"] != "apply" for agent in registry for tool in agent["tools"])

    with pytest.raises(PpmAgentRegistryError) as exc_info:
        validate_agent_tool_call(
            agent_kind=PpmAgentKind.WORK_DECOMPOSER,
            tool_name="create_work_items_from_action",
            payload={"action_id": str(uuid.uuid4())},
        )
    assert exc_info.value.code == "AGENT_TOOL_NOT_ALLOWED"

    approved_tool = validate_approved_action_tool_call(
        tool_name="create_work_items_from_action",
        payload={"action_id": str(uuid.uuid4())},
    )
    assert approved_tool.mode.value == "apply"


def test_registry_api_is_project_scoped_and_keeps_apply_disabled(api_client, agent_project, settings):
    user, workspace, project, _, _ = agent_project
    settings.PPM_AGENTS_WRITE_ENABLED = False
    outsider = UserFactory(
        username=f"outsider-{uuid.uuid4().hex}",
        email=f"outsider-{uuid.uuid4().hex}@plane.test",
    )
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/registry/"

    api_client.force_authenticate(user=user)
    allowed = api_client.get(url)

    assert allowed.status_code == 200
    assert allowed.data["policy_version"] == "ppm-agents-v1"
    assert allowed.data["write_enabled"] is False
    assert {agent["kind"] for agent in allowed.data["agents"]} == set(PpmAgentKind.values)

    api_client.force_authenticate(user=outsider)
    denied = api_client.get(url)
    assert denied.status_code == 403
    assert denied.data["error"]["code"] == "BRAIN_PERMISSION_DENIED"

    settings.PPM_AGENTS_ENABLED = False
    api_client.force_authenticate(user=user)
    disabled = api_client.get(url)
    assert disabled.status_code == 503
    assert disabled.data["error"]["code"] == "AGENTS_DISABLED"


def test_project_reporter_api_returns_grounded_read_only_report(api_client, agent_project):
    user, workspace, project, issue, source = agent_project
    issue.target_date = timezone.localdate() - timedelta(days=1)
    issue.save(update_fields=["target_date", "updated_at"])
    source, job = request_source_index(
        workspace_id=workspace.id,
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=issue.id,
        requested_by=user.id,
    )
    process_index_job(job.id, worker_id="project-reporter-test")
    source.refresh_from_db()
    issue_count = Issue.objects.filter(project=project).count()
    operation_id = uuid.uuid4()
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    payload = {
        "agent_kind": PpmAgentKind.PROJECT_REPORTER,
        "client_operation_id": str(operation_id),
        "context": {"locale": "ru"},
        "options": {"max_highlights": 5},
    }

    api_client.force_authenticate(user=user)
    created = api_client.post(url, payload, format="json")
    duplicate = api_client.post(url, payload, format="json")

    assert created.status_code == 201
    assert duplicate.status_code == 200
    assert duplicate.data["id"] == created.data["id"]
    assert created.data["status"] == PpmAgentRunStatus.COMPLETED
    assert created.data["started_at"] is not None
    assert created.data["attempt_count"] == 1
    assert created.data["policy_version"] == "ppm-agents-v1"
    assert "input_json" not in created.data
    assert "input_hash" not in created.data
    assert "lease_token" not in created.data
    assert "lease_expires_at" not in created.data
    assert "worker_task_id" not in created.data
    assert created.data["result"]["kind"] == "project_report"
    assert created.data["result"]["metrics"]["issue_count"] == issue_count
    assert created.data["result"]["metrics"]["overdue_count"] == 1
    assert "# Сводка проекта" in created.data["result"]["markdown"]
    assert "Plane" not in created.data["result"]["markdown"]
    assert "задач PPM" in created.data["result"]["markdown"]
    assert created.data["citations"][0]["source_id"] == source.source_id
    assert created.data["citations"][0]["source_version"] == source.source_version
    assert {event.get("tool", {}).get("name") for event in created.data["audit_trace"] if event.get("tool")} >= {
        "list_work_items",
        "read_work_item",
    }
    assert Issue.objects.filter(project=project).count() == issue_count
    assert not PpmAgentRun.objects.get(id=created.data["id"]).actions.exists()


@pytest.mark.django_db(transaction=True)
def test_agent_stream_emits_queued_running_and_final_snapshots(api_client, agent_project):
    user, workspace, project, _, _ = agent_project
    operation_id = str(uuid.uuid4())
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/stream/"
    payload = {
        "agent_kind": PpmAgentKind.PROJECT_REPORTER,
        "client_operation_id": operation_id,
        "context": {"locale": "ru"},
        "options": {"max_highlights": 3},
    }
    api_client.force_authenticate(user=user)

    created = api_client.post(url, payload, format="json")
    events = parse_sse_response(created)
    replay = api_client.post(url, payload, format="json")
    replay_events = parse_sse_response(replay)

    run_events = [data for event, data in events if event == "run"]
    progress_events = [data for event, data in events if event == "progress"]
    assert created.status_code == 201
    assert created["Content-Type"].startswith("text/event-stream")
    assert created["Cache-Control"] == "no-cache, no-transform"
    assert [run["status"] for run in run_events] == ["queued", "running", "completed"]
    assert len({run["id"] for run in run_events}) == 1
    assert [progress["tool"]["status"] for progress in progress_events[:2]] == ["running", "completed"]
    assert progress_events[0]["tool"]["name"] == "list_work_items"
    assert progress_events[0]["call_id"] == progress_events[1]["call_id"]
    assert all(set(progress) == {"run_id", "call_id", "occurred_at", "tool"} for progress in progress_events)
    assert all(set(progress["tool"]) == {"name", "mode", "status", "result_count"} for progress in progress_events)
    assert run_events[-1]["audit_trace"]
    assert replay.status_code == 200
    assert [(event, data["status"]) for event, data in replay_events] == [("run", "completed")]
    assert replay_events[0][1]["id"] == run_events[-1]["id"]


@pytest.mark.django_db(transaction=True)
def test_agent_stream_returns_safe_failure_event(api_client, agent_project):
    user, workspace, project, _, _ = agent_project
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/stream/"
    api_client.force_authenticate(user=user)

    response = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": {"goal": "Проверить безопасную ошибку", "source_id": str(uuid.uuid4())},
        },
        format="json",
    )
    events = parse_sse_response(response)

    assert response.status_code == 201
    assert [data["status"] for event, data in events if event == "run"] == ["queued", "running", "failed"]
    assert events[-1] == (
        "error",
        {
            "code": "WORK_DECOMPOSER_SOURCE_NOT_READY",
            "message": "Выбранная задача недоступна или ещё не проиндексирована.",
        },
    )
    assert "traceback" not in json.dumps(events).lower()


@pytest.mark.django_db(transaction=True)
def test_agent_stream_fails_safely_when_queue_is_unavailable(api_client, agent_project, monkeypatch):
    user, workspace, project, _, _ = agent_project
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/stream/"
    api_client.force_authenticate(user=user)

    def unavailable(_run_id):
        raise RuntimeError("DO_NOT_EXPOSE_BROKER_DETAILS")

    monkeypatch.setattr("plane.ppm_brain.views.dispatch_agent_run", unavailable)
    response = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.PROJECT_REPORTER,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": {"max_highlights": 3},
        },
        format="json",
    )
    events = parse_sse_response(response)

    assert response.status_code == 201
    assert [data["status"] for event, data in events if event == "run"] == ["queued", "failed"]
    assert events[-1] == (
        "error",
        {
            "code": "AGENT_QUEUE_UNAVAILABLE",
            "message": "Очередь проектных агентов временно недоступна. Повторите запуск позже.",
        },
    )
    assert "DO_NOT_EXPOSE_BROKER_DETAILS" not in json.dumps(events)


@pytest.mark.django_db(transaction=True)
def test_agent_stream_treats_concurrent_cancellation_as_terminal(api_client, agent_project, monkeypatch):
    user, workspace, project, _, _ = agent_project
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/stream/"
    api_client.force_authenticate(user=user)

    def cancel_during_execution(*, run, agent_kind, options, progress_callback=None):
        cancel_agent_run(run=run, user_id=user.id)
        raise PpmAgentActionError(code="AGENT_RUN_NOT_FINISHABLE", message="Этот запуск агента уже завершён.")

    monkeypatch.setattr("plane.ppm_brain.agent_execution.execute_started_agent_run", cancel_during_execution)
    response = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.PROJECT_REPORTER,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": {"max_highlights": 3},
        },
        format="json",
    )
    events = parse_sse_response(response)

    assert response.status_code == 201
    assert [(event, data["status"]) for event, data in events] == [
        ("run", "queued"),
        ("run", "running"),
        ("run", "cancelled"),
    ]


def test_agent_worker_claim_is_durable_and_duplicate_delivery_is_safe(agent_project):
    user, workspace, project, _, _ = agent_project
    run, created = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 2}},
        context={"locale": "ru"},
    )

    first = process_brain_agent_run_task.apply(args=[str(run.id)]).get()
    duplicate = process_brain_agent_run_task.apply(args=[str(run.id)]).get()
    run.refresh_from_db()

    assert created is True
    assert run.input_json == {"options": {"max_highlights": 2}}
    assert run.status == PpmAgentRunStatus.COMPLETED
    assert run.attempt_count == 1
    assert run.lease_token is None
    assert run.lease_expires_at is None
    assert run.worker_task_id == ""
    assert first == {"run_id": str(run.id), "status": PpmAgentRunStatus.COMPLETED, "claimed": True}
    assert duplicate == {"run_id": str(run.id), "status": PpmAgentRunStatus.COMPLETED, "claimed": False}
    assert PpmAgentAuditEvent.objects.filter(run=run, event_type="run_started").count() == 1
    assert PpmAgentAuditEvent.objects.filter(run=run, event_type="run_completed").count() == 1


def test_expired_worker_lease_resumes_proposals_without_duplicates(agent_project, monkeypatch):
    user, workspace, project, _, source = agent_project
    options = {"goal": "Восстановить декомпозицию после падения worker", "source_id": source.source_id}
    run, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.WORK_DECOMPOSER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": options},
        context={"locale": "ru"},
    )
    first_attempt, claimed = claim_agent_run(run, worker_id="worker-a")

    class SimulatedWorkerLoss(BaseException):
        pass

    def lose_worker(*args, **kwargs):
        raise SimulatedWorkerLoss

    with monkeypatch.context() as scoped:
        scoped.setattr("plane.ppm_brain.agent_decomposer.finish_agent_run", lose_worker)
        with pytest.raises(SimulatedWorkerLoss):
            run_work_decomposer(run=first_attempt, options=options)

    assert claimed is True
    assert PpmAgentAction.objects.filter(run=run).count() == 3
    PpmAgentRun.objects.filter(id=run.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))

    resumed, resumed_claimed = execute_queued_agent_run(run.id, worker_id="worker-b")
    resumed.refresh_from_db()

    assert resumed_claimed is True
    assert resumed.status == PpmAgentRunStatus.AWAITING_APPROVAL
    assert resumed.attempt_count == 2
    assert resumed.lease_token is None
    assert resumed.worker_task_id == ""
    assert PpmAgentAction.objects.filter(run=run).count() == 3
    assert PpmAgentAuditEvent.objects.filter(run=run, event_type="run_recovered").count() == 1
    assert PpmAgentAuditEvent.objects.filter(run=run, event_type="run_started").count() == 2


def test_stale_worker_is_fenced_after_lease_reassignment(agent_project):
    user, workspace, project, _, _ = agent_project
    run, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 1}},
        context={"locale": "ru"},
    )
    first_attempt, _ = claim_agent_run(run, worker_id="worker-a")
    PpmAgentRun.objects.filter(id=run.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    second_attempt, claimed = claim_agent_run(run, worker_id="worker-b")

    stale_failure = fail_agent_run(
        first_attempt,
        error_code="STALE_WORKER_FAILURE",
        error_message="Устаревший worker не должен завершить новую попытку.",
    )
    with pytest.raises(PpmAgentActionError) as exc_info:
        start_agent_tool_call(run=first_attempt, tool_name="list_work_items", payload={})

    stale_failure.refresh_from_db()
    assert claimed is True
    assert first_attempt.lease_token != second_attempt.lease_token
    assert stale_failure.status == PpmAgentRunStatus.RUNNING
    assert stale_failure.lease_token == second_attempt.lease_token
    assert stale_failure.error_code == ""
    assert exc_info.value.code == "AGENT_RUN_LEASE_LOST"


def test_only_current_worker_can_renew_agent_lease(agent_project):
    user, workspace, project, _, _ = agent_project
    run, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 1}},
        context={"locale": "ru"},
    )
    first_attempt, _ = claim_agent_run(run, worker_id="worker-a")
    original_expiry = first_attempt.lease_expires_at
    renewed_at = timezone.now() + timedelta(seconds=5)

    renewed, changed = renew_agent_run_lease(first_attempt, now=renewed_at, lease_seconds=60)
    assert changed is True
    assert renewed.lease_expires_at == renewed_at + timedelta(seconds=60)
    assert renewed.lease_expires_at > original_expiry

    PpmAgentRun.objects.filter(id=run.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    second_attempt, claimed = claim_agent_run(run, worker_id="worker-b")
    stale_renewal, stale_changed = renew_agent_run_lease(first_attempt)

    assert claimed is True
    assert stale_changed is False
    assert stale_renewal.lease_token == second_attempt.lease_token
    assert stale_renewal.lease_expires_at == second_attempt.lease_expires_at


def test_worker_attempt_limit_times_out_repeated_crash(agent_project):
    user, workspace, project, _, _ = agent_project
    run, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 1}},
        context={"locale": "ru"},
    )
    first_attempt, _ = claim_agent_run(run, worker_id="worker-a", max_attempts=1)
    PpmAgentRun.objects.filter(id=run.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))

    timed_out, claimed = claim_agent_run(first_attempt, worker_id="worker-b", max_attempts=1)
    timed_out.refresh_from_db()

    assert claimed is False
    assert timed_out.status == PpmAgentRunStatus.TIMED_OUT
    assert timed_out.attempt_count == 1
    assert timed_out.error_code == "AGENT_RUN_TIMED_OUT"
    assert timed_out.lease_token is None
    assert timed_out.lease_expires_at is None
    assert timed_out.worker_task_id == ""
    assert PpmAgentAuditEvent.objects.filter(run=run, event_type="run_timed_out").count() == 1


def test_recovery_dispatches_only_queued_agent_runs(agent_project, monkeypatch):
    user, workspace, project, _, _ = agent_project
    queued, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 1}},
        context={"locale": "ru"},
    )
    completed, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 1}},
        context={"locale": "ru"},
    )
    process_brain_agent_run_task.apply(args=[str(completed.id)]).get()
    active, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 1}},
        context={"locale": "ru"},
    )
    active = start_agent_run(active)
    expired, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": {"max_highlights": 1}},
        context={"locale": "ru"},
    )
    expired = start_agent_run(expired)
    PpmAgentRun.objects.filter(id=expired.id).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
    dispatched = []
    monkeypatch.setattr(
        "plane.ppm_brain.tasks.process_brain_agent_run_task.delay",
        lambda run_id: dispatched.append(run_id),
    )

    count = recover_queued_agent_runs_task.run()

    assert count == 2
    assert dispatched == [str(queued.id), str(expired.id)]
    active.refresh_from_db()
    assert active.status == PpmAgentRunStatus.RUNNING


def test_agent_run_detail_exposes_redacted_audit_trace_and_is_project_scoped(api_client, agent_project):
    user, workspace, project, _, _ = agent_project
    list_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    api_client.force_authenticate(user=user)
    created = api_client.post(
        list_url,
        {
            "agent_kind": PpmAgentKind.PROJECT_REPORTER,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": {"max_highlights": 1},
        },
        format="json",
    )
    assert created.status_code == 201

    run = PpmAgentRun.objects.get(id=created.data["id"])
    PpmAgentAuditEvent.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        run=run,
        actor_id=user.id,
        event_type="redaction_check",
        metadata_json={"prompt": "DO_NOT_EXPOSE_PROMPT", "token": "DO_NOT_EXPOSE_TOKEN"},
    )
    detail_url = f"{list_url}{run.id}/"
    detail = api_client.get(detail_url)

    assert detail.status_code == 200
    assert {event["event_type"] for event in detail.data["audit_trace"]} >= {
        "run_created",
        "run_started",
        "tool_call_started",
        "tool_call_completed",
        "run_completed",
        "redaction_check",
    }
    base_keys = {"id", "event_type", "action_id", "created_at"}
    assert all(
        frozenset(event) in {frozenset(base_keys), frozenset(base_keys | {"tool"})}
        for event in detail.data["audit_trace"]
    )
    tool_events = [event for event in detail.data["audit_trace"] if "tool" in event]
    assert tool_events
    assert all(set(event["tool"]) == {"name", "mode", "status", "result_count"} for event in tool_events)
    assert {event["tool"]["status"] for event in tool_events} == {"running", "completed"}
    assert "DO_NOT_EXPOSE_PROMPT" not in str(detail.data)
    assert "DO_NOT_EXPOSE_TOKEN" not in str(detail.data)
    assert "metadata_json" not in str(detail.data)
    assert "actor_id" not in str(detail.data)

    other_project = ProjectFactory(workspace=workspace, identifier=f"ISO{uuid.uuid4().hex[:5].upper()}")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=user, role=20)
    wrong_project_url = (
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{other_project.id}/knowledge/agents/runs/{run.id}/"
    )
    wrong_project = api_client.get(wrong_project_url)

    assert wrong_project.status_code == 404
    assert wrong_project.data["error"]["code"] == "AGENT_RUN_NOT_FOUND"


def test_agent_stream_rejects_foreign_board_and_unknown_secret_field(api_client, agent_project):
    user, workspace, project, _, _ = agent_project
    foreign_project = ProjectFactory(workspace=workspace, identifier=f"CTX{uuid.uuid4().hex[:5].upper()}")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=user, role=20)
    foreign_canvas = get_or_create_active_canvas(
        workspace_id=workspace.id,
        project_id=foreign_project.id,
        user_id=user.id,
    )
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/stream/"
    secret = "sk-agent-private-value"
    api_client.force_authenticate(user=user)

    foreign_board = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.RELATIONSHIP_ANALYST,
            "client_operation_id": str(uuid.uuid4()),
            "context": {
                "canvas_id": str(foreign_canvas.default_board_id),
                "selected_shape_ids": ["shape:foreign-a", "shape:foreign-b"],
                "locale": "ru",
            },
            "options": {
                "from_shape_id": "shape:foreign-a",
                "to_shape_id": "shape:foreign-b",
                "relation": "relates_to",
                "reason": "Проверка изоляции",
            },
        },
        format="json",
        HTTP_ACCEPT="text/event-stream",
    )
    forbidden_field = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.PROJECT_REPORTER,
            "client_operation_id": str(uuid.uuid4()),
            "options": {},
            "provider_api_key": secret,
        },
        format="json",
        HTTP_ACCEPT="text/event-stream",
    )

    assert foreign_board.status_code == 400
    assert foreign_board.data["error"]["code"] == "AGENT_CONTEXT_CANVAS_NOT_FOUND"
    assert forbidden_field.status_code == 400
    assert forbidden_field.data["error"]["code"] == "AGENT_REQUEST_FIELD_FORBIDDEN"
    assert secret not in json.dumps(forbidden_field.data, ensure_ascii=False)
    assert not PpmAgentRun.objects.filter(project_id=project.id).exists()


def test_agent_stream_replay_never_serializes_worker_input_tokens_or_audit_metadata(api_client, agent_project):
    user, workspace, project, _, _ = agent_project
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    operation_id = str(uuid.uuid4())
    payload = {
        "agent_kind": PpmAgentKind.PROJECT_REPORTER,
        "client_operation_id": operation_id,
        "context": {"locale": "ru"},
        "options": {"max_highlights": 1},
    }
    api_client.force_authenticate(user=user)
    created = api_client.post(url, payload, format="json")
    run = PpmAgentRun.objects.get(id=created.data["id"])
    secret = "sk-internal-worker-secret"
    run.input_json = {"options": {"max_highlights": 1}, "api_key": secret}
    run.token_usage_json = {"private_token": secret}
    run.worker_task_id = secret
    run.save(update_fields=["input_json", "token_usage_json", "worker_task_id", "updated_at"])
    PpmAgentAuditEvent.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        run=run,
        actor_id=user.id,
        event_type="private_metadata_check",
        metadata_json={"prompt": secret, "traceback": f"RuntimeError({secret})"},
    )

    replay = api_client.post(f"{url}stream/", payload, format="json", HTTP_ACCEPT="text/event-stream")
    events = parse_sse_response(replay)
    serialized = json.dumps(events, ensure_ascii=False)

    assert replay.status_code == 200
    assert [event for event, _ in events] == ["run"]
    assert events[0][1]["id"] == str(run.id)
    assert secret not in serialized
    assert "input_json" not in serialized
    assert "token_usage" not in serialized
    assert "worker_task_id" not in serialized
    assert "metadata_json" not in serialized
    assert "traceback" not in serialized.lower()


def test_work_decomposer_api_proposes_three_tasks_without_creating_them(api_client, agent_project):
    user, workspace, project, _, source = agent_project
    issue_count = Issue.objects.filter(project=project).count()
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"

    api_client.force_authenticate(user=user)
    created = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": {
                "goal": "Подготовить безопасный запуск проектных агентов",
                "source_id": source.source_id,
            },
        },
        format="json",
    )

    assert created.status_code == 201
    assert created.data["status"] == PpmAgentRunStatus.AWAITING_APPROVAL
    assert created.data["result"]["kind"] == "work_decomposition"
    assert created.data["result"]["item_count"] == 3
    assert created.data["result"]["canonical_changes_applied"] is False
    assert len(created.data["actions"]) == 3
    assert created.data["result"]["action_ids"] == [action["id"] for action in created.data["actions"]]
    assert created.data["action_summary"] == {
        "total": 3,
        "reviewed": 0,
        "remaining": 3,
        "approved": 0,
        "rejected": 0,
        "cancelled": 0,
        "applying": 0,
        "applied": 0,
        "conflict": 0,
        "failed": 0,
        "review_complete": False,
        "partial": False,
        "canonical_changes_applied": False,
    }
    for position, action in enumerate(created.data["actions"], start=1):
        assert action["status"] == PpmAgentActionStatus.PROPOSED
        assert action["proposal_tool"] == "propose_work_items"
        assert len(action["payload"]["items"]) == 1
        assert action["payload"]["items"][0]["source_ids"] == [source.source_id]
        assert action["preview"]["summary"].startswith("Для этой задачи")
        assert action["preview"]["batch"] == {"position": position, "total": 3}
    assert created.data["citations"][0]["source_version"] == source.source_version
    assert Issue.objects.filter(project=project).count() == issue_count


def test_work_decomposer_batch_review_is_partial_scoped_and_idempotent(api_client, agent_project):
    user, workspace, project, _, source = agent_project
    guest = UserFactory(
        username=f"batch-guest-{uuid.uuid4().hex}",
        email=f"batch-guest-{uuid.uuid4().hex}@plane.test",
    )
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    issue_count = Issue.objects.filter(project=project).count()
    run_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"

    api_client.force_authenticate(user=user)
    created = api_client.post(
        run_url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "options": {
                "goal": "Проверить частичное рассмотрение набора",
                "source_id": source.source_id,
            },
        },
        format="json",
    )
    action_ids = [action["id"] for action in created.data["actions"]]
    review_url = f"{run_url}{created.data['id']}/review/"
    first_batch = {
        "decisions": [
            {"action_id": action_ids[0], "decision": "approve"},
            {"action_id": action_ids[1], "decision": "reject"},
        ]
    }

    api_client.force_authenticate(user=guest)
    denied = api_client.post(review_url, first_batch, format="json")
    assert denied.status_code == 403
    assert denied.data["error"]["code"] == "BRAIN_WRITE_FORBIDDEN"

    api_client.force_authenticate(user=user)
    reviewed = api_client.post(review_url, first_batch, format="json")
    duplicate = api_client.post(review_url, first_batch, format="json")

    assert reviewed.status_code == 200
    assert duplicate.status_code == 200
    assert [action["status"] for action in reviewed.data["actions"]] == [
        PpmAgentActionStatus.APPROVED,
        PpmAgentActionStatus.REJECTED,
        PpmAgentActionStatus.PROPOSED,
    ]
    assert reviewed.data["action_summary"]["approved"] == 1
    assert reviewed.data["action_summary"]["rejected"] == 1
    assert reviewed.data["action_summary"]["remaining"] == 1
    assert reviewed.data["action_summary"]["partial"] is True
    assert reviewed.data["action_summary"]["review_complete"] is False
    assert reviewed.data["action_summary"]["canonical_changes_applied"] is False
    assert (
        PpmAgentAuditEvent.objects.filter(
            run_id=created.data["id"],
            event_type="actions_batch_reviewed",
        ).count()
        == 1
    )

    final = api_client.post(
        review_url,
        {"decisions": [{"action_id": action_ids[2], "decision": "reject"}]},
        format="json",
    )
    assert final.status_code == 200
    assert final.data["action_summary"]["approved"] == 1
    assert final.data["action_summary"]["rejected"] == 2
    assert final.data["action_summary"]["remaining"] == 0
    assert final.data["action_summary"]["partial"] is True
    assert final.data["action_summary"]["review_complete"] is True
    assert Issue.objects.filter(project=project).count() == issue_count


def test_work_decomposer_applies_only_approved_tasks_atomically_and_idempotently(api_client, agent_project, settings):
    user, workspace, project, _, source = agent_project
    settings.PPM_AGENTS_WRITE_ENABLED = False
    guest = UserFactory(
        username=f"apply-guest-{uuid.uuid4().hex}",
        email=f"apply-guest-{uuid.uuid4().hex}@plane.test",
    )
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    issue_count = Issue.objects.filter(project=project).count()
    run_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"

    api_client.force_authenticate(user=user)
    created = api_client.post(
        run_url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "options": {
                "goal": "Применить только выбранные задачи",
                "source_id": source.source_id,
            },
        },
        format="json",
    )
    action_ids = [action["id"] for action in created.data["actions"]]
    proposed_titles = [action["payload"]["items"][0]["title"] for action in created.data["actions"]]
    review_url = f"{run_url}{created.data['id']}/review/"
    reviewed = api_client.post(
        review_url,
        {
            "decisions": [
                {"action_id": action_ids[0], "decision": "approve"},
                {"action_id": action_ids[1], "decision": "reject"},
                {"action_id": action_ids[2], "decision": "approve"},
            ]
        },
        format="json",
    )
    assert reviewed.status_code == 200
    apply_url = f"{run_url}{created.data['id']}/apply/"

    disabled = api_client.post(apply_url, {"action_ids": [action_ids[0]]}, format="json")
    assert disabled.status_code == 503
    assert disabled.data["error"]["code"] == "AGENT_WRITES_DISABLED"
    assert Issue.objects.filter(project=project).count() == issue_count

    settings.PPM_AGENTS_WRITE_ENABLED = True
    api_client.force_authenticate(user=guest)
    denied = api_client.post(apply_url, {"action_ids": [action_ids[0]]}, format="json")
    assert denied.status_code == 403
    assert denied.data["error"]["code"] == "BRAIN_WRITE_FORBIDDEN"

    api_client.force_authenticate(user=user)
    first = api_client.post(apply_url, {"action_ids": [action_ids[0]]}, format="json")
    duplicate = api_client.post(apply_url, {"action_ids": [action_ids[0]]}, format="json")

    assert first.status_code == 200
    assert duplicate.status_code == 200
    assert first.data["status"] == PpmAgentRunStatus.AWAITING_APPROVAL
    assert first.data["actions"][0]["status"] == PpmAgentActionStatus.APPLIED
    assert first.data["actions"][0]["result"]["created_count"] == 1
    assert first.data["actions"][0]["result"]["issues"][0]["identifier"].startswith(f"{project.identifier}-")
    assert first.data["actions"][0]["result"]["issues"][0]["url"].startswith(
        f"/{workspace.slug}/browse/{project.identifier}-"
    )
    assert Issue.objects.filter(project=project, name=proposed_titles[0]).count() == 1
    assert Issue.objects.filter(project=project).count() == issue_count + 1

    not_approved = api_client.post(apply_url, {"action_ids": [action_ids[1]]}, format="json")
    assert not_approved.status_code == 400
    assert not_approved.data["error"]["code"] == "AGENT_ACTION_NOT_APPROVED"
    assert Issue.objects.filter(project=project).count() == issue_count + 1

    final = api_client.post(apply_url, {"action_ids": [action_ids[2]]}, format="json")
    assert final.status_code == 200
    assert final.data["status"] == PpmAgentRunStatus.COMPLETED
    assert final.data["finished_at"] is not None
    assert final.data["result"]["canonical_changes_applied"] is True
    assert final.data["result"]["applied_action_ids"] == [action_ids[0], action_ids[2]]
    assert Issue.objects.filter(project=project, name=proposed_titles[2]).count() == 1
    assert Issue.objects.filter(project=project, name=proposed_titles[1]).count() == 0
    assert Issue.objects.filter(project=project).count() == issue_count + 2
    assert PpmAgentAuditEvent.objects.filter(run_id=created.data["id"], event_type="action_applied").count() == 2
    assert PpmAgentAuditEvent.objects.filter(run_id=created.data["id"], event_type="actions_batch_applied").count() == 2


def test_work_decomposer_rechecks_source_before_apply(api_client, agent_project, settings):
    user, workspace, project, _, source = agent_project
    issue_count = Issue.objects.filter(project=project).count()
    run_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    settings.PPM_AGENTS_WRITE_ENABLED = True
    api_client.force_authenticate(user=user)
    created = api_client.post(
        run_url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "options": {
                "goal": "Не применять устаревшее предложение",
                "source_id": source.source_id,
            },
        },
        format="json",
    )
    action_id = created.data["actions"][0]["id"]
    approved = api_client.post(
        f"{run_url}{created.data['id']}/review/",
        {"decisions": [{"action_id": action_id, "decision": "approve"}]},
        format="json",
    )
    assert approved.status_code == 200

    source.source_version = "changed-after-approval"
    source.save(update_fields=["source_version", "updated_at"])
    blocked = api_client.post(
        f"{run_url}{created.data['id']}/apply/",
        {"action_ids": [action_id]},
        format="json",
    )

    assert blocked.status_code == 400
    assert blocked.data["error"]["code"] == "AGENT_ACTION_SOURCE_CHANGED"
    assert Issue.objects.filter(project=project).count() == issue_count
    action = PpmAgentRun.objects.get(id=created.data["id"]).actions.get(id=action_id)
    assert action.status == PpmAgentActionStatus.CONFLICT
    assert action.applied_at is None
    assert action.error_code == "AGENT_ACTION_SOURCE_CHANGED"
    assert PpmAgentAuditEvent.objects.filter(action=action, event_type="action_conflict").count() == 1


def test_agent_run_can_be_cancelled_and_retried_idempotently(api_client, agent_project):
    user, workspace, project, _, source = agent_project
    issue_count = Issue.objects.filter(project=project).count()
    run_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    options = {
        "goal": "Подготовить повторяемый безопасный запуск",
        "source_id": source.source_id,
    }

    api_client.force_authenticate(user=user)
    created = api_client.post(
        run_url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": options,
        },
        format="json",
    )
    cancel_url = f"{run_url}{created.data['id']}/cancel/"
    cancelled = api_client.post(cancel_url, {}, format="json")
    duplicate_cancel = api_client.post(cancel_url, {}, format="json")

    assert cancelled.status_code == 200
    assert duplicate_cancel.status_code == 200
    assert cancelled.data["status"] == PpmAgentRunStatus.CANCELLED
    assert cancelled.data["cancel_requested"] is True
    assert cancelled.data["finished_at"] is not None
    assert cancelled.data["actions"][0]["status"] == PpmAgentActionStatus.CANCELLED
    assert PpmAgentAuditEvent.objects.filter(run_id=created.data["id"], event_type="run_cancelled").count() == 1

    retry_operation_id = str(uuid.uuid4())
    retry_url = f"{run_url}{created.data['id']}/retry/"
    retry_payload = {"client_operation_id": retry_operation_id, "options": options}
    retried = api_client.post(retry_url, retry_payload, format="json")
    duplicate_retry = api_client.post(retry_url, retry_payload, format="json")

    assert retried.status_code == 201
    assert duplicate_retry.status_code == 200
    assert retried.data["id"] != created.data["id"]
    assert duplicate_retry.data["id"] == retried.data["id"]
    assert retried.data["status"] == PpmAgentRunStatus.AWAITING_APPROVAL
    assert retried.data["actions"][0]["status"] == PpmAgentActionStatus.PROPOSED
    assert (
        PpmAgentAuditEvent.objects.filter(
            run_id=retried.data["id"],
            event_type="run_retried_from",
            metadata_json__original_run_id=created.data["id"],
        ).count()
        == 1
    )
    assert Issue.objects.filter(project=project).count() == issue_count

    changed = api_client.post(
        retry_url,
        {
            "client_operation_id": str(uuid.uuid4()),
            "options": {**options, "goal": "Другая цель"},
        },
        format="json",
    )
    assert changed.status_code == 400
    assert changed.data["error"]["code"] == "AGENT_RETRY_INPUT_CHANGED"


@pytest.mark.django_db(transaction=True)
def test_agent_retry_stream_emits_linked_run_and_safe_progress(api_client, agent_project):
    user, workspace, project, _, source = agent_project
    issue_count = Issue.objects.filter(project=project).count()
    run_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    options = {
        "goal": "Повторить декомпозицию в живом потоке",
        "source_id": source.source_id,
    }
    api_client.force_authenticate(user=user)
    original = api_client.post(
        run_url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": options,
        },
        format="json",
    )
    api_client.post(f"{run_url}{original.data['id']}/cancel/", {}, format="json")
    retry_url = f"{run_url}{original.data['id']}/retry/stream/"
    retry_payload = {"client_operation_id": str(uuid.uuid4()), "options": options}

    response = api_client.post(retry_url, retry_payload, format="json")
    events = parse_sse_response(response)
    replay = api_client.post(retry_url, retry_payload, format="json")
    replay_events = parse_sse_response(replay)

    run_events = [data for event, data in events if event == "run"]
    progress_events = [data for event, data in events if event == "progress"]
    assert response.status_code == 201
    assert response["Content-Type"].startswith("text/event-stream")
    assert [run["status"] for run in run_events] == ["queued", "running", "awaiting_approval"]
    assert len({run["id"] for run in run_events}) == 1
    assert run_events[-1]["id"] != original.data["id"]
    assert [progress["tool"]["status"] for progress in progress_events[:2]] == ["running", "completed"]
    assert all(set(progress) == {"run_id", "call_id", "occurred_at", "tool"} for progress in progress_events)
    assert all(set(progress["tool"]) == {"name", "mode", "status", "result_count"} for progress in progress_events)
    assert replay.status_code == 200
    assert [(event, data["status"]) for event, data in replay_events] == [("run", "awaiting_approval")]
    assert replay_events[0][1]["id"] == run_events[-1]["id"]
    assert (
        PpmAgentAuditEvent.objects.filter(
            run_id=run_events[-1]["id"],
            event_type="run_retried_from",
            metadata_json__original_run_id=original.data["id"],
        ).count()
        == 1
    )
    assert Issue.objects.filter(project=project).count() == issue_count


def test_stale_agent_runs_time_out_safely_and_can_be_retried(api_client, agent_project):
    user, workspace, project, issue, source = agent_project
    issue_count = Issue.objects.filter(project=project).count()
    now = timezone.now()
    options = {
        "goal": "Проверить контролируемый тайм-аут",
        "source_id": source.source_id,
    }

    def create_running_run(*, with_action=False):
        run, _ = create_agent_run(
            workspace_id=workspace.id,
            project_id=project.id,
            user_id=user.id,
            agent_kind=PpmAgentKind.WORK_DECOMPOSER,
            client_operation_id=uuid.uuid4(),
            input_payload={"options": options},
            context={"locale": "ru"},
        )
        run = start_agent_run(run)
        if not with_action:
            return run, None
        action, _ = add_proposed_action(
            run=run,
            proposal_tool="propose_work_items",
            payload={
                "items": [
                    {
                        "title": "Не применять зависшее предложение",
                        "acceptance_criteria": ["Проект не изменён"],
                        "source_ids": [source.source_id],
                    }
                ]
            },
            preview={"title": "Черновик до тайм-аута"},
            citations=[
                {
                    "source_type": source.source_type,
                    "source_id": source.source_id,
                    "source_version": source.source_version,
                    "locator": {"identifier": f"{project.identifier}-{issue.sequence_id}"},
                }
            ],
            idempotency_key=uuid.uuid4(),
        )
        return run, action

    stale_running, stale_action = create_running_run(with_action=True)
    fresh_running, _ = create_running_run()
    awaiting_approval, _ = create_running_run(with_action=True)
    awaiting_approval = finish_agent_run(awaiting_approval, result={"kind": "work_decomposition"})
    queued, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.WORK_DECOMPOSER,
        client_operation_id=uuid.uuid4(),
        input_payload={"options": options},
        context={"locale": "ru"},
    )
    stale_at = now - timedelta(seconds=61)
    PpmAgentRun.objects.filter(id=stale_running.id).update(
        started_at=stale_at,
        lease_token=None,
        lease_expires_at=None,
        worker_task_id="",
        updated_at=stale_at,
    )
    PpmAgentRun.objects.filter(id=queued.id).update(created_at=stale_at, updated_at=stale_at)
    PpmAgentRun.objects.filter(id=awaiting_approval.id).update(started_at=stale_at, updated_at=stale_at)

    expired = expire_stale_agent_runs(
        now=now,
        timeout_seconds=60,
        workspace_id=workspace.id,
        project_id=project.id,
        created_by=user.id,
    )
    duplicate_expired = expire_stale_agent_runs(
        now=now,
        timeout_seconds=60,
        workspace_id=workspace.id,
        project_id=project.id,
        created_by=user.id,
    )

    stale_running.refresh_from_db()
    stale_action.refresh_from_db()
    fresh_running.refresh_from_db()
    awaiting_approval.refresh_from_db()
    queued.refresh_from_db()
    assert expired == 2
    assert duplicate_expired == 0
    assert stale_running.status == PpmAgentRunStatus.TIMED_OUT
    assert stale_running.error_code == "AGENT_RUN_TIMED_OUT"
    assert stale_running.finished_at == now
    assert stale_action.status == PpmAgentActionStatus.CANCELLED
    assert stale_action.error_code == "AGENT_RUN_TIMED_OUT"
    assert queued.status == PpmAgentRunStatus.TIMED_OUT
    assert fresh_running.status == PpmAgentRunStatus.RUNNING
    assert awaiting_approval.status == PpmAgentRunStatus.AWAITING_APPROVAL
    assert PpmAgentAuditEvent.objects.filter(run=stale_running, event_type="run_timed_out").count() == 1
    assert PpmAgentAuditEvent.objects.filter(action=stale_action, event_type="action_timed_out").count() == 1

    api_client.force_authenticate(user=user)
    run_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    retried = api_client.post(
        f"{run_url}{stale_running.id}/retry/",
        {"client_operation_id": str(uuid.uuid4()), "options": options},
        format="json",
    )
    assert retried.status_code == 201
    assert retried.data["status"] == PpmAgentRunStatus.AWAITING_APPROVAL
    assert Issue.objects.filter(project=project).count() == issue_count


def test_knowledge_librarian_applies_approved_markdown_note_idempotently(api_client, agent_project, settings):
    user, workspace, project, _, _ = agent_project
    settings.PPM_AGENTS_WRITE_ENABLED = True
    vault = get_or_create_project_vault(workspace_id=workspace.id, project_id=project.id, user_id=user.id)
    entry = create_markdown(
        vault=vault,
        parent_id=None,
        name="Архитектура.md",
        content="# Архитектура\nПроект хранит знания в Markdown.",
        user_id=user.id,
    )
    source, job = request_source_index(
        workspace_id=workspace.id,
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.VAULT_FILE,
        source_id=entry.id,
        requested_by=user.id,
    )
    process_index_job(job.id, worker_id="knowledge-librarian-test")
    source.refresh_from_db()
    entry_count = PpmVaultEntry.objects.filter(project_id=project.id).count()
    version_count = entry.versions.count()
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"

    api_client.force_authenticate(user=user)
    created = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.KNOWLEDGE_LIBRARIAN,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": {
                "topic": "Описать правила резервного копирования",
                "source_id": source.source_id,
            },
        },
        format="json",
    )

    assert created.status_code == 201
    assert created.data["status"] == PpmAgentRunStatus.AWAITING_APPROVAL
    assert created.data["result"]["kind"] == "knowledge_proposal"
    assert created.data["result"]["canonical_changes_applied"] is False
    action = created.data["actions"][0]
    assert action["proposal_tool"] == "propose_page_or_vault_note"
    assert action["payload"]["target"] == "vault_markdown"
    assert "Описать правила резервного копирования" in action["payload"]["body"]
    assert action["payload"]["source_ids"] == [source.source_id]
    assert created.data["citations"][0]["locator"] == {
        "kind": "vault_markdown",
        "path": "Архитектура.md",
    }

    review_url = (
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/actions/{action['id']}/review/"
    )
    approved = api_client.post(review_url, {"decision": "approve"}, format="json")

    assert approved.status_code == 200
    assert approved.data["actions"][0]["status"] == PpmAgentActionStatus.APPROVED
    assert PpmVaultEntry.objects.filter(project_id=project.id).count() == entry_count

    apply_url = f"{url}{created.data['id']}/apply/"
    applied = api_client.post(apply_url, {"action_ids": [action["id"]]}, format="json")
    duplicate = api_client.post(apply_url, {"action_ids": [action["id"]]}, format="json")

    assert applied.status_code == 200
    assert duplicate.status_code == 200
    assert applied.data["status"] == PpmAgentRunStatus.COMPLETED
    assert applied.data["result"]["canonical_changes_applied"] is True
    apply_tool_events = [
        event["tool"]
        for event in applied.data["audit_trace"]
        if event.get("tool", {}).get("name") == "write_vault_file_from_action"
    ]
    assert apply_tool_events == [
        {"name": "write_vault_file_from_action", "mode": "apply", "status": "completed", "result_count": 1}
    ]
    applied_action = applied.data["actions"][0]
    assert applied_action["status"] == PpmAgentActionStatus.APPLIED
    assert applied_action["result"]["created_count"] == 1
    assert len(applied_action["result"]["vault_entries"]) == 1
    result_entry = applied_action["result"]["vault_entries"][0]
    assert result_entry["name"] == f"{action['payload']['title']}.md"
    assert result_entry["version"] == 1
    assert result_entry["url"] == (f"/{workspace.slug}/projects/{project.id}/knowledge?entry_id={result_entry['id']}")
    assert PpmVaultEntry.objects.filter(project_id=project.id).count() == entry_count + 1
    created_entry = PpmVaultEntry.objects.get(id=result_entry["id"])
    assert created_entry.current_version.content_text == action["payload"]["body"]
    assert duplicate.data["actions"][0]["result"] == applied_action["result"]
    assert (
        PpmAgentAuditEvent.objects.filter(
            action_id=action["id"],
            event_type="action_applied",
        ).count()
        == 1
    )

    conflicting_run = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.KNOWLEDGE_LIBRARIAN,
            "client_operation_id": str(uuid.uuid4()),
            "context": {"locale": "ru"},
            "options": {
                "topic": "Описать правила резервного копирования",
                "source_id": source.source_id,
            },
        },
        format="json",
    )
    conflicting_action = conflicting_run.data["actions"][0]
    conflicting_review_url = (
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/actions/"
        f"{conflicting_action['id']}/review/"
    )
    assert api_client.post(conflicting_review_url, {"decision": "approve"}, format="json").status_code == 200
    conflict = api_client.post(
        f"{url}{conflicting_run.data['id']}/apply/",
        {"action_ids": [conflicting_action["id"]]},
        format="json",
    )
    assert conflict.status_code == 400
    assert conflict.data["error"]["code"] == "VAULT_NAME_CONFLICT"
    assert PpmAgentAction.objects.get(id=conflicting_action["id"]).status == PpmAgentActionStatus.CONFLICT
    assert (
        PpmAgentAuditEvent.objects.filter(
            action_id=conflicting_action["id"],
            event_type="action_conflict",
        ).count()
        == 1
    )
    assert PpmVaultEntry.objects.filter(project_id=project.id).count() == entry_count + 1
    created_entry.refresh_from_db()
    assert created_entry.current_version.content_text == action["payload"]["body"]

    entry.refresh_from_db()
    assert entry.versions.count() == version_count
    assert entry.current_version.content_text == "# Архитектура\nПроект хранит знания в Markdown."


def test_relationship_analyst_applies_confirmed_edge_idempotently(api_client, agent_project, settings):
    user, workspace, project, issue, issue_source = agent_project
    settings.PPM_AGENTS_WRITE_ENABLED = True
    vault = get_or_create_project_vault(workspace_id=workspace.id, project_id=project.id, user_id=user.id)
    entry = create_markdown(
        vault=vault,
        parent_id=None,
        name="Основание.md",
        content="# Основание\nМатериал объясняет проверку предложений.",
        user_id=user.id,
    )
    vault_source, vault_job = request_source_index(
        workspace_id=workspace.id,
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.VAULT_FILE,
        source_id=entry.id,
        requested_by=user.id,
    )
    process_index_job(vault_job.id, worker_id="relationship-analyst-test")
    vault_source.refresh_from_db()
    canvas = get_or_create_active_canvas(workspace_id=workspace.id, project_id=project.id, user_id=user.id)
    board = canvas.default_board
    from_shape_id = "shape:knowledge"
    to_shape_id = "shape:work"
    board, _, _ = save_canvas_snapshot(
        board=board,
        user_id=user.id,
        request_id=uuid.uuid4(),
        base_version=0,
        schema_version=2,
        snapshot={
            "document": {
                "store": {
                    from_shape_id: {"id": from_shape_id, "typeName": "shape", "type": "ppm-canvas-node"},
                    to_shape_id: {"id": to_shape_id, "typeName": "shape", "type": "ppm-canvas-node"},
                }
            },
            "session": {},
        },
        client_operation_id=uuid.uuid4(),
    )
    PpmCanvasBinding.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        canvas=canvas,
        board=board,
        shape_id=from_shape_id,
        entity_type=PpmCanvasEntityType.VAULT_FILE,
        entity_id=entry.id,
        status=PpmCanvasBindingStatus.ACTIVE,
        source_version=str(entry.version),
        client_operation_id=uuid.uuid4(),
        operation_fingerprint="a" * 64,
        created_by=user.id,
    )
    PpmCanvasBinding.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        canvas=canvas,
        board=board,
        shape_id=to_shape_id,
        entity_type=PpmCanvasEntityType.WORK_ITEM,
        entity_id=issue.id,
        status=PpmCanvasBindingStatus.ACTIVE,
        source_version=issue_source.source_version,
        client_operation_id=uuid.uuid4(),
        operation_fingerprint="b" * 64,
        created_by=user.id,
    )
    edge_count = PpmCanvasSemanticEdge.objects.filter(project_id=project.id).count()
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"

    api_client.force_authenticate(user=user)
    created = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.RELATIONSHIP_ANALYST,
            "client_operation_id": str(uuid.uuid4()),
            "context": {
                "canvas_id": str(board.id),
                "locale": "ru",
                "selected_shape_ids": [from_shape_id, to_shape_id],
            },
            "options": {
                "from_shape_id": from_shape_id,
                "to_shape_id": to_shape_id,
                "relation": "explains",
                "reason": "Материал описывает основание для выполнения задачи.",
            },
        },
        format="json",
    )

    assert created.status_code == 201
    assert created.data["status"] == PpmAgentRunStatus.AWAITING_APPROVAL
    assert created.data["result"]["kind"] == "semantic_edge_proposal"
    assert created.data["result"]["canonical_changes_applied"] is False
    action = created.data["actions"][0]
    assert action["proposal_tool"] == "propose_semantic_edges"
    assert action["payload"]["edges"][0]["relation"] == "explains"
    assert set(action["payload"]["edges"][0]["source_ids"]) == {
        issue_source.source_id,
        vault_source.source_id,
    }
    assert PpmCanvasSemanticEdge.objects.filter(project_id=project.id).count() == edge_count

    review_url = (
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/actions/{action['id']}/review/"
    )
    approved = api_client.post(review_url, {"decision": "approve"}, format="json")

    assert approved.status_code == 200
    assert approved.data["actions"][0]["status"] == PpmAgentActionStatus.APPROVED
    assert PpmCanvasSemanticEdge.objects.filter(project_id=project.id).count() == edge_count

    apply_url = f"{url}{created.data['id']}/apply/"
    applied = api_client.post(apply_url, {"action_ids": [action["id"]]}, format="json")
    duplicate = api_client.post(apply_url, {"action_ids": [action["id"]]}, format="json")

    assert applied.status_code == 200
    assert duplicate.status_code == 200
    assert applied.data["status"] == PpmAgentRunStatus.COMPLETED
    assert applied.data["result"]["canonical_changes_applied"] is True
    applied_action = applied.data["actions"][0]
    assert applied_action["status"] == PpmAgentActionStatus.APPLIED
    assert applied_action["result"]["created_count"] == 1
    result_edge = applied_action["result"]["semantic_edges"][0]
    assert result_edge["board_id"] == str(board.id)
    assert result_edge["relation_type"] == "explains"
    assert result_edge["confirmation_status"] == PpmSemanticEdgeConfirmationStatus.CONFIRMED
    assert result_edge["origin"] == PpmSemanticEdgeOrigin.AGENT
    assert result_edge["reason"] == "Материал описывает основание для выполнения задачи."
    assert result_edge["url"] == f"/{workspace.slug}/projects/{project.id}/brain?board_id={board.id}"
    assert PpmCanvasSemanticEdge.objects.filter(project_id=project.id).count() == edge_count + 1
    edge = PpmCanvasSemanticEdge.objects.get(id=result_edge["edge_id"])
    assert edge.confirmed_by == user.id
    assert edge.confirmed_at is not None
    assert duplicate.data["actions"][0]["result"] == applied_action["result"]

    stale_run = api_client.post(
        url,
        {
            "agent_kind": PpmAgentKind.RELATIONSHIP_ANALYST,
            "client_operation_id": str(uuid.uuid4()),
            "context": {
                "canvas_id": str(board.id),
                "locale": "ru",
                "selected_shape_ids": [from_shape_id, to_shape_id],
            },
            "options": {
                "from_shape_id": from_shape_id,
                "to_shape_id": to_shape_id,
                "relation": "depends_on",
                "reason": "Проверяем изменение версии доски перед применением.",
            },
        },
        format="json",
    )
    stale_action = stale_run.data["actions"][0]
    stale_review_url = (
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/actions/"
        f"{stale_action['id']}/review/"
    )
    assert api_client.post(stale_review_url, {"decision": "approve"}, format="json").status_code == 200
    board, _, _ = save_canvas_snapshot(
        board=board,
        user_id=user.id,
        request_id=uuid.uuid4(),
        base_version=board.current_version,
        schema_version=2,
        snapshot={
            "document": {
                "store": {
                    from_shape_id: {"id": from_shape_id, "typeName": "shape", "type": "ppm-canvas-node"},
                    to_shape_id: {"id": to_shape_id, "typeName": "shape", "type": "ppm-canvas-node"},
                }
            },
            "session": {},
        },
        client_operation_id=uuid.uuid4(),
    )
    conflict = api_client.post(
        f"{url}{stale_run.data['id']}/apply/",
        {"action_ids": [stale_action["id"]]},
        format="json",
    )
    assert conflict.status_code == 400
    assert conflict.data["error"]["code"] == "AGENT_ACTION_BOARD_CHANGED"
    assert PpmAgentAction.objects.get(id=stale_action["id"]).status == PpmAgentActionStatus.CONFLICT
    assert PpmCanvasSemanticEdge.objects.filter(project_id=project.id).count() == edge_count + 1


def test_agent_action_review_requires_edit_access_and_never_applies_tasks(api_client, agent_project):
    user, workspace, project, _, source = agent_project
    guest = UserFactory(
        username=f"agent-guest-{uuid.uuid4().hex}",
        email=f"agent-guest-{uuid.uuid4().hex}@plane.test",
    )
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    issue_count = Issue.objects.filter(project=project).count()
    run_url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"

    api_client.force_authenticate(user=user)
    created = api_client.post(
        run_url,
        {
            "agent_kind": PpmAgentKind.WORK_DECOMPOSER,
            "client_operation_id": str(uuid.uuid4()),
            "options": {"goal": "Проверить разграничение прав", "source_id": source.source_id},
        },
        format="json",
    )
    action_id = created.data["actions"][0]["id"]
    review_url = (
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/actions/{action_id}/review/"
    )

    api_client.force_authenticate(user=guest)
    denied = api_client.post(review_url, {"decision": "approve"}, format="json")
    assert denied.status_code == 403
    assert denied.data["error"]["code"] == "BRAIN_WRITE_FORBIDDEN"

    api_client.force_authenticate(user=user)
    approved = api_client.post(review_url, {"decision": "approve"}, format="json")
    duplicate = api_client.post(review_url, {"decision": "approve"}, format="json")

    assert approved.status_code == 200
    assert duplicate.status_code == 200
    assert approved.data["actions"][0]["status"] == PpmAgentActionStatus.APPROVED
    assert approved.data["actions"][0]["approved_by"] == str(user.id)
    assert approved.data["result"]["canonical_changes_applied"] is False
    assert Issue.objects.filter(project=project).count() == issue_count

    cancel_url = f"{run_url}{created.data['id']}/cancel/"
    cannot_cancel = api_client.post(cancel_url, {}, format="json")
    assert cannot_cancel.status_code == 400
    assert cannot_cancel.data["error"]["code"] == "AGENT_RUN_ALREADY_REVIEWED"


def test_project_reporter_run_is_private_and_request_schema_is_strict(api_client, agent_project):
    user, workspace, project, _, _ = agent_project
    outsider = UserFactory(
        username=f"report-outsider-{uuid.uuid4().hex}",
        email=f"report-outsider-{uuid.uuid4().hex}@plane.test",
    )
    url = f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/knowledge/agents/runs/"
    payload = {
        "agent_kind": PpmAgentKind.PROJECT_REPORTER,
        "client_operation_id": str(uuid.uuid4()),
        "options": {},
    }
    api_client.force_authenticate(user=user)
    created = api_client.post(url, payload, format="json")
    detail_url = f"{url}{created.data['id']}/"

    api_client.force_authenticate(user=outsider)
    denied = api_client.get(detail_url)
    assert denied.status_code == 403

    api_client.force_authenticate(user=user)
    forbidden_field = api_client.post(
        url,
        {**payload, "client_operation_id": str(uuid.uuid4()), "capabilities": ["apply_semantic_edges"]},
        format="json",
    )
    unavailable_agent = api_client.post(
        url,
        {
            "agent_kind": "unknown_agent",
            "client_operation_id": str(uuid.uuid4()),
        },
        format="json",
    )

    assert forbidden_field.status_code == 400
    assert forbidden_field.data["error"]["code"] == "AGENT_REQUEST_FIELD_FORBIDDEN"
    assert unavailable_agent.status_code == 400
    assert unavailable_agent.data["error"]["code"] == "AGENT_RUNNER_NOT_READY"


def test_tool_schema_rejects_unknown_fields_and_out_of_range_values():
    with pytest.raises(PpmAgentRegistryError) as unknown:
        validate_agent_tool_call(
            agent_kind=PpmAgentKind.PROJECT_REPORTER,
            tool_name="list_work_items",
            payload={"limit": 10, "system_override": "ignore policy"},
        )
    assert unknown.value.code == "AGENT_TOOL_PAYLOAD_INVALID"
    assert unknown.value.details["path"] == "$"

    with pytest.raises(PpmAgentRegistryError) as depth:
        validate_agent_tool_call(
            agent_kind=PpmAgentKind.RELATIONSHIP_ANALYST,
            tool_name="read_canvas_neighborhood",
            payload={"board_id": str(uuid.uuid4()), "shape_ids": ["shape:1"], "depth": 99},
        )
    assert depth.value.code == "AGENT_TOOL_PAYLOAD_INVALID"
    assert depth.value.details["path"] == "$.depth"


def test_agent_run_is_idempotent_and_does_not_persist_raw_input(agent_project):
    user, workspace, project, _, _ = agent_project
    operation_id = uuid.uuid4()
    raw_marker = "RAW-REQUEST-MUST-NOT-BE-STORED"

    run, created = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=operation_id,
        input_payload={"request": raw_marker},
        context={"locale": "ru", "selected_shape_ids": ["shape:2", "shape:1"]},
    )
    duplicate, duplicate_created = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.PROJECT_REPORTER,
        client_operation_id=operation_id,
        input_payload={"request": raw_marker},
        context={"locale": "ru", "selected_shape_ids": ["shape:1", "shape:2"]},
    )

    assert created is True
    assert duplicate_created is False
    assert duplicate.id == run.id
    assert raw_marker not in str(run.context_json)
    assert raw_marker not in str(run.result_json)
    assert len(run.input_hash) == 64
    assert run.context_json["selected_shape_ids"] == ["shape:1", "shape:2"]
    assert PpmAgentAuditEvent.objects.filter(run=run, event_type="run_created").count() == 1

    with pytest.raises(PpmAgentActionError) as conflict:
        create_agent_run(
            workspace_id=workspace.id,
            project_id=project.id,
            user_id=user.id,
            agent_kind=PpmAgentKind.PROJECT_REPORTER,
            client_operation_id=operation_id,
            input_payload={"request": "другой запрос"},
            context={"locale": "ru"},
        )
    assert conflict.value.code == "AGENT_OPERATION_CONFLICT"


def test_client_cannot_add_capabilities_to_server_context(agent_project):
    user, workspace, project, _, _ = agent_project

    with pytest.raises(PpmAgentActionError) as exc_info:
        create_agent_run(
            workspace_id=workspace.id,
            project_id=project.id,
            user_id=user.id,
            agent_kind=PpmAgentKind.WORK_DECOMPOSER,
            client_operation_id=uuid.uuid4(),
            input_payload={},
            context={"locale": "ru", "capabilities": ["create_pull_request_from_action"]},
        )
    assert exc_info.value.code == "AGENT_CONTEXT_FIELD_FORBIDDEN"
    assert exc_info.value.details == {"fields": ["capabilities"]}


def test_proposal_and_approval_do_not_apply_canonical_mutation(agent_project):
    user, workspace, project, issue, source = agent_project
    issue_count = Issue.objects.filter(project=project).count()
    run, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.WORK_DECOMPOSER,
        client_operation_id=uuid.uuid4(),
        input_payload={"goal": "Разбить проверку на этапы"},
        context={"locale": "ru"},
    )
    run = start_agent_run(run)
    action, created = add_proposed_action(
        run=run,
        proposal_tool="propose_work_items",
        payload={
            "items": [
                {
                    "title": "Проверить первый этап",
                    "description": "Черновик задачи, который ещё не применён.",
                    "acceptance_criteria": ["Результат приложен к проекту"],
                    "source_ids": [source.source_id],
                }
            ]
        },
        preview={
            "title": "Будет создана 1 задача",
            "changes": [{"field": "name", "after": "Проверить первый этап"}],
        },
        citations=[
            {
                "source_type": source.source_type,
                "source_id": source.source_id,
                "source_version": source.source_version,
                "locator": {"identifier": f"{project.identifier}-{issue.sequence_id}"},
            }
        ],
        idempotency_key=uuid.uuid4(),
    )
    run = finish_agent_run(run, result={"summary": "Подготовлено одно предложение."})

    assert created is True
    assert run.status == PpmAgentRunStatus.AWAITING_APPROVAL
    assert action.status == PpmAgentActionStatus.PROPOSED
    assert Issue.objects.filter(project=project).count() == issue_count
    citation = PpmAgentCitation.objects.get(action=action)
    assert citation.source_version == source.source_version
    assert action.preconditions_json["project_id"] == str(project.id)

    approved, reviewed = review_agent_action(action=action, user_id=user.id, approve=True)
    duplicate, duplicate_reviewed = review_agent_action(action=approved, user_id=user.id, approve=True)

    assert reviewed is True
    assert duplicate_reviewed is False
    assert duplicate.id == action.id
    assert approved.status == PpmAgentActionStatus.APPROVED
    assert approved.applied_at is None
    assert approved.result_json == {}
    assert Issue.objects.filter(project=project).count() == issue_count
    assert PpmAgentAuditEvent.objects.filter(action=action, event_type="action_approved").count() == 1


def test_foreign_or_stale_source_cannot_back_proposal(agent_project):
    user, workspace, project, _, source = agent_project
    run, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.WORK_DECOMPOSER,
        client_operation_id=uuid.uuid4(),
        input_payload={"goal": "Проверка источников"},
        context={},
    )
    run = start_agent_run(run)
    payload = {
        "items": [
            {
                "title": "Проверить источник",
                "acceptance_criteria": ["Источник актуален"],
                "source_ids": [source.source_id],
            }
        ]
    }

    with pytest.raises(PpmAgentActionError) as stale:
        add_proposed_action(
            run=run,
            proposal_tool="propose_work_items",
            payload=payload,
            preview={"title": "Черновик"},
            citations=[
                {
                    "source_type": source.source_type,
                    "source_id": source.source_id,
                    "source_version": "stale-version",
                }
            ],
            idempotency_key=uuid.uuid4(),
        )
    assert stale.value.code == "AGENT_CITATION_STALE"

    foreign_workspace = WorkspaceFactory(owner=user)
    foreign_project = ProjectFactory(workspace=foreign_workspace, identifier=f"FOR{uuid.uuid4().hex[:5].upper()}")
    source.project_id = foreign_project.id
    source.workspace_id = foreign_workspace.id
    source.save(update_fields=["workspace_id", "project_id", "updated_at"])

    with pytest.raises(PpmAgentActionError) as foreign:
        add_proposed_action(
            run=run,
            proposal_tool="propose_work_items",
            payload=payload,
            preview={"title": "Черновик"},
            citations=[{"source_type": source.source_type, "source_id": source.source_id}],
            idempotency_key=uuid.uuid4(),
        )
    assert foreign.value.code == "AGENT_CITATION_NOT_READY"

    assert PpmAgentRun.objects.filter(project_id=project.id).count() == 1


def test_source_version_is_rechecked_before_approval(agent_project):
    user, workspace, project, _, source = agent_project
    run, _ = create_agent_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        agent_kind=PpmAgentKind.WORK_DECOMPOSER,
        client_operation_id=uuid.uuid4(),
        input_payload={"goal": "Проверить актуальность"},
        context={},
    )
    run = start_agent_run(run)
    action, _ = add_proposed_action(
        run=run,
        proposal_tool="propose_work_items",
        payload={
            "items": [
                {
                    "title": "Проверить актуальность",
                    "acceptance_criteria": ["Источник не изменён"],
                    "source_ids": [source.source_id],
                }
            ]
        },
        preview={"title": "Будет создана 1 задача"},
        citations=[
            {
                "source_type": source.source_type,
                "source_id": source.source_id,
                "source_version": source.source_version,
            }
        ],
        idempotency_key=uuid.uuid4(),
    )
    finish_agent_run(run)
    source.source_version = "new-version-after-preview"
    source.save(update_fields=["source_version", "updated_at"])

    with pytest.raises(PpmAgentActionError) as exc_info:
        review_agent_action(action=action, user_id=user.id, approve=True)

    assert exc_info.value.code == "AGENT_ACTION_SOURCE_CHANGED"
    action.refresh_from_db()
    assert action.status == PpmAgentActionStatus.PROPOSED
    assert action.approved_by is None
