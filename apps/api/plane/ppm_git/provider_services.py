import base64
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone as datetime_timezone

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status as http_status

from plane.db.models import Issue, Project, User
from plane.ppm_core.permissions import PpmProjectAccess

from .forgejo_access import forgejo_sso_is_configured, forgejo_username_for
from .forgejo_admin import ForgejoAdminClient
from .models import (
    PpmForgejoAccount,
    PpmForgejoOrganization,
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
from .providers import (
    FORGEJO_INSTALLATION_ID,
    GitHubAppClient,
    forgejo_is_configured,
    forgejo_public_url,
    forgejo_ssh_enabled,
    forgejo_trusted_origin,
    get_provider_client,
    github_app_is_configured,
)
from .providers.base import REPOSITORY_MOVED_CODES, PpmGitProviderError, PpmGitProviderRateLimited
from .providers.forgejo import (
    PAGE_SIZE as FORGEJO_PAGE_SIZE,
    REQUEST_TIMEOUT as FORGEJO_REQUEST_TIMEOUT,
    normalize_forgejo_repository,
)
from .services import (
    PpmGitError,
    create_repository,
    ensure_clone_scope,
    normalize_git_object_url,
    normalize_name,
    normalize_ssh_url,
    restore_repository,
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
# G2.1: machine code of a repository-level error a provider's normalized delivery may report
# (providers.base.ConnectionErrorDirective).
CONNECTION_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
# G2.1: a directive with `halt_sync` (for example «repository deleted») stops synchronization of the connection until an
# administrator presses «Обновить». The marker {"code": …, "at": ISO 8601} lives in `sync_cursor` next to the commit
# cursor: scheduled reconciliation, retries and deliveries skip the connection, `resume_connection_sync` lifts it.
SYNC_HALT_KEY = "halted"
# G2.1 A2: pushes the provider delivered only in part (`providers.base.CatchUpRange`), kept until a synchronization read
# them (at most CATCH_UP_LIMIT, the newest win).
CATCH_UP_KEY = "catch_up"
CATCH_UP_LIMIT = 20
CATCH_UP_SHA = re.compile(r"^[0-9a-f]{40,64}$")
# G2.1 A2: the Forgejo «installation» of a project — the read-only service account ppm-bot, one row per project.
FORGEJO_PERMISSIONS = {"metadata": "read", "contents": "read", "pull_requests": "read"}
FORGEJO_EVENTS = ["push", "pull_request", "create", "delete", "repository"]
FORGEJO_SEARCH_MAX_LENGTH = 100
FORGEJO_MAX_PAGE = 1000
# G2.1 A2 fix round 1: a receipt is proof of receipt, not an archive. A handled one (processed or ignored) is removed
# this long after it was handled (round 2: `processed_at`, not `received_at` — a delivery that failed for weeks and then
# succeeded still guards against its next redelivery) — for every provider (nothing cleaned GitHub receipts before);
# failed and pending ones stay, the scheduled job still retries them. At most DELIVERY_PURGE_BATCH per run of the
# 15-minute reconciliation.
DELIVERY_RETENTION = timedelta(days=30)
DELIVERY_PURGE_BATCH = 1000
# What a receipt of a repository PPM does not follow keeps (fix round 1): the system webhook of the Git server sends
# every repository of the server, and PPM stores none of their content.
UNFOLLOWED_DELIVERY_KEYS = ("event", "action", "installation_id", "repository_id")
# G2.2: the sign-in source of PPM on the Git server is named exactly this (plan «G2.2»): it is part of the button text,
# of the redirect URI registered in PPM and of the one-click sign-in link `/user/oauth2/PPM`.
FORGEJO_SSO_SOURCE_NAME = "PPM"
# G2.2 R17: one page of a project administrator's connect dialog (their listing is read whole and paged here).
FORGEJO_LISTING_PAGE_SIZE = FORGEJO_PAGE_SIZE
# The person's listing is read as that person at most this many pages (of 50: 1 000 repositories) and kept this many
# seconds per person — searching and paging the dialog do not ask the Git server again. A connect never uses it.
FORGEJO_LISTING_MAX_PAGES = 20
FORGEJO_LISTING_CACHE_SECONDS = 60
FORGEJO_LISTING_CACHE_PREFIX = "ppm:git:forgejo-administered:"
FORGEJO_TOO_MANY_REPOSITORIES = (
    "FORGEJO_TOO_MANY_REPOSITORIES",
    "На Git-сервере вам доступно слишком много репозиториев — список не показать. Попросите администратора PPM "
    "подключить нужный репозиторий.",
)
FORGEJO_ACCOUNT_REQUIRED = (
    "FORGEJO_ACCOUNT_REQUIRED",
    "Сначала войдите на Git-сервер кнопкой «Войти через PPM» — здесь появятся ваши репозитории.",
)
FORGEJO_NOT_ADMINISTERED = (
    "GIT_PERMISSION_DENIED",
    "Подключить можно только репозиторий организации пространства, где у вас права администратора на Git-сервере.",
)
FORGEJO_REPOSITORY_NOT_FOUND = ("GIT_REPOSITORY_NOT_FOUND", "Репозиторий не найден на Git-сервере.")


def sync_halted(connection):
    return isinstance(connection.sync_cursor, dict) and SYNC_HALT_KEY in connection.sync_cursor


def resume_connection_sync(*, connection, user_id):
    """«Обновить»: lifts a provider halt, so the queued synchronization reaches the provider again (for example
    after the repository was restored). The commit cursor stays.

    Returns the lifted marker, or None when the connection was not halted. The halt is looked up only on the locked row
    (A2, item 0): the caller's ``connection`` was read earlier, and a halt that landed since then must still be lifted —
    otherwise the queued synchronization would see it and do nothing.
    """
    with transaction.atomic():
        locked = PpmGitConnection.objects.select_for_update().get(id=connection.id)
        cursor = dict(locked.sync_cursor) if isinstance(locked.sync_cursor, dict) else {}
        halt = cursor.pop(SYNC_HALT_KEY, None)
        if halt is None:
            connection.sync_cursor = locked.sync_cursor
            return None
        locked.sync_cursor = cursor
        locked.updated_by = user_id
        locked.save(update_fields=["sync_cursor", "updated_by", "updated_at"])
    connection.sync_cursor = cursor
    return halt if isinstance(halt, dict) else {}


def provider_summary():
    return {
        "provider": PpmGitProvider.GITHUB,
        "configured": github_app_is_configured(),
        "mode": "github_app",
        "permissions": {"metadata": "read", **REQUIRED_PERMISSIONS},
        "events": ["installation", "installation_repositories", "push", "pull_request"],
    }


def providers_summary(*, user=None):
    """G2.1 R9: which Git providers this PPM is set up for — never a secret (the token and the webhook secret stay).

    G2.2: single sign-on on PPM's Git server, the viewer's name there and the one-click sign-in link. The name comes
    from PPM's own record (``PpmForgejoAccount``): the overview never asks the Git server, and without single sign-on no
    access table is read at all.
    """
    public_url = forgejo_public_url()
    sso = forgejo_sso_is_configured()
    return {
        "github": {"configured": github_app_is_configured()},
        "forgejo": {
            "configured": forgejo_is_configured(),
            "public_url": public_url or None,
            "sso_enabled": sso,
            "username": forgejo_username_for(user) if sso and user is not None else None,
            "sso_login_url": f"{public_url}/user/oauth2/{FORGEJO_SSO_SOURCE_NAME}" if sso and public_url else None,
        },
    }


# --- Forgejo: PPM's own Git server (G2.1 A2) -------------------------------------------------------------------------


def list_forgejo_repositories(*, workspace_id, project_id, search="", page=1, client=None):
    """One page of the Git server's repositories for the connect dialog, each marked when already connected here."""
    _require_forgejo_configured()
    query = search.strip()[:FORGEJO_SEARCH_MAX_LENGTH] if isinstance(search, str) else ""
    page_number = _page_number(page)
    try:
        answer = (client or get_provider_client(PpmGitProvider.FORGEJO)).search_repositories(
            query=query,
            page=page_number,
        )
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc
    return _forgejo_repository_page(
        answer["items"],
        workspace_id=workspace_id,
        project_id=project_id,
        page=answer["page"],
        has_next=answer["has_next"],
    )


def _forgejo_repository_page(items, *, workspace_id, project_id, page, has_next):
    """One page of the connect dialog (G2.1 shape), each repository marked when it is already connected here."""
    connections = {
        connection.provider_repository_id: connection
        for connection in PpmGitConnection.objects.select_related("repository").filter(
            workspace_id=workspace_id,
            project_id=project_id,
            installation__provider=PpmGitProvider.FORGEJO,
        )
    }
    return {
        "results": [
            {
                "provider_repository_id": item["provider_repository_id"],
                "full_name": item["full_name"],
                "name": item["name"],
                "owner": item["owner"],
                "description": item["description"],
                "private": item["private"],
                "archived": item["archived"],
                "default_branch": item["default_branch"],
                "html_url": item["canonical_url"],
                "clone_https": item["clone_https"],
                "clone_ssh": item["clone_ssh"],
                "updated_at": item["updated_at"].isoformat() if item["updated_at"] else None,
                # Exactly the «already connected» 409 of connecting: a row that is not connected can be connected.
                "connected": forgejo_connection_is_current(
                    connections.get(item["provider_repository_id"]),
                    full_name=item["full_name"],
                ),
            }
            for item in items
        ],
        "page": page,
        "has_next": has_next,
    }


# --- G2.2 R17: a project administrator connects the repositories they administer on the Git server --------------------


def list_administered_forgejo_repositories(*, user, workspace_id, project_id, search="", page=1, client=None):
    """The connect dialog of a project administrator (single sign-on): the repositories of the workspace's organization
    their Git server account administers — created by them (Forgejo makes the creator of an organization repository its
    admin collaborator) or reached through their ``<KEY>-admin`` team. G2.1 shape; filtered, searched by name, sorted
    and paged here from the person's listing (``_administered_repositories``: at most 20 pages, kept 60 s)."""
    _require_forgejo_configured()
    query = search.strip()[:FORGEJO_SEARCH_MAX_LENGTH].casefold() if isinstance(search, str) else ""
    page_number = _page_number(page)
    username, organization = _forgejo_person(user=user, workspace_id=workspace_id)
    items = []
    if organization is not None:
        items = [
            item
            for item in _administered_repositories(user=user, username=username, client=client)
            if item["owner"].casefold() == organization.casefold() and (not query or query in item["name"].casefold())
        ]
    items.sort(key=lambda item: (item["full_name"].casefold(), item["provider_repository_id"]))
    start = (page_number - 1) * FORGEJO_LISTING_PAGE_SIZE
    return _forgejo_repository_page(
        items[start : start + FORGEJO_LISTING_PAGE_SIZE],
        workspace_id=workspace_id,
        project_id=project_id,
        page=page_number,
        has_next=start + FORGEJO_LISTING_PAGE_SIZE < len(items),
    )


def require_administered_forgejo_repository(*, user, workspace_id, provider_repository_id, client=None):
    """Before a project administrator connects a repository, the right is checked on the Git server itself — never taken
    from the client or from the dialog's cached listing: the repository by id (the service account sees every one) and
    the person's permission on it (``…/collaborators/{name}/permission``, teams included). No access — «not found»
    (404, as a missing one); read or write only, or a repository outside the workspace's organization — refused (403);
    admin (or owner) of a repository of the organization — allowed. Neither refusal names the repository."""
    _require_forgejo_configured()
    repository_id = _forgejo_repository_id(provider_repository_id)
    username, organization = _forgejo_person(user=user, workspace_id=workspace_id)
    client = client or ForgejoAdminClient()
    try:
        repository = client.get_repository(repository_id)
        permission = "none" if repository is None else client.repository_permission(repository["full_name"], username)
    except PpmGitProviderError as exc:
        if exc.code == "GIT_PROVIDER_NOT_FOUND":
            # The repository was just found by id: it is the person's account that is gone on the Git server (deleted
            # or renamed there) — the next sign-in brings it back.
            raise PpmGitError(*FORGEJO_ACCOUNT_REQUIRED) from exc
        raise _provider_error(exc) from exc
    if permission not in {"read", "write", "admin", "owner"}:
        raise PpmGitError(*FORGEJO_REPOSITORY_NOT_FOUND)
    in_organization = organization is not None and repository["owner"].casefold() == organization.casefold()
    if not in_organization or permission not in {"admin", "owner"}:
        raise PpmGitError(*FORGEJO_NOT_ADMINISTERED)


def _forgejo_person(*, user, workspace_id):
    """The person's name on the Git server (409 ``FORGEJO_ACCOUNT_REQUIRED`` before their first sign-in there) and the
    name of the workspace's organization (None until the access engine created or adopted it)."""
    username = PpmForgejoAccount.objects.filter(user_id=user.id).values_list("username", flat=True).first()
    if username is None:
        raise PpmGitError(*FORGEJO_ACCOUNT_REQUIRED)
    organization = (
        PpmForgejoOrganization.objects.filter(workspace_id=workspace_id).values_list("name", flat=True).first()
    )
    return username, organization


class _ListingPages:
    """``ForgejoAdminClient.request_timeout`` for the dialog's listing — the client's hook that gives the timeout of the
    next request or raises to stop before it: the usual timeouts, and no page past the limit."""

    def __init__(self, pages):
        self.left = pages

    def __call__(self):
        if self.left <= 0:
            raise PpmGitProviderError(*FORGEJO_TOO_MANY_REPOSITORIES)
        self.left -= 1
        return FORGEJO_REQUEST_TIMEOUT


def _administered_repositories(*, user, username, client=None):
    """Every repository the person administers on the Git server (any owner), as the dialog lists it. Read as that
    person (admin sudo — ``ForgejoAdminClient.list_repositories_as``, at most ``FORGEJO_LISTING_MAX_PAGES`` pages) and
    kept ``FORGEJO_LISTING_CACHE_SECONDS`` per person, so searching and paging the dialog do not ask the Git server
    again; a repository created a moment ago shows up within that minute. Failures are not kept."""
    key = f"{FORGEJO_LISTING_CACHE_PREFIX}{user.id}:{username.casefold()}"
    cached = cache.get(key)
    if isinstance(cached, list):
        return cached
    client = client or ForgejoAdminClient()
    client.request_timeout = _ListingPages(FORGEJO_LISTING_MAX_PAGES)
    try:
        payloads = client.list_repositories_as(username)
    except PpmGitProviderError as exc:
        if exc.code == "GIT_PROVIDER_NOT_FOUND":
            # The account is gone on the Git server (deleted or renamed there): the next sign-in brings it back.
            raise PpmGitError(*FORGEJO_ACCOUNT_REQUIRED) from exc
        raise _provider_error(exc) from exc
    items = [
        _listed_forgejo_repository(payload)
        for payload in payloads
        if isinstance(payload.get("permissions"), dict) and payload["permissions"].get("admin") is True
    ]
    cache.set(key, items, timeout=FORGEJO_LISTING_CACHE_SECONDS)
    return items


def _listed_forgejo_repository(payload):
    """A repository of the person's listing as ``ForgejoClient.search_repositories`` lists it for G2.1."""
    try:
        repository = normalize_forgejo_repository(payload)
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc
    return {
        **repository,
        "description": _clean_text(payload.get("description"), maximum=2048),
        "private": payload.get("private") is True,
    }


def _forgejo_repository_id(value):
    try:
        repository_id = int(value)
    except (TypeError, ValueError) as exc:
        raise PpmGitError("GIT_REPOSITORY_INVALID", "Выберите репозиторий Git-сервера.") from exc
    if repository_id <= 0:
        raise PpmGitError("GIT_REPOSITORY_INVALID", "Выберите репозиторий Git-сервера.")
    return repository_id


def forgejo_connection_is_current(connection, *, full_name):
    """G2.1 A2 fix round 1 — the one «already connected» rule: the 409 of connecting and `connected` in the list.

    The project's Forgejo connection of a repository is current while it is in an active state, is not halted, its
    record is active and it carries the repository's current full name. Anything else — renamed or moved
    (``GIT_REPOSITORY_MOVED``), halted, disconnected, or left on an archived record — is connected again, in place.
    """
    return (
        connection is not None
        and connection.status in ACTIVE_CONNECTION_STATUSES
        and not sync_halted(connection)
        and connection.repository.status == PpmGitRepositoryStatus.ACTIVE
        and connection.provider_full_name == full_name
    )


def connect_forgejo_repository(*, workspace_id, project_id, provider_repository_id, user_id, client=None):
    """G2.1 R7: connect a repository of PPM's Git server to the project (the view checks
    ``connect_git_server_repositories``, and for a project administrator — G2.2 R17 — also
    ``require_administered_forgejo_repository``).

    The project's Forgejo installation row (ppm-bot, installation id 1), the repository — matched with a manual G0.1
    record by its canonical URL, as GitHub does — and the active connection. A connection that is not current
    (``forgejo_connection_is_current``) is connected again in place; one left on an archived record brings that record
    back with its history (fix round 1). Returns ``(repository, connection)``.
    """
    _require_forgejo_configured()
    provider_repository_id = _forgejo_repository_id(provider_repository_id)
    client = client or get_provider_client(PpmGitProvider.FORGEJO)
    try:
        provider_data = client.get_repository(FORGEJO_INSTALLATION_ID, provider_repository_id)
        bot = client.get_current_user()
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc
    if provider_data["archived"]:
        raise PpmGitError("GIT_REPOSITORY_ARCHIVED", "Архивный репозиторий нельзя подключить к проекту.")

    payload = {
        "name": provider_data["name"],
        "provider": PpmGitProvider.FORGEJO,
        "canonical_url": provider_data["canonical_url"],
        "clone_https": provider_data["clone_https"],
        "clone_ssh": provider_data["clone_ssh"],
        "default_branch": provider_data["default_branch"],
        "visibility": provider_data["visibility"],
        "is_default": False,
    }
    trusted_origin = forgejo_trusted_origin()
    with transaction.atomic():
        installation, created = PpmGitInstallation.objects.select_for_update().get_or_create(
            workspace_id=workspace_id,
            project_id=project_id,
            provider=PpmGitProvider.FORGEJO,
            provider_installation_id=FORGEJO_INSTALLATION_ID,
            defaults={
                "provider_account_id": bot["id"],
                "account_login": bot["login"],
                "account_type": "User",
                "repository_selection": "all",
                "permissions": dict(FORGEJO_PERMISSIONS),
                "events": list(FORGEJO_EVENTS),
                "status": PpmGitInstallationStatus.ACTIVE,
                "created_by": user_id,
                "updated_by": user_id,
            },
        )
        if not created:
            installation.provider_account_id = bot["id"]
            installation.account_login = bot["login"]
            installation.permissions = dict(FORGEJO_PERMISSIONS)
            installation.events = list(FORGEJO_EVENTS)
            installation.status = PpmGitInstallationStatus.ACTIVE
            installation.revoked_at = None
            installation.updated_by = user_id
            installation.save()
        # The project's Forgejo connection of this repository, whatever the state of its record — at most one (unique
        # per project, installation and repository id).
        previous = (
            PpmGitConnection.objects.select_for_update(of=("self",))
            .select_related("repository")
            .filter(installation=installation, provider_repository_id=provider_repository_id)
            .first()
        )
        if forgejo_connection_is_current(previous, full_name=provider_data["full_name"]):
            raise PpmGitError("GIT_REPOSITORY_CONFLICT", "Репозиторий уже подключён к проекту.")
        repository = (
            PpmGitRepository.objects.select_for_update()
            .filter(
                workspace_id=workspace_id,
                project_id=project_id,
                status=PpmGitRepositoryStatus.ACTIVE,
                provider=PpmGitProvider.FORGEJO,
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
        restored = previous is not None and previous.repository.status != PpmGitRepositoryStatus.ACTIVE
        if restored:
            # The repository was removed from the project (its record archived): the same record comes back with its
            # history. Another active record of it (a manual one, by address) is not merged into it silently.
            if repository is not None:
                raise PpmGitError(
                    "GIT_REPOSITORY_RECORD_CONFLICT",
                    "В проекте есть ручная запись этого репозитория. Уберите её в разделе «Код» и подключите "
                    "репозиторий снова — вернётся прежняя запись с историей.",
                )
            repository = restore_repository(
                repository=previous.repository,
                payload=payload,
                user_id=user_id,
                trusted_origin=trusted_origin,
            )
            existing = previous
        else:
            existing = (
                PpmGitConnection.objects.select_for_update()
                .select_related("installation")
                .filter(repository=repository)
                .first()
                if repository is not None
                else None
            )
            if existing is not None and existing.installation.provider != PpmGitProvider.FORGEJO:
                # The record is connected through another provider: never re-point that connection.
                raise PpmGitError("GIT_REPOSITORY_CONFLICT", "Этот репозиторий уже подключён через другого провайдера.")
        if repository is None:
            repository = create_repository(
                workspace_id=workspace_id,
                project_id=project_id,
                payload=payload,
                user_id=user_id,
                trusted_origin=trusted_origin,
            )
        elif not restored:
            payload["is_default"] = repository.is_default
            repository = update_repository(
                repository=repository,
                payload=payload,
                user_id=user_id,
                trusted_origin=trusted_origin,
            )
        repository.provider_repository_id = provider_repository_id
        repository.provider_full_name = provider_data["full_name"]
        repository.updated_by = user_id
        repository.save(update_fields=["provider_repository_id", "provider_full_name", "updated_by", "updated_at"])
        if existing is None:
            try:
                with transaction.atomic():
                    connection = PpmGitConnection.objects.create(
                        workspace_id=workspace_id,
                        project_id=project_id,
                        installation=installation,
                        repository=repository,
                        provider_repository_id=provider_repository_id,
                        provider_full_name=provider_data["full_name"],
                        permissions=dict(FORGEJO_PERMISSIONS),
                        events=list(FORGEJO_EVENTS),
                        status=PpmGitConnectionStatus.ACTIVE,
                        created_by=user_id,
                        updated_by=user_id,
                    )
            except IntegrityError as exc:
                # The project keeps a connection of this repository on an archived record.
                raise PpmGitError("GIT_REPOSITORY_CONFLICT", "Репозиторий уже подключён к проекту.") from exc
        else:
            connection = existing
            cursor = dict(connection.sync_cursor) if isinstance(connection.sync_cursor, dict) else {}
            # A new connection starts synchronizing: a halt (for example «repository deleted») does not carry over.
            cursor.pop(SYNC_HALT_KEY, None)
            connection.installation = installation
            connection.provider_repository_id = provider_repository_id
            connection.provider_full_name = provider_data["full_name"]
            connection.permissions = dict(FORGEJO_PERMISSIONS)
            connection.events = list(FORGEJO_EVENTS)
            connection.status = PpmGitConnectionStatus.ACTIVE
            connection.sync_cursor = cursor
            connection.last_error_code = ""
            connection.last_error_message = ""
            connection.retry_after = None
            connection.disconnected_at = None
            connection.updated_by = user_id
            connection.save()
    return repository, connection


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
    _require_github_installation(installation)
    if installation.status != PpmGitInstallationStatus.ACTIVE:
        raise PpmGitError("GITHUB_INSTALLATION_INACTIVE", "Подключение GitHub App больше не активно.")
    _ensure_required_permissions(installation.permissions)
    try:
        return (client or GitHubAppClient()).list_repositories(installation.provider_installation_id)
    except PpmGitProviderError as exc:
        raise _provider_error(exc) from exc


def refresh_github_installation(*, installation, user_id, client=None):
    _require_github_installation(installation)
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
    _require_github_installation(installation)
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
    # G2.1: a halted connection is never synchronized by schedule or retry — only after «Обновить» lifted the halt.
    if sync_halted(connection) or not _mark_syncing(connection):
        return connection
    since = connection.sync_cursor.get("commits_since") if isinstance(connection.sync_cursor, dict) else None
    provider = connection.installation.provider
    # G2.1 A2: pushes the provider delivered only in part are read now; GitHub never has any.
    catch_up = _pending_catch_up(connection)
    options = {"since": since, "catch_up": catch_up} if catch_up else {"since": since}
    try:
        # G2.1: the client of the connection's provider (registry); `client=` stays for tests. Inside `try`: a provider
        # without a usable client (unknown, not configured) is recorded on the connection, never left «syncing».
        provider_client = client or get_provider_client(provider)
        values = provider_client.sync_repository(
            connection.installation.provider_installation_id,
            connection.provider_repository_id,
            connection.provider_full_name,
            **options,
        )
    except PpmGitProviderRateLimited as exc:
        _record_sync_error(connection, exc, rate_limited=True)
        raise
    except PpmGitProviderError as exc:
        _record_sync_error(connection, exc)
        if exc.code in REPOSITORY_MOVED_CODES:
            # G2.1 A2 fix round 1: another repository may carry the old name now — the indexed code leaves search.
            _purge_code_for_repositories([connection.repository_id])
        raise

    now = timezone.now()
    with transaction.atomic():
        connection = PpmGitConnection.objects.select_for_update().select_related("repository").get(id=connection.id)
        if sync_halted(connection):
            # G2.1: the provider halted the connection while this sync was reading it: its state wins, nothing stored.
            return connection
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
        cursor = {"commits_since": (now - timedelta(minutes=5)).isoformat()}
        # Ranges a delivery added while this synchronization was reading stay for the next one.
        remaining = [entry for entry in _pending_catch_up(connection) if entry not in catch_up]
        if remaining:
            cursor[CATCH_UP_KEY] = remaining
        connection.sync_cursor = cursor
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
    refresh = PROVIDER_REPOSITORY_REFRESHERS.get(provider)
    if refresh is not None:
        refresh(connection, provider_client)
    return connection


def _pending_catch_up(connection):
    """The valid ``CatchUpRange`` entries kept in the connection's cursor (anything else is dropped)."""
    cursor = connection.sync_cursor if isinstance(connection.sync_cursor, dict) else {}
    entries = cursor.get(CATCH_UP_KEY)
    if not isinstance(entries, list):
        return []
    return [entry for entry in (_catch_up_range(item) for item in entries) if entry is not None][-CATCH_UP_LIMIT:]


def _catch_up_range(value):
    if not isinstance(value, dict):
        return None
    ref, before, after, base = (value.get(key) for key in ("ref", "before", "after", "base"))
    if not isinstance(ref, str) or not ref.startswith("refs/heads/") or len(ref) > 512:
        return None
    if not isinstance(after, str) or not CATCH_UP_SHA.fullmatch(after):
        return None
    if not isinstance(before, str) or (before and not CATCH_UP_SHA.fullmatch(before)):
        return None
    if not isinstance(base, str) or len(base) > 255:
        return None
    return {"ref": ref, "before": before, "after": after, "base": base}


def _request_catch_up(connection, entry):
    """Keeps the range on the connection and queues its synchronization (once the delivery's writes are committed)."""
    from .tasks import reconcile_git_connection_task

    with transaction.atomic():
        locked = PpmGitConnection.objects.select_for_update().get(id=connection.id)
        cursor = dict(locked.sync_cursor) if isinstance(locked.sync_cursor, dict) else {}
        pending = [item for item in _pending_catch_up(locked) if item != entry]
        cursor[CATCH_UP_KEY] = [*pending, entry][-CATCH_UP_LIMIT:]
        locked.sync_cursor = cursor
        locked.save(update_fields=["sync_cursor", "updated_at"])
    connection.sync_cursor = cursor
    connection_id = str(connection.id)
    transaction.on_commit(lambda: reconcile_git_connection_task.delay(connection_id))


def _refresh_forgejo_clone_ssh(connection, client):
    """G2.1 A2 (controller ruling): with ``PPM_FORGEJO_SSH_ENABLED=0`` a Forgejo repository keeps no SSH address;
    switched back on, the address Forgejo reports returns. Best effort: the synchronization itself already succeeded."""
    repository = connection.repository
    if forgejo_ssh_enabled() == bool(repository.clone_ssh):
        return
    value = ""
    if forgejo_ssh_enabled():
        try:
            value = client.get_repository(FORGEJO_INSTALLATION_ID, connection.provider_repository_id)["clone_ssh"]
            trusted_origin = forgejo_trusted_origin()
            value = normalize_ssh_url(value, trusted_origin=trusted_origin)
            ensure_clone_scope(
                canonical_url=repository.canonical_url,
                clone_https=repository.clone_https,
                clone_ssh=value,
                trusted_origin=trusted_origin,
            )
        except (PpmGitProviderError, PpmGitError, AttributeError, KeyError, TypeError):
            return
        if not value:
            return
    PpmGitRepository.objects.filter(id=repository.id).update(clone_ssh=value, updated_at=timezone.now())
    repository.clone_ssh = value


# Provider-specific upkeep of the repository record after a successful synchronization.
PROVIDER_REPOSITORY_REFRESHERS = {
    PpmGitProvider.FORGEJO.value: _refresh_forgejo_clone_ssh,
}


def _mark_syncing(connection):
    """Marks the start of a sync unless a halt landed since the connection was read (one conditional UPDATE)."""
    now = timezone.now()
    marked = (
        PpmGitConnection.objects.filter(id=connection.id)
        .exclude(sync_cursor__has_key=SYNC_HALT_KEY)
        .update(status=PpmGitConnectionStatus.SYNCING, last_error_code="", last_error_message="", updated_at=now)
    )
    if marked:
        connection.status = PpmGitConnectionStatus.SYNCING
        connection.last_error_code = ""
        connection.last_error_message = ""
        connection.updated_at = now
    return bool(marked)


def upsert_git_object(*, connection, payload):
    object_type = payload.get("object_type")
    if object_type not in PpmGitObjectType.values:
        if connection.installation.provider == PpmGitProvider.GITHUB:
            raise PpmGitError("GITHUB_OBJECT_INVALID", "GitHub вернул неизвестный тип объекта.")
        raise PpmGitError("GIT_OBJECT_INVALID", "Git-сервер вернул неизвестный тип объекта.")
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
    # AF2.2 S2a: время слияния несёт только нормализованный PR; ветки, коммиты и webhook-доставки, сохранённые до
    # обновления, его не передают — известное значение не затирается.
    if "provider_merged_at" in payload:
        defaults["provider_merged_at"] = _coerce_datetime(payload.get("provider_merged_at"))
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


def create_delivery(*, delivery_id, event_name, raw_body_hash, normalized_payload, provider=PpmGitProvider.GITHUB):
    """Idempotent receipt of one delivery; delivery ids are unique per provider (G2.1)."""
    try:
        with transaction.atomic():
            delivery = PpmGitDelivery.objects.create(
                provider=provider,
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
            provider=provider,
            provider_delivery_id=delivery_id,
        )
        if delivery.body_sha256 != raw_body_hash:
            if provider == PpmGitProvider.GITHUB:
                raise PpmGitError("GITHUB_DELIVERY_CONFLICT", "Повторный webhook имеет другое содержимое.")
            raise PpmGitError(
                "GIT_DELIVERY_CONFLICT",
                "Повторное событие Git-сервера имеет другое содержимое.",
                status_code=http_status.HTTP_409_CONFLICT,
            )
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
        failure_code, failure_message = _delivery_failure(delivery.provider)
        delivery.status = PpmGitDeliveryStatus.FAILED
        delivery.last_error_code = getattr(exc, "code", failure_code)
        delivery.last_error_message = str(getattr(exc, "message", failure_message))[:500]
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
    """G2.1 R1e: a provider's normalizer (``webhooks.py``) decided what the delivery means; applying it is neutral.

    Installation-wide lifecycle events are provider-specific (GitHub App: ``LIFECYCLE_EVENT_APPLIERS``); everything else
    is a normalized repository event (``providers.base.NormalizedDelivery``) applied the same way for every provider.
    """
    payload = delivery.payload
    event_name = delivery.event_name
    if event_name == "ping" or payload.get("ignored"):
        return False
    lifecycle = LIFECYCLE_EVENT_APPLIERS.get((delivery.provider, event_name))
    if lifecycle is not None:
        return lifecycle(delivery, payload)
    directive = _connection_error_directive(payload)
    if directive is not None:
        return _apply_connection_error(delivery, directive)
    return _apply_repository_event(delivery, payload)


def _delivery_connections(delivery):
    """Active connections of exactly this delivery's provider and repository (R1d): the numeric ids of different
    providers may coincide, so the provider is always part of the match. A halted connection takes no events until
    «Обновить»; the synchronization after it recovers what was missed."""
    return _followed_connections(
        provider=delivery.provider,
        repository_id=delivery.provider_repository_id,
        installation_id=delivery.provider_installation_id,
    )


def _followed_connections(*, provider, repository_id, installation_id):
    connections = (
        PpmGitConnection.objects.select_related("repository")
        .filter(
            installation__provider=provider,
            provider_repository_id=repository_id,
            status__in=ACTIVE_CONNECTION_STATUSES,
        )
        .exclude(sync_cursor__has_key=SYNC_HALT_KEY)
    )
    if installation_id is not None:
        connections = connections.filter(installation__provider_installation_id=installation_id)
    # Without an installation id — GitHub repository webhooks, a supported fallback for local/self-hosted PPM whose
    # payloads carry the repository id but no installation object — the provider and the repository id decide.
    return connections


def unfollowed_delivery_payload(*, provider, normalized):
    """G2.1 A2 fix round 1: what the receipt of a delivery keeps. A repository no connection follows (the system webhook
    of the Git server sends every repository of the server; a halted connection takes no events either) keeps only the
    event, the action and the ids — no commit messages, titles, branches or authors; it is ignored when processed. The
    connections are matched exactly as processing matches them (``_delivery_connections``)."""
    if normalized.get("ignored") is True:
        return normalized
    repository_id = normalized.get("repository_id")
    if (
        repository_id is not None
        and _followed_connections(
            provider=provider,
            repository_id=repository_id,
            installation_id=normalized.get("installation_id"),
        ).exists()
    ):
        return normalized
    return {**{key: normalized[key] for key in UNFOLLOWED_DELIVERY_KEYS if key in normalized}, "ignored": True}


def purge_old_deliveries(*, now=None):
    """Removes handled receipts (processed or ignored) handled more than ``DELIVERY_RETENTION`` ago — of every provider;
    returns how many. The period counts from ``processed_at``, set exactly when a receipt turns processed or ignored.
    Failed and pending receipts stay: the scheduled job still retries them."""
    cutoff = (now or timezone.now()) - DELIVERY_RETENTION
    ids = list(
        PpmGitDelivery.objects.filter(
            status__in=[PpmGitDeliveryStatus.PROCESSED, PpmGitDeliveryStatus.IGNORED],
            processed_at__isnull=False,
            processed_at__lt=cutoff,
        ).values_list("id", flat=True)[:DELIVERY_PURGE_BATCH]
    )
    if ids:
        PpmGitDelivery.objects.filter(id__in=ids).delete()
    return len(ids)


def _repository_event_kind(payload):
    if "branch" in payload or "commits" in payload:
        return "ref_update"  # push, branch created or deleted
    if "pull_request" in payload:
        return "pull_request"
    return None


def _repository_event_objects(kind, payload):
    if kind == "ref_update":
        return [payload.get("branch"), *payload.get("commits", [])]
    return [payload.get("pull_request")]


def _apply_repository_event(delivery, payload):
    kind = _repository_event_kind(payload)
    if kind is None:
        # Nothing PPM stores (an event a normalizer kept without content): accepted, no connection is touched.
        return False
    processed = False
    # G2.1 A2: the provider cut this push — a synchronization reads the rest (`providers.base.CatchUpRange`).
    catch_up = _catch_up_range(payload.get("catch_up")) if kind == "ref_update" else None
    for connection in _delivery_connections(delivery):
        for object_payload in _repository_event_objects(kind, payload):
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
        if kind == "ref_update":
            _handle_code_push(connection=connection, payload=payload)
        if catch_up is not None:
            _request_catch_up(connection, catch_up)
    return processed


def _connection_error_directive(payload):
    directive = payload.get("connection_error")
    if not isinstance(directive, dict):
        return None
    code = directive.get("code")
    message = directive.get("message")
    if not isinstance(code, str) or not CONNECTION_ERROR_CODE.fullmatch(code):
        return None
    if not isinstance(message, str) or not message.strip():
        return None
    return {
        "code": code,
        "message": message.strip()[:500],
        "purge_code": directive.get("purge_code") is True,
        "halt_sync": directive.get("halt_sync") is True,
    }


def _apply_connection_error(delivery, directive):
    """The provider reports that the repository can no longer be synchronized (for example it was deleted): the
    connection shows the error, the Git history (objects, links) stays, the code index is dropped only on request.

    Without ``halt_sync`` the state is temporary: the next successful synchronization (scheduled or manual) clears it.
    With ``halt_sync`` the connection also gets the halt marker and waits for «Обновить» (``resume_connection_sync``).
    The rows are locked, so a synchronization running right now either finishes first or sees the halt."""
    now = timezone.now()
    with transaction.atomic():
        connections = list(_delivery_connections(delivery).select_for_update(of=("self",)))
        for connection in connections:
            connection.status = PpmGitConnectionStatus.ERROR
            connection.last_error_code = directive["code"]
            connection.last_error_message = directive["message"]
            connection.retry_after = None
            connection.last_event_at = now
            update_fields = ["status", "last_error_code", "last_error_message", "retry_after", "last_event_at"]
            if directive["halt_sync"]:
                cursor = dict(connection.sync_cursor) if isinstance(connection.sync_cursor, dict) else {}
                cursor[SYNC_HALT_KEY] = {"code": directive["code"], "at": now.isoformat()}
                connection.sync_cursor = cursor
                update_fields.append("sync_cursor")
            connection.save(update_fields=[*update_fields, "updated_at"])
    if directive["purge_code"]:
        _purge_code_for_repositories([connection.repository_id for connection in connections])
    return bool(connections)


def _apply_installation_event(delivery, payload):
    action = payload.get("action")
    installation_id = payload.get("installation_id")
    installations = PpmGitInstallation.objects.filter(
        provider=delivery.provider,
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


def _apply_installation_repositories_event(delivery, payload):
    removed = payload.get("repositories_removed", [])
    if not removed:
        return False
    connections = PpmGitConnection.objects.filter(
        installation__provider=delivery.provider,
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


# GitHub App lifecycle (G1.1): installation-wide events only GitHub sends. Repository-level states of any provider come
# as normalized content (``NormalizedDelivery.connection_error``), not as appliers here.
LIFECYCLE_EVENT_APPLIERS = {
    (PpmGitProvider.GITHUB.value, "installation"): _apply_installation_event,
    (PpmGitProvider.GITHUB.value, "installation_repositories"): _apply_installation_repositories_event,
}


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
    connection.updated_at = timezone.now()
    # G2.1: a halt that landed during this sync keeps the directive's own code and text (one conditional UPDATE).
    PpmGitConnection.objects.filter(id=connection.id).exclude(sync_cursor__has_key=SYNC_HALT_KEY).update(
        status=connection.status,
        last_error_code=connection.last_error_code,
        last_error_message=connection.last_error_message,
        retry_after=connection.retry_after,
        updated_at=connection.updated_at,
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


def _delivery_failure(provider):
    if provider == PpmGitProvider.GITHUB:
        return "GITHUB_DELIVERY_FAILED", "Не удалось обработать событие GitHub."
    return "GIT_DELIVERY_FAILED", "Не удалось обработать событие Git-сервера."


def _require_github_installation(installation):
    """GitHub App flows accept only GitHub installations: another provider's installation lives in the same table
    (G2.1) and must never reach the GitHub API."""
    if installation.provider != PpmGitProvider.GITHUB:
        raise PpmGitError("GITHUB_INSTALLATION_NOT_FOUND", "Установка GitHub App не найдена.")


def _require_github_configured():
    if not github_app_is_configured():
        raise PpmGitError(
            "GITHUB_APP_NOT_CONFIGURED",
            "GitHub App ещё не настроен администратором PPM.",
        )


def _require_forgejo_configured():
    if not forgejo_is_configured():
        raise PpmGitError("FORGEJO_NOT_CONFIGURED", "Git-сервер PPM ещё не настроен администратором сервера.")


def _page_number(value):
    try:
        page = int(value)
    except (TypeError, ValueError) as exc:
        raise PpmGitError("GIT_INVALID_FIELD", "Номер страницы некорректен.", {"field": "page"}) from exc
    if not 1 <= page <= FORGEJO_MAX_PAGE:
        raise PpmGitError("GIT_INVALID_FIELD", "Номер страницы некорректен.", {"field": "page"})
    return page


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
