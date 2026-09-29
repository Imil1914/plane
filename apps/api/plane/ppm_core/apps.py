from django.apps import AppConfig
from django.conf import settings
from django.db.models.signals import pre_save


class PpmCoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "plane.ppm_core"
    verbose_name = "PPM core: global administration center"

    def ready(self):
        from plane.ppm_core.suspension import keep_switched_off

        # G2.2 R15a: a request that started before «Отключить» must not switch the person back on by saving them.
        pre_save.connect(
            keep_switched_off,
            sender=settings.AUTH_USER_MODEL,
            dispatch_uid="plane.ppm_core.keep_switched_off",
        )
