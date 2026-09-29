"""G2.2 R3 — the only OAuth2 client of PPM: the Git server.

``--ensure`` brings the application of ``PPM_OIDC_CLIENT_ID`` in line with the environment (idempotent: nothing is
written when it already matches), ``--disable`` removes it together with its codes and tokens (G2.2 rollback), and
``--status`` reports without secrets. Other applications in the OAuth2 tables are never created, changed or removed.
Secrets are never printed: not the client secret, not its hash, not the signing key.
"""

from django.contrib.auth.hashers import check_password, identify_hasher
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from jwcrypto import jwk

from plane.ppm_oidc import conf, state

CLIENT_NAME = "Git-сервер PPM"

SECRET_MATCHES = "совпадает с окружением"
SECRET_LEGACY_HASH = "совпадает с окружением, но хэш прежнего формата — --ensure перепишет"
SECRET_DIFFERS = "отличается"
SECRET_UNSET = "не задан в окружении"


def _application_model():
    from oauth2_provider.models import get_application_model

    return get_application_model()


def _desired_fields(application_model, redirect_uri):
    return {
        "name": CLIENT_NAME,
        "client_type": application_model.CLIENT_CONFIDENTIAL,
        "authorization_grant_type": application_model.GRANT_AUTHORIZATION_CODE,
        "redirect_uris": redirect_uri,
        "post_logout_redirect_uris": "",
        "allowed_origins": "",
        "algorithm": application_model.RS256_ALGORITHM,
        "skip_authorization": True,
        "hash_client_secret": True,
        "user": None,
    }


def _secret_state(secret, stored):
    """How the stored client secret relates to the environment. A secret hashed earlier with another hasher (PBKDF2)
    still verifies — sign-in keeps working — but --ensure rewrites it with the fast hasher (ppm_oidc/hashers.py)."""
    if not secret:
        return SECRET_UNSET
    try:
        hasher = identify_hasher(stored)
    except ValueError:
        # A plain stored secret is never kept: --ensure replaces it with a hash.
        return SECRET_DIFFERS
    if not check_password(secret, stored):
        return SECRET_DIFFERS
    return SECRET_MATCHES if hasher.algorithm == conf.CLIENT_SECRET_HASHER else SECRET_LEGACY_HASH


def _key_summary(pem):
    bits = state.rsa_key_bits(pem)
    if not bits:
        return "не задан или не читается"
    return f"RSA {bits}, kid {jwk.JWK.from_pem(pem.encode('utf-8')).thumbprint()}"


class Command(BaseCommand):
    help = "Приводит OAuth2-клиента Git-сервера (PPM_OIDC_CLIENT_ID) к окружению; секреты не печатает."

    def add_arguments(self, parser):
        action = parser.add_mutually_exclusive_group(required=True)
        action.add_argument("--ensure", action="store_true", help="создать или привести клиента к окружению")
        action.add_argument("--disable", action="store_true", help="удалить клиента вместе с его кодами и токенами")
        action.add_argument("--status", action="store_true", help="показать состояние без секретов")

    def handle(self, *args, **options):
        if options["ensure"]:
            try:
                self._ensure()
            except ValidationError as error:
                # Messages name fields and the redirect URI, never the secret (only its length can be mentioned).
                raise CommandError("Клиент OIDC не сохранён: " + "; ".join(error.messages)) from None
        elif options["disable"]:
            self._disable()
        else:
            self._status()

    def _ensure(self):
        from django.conf import settings

        problems = state.configuration_problems()
        if problems:
            raise CommandError(
                "Единый вход не настроен: проверьте " + ", ".join(problems) + ". Клиент OIDC не изменён."
            )
        application_model = _application_model()
        client_id = state.configured_client_id()
        secret = settings.PPM_OIDC_CLIENT_SECRET
        desired = _desired_fields(application_model, settings.PPM_OIDC_FORGEJO_REDIRECT_URI)

        with transaction.atomic():
            application = application_model.objects.select_for_update().filter(client_id=client_id).first()
            if application is None:
                application = application_model(client_id=client_id, client_secret=secret, **desired)
                application.full_clean()
                application.save()
                self.stdout.write(self.style.SUCCESS(f"Клиент OIDC «{client_id}» создан."))
                return

            changed = [field for field, value in desired.items() if getattr(application, field) != value]
            for field in changed:
                setattr(application, field, desired[field])
            if _secret_state(secret, application.client_secret) != SECRET_MATCHES:
                # Hashed on save (hash_client_secret) with CLIENT_SECRET_HASHER; the stored value is only the hash.
                application.client_secret = secret
                changed.append("client_secret")
            if not changed:
                self.stdout.write(f"Клиент OIDC «{client_id}» уже соответствует окружению.")
                return
            application.full_clean()
            application.save()
        labels = ", ".join("секрет" if field == "client_secret" else field for field in changed)
        self.stdout.write(self.style.SUCCESS(f"Клиент OIDC «{client_id}» обновлён: {labels}."))

    def _disable(self):
        client_id = state.configured_client_id()
        deleted, _ = _application_model().objects.filter(client_id=client_id).delete()
        if deleted:
            self.stdout.write(
                self.style.SUCCESS(f"Клиент OIDC «{client_id}» отключён: приложение и его токены удалены.")
            )
        else:
            self.stdout.write(f"Клиент OIDC «{client_id}» не найден — отключать нечего.")

    def _status(self):
        from django.conf import settings

        client_id = state.configured_client_id()
        problems = state.configuration_problems()
        lines = [
            f"Единый вход (PPM_GIT_SSO_ENABLED): {'включён' if state.sso_switch_is_on() else 'выключен'}",
            "Точки /auth/oidc/*: " + ("работают" if state.sso_switch_is_on() and not problems else "отвечают 404"),
            "Не настроено: " + (", ".join(problems) if problems else "—"),
            f"Issuer: {state.issuer() or '—'}",
            f"Ключ подписи: {_key_summary(getattr(settings, 'PPM_OIDC_PRIVATE_KEY', ''))}",
            "Прежний ключ (ротация): "
            + (
                _key_summary(settings.PPM_OIDC_PREVIOUS_PRIVATE_KEY)
                if getattr(settings, "PPM_OIDC_PREVIOUS_PRIVATE_KEY", "")
                else "нет"
            ),
            f"Redirect URI из окружения: {getattr(settings, 'PPM_OIDC_FORGEJO_REDIRECT_URI', '') or '—'}",
        ]
        application_model = _application_model()
        application = application_model.objects.filter(client_id=client_id).first()
        in_sync = False
        if application is None:
            lines.append(f"Клиент «{client_id or '—'}»: нет")
        else:
            desired = _desired_fields(application_model, getattr(settings, "PPM_OIDC_FORGEJO_REDIRECT_URI", ""))
            drift = [field for field, value in desired.items() if getattr(application, field) != value]
            secret_state = _secret_state(
                getattr(settings, "PPM_OIDC_CLIENT_SECRET", "") or "", application.client_secret
            )
            if secret_state != SECRET_MATCHES:
                drift.append("client_secret")
            in_sync = not drift
            lines += [
                f"Клиент «{client_id}»: есть ({application.client_type}, {application.authorization_grant_type}, "
                f"{application.algorithm or 'без подписи'}, без экрана согласия: "
                f"{'да' if application.skip_authorization else 'нет'})",
                f"Redirect URI клиента: {application.redirect_uris or '—'}",
                f"Секрет клиента: {secret_state}",
            ]
            if drift:
                lines.append("Расходится с окружением: " + ", ".join(drift))
        others = application_model.objects.exclude(client_id=client_id).count()
        lines.append(f"Другие приложения OAuth2 в базе: {others} (PPM их не обслуживает)")
        if in_sync and not problems:
            lines.append("Итог: клиент соответствует окружению.")
        else:
            lines.append("Итог: есть расхождения — выполните --ensure после исправления окружения.")
        self.stdout.write("\n".join(lines))
