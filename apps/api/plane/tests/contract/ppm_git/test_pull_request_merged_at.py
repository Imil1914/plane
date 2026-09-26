"""AF2.2 S2a: настоящее время слияния PR (`PpmGitObject.provider_merged_at`) для ленты «Что изменилось»."""

import io
import json
import uuid
from datetime import datetime, timezone

import pytest
from django.core.management import call_command
from django.test import override_settings

from plane.ppm_git.models import PpmGitConnection, PpmGitInstallation, PpmGitObject, PpmGitRepository
from plane.ppm_git.provider_services import create_delivery, process_delivery, upsert_git_object
from plane.ppm_git.providers.github import GitHubAppClient
from plane.ppm_git.webhooks import body_sha256, parse_github_webhook
from plane.tests.factories import ProjectFactory, UserFactory, WorkspaceFactory


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

REPOSITORY_URL = "https://github.com/ppm-test-org/ppm-project"


def pull_request_payload(*, merged_at, updated_at="2026-09-22T08:00:00Z", state="closed"):
    return {
        "id": 92001,
        "node_id": "PR_merged_node",
        "number": 3,
        "title": "Живая карта",
        "html_url": f"{REPOSITORY_URL}/pull/3",
        "state": state,
        "draft": False,
        "updated_at": updated_at,
        "merged_at": merged_at,
        "user": {"login": "developer", "avatar_url": "https://avatars.example.test/1"},
        "base": {"ref": "main"},
        "head": {"ref": "feature/living-map", "sha": "b" * 40},
    }


@pytest.fixture
def git_connection():
    marker = uuid.uuid4().hex
    owner = UserFactory(username=f"merged-{marker}", email=f"merged-{marker}@plane.test")
    workspace = WorkspaceFactory(owner=owner)
    project = ProjectFactory(workspace=workspace, identifier="MRG")
    repository = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name="ppm-project",
        normalized_name="ppm-project",
        provider="github",
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm-project",
        canonical_url=REPOSITORY_URL,
        clone_https=f"{REPOSITORY_URL}.git",
        default_branch="main",
        created_by=owner.id,
        updated_by=owner.id,
    )
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=81001,
        provider_account_id=71001,
        account_login="ppm-test-org",
        created_by=owner.id,
        updated_by=owner.id,
    )
    return PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm-project",
        created_by=owner.id,
        updated_by=owner.id,
    )


def test_pull_request_normalization_carries_the_merge_time():
    client = GitHubAppClient()

    merged = client.normalize_pull_request(pull_request_payload(merged_at="2026-09-20T12:00:00Z"))
    opened = client.normalize_pull_request(pull_request_payload(merged_at=None, state="open"))
    webhook = parse_github_webhook(
        json.dumps(
            {
                "action": "closed",
                "installation": {"id": 81001},
                "repository": {"id": 91001, "full_name": "ppm-test-org/ppm-project"},
                "pull_request": pull_request_payload(merged_at="2026-09-20T12:00:00Z"),
            }
        ).encode(),
        event_name="pull_request",
    )

    assert merged["state"] == "merged"
    assert merged["provider_merged_at"] == datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
    assert merged["provider_updated_at"] == datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)
    assert opened["state"] == "open"
    assert opened["provider_merged_at"] is None
    # Доставка webhook хранится в JSON — время слияния, как и время обновления, приходит строкой ISO 8601.
    assert webhook["pull_request"]["provider_merged_at"] == "2026-09-20T12:00:00+00:00"
    assert webhook["pull_request"]["provider_updated_at"] == "2026-09-22T08:00:00+00:00"
    json.dumps(webhook)


def test_upsert_stores_the_merge_time_and_payloads_without_it_do_not_erase_it(git_connection):
    raw_body = json.dumps(
        {
            "action": "closed",
            "installation": {"id": 81001},
            "repository": {"id": 91001, "full_name": "ppm-test-org/ppm-project"},
            "pull_request": pull_request_payload(merged_at="2026-09-20T12:00:00Z"),
        }
    ).encode()
    normalized = parse_github_webhook(raw_body, event_name="pull_request")
    delivery, _ = create_delivery(
        delivery_id="merged-1",
        event_name="pull_request",
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=normalized,
    )

    process_delivery(delivery.id)
    git_object = PpmGitObject.objects.get(repository=git_connection.repository, provider_object_id="92001")
    assert git_object.state == "merged"
    assert git_object.provider_merged_at == datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)

    # Доставка, сохранённая до обновления (без ключа), и поздняя активность у провайдера не затирают время слияния.
    legacy = {**normalized["pull_request"], "provider_updated_at": "2026-09-24T09:30:00+00:00"}
    legacy.pop("provider_merged_at")
    upsert_git_object(connection=git_connection, payload=legacy)
    git_object.refresh_from_db()
    assert git_object.provider_merged_at == datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
    assert git_object.provider_updated_at == datetime(2026, 9, 24, 9, 30, tzinfo=timezone.utc)

    # Полный PR (reconcile, новый webhook) записывает время слияния как есть.
    upsert_git_object(
        connection=git_connection,
        payload=GitHubAppClient().normalize_pull_request(
            pull_request_payload(merged_at="2026-09-20T12:00:05Z", updated_at="2026-09-25T10:00:00Z")
        ),
    )
    git_object.refresh_from_db()
    assert git_object.provider_merged_at == datetime(2026, 9, 20, 12, 0, 5, tzinfo=timezone.utc)
    assert PpmGitObject.objects.filter(repository=git_connection.repository).count() == 1


@override_settings(MIGRATION_MODULES={})
def test_ppm_git_migrations_match_the_models():
    """pytest.ini запускает тесты с --nomigrations: расхождение миграции и модели иначе незаметно."""
    output = io.StringIO()
    call_command("makemigrations", "ppm_git", "--check", "--dry-run", stdout=output)
    assert "No changes detected" in output.getvalue()
