"""G2.2 — configuration helpers of PPM's OpenID Connect provider, read by ``plane/settings/common.py``.

Standard library only: settings import this module in every process — including the owner's development API, which
runs with ``uvicorn --reload`` on the same tree and does not have django-oauth-toolkit installed. There the provider
simply is not installed (``oidc_installed_apps()`` is empty, ``plane/urls.py`` mounts no ``/auth/oidc/`` routes) and
everything else keeps working.
"""

import base64
import binascii
import importlib.util
import logging
import re
from urllib.parse import urlsplit

_logger = logging.getLogger("plane")

# Both apps together or neither: plane.ppm_oidc is built on django-oauth-toolkit (import name ``oauth2_provider``),
# its tables are the OAuth2 tables of the PPM database.
OIDC_APPS = ("oauth2_provider", "plane.ppm_oidc")
OIDC_LIBRARY_MODULES = ("oauth2_provider", "jwcrypto", "oauthlib")

# The path of Forgejo's callback for the login source named exactly «PPM» (G2.2 plan: the name is in the button text,
# in the callback URL and in the redirect URI registered for the client).
FORGEJO_CALLBACK_PATH = "/user/oauth2/PPM/callback"
OIDC_MOUNT_PATH = "/auth/oidc"

# The Git server client secret is hashed with a fast salted HMAC (see plane/ppm_oidc/hashers.py for why); the hasher is
# appended to Django's PASSWORD_HASHERS, after the standard ones, so people's passwords keep PBKDF2.
CLIENT_SECRET_HASHER = "ppm_oidc_hmac_sha256"
CLIENT_SECRET_HASHER_PATH = "plane.ppm_oidc.hashers.ClientSecretHasher"

# «10/minute» — the format of the request-rate settings (the DRF throttle format, without its loose parsing).
_RATE_PATTERN = re.compile(r"^\s*([1-9][0-9]{0,6})\s*/\s*(s|sec|second|m|min|minute|h|hour|d|day)\s*$", re.IGNORECASE)

_PEM_BEGIN = "-----BEGIN "
_PEM_PRIVATE_KEY_END = "PRIVATE KEY-----"


def oidc_installed_apps(find_spec=importlib.util.find_spec):
    """The apps to add to INSTALLED_APPS: both, when the library and its dependencies are importable, else none."""
    for module in OIDC_LIBRARY_MODULES:
        try:
            if find_spec(module) is None:
                return []
        except (ImportError, ValueError):
            return []
    return list(OIDC_APPS)


def pem_from_setting(raw, *, name="PPM_OIDC_PRIVATE_KEY"):
    """The PEM text of a signing key given as the environment carries it — base64 of the PEM in one line (the bundle's
    form, R1) or the PEM itself (a ``_FILE`` with the key as is). Anything else is treated as not set: an error names
    the variable, never its value.
    """
    value = (raw or "").strip()
    if not value:
        return ""
    if value.startswith(_PEM_BEGIN):
        pem = value
    else:
        try:
            pem = base64.b64decode("".join(value.split()), validate=True).decode("utf-8").strip()
        except (binascii.Error, ValueError, UnicodeDecodeError):
            _logger.error("%s is neither base64 of a PEM private key nor a PEM private key; the key is ignored", name)
            return ""
    if not (pem.startswith(_PEM_BEGIN) and pem.endswith(_PEM_PRIVATE_KEY_END)):
        _logger.error("%s does not hold a PEM private key; the key is ignored", name)
        return ""
    return pem + "\n"


def forgejo_redirect_uri(explicit, forgejo_public_url):
    """The only redirect URI of the Git server client: set explicitly, or the Forgejo callback of the source «PPM»."""
    explicit = (explicit or "").strip()
    if explicit:
        return explicit
    public = (forgejo_public_url or "").strip().rstrip("/")
    return f"{public}{FORGEJO_CALLBACK_PATH}" if public else ""


def oidc_issuer(web_url):
    """``issuer`` = the public address of PPM + ``/auth/oidc`` (R1); empty while ``WEB_URL`` is not set."""
    web_url = (web_url or "").strip().rstrip("/")
    if not web_url:
        return ""
    parts = urlsplit(web_url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        _logger.error("WEB_URL is not an absolute http(s) address; the OpenID Connect issuer stays unset")
        return ""
    return f"{web_url}{OIDC_MOUNT_PATH}"


def normalized_rate(raw):
    """``"10/minute"`` for a valid request rate (spaces and case normalised), otherwise ``""``."""
    match = _RATE_PATTERN.match(raw or "") if isinstance(raw, str) else None
    if not match:
        return ""
    return f"{int(match.group(1))}/{match.group(2).lower()}"


def rate_setting(raw, *, default, name):
    """A request-rate setting from the environment; an invalid value falls back to ``default`` with a warning."""
    if not (raw or "").strip():
        return default
    rate = normalized_rate(raw)
    if not rate:
        _logger.warning("%s is not a request rate like 10/minute; using %s", name, default)
        return default
    return rate


def positive_int(raw, *, name="PPM_FORGEJO_SSO_SOURCE_ID"):
    """An optional positive integer from the environment; empty or invalid → ``None`` (a warning names the variable)."""
    value = (raw or "").strip()
    if not value:
        return None
    try:
        number = int(value)
    except ValueError:
        number = 0
    if number <= 0:
        _logger.warning("%s must be a positive integer; the value is ignored", name)
        return None
    return number


def oauth2_provider_settings(*, issuer, private_key, previous_private_key=""):
    """``OAUTH2_PROVIDER`` of django-oauth-toolkit for PPM's single client — the Git server (G2.2 R1–R7).

    - lifetimes (R1): code 60 s, access and ID token 5 min, refresh token 1 h;
    - scopes ``openid profile email groups``; claims — ``plane.ppm_oidc.validators.PpmOAuth2Validator`` (R4, R5);
    - ``PpmOidcServer`` calls the access module of the Git server after the code is verified and before tokens are
      issued (R9);
    - PKCE is optional (Forgejo sends none on the first sign-in after its login source is registered) but verified when
      sent, S256 only; the previous signing key stays published in the JWKS until its tokens expire (R7);
    - the client secret is stored as a fast salted HMAC (``CLIENT_SECRET_HASHER``), not PBKDF2;
    - RFC 9700 gates of the toolkit: access and refresh tokens are stored only as SHA-256 checksums (a database dump
      holds no usable token), no implicit or password grant, access tokens only in the Authorization header.
      ``COMPLIANT_BCP_RFC9700_AUTHZ_RESPONSE_ISS`` stays off: Forgejo does not read ``iss`` of the callback.
    """
    return {
        "OIDC_ENABLED": True,
        "OIDC_ISS_ENDPOINT": issuer,
        "OIDC_RSA_PRIVATE_KEY": private_key,
        "OIDC_RSA_PRIVATE_KEYS_INACTIVE": [previous_private_key] if previous_private_key else [],
        "OIDC_RESPONSE_TYPES_SUPPORTED": ["code"],
        "OIDC_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED": ["client_secret_basic", "client_secret_post"],
        "OAUTH2_RESPONSE_TYPES_SUPPORTED": ["code"],
        "OAUTH2_GRANT_TYPES_SUPPORTED": ["authorization_code", "refresh_token"],
        "OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED": ["client_secret_basic", "client_secret_post"],
        "OIDC_SERVER_CLASS": "plane.ppm_oidc.server.PpmOidcServer",
        "CLIENT_SECRET_HASHER": CLIENT_SECRET_HASHER,
        "OAUTH2_VALIDATOR_CLASS": "plane.ppm_oidc.validators.PpmOAuth2Validator",
        "SCOPES": {
            "openid": "OpenID Connect",
            "profile": "Имя и имя на Git-сервере",
            "email": "Почта",
            "groups": "Группы PPM",
        },
        "DEFAULT_SCOPES": ["openid"],
        "AUTHORIZATION_CODE_EXPIRE_SECONDS": 60,
        "ACCESS_TOKEN_EXPIRE_SECONDS": 300,
        "ID_TOKEN_EXPIRE_SECONDS": 300,
        "REFRESH_TOKEN_EXPIRE_SECONDS": 3600,
        "ROTATE_REFRESH_TOKEN": True,
        "REFRESH_TOKEN_REUSE_PROTECTION": True,
        "PKCE_REQUIRED": False,
        "ALLOW_URI_WILDCARDS": False,
        "COMPLIANT_BCP_RFC9700_IMPLICIT_GRANT": True,
        "COMPLIANT_BCP_RFC9700_PASSWORD_GRANT": True,
        "COMPLIANT_BCP_RFC9700_PKCE_METHOD": True,
        "COMPLIANT_BCP_RFC9700_ACCESS_TOKEN_TRANSPORT": True,
        "COMPLIANT_BCP_RFC9700_TOKEN_STORAGE": True,
        "COMPLIANT_BCP_RFC9700_AUTHZ_RESPONSE_ISS": False,
    }
