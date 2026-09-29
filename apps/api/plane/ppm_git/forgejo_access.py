"""G2.2 B (R8–R16) — PPM keeps people's accounts and code access on its own Git server (Forgejo 15).

The contract other lines use (plan «G2.2», fixed names):

- ``forgejo_sso_is_configured()`` — single sign-on is on (``PPM_GIT_SSO_ENABLED``), the Git server is configured (G2.1),
  and the administration token and the id of the sign-in source «PPM» are set. Otherwise nothing here does anything
  and the tables of migration 0009 are never read (the owner's dev API runs without that migration).
- ``ensure_account_for_login(user)`` — R9, called by the OIDC token endpoint before tokens are issued: the person's
  account is looked up by (sign-in source, ``login_name`` = the person's UUID) first — Forgejo keeps no uniqueness of
  that pair, PPM does — else one is created with ``must_change_password: false`` and no password. Name and e-mail are
  reconciled with a PATCH (sign-in never updates them). A retry after a failure never creates a second account. An
  existing local account is never adopted (security review 2026-09-29: it keeps its own password, tokens and SSH keys
  PPM cannot revoke, and an e-mail in Forgejo proves nothing): a taken name gets a suffix, a taken e-mail refuses the
  sign-in with a problem for the administrator.
- ``apply_user_access(user, budget_seconds=5.0)`` — R11–R15 for one person within a hard time budget (the lock wait and
  every request included); the rest goes to a background synchronization (``False``).
- ``forgejo_username_for(user)`` — the person's Git server name (the OIDC ``nickname``/``preferred_username``).
- ``schedule_access_sync(...)`` — R16: one delayed (≈5 s) task per burst of changes, scopes merged in the cache.

The model (R11–R15): a workspace is a private organization (an existing one with the workspace's name is adopted; a
name a person holds gets a suffix); a project has up to three teams — ``<KEY>-admin`` (administrators, may create
repositories in the organization), ``<KEY>`` (members, write), ``<KEY>-read`` (guests) — created when first needed,
non-admin ones with ``units_map`` only; a team with that name PPM does not manage is never taken over (PPM's own gets
``-ppm``; only a team described «PPM: …» — PPM's, whose creation answer was lost — is adopted); the project's active
Forgejo connections that lie in the organization are in every team of the project (a repository elsewhere is reported,
not managed); a person leaves the teams of a project or workspace they left; a disabled or deleted person is locked out
(``prohibit_login``) and leaves every PPM team; PPM's global administrators are administrators of the Git server.

What PPM touches is decided by what an account is, not by its name: PPM changes (and adds to or removes from its
teams) only its own accounts — bound to its sign-in source with a PPM person's UUID and recorded by PPM. Never the
owner of the administration token, never an account made an administrator by somebody else, never any other account
(ppm-bot, the emergency administrator, local accounts of the «Быстрый» mode): they keep their flags and their team
memberships. The Owners team is never touched.

The full reconciliation (every 10 minutes and on demand) brings every PPM account, organization and team back to this
model: members PPM did not give are removed (its own accounts only), permissions, units and descriptions restored,
repositories aligned, the teams of deleted projects deleted and those of re-keyed projects renamed. It works only with
people who already have an account (it appears at their first sign-in) — it never creates accounts. Every change goes
to ``PpmGitAudit`` (``forgejo.access.*``, without an actor); every run to ``PpmForgejoSyncRun`` (counts and at most 50
plain problems). Secrets never reach a record, a log or an exception: only safe codes and Russian texts do.
"""

import logging
import re
import time
import unicodedata
import uuid
from collections import Counter
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from plane.db.models import Project, ProjectMember, User, Workspace, WorkspaceMember
from plane.ppm_canvas.models import PpmGlobalAdmin

from .forgejo_admin import TEAM_UNITS, ForgejoAdminClient
from .models import (
    PpmForgejoAccount,
    PpmForgejoOrganization,
    PpmForgejoSyncKind,
    PpmForgejoSyncRun,
    PpmForgejoSyncStatus,
    PpmForgejoTeam,
    PpmForgejoTeamRole,
    PpmGitAudit,
    PpmGitConnection,
    PpmGitProvider,
    PpmGitRepositoryStatus,
)
from .providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from .providers.forgejo import REQUEST_TIMEOUT, forgejo_is_configured

logger = logging.getLogger(__name__)

USERNAME_LIMIT = 39  # R10
ORGANIZATION_NAME_LIMIT = 40  # R11: Forgejo's MaxSize(40)
FULL_NAME_LIMIT = 100  # Forgejo's MaxSize(100) of a full name
# Forgejo cuts a team description longer than 255 BYTES when the team is edited, breaking the last character — a
# longer one would drift on every reconciliation (live Forgejo 15, S2a report §0).
DESCRIPTION_BYTES = 255
DESCRIPTION_PREFIX = "PPM: "
TEAM_SUFFIX = "-ppm"
NAME_ATTEMPTS = 50
PROBLEM_LIMIT = 50
LOGIN_BUDGET_SECONDS = 5.0
# A request is not started with less than this left of the budget: it could not finish in time anyway.
BUDGET_MARGIN_SECONDS = 0.05
SYNC_DELAY_SECONDS = 5
RETRY_SECONDS = 30
MAX_RETRY_SECONDS = 600
MAX_ATTEMPTS = 5
RUN_RETENTION_DAYS = 30
FULL_LOCK_SECONDS = 15 * 60
SCOPED_LOCK_SECONDS = 5 * 60
LOGIN_LOCK_WAIT_SECONDS = 1.0
USER_LOCK_SECONDS = 60
USER_LOCK_WAIT_SECONDS = 10.0
SCHEDULED_SECONDS = 60
PENDING_SECONDS = 24 * 60 * 60

LOCK_KEY = "ppm:git:forgejo-access:lock"
PENDING_KEY = "ppm:git:forgejo-access:pending"
PENDING_LOCK_KEY = "ppm:git:forgejo-access:pending-lock"
SCHEDULED_KEY = "ppm:git:forgejo-access:scheduled"
USER_LOCK_PREFIX = "ppm:git:forgejo-access:account:"

ROLE_BY_PPM_ROLE = {20: PpmForgejoTeamRole.ADMIN, 15: PpmForgejoTeamRole.WRITE, 5: PpmForgejoTeamRole.READ}
ROLE_ORDER = (PpmForgejoTeamRole.ADMIN, PpmForgejoTeamRole.WRITE, PpmForgejoTeamRole.READ)
ROLE_TITLES = {
    PpmForgejoTeamRole.ADMIN: "Администратор",
    PpmForgejoTeamRole.WRITE: "Запись",
    PpmForgejoTeamRole.READ: "Чтение",
}
# Forgejo 15 `models/user/user.go` (reservedUsernames, reservedUserPatterns), checked at v15.0.9.
RESERVED_NAMES = frozenset(
    {
        ".",
        "..",
        "-",
        ".well-known",
        "api",
        "metrics",
        "v2",
        "assets",
        "attachments",
        "avatar",
        "avatars",
        "repo-avatars",
        "captcha",
        "login",
        "org",
        "repo",
        "user",
        "admin",
        "explore",
        "issues",
        "pulls",
        "milestones",
        "notifications",
        "report_abuse",
        "favicon.ico",
        "manifest.json",
        "robots.txt",
        "sitemap.xml",
        "ssh_info",
        "swagger.v1.json",
        "ghost",
        "gitea-actions",
        "forgejo-actions",
    }
)
RESERVED_SUFFIXES = (".keys", ".gpg", ".rss", ".atom", ".png")
# Names of the bundle's service account and emergency administrator (git-bootstrap, RUNBOOK §17): never handed out
# and never changed. The protection itself goes by what an account is (``_Run.protected``) — these only add to it.
PROTECTED_ACCOUNTS = frozenset({"ppm-bot", "git-admin"})
USERNAME_PATTERN = re.compile(r"^[0-9a-z][-.\w]*$", re.ASCII)
USERNAME_SPECIAL_RUNS = re.compile(r"[-._]{2,}|[-._]$")
CHANGE_KEYS = (
    "accounts_created",
    "accounts_adopted",
    "accounts_updated",
    "logins_prohibited",
    "logins_restored",
    "admins_granted",
    "admins_revoked",
    "organizations_created",
    "organizations_adopted",
    "organizations_updated",
    "teams_created",
    "teams_adopted",
    "teams_updated",
    "teams_renamed",
    "teams_deleted",
    "members_added",
    "members_removed",
    "repositories_added",
    "repositories_removed",
)
# Answers after which nothing else can work now: the run stops (the scoped one is retried later).
FATAL_CODES = frozenset({"GIT_PROVIDER_AUTH_FAILED", "GIT_PROVIDER_NOT_CONFIGURED", "FORGEJO_SSO_SOURCE_MISSING"})
UNAVAILABLE_TEXT = "Git-сервер недоступен. PPM повторит синхронизацию позже."
WAIT_TEXT = "Git-сервер просит подождать. PPM повторит синхронизацию позже."
INTERNAL_TEXT = "Синхронизация прервана внутренней ошибкой PPM — подробности в журнале API."


def _monotonic():
    return time.monotonic()


class ForgejoAccessError(Exception):
    """The person's account could not be ensured; ``message`` is plain Russian without secrets."""

    def __init__(self, code, message):
        super().__init__(code, message)
        self.code = code
        self.message = message

    def __str__(self):
        return self.code


class _BudgetExceeded(Exception):
    pass


class _Abort(Exception):
    def __init__(self, error):
        super().__init__(error.code)
        self.error = error


class _Problem(Exception):
    def __init__(self, message, *, level="error"):
        super().__init__(message)
        self.message = message
        self.level = level


# --- configuration -------------------------------------------------------------------------------------------------


def _setting(name):
    value = getattr(settings, name, "")
    return value.strip() if isinstance(value, str) else ""


def _enabled(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value == 1
    return isinstance(value, str) and value.strip().casefold() in {"1", "true", "yes", "on"}


def _source_id():
    value = getattr(settings, "PPM_FORGEJO_SSO_SOURCE_ID", None)
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def forgejo_sso_is_configured():
    """Single sign-on is on and complete: the switch, the Git server (G2.1), the administration token, the source id.

    Settings only — no database, no network (signals call it on every change)."""
    return (
        _enabled(getattr(settings, "PPM_GIT_SSO_ENABLED", False))
        and forgejo_is_configured()
        and bool(_setting("PPM_FORGEJO_ADMIN_TOKEN"))
        and _source_id() is not None
    )


# --- people and names ----------------------------------------------------------------------------------------------


def _is_person(user):
    """R5: an active human with an e-mail — only such a person has access on the Git server."""
    return (
        user is not None
        and user.is_active
        and not user.is_bot
        and isinstance(user.email, str)
        and bool(user.email.strip())
    )


def _one_line(value):
    return re.sub(r"[\x00-\x1f\x7f]", "", " ".join(value.split())) if isinstance(value, str) else ""


def _full_name(user):
    """The name PPM shows (as the OIDC ``name`` claim, R4): the display name, else first and last name."""
    name = _one_line(user.display_name) or _one_line(f"{user.first_name or ''} {user.last_name or ''}")
    return name[:FULL_NAME_LIMIT].strip()


def _is_global_admin(user):
    if not _is_person(user) or not getattr(settings, "PPM_GLOBAL_ADMIN_ENABLED", True):
        return False
    return PpmGlobalAdmin.objects.filter(user_id=user.id, revoked_at__isnull=True).exists()


def _normalized_name(value, limit):
    """R10/R11: lowercase ``a-z 0-9 . _ -``, starting with a letter or digit, no two special characters in a row, no
    special character at the end (Forgejo's username rule), at most ``limit`` characters."""
    ascii_value = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode("ascii").lower()
    name = re.sub(r"[^a-z0-9._-]+", "", ascii_value)
    name = re.sub(r"[-._]{2,}", lambda match: match.group(0)[0], name)
    return name.lstrip("-._")[:limit].rstrip("-._")


def _name_candidates(base, limit):
    yield base
    for number in range(2, NAME_ATTEMPTS + 1):
        suffix = f"-{number}"
        yield f"{base[: limit - len(suffix)].rstrip('-._')}{suffix}"


def _usable_name(name, limit):
    lowered = name.casefold()
    return (
        0 < len(name) <= limit
        and USERNAME_PATTERN.fullmatch(name) is not None
        and USERNAME_SPECIAL_RUNS.search(name) is None
        and lowered not in RESERVED_NAMES
        and lowered not in PROTECTED_ACCOUNTS
        and not lowered.endswith(RESERVED_SUFFIXES)
    )


def _team_key(project):
    """The project key as a Forgejo team name: ASCII letters, digits, ``-``, ``_``, ``.``. A key that has to change
    for that (letters outside ASCII) gets a piece of the project id, so two projects never share team names."""
    identifier = project.identifier or ""
    plain = unicodedata.normalize("NFKD", identifier).encode("ascii", "ignore").decode("ascii")
    plain = re.sub(r"[^A-Za-z0-9_.-]+", "", plain)
    if plain and plain == identifier:
        return plain
    marker = project.id.hex[:6]
    return f"{plain}-{marker}" if plain else f"P-{marker}"


def _team_name(project, role):
    key = _team_key(project)
    if role == PpmForgejoTeamRole.ADMIN:
        return f"{key}-admin"
    if role == PpmForgejoTeamRole.READ:
        return f"{key}-read"
    # The organization's Owners team holds this name (without case).
    return f"{key}-write" if key.casefold() == "owners" else key


def _team_name_candidates(base):
    """The team's name, then — when a team PPM does not manage holds it — ``<name>-ppm``, ``<name>-ppm-2``, …"""
    yield base
    yield f"{base}{TEAM_SUFFIX}"
    for number in range(2, NAME_ATTEMPTS + 1):
        yield f"{base}{TEAM_SUFFIX}-{number}"


def _is_team_variant(name, base):
    """``<base>-ppm`` or ``<base>-ppm-<n>`` (without case): the name PPM gave its team next to a team it does not
    manage — kept as long as the key stays."""
    return re.fullmatch(re.escape(f"{base}{TEAM_SUFFIX}".casefold()) + r"(-\d+)?", name.casefold()) is not None


def _team_description(project, role):
    """R12: «PPM: <роль> проекта «<название>». Состав ведёт PPM — не меняйте вручную», within 255 bytes."""
    head = f"{DESCRIPTION_PREFIX}{ROLE_TITLES[role]} проекта «"
    tail = "». Состав ведёт PPM — не меняйте вручную"
    name = _one_line(project.name)
    budget = DESCRIPTION_BYTES - len(head.encode("utf-8")) - len(tail.encode("utf-8"))
    if len(name.encode("utf-8")) > budget:
        budget -= len("…".encode("utf-8"))
        while name and len(name.encode("utf-8")) > budget:
            name = name[:-1]
        name = f"{name.rstrip()}…"
    return f"{head}{name}{tail}"


def _organization_full_name(workspace):
    return _one_line(workspace.name)[:FULL_NAME_LIMIT].strip()


def _team_permission(role):
    return "admin" if role == PpmForgejoTeamRole.ADMIN else str(role)


def _units_match(actual, role):
    """A non-admin team grants exactly the PPM units with its access; any other unit stays closed."""
    wanted = str(role)
    if any(actual.get(unit) != wanted for unit in TEAM_UNITS):
        return False
    return all(value == "none" for unit, value in actual.items() if unit not in TEAM_UNITS)


# --- problems ----------------------------------------------------------------------------------------------------


def _is_fatal(error):
    if isinstance(error, PpmGitProviderRateLimited) or error.code in FATAL_CODES:
        return True
    # No answer at all (connection refused, timeout) — a 500 of one request is that request's problem.
    return error.code == "GIT_PROVIDER_UNAVAILABLE" and error.http_status is None


def _fatal_text(error):
    if isinstance(error, PpmGitProviderRateLimited):
        return WAIT_TEXT
    if error.code == "GIT_PROVIDER_UNAVAILABLE":
        return UNAVAILABLE_TEXT
    return error.message


def _item_text(error):
    if error.code == "GIT_PROVIDER_UNAVAILABLE":
        return "Git-сервер не выполнил запрос (внутренняя ошибка Git-сервера). PPM повторит при следующей сверке."
    return error.message


def _retry_countdown(error):
    if isinstance(error, PpmGitProviderRateLimited):
        return max(SYNC_DELAY_SECONDS, min(error.retry_after_seconds or 60, MAX_RETRY_SECONDS))
    return RETRY_SECONDS


# --- locks and the pending scope ----------------------------------------------------------------------------------


def _acquire_lock(timeout_seconds, *, wait_seconds, key=LOCK_KEY):
    """One synchronization at a time (a cache lock): the token to release it with, or None."""
    token = uuid.uuid4().hex
    deadline = _monotonic() + wait_seconds
    while True:
        if cache.add(key, token, timeout=timeout_seconds):
            return token
        if _monotonic() >= deadline:
            return None
        time.sleep(0.2)


def _release_lock(token, *, key=LOCK_KEY):
    if token and cache.get(key) == token:
        cache.delete(key)


def _empty_scope():
    return {"user_ids": set(), "project_ids": set(), "workspace_ids": set(), "full": False, "attempts": 0}


def _scope(value):
    scope = _empty_scope()
    if not isinstance(value, dict):
        return scope
    for key in ("user_ids", "project_ids", "workspace_ids"):
        for item in value.get(key) or ():
            try:
                scope[key].add(str(uuid.UUID(str(item))))
            except (TypeError, ValueError):
                continue
    scope["full"] = value.get("full") is True
    attempts = value.get("attempts")
    scope["attempts"] = attempts if isinstance(attempts, int) and not isinstance(attempts, bool) else 0
    return scope


def _merge(first, second):
    merged = _empty_scope()
    for key in ("user_ids", "project_ids", "workspace_ids"):
        merged[key] = set(first[key]) | set(second[key])
    merged["full"] = first["full"] or second["full"]
    merged["attempts"] = max(first["attempts"], second["attempts"])
    return merged


def _stored(scope):
    return {
        "user_ids": sorted(scope["user_ids"]),
        "project_ids": sorted(scope["project_ids"]),
        "workspace_ids": sorted(scope["workspace_ids"]),
        "full": scope["full"],
        "attempts": scope["attempts"],
    }


def _is_empty(scope):
    return not (scope["user_ids"] or scope["project_ids"] or scope["workspace_ids"] or scope["full"])


def _with_pending(change):
    """Read-modify-write of the pending scope under a short cache lock (best effort: a lost update is caught by the
    full reconciliation)."""
    token = _acquire_lock(5, wait_seconds=2.0, key=PENDING_LOCK_KEY)
    try:
        current = _scope(cache.get(PENDING_KEY))
        updated, result = change(current)
        if _is_empty(updated):
            cache.delete(PENDING_KEY)
        else:
            cache.set(PENDING_KEY, _stored(updated), timeout=PENDING_SECONDS)
        return result
    finally:
        _release_lock(token, key=PENDING_LOCK_KEY)


def pending_scope():
    """What the next scheduled synchronization will do (ids as strings) — for diagnostics and tests."""
    return _stored(_scope(cache.get(PENDING_KEY)))


def clear_access_cache():
    """Drops the lock, the pending scope and the «scheduled» mark (tests, and an operator after a crash)."""
    cache.delete_many([LOCK_KEY, PENDING_KEY, PENDING_LOCK_KEY, SCHEDULED_KEY])


def _enqueue(scope, *, countdown=SYNC_DELAY_SECONDS):
    """Adds ``scope`` to the pending one and makes sure one task will run it. Never raises: a change in PPM must not
    fail because the broker or the cache is down — the full reconciliation catches up."""
    try:
        _with_pending(lambda current: (_merge(current, scope), None))
        if cache.add(SCHEDULED_KEY, 1, timeout=max(SCHEDULED_SECONDS, countdown + SCHEDULED_SECONDS)):
            from .tasks import sync_forgejo_access_task

            try:
                sync_forgejo_access_task.apply_async(kwargs={"scope": {}}, countdown=countdown)
            except Exception:
                cache.delete(SCHEDULED_KEY)
                raise
    except Exception as error:
        # The exception text may carry the broker address: only its type is logged.
        logger.warning("ppm forgejo access: could not schedule a synchronization (%s)", type(error).__name__)


def schedule_access_sync(*, user_ids=(), project_ids=(), workspace_ids=(), full=False):
    """R16: a delayed (≈5 s) synchronization of the affected people, projects and workspaces; every change of the
    burst lands in the same task. No-op without single sign-on; runs after the current transaction commits."""
    if not forgejo_sso_is_configured():
        return
    scope = _scope(
        {
            "user_ids": list(user_ids),
            "project_ids": list(project_ids),
            "workspace_ids": list(workspace_ids),
            "full": full,
        }
    )
    if _is_empty(scope):
        return
    transaction.on_commit(lambda: _enqueue(scope), robust=True)


def _take_pending():
    return _with_pending(lambda current: (_empty_scope(), current))


def _requeue(scope, error=None):
    """The scope of a failed run goes back to the queue — at most ``MAX_ATTEMPTS`` times; after that the full
    reconciliation (every 10 minutes) brings it back once the Git server (or PPM) works again."""
    scope = dict(scope)
    scope["attempts"] = scope["attempts"] + 1
    if scope["attempts"] > MAX_ATTEMPTS:
        logger.warning(
            "ppm forgejo access: scoped synchronization dropped after retries (%s)",
            error.code if error is not None else "PPM_INTERNAL_ERROR",
        )
        return
    _enqueue(scope, countdown=_retry_countdown(error) if error is not None else RETRY_SECONDS)


# --- the engine -----------------------------------------------------------------------------------------------------


class _BudgetedClient:
    """The administration client of one run: the time budget is checked before every call, and a request cut short
    by the end of the budget is the end of the budget — not an outage of the Git server."""

    def __init__(self, client, run):
        self._client = client
        self._run = run

    def __getattr__(self, name):
        attribute = getattr(self._client, name)
        if not callable(attribute):
            return attribute

        def call(*args, **kwargs):
            self._run.check_budget()
            try:
                return attribute(*args, **kwargs)
            except PpmGitProviderError as error:
                if error.code == "GIT_PROVIDER_UNAVAILABLE" and error.http_status is None and self._run.budget_spent():
                    raise _BudgetExceeded() from None
                raise

        return call


class _Run:
    def __init__(self, kind, *, deadline=None):
        self.id = uuid.uuid4()
        self.kind = kind
        self.started_at = timezone.now()
        self.deadline = deadline
        client = ForgejoAdminClient()
        if deadline is not None:
            client.request_timeout = self.request_timeout
        self.client = _BudgetedClient(client, self)
        self.source_id = _source_id()
        self.counts = Counter()
        self.problems = []
        self.fatal = None
        self.lock_token = None
        self._lock_seconds = SCOPED_LOCK_SECONDS
        self._lock_touched = _monotonic()
        self._service_login = None
        self._bound = None
        self._bound_by_login = None
        self._records = None
        self._hands_off = set()
        self._gone = set()
        self._organizations = {}
        self._team_listings = {}
        self._repositories = {}
        self._reconciled = set()
        self._labels = {}
        self.managed_repositories = set()
        self.totals = {}

    # --- bookkeeping ----------------------------------------------------------------------------------------------

    def request_timeout(self):
        """(connect, read) timeout of the next request: never past the deadline of the sign-in budget."""
        remaining = self.deadline - _monotonic()
        if remaining <= BUDGET_MARGIN_SECONDS:
            raise _BudgetExceeded()
        return (min(REQUEST_TIMEOUT[0], remaining), min(REQUEST_TIMEOUT[1], remaining))

    def budget_spent(self):
        return self.deadline is not None and _monotonic() >= self.deadline - BUDGET_MARGIN_SECONDS

    def check_budget(self):
        if self.budget_spent():
            raise _BudgetExceeded()
        now = _monotonic()
        if self.lock_token and now - self._lock_touched > 60:
            # A long reconciliation keeps its lock alive.
            cache.touch(LOCK_KEY, self._lock_seconds)
            self._lock_touched = now

    def change(self, key, amount=1):
        self.counts[key] += amount

    def problem(self, kind, subject, message, *, level="error"):
        entry = {"kind": kind, "subject": str(subject)[:255], "message": message, "level": level}
        if any({**item, "at": None} == {**entry, "at": None} for item in self.problems):
            return
        if len(self.problems) < PROBLEM_LIMIT:
            self.problems.append({"at": timezone.now().isoformat(), **entry})
        logger.info("ppm forgejo access problem: %s %s", kind, level)

    def audit(self, action, *, target_type, target_id=None, workspace_id=None, project_id=None, metadata=None):
        PpmGitAudit.objects.create(
            workspace_id=workspace_id,
            project_id=project_id,
            actor_id=None,
            action=f"forgejo.access.{action}",
            target_type=target_type,
            target_id=target_id,
            request_id=self.id,
            metadata=metadata or {},
        )

    def fail(self, error):
        self.fatal = error
        self.problem("forgejo", "Git-сервер", _fatal_text(error))

    def crash(self):
        """A failure of PPM itself (a bug, the database): logged with its traceback, recorded as an error run."""
        logger.exception("ppm forgejo access: synchronization failed")
        self.fatal = PpmGitProviderError("PPM_INTERNAL_ERROR", INTERNAL_TEXT)
        self.problem("ppm", "PPM", INTERNAL_TEXT)

    def has_errors(self):
        return self.fatal is not None or any(item["level"] == "error" for item in self.problems)

    def finish(self):
        changes = sum(self.counts[key] for key in CHANGE_KEYS)
        if self.kind == PpmForgejoSyncKind.SCOPED and not changes and not self.problems:
            return None
        if self.fatal is not None:
            status = PpmForgejoSyncStatus.ERROR
        elif any(item["level"] == "error" for item in self.problems):
            status = PpmForgejoSyncStatus.PARTIAL
        else:
            status = PpmForgejoSyncStatus.OK
        counts = {key: self.counts[key] for key in CHANGE_KEYS}
        counts["changes"] = changes
        counts.update(self.totals)
        return PpmForgejoSyncRun.objects.create(
            kind=self.kind,
            status=status,
            started_at=self.started_at,
            finished_at=timezone.now(),
            counts=counts,
            problems=self.problems[:PROBLEM_LIMIT],
        )

    def guard(self, kind, subject, function, *args, **kwargs):
        """One item (an account, an organization, a project): its problem is recorded and the run goes on; a fatal
        answer or the end of the budget stops the whole run."""
        try:
            return function(*args, **kwargs)
        except (_BudgetExceeded, _Abort):
            raise
        except PpmGitProviderError as error:
            if _is_fatal(error):
                raise _Abort(error) from None
            self.problem(kind, subject, _item_text(error))
        except ForgejoAccessError as error:
            self.problem(kind, subject, error.message)
        except _Problem as problem:
            self.problem(kind, subject, problem.message, level=problem.level)
        return None

    # --- who is PPM's -------------------------------------------------------------------------------------------

    def service_login(self):
        """The owner of the administration token (ppm-bot in the bundle, whatever its name)."""
        if self._service_login is None:
            self._service_login = self.client.current_login()
        return self._service_login

    def protected(self, remote):
        login = remote["login"].casefold()
        return login in PROTECTED_ACCOUNTS or login == self.service_login().casefold()

    def records(self):
        """PPM's account rows, loaded once per run: by person and by Git server id."""
        if self._records is None:
            rows = list(PpmForgejoAccount.objects.all())
            self._records = {
                "user": {row.user_id: row for row in rows},
                "forgejo": {row.forgejo_user_id: row for row in rows},
            }
        return self._records

    def bound_accounts(self):
        """Every account bound to PPM's sign-in source (one listing per run), by id."""
        if self._bound is None:
            listing = self.client.list_source_users(self.source_id)
            self._bound = {remote["id"]: remote for remote in listing}
            self._bound_by_login = {}
            for remote in listing:
                self._bound_by_login.setdefault(remote["login_name"], []).append(remote)
        return self._bound

    def ppm_record(self, remote):
        """The PPM row of a Git server account that is PPM's own: bound to its sign-in source with the UUID of the
        person PPM recorded it for. None for any other account (never changed, never taken out of a team)."""
        if remote.get("source_id") != self.source_id:
            return None
        record = self.records()["forgejo"].get(remote["id"])
        if record is None or remote.get("login_name") != str(record.user_id):
            return None
        return record

    def foreign_admin(self, remote, record):
        """An administrator of the Git server that PPM did not make one — left alone (R14)."""
        return remote["is_admin"] and not record.admin_granted

    def project_label(self, project_id):
        """`<КЛЮЧ> «название»` of a project for the problems — never its UUID."""
        if project_id not in self._labels:
            row = Project.all_objects.filter(id=project_id).values_list("identifier", "name").first()
            if row is not None:
                label = f"{row[0]} «{_one_line(row[1])}»"
            else:
                team = PpmForgejoTeam.objects.filter(project_id=project_id).values_list("name", flat=True).first()
                label = f"удалённый проект (команда {team})" if team else "удалённый проект"
            self._labels[project_id] = label
        return self._labels[project_id]

    def person_label(self, user_id):
        """The Git server name of a person, else their e-mail — never their UUID."""
        record = self.records()["user"].get(user_id)
        if record is not None:
            return record.username
        return User.objects.filter(id=user_id).values_list("email", flat=True).first() or "человек PPM"

    # --- accounts -------------------------------------------------------------------------------------------------

    def ensure_account(self, user):
        login_name = str(user.id)
        record = PpmForgejoAccount.objects.filter(user_id=user.id).first()
        remote = self._bound_account(record, self.client.find_users_by_login(self.source_id, login_name), user.email)
        created = remote is None
        if created:
            remote = self._create_account(user, preferred=record.username if record else None)
        if self.protected(remote):
            raise ForgejoAccessError(
                "FORGEJO_ACCOUNT_PROTECTED",
                f"Служебная учётка {remote['login']} привязана на Git-сервере ко входу человека PPM — вход через неё "
                "запрещён. Отвяжите её на Git-сервере.",
            )
        record = self._record_account(user, remote, record, created=created)
        self.sync_account(user, record, remote)
        return record

    def _bound_account(self, record, bound, subject):
        if not bound:
            return None
        chosen = None
        if record is not None:
            chosen = next((item for item in bound if item["id"] == record.forgejo_user_id), None)
        chosen = chosen or min(bound, key=lambda item: item["id"])
        if len(bound) > 1:
            self.problem(
                "account",
                subject,
                f"К человеку PPM на Git-сервере привязано несколько учёток; PPM ведёт {chosen['login']}, "
                "остальные не трогает.",
                level="warning",
            )
        return chosen

    def _create_account(self, user, *, preferred):
        """R9–R10: a new account; nothing that exists is ever taken over."""
        email = user.email.strip()
        # Nothing usable before «@» (letters outside ASCII): «person» (Forgejo reserves «user»).
        base = _normalized_name(email.split("@", 1)[0], USERNAME_LIMIT) or "person"
        candidates = [preferred] if preferred else []
        candidates += [name for name in _name_candidates(base, USERNAME_LIMIT) if name != preferred]
        for name in candidates:
            if not _usable_name(name, USERNAME_LIMIT) or self.client.get_user(name) is not None:
                continue
            try:
                return self.client.create_user(
                    username=name,
                    email=email,
                    full_name=_full_name(user),
                    source_id=self.source_id,
                    login_name=str(user.id),
                )
            except PpmGitProviderError as error:
                if error.code in {"FORGEJO_NAME_TAKEN", "FORGEJO_NAME_INVALID"}:
                    continue
                if error.code == "FORGEJO_EMAIL_TAKEN":
                    raise self._email_taken(email) from None
                if error.code == "FORGEJO_EMAIL_INVALID":
                    raise ForgejoAccessError(
                        "FORGEJO_EMAIL_INVALID", f"Git-сервер не принял почту {email}. Смените её в PPM."
                    ) from None
                raise
        raise ForgejoAccessError("FORGEJO_NAME_UNAVAILABLE", "Не удалось подобрать свободное имя на Git-сервере.")

    def _email_taken(self, email):
        """Forgejo keeps e-mails unique (422 on create, live v15): the sign-in waits until an administrator frees the
        address — the account holding it is named, never taken over."""
        holder = None
        try:
            owners = self.client.find_email_owners(email)
            if owners:
                holder = self.client.get_user(owners[0]["username"]) or {"login": owners[0]["username"]}
        except PpmGitProviderError:
            holder = None  # the message only gets less specific
        if holder is None:
            who = "другой учёткой Forgejo"
        elif holder.get("source_id") == 0:
            who = f"локальной учёткой Forgejo {holder['login']}"
        else:
            who = f"учёткой Forgejo {holder['login']}"
        return ForgejoAccessError(
            "FORGEJO_EMAIL_TAKEN", f"Почта {email} уже занята {who} — администратору нужно освободить её."
        )

    def _record_account(self, user, remote, record, *, created):
        with transaction.atomic():
            # Rows of other people that still claim this account or name are stale (the account was deleted on the
            # Git server and the name reused, or it was bound to this person by hand).
            stale = PpmForgejoAccount.objects.filter(
                Q(forgejo_user_id=remote["id"]) | Q(username__iexact=remote["login"])
            ).exclude(user_id=user.id)
            for row in stale:
                self.problem(
                    "account",
                    row.username,
                    f"Запись PPM об учётке {row.username} устарела и снята: учётка теперь принадлежит "
                    "другому человеку.",
                    level="warning",
                )
            stale.delete()
            record = record or PpmForgejoAccount(user_id=user.id)
            if record.forgejo_user_id != remote["id"]:
                # Another account than the recorded one: what PPM granted the old one does not carry over.
                record.admin_granted = False
            record.forgejo_user_id = remote["id"]
            record.username = remote["login"]
            record.adopted = False
            record.save()
        if created:
            self.change("accounts_created")
            self.audit(
                "account_created",
                target_type="forgejo_account",
                target_id=record.id,
                metadata={"username": remote["login"], "forgejo_user_id": remote["id"], "user_id": str(user.id)},
            )
        return record

    def locate(self, record):
        """The Git server account of a PPM row — bound to PPM's sign-in source with the person's UUID; a row whose
        account was deleted or unbound on the Git server is not PPM's any more (a warning, nothing is changed). Another
        account bound to the person by hand is not taken for it either: the synchronization leaves it alone until the
        person signs in again (then the sign-in records it as a new account, R9)."""
        self.bound_accounts()
        remote = self._bound_account(record, self._bound_by_login.get(str(record.user_id), []), record.username)
        if remote is None:
            self._gone.add(record.user_id)
            raise _Problem(
                f"Учётка {record.username} удалена на Git-сервере или отвязана от входа через PPM — PPM её больше не "
                "ведёт; при следующем входе человека PPM создаст новую.",
                level="warning",
            )
        if remote["id"] != record.forgejo_user_id:
            self._gone.add(record.user_id)
            self._hands_off.add(remote["id"])
            person = User.objects.filter(id=record.user_id).values_list("email", flat=True).first()
            raise _Problem(
                f"Учётка на Git-сервере для {person or record.username} сменилась вручную (была {record.username}, "
                f"теперь {remote['login']}) — проверьте привязку",
                level="warning",
            )
        return remote

    def sync_account(self, user, record, remote):
        """Name, e-mail, access and administrator flag of an account PPM keeps (R9, R14, R15) — never of the token's
        owner, never of an administrator PPM did not make one."""
        if self.protected(remote):
            self._hands_off.add(remote["id"])
            raise _Problem(
                f"Служебная учётка {remote['login']} привязана ко входу через PPM — PPM её не меняет; отвяжите её на "
                "Git-сервере."
            )
        if self.foreign_admin(remote, record):
            self._hands_off.add(remote["id"])
            self.problem(
                "account",
                remote["login"],
                f"Учётка {remote['login']} — администратор Git-сервера, назначенный не PPM: PPM её не меняет и не "
                "выводит из команд. Вход и права этой учётки пересмотрите на Git-сервере.",
                level="warning",
            )
            # admin_granted is left as it is: this row may be a snapshot older than a grant PPM made meanwhile.
            self._save_account(record, remote)
            return remote
        person = _is_person(user)
        changes = {}
        if person:
            full_name = _full_name(user)
            email = user.email.strip()
            if remote["full_name"] != full_name:
                changes["full_name"] = full_name
            if remote["email"].casefold() != email.casefold():
                changes["email"] = email
            if not remote["active"]:
                changes["active"] = True
        if remote["prohibit_login"] == person:
            changes["prohibit_login"] = not person
        admin = _is_global_admin(user) if person else False
        granted = None
        if admin and not remote["is_admin"]:
            # Recorded before the request: an answer lost on the way still leaves PPM responsible for the flag.
            record.admin_granted = True
            record.save(update_fields=["admin_granted", "updated_at"])
            changes["admin"] = True
        elif not admin and remote["is_admin"]:
            changes["admin"] = False
        elif not admin and record.admin_granted:
            granted = False  # the flag is off: nothing left for PPM to answer for
        if changes:
            login_name = str(record.user_id)
            try:
                remote = self.client.edit_user(
                    remote["login"], source_id=self.source_id, login_name=login_name, **changes
                )
            except PpmGitProviderError as error:
                if error.code != "FORGEJO_EMAIL_TAKEN" or "email" not in changes:
                    raise
                self.problem(
                    "account",
                    remote["login"],
                    f"Почта {changes.pop('email')} уже занята другой учёткой на Git-сервере — у {remote['login']} "
                    "осталась прежняя.",
                )
                remote = self.client.edit_user(
                    remote["login"], source_id=self.source_id, login_name=login_name, **changes
                )
            self._account_changes(record, remote, changes)
            if self._bound is not None:
                self._bound[remote["id"]] = remote
            if "admin" in changes:
                granted = changes["admin"]
        self._save_account(record, remote, admin_granted=granted)
        return remote

    def _save_account(self, record, remote, *, admin_granted=None):
        """The row follows the account; ``admin_granted`` changes only with what PPM itself just did (a grant, a revoke,
        a flag found off) — never from the run's snapshot of the row."""
        if record.username != remote["login"]:
            # Renamed on the Git server: a stale row that still claims the new name goes (the name is unique).
            PpmForgejoAccount.objects.filter(username__iexact=remote["login"]).exclude(pk=record.pk).delete()
        record.username = remote["login"]
        record.prohibited = remote["prohibit_login"]
        record.last_synced_at = timezone.now()
        record.last_error_code = ""
        record.last_error_message = ""
        fields = ["username", "prohibited", "last_synced_at", "last_error_code", "last_error_message", "updated_at"]
        if admin_granted is not None:
            record.admin_granted = admin_granted
            fields.append("admin_granted")
        record.save(update_fields=fields)

    def _account_changes(self, record, remote, changes):
        details = {"username": remote["login"], "forgejo_user_id": remote["id"], "user_id": str(record.user_id)}
        if "prohibit_login" in changes:
            action = "login_prohibited" if changes["prohibit_login"] else "login_restored"
            self.change("logins_prohibited" if changes["prohibit_login"] else "logins_restored")
            self.audit(action, target_type="forgejo_account", target_id=record.id, metadata=details)
        if "admin" in changes:
            action = "admin_granted" if changes["admin"] else "admin_revoked"
            self.change("admins_granted" if changes["admin"] else "admins_revoked")
            self.audit(action, target_type="forgejo_account", target_id=record.id, metadata=details)
        profile = sorted(key for key in changes if key in {"full_name", "email", "active"})
        if profile:
            self.change("accounts_updated")
            self.audit(
                "account_updated",
                target_type="forgejo_account",
                target_id=record.id,
                metadata={**details, "fields": profile},
            )

    def apply_user(self, user_id, *, with_projects=True):
        """One person: the account (R9 profile, R14, R15), the teams of their projects, and leaving PPM teams that are
        no longer theirs (found through admin sudo)."""
        record = self.records()["user"].get(user_id)
        if record is None:
            return
        user = User.objects.filter(id=user_id).first()
        remote = self.sync_account(user, record, self.locate(record))
        if remote["id"] in self._hands_off or not with_projects:
            return
        wanted = self._roles_of(user) if _is_person(user) else {}
        for project_id in sorted(wanted, key=str):
            self.guard("project", self.project_label(project_id), self.reconcile_project, project_id)
        tracked = {team.forgejo_team_id: team for team in PpmForgejoTeam.objects.all()}
        for team in self.client.list_user_teams(remote["login"]):
            record_team = tracked.get(team["id"])
            if record_team is None or wanted.get(record_team.project_id) == record_team.role:
                continue
            self.client.remove_team_member(team["id"], remote["login"])
            self.change("members_removed")
            self.audit(
                "member_removed",
                target_type="forgejo_team",
                target_id=record_team.id,
                workspace_id=record_team.workspace_id,
                project_id=record_team.project_id,
                metadata={"username": remote["login"], "team": record_team.name, "role": record_team.role},
            )

    def _roles_of(self, user):
        """{project_id: role} of a person: active membership of a live project in a workspace they are still in."""
        workspaces = set(
            WorkspaceMember.objects.filter(member_id=user.id, is_active=True).values_list("workspace_id", flat=True)
        )
        roles = {}
        memberships = ProjectMember.objects.filter(
            member_id=user.id,
            is_active=True,
            project__deleted_at__isnull=True,
            project__workspace__deleted_at__isnull=True,
        ).values_list("project_id", "workspace_id", "role")
        for project_id, workspace_id, role in memberships:
            if workspace_id in workspaces and role in ROLE_BY_PPM_ROLE:
                roles[project_id] = ROLE_BY_PPM_ROLE[role]
        return roles

    # --- organizations ------------------------------------------------------------------------------------------

    def organization(self, workspace):
        """R11: the workspace's organization, created or adopted when first needed; name, full name, visibility."""
        if workspace.id in self._organizations:
            return self._organizations[workspace.id]
        record = PpmForgejoOrganization.objects.filter(workspace_id=workspace.id).first()
        remote = None
        if record is not None:
            remote = self.client.get_organization(record.name)
            if remote is None or remote["id"] != record.forgejo_org_id:
                remote = next(
                    (item for item in self.client.list_organizations() if item["id"] == record.forgejo_org_id), None
                )
            if remote is None:
                self.problem(
                    "organization",
                    record.name,
                    f"Организация {record.name} удалена на Git-сервере — PPM создаёт её заново.",
                    level="warning",
                )
                PpmForgejoTeam.objects.filter(workspace_id=workspace.id).delete()
                record.delete()
                record = None
        if record is None:
            record, remote = self._create_or_adopt_organization(workspace)
        else:
            if record.name != remote["name"]:
                record.name = remote["name"]
                record.save(update_fields=["name", "updated_at"])
            self._sync_organization(record, remote, workspace)
        self._organizations[workspace.id] = record
        return record

    def _create_or_adopt_organization(self, workspace):
        base = _normalized_name(workspace.slug, ORGANIZATION_NAME_LIMIT) or "workspace"
        for index, name in enumerate(_name_candidates(base, ORGANIZATION_NAME_LIMIT)):
            if not _usable_name(name, ORGANIZATION_NAME_LIMIT):
                continue
            remote = self.client.get_organization(name)
            if remote is not None:
                # Only the organization named exactly after the workspace is adopted — never one PPM keeps already.
                if index == 0 and not PpmForgejoOrganization.objects.filter(forgejo_org_id=remote["id"]).exists():
                    record = PpmForgejoOrganization.objects.create(
                        workspace_id=workspace.id, forgejo_org_id=remote["id"], name=remote["name"], adopted=True
                    )
                    self.change("organizations_adopted")
                    self.audit(
                        "organization_adopted",
                        target_type="forgejo_organization",
                        target_id=record.id,
                        workspace_id=workspace.id,
                        metadata={"name": remote["name"], "forgejo_org_id": remote["id"]},
                    )
                    self._sync_organization(record, remote, workspace)
                    return record, remote
                continue
            if self.client.get_user(name) is not None:
                continue  # a person's name
            try:
                remote = self.client.create_organization(name=name, full_name=_organization_full_name(workspace))
            except PpmGitProviderError as error:
                if error.code in {"FORGEJO_NAME_TAKEN", "FORGEJO_NAME_INVALID"}:
                    continue
                raise
            record = PpmForgejoOrganization.objects.create(
                workspace_id=workspace.id, forgejo_org_id=remote["id"], name=remote["name"], adopted=False
            )
            self.change("organizations_created")
            self.audit(
                "organization_created",
                target_type="forgejo_organization",
                target_id=record.id,
                workspace_id=workspace.id,
                metadata={"name": remote["name"], "forgejo_org_id": remote["id"]},
            )
            return record, remote
        raise _Problem("Не удалось подобрать свободное имя организации на Git-сервере.")

    def _sync_organization(self, record, remote, workspace):
        full_name = _organization_full_name(workspace)
        if remote["full_name"] == full_name and remote["visibility"] == "private":
            return
        self.client.edit_organization(remote, full_name=full_name, visibility="private")
        self.change("organizations_updated")
        self.audit(
            "organization_updated",
            target_type="forgejo_organization",
            target_id=record.id,
            workspace_id=workspace.id,
            metadata={"name": remote["name"]},
        )

    def reconcile_organization(self, record):
        workspace = Workspace.all_objects.filter(id=record.workspace_id).first()
        if workspace is None or workspace.deleted_at is not None:
            return  # the organization and its repositories stay; the teams go with the projects
        self.organization(workspace)

    # --- projects and teams ---------------------------------------------------------------------------------------

    def reconcile_project(self, project_id, *, phase="all"):
        """R12–R13 for one project. ``phase``: ``existing`` — only its teams PPM already keeps (renames go first in a
        full reconciliation), ``missing`` — only the teams it lacks, ``all`` — both."""
        if (project_id, phase) in self._reconciled or (project_id, "all") in self._reconciled:
            return
        self._reconciled.add((project_id, phase))
        records = {team.role: team for team in PpmForgejoTeam.objects.filter(project_id=project_id)}
        project = Project.all_objects.select_related("workspace").filter(id=project_id).first()
        if project is None or project.deleted_at is not None or project.workspace.deleted_at is not None:
            if phase != "missing":
                for record in records.values():
                    self.guard("team", record.name, self._delete_team, record)
            return
        members = self._members(project)
        roles = []
        for role in ROLE_ORDER:
            if role in records and phase != "missing":
                roles.append(role)
            elif role not in records and phase != "existing" and members[role]:
                roles.append(role)
        if not roles:
            return
        organization = self.organization(project.workspace)
        repositories = self._project_repositories(project, organization)
        for role in roles:
            self.guard(
                "team",
                _team_name(project, role),
                self._reconcile_team,
                organization,
                project,
                role,
                records.get(role),
                members[role],
                repositories,
            )

    def _members(self, project):
        """{role: {login}} — PPM's own accounts of people active in the project and in its workspace; never the
        token's owner or an administrator PPM did not make one."""
        workspace_members = set(
            WorkspaceMember.objects.filter(workspace_id=project.workspace_id, is_active=True).values_list(
                "member_id", flat=True
            )
        )
        rows = (
            ProjectMember.objects.filter(
                project_id=project.id,
                is_active=True,
                member__isnull=False,
                member__is_active=True,
                member__is_bot=False,
                member__email__isnull=False,
            )
            .exclude(member__email="")
            .values_list("member_id", "role")
        )
        records = self.records()["user"]
        bound = self.bound_accounts()
        members = {role: set() for role in ROLE_ORDER}
        for member_id, role in rows:
            record = records.get(member_id)
            if member_id not in workspace_members or record is None or role not in ROLE_BY_PPM_ROLE:
                continue
            remote = bound.get(record.forgejo_user_id)
            if remote is None or self.ppm_record(remote) is not record or remote["id"] in self._hands_off:
                continue
            if self.protected(remote) or self.foreign_admin(remote, record):
                continue
            members[ROLE_BY_PPM_ROLE[role]].add(remote["login"])
        return members

    def _project_repositories(self, project, organization):
        """R13: the project's active Forgejo connections that lie in the workspace's organization."""
        from .provider_services import ACTIVE_CONNECTION_STATUSES

        rows = PpmGitConnection.objects.filter(
            project_id=project.id,
            installation__provider=PpmGitProvider.FORGEJO,
            status__in=ACTIVE_CONNECTION_STATUSES,
            repository__status=PpmGitRepositoryStatus.ACTIVE,
        ).values_list("provider_repository_id", "provider_full_name")
        repositories = {}
        for repository_id, full_name in rows:
            if repository_id not in self._repositories:
                self._repositories[repository_id] = self.client.get_repository(repository_id)
            remote = self._repositories[repository_id]
            if remote is None:
                self.problem(
                    "repository",
                    full_name,
                    f"Репозиторий {full_name} не найден на Git-сервере — доступ к нему не настраивается.",
                    level="warning",
                )
                continue
            if remote["owner"].casefold() != organization.name.casefold():
                self.problem(
                    "repository",
                    remote["full_name"],
                    f"Доступ к {remote['full_name']} настраивается вручную: он вне организации пространства",
                    level="warning",
                )
                continue
            repositories[remote["id"]] = remote
        self.managed_repositories.update(repositories)
        return repositories

    def _organization_teams(self, organization):
        if organization.id not in self._team_listings:
            self._team_listings[organization.id] = self.client.list_organization_teams(organization.name)
        return self._team_listings[organization.id]

    def _remember_team(self, organization, remote):
        """Keeps the run's listing of the organization's teams in step with what PPM just created or renamed."""
        listing = self._organization_teams(organization)
        listing[:] = [item for item in listing if item["id"] != remote["id"]] + [remote]

    def _create_or_adopt_team(self, organization, project, role, base, description, *, retried=False):
        """R12: the team of a role. A team with the name that PPM does not manage is never taken over: PPM's gets
        ``<name>-ppm`` (and a warning). Only a team described «PPM: …» and kept by no PPM row — PPM's own, whose
        creation answer was lost — is adopted."""
        taken = {item["name"].casefold(): item for item in self._organization_teams(organization)}
        foreign = None
        for candidate in _team_name_candidates(base):
            existing = taken.get(candidate.casefold())
            if existing is None:
                try:
                    remote = self.client.create_team(
                        organization.name,
                        name=candidate,
                        description=description,
                        permission=_team_permission(role),
                        can_create_org_repo=role == PpmForgejoTeamRole.ADMIN,
                    )
                except PpmGitProviderError as error:
                    if error.code != "FORGEJO_TEAM_EXISTS" or retried:
                        raise
                    # Created meanwhile: read the organization's teams again and decide once more.
                    self._team_listings.pop(organization.id, None)
                    return self._create_or_adopt_team(organization, project, role, base, description, retried=True)
                record = PpmForgejoTeam.objects.create(
                    workspace_id=project.workspace_id,
                    project_id=project.id,
                    role=role,
                    forgejo_team_id=remote["id"],
                    name=remote["name"],
                )
                self._remember_team(organization, remote)
                self.change("teams_created")
                self.audit(
                    "team_created",
                    target_type="forgejo_team",
                    target_id=record.id,
                    workspace_id=project.workspace_id,
                    project_id=project.id,
                    metadata={"name": remote["name"], "role": role, "organization": organization.name},
                )
                if foreign is not None:
                    self.problem(
                        "team",
                        foreign["name"],
                        f"Команда {foreign['name']} в организации {organization.name} не управляется PPM — PPM "
                        f"создал {remote['name']}",
                        level="warning",
                    )
                return record, remote
            if PpmForgejoTeam.objects.filter(forgejo_team_id=existing["id"]).exists():
                if candidate == base:
                    raise _Problem(
                        f"Имя команды {base} на Git-сервере занято другой командой PPM — поправится при следующей "
                        "полной сверке."
                    )
                continue
            if existing["permission"] != "owner" and existing["description"].startswith(DESCRIPTION_PREFIX):
                record = PpmForgejoTeam.objects.create(
                    workspace_id=project.workspace_id,
                    project_id=project.id,
                    role=role,
                    forgejo_team_id=existing["id"],
                    name=existing["name"],
                )
                self.change("teams_adopted")
                self.audit(
                    "team_adopted",
                    target_type="forgejo_team",
                    target_id=record.id,
                    workspace_id=project.workspace_id,
                    project_id=project.id,
                    metadata={"name": existing["name"], "role": role, "organization": organization.name},
                )
                return record, existing
            foreign = foreign or existing
        raise _Problem(f"Не удалось подобрать свободное имя команды для {base} на Git-сервере.")

    def _desired_team_name(self, record, organization, project, role):
        """The name a PPM team should carry: the role's name (exact case) — or the ``-ppm`` name PPM gave it next to a
        team it does not manage, kept while the key stays. A new key renames it, again past such teams."""
        base = _team_name(project, role)
        if record.name.casefold() == base.casefold():
            return base
        if _is_team_variant(record.name, base):
            return record.name
        taken = {
            item["name"].casefold(): item
            for item in self._organization_teams(organization)
            if item["id"] != record.forgejo_team_id
        }
        for candidate in _team_name_candidates(base):
            holder = taken.get(candidate.casefold())
            if holder is None:
                if candidate != base:
                    self.problem(
                        "team",
                        base,
                        f"Команда {base} в организации {organization.name} не управляется PPM — PPM назвал свою "
                        f"команду {candidate}",
                        level="warning",
                    )
                return candidate
            if PpmForgejoTeam.objects.filter(forgejo_team_id=holder["id"]).exists():
                raise _Problem(
                    f"Имя команды {candidate} на Git-сервере занято другой командой PPM — поправится при следующей "
                    "полной сверке."
                )
        raise _Problem(f"Не удалось подобрать свободное имя команды для {base} на Git-сервере.")

    def _reconcile_team(self, organization, project, role, record, members, repositories):
        description = _team_description(project, role)
        remote = None
        if record is not None:
            remote = self.client.get_team(record.forgejo_team_id)
            if remote is None:
                self.problem(
                    "team",
                    record.name,
                    f"Команда {record.name} удалена на Git-сервере — PPM создаёт её заново.",
                    level="warning",
                )
                record.delete()
                record = None
                if not members:
                    return
        if record is None:
            record, remote = self._create_or_adopt_team(
                organization, project, role, _team_name(project, role), description
            )
        name = self._desired_team_name(record, organization, project, role)
        self._sync_team(organization, record, remote, role, name, description)
        self._sync_members(record, members)
        self._sync_repositories(record, organization, repositories)

    def _sync_team(self, organization, record, remote, role, name, description):
        permission = _team_permission(role)
        renamed = remote["name"] != name
        drift = (
            renamed
            or remote["description"] != description
            or remote["permission"] != permission
            or remote["can_create_org_repo"] != (role == PpmForgejoTeamRole.ADMIN)
            or remote["includes_all_repositories"]
            or (role != PpmForgejoTeamRole.ADMIN and not _units_match(remote["units_map"], role))
        )
        if not drift:
            return
        updated = self.client.edit_team(
            record.forgejo_team_id,
            name=name,
            description=description,
            permission=permission,
            can_create_org_repo=role == PpmForgejoTeamRole.ADMIN,
        )
        self._remember_team(organization, updated)
        details = {"role": role, "name": name}
        if renamed:
            self.change("teams_renamed")
            self.audit(
                "team_renamed",
                target_type="forgejo_team",
                target_id=record.id,
                workspace_id=record.workspace_id,
                project_id=record.project_id,
                metadata={**details, "previous_name": remote["name"]},
            )
        else:
            self.change("teams_updated")
            self.audit(
                "team_updated",
                target_type="forgejo_team",
                target_id=record.id,
                workspace_id=record.workspace_id,
                project_id=record.project_id,
                metadata=details,
            )
        if record.name != name:
            record.name = name
            record.save(update_fields=["name", "updated_at"])

    def _removable(self, member):
        """R14: only PPM's own accounts leave PPM's teams — never another account (a local one, ppm-bot, the emergency
        administrator, the token's owner), never an administrator PPM did not make one."""
        record = self.ppm_record(member)
        if record is None or member["id"] in self._hands_off or self.protected(member):
            return False
        return not self.foreign_admin(member, record)

    def _sync_members(self, record, members):
        current = {
            member["login"].casefold(): member for member in self.client.list_team_members(record.forgejo_team_id)
        }
        wanted = {login.casefold(): login for login in members}
        scope = {"workspace_id": record.workspace_id, "project_id": record.project_id}
        for key in sorted(wanted.keys() - current.keys()):
            try:
                self.client.add_team_member(record.forgejo_team_id, wanted[key])
            except PpmGitProviderError as error:
                if error.code != "GIT_PROVIDER_NOT_FOUND":
                    raise
                self.problem(
                    "account",
                    wanted[key],
                    f"Учётка {wanted[key]} не найдена на Git-сервере — PPM создаст её снова при следующем входе "
                    "человека.",
                    level="warning",
                )
                continue
            self.change("members_added")
            self.audit(
                "member_added",
                target_type="forgejo_team",
                target_id=record.id,
                metadata={"username": wanted[key], "team": record.name, "role": record.role},
                **scope,
            )
        for key in sorted(current.keys() - wanted.keys()):
            member = current[key]
            if not self._removable(member):
                continue
            self.client.remove_team_member(record.forgejo_team_id, member["login"])
            self.change("members_removed")
            self.audit(
                "member_removed",
                target_type="forgejo_team",
                target_id=record.id,
                metadata={"username": member["login"], "team": record.name, "role": record.role},
                **scope,
            )

    def _sync_repositories(self, record, organization, repositories):
        current = {item["id"]: item for item in self.client.list_team_repositories(record.forgejo_team_id)}
        scope = {"workspace_id": record.workspace_id, "project_id": record.project_id}
        for repository_id in sorted(repositories.keys() - current.keys()):
            repository = repositories[repository_id]
            self.client.add_team_repository(record.forgejo_team_id, organization.name, repository["name"])
            self.change("repositories_added")
            self.audit(
                "repository_added",
                target_type="forgejo_team",
                target_id=record.id,
                metadata={"repository": repository["full_name"], "team": record.name},
                **scope,
            )
        for repository_id in sorted(current.keys() - repositories.keys()):
            repository = current[repository_id]
            self.client.remove_team_repository(record.forgejo_team_id, repository["owner"], repository["name"])
            self.change("repositories_removed")
            self.audit(
                "repository_removed",
                target_type="forgejo_team",
                target_id=record.id,
                metadata={"repository": repository["full_name"], "team": record.name},
                **scope,
            )

    def _delete_team(self, record):
        """R12: a deleted project's team goes; its repositories stay in the organization."""
        deleted = self.client.delete_team(record.forgejo_team_id)
        record_id = record.id
        record.delete()
        if deleted:
            self.change("teams_deleted")
        self.audit(
            "team_deleted",
            target_type="forgejo_team",
            target_id=record_id,
            workspace_id=record.workspace_id,
            project_id=record.project_id,
            metadata={"name": record.name, "role": record.role, "already_gone": not deleted},
        )

    # --- runs -------------------------------------------------------------------------------------------------------

    def apply_scope(self, scope):
        project_ids = {uuid.UUID(item) for item in scope["project_ids"]}
        for workspace_id in sorted(scope["workspace_ids"]):
            workspace_uuid = uuid.UUID(workspace_id)
            record = PpmForgejoOrganization.objects.filter(workspace_id=workspace_uuid).first()
            if record is not None:
                self.guard("organization", record.name, self.reconcile_organization, record)
            project_ids |= set(Project.all_objects.filter(workspace_id=workspace_uuid).values_list("id", flat=True))
            project_ids |= set(
                PpmForgejoTeam.objects.filter(workspace_id=workspace_uuid).values_list("project_id", flat=True)
            )
        for user_id in sorted(scope["user_ids"]):
            user_uuid = uuid.UUID(user_id)
            self.guard("account", self.person_label(user_uuid), self.apply_user, user_uuid)
        for project_id in sorted(project_ids, key=str):
            self.guard("project", self.project_label(project_id), self.reconcile_project, project_id)

    def full(self):
        records = list(self.records()["user"].values())
        self.bound_accounts()
        for record in records:
            self.guard("account", record.username, self.apply_user, record.user_id, with_projects=False)
        for organization in PpmForgejoOrganization.objects.all():
            self.guard("organization", organization.name, self.reconcile_organization, organization)
        kept = set(PpmForgejoTeam.objects.values_list("project_id", flat=True))
        needed = set(
            ProjectMember.objects.filter(
                member_id__in=[record.user_id for record in records], is_active=True
            ).values_list("project_id", flat=True)
        )
        # Renames and deletions first, so that a key another project gives up is free when teams are created.
        for project_id in sorted(kept, key=str):
            self.guard("project", self.project_label(project_id), self.reconcile_project, project_id, phase="existing")
        for project_id in sorted(kept | needed, key=str):
            self.guard("project", self.project_label(project_id), self.reconcile_project, project_id, phase="missing")
        self.totals = {
            "accounts": PpmForgejoAccount.objects.count(),
            "organizations": PpmForgejoOrganization.objects.count(),
            "teams": PpmForgejoTeam.objects.count(),
            "repositories": len(self.managed_repositories),
        }
        PpmForgejoSyncRun.objects.filter(started_at__lt=timezone.now() - timedelta(days=RUN_RETENTION_DAYS)).delete()


# --- the contract ---------------------------------------------------------------------------------------------------


def forgejo_username_for(user):
    """The person's name on the Git server (OIDC ``nickname``/``preferred_username``), None without an account or
    without single sign-on (then no table of migration 0009 is read)."""
    if user is None or not forgejo_sso_is_configured():
        return None
    return PpmForgejoAccount.objects.filter(user_id=user.id).values_list("username", flat=True).first()


def _finish_quietly(run):
    """The sign-in path records its run, but never fails because of that record."""
    try:
        return run.finish()
    except Exception:
        logger.exception("ppm forgejo access: the run could not be recorded")
        return None


def _record_account_error(user, error):
    PpmForgejoAccount.objects.filter(user_id=user.id).update(
        last_error_code=error.code[:64], last_error_message=error.message[:500], updated_at=timezone.now()
    )


def ensure_account_for_login(user):
    """R9: the person's Git server account, ensured before the OIDC tokens are issued (see the module docstring).

    Raises ``ForgejoAccessError`` — the sign-in is refused; the reason goes to the log (code only) and to the problems
    of the admin centre (R18)."""
    if not forgejo_sso_is_configured():
        raise ForgejoAccessError("FORGEJO_SSO_NOT_CONFIGURED", "Единый вход на Git-сервер не настроен.")
    if not _is_person(user):
        raise ForgejoAccessError(
            "FORGEJO_ACCOUNT_NOT_ALLOWED", "Вход на Git-сервер доступен только активным людям PPM с почтой."
        )
    key = f"{USER_LOCK_PREFIX}{user.id}"
    token = _acquire_lock(USER_LOCK_SECONDS, wait_seconds=USER_LOCK_WAIT_SECONDS, key=key)
    if token is None:
        raise ForgejoAccessError(
            "FORGEJO_ACCOUNT_BUSY", "Учётка на Git-сервере уже создаётся — повторите вход через несколько секунд."
        )
    run = _Run(PpmForgejoSyncKind.SCOPED)
    try:
        return run.ensure_account(user)
    except PpmGitProviderError as error:
        if _is_fatal(error):
            run.fatal = error
        failure = ForgejoAccessError(error.code, error.message if _is_fatal(error) else _item_text(error))
        run.problem("account", user.email, failure.message)
        _record_account_error(user, failure)
        logger.warning("ppm forgejo access: account not ensured (%s)", failure.code)
        raise failure from None
    except ForgejoAccessError as error:
        run.problem("account", user.email, error.message)
        _record_account_error(user, error)
        logger.warning("ppm forgejo access: account not ensured (%s)", error.code)
        raise
    except _Problem as problem:
        failure = ForgejoAccessError("FORGEJO_ACCOUNT_PROTECTED", problem.message)
        run.problem("account", user.email, failure.message)
        _record_account_error(user, failure)
        logger.warning("ppm forgejo access: account not ensured (%s)", failure.code)
        raise failure from None
    except Exception:
        run.crash()
        failure = ForgejoAccessError(
            "FORGEJO_ACCESS_FAILED", "Не удалось подготовить учётку на Git-сервере — подробности в журнале PPM."
        )
        _record_account_error(user, failure)
        raise failure from None
    finally:
        _release_lock(token, key=key)
        _finish_quietly(run)


def apply_user_access(user, *, budget_seconds=LOGIN_BUDGET_SECONDS):
    """R11–R15 for one person within ``budget_seconds`` — a hard limit: waiting for the lock and every request count,
    and no request outlives it. True when everything was applied; otherwise the rest is left to a background
    synchronization (and a problem, if any, to the admin centre) and False comes back. A budget of 0 (or less) applies
    nothing while the person waits."""
    if user is None or not forgejo_sso_is_configured():
        return True
    budget = budget_seconds if isinstance(budget_seconds, (int, float)) and not isinstance(budget_seconds, bool) else 0
    if budget <= 0:
        schedule_access_sync(user_ids=[user.id])
        return False
    deadline = _monotonic() + budget
    token = _acquire_lock(SCOPED_LOCK_SECONDS, wait_seconds=min(LOGIN_LOCK_WAIT_SECONDS, budget))
    if token is None or _monotonic() >= deadline - BUDGET_MARGIN_SECONDS:
        _release_lock(token)
        schedule_access_sync(user_ids=[user.id])
        return False
    run = _Run(PpmForgejoSyncKind.SCOPED, deadline=deadline)
    run.lock_token = token
    complete = False
    try:
        run.apply_scope(_scope({"user_ids": [str(user.id)]}))
        complete = True
    except _BudgetExceeded:
        pass
    except _Abort as abort:
        run.fail(abort.error)
    except PpmGitProviderError as error:
        run.fail(error)
    except Exception:
        # The sign-in goes on whatever happens here (R9); the rest is left to the background synchronization.
        run.crash()
    finally:
        _release_lock(token)
        _finish_quietly(run)
    if not complete:
        schedule_access_sync(user_ids=[user.id])
    return complete and not run.has_errors()


def run_access_sync(scope=None):
    """The scheduled synchronization (``tasks.sync_forgejo_access_task``): the given scope plus everything pending.
    Returns the recorded run, or None when there was nothing to do (or another synchronization holds the lock — the
    scope then waits for the next task)."""
    if not forgejo_sso_is_configured():
        return None
    cache.delete(SCHEDULED_KEY)
    merged = _merge(_scope(scope), _take_pending())
    if _is_empty(merged):
        return None
    if merged["full"]:
        run = run_full_reconcile()
        if run is None:
            # Another synchronization holds the lock: the full one is asked for again a little later.
            _enqueue(merged, countdown=RETRY_SECONDS)
        return run
    token = _acquire_lock(SCOPED_LOCK_SECONDS, wait_seconds=0)
    if token is None:
        _enqueue(merged, countdown=RETRY_SECONDS)
        return None
    run = _Run(PpmForgejoSyncKind.SCOPED)
    run.lock_token = token
    try:
        run.apply_scope(merged)
    except (_Abort, PpmGitProviderError) as failure:
        error = failure.error if isinstance(failure, _Abort) else failure
        run.fail(error)
        _requeue(merged, error)
    except Exception:
        run.crash()
        # The scope taken from the queue goes back to it (same limit of attempts).
        _requeue(merged)
    finally:
        _release_lock(token)
    return run.finish()


def run_full_reconcile():
    """R16: the full reconciliation (every 10 minutes, and «Синхронизировать сейчас»); one at a time."""
    if not forgejo_sso_is_configured():
        return None
    token = _acquire_lock(FULL_LOCK_SECONDS, wait_seconds=0)
    if token is None:
        return None
    run = _Run(PpmForgejoSyncKind.FULL)
    run.lock_token = token
    run._lock_seconds = FULL_LOCK_SECONDS
    try:
        run.full()
    except (_Abort, PpmGitProviderError) as failure:
        run.fail(failure.error if isinstance(failure, _Abort) else failure)
    except Exception:
        run.crash()
    finally:
        _release_lock(token)
    return run.finish()
