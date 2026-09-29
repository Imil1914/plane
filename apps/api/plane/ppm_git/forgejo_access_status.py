"""G2.2 R18–R19 — the state of code access on PPM's own Git server for the admin centre's «Git-сервер» tab.

``access_status()`` is the answer of ``GET /api/ppm/v1/git/forgejo/access/status/`` (plan «G2.2», HTTP contract for
web): the Git server is configured (G2.1) and answers, single sign-on is on, the last full reconciliation (time,
outcome, numbers) and the latest problems of the access synchronizations (``forgejo_access``), the link to Forgejo's own
administration. Never a secret; without single sign-on no access table is read (the owner's dev API runs without
migration 0009). ``reserve_manual_sync()`` keeps «Синхронизировать сейчас» to once per 30 seconds.
"""

import math
import time
from datetime import datetime

import requests
from django.conf import settings
from django.core.cache import cache

from .forgejo_access import forgejo_sso_is_configured
from .models import PpmForgejoSyncKind, PpmForgejoSyncRun
from .providers.forgejo import forgejo_is_configured, forgejo_public_url

# «Git-сервер отвечает» — one quick request: a status page must not wait the 5 + 15 s a synchronization may.
STATUS_PROBE_TIMEOUT = (2, 3)  # connect, read — seconds
# What a live Forgejo answers `GET /api/v1/version` with: 200, or — with `REQUIRE_SIGNIN_VIEW` (the bundle) and no token
# — 403; 401 from an authenticating proxy in front of it. Anything else (404 of some other service, 5xx) is not it.
ANSWERING_STATUSES = frozenset({200, 401, 403})
# The numbers the admin centre shows (plan: totals of the full reconciliation and changes of the run) — always present;
# null when the run does not know them (a reconciliation stopped by an error records no totals).
STATUS_COUNT_KEYS = ("accounts", "organizations", "teams", "repositories", "changes")
STATUS_PROBLEM_LIMIT = 50
# The latest runs with problems read for the list: a problem every reconciliation meets again (a repository outside
# the organization, every 10 minutes) is listed once, so older distinct ones still have room.
STATUS_PROBLEM_RUNS = 100
# «Синхронизировать сейчас» — at most once per this many seconds, for all administrators together.
SYNC_INTERVAL_SECONDS = 30
SYNC_THROTTLE_KEY = "ppm:git:forgejo-access:manual-sync"


def _now():
    return time.time()


def forgejo_server_answers(*, session=None):
    """R18 «Git-сервер отвечает»: ``GET /api/v1/version`` on the internal address — without any token — with a short
    timeout and no redirects. A refused administration token is not «does not answer»: it shows as a problem of the next
    synchronization."""
    base = getattr(settings, "PPM_FORGEJO_URL", "")
    base = base.strip().rstrip("/") if isinstance(base, str) else ""
    if not base or not forgejo_is_configured():
        return False
    try:
        response = (session or requests).get(
            f"{base}/api/v1/version",
            headers={"Accept": "application/json"},
            timeout=STATUS_PROBE_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException:
        return False
    return response.status_code in ANSWERING_STATUSES


def _moment(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def _integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _full_sync_summary(run):
    """The last full reconciliation: every integer counter of the run (the engine's own ones stay visible in the API),
    and the five the admin centre shows always present — null when unknown."""
    recorded = run.counts if isinstance(run.counts, dict) else {}
    counts = {key: value for key, value in recorded.items() if isinstance(key, str) and _integer(value) is not None}
    counts.update({key: _integer(recorded.get(key)) for key in STATUS_COUNT_KEYS})
    return {
        "started_at": run.started_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "status": run.status,
        "counts": counts,
    }


def _sync_problems():
    """R18: the latest problems of the access synchronizations (at most 50), newest first; a problem later runs met
    again is listed once, at its latest time. The engine names its subjects itself (a person's Git server name or
    e-mail, a project as `<КЛЮЧ> «название»`)."""
    latest = {}
    runs = (
        PpmForgejoSyncRun.objects.exclude(problems=[])
        .order_by("-started_at", "-id")
        .values_list("problems", flat=True)[:STATUS_PROBLEM_RUNS]
    )
    for problems in runs:
        for item in problems if isinstance(problems, list) else ():
            if not isinstance(item, dict):
                continue
            problem = {key: str(item.get(key) or "") for key in ("at", "kind", "subject", "message")}
            problem["level"] = "warning" if item.get("level") == "warning" else "error"
            moment = _moment(problem["at"])
            if moment is None:
                continue
            key = (problem["kind"], problem["subject"], problem["message"])
            if key not in latest or latest[key][0] < moment:
                latest[key] = (moment, problem)
    ordered = sorted(latest.values(), key=lambda entry: entry[0], reverse=True)
    return [problem for _, problem in ordered[:STATUS_PROBLEM_LIMIT]]


def access_status():
    """The answer of ``GET …/access/status/``: ``{configured, sso_enabled, reachable, last_full_sync, problems,
    forgejo_admin_url}``."""
    configured = forgejo_is_configured()
    sso = forgejo_sso_is_configured()
    public_url = forgejo_public_url()
    last_full_sync = None
    problems = []
    if sso:
        run = PpmForgejoSyncRun.objects.filter(kind=PpmForgejoSyncKind.FULL).order_by("-started_at", "-id").first()
        last_full_sync = _full_sync_summary(run) if run is not None else None
        problems = _sync_problems()
    return {
        "configured": configured,
        "sso_enabled": sso,
        "reachable": forgejo_server_answers() if configured else False,
        "last_full_sync": last_full_sync,
        "problems": problems,
        # Forgejo 15 keeps its site administration at /admin (`routers/web/web.go`), not at Gitea's /-/admin.
        "forgejo_admin_url": f"{public_url}/admin" if public_url else None,
    }


def reserve_manual_sync():
    """0 when «Синхронизировать сейчас» may run now (the next 30 s are then taken), else the whole seconds to wait.

    Best effort across processes: two requests meeting exactly at the end of the window may both pass — harmless, the
    full reconciliation they ask for is one pending scope, one task."""
    now = _now()
    if cache.add(SYNC_THROTTLE_KEY, now, timeout=SYNC_INTERVAL_SECONDS):
        return 0
    last = cache.get(SYNC_THROTTLE_KEY)
    if isinstance(last, (int, float)) and not isinstance(last, bool) and 0 <= now - last < SYNC_INTERVAL_SECONDS:
        return max(1, math.ceil(SYNC_INTERVAL_SECONDS - (now - last)))
    cache.set(SYNC_THROTTLE_KEY, now, timeout=SYNC_INTERVAL_SECONDS)
    return 0
