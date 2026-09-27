"""G1.3 (RC-C): GitHubAppClient write/preview primitives against the in-memory GitHub (no network)."""

from unittest.mock import patch

import pytest
from django.test import override_settings

from plane.ppm_git.providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from plane.ppm_git.providers.github import GitHubAppClient
from plane.tests.contract.ppm_git.github_fake import FakeGitHubApi, FakeResponse


pytestmark = [pytest.mark.contract]


def client_for(api):
    client = GitHubAppClient(session=api)
    return client


@pytest.fixture(autouse=True)
def fake_app_jwt():
    with patch.object(GitHubAppClient, "_app_jwt", return_value="fake-app-jwt"):
        with override_settings(PPM_GITHUB_API_VERSION="2022-11-28"):
            yield


@pytest.mark.parametrize(
    ("installation_state", "status_code", "code"),
    [
        ("deleted", None, "GITHUB_INSTALLATION_REVOKED"),
        ("suspended", None, "GITHUB_INSTALLATION_SUSPENDED"),
        ("active", 401, "GITHUB_AUTH_FAILED"),
    ],
)
def test_installation_token_errors_are_named_for_the_user(installation_state, status_code, code):
    api = FakeGitHubApi(installation_state=installation_state)
    if status_code:
        api.inject("POST", r"/access_tokens$", FakeResponse(status_code, {"message": "A JSON web token could not"}))

    with pytest.raises(PpmGitProviderError) as error:
        client_for(api).create_installation_token(81001, repository_ids=[91001], permissions={"contents": "write"})

    assert error.value.code == code


def test_write_scope_drift_is_reported_before_any_repository_request():
    api = FakeGitHubApi(granted_permissions={"metadata": "read", "contents": "read", "pull_requests": "read"})

    with pytest.raises(PpmGitProviderError) as error:
        client_for(api).create_branch(
            81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/x", base_sha=api.base_sha, allow_replay=False
        )

    assert error.value.code == "GITHUB_WRITE_PERMISSION_MISSING"
    assert [path for _, path, _ in api.requests] == ["/app/installations/81001/access_tokens"]


def test_primary_rate_limit_403_on_write_is_rate_limited_not_permission_denied():
    api = FakeGitHubApi()
    api.inject(
        "POST",
        r"/git/refs$",
        FakeResponse(403, {"message": "API rate limit exceeded"}, {"X-RateLimit-Remaining": "0", "Retry-After": "90"}),
    )

    with pytest.raises(PpmGitProviderRateLimited) as error:
        client_for(api).create_branch(
            81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/x", base_sha=api.base_sha, allow_replay=False
        )

    assert error.value.code == "GITHUB_RATE_LIMITED"
    assert error.value.retry_after_seconds == 90
    assert error.value.write_outcome == "not_performed"
    assert "gwa-1/x" not in api.branches


@pytest.mark.parametrize(
    ("headers", "message", "retry_after"),
    [
        (
            {"X-RateLimit-Remaining": "4999", "Retry-After": "60"},
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
            60,
        ),
        ({"X-RateLimit-Remaining": "4999"}, "You have exceeded a secondary rate limit.", 60),
        ({"X-RateLimit-Remaining": "4999", "Retry-After": "120"}, "Forbidden", 120),
    ],
)
def test_secondary_rate_limit_403_is_rate_limited_even_with_primary_budget_left(headers, message, retry_after):
    api = FakeGitHubApi()
    api.inject("POST", r"/git/refs$", FakeResponse(403, {"message": message}, headers))

    with pytest.raises(PpmGitProviderRateLimited) as error:
        client_for(api).create_branch(
            81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/x", base_sha=api.base_sha, allow_replay=False
        )

    assert error.value.code == "GITHUB_RATE_LIMITED"
    assert error.value.retry_after_seconds == retry_after


def test_plain_403_is_still_missing_permission():
    api = FakeGitHubApi()
    api.inject(
        "POST",
        r"/git/refs$",
        FakeResponse(403, {"message": "Resource not accessible by integration"}, {"X-RateLimit-Remaining": "4999"}),
    )

    with pytest.raises(PpmGitProviderError) as error:
        client_for(api).create_branch(
            81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/x", base_sha=api.base_sha, allow_replay=False
        )

    assert not isinstance(error.value, PpmGitProviderRateLimited)
    assert error.value.code == "GITHUB_PERMISSION_DENIED"
    assert error.value.write_outcome == "not_performed"


@pytest.mark.parametrize("sha", ["$(id)", "a" * 39, "A" * 40, "g" * 40, "a" * 40 + ";calc"])
def test_shas_from_github_must_be_plain_hex_before_use(sha):
    api = FakeGitHubApi()
    api.inject("GET", r"/git/ref/heads/main$", FakeResponse(200, {"ref": "refs/heads/main", "object": {"sha": sha}}))

    with pytest.raises(PpmGitProviderError) as error:
        client_for(api).get_branch_heads(81001, 91001, api.full_name, ["main"])

    assert error.value.code == "GITHUB_INVALID_RESPONSE"


def test_a_lost_answer_to_the_write_request_leaves_the_outcome_unknown():
    api = FakeGitHubApi()
    api.lose_response("POST", r"/git/refs$")

    with pytest.raises(PpmGitProviderError) as error:
        client_for(api).create_branch(
            81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/x", base_sha=api.base_sha, allow_replay=False
        )

    assert error.value.code == "GITHUB_UNAVAILABLE"
    assert error.value.write_outcome == "unknown"
    assert api.branches["gwa-1/x"] == api.base_sha


def test_retry_reconciles_a_branch_pushed_to_since_but_not_an_unrelated_one():
    api = FakeGitHubApi()
    api.create_foreign_branch("gwa-1/ours")
    api.commit_on("gwa-1/ours", "GWA-1: pushed after creation")
    api.create_foreign_branch("gwa-1/theirs", api.commit_on("elsewhere", "Unrelated history"))
    client = client_for(api)

    adopted = client.create_branch(
        81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/ours", base_sha=api.base_sha, allow_replay=True
    )
    with pytest.raises(PpmGitProviderError) as error:
        client.create_branch(
            81001,
            91001,
            api.full_name,
            base_ref="main",
            head_ref="gwa-1/theirs",
            base_sha=api.base_sha,
            allow_replay=True,
        )

    assert adopted["created"] is False
    assert adopted["sha"] == api.branches["gwa-1/ours"]
    # While reconciling, an unrelated branch with our name cannot be proven foreign: honest "unknown", no write.
    assert error.value.code == "GITHUB_BRANCH_UNCONFIRMED"
    assert error.value.write_outcome == "unknown"
    assert "Не удалось подтвердить" in error.value.message
    assert error.value.details == {"canonical_url": f"https://github.com/{api.full_name}/tree/gwa-1/theirs"}
    assert api.write_requests() == []


def test_branch_creation_never_updates_or_deletes_an_existing_ref():
    api = FakeGitHubApi()
    api.create_foreign_branch("gwa-1/x", api.commit_on("elsewhere", "Foreign work"))

    with pytest.raises(PpmGitProviderError) as error:
        client_for(api).create_branch(
            81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/x", base_sha=api.base_sha, allow_replay=False
        )

    assert error.value.code == "GITHUB_BRANCH_CONFLICT"
    assert error.value.write_outcome == "not_performed"
    assert api.write_requests() == []


def test_pull_request_preview_reads_exact_shas_and_summarises_commits():
    api = FakeGitHubApi()
    api.create_foreign_branch("gwa-1/x")
    shas = [api.commit_on("gwa-1/x", f"GWA-1: step {index}\n\nDetails {index}") for index in range(25)]

    preview = client_for(api).get_pull_request_preview(81001, 91001, api.full_name, base_ref="main", head_ref="gwa-1/x")

    assert preview["base_sha"] == api.base_sha
    assert preview["head_sha"] == shas[-1]
    assert preview["ahead_by"] == 25
    assert preview["truncated"] is True
    assert len(preview["commits"]) == 20
    assert preview["commits"][0] == {
        "sha": shas[0],
        "title": "GWA-1: step 0",
        "author": "developer",
        "canonical_url": f"https://github.com/{api.full_name}/commit/{shas[0]}",
    }
    assert preview["existing_pull_requests"] == []
    assert preview["previous_pull_requests"] == []
    assert all(body["permissions"] == {"contents": "read", "pull_requests": "read"} for body in api.token_requests())
    assert api.write_requests() == []
