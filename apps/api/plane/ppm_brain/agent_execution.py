from threading import Event, Thread

from django.conf import settings
from django.db import close_old_connections

from .agent_actions import (
    PpmAgentActionError,
    claim_agent_run,
    fail_agent_run,
    renew_agent_run_lease,
    start_agent_run,
)
from .agent_decomposer import normalize_work_decomposer_options, run_work_decomposer
from .agent_librarian import normalize_knowledge_librarian_options, run_knowledge_librarian
from .agent_relationships import normalize_relationship_analyst_options, run_relationship_analyst
from .agent_reporter import normalize_project_reporter_options, run_project_reporter
from .models import PpmAgentKind, PpmAgentRun


class _AgentRunLeaseHeartbeat:
    def __init__(self, run):
        self.run = run
        lease_seconds = int(getattr(settings, "PPM_AGENT_LEASE_SECONDS", 180))
        self.interval_seconds = max(10, min(60, lease_seconds // 3))
        self.stop_event = Event()
        self.thread = Thread(
            target=self._heartbeat,
            name=f"ppm-agent-lease-{run.id}",
            daemon=True,
        )

    def _heartbeat(self):
        close_old_connections()
        try:
            while not self.stop_event.wait(self.interval_seconds):
                try:
                    _, renewed = renew_agent_run_lease(self.run)
                except Exception:
                    return
                if not renewed:
                    return
        finally:
            close_old_connections()

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.stop_event.set()
        self.thread.join(timeout=2)
        return False


def normalize_agent_options(agent_kind, options):
    if agent_kind == PpmAgentKind.PROJECT_REPORTER:
        return normalize_project_reporter_options(options)
    if agent_kind == PpmAgentKind.WORK_DECOMPOSER:
        return normalize_work_decomposer_options(options)
    if agent_kind == PpmAgentKind.KNOWLEDGE_LIBRARIAN:
        return normalize_knowledge_librarian_options(options)
    if agent_kind == PpmAgentKind.RELATIONSHIP_ANALYST:
        return normalize_relationship_analyst_options(options)
    raise PpmAgentActionError(
        code="AGENT_RUNNER_NOT_READY",
        message="Этот проектный агент ещё не подключён к безопасному исполнителю.",
    )


def execute_started_agent_run(*, run, agent_kind, options, progress_callback=None):
    try:
        if agent_kind == PpmAgentKind.PROJECT_REPORTER:
            return run_project_reporter(run=run, options=options, progress_callback=progress_callback)
        if agent_kind == PpmAgentKind.WORK_DECOMPOSER:
            return run_work_decomposer(run=run, options=options, progress_callback=progress_callback)
        if agent_kind == PpmAgentKind.KNOWLEDGE_LIBRARIAN:
            return run_knowledge_librarian(run=run, options=options, progress_callback=progress_callback)
        if agent_kind == PpmAgentKind.RELATIONSHIP_ANALYST:
            return run_relationship_analyst(run=run, options=options, progress_callback=progress_callback)
        raise PpmAgentActionError(
            code="AGENT_RUNNER_NOT_READY",
            message="Этот проектный агент ещё не подключён к безопасному исполнителю.",
        )
    except PpmAgentActionError as exc:
        fail_agent_run(run, error_code=exc.code, error_message=exc.message)
        raise
    except Exception:
        fail_agent_run(
            run,
            error_code="AGENT_RUN_FAILED",
            error_message="Не удалось выполнить проектного агента.",
        )
        raise


def execute_agent_run(*, run, agent_kind, options, progress_callback=None):
    return execute_started_agent_run(
        run=start_agent_run(run),
        agent_kind=agent_kind,
        options=options,
        progress_callback=progress_callback,
    )


def execute_queued_agent_run(run_id, *, worker_id=""):
    run, claimed = claim_agent_run(PpmAgentRun(id=run_id), worker_id=worker_id)
    if not claimed:
        return run, False
    try:
        input_payload = run.input_json if isinstance(run.input_json, dict) else {}
        options = normalize_agent_options(run.agent_kind, input_payload.get("options") or {})
    except PpmAgentActionError as exc:
        fail_agent_run(run, error_code=exc.code, error_message=exc.message)
        raise
    with _AgentRunLeaseHeartbeat(run):
        return (
            execute_started_agent_run(
                run=run,
                agent_kind=run.agent_kind,
                options=options,
            ),
            True,
        )
