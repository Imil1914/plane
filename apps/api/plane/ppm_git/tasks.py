from celery import shared_task
from django.db.models import Q
from django.utils import timezone

from .models import PpmGitConnection, PpmGitConnectionStatus, PpmGitDelivery, PpmGitDeliveryStatus
from .code_indexing import synchronize_repository_code
from .services import PpmGitError
from .provider_services import SYNC_HALT_KEY, process_delivery, purge_old_deliveries, synchronize_connection
from .providers.base import PpmGitProviderError, PpmGitProviderRateLimited

# G2.1 A2: answers a retry cannot change: a provider whose server settings are missing (or unknown) — until an
# administrator changes them and restarts PPM; a repository renamed or moved on the provider — until it is connected
# again; an empty repository — its first push queues the code index itself. The error is already recorded (on the
# connection) and the scheduled reconciliation looks again every 15 minutes, so the task ends without retries.
NO_RETRY_ERRORS = {
    "GIT_PROVIDER_NOT_CONFIGURED",
    "GIT_PROVIDER_UNSUPPORTED",
    "GIT_REPOSITORY_MOVED",
    "GIT_REPOSITORY_EMPTY",
}


@shared_task(bind=True, max_retries=5)
def process_git_delivery_task(self, delivery_id):
    try:
        process_delivery(delivery_id)
    except PpmGitProviderRateLimited as exc:
        raise self.retry(
            exc=exc,
            countdown=min(exc.retry_after_seconds or 60, 3600),
        ) from exc
    except PpmGitProviderError as exc:
        raise self.retry(exc=exc, countdown=min(2 ** (self.request.retries + 1) * 30, 3600)) from exc


@shared_task(bind=True, max_retries=5)
def reconcile_git_connection_task(self, connection_id):
    try:
        synchronize_connection(connection_id)
    except PpmGitProviderRateLimited as exc:
        raise self.retry(
            exc=exc,
            countdown=min(exc.retry_after_seconds or 60, 3600),
        ) from exc
    except PpmGitProviderError as exc:
        if exc.code in NO_RETRY_ERRORS:
            return
        raise self.retry(exc=exc, countdown=min(2 ** (self.request.retries + 1) * 30, 3600)) from exc


@shared_task(bind=True, max_retries=5)
def synchronize_git_code_task(self, repository_id):
    try:
        synchronize_repository_code(repository_id)
    except PpmGitProviderRateLimited as exc:
        raise self.retry(exc=exc, countdown=min(exc.retry_after_seconds or 60, 3600)) from exc
    except PpmGitProviderError as exc:
        if exc.code in NO_RETRY_ERRORS:
            return
        raise self.retry(exc=exc, countdown=min(2 ** (self.request.retries + 1) * 30, 3600)) from exc
    except PpmGitError:
        return


@shared_task
def reconcile_active_git_connections():
    now = timezone.now()
    connection_ids = (
        PpmGitConnection.objects.filter(
            Q(status__in=[PpmGitConnectionStatus.ACTIVE, PpmGitConnectionStatus.ERROR])
            | Q(status=PpmGitConnectionStatus.RATE_LIMITED, retry_after__lte=now)
        )
        # G2.1: halted by a provider directive (for example «repository deleted») — waits for «Обновить».
        .exclude(sync_cursor__has_key=SYNC_HALT_KEY)
        .values_list("id", flat=True)
    )
    for connection_id in connection_ids.iterator(chunk_size=100):
        reconcile_git_connection_task.delay(str(connection_id))

    delivery_ids = PpmGitDelivery.objects.filter(
        status=PpmGitDeliveryStatus.FAILED,
        next_retry_at__lte=now,
    ).values_list("id", flat=True)
    for delivery_id in delivery_ids.iterator(chunk_size=100):
        process_git_delivery_task.delay(str(delivery_id))

    # G2.1 A2 fix round 1: handled receipts older than 30 days go (every provider; nothing cleaned them before).
    purge_old_deliveries(now=now)
