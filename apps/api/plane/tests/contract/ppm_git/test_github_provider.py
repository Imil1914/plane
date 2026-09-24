import hashlib
import hmac
import json
import uuid
import base64
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import pytest
from django.test import override_settings
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_git.code_indexing import ingest_code_snapshot
from plane.ppm_git.models import (
    PpmGitCodeFile,
    PpmGitCodeIndexPolicy,
    PpmGitCodeSnapshotStatus,
    PpmGitDelivery,
    PpmGitDeliveryStatus,
    PpmGitAudit,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitObject,
)
from plane.ppm_git.provider_services import create_delivery, process_delivery, synchronize_connection
from plane.ppm_git.providers.github import GitHubAppClient
from plane.ppm_git.providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from plane.ppm_git.webhooks import body_sha256, parse_github_webhook
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def test_pull_request_webhook_payload_is_json_serializable():
    raw_body = json.dumps(
        {
            "action": "synchronize",
            "repository": {"id": 91001, "full_name": "ppm-test-org/ppm-project"},
            "pull_request": {
                "id": 92001,
                "node_id": "PR_test_node",
                "number": 3,
                "title": "Проверить живой webhook",
                "html_url": "https://github.com/ppm-test-org/ppm-project/pull/3",
                "state": "open",
                "draft": True,
                "updated_at": "2026-09-21T11:02:24Z",
                "user": {"login": "developer", "avatar_url": "https://avatars.example.test/1"},
                "base": {"ref": "main"},
                "head": {"ref": "feature/webhook", "sha": "a" * 40},
            },
        }
    ).encode()

    normalized = parse_github_webhook(raw_body, event_name="pull_request")

    assert normalized["installation_id"] is None
    assert normalized["pull_request"]["provider_updated_at"] == "2026-09-21T11:02:24+00:00"
    json.dumps(normalized)


class FakeGitHubClient:
    installation_id = 81001
    repository_id = 91001

    def installation_url_with_state(self, state):
        return f"https://github.com/apps/ppm-test/installations/new?state={state}"

    def user_authorization_url(self, state, code_verifier):
        assert len(code_verifier) == 43
        return f"https://github.com/login/oauth/authorize?state={state}"

    def exchange_user_code(self, code, code_verifier):
        assert code == "valid-code"
        assert len(code_verifier) == 43
        return "transient-user-token"

    def get_user_installation(self, user_token, installation_id):
        assert user_token == "transient-user-token"
        assert installation_id == self.installation_id
        return {
            "provider_installation_id": self.installation_id,
            "provider_account_id": 71001,
            "account_login": "ppm-test-org",
            "account_type": "Organization",
            "repository_selection": "selected",
            "permissions": {"metadata": "read", "contents": "read", "pull_requests": "read"},
            "events": ["push", "pull_request", "installation", "installation_repositories"],
        }

    def list_repositories(self, installation_id):
        assert installation_id == self.installation_id
        return [self.repository()]

    def get_repository(self, installation_id, repository_id):
        assert installation_id == self.installation_id
        assert repository_id == self.repository_id
        return self.repository()

    def sync_repository(self, installation_id, repository_id, full_name, *, since=None):
        assert installation_id == self.installation_id
        assert repository_id == self.repository_id
        assert full_name == "ppm-test-org/ppm-project"
        return {"branches": [], "commits": [], "pull_requests": []}

    def repository(self):
        return {
            "provider_repository_id": self.repository_id,
            "name": "ppm-project",
            "full_name": "ppm-test-org/ppm-project",
            "owner": "ppm-test-org",
            "canonical_url": "https://github.com/ppm-test-org/ppm-project",
            "clone_https": "https://github.com/ppm-test-org/ppm-project.git",
            "clone_ssh": "git@github.com:ppm-test-org/ppm-project.git",
            "default_branch": "main",
            "visibility": "private",
            "archived": False,
            "updated_at": None,
        }


class RateLimitedGitHubClient:
    def sync_repository(self, *args, **kwargs):
        raise PpmGitProviderRateLimited(
            "GITHUB_RATE_LIMITED",
            "GitHub временно ограничил частоту синхронизации.",
            retry_after_seconds=120,
        )


class UnownedInstallationClient(FakeGitHubClient):
    def get_user_installation(self, user_token, installation_id):
        raise PpmGitProviderError(
            "GITHUB_INSTALLATION_NOT_OWNED",
            "Установка GitHub App не принадлежит текущему пользователю GitHub.",
        )


class WritePermissionsGitHubClient(FakeGitHubClient):
    def get_installation(self, installation_id):
        assert installation_id == self.installation_id
        return {
            "provider_installation_id": self.installation_id,
            "provider_account_id": 71001,
            "account_login": "ppm-test-org",
            "account_type": "Organization",
            "repository_selection": "selected",
            "permissions": {"metadata": "read", "contents": "write", "pull_requests": "write"},
            "events": ["push", "pull_request", "installation", "installation_repositories"],
        }


@pytest.fixture
def github_project():
    marker = uuid.uuid4().hex
    owner = UserFactory(username=f"github-{marker}", email=f"github-{marker}@plane.test")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    project = ProjectFactory(workspace=workspace, identifier="GH")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=owner,
    )
    issue = Issue(name="Проверить GitHub App", project=project, state=state)
    issue.save(created_by_id=owner.id)
    return owner, workspace, project, issue


def project_git_url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/{suffix}"


def sign(secret, raw_body):
    digest = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


@override_settings(
    PPM_GITHUB_APP_CLIENT_ID="ppm-client-id",
    PPM_GITHUB_CALLBACK_URL="https://ppm.example/api/ppm/v1/git/github/callback/",
)
def test_github_user_authorization_url_uses_exact_callback_state_and_pkce():
    query = parse_qs(urlparse(GitHubAppClient().user_authorization_url("safe-state", "v" * 43)).query)

    assert query["client_id"] == ["ppm-client-id"]
    assert query["redirect_uri"] == ["https://ppm.example/api/ppm/v1/git/github/callback/"]
    assert query["state"] == ["safe-state"]
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) == 43


@override_settings(
    PPM_GITHUB_APP_CLIENT_ID="ppm-client-id",
    PPM_GITHUB_APP_CLIENT_SECRET="fixture",
    PPM_GITHUB_CALLBACK_URL="https://ppm.example/api/ppm/v1/git/github/callback/",
)
def test_github_user_code_exchange_posts_form_callback_and_pkce():
    class Response:
        status_code = 200
        headers = {}

        @staticmethod
        def json():
            return {"access_token": "transient-user-token"}

    class Session:
        def __init__(self):
            self.request_data = None

        def request(self, method, url, **kwargs):
            assert method == "POST"
            assert url == "https://github.com/login/oauth/access_token"
            self.request_data = kwargs
            return Response()

    session = Session()
    token = GitHubAppClient(session=session).exchange_user_code("valid-code", "v" * 43)

    assert token == "transient-user-token"
    assert session.request_data["json"] is None
    assert session.request_data["data"] == {
        "client_id": "ppm-client-id",
        "client_secret": "fixture",
        "code": "valid-code",
        "redirect_uri": "https://ppm.example/api/ppm/v1/git/github/callback/",
        "code_verifier": "v" * 43,
    }


def test_github_app_webhook_status_uses_app_jwt_and_redacts_secret():
    class Response:
        status_code = 200
        headers = {}
        links = {}

        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

    class Session:
        def __init__(self):
            self.requests = []

        def request(self, method, url, **kwargs):
            self.requests.append((method, url, kwargs))
            if url.endswith("/app/hook/config"):
                return Response(
                    {
                        "url": "https://ppm.example/api/ppm/v1/git/github/webhook/",
                        "content_type": "json",
                        "insecure_ssl": "0",
                        "secret": "must-not-leave-provider-client",
                    }
                )
            if url.endswith("/app/hook/deliveries"):
                assert kwargs["params"] == {"per_page": 5}
                return Response([{"id": 1, "event": "ping", "status": "OK", "status_code": 202}])
            raise AssertionError(f"Unexpected GitHub URL: {url}")

    session = Session()
    client = GitHubAppClient(session=session)
    with patch.object(client, "_app_jwt", return_value="app-jwt"):
        configuration = client.get_app_webhook_configuration()
        deliveries = client.list_app_webhook_deliveries(limit=5)

    assert configuration == {
        "url": "https://ppm.example/api/ppm/v1/git/github/webhook/",
        "content_type": "json",
        "insecure_ssl": "0",
    }
    assert "secret" not in configuration
    assert deliveries == [{"id": 1, "event": "ping", "status": "OK", "status_code": 202}]
    assert all(request[2]["headers"]["Authorization"] == "Bearer app-jwt" for request in session.requests)


def test_github_installation_refresh_reads_current_permissions_with_app_jwt():
    class Response:
        status_code = 200
        headers = {}
        links = {}

        @staticmethod
        def json():
            return {
                "id": 81001,
                "account": {"id": 71001, "login": "ppm-test-org", "type": "Organization"},
                "repository_selection": "selected",
                "permissions": {"metadata": "read", "contents": "write", "pull_requests": "write"},
                "events": ["push", "pull_request"],
            }

    class Session:
        def __init__(self):
            self.request_data = None

        def request(self, method, url, **kwargs):
            assert method == "GET"
            assert url == "https://api.github.com/app/installations/81001"
            self.request_data = kwargs
            return Response()

    session = Session()
    client = GitHubAppClient(session=session)
    with patch.object(client, "_app_jwt", return_value="app-jwt"):
        installation = client.get_installation(81001)

    assert installation["permissions"] == {
        "metadata": "read",
        "contents": "write",
        "pull_requests": "write",
    }
    assert session.request_data["headers"]["Authorization"] == "Bearer app-jwt"


def test_github_code_tree_and_blobs_are_read_from_exact_commit():
    class Response:
        status_code = 200
        headers = {}
        links = {}

        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

    class Session:
        def __init__(self):
            self.requests = []

        def request(self, method, url, **kwargs):
            self.requests.append((method, url, kwargs))
            if url.endswith("/commits/main"):
                return Response({"sha": "a" * 40})
            if "/git/trees/" in url:
                assert kwargs["params"] == {"recursive": "1"}
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
                return Response(
                    {
                        "encoding": "base64",
                        "content": base64.b64encode(b"print('ok')\n").decode("ascii"),
                    }
                )
            raise AssertionError(f"Unexpected GitHub URL: {url}")

    session = Session()
    client = GitHubAppClient(session=session)
    with patch.object(client, "create_installation_token", return_value="read-token") as token:
        tree = client.get_code_tree(81001, 91001, "org/repo", "main")
        blobs = client.get_code_blobs(81001, 91001, "org/repo", tree["files"])

    assert tree == {
        "commit_sha": "a" * 40,
        "files": [{"path": "src/app.py", "sha": "blob-sha", "size": 12}],
    }
    assert blobs == {"blob-sha": b"print('ok')\n"}
    assert token.call_count == 2
    assert all(request[2]["headers"]["Authorization"] == "Bearer read-token" for request in session.requests)


def test_github_branch_creation_uses_contents_write_and_replays_exact_ref():
    base_sha = "a" * 40

    class Response:
        headers = {}
        links = {}

        def __init__(self, status_code, payload):
            self.status_code = status_code
            self.payload = payload

        def json(self):
            return self.payload

    class Session:
        def __init__(self):
            self.branch_exists = False
            self.requests = []

        def request(self, method, url, **kwargs):
            self.requests.append((method, url, kwargs))
            if method == "GET" and url.endswith("/git/ref/heads/main"):
                return Response(200, {"ref": "refs/heads/main", "object": {"sha": base_sha}})
            if method == "GET" and url.endswith("/git/ref/heads/GH-7/safe-write"):
                if self.branch_exists:
                    return Response(200, {"ref": "refs/heads/GH-7/safe-write", "object": {"sha": base_sha}})
                return Response(404, {"message": "Not Found"})
            if method == "POST" and url.endswith("/git/refs"):
                assert kwargs["json"] == {"ref": "refs/heads/GH-7/safe-write", "sha": base_sha}
                self.branch_exists = True
                return Response(201, {"ref": "refs/heads/GH-7/safe-write", "object": {"sha": base_sha}})
            raise AssertionError(f"Unexpected GitHub request: {method} {url}")

    session = Session()
    client = GitHubAppClient(session=session)
    with patch.object(client, "create_installation_token", return_value="write-token") as token:
        created = client.create_branch(
            81001,
            91001,
            "org/repo",
            base_ref="main",
            head_ref="GH-7/safe-write",
        )
        replayed = client.create_branch(
            81001,
            91001,
            "org/repo",
            base_ref="main",
            head_ref="GH-7/safe-write",
        )

    assert created == {
        "ref": "GH-7/safe-write",
        "sha": base_sha,
        "canonical_url": "https://github.com/org/repo/tree/GH-7/safe-write",
        "created": True,
    }
    assert replayed == {**created, "created": False}
    assert token.call_count == 2
    assert all(call.kwargs["permissions"] == {"contents": "write"} for call in token.call_args_list)
    assert all(call.kwargs["repository_ids"] == [91001] for call in token.call_args_list)
    assert sum(method == "POST" for method, _, _ in session.requests) == 1
    assert all(request[2]["headers"]["Authorization"] == "Bearer write-token" for request in session.requests)


def test_github_branch_creation_rejects_existing_ref_at_other_commit():
    class Response:
        status_code = 200
        headers = {}
        links = {}

        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

    class Session:
        def request(self, method, url, **kwargs):
            assert method == "GET"
            if url.endswith("/git/ref/heads/main"):
                return Response({"ref": "refs/heads/main", "object": {"sha": "a" * 40}})
            if url.endswith("/git/ref/heads/GH-7/safe-write"):
                return Response({"ref": "refs/heads/GH-7/safe-write", "object": {"sha": "b" * 40}})
            raise AssertionError(f"Unexpected GitHub URL: {url}")

    client = GitHubAppClient(session=Session())
    with patch.object(client, "create_installation_token", return_value="write-token"):
        with pytest.raises(PpmGitProviderError, match="другой commit") as exc_info:
            client.create_branch(
                81001,
                91001,
                "org/repo",
                base_ref="main",
                head_ref="GH-7/safe-write",
            )

    assert exc_info.value.code == "GITHUB_BRANCH_CONFLICT"


def test_github_draft_pull_request_requires_commit_and_replays_exact_pr():
    base_sha = "a" * 40
    head_sha = "b" * 40
    title = "GH-7 — Безопасный Git write"
    body = "Проверяемое описание"

    class Response:
        headers = {}
        links = {}

        def __init__(self, status_code, payload):
            self.status_code = status_code
            self.payload = payload

        def json(self):
            return self.payload

    class Session:
        def __init__(self):
            self.pull_request = None
            self.requests = []

        def pr_payload(self):
            return {
                "id": 92001,
                "node_id": "PR_write_test",
                "number": 7,
                "title": title,
                "body": body,
                "html_url": "https://github.com/org/repo/pull/7",
                "state": "open",
                "draft": True,
                "updated_at": "2026-09-21T20:00:00Z",
                "user": {"login": "ppm-app", "avatar_url": "https://avatars.example/ppm"},
                "base": {"ref": "main"},
                "head": {"ref": "GH-7/safe-write", "sha": head_sha},
            }

        def request(self, method, url, **kwargs):
            self.requests.append((method, url, kwargs))
            if method == "GET" and url.endswith("/git/ref/heads/main"):
                return Response(200, {"ref": "refs/heads/main", "object": {"sha": base_sha}})
            if method == "GET" and url.endswith("/git/ref/heads/GH-7/safe-write"):
                return Response(200, {"ref": "refs/heads/GH-7/safe-write", "object": {"sha": head_sha}})
            if method == "GET" and url.endswith("/pulls"):
                assert kwargs["params"] == {
                    "state": "all",
                    "head": "org:GH-7/safe-write",
                    "base": "main",
                    "per_page": 100,
                }
                return Response(200, [self.pull_request] if self.pull_request else [])
            if method == "POST" and url.endswith("/pulls"):
                assert kwargs["json"] == {
                    "title": title,
                    "body": body,
                    "head": "GH-7/safe-write",
                    "base": "main",
                    "draft": True,
                }
                self.pull_request = self.pr_payload()
                return Response(201, self.pull_request)
            raise AssertionError(f"Unexpected GitHub request: {method} {url}")

    session = Session()
    client = GitHubAppClient(session=session)
    with patch.object(client, "create_installation_token", return_value="write-token") as token:
        created = client.create_draft_pull_request(
            81001,
            91001,
            "org/repo",
            base_ref="main",
            head_ref="GH-7/safe-write",
            title=title,
            body=body,
        )
        replayed = client.create_draft_pull_request(
            81001,
            91001,
            "org/repo",
            base_ref="main",
            head_ref="GH-7/safe-write",
            title=title,
            body=body,
        )

    assert created["created"] is True
    assert created["provider_object_id"] == "92001"
    assert created["canonical_url"] == "https://github.com/org/repo/pull/7"
    assert created["is_draft"] is True
    assert replayed == {**created, "created": False}
    assert token.call_count == 2
    assert all(
        call.kwargs["permissions"] == {"contents": "read", "pull_requests": "write"} for call in token.call_args_list
    )
    assert sum(method == "POST" for method, _, _ in session.requests) == 1


def test_github_draft_pull_request_rejects_head_without_new_commit():
    class Response:
        status_code = 200
        headers = {}
        links = {}

        def __init__(self, ref):
            self.ref = ref

        def json(self):
            return {"ref": f"refs/heads/{self.ref}", "object": {"sha": "a" * 40}}

    class Session:
        def request(self, method, url, **kwargs):
            assert method == "GET"
            return Response("main" if url.endswith("/main") else "GH-7/safe-write")

    client = GitHubAppClient(session=Session())
    with patch.object(client, "create_installation_token", return_value="write-token"):
        with pytest.raises(PpmGitProviderError, match="хотя бы один commit") as exc_info:
            client.create_draft_pull_request(
                81001,
                91001,
                "org/repo",
                base_ref="main",
                head_ref="GH-7/safe-write",
                title="GH-7 — Безопасный Git write",
                body="Проверяемое описание",
            )

    assert exc_info.value.code == "GITHUB_PULL_REQUEST_EMPTY"


def test_github_reconciliation_includes_commit_at_each_branch_head():
    main_sha = "a" * 40
    feature_sha = "b" * 40

    class Response:
        status_code = 200
        headers = {}
        links = {}

        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

    class Session:
        def request(self, method, url, **kwargs):
            assert method == "GET"
            if url.endswith("/branches"):
                return Response(
                    [
                        {"name": "main", "commit": {"sha": main_sha}, "protected": True},
                        {
                            "name": "feature/GH-7-live-sync",
                            "commit": {"sha": feature_sha},
                            "protected": False,
                        },
                    ]
                )
            if url.endswith("/commits"):
                return Response(
                    [
                        {
                            "sha": main_sha,
                            "html_url": f"https://github.com/org/repo/commit/{main_sha}",
                            "commit": {
                                "message": "Main commit",
                                "author": {"name": "PPM", "date": "2026-09-21T00:00:00Z"},
                            },
                            "author": {"login": "ppm", "avatar_url": "https://avatars.example/ppm"},
                        }
                    ]
                )
            if url.endswith("/pulls"):
                return Response([])
            raise AssertionError(f"Unexpected GitHub URL: {url}")

    client = GitHubAppClient(session=Session())
    with patch.object(client, "create_installation_token", return_value="read-token"):
        result = client.sync_repository(81001, 91001, "org/repo")

    commits = {item["provider_object_id"]: item for item in result["commits"]}
    assert commits[main_sha]["title"] == "Main commit"
    assert commits[feature_sha] == {
        "object_type": "commit",
        "provider_object_id": feature_sha,
        "ref": feature_sha[:12],
        "title": f"Коммит {feature_sha[:12]}",
        "canonical_url": f"https://github.com/org/repo/commit/{feature_sha}",
        "state": "committed",
        "author_name": "",
        "author_avatar_url": "",
        "commit_sha": feature_sha,
        "metadata": {
            "branch_refs": ["feature/GH-7-live-sync"],
            "reconciliation_fallback": True,
        },
        "source_version": feature_sha,
        "provider_updated_at": None,
    }


@override_settings(
    PPM_GITHUB_APP_CONFIGURED=True,
    PPM_GITHUB_CONNECT_STATE_TTL_SECONDS=600,
    PPM_GITHUB_CALLBACK_URL="https://ppm.example/api/ppm/v1/git/github/callback/",
    APP_BASE_URL="http://localhost:3000",
)
def test_github_app_connect_select_repository_and_project_scope(api_client, github_project):
    owner, workspace, project, _ = github_project
    fake = FakeGitHubClient()
    api_client.force_authenticate(user=owner)

    with patch("plane.ppm_git.provider_services.GitHubAppClient", return_value=fake):
        started = api_client.post(project_git_url(workspace, project, "providers/github/start/"), format="json")
        state_value = parse_qs(urlparse(started.data["authorization_url"]).query)["state"][0]
        api_client.force_authenticate(user=None)
        setup = api_client.get(
            "/api/ppm/v1/git/github/setup/",
            {
                "state": state_value,
                "installation_id": str(fake.installation_id),
            },
        )
        completed = api_client.get(
            "/api/ppm/v1/git/github/callback/",
            {
                "state": state_value,
                "code": "valid-code",
            },
        )
        api_client.force_authenticate(user=owner)
        installation = PpmGitInstallation.objects.get(project_id=project.id)
        available = api_client.get(
            project_git_url(
                workspace,
                project,
                f"providers/github/installations/{installation.id}/repositories/",
            )
        )
        with patch("plane.ppm_git.views.reconcile_git_connection_task.delay"):
            connected = api_client.post(
                project_git_url(workspace, project, "providers/github/repositories/"),
                {
                    "installation_id": str(installation.id),
                    "provider_repository_id": fake.repository_id,
                },
                format="json",
            )

    assert started.status_code == status.HTTP_200_OK
    assert setup.status_code == status.HTTP_302_FOUND
    assert setup.url.startswith("https://github.com/login/oauth/authorize?")
    assert completed.status_code == status.HTTP_302_FOUND
    assert completed.url.endswith(f"/{workspace.slug}/projects/{project.id}/code?github=connected")
    assert available.status_code == status.HTTP_200_OK
    assert available.data["repositories"][0]["full_name"] == "ppm-test-org/ppm-project"
    assert connected.status_code == status.HTTP_201_CREATED
    assert connected.data["provider_full_name"] == "ppm-test-org/ppm-project"

    other_project = ProjectFactory(workspace=workspace, identifier="OTHER")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=owner, role=20)
    hidden = api_client.get(
        project_git_url(
            workspace,
            other_project,
            f"providers/github/installations/{installation.id}/repositories/",
        )
    )
    assert hidden.status_code == status.HTTP_404_NOT_FOUND


@override_settings(PPM_GITHUB_APP_CONFIGURED=True)
def test_github_installation_permissions_refresh_updates_project_connections(api_client, github_project):
    owner, workspace, project, _ = github_project
    fake = FakeGitHubClient()
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=fake.installation_id,
        provider_account_id=71001,
        account_login="ppm-test-org",
        permissions={"metadata": "read", "contents": "read", "pull_requests": "read"},
        events=["push", "pull_request"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    from plane.ppm_git.provider_services import connect_github_repository

    connection = connect_github_repository(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        provider_repository_id=fake.repository_id,
        user_id=owner.id,
        client=fake,
    )
    api_client.force_authenticate(user=owner)

    with patch(
        "plane.ppm_git.provider_services.GitHubAppClient",
        return_value=WritePermissionsGitHubClient(),
    ):
        response = api_client.post(
            project_git_url(
                workspace,
                project,
                f"providers/github/installations/{installation.id}/refresh/",
            ),
            format="json",
        )

    installation.refresh_from_db()
    connection.refresh_from_db()
    assert response.status_code == status.HTTP_200_OK
    assert response.data["readiness"]["permission_ready"] is True
    assert response.data["readiness"]["connections"][0]["missing_permissions"] == []
    assert installation.permissions["contents"] == "write"
    assert connection.permissions == installation.permissions
    assert PpmGitAudit.objects.filter(
        project_id=project.id,
        action="github.installation.permissions.refresh",
        target_id=installation.id,
    ).exists()

    member = UserFactory(username=f"github-member-{uuid.uuid4().hex}")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    api_client.force_authenticate(user=member)
    with patch("plane.ppm_git.provider_services.GitHubAppClient") as provider_client:
        denied = api_client.post(
            project_git_url(
                workspace,
                project,
                f"providers/github/installations/{installation.id}/refresh/",
            ),
            format="json",
        )
    assert denied.status_code == status.HTTP_403_FORBIDDEN
    provider_client.assert_not_called()


def test_new_permissions_webhook_updates_connection_readiness(github_project):
    owner, workspace, project, _ = github_project
    fake = FakeGitHubClient()
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=fake.installation_id,
        provider_account_id=71001,
        account_login="ppm-test-org",
        permissions={"metadata": "read", "contents": "read", "pull_requests": "read"},
        events=["push", "pull_request"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    from plane.ppm_git.provider_services import connect_github_repository

    connection = connect_github_repository(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        provider_repository_id=fake.repository_id,
        user_id=owner.id,
        client=fake,
    )
    raw_body = json.dumps(
        {
            "action": "new_permissions_accepted",
            "installation": {
                "id": fake.installation_id,
                "account": {"id": 71001, "login": "ppm-test-org", "type": "Organization"},
                "repository_selection": "selected",
                "permissions": {"metadata": "read", "contents": "write", "pull_requests": "write"},
                "events": ["push", "pull_request", "installation", "installation_repositories"],
            },
            "repositories": [],
        }
    ).encode()
    normalized = parse_github_webhook(raw_body, event_name="installation")
    delivery, duplicate = create_delivery(
        delivery_id="delivery-new-permissions",
        event_name="installation",
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=normalized,
    )

    process_delivery(delivery.id)

    installation.refresh_from_db()
    connection.refresh_from_db()
    delivery.refresh_from_db()
    assert duplicate is False
    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    assert installation.permissions["contents"] == "write"
    assert connection.permissions == installation.permissions
    assert connection.status == "active"


@override_settings(
    PPM_GITHUB_APP_CONFIGURED=True,
    PPM_GITHUB_CONNECT_STATE_TTL_SECONDS=600,
    PPM_GITHUB_CALLBACK_URL="https://ppm.example/api/ppm/v1/git/github/callback/",
)
def test_spoofed_installation_id_is_rejected(api_client, github_project):
    owner, workspace, project, _ = github_project
    api_client.force_authenticate(user=owner)
    with patch(
        "plane.ppm_git.provider_services.GitHubAppClient",
        return_value=UnownedInstallationClient(),
    ):
        started = api_client.post(project_git_url(workspace, project, "providers/github/start/"), format="json")
        state_value = parse_qs(urlparse(started.data["authorization_url"]).query)["state"][0]
        setup = api_client.get(
            "/api/ppm/v1/git/github/setup/",
            {
                "state": state_value,
                "installation_id": str(FakeGitHubClient.installation_id),
            },
        )
        rejected = api_client.get(
            "/api/ppm/v1/git/github/callback/",
            {
                "state": state_value,
                "code": "valid-code",
            },
        )

    assert setup.status_code == status.HTTP_302_FOUND
    assert rejected.status_code == status.HTTP_400_BAD_REQUEST
    assert rejected.data["error"]["code"] == "GITHUB_INSTALLATION_NOT_OWNED"
    assert not PpmGitInstallation.objects.filter(project_id=project.id).exists()


@override_settings(PPM_GITHUB_WEBHOOK_SECRET="webhook-test-secret", PPM_GITHUB_WEBHOOK_MAX_BYTES=2_000_000)
def test_signed_ping_is_accepted_once_and_ignored_without_retry(api_client, django_capture_on_commit_callbacks):
    raw_body = json.dumps({"zen": "Keep it logically awesome.", "hook_id": 12345}).encode()
    headers = {
        "HTTP_X_HUB_SIGNATURE_256": sign("webhook-test-secret", raw_body),
        "HTTP_X_GITHUB_EVENT": "ping",
        "HTTP_X_GITHUB_DELIVERY": "delivery-ping-1",
    }
    with (
        patch("plane.ppm_git.views.process_git_delivery_task.delay") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        accepted = api_client.generic(
            "POST",
            "/api/ppm/v1/git/github/webhook/",
            raw_body,
            content_type="application/json",
            **headers,
        )
        duplicate = api_client.generic(
            "POST",
            "/api/ppm/v1/git/github/webhook/",
            raw_body,
            content_type="application/json",
            **headers,
        )

    delivery = PpmGitDelivery.objects.get(provider_delivery_id="delivery-ping-1")
    process_delivery(delivery.id)
    delivery.refresh_from_db()

    assert accepted.status_code == status.HTTP_202_ACCEPTED
    assert duplicate.status_code == status.HTTP_200_OK
    assert duplicate.data["duplicate"] is True
    enqueue.assert_called_once()
    assert delivery.status == PpmGitDeliveryStatus.IGNORED
    assert delivery.attempts == 1
    assert delivery.next_retry_at is None


@override_settings(
    DEBUG=True,
    PPM_GITHUB_WEBHOOK_SECRET="webhook-test-secret",
    PPM_GITHUB_WEBHOOK_MAX_BYTES=2_000_000,
)
def test_unexpected_webhook_error_returns_safe_json(api_client):
    raw_body = json.dumps({"zen": "Keep it logically awesome.", "hook_id": 12345}).encode()

    with patch(
        "plane.ppm_git.views.create_delivery",
        side_effect=TypeError("internal-secret-detail-must-not-leak"),
    ):
        response = api_client.generic(
            "POST",
            "/api/ppm/v1/git/github/webhook/",
            raw_body,
            content_type="application/json",
            HTTP_X_HUB_SIGNATURE_256=sign("webhook-test-secret", raw_body),
            HTTP_X_GITHUB_EVENT="ping",
            HTTP_X_GITHUB_DELIVERY="delivery-safe-error",
        )

    response_body = response.content.decode()
    assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    assert response["Content-Type"].startswith("application/json")
    assert response.data["error"]["code"] == "GITHUB_WEBHOOK_FAILED"
    assert response.data["error"]["message"] == "Не удалось принять событие GitHub."
    assert "internal-secret-detail-must-not-leak" not in response_body
    assert "Traceback" not in response_body


@override_settings(PPM_GITHUB_WEBHOOK_SECRET="webhook-test-secret", PPM_GITHUB_WEBHOOK_MAX_BYTES=2_000_000)
def test_signed_repository_push_is_idempotent_and_auto_links_work_item(
    api_client,
    github_project,
    django_capture_on_commit_callbacks,
):
    owner, workspace, project, issue = github_project
    fake = FakeGitHubClient()
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=fake.installation_id,
        provider_account_id=71001,
        account_login="ppm-test-org",
        permissions={"contents": "read", "pull_requests": "read"},
        events=["push"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    from plane.ppm_git.provider_services import connect_github_repository

    connection = connect_github_repository(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        provider_repository_id=fake.repository_id,
        user_id=owner.id,
        client=fake,
    )
    payload = {
        "ref": f"refs/heads/GH-{issue.sequence_id}/github-app",
        "after": "a" * 40,
        "deleted": False,
        "repository": {"id": fake.repository_id, "full_name": "ppm-test-org/ppm-project"},
        "head_commit": {"id": "a" * 40, "timestamp": "2026-09-20T10:00:00Z"},
        "commits": [
            {
                "id": "a" * 40,
                "message": f"GH-{issue.sequence_id}: подключить GitHub App",
                "url": f"https://github.com/ppm-test-org/ppm-project/commit/{'a' * 40}",
                "timestamp": "2026-09-20T10:00:00Z",
                "author": {"username": "developer", "email": "must-not-be-stored@example.test"},
            }
        ],
    }
    raw_body = json.dumps(payload).encode()
    headers = {
        "HTTP_X_HUB_SIGNATURE_256": sign("webhook-test-secret", raw_body),
        "HTTP_X_GITHUB_EVENT": "push",
        "HTTP_X_GITHUB_DELIVERY": "delivery-1",
    }
    with (
        patch("plane.ppm_git.views.process_git_delivery_task.delay") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        accepted = api_client.generic(
            "POST",
            "/api/ppm/v1/git/github/webhook/",
            raw_body,
            content_type="application/json",
            **headers,
        )
        duplicate = api_client.generic(
            "POST",
            "/api/ppm/v1/git/github/webhook/",
            raw_body,
            content_type="application/json",
            **headers,
        )

    delivery = PpmGitDelivery.objects.get(provider_delivery_id="delivery-1")
    process_delivery(delivery.id)
    connection.refresh_from_db()

    assert accepted.status_code == status.HTTP_202_ACCEPTED
    assert duplicate.status_code == status.HTTP_200_OK
    assert duplicate.data["duplicate"] is True
    enqueue.assert_called_once()
    assert PpmGitDelivery.objects.count() == 1
    assert delivery.provider_installation_id is None
    assert connection.last_event_at is not None
    assert PpmGitObject.objects.filter(connection=connection).count() == 2
    assert PpmGitLink.objects.filter(work_item=issue, origin="provider", status="active").count() == 2
    assert "must-not-be-stored@example.test" not in str(PpmGitDelivery.objects.get().payload)

    invalid = api_client.generic(
        "POST",
        "/api/ppm/v1/git/github/webhook/",
        raw_body,
        content_type="application/json",
        HTTP_X_HUB_SIGNATURE_256="sha256=invalid",
        HTTP_X_GITHUB_EVENT="push",
        HTTP_X_GITHUB_DELIVERY="delivery-2",
    )
    assert invalid.status_code == status.HTTP_401_UNAUTHORIZED

    PpmGitCodeIndexPolicy.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        repository=connection.repository,
        enabled=True,
        branch="main",
        include_paths=["src/**"],
        updated_by=owner.id,
    )
    deleted_branch_snapshot = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="f" * 40,
        files=[{"path": "src/revoked.py", "content": 'REVOKED-CODE = "must-purge"'}],
        dispatch=False,
    )
    deleted_branch_file_id = deleted_branch_snapshot.files.get().id
    deleted_branch_payload = {
        "ref": "refs/heads/main",
        "after": "0" * 40,
        "deleted": True,
        "installation": {"id": fake.installation_id},
        "repository": {"id": fake.repository_id, "full_name": "ppm-test-org/ppm-project"},
        "head_commit": None,
        "commits": [],
    }
    deleted_branch_body = json.dumps(deleted_branch_payload).encode()
    deleted_branch = api_client.generic(
        "POST",
        "/api/ppm/v1/git/github/webhook/",
        deleted_branch_body,
        content_type="application/json",
        HTTP_X_HUB_SIGNATURE_256=sign("webhook-test-secret", deleted_branch_body),
        HTTP_X_GITHUB_EVENT="push",
        HTTP_X_GITHUB_DELIVERY="delivery-branch-deleted",
    )
    process_delivery(PpmGitDelivery.objects.get(provider_delivery_id="delivery-branch-deleted").id)
    deleted_branch_snapshot.refresh_from_db()
    assert deleted_branch.status_code == status.HTTP_202_ACCEPTED
    assert deleted_branch_snapshot.status == PpmGitCodeSnapshotStatus.REVOKED
    assert not PpmGitCodeFile.objects.filter(id=deleted_branch_file_id).exists()

    revoked_snapshot = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="9" * 40,
        files=[{"path": "src/revoked.py", "content": 'REVOKED-CODE = "must-purge-again"'}],
        dispatch=False,
    )
    revoked_file_id = revoked_snapshot.files.get().id

    revoked_body = json.dumps(
        {
            "action": "deleted",
            "installation": {
                "id": fake.installation_id,
                "account": {"id": 71001, "login": "ppm-test-org", "type": "Organization"},
            },
            "repositories": [],
        }
    ).encode()
    revoked = api_client.generic(
        "POST",
        "/api/ppm/v1/git/github/webhook/",
        revoked_body,
        content_type="application/json",
        HTTP_X_HUB_SIGNATURE_256=sign("webhook-test-secret", revoked_body),
        HTTP_X_GITHUB_EVENT="installation",
        HTTP_X_GITHUB_DELIVERY="delivery-revoked",
    )
    process_delivery(PpmGitDelivery.objects.get(provider_delivery_id="delivery-revoked").id)
    connection.refresh_from_db()
    installation.refresh_from_db()
    revoked_snapshot.refresh_from_db()
    assert revoked.status_code == status.HTTP_202_ACCEPTED
    assert connection.status == "revoked"
    assert installation.status == "revoked"
    assert revoked_snapshot.status == PpmGitCodeSnapshotStatus.REVOKED
    assert revoked_snapshot.is_current is False
    assert not PpmGitCodeFile.objects.filter(id=revoked_file_id).exists()


def test_sync_rate_limit_is_recorded_without_disconnecting_repository(github_project):
    owner, workspace, project, _ = github_project
    fake = FakeGitHubClient()
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=fake.installation_id,
        provider_account_id=71001,
        account_login="ppm-test-org",
        permissions={"contents": "read", "pull_requests": "read"},
        events=["push"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    from plane.ppm_git.provider_services import connect_github_repository

    connection = connect_github_repository(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        provider_repository_id=fake.repository_id,
        user_id=owner.id,
        client=fake,
    )

    with pytest.raises(PpmGitProviderRateLimited):
        synchronize_connection(connection.id, client=RateLimitedGitHubClient())

    connection.refresh_from_db()
    assert connection.status == "rate_limited"
    assert connection.last_error_code == "GITHUB_RATE_LIMITED"
    assert connection.retry_after is not None
