"""G2.1 R6 — приёмник системного вебхука Forgejo и нормализация его событий.

Тела доставок — настоящие, записанные с живого Forgejo 15.0.9 (`fixtures/forgejo/webhooks`); подпись считает тест.
Приёмник проверяет подпись до разбора тела, отвечает без эха тела, квитанция идемпотентна, обработка — в фоне тем же
нейтральным конвейером, что у GitHub.
"""

import hashlib
import hmac
import json
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_git.code_indexing import ingest_code_snapshot
from plane.ppm_git.models import (
    PpmGitCodeIndexPolicy,
    PpmGitCodeSnapshot,
    PpmGitConnection,
    PpmGitDelivery,
    PpmGitDeliveryStatus,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitObject,
    PpmGitRepository,
)
from plane.ppm_git.provider_services import (
    connect_forgejo_repository,
    create_delivery,
    process_delivery,
    synchronize_connection,
)
from plane.ppm_git.providers.base import (
    CatchUpRange,
    ConnectionErrorDirective,
    GitBranchObject,
    GitCommitObject,
    GitPullRequestObject,
    NormalizedDelivery,
)
from plane.ppm_git.tasks import reconcile_active_git_connections
from plane.ppm_git.webhooks import body_sha256, parse_forgejo_webhook, verify_forgejo_signature
from plane.tests.contract.ppm_git.forgejo_fake import PUBLIC_URL, WEBHOOK_SECRET, load_fixture, webhook_fixture
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

RECEIVER = "/api/ppm/v1/git/forgejo/webhook/"
APP = f"{PUBLIC_URL}/team-alpha/app"
BULK_BEFORE = "605e512f1a59749c195663d2ff266d8e4d422097"
BULK_HEAD = "c7eb742b6962b2d76a17746ffcf154f3a03dd423"


def keys(typed_dict):
    return set(typed_dict.__required_keys__) | set(typed_dict.__optional_keys__)


def sign(raw_body, secret=WEBHOOK_SECRET):
    return hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()


def forgejo_headers(event, raw_body, *, delivery=None, secret=WEBHOOK_SECRET, **overrides):
    """The headers a live Forgejo 15 sends (the compatible GitHub ones included)."""
    delivery = delivery or str(uuid.uuid4())
    signature = sign(raw_body, secret)
    headers = {
        "HTTP_X_FORGEJO_EVENT": event,
        "HTTP_X_FORGEJO_EVENT_TYPE": event,
        "HTTP_X_FORGEJO_DELIVERY": delivery,
        "HTTP_X_FORGEJO_SIGNATURE": signature,
        "HTTP_X_GITEA_EVENT": event,
        "HTTP_X_GITEA_DELIVERY": delivery,
        "HTTP_X_GITEA_SIGNATURE": signature,
        "HTTP_X_GITHUB_EVENT": event,
        "HTTP_X_GITHUB_DELIVERY": delivery,
        "HTTP_X_HUB_SIGNATURE_256": f"sha256={signature}",
    }
    headers.update(overrides)
    return {key: value for key, value in headers.items() if value is not None}


def post(api_client, raw_body, headers, url=RECEIVER):
    return api_client.generic("POST", url, raw_body, content_type="application/json", **headers)


def deliver(api_client, name, *, process=True, delivery=None):
    """Posts a recorded delivery and runs the background processing (as the Celery task would)."""
    event, raw_body = webhook_fixture(name)
    with patch("plane.ppm_git.views.process_git_delivery_task.delay") as enqueue:
        response = post(api_client, raw_body, forgejo_headers(event, raw_body, delivery=delivery))
    assert response.status_code in (status.HTTP_200_OK, status.HTTP_202_ACCEPTED), response.content
    row = PpmGitDelivery.objects.get(
        provider="forgejo", provider_delivery_id=response.wsgi_request.META["HTTP_X_FORGEJO_DELIVERY"]
    )
    if process:
        process_delivery(row.id)
        row.refresh_from_db()
    return response, row, enqueue


def body_with(name, **changes):
    """A recorded body with some top-level or repository fields changed (for repositories PPM does not know)."""
    _, raw_body = webhook_fixture(name)
    payload = json.loads(raw_body)
    repository = changes.pop("repository", None)
    if repository:
        payload["repository"].update(repository)
    payload.update(changes)
    return json.dumps(payload).encode()


@pytest.fixture
def forgejo_project(forgejo):
    """Project KEY with tasks KEY-1…KEY-5 and team-alpha/app connected by a PPM global administrator."""
    marker = uuid.uuid4().hex
    owner = UserFactory(username=f"forgejo-{marker}", email=f"forgejo-{marker}@plane.test")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    project = ProjectFactory(workspace=workspace, identifier="KEY")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    state = State.objects.create(
        name="Backlog", color="#60646C", group="backlog", default=True, project=project, created_by=owner
    )
    issues = {}
    for number in range(1, 6):
        issue = Issue(name=f"Задача {number}", project=project, state=state)
        issue.save(created_by_id=owner.id)
        issues[issue.sequence_id] = issue
    repository, connection = connect_forgejo_repository(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_repository_id=1,
        user_id=owner.id,
    )
    forgejo.requests.clear()
    return owner, workspace, project, issues, repository, connection


def objects_of(connection):
    return PpmGitObject.objects.filter(repository_id=connection.repository_id)


# --- signature, headers, size, configuration: refused before anything is stored -----------------------------------


def test_signature_is_the_hex_hmac_of_the_raw_body(forgejo):
    _, raw_body = webhook_fixture("push_main_initial")
    signature = sign(raw_body)

    assert verify_forgejo_signature(raw_body, signature) is True
    assert verify_forgejo_signature(raw_body, signature.upper()) is False
    assert verify_forgejo_signature(raw_body, f"sha256={signature}") is False
    assert verify_forgejo_signature(raw_body + b" ", signature) is False
    assert verify_forgejo_signature(raw_body, sign(raw_body, "another-secret")) is False
    assert verify_forgejo_signature(raw_body, "") is False
    assert verify_forgejo_signature(raw_body, None) is False
    assert verify_forgejo_signature(raw_body, "é" * 64) is False


@pytest.mark.parametrize(
    ("overrides", "code", "status_code"),
    [
        ({"HTTP_X_FORGEJO_SIGNATURE": None}, "FORGEJO_WEBHOOK_SIGNATURE_INVALID", 401),
        ({"HTTP_X_FORGEJO_SIGNATURE": ""}, "FORGEJO_WEBHOOK_SIGNATURE_INVALID", 401),
        ({"HTTP_X_FORGEJO_SIGNATURE": "0" * 64}, "FORGEJO_WEBHOOK_SIGNATURE_INVALID", 401),
        ({"HTTP_X_FORGEJO_DELIVERY": None}, "FORGEJO_WEBHOOK_HEADERS_INVALID", 400),
        ({"HTTP_X_FORGEJO_EVENT": None}, "FORGEJO_WEBHOOK_HEADERS_INVALID", 400),
        ({"HTTP_X_FORGEJO_DELIVERY": "d" * 256}, "FORGEJO_WEBHOOK_HEADERS_INVALID", 400),
    ],
)
def test_refused_deliveries_store_nothing_and_echo_nothing(api_client, forgejo, overrides, code, status_code):
    event, raw_body = webhook_fixture("push_main_initial")
    # The GitHub-compatible headers Forgejo also sends (valid signature!) must not stand in for the Forgejo ones.
    response = post(api_client, raw_body, forgejo_headers(event, raw_body, **overrides))

    assert response.status_code == status_code
    assert response.data["error"]["code"] == code
    assert not PpmGitDelivery.objects.exists()
    assert "team-alpha" not in response.content.decode() and "KEY-1" not in response.content.decode()


def test_signature_with_another_secret_is_refused(api_client, forgejo):
    event, raw_body = webhook_fixture("push_main_initial")

    response = post(api_client, raw_body, forgejo_headers(event, raw_body, secret="not-the-ppm-secret"))

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert not PpmGitDelivery.objects.exists()


def test_too_large_body_is_refused(api_client, forgejo, settings):
    settings.PPM_FORGEJO_WEBHOOK_MAX_BYTES = 1024
    event, raw_body = webhook_fixture("push_main_initial")

    response = post(api_client, raw_body, forgejo_headers(event, raw_body))

    assert response.status_code == status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    assert response.data["error"]["code"] == "FORGEJO_WEBHOOK_TOO_LARGE"
    assert not PpmGitDelivery.objects.exists()


@pytest.mark.parametrize("missing", ["PPM_FORGEJO_WEBHOOK_SECRET", "PPM_FORGEJO_TOKEN"])
def test_receiver_of_an_unconfigured_git_server_refuses(api_client, forgejo, settings, missing):
    setattr(settings, missing, "")
    event, raw_body = webhook_fixture("push_main_initial")

    response = post(api_client, raw_body, forgejo_headers(event, raw_body))

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.data["error"]["code"] == "FORGEJO_NOT_CONFIGURED"
    assert not PpmGitDelivery.objects.exists()


def test_broken_json_is_refused_without_echo(api_client, forgejo):
    raw_body = b'{"ref": "refs/heads/main", "secret-looking": '

    response = post(api_client, raw_body, forgejo_headers("push", raw_body))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == "FORGEJO_WEBHOOK_INVALID"
    assert "secret-looking" not in response.content.decode()
    assert not PpmGitDelivery.objects.exists()


def test_unexpected_failure_answers_safe_json(api_client, forgejo, settings):
    settings.DEBUG = True
    event, raw_body = webhook_fixture("push_main_initial")

    with patch("plane.ppm_git.views.create_delivery", side_effect=TypeError("internal-detail-must-not-leak")):
        response = post(api_client, raw_body, forgejo_headers(event, raw_body))

    assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    assert response.data["error"]["code"] == "FORGEJO_WEBHOOK_FAILED"
    assert "internal-detail-must-not-leak" not in response.content.decode()


def test_forgejo_delivery_is_refused_by_the_github_receiver(api_client, forgejo, settings):
    """Forgejo also sends X-GitHub-Event/Delivery and X-Hub-Signature-256 — signed with its own secret."""
    settings.PPM_GITHUB_WEBHOOK_SECRET = "github-webhook-secret-for-tests"
    event, raw_body = webhook_fixture("push_main_initial")

    response = post(api_client, raw_body, forgejo_headers(event, raw_body), url="/api/ppm/v1/git/github/webhook/")

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.data["error"]["code"] == "GITHUB_WEBHOOK_SIGNATURE_INVALID"
    assert not PpmGitDelivery.objects.exists()


# --- receipt ------------------------------------------------------------------------------------------------------


def test_signed_delivery_is_received_once_and_processed_in_background(
    api_client, forgejo_project, django_capture_on_commit_callbacks
):
    _, _, _, issues, _, connection = forgejo_project
    event, raw_body = webhook_fixture("push_main_initial")
    headers = forgejo_headers(event, raw_body, delivery="d953d0a8-a96f-4108-9369-1483596af0f3")

    with (
        patch("plane.ppm_git.views.process_git_delivery_task.delay") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        accepted = post(api_client, raw_body, headers)
        duplicate = post(api_client, raw_body, headers)
        conflict = post(api_client, raw_body + b"\n", {**headers, "HTTP_X_FORGEJO_SIGNATURE": sign(raw_body + b"\n")})

    delivery = PpmGitDelivery.objects.get()
    assert accepted.status_code == status.HTTP_202_ACCEPTED
    assert (duplicate.status_code, duplicate.data["duplicate"]) == (status.HTTP_200_OK, True)
    assert conflict.status_code == status.HTTP_409_CONFLICT
    assert conflict.data["error"]["code"] == "GIT_DELIVERY_CONFLICT"
    enqueue.assert_called_once_with(str(delivery.id))
    assert (delivery.provider, delivery.provider_installation_id, delivery.provider_repository_id) == ("forgejo", 1, 1)
    assert (delivery.event_name, delivery.status) == ("push", PpmGitDeliveryStatus.RECEIVED)
    # Never the raw body: no e-mails, no sender object.
    assert "@" not in json.dumps(delivery.payload)

    process_delivery(delivery.id)

    delivery.refresh_from_db()
    connection.refresh_from_db()
    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    assert sorted(objects_of(connection).values_list("object_type", flat=True)) == ["branch", "commit", "commit"]
    assert connection.last_event_at is not None
    commit = objects_of(connection).get(title="KEY-1: add sensor driver")
    assert commit.canonical_url == f"{APP}/commit/{commit.provider_object_id}"
    assert commit.author_name == "dev1"
    # Auto-link by key.
    assert PpmGitLink.objects.filter(work_item=issues[1], git_object=commit, origin="provider").exists()


def test_every_recorded_delivery_normalizes_to_contract_keys_only(forgejo):
    for item in load_fixture("webhooks/index.json"):
        event, raw_body = webhook_fixture(item["name"])
        normalized = parse_forgejo_webhook(raw_body, event_name=event)

        assert set(normalized) <= keys(NormalizedDelivery), item["name"]
        assert normalized["installation_id"] == 1
        json.dumps(normalized)
        assert "@" not in json.dumps(normalized), item["name"]
        if "branch" in normalized:
            assert set(normalized["branch"]) == keys(GitBranchObject)
            assert len(normalized["branch"]["source_version"]) <= 64
        for commit in normalized.get("commits", []):
            assert set(commit) == keys(GitCommitObject)
        if "pull_request" in normalized:
            assert set(normalized["pull_request"]) == keys(GitPullRequestObject)
            assert len(normalized["pull_request"]["source_version"]) <= 64
        if "catch_up" in normalized:
            assert set(normalized["catch_up"]) == keys(CatchUpRange)
        if "connection_error" in normalized:
            assert set(normalized["connection_error"]) <= keys(ConnectionErrorDirective)


def test_recorded_events_normalize_as_the_live_server_meant_them(forgejo):
    def parse(name):
        event, raw_body = webhook_fixture(name)
        return parse_forgejo_webhook(raw_body, event_name=event)

    created = parse("create_branch_login_form")
    deleted = parse("delete_branch_login_form")
    merged = parse("pull_request_merged")
    synchronized = parse("pull_request_synchronized")

    # `create`/`delete` carry the full ref (live Forgejo 15), the branch keeps its short name.
    assert (created["ref"], created["deleted"], created["commits"]) == ("refs/heads/KEY-2/login-form", False, [])
    assert created["branch"]["provider_object_id"] == "KEY-2/login-form"
    assert created["branch"]["canonical_url"] == f"{APP}/src/branch/KEY-2/login-form"
    assert (deleted["deleted"], deleted["branch"]["state"], deleted["branch"]["commit_sha"]) == (True, "deleted", "")
    assert merged["pull_request"]["state"] == "merged"
    assert merged["pull_request"]["provider_merged_at"] == "2026-09-28T13:21:05+00:00"
    assert merged["pull_request"]["head_ref"] == "KEY-2/login-form"
    assert synchronized["action"] == "synchronized"
    assert parse("pull_request_opened_draft")["pull_request"]["is_draft"] is True
    # Tags, other ref types, repository creation and events PPM does not use: accepted, never applied.
    for name in ("push_tag", "create_tag", "repository_created"):
        assert parse(name)["ignored"] is True, name
    assert parse_forgejo_webhook(b"{}", event_name="issues") == {
        "event": "issues",
        "installation_id": 1,
        "ignored": True,
    }
    removed = parse("repository_deleted")
    assert removed["repository_id"] == 2
    assert removed["connection_error"] == {
        "code": "GIT_REPOSITORY_DELETED",
        "message": "Репозиторий удалён на Git-сервере. История и связи в PPM сохранены; чтобы продолжить, подключите "
        "репозиторий заново.",
        "purge_code": True,
        "halt_sync": True,
    }
    # Pushes Forgejo cut: 15 of 20 commits of an existing branch, the last 10 of a new branch.
    truncated = parse("push_bulk_truncated")
    new_branch = parse("push_bulk_new_branch")
    assert len(truncated["commits"]) == 15
    assert truncated["catch_up"] == {
        "ref": "refs/heads/KEY-5/bulk",
        "before": BULK_BEFORE,
        "after": BULK_HEAD,
        "base": "main",
    }
    assert len(new_branch["commits"]) == 10
    assert new_branch["catch_up"] == {
        "ref": "refs/heads/KEY-5/bulk",
        "before": "",
        "after": BULK_BEFORE,
        "base": "main",
    }
    assert "catch_up" not in parse("push_branch_login_form_more")
    assert "catch_up" not in parse("push_main_initial")


# --- application ----------------------------------------------------------------------------------------------------


def test_github_headers_do_not_steer_the_forgejo_receiver(api_client, forgejo_project):
    event, raw_body = webhook_fixture("push_branch_login_form")
    headers = forgejo_headers(event, raw_body, HTTP_X_GITHUB_EVENT="installation", HTTP_X_GITEA_EVENT="installation")

    with patch("plane.ppm_git.views.process_git_delivery_task.delay"):
        response = post(api_client, raw_body, headers)

    assert response.status_code == status.HTTP_202_ACCEPTED
    assert PpmGitDelivery.objects.get().event_name == "push"


def test_push_stores_commits_and_links_them_to_work_items_by_key(api_client, forgejo_project):
    _, _, _, issues, _, connection = forgejo_project

    deliver(api_client, "create_branch_login_form")
    _, delivery, _ = deliver(api_client, "push_branch_login_form")

    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    branch = objects_of(connection).get(object_type="branch", provider_object_id="KEY-2/login-form")
    assert (branch.state, branch.is_active) == ("active", True)
    titles = set(objects_of(connection).filter(object_type="commit").values_list("title", flat=True))
    assert titles == {"KEY-2: login form", "KEY-2: validate input"}
    linked = set(PpmGitLink.objects.filter(work_item=issues[2], status="active").values_list("object_type", flat=True))
    assert linked == {"branch", "commit"}


def test_pull_request_is_opened_then_merged(api_client, forgejo_project):
    _, _, _, issues, _, connection = forgejo_project

    deliver(api_client, "pull_request_opened")
    opened = objects_of(connection).get(object_type="pull_request")
    assert (opened.state, opened.is_draft, opened.head_ref, opened.provider_merged_at) == (
        "open",
        False,
        "KEY-2/login-form",
        None,
    )
    deliver(api_client, "pull_request_synchronized")
    deliver(api_client, "pull_request_edited")
    deliver(api_client, "pull_request_merged")

    merged = objects_of(connection).get(object_type="pull_request")
    assert merged.id == opened.id
    assert (merged.state, merged.title) == ("merged", "KEY-2 — форма входа и проверка")
    assert merged.provider_merged_at.isoformat() == "2026-09-28T13:21:05+00:00"
    assert merged.canonical_url == f"{APP}/pulls/1"
    assert PpmGitLink.objects.filter(work_item=issues[2], git_object=merged).exists()

    deliver(api_client, "pull_request_opened_draft")
    deliver(api_client, "pull_request_closed")
    closed = objects_of(connection).get(object_type="pull_request", ref="2")
    assert (closed.state, closed.is_draft, closed.provider_merged_at) == ("closed", True, None)


def test_branch_deletion_marks_the_branch_and_purges_the_index_of_the_indexed_branch(api_client, forgejo_project):
    owner, _, _, _, _, connection = forgejo_project
    deliver(api_client, "create_branch_login_form")
    PpmGitCodeIndexPolicy.objects.create(
        workspace_id=connection.workspace_id,
        project_id=connection.project_id,
        repository=connection.repository,
        enabled=True,
        branch="KEY-2/login-form",
        updated_by=owner.id,
    )
    snapshot = ingest_code_snapshot(
        connection=connection,
        branch="KEY-2/login-form",
        commit_sha="5d2d8b33018a04ffba909dabe9db92d14e13f34f",
        files=[{"path": "src/login.py", "content": "def login(user):\n    return bool(user)\n"}],
        dispatch=False,
    )

    _, delivery, _ = deliver(api_client, "delete_branch_login_form")

    branch = objects_of(connection).get(object_type="branch", provider_object_id="KEY-2/login-form")
    snapshot.refresh_from_db()
    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    assert (branch.state, branch.is_active) == ("deleted", False)
    assert snapshot.status == "revoked" and not snapshot.files.exists()


def test_tags_unknown_events_and_other_repositories_change_nothing(api_client, forgejo_project):
    _, _, _, _, _, connection = forgejo_project
    unknown = b'{"action": "opened", "repository": {"id": 1}}'

    for name in ("push_tag", "create_tag", "repository_created"):
        _, delivery, _ = deliver(api_client, name)
        assert delivery.status == PpmGitDeliveryStatus.IGNORED, name
    with patch("plane.ppm_git.views.process_git_delivery_task.delay"):
        response = post(api_client, unknown, forgejo_headers("issues", unknown))
    process_delivery(PpmGitDelivery.objects.get(event_name="issues").id)
    # A repository without an active Forgejo connection (the live `tools`, id 2, and an unknown id).
    _, removed_elsewhere, _ = deliver(api_client, "repository_deleted")
    other = body_with("push_branch_login_form", repository={"id": 999})
    with patch("plane.ppm_git.views.process_git_delivery_task.delay"):
        post(api_client, other, forgejo_headers("push", other))
    process_delivery(PpmGitDelivery.objects.get(provider_repository_id=999).id)

    connection.refresh_from_db()
    assert response.status_code == status.HTTP_202_ACCEPTED
    assert set(PpmGitDelivery.objects.values_list("status", flat=True)) == {PpmGitDeliveryStatus.IGNORED}
    assert removed_elsewhere.provider_repository_id == 2
    assert not objects_of(connection).exists()
    assert (connection.status, connection.last_error_code, connection.last_event_at) == ("active", "", None)


def receive(api_client, raw_body, event):
    with patch("plane.ppm_git.views.process_git_delivery_task.delay"):
        response = post(api_client, raw_body, forgejo_headers(event, raw_body))
    assert response.status_code == status.HTTP_202_ACCEPTED, response.content
    return PpmGitDelivery.objects.get(provider_delivery_id=response.wsgi_request.META["HTTP_X_FORGEJO_DELIVERY"])


def test_a_delivery_of_an_unconnected_repository_keeps_only_the_event_and_ids(api_client, forgejo_project):
    """Fix round 1: the system webhook sends every repository of the server — PPM keeps no content of the ones it does
    not follow (no commit messages, titles, branches or authors)."""
    _, _, _, _, _, connection = forgejo_project
    unconnected = [
        ("push", body_with("push_branch_login_form", repository={"id": 999})),
        ("pull_request", body_with("pull_request_merged", repository={"id": 999})),
        ("create", body_with("create_branch_login_form", repository={"id": 999})),
        ("repository", webhook_fixture("repository_deleted")[1]),  # the live `tools` (id 2) is not connected here
    ]

    stored = [receive(api_client, raw_body, event) for event, raw_body in unconnected]
    followed = receive(api_client, webhook_fixture("push_branch_login_form")[1], "push")

    assert [delivery.payload for delivery in stored] == [
        {"event": "push", "action": "", "installation_id": 1, "repository_id": 999, "ignored": True},
        {"event": "pull_request", "action": "closed", "installation_id": 1, "repository_id": 999, "ignored": True},
        {"event": "create", "action": "", "installation_id": 1, "repository_id": 999, "ignored": True},
        {"event": "repository", "action": "deleted", "installation_id": 1, "repository_id": 2, "ignored": True},
    ]
    for delivery in stored:
        process_delivery(delivery.id)
        delivery.refresh_from_db()
        assert delivery.status == PpmGitDeliveryStatus.IGNORED
    # A repository PPM follows keeps its content until it is applied.
    assert {"branch", "commits"} <= set(followed.payload)
    assert followed.payload["commits"][0]["metadata"]["message"].startswith("KEY-2")
    connection.refresh_from_db()
    assert connection.status == "active"


def test_a_halted_repository_keeps_no_content_either(api_client, forgejo_project):
    _, _, _, _, _, connection = forgejo_project
    PpmGitConnection.objects.filter(id=connection.id).update(sync_cursor={"halted": {"code": "GIT_REPOSITORY_DELETED"}})

    delivery = receive(api_client, webhook_fixture("push_branch_login_form")[1], "push")

    assert delivery.payload == {
        "event": "push",
        "action": "",
        "installation_id": 1,
        "repository_id": 1,
        "ignored": True,
    }


@pytest.mark.parametrize(
    "breakage",
    [
        lambda pull: pull.pop("number"),
        lambda pull: pull.update(id="1"),
        lambda pull: pull.pop("html_url"),
    ],
    ids=["no-number", "string-id", "no-html-url"],
)
def test_a_broken_pull_request_in_a_signed_delivery_is_refused_as_invalid(api_client, forgejo_project, breakage):
    _, raw_body = webhook_fixture("pull_request_opened")
    payload = json.loads(raw_body)
    breakage(payload["pull_request"])
    broken = json.dumps(payload).encode()

    response = post(api_client, broken, forgejo_headers("pull_request", broken))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == "FORGEJO_WEBHOOK_INVALID"
    assert "KEY-2" not in response.content.decode()
    assert not PpmGitDelivery.objects.exists()


def scheduled_housekeeping():
    with (
        patch("plane.ppm_git.tasks.reconcile_git_connection_task.delay"),
        patch("plane.ppm_git.tasks.process_git_delivery_task.delay"),
    ):
        reconcile_active_git_connections()


def test_old_processed_and_ignored_receipts_of_both_providers_are_purged(forgejo):
    """Fix round 1: receipts are kept 30 days after they were handled — for GitHub too (nothing cleaned them before).
    Round 2: the period counts from handling (`processed_at`, set exactly for processed and ignored receipts)."""
    now = timezone.now()

    def receipt(provider, status_value, received_days, handled_days=None):
        delivery = PpmGitDelivery.objects.create(
            provider=provider,
            provider_delivery_id=f"{provider}-{status_value}-{received_days}-{handled_days}",
            event_name="push",
            body_sha256="0" * 64,
            payload={"event": "push"},
            status=status_value,
        )
        handled = status_value in ("processed", "ignored")
        PpmGitDelivery.objects.filter(id=delivery.id).update(
            received_at=now - timedelta(days=received_days),
            # As `process_delivery` does: only a processed or ignored receipt has a handling moment.
            processed_at=now - timedelta(days=received_days if handled_days is None else handled_days)
            if handled
            else None,
        )
        return delivery.id

    providers, handled = ("github", "forgejo"), ("processed", "ignored")
    purged = [receipt(provider, value, 31) for provider in providers for value in handled]
    kept = [receipt(provider, value, 29) for provider in providers for value in handled]
    # Received long ago, handled recently (it failed for weeks first): kept for 30 days after handling.
    kept += [receipt(provider, value, 90, handled_days=29) for provider in providers for value in handled]
    kept += [receipt(provider, value, 90) for provider in providers for value in ("failed", "received")]

    scheduled_housekeeping()

    assert not PpmGitDelivery.objects.filter(id__in=purged).exists()
    assert set(PpmGitDelivery.objects.values_list("id", flat=True)) == set(kept)


def test_a_receipt_handled_late_still_guards_the_next_redelivery(forgejo):
    """Round 2: a delivery that stayed failed for more than 30 days and then succeeded is not removed right after its
    processing — otherwise the next redelivery of the same id would be taken as new."""
    event, raw_body = webhook_fixture("push_tag")
    normalized = parse_forgejo_webhook(raw_body, event_name=event)
    delivery, _ = create_delivery(
        provider="forgejo",
        delivery_id="late-success",
        event_name=event,
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=normalized,
    )
    PpmGitDelivery.objects.filter(id=delivery.id).update(
        received_at=timezone.now() - timedelta(days=45),
        status=PpmGitDeliveryStatus.FAILED,
        attempts=12,
    )

    process_delivery(delivery.id)
    scheduled_housekeeping()

    delivery.refresh_from_db()
    assert delivery.status == PpmGitDeliveryStatus.IGNORED
    assert delivery.processed_at is not None
    again, duplicate = create_delivery(
        provider="forgejo",
        delivery_id="late-success",
        event_name=event,
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=normalized,
    )
    assert (duplicate, again.id) == (True, delivery.id)


def test_repository_deletion_halts_the_connection_and_keeps_the_history(api_client, forgejo_project):
    owner, _, _, issues, _, connection = forgejo_project
    deliver(api_client, "push_main_initial")
    PpmGitCodeIndexPolicy.objects.create(
        workspace_id=connection.workspace_id,
        project_id=connection.project_id,
        repository=connection.repository,
        enabled=True,
        branch="main",
        updated_by=owner.id,
    )
    ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="2afb6d980cb230732d188de52866425cac96b979",
        files=[{"path": "src/sensor.py", "content": "def read_sensor():\n    return 42\n"}],
        dispatch=False,
    )
    deleted = body_with("repository_deleted", repository={"id": 1, "name": "app", "full_name": "team-alpha/app"})

    with patch("plane.ppm_git.views.process_git_delivery_task.delay"):
        post(api_client, deleted, forgejo_headers("repository", deleted))
    delivery = PpmGitDelivery.objects.get(event_name="repository")
    process_delivery(delivery.id)

    connection.refresh_from_db()
    delivery.refresh_from_db()
    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    assert (connection.status, connection.last_error_code) == ("error", "GIT_REPOSITORY_DELETED")
    assert connection.sync_cursor["halted"]["code"] == "GIT_REPOSITORY_DELETED"
    # History and links stay; the code index of the deleted repository is dropped.
    assert objects_of(connection).count() == 3
    assert PpmGitLink.objects.filter(work_item=issues[1], status="active").exists()
    assert PpmGitCodeSnapshot.objects.get(repository_id=connection.repository_id).status == "revoked"
    # The scheduled reconciliation leaves it alone until «Обновить».
    with patch("plane.ppm_git.tasks.reconcile_git_connection_task.delay") as enqueue:
        reconcile_active_git_connections()
    assert str(connection.id) not in {call.args[0] for call in enqueue.call_args_list}


# --- a push Forgejo cut is completed by a synchronization ----------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected_steps"),
    [
        # An existing branch: the webhook carried 15 of 20 commits.
        ("push_bulk_truncated", range(21, 41)),
        # A new branch: the webhook carried its last 10 commits (and said total 10) of 20.
        ("push_bulk_new_branch", range(1, 21)),
    ],
)
def test_truncated_push_queues_a_synchronization_that_reads_the_rest(
    api_client, forgejo_project, django_capture_on_commit_callbacks, forgejo, name, expected_steps
):
    _, _, _, issues, _, connection = forgejo_project

    with (
        patch("plane.ppm_git.tasks.reconcile_git_connection_task.delay") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        _, delivery, _ = deliver(api_client, name)

    connection.refresh_from_db()
    pending = connection.sync_cursor["catch_up"]
    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    enqueue.assert_called_once_with(str(connection.id))
    assert len(pending) == 1 and pending[0]["ref"] == "refs/heads/KEY-5/bulk"
    webhook_steps = objects_of(connection).filter(object_type="commit", title__startswith="KEY-5").count()
    assert webhook_steps in (10, 15)

    synchronize_connection(connection.id)

    connection.refresh_from_db()
    titles = set(objects_of(connection).filter(object_type="commit").values_list("title", flat=True))
    assert {f"KEY-5: bulk step {number}" for number in expected_steps} <= titles
    assert "catch_up" not in connection.sync_cursor
    linked = PpmGitLink.objects.filter(work_item=issues[5], object_type="commit", status="active").count()
    assert linked >= len(expected_steps)


def test_complete_push_queues_no_extra_synchronization(api_client, forgejo_project, django_capture_on_commit_callbacks):
    _, _, _, _, _, connection = forgejo_project

    with (
        patch("plane.ppm_git.tasks.reconcile_git_connection_task.delay") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        deliver(api_client, "push_branch_login_form_more")

    connection.refresh_from_db()
    enqueue.assert_not_called()
    assert "catch_up" not in connection.sync_cursor


def test_catch_up_ranges_survive_a_failed_synchronization(api_client, forgejo_project, forgejo):
    from plane.ppm_git.providers.base import PpmGitProviderError
    from plane.tests.contract.ppm_git.forgejo_fake import FakeResponse

    _, _, _, _, _, connection = forgejo_project
    with patch("plane.ppm_git.tasks.reconcile_git_connection_task.delay"):
        deliver(api_client, "push_bulk_truncated")
    forgejo.inject(r"/repositories/1$", FakeResponse(500, {"message": "boom"}))

    with pytest.raises(PpmGitProviderError):
        synchronize_connection(connection.id)

    connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("error", "GIT_PROVIDER_UNAVAILABLE")
    assert len(connection.sync_cursor["catch_up"]) == 1
    synchronize_connection(connection.id)
    connection.refresh_from_db()
    assert connection.status == "active" and "catch_up" not in connection.sync_cursor


def test_installation_and_repository_rows_are_scoped_to_forgejo(forgejo_project):
    _, _, project, _, repository, connection = forgejo_project

    installation = PpmGitInstallation.objects.get(project_id=project.id)
    assert (installation.provider, installation.provider_installation_id) == ("forgejo", 1)
    assert PpmGitRepository.objects.get(id=repository.id).provider == "forgejo"
    assert PpmGitConnection.objects.get(id=connection.id).installation_id == installation.id
    assert timezone.now() >= connection.created_at
