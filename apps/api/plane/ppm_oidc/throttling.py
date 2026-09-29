"""G2.2 R7 — request rates of the OpenID Connect endpoints, counted per client address in the Django cache.

DRF throttling does not run for the toolkit's plain Django views, so the views ask these throttles themselves (the same
approach as ``plane.authentication.rate_limit.authentication_throttle_allows``).

- The client address is the LAST element of ``X-Forwarded-For`` — the one the proxy in front of PPM appended (Caddy
  keeps no address a client sends in the header) — or ``REMOTE_ADDR`` without the header. The first element is
  whatever the client wrote there.
- token/ counts only failed client authentications (``invalid_client``). Every sign-in of everybody reaches token/ from
  the Git server's own address, and anybody can make the Git server exchange a made-up code (its callback is public):
  counting those would let a stranger lock the whole organisation out of the Git server. A wrong or missing client
  secret is what an attacker controls, and that is slowed down; the authenticated client is never throttled.
- An invalid rate in the settings falls back to the default (with a warning) instead of failing requests.
"""

import ipaddress
import logging
import time

from django.conf import settings
from django.core.cache import cache
from rest_framework.throttling import SimpleRateThrottle

from plane.ppm_oidc import conf

logger = logging.getLogger("plane.api")

_PERIOD_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
_warned_rates = set()


def client_address(request):
    """The address of the client as the proxy in front of PPM saw it (see the module docstring)."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "") or ""
    candidate = forwarded.split(",")[-1].strip() if forwarded.strip() else ""
    if candidate:
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            pass
    return (request.META.get("REMOTE_ADDR") or "unknown").strip()[:64]


def configured_rate(setting_name, default):
    raw = getattr(settings, setting_name, "")
    rate = conf.normalized_rate(raw)
    if rate:
        return rate
    if raw and (setting_name, raw) not in _warned_rates:
        _warned_rates.add((setting_name, raw))
        logger.warning("%s is not a request rate like 10/minute; using %s", setting_name, default)
    return default


def _parse(rate):
    count, period = rate.split("/")
    return int(count), _PERIOD_SECONDS[period[0]]


class _PpmOidcThrottle(SimpleRateThrottle):
    setting_name = ""
    default_rate = ""
    cache_format = "ppm_oidc_throttle_%(scope)s_%(ident)s"

    def get_rate(self):
        return configured_rate(self.setting_name, self.default_rate)

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": client_address(request)}


class ContinueThrottle(_PpmOidcThrottle):
    scope = "ppm_oidc_continue"
    setting_name = "PPM_OIDC_CONTINUE_RATE_LIMIT"
    default_rate = "60/minute"


class AuthorizeThrottle(_PpmOidcThrottle):
    # Every authorization request writes something: a kept request in the cache or a code in the database.
    scope = "ppm_oidc_authorize"
    setting_name = "PPM_OIDC_AUTHORIZE_RATE_LIMIT"
    default_rate = "120/minute"


def allows(throttle_class, request):
    """``(True, 0)`` when the request is within the rate, else ``(False, seconds to wait)``."""
    throttle = throttle_class()
    if throttle.allow_request(request, None):
        return True, 0
    wait = throttle.wait()
    return False, max(1, int(wait or 60))


class TokenFailureThrottle:
    """Failed client authentications at token/ of one client address within a sliding window."""

    scope = "ppm_oidc_token_failures"
    setting_name = "PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT"
    default_rate = "10/minute"

    def __init__(self, request):
        self.key = f"ppm_oidc_throttle_{self.scope}_{client_address(request)}"
        self.limit, self.duration = _parse(configured_rate(self.setting_name, self.default_rate))

    def _history(self, now):
        history = cache.get(self.key, [])
        if not isinstance(history, list):
            return []
        # Newest first; only the newest ``limit`` failures can decide anything.
        return [moment for moment in history if isinstance(moment, float) and moment > now - self.duration][
            : self.limit
        ]

    def retry_after(self):
        """0 while the address may authenticate, else the seconds until its oldest counted failure expires."""
        now = time.time()
        history = self._history(now)
        if len(history) < self.limit:
            return 0
        return max(1, int(history[-1] + self.duration - now) + 1)

    def record_failure(self):
        now = time.time()
        cache.set(self.key, [now, *self._history(now)][: self.limit], self.duration)
