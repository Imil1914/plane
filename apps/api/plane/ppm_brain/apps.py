from django.apps import AppConfig


class PpmBrainConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "plane.ppm_brain"
    verbose_name = "PPM Project Brain"

    def ready(self):
        from . import signals  # noqa: F401
