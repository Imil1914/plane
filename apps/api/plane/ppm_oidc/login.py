"""G2.2 R9 — the Git server account at sign-in, through the access module of line S2.

The contract (plan, «Модуль доступов»): ``plane.ppm_git.forgejo_access`` provides ``forgejo_sso_is_configured()``,
``ensure_account_for_login(user)`` (raises ``ForgejoAccessError(code, message)``), ``apply_user_access(user, *,
budget_seconds=5.0) -> bool``, ``forgejo_username_for(user) -> str | None`` and ``schedule_access_sync(...)``.

The module is imported lazily — at sign-in, not at import time — so the provider starts even while that module is
absent; a sign-in without it is refused with a clear code in the log. What the Git server receives is only the
standard OAuth ``server_error``; codes and reasons stay in the PPM log (without secrets).
"""

import importlib
import logging

logger = logging.getLogger("plane.api")

ACCESS_MODULE = "plane.ppm_git.forgejo_access"
ACCESS_BUDGET_SECONDS = 5.0

ACCESS_MODULE_MISSING = "PPM_OIDC_ACCESS_MODULE_MISSING"
ACCESS_NOT_CONFIGURED = "PPM_OIDC_GIT_ACCESS_NOT_CONFIGURED"
ACCOUNT_FAILED = "PPM_OIDC_GIT_ACCOUNT_FAILED"


class GitServerLoginRejected(Exception):
    """The Git server account could not be ensured: the sign-in is refused (R9). ``code`` is safe to log."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def load_access_module():
    return importlib.import_module(ACCESS_MODULE)


def _error_code(exc, default):
    code = getattr(exc, "code", "") or ""
    return code if isinstance(code, str) and code else default


def prepare_git_server_login(user):
    """Before tokens are issued to the Git server: its account for ``user`` exists, then the person's access is applied.

    - the account is required: without it Forgejo cannot find the person (automatic registration is off) — any failure
      raises ``GitServerLoginRejected``;
    - access (organizations, teams, repositories) is applied within the time budget; whatever does not fit — or fails —
      does not block the sign-in and is finished by a background synchronisation (R9).
    """
    try:
        access = load_access_module()
    except ImportError:
        logger.error("Git server sign-in refused: %s", ACCESS_MODULE_MISSING, extra={"user_id": str(user.id)})
        raise GitServerLoginRejected(ACCESS_MODULE_MISSING) from None

    try:
        configured = bool(access.forgejo_sso_is_configured())
    except Exception:  # an unreadable configuration is not a configuration
        configured = False
    if not configured:
        logger.error("Git server sign-in refused: %s", ACCESS_NOT_CONFIGURED, extra={"user_id": str(user.id)})
        raise GitServerLoginRejected(ACCESS_NOT_CONFIGURED)

    try:
        access.ensure_account_for_login(user)
    except Exception as exc:  # any failure refuses the sign-in; only its code reaches the log
        code = _error_code(exc, ACCOUNT_FAILED)
        logger.error(
            "Git server sign-in refused: %s",
            code,
            extra={"user_id": str(user.id), "error_class": type(exc).__name__},
        )
        raise GitServerLoginRejected(code) from None

    try:
        applied = access.apply_user_access(user, budget_seconds=ACCESS_BUDGET_SECONDS)
    except Exception as exc:  # the account exists: the sign-in goes on, the rest is left to the sync
        logger.warning(
            "Git server access was not applied at sign-in: %s",
            _error_code(exc, "PPM_OIDC_GIT_ACCESS_FAILED"),
            extra={"user_id": str(user.id), "error_class": type(exc).__name__},
        )
        try:
            access.schedule_access_sync(user_ids=(user.id,))
        except Exception as schedule_exc:
            logger.warning(
                "Git server access synchronisation was not scheduled after sign-in",
                extra={"user_id": str(user.id), "error_class": type(schedule_exc).__name__},
            )
        return
    if not applied:
        logger.info("Git server access at sign-in is being finished in the background", extra={"user_id": str(user.id)})


def git_server_username(user):
    """R4 ``nickname``/``preferred_username``: the name PPM assigned on the Git server, or ``None`` while unknown."""
    try:
        access = load_access_module()
        username = access.forgejo_username_for(user)
    except Exception as exc:  # the claim is only omitted; Forgejo finds the person by ``sub``
        logger.warning(
            "The Git server name of a user is unavailable for the claims",
            extra={"user_id": str(user.id), "error_class": type(exc).__name__},
        )
        return None
    return username or None
