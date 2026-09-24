import base64
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone as datetime_timezone

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.db.models import Issue, Project, User
from plane.ppm_core.permissions import PpmProjectAccess

from .models import (
    PpmGitCodeIndexPolicy,
    PpmGitConnection,
    PpmGitConnectionStatus,
    PpmGitConnectState,
    PpmGitDelivery,
    PpmGitDeliveryStatus,
    PpmGitInstallation,
    PpmGitInstallationStatus,
    PpmGitLink,
    PpmGitLinkOrigin,
    PpmGitLinkStatus,
    PpmGitObject,
    PpmGitObjectType,
    PpmGitProvider,
    PpmGitRepository,
    PpmGitRepositoryStatus,
)
from .permissions import get_ppm_git_capabilities
from .providers import GitHubAppClient, github_app_is_configured
from .providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from .services import (
    PpmGitError,
    create_repository,
    normalize_git_object_url,
    normalize_name,
    update_repository,
)


ACTIVE_CONNECTION_STATUSES = {
    PpmGitConnectionStatus.ACTIVE,
    PpmGitConnectionStatus.SYNCING,
    PpmGitConnectionStatus.ERROR,
    PpmGitConnectionStatus.RATE_LIMITED,
    PpmGitConnectionStatus.PERMISSION_DRIFT,
}
REQUIRED_PERMISSIONS = {"contents": "read", "pull_requests": "read"}


def provider_summary():
    return {
        "provider": PpmGitProvider.GITHUB,
        "configured": github_app_is_configured(),
        "mode": "github_app",
        "permissions": {"metadata": "read", **REQUIRED_PERMISSIONS},
        "events": ["installation", "installation_repositories", "push", "pull_request"],
    }


def start_github_connect(*, workspace_id, project_id, user_id, client=None):
    _require_github_configured()
    client = client or GitHubAppClient()
    raw_state = secrets.token_urlsafe(32)
    now = timezone.now()
    PpmGitConnectState.objects.filter(user_id=user_id, expires_at__lt=now).delete()
    PpmGitConnectState.objects.create(
        workspace_id=workspace_id,
        project_id=project_id,
        provider=PpmGitProvider.GITHUB,
        user_id=user_id,
        token_hash=_token_hash(raw_state),
        expires_at=now + timedelta(seconds=settings.PPM_GITHUB_CONNECT_STATE_TTL_SECONDS),
    )
    return {
        "authorization_url": client.installation_url_with_state(raw_state),
        "expires_in": settings.PPM_GITHUB_CONNECT_STATE_TTL_SECONDS,
    }


def begin_github_user_authorization(*, raw_state, installation_id, client=None):
    _require_github_configured()
    _validate_connect_state_token(raw_state)
    try:
        provider_installation_id = int(installation_id)
    except (TypeError, ValueError) as exc:
        raise PpmGitError("GITHUB_CONNECT_INVALID", "GitHub не вернул установку приложения.") from exc
    if provider_installation_id <= 0:
        raise PpmGitError("GITHUB_CONNECT_INVALID", "GitHub не вернул установку приложения.")

    now = timezone.now()
    with transaction.atomic():
        connect_state = (
            PpmGitConnectState.objects.select_for_update()
            .filter(
                token_hash=_token_hash(raw_state),
                provider=PpmGitProvider.GITHUB,
                consumed_at__isnull=True,
                expires_at__gt=now,
            )
            .first()
        )
        if connect_state is None:
            raise PpmGitError("GITHUB_CONNECT_STATE_INVALID", "Ссылка подключения GitHub истекла или уже использована.")
        _require_connect_manager(connect_state)
        if connect_state.provider_installation_id not in (None, provider_installation_id):
            raise PpmGitError("GITHUB_CONNECT_STATE_INVALID", "Установка GitHub не соответствует запросу подключения.")
        if connect_state.provider_installation_id is None:
            connect_state.provider_installation_id = provider_installation_id
            connect_state.save(update_fields=["provider_installation_id"])

    client = client or GitHubAppClient()
    return connect_state, client.user_authorization_url(raw_state, _oauth_code_verifier(raw_state))


def complete_github_connect(*, raw_state, code, client=None):
    _require_github_configured()
    _validate_connect_state_token(raw_state)
    now = timezone.now()
    connect_state = PpmGitConnectState.objects.filter(
        token_hash=_token_hash(raw_state),
        provider=PpmGitProvider.GITHUB,
        provider_installation_id__isnull=False,
        consumed_at__isnull=True,
        expires_at__gt=now,
    ).first()
    if connect_state is None:
        raise PpmGitError("GITHUB_CONNECT_STATE_INVALID", "Ссылка подключения GitHub истекла или уже использована.")
    _require_connect_manager(connect_state)

    client = client or GitHubAppClient()
    try:
        user_token = client.exchange_user_code(code, _oauth_code_verifier(raw_state))
        provider_data = client.get_user_installation(user_token, connect_state.provider_installation_id)
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc
    _ensure_required_permissions(provider_data.get("permissions", {}))

    with transaction.atomic():
        locked_state = (
            PpmGitConnectState.objects.select_for_update()
            .filter(
                id=connect_state.id,
                provider_installation_id=connect_state.provider_installation_id,
                consumed_at__isnull=True,
                expires_at__gt=timezone.now(),
            )
            .first()
        )
        if locked_state is None:
            raise PpmGitError("GITHUB_CONNECT_STATE_INVALID", "Ссылка подключения GitHub истекла или уже использована.")
        user = _require_connect_manager(locked_state)
        installation, created = PpmGitInstallation.objects.get_or_create(
            workspace_id=locked_state.workspace_id,
            project_id=locked_state.project_id,
            provider=PpmGitProvider.GITHUB,
            provider_installation_id=provider_data["provider_installation_id"],
            defaults={
                "provider_account_id": provider_data["provider_account_id"],
                "account_login": provider_data["account_login"],
                "account_type": provider_data["account_type"],
                "repository_selection": provider_data["repository_selection"],
                "permissions": provider_data["permissions"],
                "events": provider_data["events"],
                "status": PpmGitInstallationStatus.ACTIVE,
                "created_by": user.id,
                "updated_by": user.id,
                "revoked_at": None,
            },
        )
        if not created:
            installation.provider_account_id = provider_data["provider_account_id"]
            installation.account_login = provider_data["account_login"]
            installation.account_type = provider_data["account_type"]
            installation.repository_selection = provider_data["repository_selection"]
            installation.permissions = provider_data["permissions"]
            installation.events = provider_data["events"]
            installation.status = PpmGitInstallationStatus.ACTIVE
            installation.updated_by = user.id
            installation.revoked_at = None
            installation.save()
        locked_state.consumed_at = timezone.now()
        locked_state.save(update_fields=["consumed_at"])
    return locked_state, installation


def list_github_repositories(*, installation, client=None):
    if installation.status != PpmGitInstallationStatus.ACTIVE:
        raise PpmGitError("GITHUB_INSTALLATION_INACTIVE", "Подключение GitHub App больше не активно.")
    _ensure_required_permissions(installation.permissions)
    try:
        return (client or GitHubAppClient()).list_repositories(installation.provider_installation_id)
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc


def refresh_github_installation(*, installation, user_id, client=None):
    if installation.status != PpmGitInstallationStatus.ACTIVE:
        raise PpmGitError("GITHUB_INSTALLATION_INACTIVE", "Подключение GitHub App больше не активно.")
    _require_github_configured()
    try:
        provider_data = (client or GitHubAppClient()).get_installation(installation.provider_installation_id)
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc
    if provider_data["provider_installation_id"] != installation.provider_installation_id:
        raise PpmGitError("GITHUB_INSTALLATION_MISMATCH", "GitHub вернул другую установку приложения.")

    with transaction.atomic():
        locked_installation = PpmGitInstallation.objects.select_for_update().get(
            id=installation.id,
            workspace_id=installation.workspace_id,
            project_id=installation.project_id,
            status=PpmGitInstallationStatus.ACTIVE,
        )
        locked_installation.provider_account_id = provider_data["provider_account_id"]
        locked_installation.account_login = provider_data["account_login"]
        locked_installation.account_type = provider_data["account_type"]
        locked_installation.repository_selection = provider_data["repository_selection"]
        locked_installation.permissions = provider_data["permissions"]
        locked_installation.events = provider_data["events"]
        locked_installation.updated_by = user_id
        locked_installation.save(
            update_fields=[
                "provider_account_id",
                "account_login",
                "account_type",
                "repository_selection",
                "permissions",
                "events",
                "updated_by",
                "updated_at",
            ]
        )
        PpmGitConnection.objects.filter(installation=locked_installation).exclude(
            status__in={PpmGitConnectionStatus.DISCONNECTED, PpmGitConnectionStatus.REVOKED}
        ).update(
            permissions=provider_data["permissions"],
            events=provider_data["events"],
            updated_by=user_id,
            updated_at=timezone.now(),
        )
    return locked_installation


def connect_github_repository(
    *,
    workspace_id,
    project_id,
    installation,
    provider_repository_id,
    user_id,
    client=None,
):
    if installation.workspace_id != workspace_id or installation.status != PpmGitInstallationStatus.ACTIVE:
        raise PpmGitError("GITHUB_INSTALLATION_NOT_FOUND", "Установка GitHub App не найдена.")
    _ensure_required_permissions(installation.permissions)
    try:
        provider_repository_id = int(provider_repository_id)
        provider_data = (client or GitHubAppClient()).get_repository(
            installation.provider_installation_id,
            provider_repository_id,
        )
    except (TypeError, ValueError) as exc:
        raise PpmGitError("GITHUB_REPOSITORY_INVALID", "Выберите репозиторий GitHub.") from exc
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc
    if provider_data["archived"]:
        raise PpmGitError("GITHUB_REPOSITORY_ARCHIVED", "Архивный репозиторий нельзя подключить к проекту.")

    payload = {
        "name": provider_data["name"],
        "provider": PpmGitProvider.GITHUB,
        "canonical_url": provider_data["canonical_url"],
        "clone_https": provider_data["clone_https"],
        "clone_ssh": provider_data["clone_ssh"],
        "default_branch": provider_data["default_branch"],
        "visibility": provider_data["visibility"],
        "is_default": False,
    }
    with transaction.atomic():
        repository = (
            PpmGitRepository.objects.select_for_update()
            .filter(
                workspace_id=workspace_id,
                project_id=project_id,
                status=PpmGitRepositoryStatus.ACTIVE,
                provider=PpmGitProvider.GITHUB,
                provider_repository_id=provider_repository_id,
            )
            .first()
        )
        if repository is None:
            repository = (
                PpmGitRepository.objects.select_for_update()
                .filter(
                    workspace_id=workspace_id,
                    project_id=project_id,
                    status=PpmGitRepositoryStatus.ACTIVE,
                    canonical_url=provider_data["canonical_url"],
                )
                .first()
            )
        if repository is None:
            repository = create_repository(
                workspace_id=workspace_id,
                project_id=project_id,
                payload=payload,
                user_id=user_id,
            )
        else:
            payload["is_default"] = repository.is_default
            repository = update_repository(repository=repository, payload=payload, user_id=user_id)
        repository.provider_repository_id = provider_repository_id
        repository.provider_full_name = provider_data["full_name"]
        repository.updated_by = user_id
        repository.save(update_fields=["provider_repository_id", "provider_full_name", "updated_by", "updated_at"])
        connection, created = PpmGitConnection.objects.select_for_update().get_or_create(
            repository=repository,
            defaults={
                "workspace_id": workspace_id,
                "project_id": project_id,
                "installation": installation,
                "provider_repository_id": provider_repository_id,
                "provider_full_name": provider_data["full_name"],
                "permissions": installation.permissions,
                "events": installation.events,
                "status": PpmGitConnectionStatus.ACTIVE,
                "created_by": user_id,
                "updated_by": user_id,
            },
        )
        if not created:
            connection.installation = installation
            connection.provider_repository_id = provider_repository_id
            connection.provider_full_name = provider_data["full_name"]
            connection.permissions = installation.permissions
            connection.events = installation.events
            connection.status = PpmGitConnectionStatus.ACTIVE
            connection.last_error_code = ""
            connection.last_error_message = ""
            connection.retry_after = None
            connection.disconnected_at = None
            connection.updated_by = user_id
            connection.save()
    return connection


def disconnect_github_connection(*, connection, user_id):
    from .code_indexing import purge_repository_code

    with transaction.atomic():
        locked_connection = (
            PpmGitConnection.objects.select_for_update().select_related("repository").get(id=connection.id)
        )
        if locked_connection.status not in {
            PpmGitConnectionStatus.DISCONNECTED,
            PpmGitConnectionStatus.REVOKED,
        }:
            locked_connection.status = PpmGitConnectionStatus.DISCONNECTED
            locked_connection.disconnected_at = timezone.now()
            locked_connection.updated_by = user_id
            locked_connection.last_error_code = ""
            locked_connection.last_error_message = ""
            locked_connection.retry_after = None
            locked_connection.save(
                update_fields=[
                    "status",
                    "disconnected_at",
                    "updated_by",
                    "last_error_code",
                    "last_error_message",
                    "retry_after",
                    "updated_at",
                ]
            )
        # Always purge, including repeated disconnect requests. This repairs any
        # derived index written by a worker that started before access was revoked.
        purge_repository_code(repository=locked_connection.repository)
    return locked_connection


def synchronize_connection(connection_id, *, client=None):
    connection = PpmGitConnection.objects.select_related("installation", "repository").get(id=connection_id)
    if connection.status not in ACTIVE_CONNECTION_STATUSES:
        return connection
    connection.status = PpmGitConnectionStatus.SYNCING
    connection.last_error_code = ""
    connection.last_error_message = ""
    connection.save(update_fields=["status", "last_error_code", "last_error_message", "updated_at"])
    since = connection.sync_cursor.get("commits_since") if isinstance(connection.sync_cursor, dict) else None
    try:
        values = (client or GitHubAppClient()).sync_repository(
            connection.installation.provider_installation_id,
            connection.provider_repository_id,
            connection.provider_full_name,
            since=since,
        )
    except PpmGitProviderRateLimited as exc:
        _record_sync_error(connection, exc, rate_limited=True)
        raise
    except PpmGitProviderError as exc:
        _record_sync_error(connection, exc)
        raise

    now = timezone.now()
    with transaction.atomic():
        connection = PpmGitConnection.objects.select_for_update().select_related("repository").get(id=connection.id)
        active_branch_ids = []
        for object_type in ("branches", "commits", "pull_requests"):
            for payload in values.get(object_type, []):
                git_object = upsert_git_object(connection=connection, payload=payload)
                auto_link_git_object(git_object=git_object, actor_id=connection.created_by)
                if git_object.object_type == PpmGitObjectType.BRANCH:
                    active_branch_ids.append(git_object.id)
        stale_branches = PpmGitObject.objects.filter(
            connection=connection,
            object_type=PpmGitObjectType.BRANCH,
            is_active=True,
        )
        if active_branch_ids:
            stale_branches = stale_branches.exclude(id__in=active_branch_ids)
        stale_branches.update(is_active=False, state="deleted")
        connection.status = PpmGitConnectionStatus.ACTIVE
        connection.last_sync_at = now
        connection.sync_cursor = {"commits_since": (now - timedelta(minutes=5)).isoformat()}
        connection.last_error_code = ""
        connection.last_error_message = ""
        connection.retry_after = None
        connection.save(
            update_fields=[
                "status",
                "last_sync_at",
                "sync_cursor",
                "last_error_code",
                "last_error_message",
                "retry_after",
                "updated_at",
            ]
        )
    _request_code_sync(connection.repository_id)
    return connection


def upsert_git_object(*, connection, payload):
    object_type = payload.get("object_type")
    if object_type not in PpmGitObjectType.values:
        raise PpmGitError("GITHUB_OBJECT_INVALID", "GitHub вернул неизвестный тип объекта.")
    provider_object_id = normalize_name(payload.get("provider_object_id"), maximum=255)
    title = normalize_name(payload.get("title"), maximum=500)
    canonical_url = normalize_git_object_url(payload.get("canonical_url"), repository=connection.repository)
    provider_updated_at = _coerce_datetime(payload.get("provider_updated_at"))
    defaults = {
        "workspace_id": connection.workspace_id,
        "project_id": connection.project_id,
        "connection": connection,
        "ref": _clean_text(payload.get("ref"), maximum=255),
        "title": title,
        "canonical_url": canonical_url,
        "state": _clean_text(payload.get("state"), maximum=32),
        "is_draft": payload.get("is_draft") is True,
        "author_name": _clean_text(payload.get("author_name"), maximum=255),
        "author_avatar_url": _clean_url(payload.get("author_avatar_url")),
        "base_ref": _clean_text(payload.get("base_ref"), maximum=255),
        "head_ref": _clean_text(payload.get("head_ref"), maximum=255),
        "commit_sha": _clean_text(payload.get("commit_sha"), maximum=64),
        "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
        "source_version": normalize_name(payload.get("source_version"), maximum=255),
        "provider_updated_at": provider_updated_at,
        "is_active": payload.get("state") != "deleted",
    }
    git_object, _ = PpmGitObject.objects.update_or_create(
        repository=connection.repository,
        object_type=object_type,
        provider_object_id=provider_object_id,
        defaults=defaults,
    )
    return git_object


def auto_link_git_object(*, git_object, actor_id):
    project = Project.objects.only("identifier").get(id=git_object.project_id)
    identifier = project.identifier
    if not identifier:
        return []
    message = git_object.metadata.get("message", "") if isinstance(git_object.metadata, dict) else ""
    searchable = " ".join((git_object.ref, git_object.title, git_object.head_ref, str(message)))
    pattern = re.compile(rf"(?<![A-Z0-9]){re.escape(identifier)}-(\d+)(?!\d)", re.IGNORECASE)
    sequence_ids = {int(value) for value in pattern.findall(searchable)}
    if not sequence_ids:
        return []
    issues = Issue.objects.filter(
        workspace_id=git_object.workspace_id,
        project_id=git_object.project_id,
        sequence_id__in=sequence_ids,
        deleted_at__isnull=True,
    )
    links = []
    for issue in issues:
        try:
            with transaction.atomic():
                link, created = PpmGitLink.objects.get_or_create(
                    repository=git_object.repository,
                    work_item=issue,
                    object_type=git_object.object_type,
                    canonical_url=git_object.canonical_url,
                    status=PpmGitLinkStatus.ACTIVE,
                    defaults={
                        "workspace_id": git_object.workspace_id,
                        "project_id": git_object.project_id,
                        "git_object": git_object,
                        "ref": git_object.ref,
                        "title": git_object.title[:255],
                        "origin": PpmGitLinkOrigin.PROVIDER,
                        "created_by": actor_id,
                        "updated_by": actor_id,
                    },
                )
        except IntegrityError:
            link = PpmGitLink.objects.get(
                repository=git_object.repository,
                work_item=issue,
                object_type=git_object.object_type,
                canonical_url=git_object.canonical_url,
                status=PpmGitLinkStatus.ACTIVE,
            )
            created = False
        if not created and link.git_object_id is None:
            link.git_object = git_object
            link.updated_by = actor_id
            link.save(update_fields=["git_object", "updated_by", "updated_at"])
        links.append(link)
    return links


def create_delivery(*, delivery_id, event_name, raw_body_hash, normalized_payload):
    try:
        with transaction.atomic():
            delivery = PpmGitDelivery.objects.create(
                provider=PpmGitProvider.GITHUB,
                provider_delivery_id=delivery_id,
                event_name=event_name,
                action=normalized_payload.get("action", ""),
                provider_installation_id=normalized_payload.get("installation_id"),
                provider_repository_id=normalized_payload.get("repository_id"),
                body_sha256=raw_body_hash,
                payload=normalized_payload,
            )
        return delivery, False
    except IntegrityError:
        delivery = PpmGitDelivery.objects.get(
            provider=PpmGitProvider.GITHUB,
            provider_delivery_id=delivery_id,
        )
        if delivery.body_sha256 != raw_body_hash:
            raise PpmGitError("GITHUB_DELIVERY_CONFLICT", "Повторный webhook имеет другое содержимое.")
        return delivery, True


def process_delivery(delivery_id):
    with transaction.atomic():
        delivery = PpmGitDelivery.objects.select_for_update().get(id=delivery_id)
        if delivery.status in {PpmGitDeliveryStatus.PROCESSED, PpmGitDeliveryStatus.IGNORED}:
            return delivery
        delivery.status = PpmGitDeliveryStatus.PROCESSING
        delivery.attempts += 1
        delivery.save(update_fields=["status", "attempts"])
    try:
        processed = _apply_delivery(delivery)
    except Exception as exc:
        delivery.status = PpmGitDeliveryStatus.FAILED
        delivery.last_error_code = getattr(exc, "code", "GITHUB_DELIVERY_FAILED")
        delivery.last_error_message = str(getattr(exc, "message", "Не удалось обработать событие GitHub."))[:500]
        delivery.next_retry_at = timezone.now() + timedelta(minutes=min(2**delivery.attempts, 60))
        delivery.save(update_fields=["status", "last_error_code", "last_error_message", "next_retry_at"])
        raise
    delivery.status = PpmGitDeliveryStatus.PROCESSED if processed else PpmGitDeliveryStatus.IGNORED
    delivery.processed_at = timezone.now()
    delivery.last_error_code = ""
    delivery.last_error_message = ""
    delivery.next_retry_at = None
    delivery.save(
        update_fields=[
            "status",
            "processed_at",
            "last_error_code",
            "last_error_message",
            "next_retry_at",
        ]
    )
    return delivery


def _apply_delivery(delivery):
    payload = delivery.payload
    event_name = delivery.event_name
    if event_name == "ping" or payload.get("ignored"):
        return False
    if event_name == "installation":
        return _apply_installation_event(payload)
    if event_name == "installation_repositories":
        return _apply_installation_repositories_event(payload)
    connections = PpmGitConnection.objects.select_related("repository").filter(
        provider_repository_id=delivery.provider_repository_id,
        status__in=ACTIVE_CONNECTION_STATUSES,
    )
    if delivery.provider_installation_id is not None:
        connections = connections.filter(
            installation__provider_installation_id=delivery.provider_installation_id,
        )
    else:
        # Repository webhooks are a supported fallback for local/self-hosted PPM
        # installations. Their payloads contain the repository id, but unlike a
        # GitHub App webhook they do not include an installation object.
        connections = connections.filter(installation__provider=PpmGitProvider.GITHUB)
    processed = False
    for connection in connections:
        objects = []
        if event_name == "push":
            objects = [payload.get("branch"), *payload.get("commits", [])]
        elif event_name == "pull_request":
            objects = [payload.get("pull_request")]
        for object_payload in objects:
            if not isinstance(object_payload, dict):
                continue
            git_object = upsert_git_object(connection=connection, payload=object_payload)
            auto_link_git_object(git_object=git_object, actor_id=connection.created_by)
            processed = True
        connection.last_event_at = timezone.now()
        connection.status = PpmGitConnectionStatus.ACTIVE
        connection.last_error_code = ""
        connection.last_error_message = ""
        connection.save(
            update_fields=["last_event_at", "status", "last_error_code", "last_error_message", "updated_at"]
        )
        if event_name == "push":
            _handle_code_push(connection=connection, payload=payload)
    return processed


def _apply_installation_event(payload):
    action = payload.get("action")
    installation_id = payload.get("installation_id")
    installations = PpmGitInstallation.objects.filter(
        provider=PpmGitProvider.GITHUB,
        provider_installation_id=installation_id,
    )
    if action == "deleted":
        repository_ids = list(
            PpmGitConnection.objects.filter(installation__in=installations).values_list("repository_id", flat=True)
        )
        installations.update(status=PpmGitInstallationStatus.REVOKED, revoked_at=timezone.now())
        PpmGitConnection.objects.filter(installation__in=installations).update(
            status=PpmGitConnectionStatus.REVOKED,
            last_error_code="GITHUB_INSTALLATION_REVOKED",
            last_error_message="Установка GitHub App отозвана.",
        )
        _purge_code_for_repositories(repository_ids)
        return installations.exists()
    if action == "suspend":
        installations.update(status=PpmGitInstallationStatus.SUSPENDED)
        PpmGitConnection.objects.filter(installation__in=installations).update(
            status=PpmGitConnectionStatus.SUSPENDED,
            last_error_code="GITHUB_INSTALLATION_SUSPENDED",
            last_error_message="Установка GitHub App приостановлена.",
        )
        return installations.exists()
    if action in {"unsuspend", "new_permissions_accepted"}:
        provider_data = payload.get("installation") if isinstance(payload.get("installation"), dict) else {}
        permissions = provider_data.get("permissions", {})
        events = provider_data.get("events", [])
        now = timezone.now()
        installations.update(
            status=PpmGitInstallationStatus.ACTIVE,
            permissions=permissions,
            events=events,
            revoked_at=None,
            updated_at=now,
        )
        connections = PpmGitConnection.objects.filter(installation__in=installations).exclude(
            status__in={PpmGitConnectionStatus.DISCONNECTED, PpmGitConnectionStatus.REVOKED}
        )
        connections.update(permissions=permissions, events=events, updated_at=now)
        if action == "unsuspend":
            connections.filter(status=PpmGitConnectionStatus.SUSPENDED).update(
                status=PpmGitConnectionStatus.ACTIVE,
                last_error_code="",
                last_error_message="",
                retry_after=None,
                updated_at=now,
            )
        return installations.exists()
    return False


def _apply_installation_repositories_event(payload):
    removed = payload.get("repositories_removed", [])
    if not removed:
        return False
    connections = PpmGitConnection.objects.filter(
        installation__provider_installation_id=payload.get("installation_id"),
        provider_repository_id__in=removed,
    )
    repository_ids = list(connections.values_list("repository_id", flat=True))
    changed = bool(
        connections.update(
            status=PpmGitConnectionStatus.PERMISSION_DRIFT,
            last_error_code="GITHUB_REPOSITORY_ACCESS_REMOVED",
            last_error_message="GitHub App больше не имеет доступа к репозиторию.",
        )
    )
    _purge_code_for_repositories(repository_ids)
    return changed


def _purge_code_for_repositories(repository_ids):
    if not repository_ids:
        return
    from .code_indexing import purge_repository_code

    for repository in PpmGitRepository.objects.filter(id__in=repository_ids):
        purge_repository_code(repository=repository)


def _request_code_sync(repository_id):
    from .tasks import synchronize_git_code_task

    if PpmGitRepository.objects.filter(id=repository_id, code_index_policy__enabled=True).exists():
        transaction.on_commit(lambda: synchronize_git_code_task.delay(str(repository_id)))


def _handle_code_push(*, connection, payload):
    policy = PpmGitCodeIndexPolicy.objects.filter(repository_id=connection.repository_id, enabled=True).first()
    branch = payload.get("branch") if isinstance(payload.get("branch"), dict) else {}
    if policy is None or branch.get("ref") != policy.branch:
        return
    if payload.get("deleted") is True:
        from .code_indexing import purge_repository_code

        purge_repository_code(repository=connection.repository)
        return
    _request_code_sync(connection.repository_id)


def _record_sync_error(connection, error, *, rate_limited=False):
    connection.status = PpmGitConnectionStatus.RATE_LIMITED if rate_limited else PpmGitConnectionStatus.ERROR
    connection.last_error_code = error.code
    connection.last_error_message = error.message[:500]
    connection.retry_after = (
        timezone.now() + timedelta(seconds=error.retry_after_seconds or 60) if rate_limited else None
    )
    connection.save(
        update_fields=[
            "status",
            "last_error_code",
            "last_error_message",
            "retry_after",
            "updated_at",
        ]
    )


def _provider_error(error):
    details = {"retry_after_seconds": error.retry_after_seconds} if error.retry_after_seconds else None
    return PpmGitError(error.code, error.message, details)


def _ensure_required_permissions(permissions):
    missing = [key for key in REQUIRED_PERMISSIONS if permissions.get(key) not in {"read", "write"}]
    if missing:
        raise PpmGitError(
            "GITHUB_PERMISSIONS_MISSING",
            "GitHub App не получила необходимые права только на чтение.",
            {"permissions": missing},
        )


def _require_github_configured():
    if not github_app_is_configured():
        raise PpmGitError(
            "GITHUB_APP_NOT_CONFIGURED",
            "GitHub App ещё не настроен администратором PPM.",
        )


def _validate_connect_state_token(raw_state):
    if not isinstance(raw_state, str) or not 32 <= len(raw_state) <= 512:
        raise PpmGitError("GITHUB_CONNECT_STATE_INVALID", "Состояние подключения GitHub недействительно.")


def _oauth_code_verifier(raw_state):
    digest = hmac.new(
        settings.SECRET_KEY.encode("utf-8"),
        raw_state.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _require_connect_manager(connect_state):
    user = User.objects.filter(id=connect_state.user_id, is_active=True).first()
    if user is None:
        raise PpmGitError("GIT_PERMISSION_DENIED", "Пользователь подключения больше не активен.")
    access, capabilities = get_ppm_git_capabilities(
        user=user,
        workspace_id=connect_state.workspace_id,
        project_id=connect_state.project_id,
    )
    if access == PpmProjectAccess.DENY or not capabilities["manage_provider"]:
        raise PpmGitError("GIT_PERMISSION_DENIED", "Недостаточно прав для подключения GitHub к проекту.")
    return user


def _token_hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _coerce_datetime(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=datetime_timezone.utc)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _clean_text(value, *, maximum):
    if not isinstance(value, str):
        return ""
    return value[:maximum].replace("\x00", "")


def _clean_url(value):
    if not isinstance(value, str) or not value.startswith("https://") or len(value) > 2048:
        return ""
    return value
