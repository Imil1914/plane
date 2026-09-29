"""G2.2 R6 — bringing a person back to the Git server's authorization request after the PPM sign-in.

The standard ``next_path`` of PPM cannot carry the request itself (it is inserted without encoding and the last step
is a client-side route), so an anonymous ``authorize/`` keeps its query in the cache under a one-time random id for
10 minutes and sends the person to the sign-in with ``next_path=/auth/oidc/continue/<id>/`` — a plain path that
passes ``validate_next_path``.

The id works only in the browser that started the sign-in: that browser holds the binding cookie, the cache holds its
SHA-256. The cache key is the SHA-256 of the id too, so neither is usable from a dump of the cache.
"""

import hashlib
import re
import secrets
import time

from django.conf import settings
from django.core.cache import cache

CONTINUE_TTL_SECONDS = 600
MAX_QUERY_LENGTH = 4096
# Visits of continue/<id>/ without a PPM session — each sends the person to the sign-in again. More than this means
# the session never reaches /auth/oidc/ (a misconfigured cookie): stop with the «expired» page instead of a loop.
MAX_ANONYMOUS_VISITS = 5
BINDING_COOKIE = "ppm-oidc-continue"
BINDING_COOKIE_PATH = "/auth/oidc/"
CONTINUE_PATH = "/auth/oidc/continue/{}/"

_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
_KEY_PREFIX = "ppm_oidc:continue:"


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _cache_key(continue_id):
    return f"{_KEY_PREFIX}{_digest(continue_id)}"


def is_well_formed(token):
    return bool(_TOKEN_PATTERN.match(token or ""))


def continue_path(continue_id):
    return CONTINUE_PATH.format(continue_id)


def binding_from(request):
    """The binding of this browser, if it already has a well-formed one."""
    value = request.COOKIES.get(BINDING_COOKIE, "")
    return value if is_well_formed(value) else ""


def new_binding():
    return secrets.token_urlsafe(32)


def set_binding_cookie(response, request, binding):
    response.set_cookie(
        BINDING_COOKIE,
        binding,
        max_age=CONTINUE_TTL_SECONDS,
        path=BINDING_COOKIE_PATH,
        secure=bool(getattr(settings, "SESSION_COOKIE_SECURE", False) or request.is_secure()),
        httponly=True,
        samesite="Lax",
    )


def remember(query_string, binding):
    """Keeps the authorization request of this browser; returns the one-time id for ``next_path``."""
    continue_id = secrets.token_urlsafe(32)
    entry = {
        "query": query_string,
        "binding": _digest(binding),
        "expires_at": time.time() + CONTINUE_TTL_SECONDS,
        "anonymous_visits": 0,
    }
    cache.set(_cache_key(continue_id), entry, CONTINUE_TTL_SECONDS)
    return continue_id


def load(continue_id, binding):
    """The kept request — only for a known, unexpired id of this browser; otherwise ``None`` (nothing is consumed)."""
    if not is_well_formed(continue_id) or not binding:
        return None
    entry = cache.get(_cache_key(continue_id))
    if not isinstance(entry, dict) or not isinstance(entry.get("query"), str):
        return None
    if not secrets.compare_digest(str(entry.get("binding", "")), _digest(binding)):
        return None
    return entry


def note_anonymous_visit(continue_id, entry):
    """Counts a visit without a PPM session; ``False`` once there were too many of them or the id has expired."""
    visits = int(entry.get("anonymous_visits", 0)) + 1
    remaining = int(float(entry.get("expires_at", 0)) - time.time())
    if visits > MAX_ANONYMOUS_VISITS or remaining <= 0:
        return False
    cache.set(_cache_key(continue_id), {**entry, "anonymous_visits": visits}, remaining)
    return True


def consume(continue_id):
    """Removes the kept request; ``True`` only for the one request that removed it (a replay or a race: ``False``)."""
    return bool(cache.delete(_cache_key(continue_id)))
