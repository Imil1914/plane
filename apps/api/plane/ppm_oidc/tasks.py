"""G2.2 R1 — expired OAuth2 codes and tokens of the Git server client are removed every day.

Imported by every worker through ``CELERY_IMPORTS`` — also where django-oauth-toolkit is not installed (the owner's
development stack): the task is then registered and does nothing, so a beat entry never becomes an unknown task.
"""

import logging

from celery import shared_task

logger = logging.getLogger("plane.worker")


@shared_task(name="plane.ppm_oidc.tasks.clear_expired_oidc_tokens")
def clear_expired_oidc_tokens():
    from django.apps import apps

    if not apps.is_installed("oauth2_provider"):
        return "skipped"

    from django.db import DatabaseError
    from oauth2_provider.models import clear_expired

    try:
        clear_expired()
    except DatabaseError as exc:
        logger.warning("Expired OAuth2 tokens were not cleared", extra={"error_class": type(exc).__name__})
        return "failed"
    return "cleared"
