# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import os
import logging
from datetime import timedelta

# Third party imports
from celery import Celery
from pythonjsonlogger.json import JsonFormatter
from celery.signals import after_setup_logger, after_setup_task_logger
from celery.schedules import crontab, schedule

# Module imports
from plane.settings.redis import redis_instance

# Set the default Django settings module for the 'celery' program.
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "plane.settings.production")

ri = redis_instance()


# Configurable metrics push interval (in minutes)
# Default: 360 (6 hours), set to 5 for development/testing
def _get_metrics_push_interval_minutes() -> int:
    raw = os.environ.get("METRICS_PUSH_INTERVAL_MINUTES", "360")
    try:
        value = int(raw)
        # Cap at 10,000,000 minutes to prevent timedelta(minutes=...) OverflowError
        # on arbitrarily large inputs while still allowing multi-year intervals.
        return value if 0 < value <= 10_000_000 else 360
    except (ValueError, OverflowError):
        return 360


METRICS_PUSH_INTERVAL_MINUTES = _get_metrics_push_interval_minutes()

app = Celery("plane")

# Using a string here means the worker will not have to
# pickle the object when using Windows.
app.config_from_object("django.conf:settings", namespace="CELERY")

app.conf.beat_schedule = {
    # Intra day recurring jobs
    "check-every-five-minutes-to-send-email-notifications": {
        "task": "plane.bgtasks.email_notification_task.stack_email_notification",
        "schedule": crontab(minute="*/5"),  # Every 5 minutes
    },
    "push-instance-metrics": {
        "task": "plane.license.bgtasks.telemetry_metrics.push_instance_metrics",
        "schedule": schedule(run_every=timedelta(minutes=METRICS_PUSH_INTERVAL_MINUTES)),
    },
    "ppm-git-reconcile": {
        "task": "plane.ppm_git.tasks.reconcile_active_git_connections",
        "schedule": schedule(run_every=timedelta(minutes=15)),
    },
    # G2.2 R16: the full reconciliation of code access on PPM's Git server (a no-op without single sign-on).
    "ppm-git-forgejo-access-reconcile": {
        "task": "plane.ppm_git.tasks.reconcile_forgejo_access",
        "schedule": schedule(run_every=timedelta(minutes=10)),
    },
    # G2.2 R1: expired OAuth2 codes and tokens of the Git server client go every day («skipped» where
    # django-oauth-toolkit is not installed — the task is registered in every worker through CELERY_IMPORTS).
    "ppm-oidc-clear-expired-tokens": {
        "task": "plane.ppm_oidc.tasks.clear_expired_oidc_tokens",
        "schedule": crontab(hour=4, minute=0),  # UTC 04:00
    },
    "ppm-brain-recover-jobs": {
        "task": "plane.ppm_brain.tasks.recover_brain_index_jobs",
        "schedule": schedule(run_every=timedelta(minutes=2)),
    },
    "ppm-agent-expire-stale-runs": {
        "task": "plane.ppm_brain.tasks.expire_stale_agent_runs_task",
        "schedule": schedule(run_every=timedelta(minutes=1)),
    },
    "ppm-agent-recover-queued-runs": {
        "task": "plane.ppm_brain.tasks.recover_queued_agent_runs_task",
        "schedule": schedule(run_every=timedelta(minutes=1)),
    },
    "ppm-brain-reconcile": {
        "task": "plane.ppm_brain.tasks.reconcile_all_brain_projects",
        "schedule": schedule(run_every=timedelta(minutes=15)),
    },
    # Occurs once every day
    "check-every-day-to-delete-hard-delete": {
        "task": "plane.bgtasks.deletion_task.hard_delete",
        "schedule": crontab(hour=0, minute=0),  # UTC 00:00
    },
    "check-every-day-to-archive-and-close": {
        "task": "plane.bgtasks.issue_automation_task.archive_and_close_old_issues",
        "schedule": crontab(hour=1, minute=0),  # UTC 01:00
    },
    "check-every-day-to-delete_exporter_history": {
        "task": "plane.bgtasks.exporter_expired_task.delete_old_s3_link",
        "schedule": crontab(hour=1, minute=30),  # UTC 01:30
    },
    "check-every-day-to-delete-file-asset": {
        "task": "plane.bgtasks.file_asset_task.delete_unuploaded_file_asset",
        "schedule": crontab(hour=2, minute=0),  # UTC 02:00
    },
    "check-every-day-to-delete-api-logs": {
        "task": "plane.bgtasks.cleanup_task.delete_api_logs",
        "schedule": crontab(hour=2, minute=30),  # UTC 02:30
    },
    "check-every-day-to-delete-email-notification-logs": {
        "task": "plane.bgtasks.cleanup_task.delete_email_notification_logs",
        "schedule": crontab(hour=2, minute=45),  # UTC 02:45
    },
    "check-every-day-to-delete-page-versions": {
        "task": "plane.bgtasks.cleanup_task.delete_page_versions",
        "schedule": crontab(hour=3, minute=0),  # UTC 03:00
    },
    "check-every-day-to-delete-issue-description-versions": {
        "task": "plane.bgtasks.cleanup_task.delete_issue_description_versions",
        "schedule": crontab(hour=3, minute=15),  # UTC 03:15
    },
    "check-every-day-to-delete-webhook-logs": {
        "task": "plane.bgtasks.cleanup_task.delete_webhook_logs",
        "schedule": crontab(hour=3, minute=30),  # UTC 03:30
    },
    "check-every-day-to-delete-exporter-history": {
        "task": "plane.bgtasks.exporter_expired_task.delete_old_s3_link",
        "schedule": crontab(hour=3, minute=45),  # UTC 03:45
    },
}


# Setup logging
@after_setup_logger.connect
def setup_loggers(logger, *args, **kwargs):
    formatter = JsonFormatter('"%(levelname)s %(asctime)s %(module)s %(name)s %(message)s')
    handler = logging.StreamHandler()
    handler.setFormatter(fmt=formatter)
    logger.addHandler(handler)


@after_setup_task_logger.connect
def setup_task_loggers(logger, *args, **kwargs):
    formatter = JsonFormatter('"%(levelname)s %(asctime)s %(module)s %(name)s %(message)s')
    handler = logging.StreamHandler()
    handler.setFormatter(fmt=formatter)
    logger.addHandler(handler)


# Load task modules from all registered Django app configs.
app.autodiscover_tasks()

app.conf.beat_scheduler = "django_celery_beat.schedulers.DatabaseScheduler"
