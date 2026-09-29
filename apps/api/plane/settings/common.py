# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Global Settings"""

# Python imports
import ipaddress
import logging
import os
from pathlib import Path
from urllib.parse import urlparse
from urllib.parse import urljoin

# Third party imports
import dj_database_url

# Django imports
from django.conf import global_settings
from django.core.management.utils import get_random_secret_key
from corsheaders.defaults import default_headers


# Module imports
from plane.utils.url import is_valid_url

# G2.2: standard library only — safe where django-oauth-toolkit is not installed (see the provider block below).
from plane.ppm_oidc import conf as ppm_oidc_conf


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_logger = logging.getLogger("plane")

# Secret Key — use `or` so an explicitly empty env var is treated the same as unset,
# falling back to a random key rather than passing "" to Django (GHSA-cmwv-pjmw-8483).
SECRET_KEY = os.environ.get("SECRET_KEY") or get_random_secret_key()
# Refuse to run silently with a publicly-known or placeholder SECRET_KEY
# (GHSA-cmwv-pjmw-8483). Emit a critical log so operators notice immediately.
# The `or get_random_secret_key()` above means the only way to reach this branch
# is if the environment explicitly passes one of the flagged values.
_INSECURE_SECRET_KEYS = {
    "60gp0byfz2dvffa45cxl20p1scy9xbpf6d8c5y0geejgkyp1b5",  # old publicly-known default
    "change-this-key-on-deployment",  # placeholder shipped in community templates
}
if SECRET_KEY in _INSECURE_SECRET_KEYS:
    _logger.critical(
        "SECURITY: SECRET_KEY is set to a known insecure or placeholder value. "
        "This makes your installation vulnerable to session forgery, CSRF bypass, and "
        "password-reset token forging. Set a unique SECRET_KEY before deploying to production. "
        "Generate one with: "
        'python3 -c "from django.utils.crypto import get_random_secret_key; print(get_random_secret_key())"'
    )

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = int(os.environ.get("DEBUG", "0"))

# Self-hosted mode
IS_SELF_MANAGED = True

# Webhook IP allowlist — comma-separated IPs or CIDR ranges that are allowed as
# webhook targets even if they resolve to private networks.
# Example: "10.0.0.0/8,192.168.1.0/24,172.16.0.5"
_webhook_allowed_ips_raw = os.environ.get("WEBHOOK_ALLOWED_IPS", "")
WEBHOOK_ALLOWED_IPS = []
for _cidr in _webhook_allowed_ips_raw.split(","):
    _cidr = _cidr.strip()
    if not _cidr:
        continue
    try:
        WEBHOOK_ALLOWED_IPS.append(ipaddress.ip_network(_cidr, strict=False))
    except ValueError:
        _logger.warning("WEBHOOK_ALLOWED_IPS: skipping invalid entry %r", _cidr)

# Webhook hostname allowlist — comma-separated hostnames that bypass the
# private-IP SSRF check. Useful for trusted internal services whose IPs are
# dynamic in containerised deployments (e.g. docker-compose service DNS,
# kubernetes service hostnames).
# Example: "silo,silo.namespace.svc.cluster.local,internal-api.lan"
_webhook_allowed_hosts_raw = os.environ.get("WEBHOOK_ALLOWED_HOSTS", "")
WEBHOOK_ALLOWED_HOSTS = [
    _host.strip().rstrip(".").lower() for _host in _webhook_allowed_hosts_raw.split(",") if _host.strip()
]

# Webhook disallowed domains — comma-separated hostnames. Webhooks targeting
# these domains or any of their subdomains are rejected (the request host is
# always appended at validation time as a loop-back guard). Empty by default
# for self-hosted deployments; set to e.g. "plane.so" to block specific domains.
_webhook_disallowed_domains_raw = os.environ.get("WEBHOOK_DISALLOWED_DOMAINS", "")
WEBHOOK_DISALLOWED_DOMAINS = [
    _d.strip().rstrip(".").lower() for _d in _webhook_disallowed_domains_raw.split(",") if _d.strip()
]

# Allowed Hosts
ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "*").split(",")

# Application definition
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    # Inhouse apps
    "plane.analytics",
    "plane.app",
    "plane.space",
    "plane.bgtasks",
    "plane.db",
    "plane.utils",
    "plane.web",
    "plane.middleware",
    "plane.license",
    "plane.api",
    "plane.authentication",
    "plane.ppm_brain",
    "plane.ppm_canvas",
    "plane.ppm_git",
    "plane.ppm_realtime",
    "plane.ppm_vault",
    # Third-party things
    "rest_framework",
    "corsheaders",
    "django_celery_beat",
]

# Middlewares
MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "plane.authentication.middleware.session.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "crum.CurrentRequestUserMiddleware",
    "django.middleware.gzip.GZipMiddleware",
    "plane.middleware.request_body_size.RequestBodySizeLimitMiddleware",
    "plane.middleware.logger.APITokenLogMiddleware",
    "plane.middleware.logger.RequestLoggerMiddleware",
]

# Rest Framework settings
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ("rest_framework.authentication.SessionAuthentication",),
    "DEFAULT_THROTTLE_CLASSES": ("rest_framework.throttling.AnonRateThrottle",),
    "DEFAULT_THROTTLE_RATES": {
        "anon": "30/minute",
        "asset_id": "5/minute",
        # Shared-IP clients all request this public, cached endpoint while bootstrapping.
        "ppm_instance_bootstrap": os.environ.get("PPM_INSTANCE_BOOTSTRAP_RATE_LIMIT", "300/minute"),
    },
    "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.IsAuthenticated",),
    "DEFAULT_RENDERER_CLASSES": ("rest_framework.renderers.JSONRenderer",),
    "DEFAULT_FILTER_BACKENDS": ("django_filters.rest_framework.DjangoFilterBackend",),
    "EXCEPTION_HANDLER": "plane.authentication.adapter.exception.auth_exception_handler",
    # Preserve original Django URL parameter names (pk) instead of converting to 'id'
    "SCHEMA_COERCE_PATH_PK": False,
}

# API key throttle rate (DRF SimpleRateThrottle format, e.g. "60/minute")
API_KEY_RATE_LIMIT = os.environ.get("API_KEY_RATE_LIMIT", "60/minute")

# Project Brain stays keyword-only unless an operator explicitly approves external
# text processing and configures a provider. API keys remain server environment only.
PPM_BRAIN_ENABLED = os.environ.get("PPM_BRAIN_ENABLED", "1") == "1"
PPM_BRAIN_GRAPH_ENABLED = os.environ.get("PPM_BRAIN_GRAPH_ENABLED", "1") == "1"
PPM_BRAIN_EMBEDDING_PROVIDER = os.environ.get("PPM_BRAIN_EMBEDDING_PROVIDER", "disabled")
PPM_BRAIN_ALLOW_EXTERNAL_EMBEDDINGS = os.environ.get("PPM_BRAIN_ALLOW_EXTERNAL_EMBEDDINGS", "0") == "1"
PPM_BRAIN_EMBEDDING_MODEL = os.environ.get("PPM_BRAIN_EMBEDDING_MODEL", "text-embedding-3-small")
PPM_BRAIN_ANSWERS_ENABLED = os.environ.get("PPM_BRAIN_ANSWERS_ENABLED", "1") == "1"
PPM_BRAIN_COMPLETION_PROVIDER = os.environ.get("PPM_BRAIN_COMPLETION_PROVIDER", "disabled")
PPM_BRAIN_ALLOW_EXTERNAL_COMPLETIONS = os.environ.get("PPM_BRAIN_ALLOW_EXTERNAL_COMPLETIONS", "0") == "1"
PPM_BRAIN_COMPLETION_MODEL = os.environ.get("PPM_BRAIN_COMPLETION_MODEL", "gpt-4o-mini")
PPM_BRAIN_COMPLETION_POLICY_VERSION = os.environ.get("PPM_BRAIN_COMPLETION_POLICY_VERSION", "").strip()
PPM_BRAIN_COMPLETION_TIMEOUT_SECONDS = int(os.environ.get("PPM_BRAIN_COMPLETION_TIMEOUT_SECONDS", "45"))
# Agent registry and proposal records are available without an external model.
# Canonical writes remain disabled until the owner approves model/retention policy
# and the individual apply paths pass their permission/precondition gates.
PPM_AGENTS_ENABLED = os.environ.get("PPM_AGENTS_ENABLED", "1") == "1"
PPM_AGENTS_WRITE_ENABLED = os.environ.get("PPM_AGENTS_WRITE_ENABLED", "0") == "1"
try:
    PPM_AGENT_RUN_TIMEOUT_SECONDS = int(os.environ.get("PPM_AGENT_RUN_TIMEOUT_SECONDS", "120"))
    if not 30 <= PPM_AGENT_RUN_TIMEOUT_SECONDS <= 3600:
        raise ValueError
except ValueError:
    _logger.warning("PPM_AGENT_RUN_TIMEOUT_SECONDS must be between 30 and 3600; using 120 seconds")
    PPM_AGENT_RUN_TIMEOUT_SECONDS = 120
try:
    PPM_AGENT_LEASE_SECONDS = int(os.environ.get("PPM_AGENT_LEASE_SECONDS", "180"))
    if not 60 <= PPM_AGENT_LEASE_SECONDS <= 600:
        raise ValueError
except ValueError:
    _logger.warning("PPM_AGENT_LEASE_SECONDS must be between 60 and 600; using 180 seconds")
    PPM_AGENT_LEASE_SECONDS = 180
try:
    PPM_AGENT_MAX_ATTEMPTS = int(os.environ.get("PPM_AGENT_MAX_ATTEMPTS", "3"))
    if not 1 <= PPM_AGENT_MAX_ATTEMPTS <= 10:
        raise ValueError
except ValueError:
    _logger.warning("PPM_AGENT_MAX_ATTEMPTS must be between 1 and 10; using 3 attempts")
    PPM_AGENT_MAX_ATTEMPTS = 3
_ppm_brain_embedding_dimensions = os.environ.get("PPM_BRAIN_EMBEDDING_DIMENSIONS", "").strip()
try:
    PPM_BRAIN_EMBEDDING_DIMENSIONS = int(_ppm_brain_embedding_dimensions) if _ppm_brain_embedding_dimensions else None
    if PPM_BRAIN_EMBEDDING_DIMENSIONS is not None and PPM_BRAIN_EMBEDDING_DIMENSIONS <= 0:
        raise ValueError
except ValueError:
    _logger.warning("PPM_BRAIN_EMBEDDING_DIMENSIONS must be a positive integer; using provider default")
    PPM_BRAIN_EMBEDDING_DIMENSIONS = None

# PPM rollout switches. The legacy default-board Canvas adapter remains available
# when multi-board routes are disabled so a rollback does not strand saved data.
PPM_CANVAS_MULTIBOARD_ENABLED = os.environ.get("PPM_CANVAS_MULTIBOARD_ENABLED", "1") == "1"
PPM_GLOBAL_ADMIN_ENABLED = os.environ.get("PPM_GLOBAL_ADMIN_ENABLED", "1") == "1"
PPM_ADMIN_CENTER_ENABLED = os.environ.get("PPM_ADMIN_CENTER_ENABLED", "1") == "1"
PPM_ADMIN_REAUTH_TTL_SECONDS = int(os.environ.get("PPM_ADMIN_REAUTH_TTL_SECONDS", "600"))
# UX2.1: project events socket /ws/ppm/v1/workspaces/<slug>/events/ and their publication after commit.
PPM_REALTIME_EVENTS_ENABLED = os.environ.get("PPM_REALTIME_EVENTS_ENABLED", "1") == "1"
PPM_VAULT_MARKDOWN_MAX_BYTES = int(os.environ.get("PPM_VAULT_MARKDOWN_MAX_BYTES", "1048576"))
PPM_VAULT_PDF_MAX_BYTES = int(os.environ.get("PPM_VAULT_PDF_MAX_BYTES", os.environ.get("FILE_SIZE_LIMIT", "5242880")))
PPM_VAULT_STORAGE_ROOT = os.environ.get("PPM_VAULT_STORAGE_ROOT")


def _ppm_secret(value_name, file_name):
    file_path = os.environ.get(file_name, "").strip()
    if file_path:
        try:
            return Path(file_path).read_text(encoding="utf-8").strip()
        except OSError:
            _logger.error("PPM secret file is unavailable: %s", file_name)
            return ""
    return os.environ.get(value_name, "").replace("\\n", "\n").strip()


# Completion credentials are dedicated to Project Brain and never fall back to
# legacy OPENAI_API_KEY variables. This prevents accidental egress when an old
# Plane integration happens to be configured on the same host.
PPM_BRAIN_COMPLETION_API_KEY = _ppm_secret(
    "PPM_BRAIN_COMPLETION_API_KEY",
    "PPM_BRAIN_COMPLETION_API_KEY_FILE",
)


# GitHub App credentials stay on the API server. Installation access tokens are
# generated on demand and are never persisted by PPM.
PPM_GITHUB_APP_ID = os.environ.get("PPM_GITHUB_APP_ID", "").strip()
PPM_GITHUB_APP_SLUG = os.environ.get("PPM_GITHUB_APP_SLUG", "").strip()
PPM_GITHUB_APP_CLIENT_ID = os.environ.get("PPM_GITHUB_APP_CLIENT_ID", "").strip()
PPM_GITHUB_CALLBACK_URL = os.environ.get("PPM_GITHUB_CALLBACK_URL", "").strip()
PPM_GITHUB_APP_CLIENT_SECRET = _ppm_secret(
    "PPM_GITHUB_APP_CLIENT_SECRET",
    "PPM_GITHUB_APP_CLIENT_SECRET_FILE",
)
PPM_GITHUB_APP_PRIVATE_KEY = _ppm_secret(
    "PPM_GITHUB_APP_PRIVATE_KEY",
    "PPM_GITHUB_APP_PRIVATE_KEY_FILE",
)
PPM_GITHUB_WEBHOOK_SECRET = _ppm_secret(
    "PPM_GITHUB_WEBHOOK_SECRET",
    "PPM_GITHUB_WEBHOOK_SECRET_FILE",
)
PPM_GITHUB_API_VERSION = os.environ.get("PPM_GITHUB_API_VERSION", "2022-11-28").strip()
PPM_GITHUB_WEBHOOK_MAX_BYTES = int(os.environ.get("PPM_GITHUB_WEBHOOK_MAX_BYTES", "2097152"))
PPM_GITHUB_CONNECT_STATE_TTL_SECONDS = int(os.environ.get("PPM_GITHUB_CONNECT_STATE_TTL_SECONDS", "600"))
# Provider writes stay disabled until the owner accepts the write-permission ADR
# and the explicit branch/draft-PR applier. Preview and approval remain local.
PPM_GIT_WRITE_ENABLED = os.environ.get("PPM_GIT_WRITE_ENABLED", "0") == "1"
PPM_GITHUB_APP_CONFIGURED = all(
    (
        PPM_GITHUB_APP_ID,
        PPM_GITHUB_APP_SLUG,
        PPM_GITHUB_APP_CLIENT_ID,
        PPM_GITHUB_CALLBACK_URL,
        PPM_GITHUB_APP_CLIENT_SECRET,
        PPM_GITHUB_APP_PRIVATE_KEY,
        PPM_GITHUB_WEBHOOK_SECRET,
    )
)

# G2.1: PPM's own Git server (Forgejo next to PPM, deployments/ppm). PPM reads it over the internal address with a
# read-only token of the service account ppm-bot and receives its signed system webhook. The provider is on only when
# the four values below are all set (`providers.forgejo.forgejo_is_configured`); the token and the secret never leave
# the API server.
PPM_FORGEJO_URL = os.environ.get("PPM_FORGEJO_URL", "").strip()
PPM_FORGEJO_PUBLIC_URL = os.environ.get("PPM_FORGEJO_PUBLIC_URL", "").strip()
PPM_FORGEJO_TOKEN = _ppm_secret("PPM_FORGEJO_TOKEN", "PPM_FORGEJO_TOKEN_FILE")
PPM_FORGEJO_WEBHOOK_SECRET = _ppm_secret("PPM_FORGEJO_WEBHOOK_SECRET", "PPM_FORGEJO_WEBHOOK_SECRET_FILE")
PPM_FORGEJO_WEBHOOK_MAX_BYTES = int(os.environ.get("PPM_FORGEJO_WEBHOOK_MAX_BYTES", "2097152"))
# Forgejo reports an SSH clone address even with its SSH server off; "0" (the bundle's PPM_GIT_SSH_ENABLED=0) makes
# PPM show and store no SSH address for Forgejo repositories.
PPM_FORGEJO_SSH_ENABLED = os.environ.get("PPM_FORGEJO_SSH_ENABLED", "1").strip() != "0"

# G2.2: single sign-on to PPM's own Git server. PPM is the OpenID Connect provider (plane.ppm_oidc on
# django-oauth-toolkit) of exactly one client — Forgejo, which exchanges codes and reads userinfo over the internal
# address of the API; at sign-in PPM ensures the person's Forgejo account and access through the access module
# (plane.ppm_git.forgejo_access, admin token below). Everything stays off without PPM_GIT_SSO_ENABLED=1 and a complete
# configuration: /auth/oidc/* answers 404, the access module does nothing. The signing key, the client secret and the
# admin token come only from the environment (never the database, so never a backup) and never leave the API server.
PPM_GIT_SSO_ENABLED = os.environ.get("PPM_GIT_SSO_ENABLED", "0").strip() == "1"
PPM_OIDC_CLIENT_ID = os.environ.get("PPM_OIDC_CLIENT_ID", "").strip() or "forgejo"
PPM_OIDC_CLIENT_SECRET = _ppm_secret("PPM_OIDC_CLIENT_SECRET", "PPM_OIDC_CLIENT_SECRET_FILE")
# RS256 signing key: base64 of the PEM in one line (the bundle's form) or, in a _FILE, the PEM itself. The previous key
# is published in the JWKS during a rotation, until the tokens it signed have expired.
PPM_OIDC_PRIVATE_KEY = ppm_oidc_conf.pem_from_setting(
    _ppm_secret("PPM_OIDC_PRIVATE_KEY", "PPM_OIDC_PRIVATE_KEY_FILE"), name="PPM_OIDC_PRIVATE_KEY"
)
PPM_OIDC_PREVIOUS_PRIVATE_KEY = ppm_oidc_conf.pem_from_setting(
    _ppm_secret("PPM_OIDC_PREVIOUS_PRIVATE_KEY", "PPM_OIDC_PREVIOUS_PRIVATE_KEY_FILE"),
    name="PPM_OIDC_PREVIOUS_PRIVATE_KEY",
)
# The API as Forgejo reaches it inside the bundle: the internal discovery points token/userinfo/jwks there.
PPM_OIDC_INTERNAL_URL = (os.environ.get("PPM_OIDC_INTERNAL_URL", "").strip() or "http://api:8000").rstrip("/")
# The only redirect URI of the client: Forgejo's callback of the login source named «PPM».
PPM_OIDC_FORGEJO_REDIRECT_URI = ppm_oidc_conf.forgejo_redirect_uri(
    os.environ.get("PPM_OIDC_FORGEJO_REDIRECT_URI", ""), PPM_FORGEJO_PUBLIC_URL
)
# Written by the bundle's git-bootstrap: the admin token of ppm-bot (write:admin, write:organization,
# read:repository, read:user) — only for the access module; and the id of Forgejo's login source «PPM».
PPM_FORGEJO_ADMIN_TOKEN = _ppm_secret("PPM_FORGEJO_ADMIN_TOKEN", "PPM_FORGEJO_ADMIN_TOKEN_FILE")
PPM_FORGEJO_SSO_SOURCE_ID = ppm_oidc_conf.positive_int(os.environ.get("PPM_FORGEJO_SSO_SOURCE_ID", ""))
# Per client address (the last X-Forwarded-For element), Django cache; an invalid value falls back to the default.
# token/ counts only failed client authentications: every sign-in of anybody comes from Forgejo's own address.
PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT = ppm_oidc_conf.rate_setting(
    os.environ.get("PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT"), default="10/minute", name="PPM_OIDC_TOKEN_FAILURE_RATE_LIMIT"
)
PPM_OIDC_CONTINUE_RATE_LIMIT = ppm_oidc_conf.rate_setting(
    os.environ.get("PPM_OIDC_CONTINUE_RATE_LIMIT"), default="60/minute", name="PPM_OIDC_CONTINUE_RATE_LIMIT"
)
PPM_OIDC_AUTHORIZE_RATE_LIMIT = ppm_oidc_conf.rate_setting(
    os.environ.get("PPM_OIDC_AUTHORIZE_RATE_LIMIT"), default="120/minute", name="PPM_OIDC_AUTHORIZE_RATE_LIMIT"
)

# Django Auth Backend
AUTHENTICATION_BACKENDS = ("django.contrib.auth.backends.ModelBackend",)  # default

# Root Urls
ROOT_URLCONF = "plane.urls"

# Templates
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": ["templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]


# CORS Settings
CORS_ALLOW_CREDENTIALS = True
cors_origins_raw = os.environ.get("CORS_ALLOWED_ORIGINS", "")
# filter out empty strings
cors_allowed_origins = [origin.strip() for origin in cors_origins_raw.split(",") if origin.strip()]
if cors_allowed_origins:
    CORS_ALLOWED_ORIGINS = cors_allowed_origins
    secure_origins = False if [origin for origin in cors_allowed_origins if "http:" in origin] else True
else:
    CORS_ALLOW_ALL_ORIGINS = True
    secure_origins = False

CORS_ALLOW_HEADERS = [*default_headers, "X-API-Key", "X-Request-ID"]

# Application Settings
WSGI_APPLICATION = "plane.wsgi.application"
ASGI_APPLICATION = "plane.asgi.application"

# Django Sites
SITE_ID = 1

# User Model
AUTH_USER_MODEL = "db.User"

# Database
if bool(os.environ.get("DATABASE_URL")):
    # Parse database configuration from $DATABASE_URL
    DATABASES = {"default": dj_database_url.config()}
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ.get("POSTGRES_DB"),
            "USER": os.environ.get("POSTGRES_USER"),
            "PASSWORD": os.environ.get("POSTGRES_PASSWORD"),
            "HOST": os.environ.get("POSTGRES_HOST"),
            "PORT": os.environ.get("POSTGRES_PORT", "5432"),
        }
    }


if os.environ.get("ENABLE_READ_REPLICA", "0") == "1":
    if bool(os.environ.get("DATABASE_READ_REPLICA_URL")):
        # Parse database configuration from $DATABASE_URL
        DATABASES["replica"] = dj_database_url.parse(os.environ.get("DATABASE_READ_REPLICA_URL"))
    else:
        DATABASES["replica"] = {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ.get("POSTGRES_READ_REPLICA_DB"),
            "USER": os.environ.get("POSTGRES_READ_REPLICA_USER"),
            "PASSWORD": os.environ.get("POSTGRES_READ_REPLICA_PASSWORD"),
            "HOST": os.environ.get("POSTGRES_READ_REPLICA_HOST"),
            "PORT": os.environ.get("POSTGRES_READ_REPLICA_PORT", "5432"),
        }

    # Database Routers
    DATABASE_ROUTERS = ["plane.utils.core.dbrouters.ReadReplicaRouter"]
    # Add middleware at the end for read replica routing
    MIDDLEWARE.append("plane.middleware.db_routing.ReadReplicaRoutingMiddleware")


# Redis Config
REDIS_URL = os.environ.get("REDIS_URL")
REDIS_SSL = REDIS_URL and "rediss" in REDIS_URL

# PPM Canvas realtime rooms must work across API processes. Redis is the
# production channel layer; the in-memory fallback exists only for isolated
# checks where Redis is intentionally absent.
if REDIS_URL:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {
                "hosts": [REDIS_URL],
                "capacity": int(os.environ.get("PPM_REALTIME_CHANNEL_CAPACITY", 300)),
                "expiry": int(os.environ.get("PPM_REALTIME_MESSAGE_EXPIRY", 30)),
                "group_expiry": int(os.environ.get("PPM_REALTIME_GROUP_EXPIRY", 90)),
            },
        }
    }
else:
    CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}

if REDIS_SSL:
    CACHES = {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": REDIS_URL,
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                "CONNECTION_POOL_KWARGS": {"ssl_cert_reqs": False},
            },
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": REDIS_URL,
            "OPTIONS": {"CLIENT_CLASS": "django_redis.client.DefaultClient"},
        }
    }

# Django's hashers first (people's passwords keep PBKDF2); G2.2 appends the fast hasher of the Git server client
# secret — a random value of 128+ bits, see plane/ppm_oidc/hashers.py (Django and the standard library only).
PASSWORD_HASHERS = [*global_settings.PASSWORD_HASHERS, ppm_oidc_conf.CLIENT_SECRET_HASHER_PATH]

# Password validations
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# Password reset time the number of seconds the uniquely generated uid will be valid
PASSWORD_RESET_TIMEOUT = 3600

# Static files (CSS, JavaScript, Images)
STATIC_URL = "/static/"
STATIC_ROOT = os.path.join(BASE_DIR, "static-assets", "collected-static")
STATICFILES_DIRS = (os.path.join(BASE_DIR, "static"),)

# Media Settings
MEDIA_ROOT = "mediafiles"
MEDIA_URL = "/media/"

# Internationalization
LANGUAGE_CODE = "en-us"
USE_I18N = True

# Timezones
USE_TZ = True
TIME_ZONE = "UTC"

# Default Auto Field
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Email settings
EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"

# Storage Settings
# Use Minio settings
USE_MINIO = int(os.environ.get("USE_MINIO", 0)) == 1

STORAGES = {"staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"}}
STORAGES["default"] = {"BACKEND": "plane.settings.storage.S3Storage"}
AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "access-key")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "secret-key")
AWS_STORAGE_BUCKET_NAME = os.environ.get("AWS_S3_BUCKET_NAME", "uploads")
AWS_REGION = os.environ.get("AWS_REGION", "")
AWS_DEFAULT_ACL = "public-read"
AWS_QUERYSTRING_AUTH = False
AWS_S3_FILE_OVERWRITE = False
AWS_S3_ENDPOINT_URL = os.environ.get("AWS_S3_ENDPOINT_URL", None) or os.environ.get("MINIO_ENDPOINT_URL", None)
if AWS_S3_ENDPOINT_URL and USE_MINIO:
    parsed_url = urlparse(os.environ.get("WEB_URL", "http://localhost"))
    AWS_S3_CUSTOM_DOMAIN = f"{parsed_url.netloc}/{AWS_STORAGE_BUCKET_NAME}"
    AWS_S3_URL_PROTOCOL = f"{parsed_url.scheme}:"

# RabbitMQ connection settings
RABBITMQ_HOST = os.environ.get("RABBITMQ_HOST", "localhost")
RABBITMQ_PORT = os.environ.get("RABBITMQ_PORT", "5672")
RABBITMQ_USER = os.environ.get("RABBITMQ_USER", "guest")
RABBITMQ_PASSWORD = os.environ.get("RABBITMQ_PASSWORD", "guest")
RABBITMQ_VHOST = os.environ.get("RABBITMQ_VHOST", "/")
AMQP_URL = os.environ.get("AMQP_URL")

# Celery Configuration
if AMQP_URL:
    CELERY_BROKER_URL = AMQP_URL
else:
    CELERY_BROKER_URL = f"amqp://{RABBITMQ_USER}:{RABBITMQ_PASSWORD}@{RABBITMQ_HOST}:{RABBITMQ_PORT}/{RABBITMQ_VHOST}"

CELERY_TIMEZONE = TIME_ZONE
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["application/json"]


CELERY_IMPORTS = (
    # scheduled tasks
    "plane.bgtasks.issue_automation_task",
    "plane.bgtasks.exporter_expired_task",
    "plane.bgtasks.file_asset_task",
    "plane.bgtasks.email_notification_task",
    "plane.bgtasks.cleanup_task",
    "plane.license.bgtasks.telemetry_metrics",
    # management tasks
    "plane.bgtasks.dummy_data_task",
    # issue version tasks
    "plane.bgtasks.issue_version_sync",
    "plane.bgtasks.issue_description_version_sync",
    # G2.2: registered even without django-oauth-toolkit (then it does nothing), so its daily beat entry is never an
    # unknown task
    "plane.ppm_oidc.tasks",
)

FILE_SIZE_LIMIT = int(os.environ.get("FILE_SIZE_LIMIT", 5242880))

# Unsplash Access key
UNSPLASH_ACCESS_KEY = os.environ.get("UNSPLASH_ACCESS_KEY")
# Github Access Token
GITHUB_ACCESS_TOKEN = os.environ.get("GITHUB_ACCESS_TOKEN", False)

# Analytics
ANALYTICS_SECRET_KEY = os.environ.get("ANALYTICS_SECRET_KEY", False)
ANALYTICS_BASE_API = os.environ.get("ANALYTICS_BASE_API", False)

# Posthog settings
POSTHOG_API_KEY = os.environ.get("POSTHOG_API_KEY", False)
POSTHOG_HOST = os.environ.get("POSTHOG_HOST", False)

# Skip environment variable configuration
SKIP_ENV_VAR = os.environ.get("SKIP_ENV_VAR", "1") == "1"

DATA_UPLOAD_MAX_MEMORY_SIZE = int(os.environ.get("FILE_SIZE_LIMIT", 5242880))

# Cookie Settings
SESSION_COOKIE_SECURE = secure_origins
SESSION_COOKIE_HTTPONLY = True
SESSION_ENGINE = "plane.db.models.session"
SESSION_COOKIE_AGE = int(os.environ.get("SESSION_COOKIE_AGE", 604800))
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "session-id")
SESSION_COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN", None)
SESSION_SAVE_EVERY_REQUEST = os.environ.get("SESSION_SAVE_EVERY_REQUEST", "0") == "1"

# Admin Cookie
ADMIN_SESSION_COOKIE_NAME = "admin-session-id"
ADMIN_SESSION_COOKIE_AGE = int(os.environ.get("ADMIN_SESSION_COOKIE_AGE", 3600))

# CSRF cookies
CSRF_COOKIE_SECURE = secure_origins
CSRF_COOKIE_HTTPONLY = True
CSRF_TRUSTED_ORIGINS = cors_allowed_origins
CSRF_COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN", None)
CSRF_FAILURE_VIEW = "plane.authentication.views.common.csrf_failure"

######  Base URLs ######

# Admin Base URL
ADMIN_BASE_URL = os.environ.get("ADMIN_BASE_URL", None)
if ADMIN_BASE_URL and not is_valid_url(ADMIN_BASE_URL):
    ADMIN_BASE_URL = None
ADMIN_BASE_PATH = os.environ.get("ADMIN_BASE_PATH", "/god-mode/")

# Space Base URL
SPACE_BASE_URL = os.environ.get("SPACE_BASE_URL", None)
if SPACE_BASE_URL and not is_valid_url(SPACE_BASE_URL):
    SPACE_BASE_URL = None
SPACE_BASE_PATH = os.environ.get("SPACE_BASE_PATH", "/spaces/")

# App Base URL
APP_BASE_URL = os.environ.get("APP_BASE_URL", None)
if APP_BASE_URL and not is_valid_url(APP_BASE_URL):
    APP_BASE_URL = None
APP_BASE_PATH = os.environ.get("APP_BASE_PATH", "/")

# Live Base URL
LIVE_BASE_URL = os.environ.get("LIVE_BASE_URL", None)
if LIVE_BASE_URL and not is_valid_url(LIVE_BASE_URL):
    LIVE_BASE_URL = None
LIVE_BASE_PATH = os.environ.get("LIVE_BASE_PATH", "/live/")

LIVE_URL = urljoin(LIVE_BASE_URL, LIVE_BASE_PATH) if LIVE_BASE_URL else None

# WEB URL
WEB_URL = os.environ.get("WEB_URL")

# G2.2: PPM's OpenID Connect provider for its Git server (plane.ppm_oidc). Installed only where django-oauth-toolkit is
# (the release image has it); without it — e.g. a development API on an older image — the app and its /auth/oidc/
# routes simply do not exist and everything else works. issuer = the public address of PPM + /auth/oidc (R1).
PPM_OIDC_ISSUER = ppm_oidc_conf.oidc_issuer(WEB_URL)
OAUTH2_PROVIDER = ppm_oidc_conf.oauth2_provider_settings(
    issuer=PPM_OIDC_ISSUER,
    private_key=PPM_OIDC_PRIVATE_KEY,
    previous_private_key=PPM_OIDC_PREVIOUS_PRIVATE_KEY,
)
INSTALLED_APPS += ppm_oidc_conf.oidc_installed_apps()

HARD_DELETE_AFTER_DAYS = int(os.environ.get("HARD_DELETE_AFTER_DAYS", 60))


def _retention_days(env_var, default):
    """
    Read a retention window (in days) from the environment, falling back to the
    default when the variable is unset, unparseable, or negative — a negative
    window would otherwise select rows with a future cutoff and delete everything.
    """
    raw = os.environ.get(env_var)
    if raw is None:
        return default
    try:
        days = int(raw)
    except ValueError:
        return default
    return days if days >= 0 else default


# API activity logs hold request/response payloads, so they are retained for a
# shorter window than other logs.
API_ACTIVITY_LOG_RETENTION_DAYS = _retention_days("API_ACTIVITY_LOG_RETENTION_DAYS", 14)

# Webhook delivery logs are retained on their own window, independent of the
# generic HARD_DELETE_AFTER_DAYS.
WEBHOOK_LOG_RETENTION_DAYS = _retention_days("WEBHOOK_LOG_RETENTION_DAYS", 14)

# Email notification logs are retained on their own window.
EMAIL_LOG_RETENTION_DAYS = _retention_days("EMAIL_LOG_RETENTION_DAYS", 7)

# Instance Changelog URL
INSTANCE_CHANGELOG_URL = os.environ.get("INSTANCE_CHANGELOG_URL", "")

ATTACHMENT_MIME_TYPES = [
    # Images
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/svg+xml",
    "image/webp",
    "image/tiff",
    "image/bmp",
    # Documents
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/markdown",
    "application/rtf",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.presentation",
    "application/vnd.oasis.opendocument.graphics",
    # Microsoft Visio
    "application/vnd.visio",
    # Netpbm format
    "image/x-portable-graymap",
    "image/x-portable-bitmap",
    "image/x-portable-pixmap",
    # Open Office Bae
    "application/vnd.oasis.opendocument.database",
    # Audio
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/midi",
    "audio/x-midi",
    "audio/aac",
    "audio/flac",
    "audio/x-m4a",
    # Video
    "video/mp4",
    "video/mpeg",
    "video/ogg",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-ms-wmv",
    # Archives
    "application/zip",
    "application/x-rar",
    "application/x-rar-compressed",
    "application/x-tar",
    "application/gzip",
    "application/x-zip",
    "application/x-zip-compressed",
    "application/x-7z-compressed",
    "application/x-compressed",
    "application/x-compressed-tar",
    "application/x-compressed-tar-gz",
    "application/x-compressed-tar-bz2",
    "application/x-compressed-tar-zip",
    "application/x-compressed-tar-7z",
    "application/x-compressed-tar-rar",
    "application/x-compressed-tar-zip",
    # 3D Models
    "model/gltf-binary",
    "model/gltf+json",
    "application/octet-stream",  # for .obj files, but be cautious
    # Fonts
    "font/ttf",
    "font/otf",
    "font/woff",
    "font/woff2",
    # Other
    "text/css",
    "text/javascript",
    "application/json",
    "text/xml",
    "text/csv",
    "application/xml",
    # SQL
    "application/x-sql",
    # Gzip
    "application/x-gzip",
    # Markdown
    "text/markdown",
]

# MIME types that browsers can execute as scripts when served inline.
# These must always be served with Content-Disposition: attachment, even if they
# somehow end up stored (e.g. uploaded before this restriction was added).
SCRIPT_CAPABLE_MIME_TYPES: frozenset[str] = frozenset(
    [
        "image/svg+xml",  # SVG with onload / embedded <script> tags
        "text/javascript",
        "application/javascript",
        "text/html",
        "application/xhtml+xml",
        "text/xml",
        "application/xml",
    ]
)

# Seed directory path
SEED_DIR = os.path.join(BASE_DIR, "seeds")

ENABLE_DRF_SPECTACULAR = os.environ.get("ENABLE_DRF_SPECTACULAR", "0") == "1"

if ENABLE_DRF_SPECTACULAR:
    REST_FRAMEWORK["DEFAULT_SCHEMA_CLASS"] = "drf_spectacular.openapi.AutoSchema"
    INSTALLED_APPS.append("drf_spectacular")
    from .openapi import SPECTACULAR_SETTINGS  # noqa: F401
