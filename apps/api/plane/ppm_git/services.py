import ipaddress
import re
import uuid
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit, urlunsplit

from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.db.models import Issue

from .models import (
    PpmGitLink,
    PpmGitObjectType,
    PpmGitProvider,
    PpmGitRepository,
    PpmGitRepositoryStatus,
    PpmGitVisibility,
)
from .providers.forgejo import forgejo_trusted_origin


CONTROL = re.compile(r"[\x00-\x1f\x7f]")
CONTROL_OR_SPACE = re.compile(r"[\x00-\x20\x7f]")
HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
SCP_SSH = re.compile(r"^git@(?P<host>[^:/]+):(?P<path>[^?#]+)$")
FORBIDDEN_FIELDS = {"credential", "credentials", "password", "private_key", "secret", "token"}


@dataclass
class PpmGitError(Exception):
    code: str
    message: str
    details: dict | None = None
    # Explicit HTTP status for errors whose status depends on the step (G1.3 write flow); None → views.error_status.
    status_code: int | None = None


def normalize_name(value, *, field="name", maximum=160):
    if not isinstance(value, str):
        raise PpmGitError("GIT_INVALID_FIELD", "Поле должно быть строкой.", {"field": field})
    normalized = " ".join(value.strip().split())
    if not normalized or len(normalized) > maximum or CONTROL.search(normalized):
        raise PpmGitError("GIT_INVALID_FIELD", "Проверьте заполнение поля.", {"field": field})
    return normalized


def reject_credential_fields(payload):
    for key in payload:
        normalized = str(key).casefold().replace("-", "_")
        if normalized in FORBIDDEN_FIELDS or any(part in FORBIDDEN_FIELDS for part in normalized.split("_")):
            raise PpmGitError(
                "GIT_CREDENTIALS_FORBIDDEN",
                "PPM не принимает и не хранит учётные данные поставщика Git.",
                {"field": str(key)},
            )


def parse_uuid(value, *, field):
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise PpmGitError("GIT_INVALID_FIELD", "Идентификатор некорректен.", {"field": field}) from exc


def trusted_git_origin(provider):
    """G2.1 A2: ``(host, port)`` of PPM's own Git server for a repository of ``provider`` — else None.

    Stored Git links never point at local-looking hosts (``_safe_host``). The one exception is the Git server the
    operator configured in ``PPM_FORGEJO_PUBLIC_URL`` (https): exactly that host and port, only for Forgejo repositories
    — a local stack serves it on ``git.<…>.localhost``. A manual (G0.1) record never gets it.
    """
    if provider != PpmGitProvider.FORGEJO:
        return None
    return forgejo_trusted_origin()


def _trusted_host(trusted_origin, port):
    """The trusted host when ``port`` (``None`` = 443) is exactly the trusted origin's port."""
    if trusted_origin is None:
        return None
    host, trusted_port = trusted_origin
    return host if (port or 443) == trusted_port else None


def _port(parsed):
    try:
        return parsed.port, None
    except ValueError as exc:
        return None, exc


def _safe_host(raw_host, *, trusted=None):
    if not raw_host:
        raise PpmGitError("GIT_INVALID_URL", "В Git-ссылке отсутствует домен.")
    try:
        host = raw_host.rstrip(".").encode("idna").decode("ascii").casefold()
    except UnicodeError as exc:
        raise PpmGitError("GIT_INVALID_URL", "Домен Git-ссылки некорректен.") from exc

    if trusted is not None and host == trusted:
        return host
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise PpmGitError("GIT_UNSAFE_URL", "Локальные адреса нельзя сохранять как репозитории Git.")
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        if len(host) > 253 or any(not HOST_LABEL.fullmatch(label) for label in host.split(".")):
            raise PpmGitError("GIT_INVALID_URL", "Домен Git-ссылки некорректен.")
    else:
        if not address.is_global:
            raise PpmGitError("GIT_UNSAFE_URL", "Приватные и локальные IP-адреса запрещены.")
    return host


def _safe_repository_path(path):
    decoded = unquote(path)
    if not decoded.startswith("/") or decoded in {"", "/"} or "\\" in decoded or "//" in decoded:
        raise PpmGitError("GIT_INVALID_URL", "В Git-ссылке отсутствует корректный путь репозитория.")
    segments = [segment for segment in decoded.split("/") if segment]
    if not segments or any(segment in {".", ".."} or CONTROL_OR_SPACE.search(segment) for segment in segments):
        raise PpmGitError("GIT_INVALID_URL", "Путь репозитория Git некорректен.")
    return "/" + "/".join(segments)


def normalize_https_url(value, *, canonical=False, trusted_origin=None):
    if not isinstance(value, str) or not value or len(value) > 2048 or CONTROL_OR_SPACE.search(value):
        raise PpmGitError("GIT_INVALID_URL", "Укажите корректную HTTPS-ссылку.")
    parsed = urlsplit(value.strip())
    if parsed.scheme.casefold() != "https" or parsed.username or parsed.password:
        raise PpmGitError("GIT_INVALID_URL", "Разрешены только HTTPS-ссылки без учётных данных.")
    if parsed.query or parsed.fragment:
        raise PpmGitError("GIT_INVALID_URL", "Параметры запроса и якорь нельзя сохранять в Git-ссылке.")
    port, port_error = _port(parsed)
    # The host is checked first, as before G2.1; a broken port never makes a host trusted.
    host = _safe_host(parsed.hostname, trusted=None if port_error else _trusted_host(trusted_origin, port))
    if port_error is not None:
        raise PpmGitError("GIT_INVALID_URL", "Порт Git-ссылки некорректен.") from port_error
    netloc = host if port in (None, 443) else f"{host}:{port}"
    path = _safe_repository_path(parsed.path).rstrip("/")
    if canonical and path.casefold().endswith(".git"):
        path = path[:-4]
    return urlunsplit(("https", netloc, path, "", ""))


def _repository_identity_from_https(value, *, trusted_origin=None):
    parsed = urlsplit(value)
    path = _safe_repository_path(parsed.path).rstrip("/")
    if path.casefold().endswith(".git"):
        path = path[:-4]
    port, port_error = _port(parsed)
    return _safe_host(parsed.hostname, trusted=None if port_error else _trusted_host(trusted_origin, port)), path


def normalize_ssh_url(value, *, trusted_origin=None):
    """SSH clone address; with ``trusted_origin`` its host may be the Git server's (any SSH port: the identity check
    ties the address to the HTTPS one)."""
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or len(value) > 2048 or CONTROL_OR_SPACE.search(value):
        raise PpmGitError("GIT_INVALID_SSH_URL", "Укажите стандартный SSH-адрес клонирования.")
    trusted = trusted_origin[0] if trusted_origin else None
    raw = value.strip()
    match = SCP_SSH.fullmatch(raw)
    if match:
        host = _safe_host(match.group("host"), trusted=trusted)
        path = _safe_repository_path("/" + match.group("path")).lstrip("/")
        return f"git@{host}:{path}"

    parsed = urlsplit(raw)
    if parsed.scheme.casefold() != "ssh" or parsed.username != "git" or parsed.password:
        raise PpmGitError("GIT_INVALID_SSH_URL", "Разрешены только стандартные SSH-ссылки пользователя git.")
    if parsed.query or parsed.fragment:
        raise PpmGitError("GIT_INVALID_SSH_URL", "Параметры запроса и якорь нельзя сохранять в SSH-ссылке.")
    host = _safe_host(parsed.hostname, trusted=trusted)
    try:
        port = parsed.port
    except ValueError as exc:
        raise PpmGitError("GIT_INVALID_SSH_URL", "Порт SSH-ссылки некорректен.") from exc
    path = _safe_repository_path(parsed.path)
    netloc = f"git@{host}" if port in (None, 22) else f"git@{host}:{port}"
    return urlunsplit(("ssh", netloc, path, "", ""))


def _repository_identity_from_ssh(value, *, trusted_origin=None):
    trusted = trusted_origin[0] if trusted_origin else None
    if value.startswith("git@"):
        match = SCP_SSH.fullmatch(value)
        return _safe_host(match.group("host"), trusted=trusted), "/" + match.group("path").removesuffix(".git")
    parsed = urlsplit(value)
    return _safe_host(parsed.hostname, trusted=trusted), _safe_repository_path(parsed.path).removesuffix(".git")


def ensure_clone_scope(*, canonical_url, clone_https, clone_ssh, trusted_origin=None):
    identity = _repository_identity_from_https(canonical_url, trusted_origin=trusted_origin)
    if _repository_identity_from_https(clone_https, trusted_origin=trusted_origin) != identity:
        raise PpmGitError("GIT_URL_SCOPE_MISMATCH", "HTTPS-адрес клонирования относится к другому репозиторию.")
    if clone_ssh and _repository_identity_from_ssh(clone_ssh, trusted_origin=trusted_origin) != identity:
        raise PpmGitError("GIT_URL_SCOPE_MISMATCH", "SSH-адрес клонирования относится к другому репозиторию.")


def normalize_git_object_url(value, *, repository):
    # G2.1 A2: objects of a Forgejo repository live on PPM's Git server — its configured host is trusted exactly.
    trusted_origin = trusted_git_origin(repository.provider)
    normalized = normalize_https_url(value, trusted_origin=trusted_origin)
    repo_host, repo_path = _repository_identity_from_https(repository.canonical_url, trusted_origin=trusted_origin)
    object_host, object_path = _repository_identity_from_https(normalized, trusted_origin=trusted_origin)
    if object_host != repo_host or object_path == repo_path or not object_path.startswith(f"{repo_path}/"):
        raise PpmGitError("GIT_URL_SCOPE_MISMATCH", "Git-объект должен принадлежать выбранному репозиторию.")
    return normalized


def detect_provider(canonical_url):
    host = urlsplit(canonical_url).hostname or ""
    if host == "github.com":
        return PpmGitProvider.GITHUB
    if host == "gitlab.com":
        return PpmGitProvider.GITLAB
    if host == "bitbucket.org":
        return PpmGitProvider.BITBUCKET
    return PpmGitProvider.GENERIC


def validate_repository_data(payload, *, current=None, trusted_origin=None):
    """``trusted_origin`` (G2.1 A2): the Git server's ``(host, port)`` for a record of the Forgejo provider — passed by
    the Forgejo connect flow and kept for an existing Forgejo record; a manual record never gets it."""
    reject_credential_fields(payload)
    allowed = {
        "name",
        "provider",
        "canonical_url",
        "clone_https",
        "clone_ssh",
        "default_branch",
        "visibility",
        "is_default",
    }
    unknown = set(payload) - allowed
    if unknown:
        raise PpmGitError("GIT_UNSUPPORTED_FIELD", "Передано неподдерживаемое поле.", {"fields": sorted(unknown)})

    def value(key, fallback=""):
        return payload[key] if key in payload else getattr(current, key, fallback)

    name = normalize_name(value("name"), field="name")
    # Only a record that is (and stays) of the Forgejo provider may use the Git server's host; `detect_provider` never
    # answers «forgejo».
    if value("provider") != PpmGitProvider.FORGEJO:
        trusted_origin = None
    canonical_url = normalize_https_url(value("canonical_url"), canonical=True, trusted_origin=trusted_origin)
    clone_https_raw = value("clone_https") or f"{canonical_url}.git"
    clone_https = normalize_https_url(clone_https_raw, trusted_origin=trusted_origin)
    clone_ssh = normalize_ssh_url(value("clone_ssh"), trusted_origin=trusted_origin)
    ensure_clone_scope(
        canonical_url=canonical_url,
        clone_https=clone_https,
        clone_ssh=clone_ssh,
        trusted_origin=trusted_origin,
    )
    provider = value("provider") or detect_provider(canonical_url)
    if provider not in PpmGitProvider.values:
        raise PpmGitError("GIT_INVALID_FIELD", "Неизвестный поставщик Git.", {"field": "provider"})
    visibility = value("visibility") or PpmGitVisibility.UNKNOWN
    if visibility not in PpmGitVisibility.values:
        raise PpmGitError("GIT_INVALID_FIELD", "Неизвестный режим видимости репозитория.", {"field": "visibility"})
    default_branch = value("default_branch") or ""
    if not isinstance(default_branch, str) or len(default_branch) > 255 or CONTROL_OR_SPACE.search(default_branch):
        raise PpmGitError("GIT_INVALID_FIELD", "Название основной ветки некорректно.", {"field": "default_branch"})
    is_default = value("is_default", False)
    if not isinstance(is_default, bool):
        raise PpmGitError("GIT_INVALID_FIELD", "Признак основного репозитория должен быть логическим значением.")
    return {
        "name": name,
        "normalized_name": name.casefold(),
        "provider": provider,
        "canonical_url": canonical_url,
        "clone_https": clone_https,
        "clone_ssh": clone_ssh,
        "default_branch": default_branch.strip(),
        "visibility": visibility,
        "is_default": is_default,
    }


def create_repository(*, workspace_id, project_id, payload, user_id, trusted_origin=None):
    values = validate_repository_data(payload, trusted_origin=trusted_origin)
    try:
        with transaction.atomic():
            repositories = PpmGitRepository.objects.select_for_update().filter(
                workspace_id=workspace_id,
                project_id=project_id,
                status=PpmGitRepositoryStatus.ACTIVE,
            )
            if values["is_default"] or not repositories.exists():
                repositories.update(is_default=False)
                values["is_default"] = True
            return PpmGitRepository.objects.create(
                workspace_id=workspace_id,
                project_id=project_id,
                created_by=user_id,
                updated_by=user_id,
                **values,
            )
    except IntegrityError as exc:
        raise PpmGitError("GIT_REPOSITORY_CONFLICT", "Такой репозиторий уже добавлен в проект.") from exc


def update_repository(*, repository, payload, user_id, trusted_origin=None):
    if trusted_origin is None:
        # An existing Forgejo record keeps its Git server trusted (for example a PATCH of `is_default`).
        trusted_origin = trusted_git_origin(repository.provider)
    values = validate_repository_data(payload, current=repository, trusted_origin=trusted_origin)
    try:
        with transaction.atomic():
            locked = PpmGitRepository.objects.select_for_update().get(id=repository.id)
            active = PpmGitRepository.objects.select_for_update().filter(
                workspace_id=locked.workspace_id,
                project_id=locked.project_id,
                status=PpmGitRepositoryStatus.ACTIVE,
            )
            if values["is_default"]:
                active.exclude(id=locked.id).update(is_default=False)
            elif locked.is_default:
                raise PpmGitError("GIT_DEFAULT_REQUIRED", "У проекта должен оставаться основной репозиторий.")
            for field, value in values.items():
                setattr(locked, field, value)
            locked.updated_by = user_id
            locked.save(update_fields=[*values.keys(), "updated_by", "updated_at"])
            return locked
    except IntegrityError as exc:
        raise PpmGitError("GIT_REPOSITORY_CONFLICT", "Такой репозиторий уже добавлен в проект.") from exc


def archive_repository(*, repository, user_id):
    with transaction.atomic():
        locked = PpmGitRepository.objects.select_for_update().get(id=repository.id)
        was_default = locked.is_default
        locked.status = PpmGitRepositoryStatus.ARCHIVED
        locked.is_default = False
        locked.updated_by = user_id
        locked.archived_at = timezone.now()
        locked.save(update_fields=["status", "is_default", "updated_by", "archived_at", "updated_at"])
        if was_default:
            next_repository = (
                PpmGitRepository.objects.select_for_update()
                .filter(
                    workspace_id=locked.workspace_id,
                    project_id=locked.project_id,
                    status=PpmGitRepositoryStatus.ACTIVE,
                )
                .order_by("created_at", "id")
                .first()
            )
            if next_repository:
                next_repository.is_default = True
                next_repository.updated_by = user_id
                next_repository.save(update_fields=["is_default", "updated_by", "updated_at"])
        return locked


def restore_repository(*, repository, payload, user_id, trusted_origin=None):
    """G2.1 A2 fix round 1: an archived record comes back — its repository of the Git server is connected again — with
    its history (objects, links, index policy). It is the default one when the project has no other active record."""
    values = validate_repository_data(payload, current=repository, trusted_origin=trusted_origin)
    try:
        with transaction.atomic():
            locked = PpmGitRepository.objects.select_for_update().get(id=repository.id)
            others = PpmGitRepository.objects.select_for_update().filter(
                workspace_id=locked.workspace_id,
                project_id=locked.project_id,
                status=PpmGitRepositoryStatus.ACTIVE,
            )
            values["is_default"] = not others.exists()
            for field, value in values.items():
                setattr(locked, field, value)
            locked.status = PpmGitRepositoryStatus.ACTIVE
            locked.archived_at = None
            locked.updated_by = user_id
            locked.save(update_fields=[*values.keys(), "status", "archived_at", "updated_by", "updated_at"])
            return locked
    except IntegrityError as exc:
        raise PpmGitError("GIT_REPOSITORY_CONFLICT", "Такой репозиторий уже добавлен в проект.") from exc


def create_link(*, workspace_id, project_id, payload, user_id):
    reject_credential_fields(payload)
    allowed = {"repository_id", "work_item_id", "object_type", "ref", "title", "canonical_url"}
    unknown = set(payload) - allowed
    if unknown:
        raise PpmGitError("GIT_UNSUPPORTED_FIELD", "Передано неподдерживаемое поле.", {"fields": sorted(unknown)})
    repository_id = parse_uuid(payload.get("repository_id"), field="repository_id")
    work_item_id = parse_uuid(payload.get("work_item_id"), field="work_item_id")
    repository = PpmGitRepository.objects.filter(
        id=repository_id,
        workspace_id=workspace_id,
        project_id=project_id,
        status=PpmGitRepositoryStatus.ACTIVE,
    ).first()
    if repository is None:
        raise PpmGitError("GIT_REPOSITORY_NOT_FOUND", "Репозиторий не найден.")
    work_item = (
        Issue.objects.select_related("project")
        .filter(
            id=work_item_id,
            workspace_id=workspace_id,
            project_id=project_id,
            deleted_at__isnull=True,
        )
        .first()
    )
    if work_item is None:
        raise PpmGitError("GIT_WORK_ITEM_NOT_FOUND", "Задача не найдена в этом проекте.")
    object_type = payload.get("object_type")
    if object_type not in PpmGitObjectType.values:
        raise PpmGitError(
            "GIT_INVALID_FIELD",
            "Выберите ветку, коммит или запрос на слияние.",
            {"field": "object_type"},
        )
    ref = str(payload.get("ref") or "").strip()
    if len(ref) > 255 or CONTROL_OR_SPACE.search(ref):
        raise PpmGitError("GIT_INVALID_FIELD", "Ветка, хеш или номер Git-объекта некорректны.", {"field": "ref"})
    title = normalize_name(payload.get("title") or ref or object_type, field="title", maximum=255)
    canonical_url = normalize_git_object_url(payload.get("canonical_url"), repository=repository)
    try:
        return PpmGitLink.objects.create(
            workspace_id=workspace_id,
            project_id=project_id,
            repository=repository,
            work_item=work_item,
            object_type=object_type,
            ref=ref,
            title=title,
            canonical_url=canonical_url,
            created_by=user_id,
            updated_by=user_id,
        )
    except IntegrityError as exc:
        raise PpmGitError("GIT_LINK_CONFLICT", "Эта Git-ссылка уже связана с задачей.") from exc
