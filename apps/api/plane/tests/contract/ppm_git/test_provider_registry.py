"""G2.1 R1 — провайдерный контракт и реестр клиентов ``ppm_git``.

Реестр выдаёт клиента по значению ``provider`` подключения или доставки. Формы данных контракта
(``providers.base``) сверяются с тем, что GitHub-клиент и нормализатор вебхуков GitHub отдают сегодня, — описание
для второго провайдера не может незаметно разойтись с кодом.
"""

import base64
import json
from unittest.mock import patch

import pytest
from django.test import override_settings

from plane.ppm_git.models import PpmGitProvider
from plane.ppm_git.providers import (
    GitHubAppClient,
    get_provider_client,
    provider_code_file_url,
    provider_is_configured,
    registered_providers,
)
from plane.ppm_git.providers.base import (
    CodeTree,
    CodeTreeFile,
    GitBranchObject,
    GitCommitObject,
    GitProviderClient,
    GitPullRequestObject,
    NormalizedDelivery,
    PpmGitProviderError,
    ProviderRepository,
    SyncRepositoryResult,
)
from plane.ppm_git.webhooks import parse_github_webhook


pytestmark = [pytest.mark.contract]

MAIN_SHA = "a" * 40
FEATURE_SHA = "b" * 40


def keys(typed_dict):
    return set(typed_dict.__required_keys__) | set(typed_dict.__optional_keys__)


class Response:
    status_code = 200
    headers = {}
    links = {}

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class GitHubReadSession:
    """Read-only GitHub answers for one repository: two branches, one listed commit, one merged PR, a code tree."""

    def request(self, method, url, **kwargs):
        assert method == "GET", f"Unexpected write: {method} {url}"
        if url.endswith("/branches"):
            return Response(
                [
                    {"name": "main", "commit": {"sha": MAIN_SHA}, "protected": True},
                    {"name": "feature/GH-7", "commit": {"sha": FEATURE_SHA}, "protected": False},
                ]
            )
        if url.endswith("/commits"):
            return Response(
                [
                    {
                        "sha": MAIN_SHA,
                        "html_url": f"https://github.com/org/repo/commit/{MAIN_SHA}",
                        "commit": {"message": "GH-7: main", "author": {"name": "PPM", "date": "2026-09-28T09:00:00Z"}},
                        "author": {"login": "ppm", "avatar_url": "https://avatars.example.test/ppm"},
                    }
                ]
            )
        if url.endswith("/pulls"):
            return Response([pull_request_payload()])
        if url.endswith("/commits/main"):
            return Response({"sha": MAIN_SHA})
        if "/git/trees/" in url:
            return Response(
                {
                    "truncated": False,
                    "tree": [
                        {"type": "blob", "path": "src/app.py", "sha": "blob-sha", "size": 12},
                        {"type": "tree", "path": "src", "sha": "tree-sha"},
                    ],
                }
            )
        if url.endswith("/git/blobs/blob-sha"):
            return Response({"encoding": "base64", "content": base64.b64encode(b"print('ok')\n").decode("ascii")})
        raise AssertionError(f"Unexpected GitHub URL: {url}")


def pull_request_payload():
    return {
        "id": 92001,
        "node_id": "PR_contract",
        "number": 7,
        "title": "GH-7 — контракт",
        "html_url": "https://github.com/org/repo/pull/7",
        "state": "closed",
        "draft": False,
        "updated_at": "2026-09-28T10:00:00Z",
        "merged_at": "2026-09-28T09:30:00Z",
        "user": {"login": "developer", "avatar_url": "https://avatars.example.test/developer"},
        "base": {"ref": "main"},
        "head": {"ref": "feature/GH-7", "sha": FEATURE_SHA},
    }


@override_settings(PPM_GITHUB_APP_CONFIGURED=True)
def test_registry_builds_the_github_client_for_github_connections():
    session = GitHubReadSession()

    client = get_provider_client(PpmGitProvider.GITHUB)
    # The stored value of `PpmGitInstallation.provider` is a plain string.
    with_session = get_provider_client("github", session=session)

    assert type(client) is GitHubAppClient
    assert isinstance(client, GitProviderClient)
    assert with_session.session is session
    assert provider_is_configured(PpmGitProvider.GITHUB) is True
    assert provider_is_configured("github") is True
    assert "github" in registered_providers()


@pytest.mark.parametrize(
    "provider",
    ["gitea", "gitlab", "bitbucket", "generic", "", None, "<script>alert(1)</script>"],
)
def test_registry_refuses_a_provider_without_a_client(provider):
    with pytest.raises(PpmGitProviderError) as exc_info:
        get_provider_client(provider)

    assert exc_info.value.code == "GIT_PROVIDER_UNSUPPORTED"
    assert exc_info.value.http_status is None
    assert "script" not in exc_info.value.message
    assert provider_is_configured(provider) is False


@override_settings(PPM_GITHUB_APP_CONFIGURED=False)
def test_registry_refuses_an_unconfigured_provider_without_building_a_client():
    with patch.object(GitHubAppClient, "__init__", side_effect=AssertionError("client must not be built")):
        with pytest.raises(PpmGitProviderError) as exc_info:
            get_provider_client(PpmGitProvider.GITHUB)

    assert exc_info.value.code == "GIT_PROVIDER_NOT_CONFIGURED"
    assert exc_info.value.http_status is None
    assert provider_is_configured(PpmGitProvider.GITHUB) is False


def test_registry_factory_is_substituted_per_test(provider_registry):
    built = []
    fake = object()

    def factory(**kwargs):
        built.append(kwargs)
        return fake

    provider_registry(PpmGitProvider.GITEA, factory)
    assert get_provider_client(PpmGitProvider.GITEA, session="session") is fake
    assert get_provider_client("gitea") is fake
    assert built == [{"session": "session"}, {}]
    assert provider_is_configured("gitea") is True

    provider_registry(PpmGitProvider.GITEA, factory, configured=False)
    with pytest.raises(PpmGitProviderError) as exc_info:
        get_provider_client(PpmGitProvider.GITEA)
    assert exc_info.value.code == "GIT_PROVIDER_NOT_CONFIGURED"
    assert len(built) == 2


def test_github_code_file_url_layout_is_unchanged():
    build = provider_code_file_url(PpmGitProvider.GITHUB)

    assert build("https://github.com/org/repo", MAIN_SHA, "src/app file.py") == (
        f"https://github.com/org/repo/blob/{MAIN_SHA}/src/app%20file.py"
    )
    with pytest.raises(PpmGitProviderError) as exc_info:
        provider_code_file_url("gitlab")
    assert exc_info.value.code == "GIT_PROVIDER_UNSUPPORTED"


def test_github_client_answers_have_exactly_the_contract_shapes():
    client = GitHubAppClient(session=GitHubReadSession())
    with patch.object(client, "create_installation_token", return_value="read-token"):
        synced = client.sync_repository(81001, 91001, "org/repo")
        tree = client.get_code_tree(81001, 91001, "org/repo", "main")
        blobs = client.get_code_blobs(81001, 91001, "org/repo", tree["files"])
    repository = client.normalize_repository(
        {
            "id": 91001,
            "name": "repo",
            "full_name": "org/repo",
            "owner": {"login": "org"},
            "html_url": "https://github.com/org/repo",
            "clone_url": "https://github.com/org/repo.git",
            "ssh_url": "git@github.com:org/repo.git",
            "default_branch": "main",
            "private": True,
            "archived": False,
            "updated_at": "2026-09-28T10:00:00Z",
        }
    )

    assert set(synced) == keys(SyncRepositoryResult)
    assert [set(item) for item in synced["branches"]] == [keys(GitBranchObject)] * 2
    # The listed commit and the reconciliation fallback for the second branch head share one shape.
    assert [item["provider_object_id"] for item in synced["commits"]] == [MAIN_SHA, FEATURE_SHA]
    assert [set(item) for item in synced["commits"]] == [keys(GitCommitObject)] * 2
    assert [set(item) for item in synced["pull_requests"]] == [keys(GitPullRequestObject)]
    assert synced["pull_requests"][0]["state"] == "merged"
    assert set(tree) == keys(CodeTree)
    assert [set(item) for item in tree["files"]] == [keys(CodeTreeFile)]
    assert blobs == {"blob-sha": b"print('ok')\n"}
    assert set(repository) == keys(ProviderRepository)


def test_github_webhook_normalization_uses_only_contract_keys():
    push = parse_github_webhook(
        json.dumps(
            {
                "ref": "refs/heads/feature/GH-7",
                "after": FEATURE_SHA,
                "installation": {"id": 81001},
                "repository": {"id": 91001, "full_name": "org/repo"},
                "head_commit": {"id": FEATURE_SHA, "timestamp": "2026-09-28T10:00:00Z"},
                "commits": [
                    {
                        "id": FEATURE_SHA,
                        "message": "GH-7: webhook",
                        "url": f"https://github.com/org/repo/commit/{FEATURE_SHA}",
                        "timestamp": "2026-09-28T10:00:00Z",
                        "author": {"username": "developer"},
                    }
                ],
            }
        ).encode(),
        event_name="push",
    )
    pull_request = parse_github_webhook(
        json.dumps(
            {
                "action": "closed",
                "installation": {"id": 81001},
                "repository": {"id": 91001, "full_name": "org/repo"},
                "pull_request": pull_request_payload(),
            }
        ).encode(),
        event_name="pull_request",
    )
    lifecycle = [
        parse_github_webhook(json.dumps({"zen": "ok"}).encode(), event_name="ping"),
        parse_github_webhook(
            json.dumps({"action": "deleted", "installation": {"id": 81001, "account": {"id": 1}}}).encode(),
            event_name="installation",
        ),
        parse_github_webhook(
            json.dumps(
                {"action": "removed", "installation": {"id": 81001}, "repositories_removed": [{"id": 91001}]}
            ).encode(),
            event_name="installation_repositories",
        ),
        parse_github_webhook(b"{}", event_name="issues"),
    ]

    for normalized in (push, pull_request, *lifecycle):
        assert set(normalized) <= keys(NormalizedDelivery)
        json.dumps(normalized)
    assert set(push["branch"]) == keys(GitBranchObject)
    assert [set(item) for item in push["commits"]] == [keys(GitCommitObject)]
    assert set(pull_request["pull_request"]) == keys(GitPullRequestObject)
    assert pull_request["pull_request"]["provider_merged_at"] == "2026-09-28T09:30:00+00:00"
