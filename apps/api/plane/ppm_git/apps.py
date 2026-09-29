from django.apps import AppConfig


class PpmGitConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "plane.ppm_git"
    verbose_name = "PPM Git metadata"

    def ready(self):
        # G2.2 R16: changes that move code access on PPM's Git server schedule a synchronization. Every handler is a
        # no-op until single sign-on is configured (the owner's dev API runs without migration 0009).
        from . import signals  # noqa: F401
