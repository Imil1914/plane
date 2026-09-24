from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from plane.db.models import Project

from .answers import process_answer_run
from .agent_actions import PpmAgentActionError, expire_stale_agent_runs
from .agent_execution import execute_queued_agent_run
from .flags import agents_enabled, answers_enabled, brain_enabled
from .models import (
    PpmAgentRun,
    PpmAgentRunStatus,
    PpmAnswerRun,
    PpmAnswerRunStatus,
    PpmIndexJob,
    PpmIndexJobStatus,
    TERMINAL_ANSWER_RUN_STATUSES,
)
from .services import PpmBrainConflict, process_index_job, reconcile_project


@shared_task(bind=True, soft_time_limit=120, time_limit=150, max_retries=5)
def process_brain_index_job_task(self, job_id):
    if not brain_enabled():
        return
    try:
        job = process_index_job(job_id, worker_id=f"celery:{self.request.id}")
    except PpmBrainConflict:
        return
    if job.status == PpmIndexJobStatus.RETRY:
        delay = max(1, int((job.available_at - timezone.now()).total_seconds())) if job.available_at else 60
        raise self.retry(countdown=min(delay, 3600))


@shared_task(soft_time_limit=90, time_limit=120)
def process_brain_answer_run_task(run_id):
    if not answers_enabled():
        return
    try:
        process_answer_run(run_id)
    except PpmBrainConflict:
        return
    except Exception:
        now = timezone.now()
        PpmAnswerRun.objects.filter(id=run_id).exclude(status__in=TERMINAL_ANSWER_RUN_STATUSES).update(
            status=PpmAnswerRunStatus.FAILED,
            error_code="ANSWER_RUN_FAILED",
            error_message="Не удалось подготовить ответ. Источники проекта не изменены.",
            finished_at=now,
            updated_at=now,
        )
        raise


@shared_task(bind=True, soft_time_limit=120, time_limit=150, acks_late=True, reject_on_worker_lost=True)
def process_brain_agent_run_task(self, run_id):
    if not agents_enabled():
        return {"run_id": str(run_id), "status": "disabled", "claimed": False}
    try:
        run, claimed = execute_queued_agent_run(run_id, worker_id=self.request.id)
    except PpmAgentRun.DoesNotExist:
        return {"run_id": str(run_id), "status": "missing", "claimed": False}
    except PpmAgentActionError as exc:
        run = PpmAgentRun.objects.filter(id=run_id).first()
        return {
            "run_id": str(run_id),
            "status": run.status if run else "missing",
            "claimed": exc.code != "AGENT_RUN_LEASE_LOST",
        }
    return {"run_id": str(run.id), "status": run.status, "claimed": claimed}


def dispatch_agent_run(run_id):
    if getattr(settings, "PPM_AGENT_TASK_ALWAYS_EAGER", False):
        return process_brain_agent_run_task.apply(args=[str(run_id)])
    return process_brain_agent_run_task.delay(str(run_id))


@shared_task
def recover_brain_index_jobs():
    if not brain_enabled():
        return
    now = timezone.now()
    jobs = PpmIndexJob.objects.filter(
        Q(status=PpmIndexJobStatus.PENDING)
        | Q(status=PpmIndexJobStatus.RETRY, available_at__lte=now)
        | Q(status=PpmIndexJobStatus.RUNNING, lease_expires_at__lte=now)
    ).values_list("id", flat=True)
    for job_id in jobs.iterator(chunk_size=100):
        process_brain_index_job_task.delay(str(job_id))


@shared_task
def expire_stale_agent_runs_task():
    if not agents_enabled():
        return 0
    return expire_stale_agent_runs()


@shared_task
def recover_queued_agent_runs_task():
    if not agents_enabled():
        return 0
    now = timezone.now()
    legacy_cutoff = now - timedelta(seconds=getattr(settings, "PPM_AGENT_LEASE_SECONDS", 180))
    run_ids = list(
        PpmAgentRun.objects.filter(
            Q(status=PpmAgentRunStatus.QUEUED)
            | Q(status=PpmAgentRunStatus.RUNNING, lease_expires_at__lte=now)
            | Q(
                status=PpmAgentRunStatus.RUNNING,
                lease_expires_at__isnull=True,
                started_at__lte=legacy_cutoff,
            )
            | Q(
                status=PpmAgentRunStatus.RUNNING,
                lease_expires_at__isnull=True,
                started_at__isnull=True,
                created_at__lte=legacy_cutoff,
            )
        )
        .order_by("created_at")
        .values_list("id", flat=True)[:500]
    )
    for run_id in run_ids:
        process_brain_agent_run_task.delay(str(run_id))
    return len(run_ids)


@shared_task
def reconcile_all_brain_projects():
    if not brain_enabled():
        return
    projects = Project.objects.filter(deleted_at__isnull=True).values_list("workspace_id", "id")
    for workspace_id, project_id in projects.iterator(chunk_size=100):
        reconcile_project(workspace_id=workspace_id, project_id=project_id, dispatch=True)
