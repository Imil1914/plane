"""G2.2 — is PPM's OpenID Connect provider on, who may sign in, and where its endpoints are.

No django-oauth-toolkit imports here: the management command and the views ask these questions before touching the
toolkit, and ``--status`` must answer them on a half-configured server too.
"""

import functools
import logging
import re
from urllib.parse import urlsplit

from django.conf import settings

logger = logging.getLogger("plane.api")

# The secret of the only client (R3) must be random: at least 32 hex digits (128 bits; the bundle generates 48). The
# fast hasher of plane/ppm_oidc/hashers.py relies on that — a guessable secret would need a slow KDF.
CLIENT_SECRET_PATTERN = re.compile(r"^[0-9a-fA-F]{32,}$")
MIN_RSA_KEY_BITS = 2048
PPM_ADMINS_GROUP = "ppm-admins"


def sso_switch_is_on():
    """``PPM_GIT_SSO_ENABLED=1`` — the operator's switch (R26: 0 returns the G2.1 mode)."""
    return bool(getattr(settings, "PPM_GIT_SSO_ENABLED", False))


def configured_client_id():
    return (getattr(settings, "PPM_OIDC_CLIENT_ID", "") or "").strip()


def issuer():
    """The ``issuer`` of discovery and of every ID token: one source — ``OAUTH2_PROVIDER["OIDC_ISS_ENDPOINT"]``."""
    return ((getattr(settings, "OAUTH2_PROVIDER", None) or {}).get("OIDC_ISS_ENDPOINT") or "").rstrip("/")


def internal_base_url():
    """``PPM_OIDC_INTERNAL_URL`` + ``/auth/oidc`` — the API as Forgejo reaches it inside the bundle (R2)."""
    base = (getattr(settings, "PPM_OIDC_INTERNAL_URL", "") or "").strip().rstrip("/")
    return f"{base}/auth/oidc" if base else ""


@functools.lru_cache(maxsize=8)
def rsa_key_bits(pem):
    """Bits of an RSA private key in PEM, or 0 when the text is not one (the key itself never leaves this function)."""
    if not pem:
        return 0
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    try:
        key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
    except (ValueError, TypeError):
        return 0
    return key.key_size if isinstance(key, rsa.RSAPrivateKey) else 0


def _is_absolute_url(value):
    parts = urlsplit(value or "")
    return parts.scheme in ("http", "https") and bool(parts.netloc) and not parts.fragment


def configuration_problems():
    """Names of the settings that keep the provider off, in a stable order; empty when it can serve the Git server.

    Only names — never values: the list is printed by ``ppm_oidc_client --status`` and written to the log.
    """
    problems = []
    if not issuer():
        problems.append("WEB_URL")
    if rsa_key_bits(getattr(settings, "PPM_OIDC_PRIVATE_KEY", "")) < MIN_RSA_KEY_BITS:
        problems.append("PPM_OIDC_PRIVATE_KEY")
    previous = getattr(settings, "PPM_OIDC_PREVIOUS_PRIVATE_KEY", "")
    if previous and rsa_key_bits(previous) < MIN_RSA_KEY_BITS:
        problems.append("PPM_OIDC_PREVIOUS_PRIVATE_KEY")
    if not configured_client_id():
        problems.append("PPM_OIDC_CLIENT_ID")
    if not CLIENT_SECRET_PATTERN.match(getattr(settings, "PPM_OIDC_CLIENT_SECRET", "") or ""):
        problems.append("PPM_OIDC_CLIENT_SECRET")
    if not _is_absolute_url(getattr(settings, "PPM_OIDC_FORGEJO_REDIRECT_URI", "")):
        problems.append("PPM_OIDC_FORGEJO_REDIRECT_URI")
    if not _is_absolute_url(internal_base_url()):
        problems.append("PPM_OIDC_INTERNAL_URL")
    return problems


_reported_problems = None


def sso_is_enabled():
    """The ``/auth/oidc/*`` endpoints answer only with the switch on and a complete configuration; otherwise 404."""
    global _reported_problems
    if not sso_switch_is_on():
        return False
    problems = configuration_problems()
    if problems:
        # Once per process and set of problems: every request to /auth/oidc/* asks, the log should not repeat it.
        if tuple(problems) != _reported_problems:
            _reported_problems = tuple(problems)
            logger.warning(
                "PPM_GIT_SSO_ENABLED=1, but the OpenID Connect provider is not configured: %s", ", ".join(problems)
            )
        return False
    return True


def user_may_sign_in(user):
    """R5: only active people (not bots) with an e-mail address sign in to the Git server."""
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if not getattr(user, "is_active", False) or getattr(user, "is_bot", False):
        return False
    email = (getattr(user, "email", "") or "").strip()
    return "@" in email


def display_name(user):
    """R4 ``name``: the display name, otherwise first and last name, otherwise the part of the e-mail before ``@``."""
    name = (getattr(user, "display_name", "") or "").strip()
    if name:
        return name
    full_name = f"{getattr(user, 'first_name', '') or ''} {getattr(user, 'last_name', '') or ''}".strip()
    if full_name:
        return full_name
    return (getattr(user, "email", "") or "").split("@")[0]
