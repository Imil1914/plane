from io import StringIO
from unittest.mock import patch

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import override_settings

from plane.ppm_git.providers.base import PpmGitProviderError


@override_settings(PPM_GITHUB_APP_CONFIGURED=True)
def test_webhook_status_command_verifies_url_delivery_and_safe_output():
    output = StringIO()
    with (
        patch(
            "plane.ppm_git.management.commands.ppm_github_webhook_status.GitHubAppClient.get_app_webhook_configuration",
            return_value={
                "url": "https://ppm.example/api/ppm/v1/git/github/webhook/",
                "content_type": "json",
                "insecure_ssl": "0",
            },
        ),
        patch(
            "plane.ppm_git.management.commands.ppm_github_webhook_status.GitHubAppClient.list_app_webhook_deliveries",
            return_value=[{"event": "ping", "status": "OK", "status_code": 202}],
        ),
    ):
        call_command(
            "ppm_github_webhook_status",
            expected_url="https://ppm.example/api/ppm/v1/git/github/webhook",
            require_delivery=True,
            stdout=output,
        )

    rendered = output.getvalue()
    assert "Webhook активен" in rendered
    assert "TLS verification: включена" in rendered
    assert "ping · OK · HTTP 202" in rendered
    assert "secret" not in rendered.lower()


@override_settings(PPM_GITHUB_APP_CONFIGURED=True)
def test_webhook_status_command_explains_missing_app_webhook():
    with patch(
        "plane.ppm_git.management.commands.ppm_github_webhook_status.GitHubAppClient.get_app_webhook_configuration",
        side_effect=PpmGitProviderError("GITHUB_NOT_FOUND", "not found"),
    ):
        with pytest.raises(CommandError, match="не активирован или ещё не сохранён"):
            call_command("ppm_github_webhook_status")
