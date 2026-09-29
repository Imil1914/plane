from django.apps import AppConfig


class PpmRealtimeConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "plane.ppm_realtime"
    verbose_name = "PPM Realtime events"

    def ready(self):
        from . import signals  # noqa: F401
