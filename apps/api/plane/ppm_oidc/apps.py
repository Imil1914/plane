import logging

from django.apps import AppConfig
from django.conf import settings
from django.db.models.signals import post_save

# django-oauth-toolkit logs the redirect with the authorization code at DEBUG («Success url for the request: …»),
# oauthlib logs request details at DEBUG. Codes and tokens must never reach the logs (R7), whatever LOGGING an
# operator sets.
LIBRARY_LOGGERS = ("oauth2_provider", "oauthlib")


class PpmOidcConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "plane.ppm_oidc"
    verbose_name = "PPM OpenID Connect provider"

    def ready(self):
        for name in LIBRARY_LOGGERS:
            library_logger = logging.getLogger(name)
            if library_logger.level < logging.WARNING:
                library_logger.setLevel(logging.WARNING)

        from plane.ppm_oidc import signals

        post_save.connect(
            signals.revoke_git_server_tokens,
            sender=settings.AUTH_USER_MODEL,
            dispatch_uid="plane.ppm_oidc.revoke_git_server_tokens",
        )
