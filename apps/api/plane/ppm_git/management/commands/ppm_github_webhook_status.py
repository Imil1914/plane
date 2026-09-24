from django.core.management.base import BaseCommand, CommandError

from plane.ppm_git.providers.base import PpmGitProviderError
from plane.ppm_git.providers.github import GitHubAppClient, github_app_is_configured


class Command(BaseCommand):
    help = "Verify the GitHub App webhook configuration and recent deliveries without changing external state."

    def add_arguments(self, parser):
        parser.add_argument("--expected-url")
        parser.add_argument("--require-delivery", action="store_true")
        parser.add_argument("--limit", type=int, default=10)

    def handle(self, *args, **options):
        if not github_app_is_configured():
            raise CommandError("GitHub App не настроен в server environment.")

        expected_url = (options.get("expected_url") or "").strip()
        limit = options["limit"]
        if not 1 <= limit <= 100:
            raise CommandError("--limit должен быть от 1 до 100.")

        client = GitHubAppClient()
        try:
            configuration = client.get_app_webhook_configuration()
            deliveries = client.list_app_webhook_deliveries(limit=limit)
        except PpmGitProviderError as exc:
            if exc.code == "GITHUB_NOT_FOUND":
                raise CommandError("Webhook GitHub App не активирован или ещё не сохранён.") from exc
            raise CommandError(f"{exc.code}: {exc.message}") from exc

        actual_url = configuration["url"]
        if expected_url and actual_url.rstrip("/") != expected_url.rstrip("/"):
            raise CommandError(f"Webhook URL не совпадает: GitHub использует {actual_url}")
        if options["require_delivery"] and not deliveries:
            raise CommandError("Webhook настроен, но GitHub ещё не зарегистрировал ни одной доставки.")

        self.stdout.write(self.style.SUCCESS(f"Webhook активен: {actual_url}"))
        self.stdout.write(f"Content type: {configuration['content_type'] or 'не указан'}")
        tls_state = "выключена" if configuration["insecure_ssl"] == "1" else "включена"
        self.stdout.write(f"TLS verification: {tls_state}")
        self.stdout.write(f"Последних доставок: {len(deliveries)}")
        if deliveries:
            latest = deliveries[0]
            status_code = latest.get("status_code")
            self.stdout.write(
                "Последняя доставка: "
                f"{latest.get('event') or 'unknown'} · {latest.get('status') or 'unknown'} · "
                f"HTTP {status_code if status_code is not None else '—'}"
            )
