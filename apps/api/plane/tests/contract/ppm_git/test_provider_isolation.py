"""G2.1 R1c–R1e — провайдер-нейтральные пути вызывают клиента провайдера подключения, а внешние id не пересекаются.

Второй провайдер здесь — значение ``gitea`` с подменённой фабрикой реестра: так проверяется «разъём» до появления
Forgejo. Числовой id репозитория и установки у GitHub и второго провайдера совпадают намеренно.
"""

import json
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from django.test import override_settings
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_git.code_indexing import ingest_code_snapshot, synchronize_repository_code
from plane.ppm_git.models import (
    PpmGitAudit,
    PpmGitCodeIndexPolicy,
    PpmGitCodeSnapshot,
    PpmGitCodeSnapshotStatus,
    PpmGitConnection,
    PpmGitDelivery,
    PpmGitDeliveryStatus,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitObject,
    PpmGitProvider,
    PpmGitRepository,
)
from plane.ppm_git.provider_services import (
    connect_github_repository,
    create_delivery,
    list_github_repositories,
    process_delivery,
    refresh_github_installation,
    resume_connection_sync,
    synchronize_connection,
)
from plane.ppm_git.providers.base import PpmGitProviderError
from plane.ppm_git.services import PpmGitError
from plane.ppm_git.tasks import reconcile_active_git_connections
from plane.ppm_git.webhooks import body_sha256, parse_github_webhook
from plane.ppm_git.write_actions import create_git_write_action_preview, serialize_git_write_readiness
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

INSTALLATION_ID = 81001
REPOSITORY_ID = 91001
FULL_NAME = "ppm-test-org/ppm-project"
GITHUB_URL = f"https://github.com/{FULL_NAME}"
OTHER_URL = f"https://git.example.test/{FULL_NAME}"


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


def connect(*, owner, workspace, project, provider, canonical_url, is_default):
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider=provider,
        provider_installation_id=INSTALLATION_ID,
        provider_account_id=71001,
        account_login="ppm-test-org",
        permissions={"metadata": "read", "contents": "read", "pull_requests": "read"},
        events=["push", "pull_request"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    repository = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name=f"ppm-project-{provider}",
        normalized_name=f"ppm-project-{provider}",
        provider=provider,
        provider_repository_id=REPOSITORY_ID,
        provider_full_name=FULL_NAME,
        canonical_url=canonical_url,
        clone_https=f"{canonical_url}.git",
        default_branch="main",
        visibility="private",
        is_default=is_default,
        created_by=owner.id,
        updated_by=owner.id,
    )
    return PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=REPOSITORY_ID,
        provider_full_name=FULL_NAME,
        permissions=installation.permissions,
        events=installation.events,
        created_by=owner.id,
        updated_by=owner.id,
    )


@pytest.fixture
def twins():
    """One project with a GitHub repository and a second provider's repository under the same external ids."""
    owner = make_user("twin")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    project = ProjectFactory(workspace=workspace, identifier="TWIN")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=owner,
    )
    issue = Issue(name="Развести провайдеров", project=project, state=state)
    issue.save(created_by_id=owner.id)
    common = {"owner": owner, "workspace": workspace, "project": project}
    return SimpleNamespace(
        **common,
        issue=issue,
        key=f"TWIN-{issue.sequence_id}",
        github=connect(**common, provider=PpmGitProvider.GITHUB, canonical_url=GITHUB_URL, is_default=True),
        other=connect(**common, provider=PpmGitProvider.GITEA, canonical_url=OTHER_URL, is_default=False),
    )


def branch_object(base_url, name, sha, *, deleted=False):
    return {
        "object_type": "branch",
        "provider_object_id": name,
        "ref": name,
        "title": name,
        "canonical_url": f"{base_url}/src/branch/{name}",
        "state": "deleted" if deleted else "active",
        "commit_sha": sha,
        "metadata": {},
        "source_version": sha or name,
        "provider_updated_at": "2026-09-28T10:00:00+00:00",
    }


def commit_object(base_url, sha, message):
    return {
        "object_type": "commit",
        "provider_object_id": sha,
        "ref": sha[:12],
        "title": message.splitlines()[0],
        "canonical_url": f"{base_url}/commit/{sha}",
        "state": "committed",
        "author_name": "developer",
        "author_avatar_url": "",
        "commit_sha": sha,
        "metadata": {"message": message},
        "source_version": sha,
        "provider_updated_at": "2026-09-28T10:00:00+00:00",
    }


class RecordingClient:
    """A provider client double that records every call and answers for its own repository only."""

    def __init__(self, base_url, sha_digit, key="TWIN-1"):
        self.base_url = base_url
        self.sha = sha_digit * 40
        self.key = key
        self.calls = []

    def sync_repository(self, installation_id, repository_id, full_name, *, since=None):
        self.calls.append(("sync_repository", installation_id, repository_id, full_name))
        return {
            "branches": [branch_object(self.base_url, f"{self.key}/split", self.sha)],
            "commits": [commit_object(self.base_url, self.sha, f"{self.key}: развести провайдеров")],
            "pull_requests": [],
        }

    def get_code_tree(self, installation_id, repository_id, full_name, ref):
        self.calls.append(("get_code_tree", installation_id, repository_id, full_name, ref))
        return {"commit_sha": self.sha, "files": [{"path": "src/app.py", "sha": "blob-1", "size": 25}]}

    def get_code_blobs(self, installation_id, repository_id, full_name, files):
        self.calls.append(
            ("get_code_blobs", installation_id, repository_id, full_name, [item["sha"] for item in files])
        )
        return {"blob-1": b'SPLIT_MARKER = "provider"'}

    def normalize_pull_request(self, payload):
        raise AssertionError("not used by these paths")


def must_not_be_built(**kwargs):
    raise AssertionError("the client of another provider must not be built")


def objects_of(connection):
    return PpmGitObject.objects.filter(repository_id=connection.repository_id)


def github_push(*, delivery_id, sha, message, branch="main", installation=True):
    payload = {
        "ref": f"refs/heads/{branch}",
        "after": sha,
        "deleted": False,
        "repository": {"id": REPOSITORY_ID, "full_name": FULL_NAME},
        "head_commit": {"id": sha, "timestamp": "2026-09-28T10:00:00Z"},
        "commits": [
            {
                "id": sha,
                "message": message,
                "url": f"{GITHUB_URL}/commit/{sha}",
                "timestamp": "2026-09-28T10:00:00Z",
                "author": {"username": "developer"},
            }
        ],
    }
    if installation:
        payload["installation"] = {"id": INSTALLATION_ID}
    raw_body = json.dumps(payload).encode()
    delivery, _ = create_delivery(
        delivery_id=delivery_id,
        event_name="push",
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=parse_github_webhook(raw_body, event_name="push"),
    )
    return delivery


def other_delivery(*, delivery_id, event_name, payload):
    """A second provider's already normalized delivery — only its normalizer would differ from GitHub."""
    normalized = {
        "event": event_name,
        "action": "",
        "installation_id": INSTALLATION_ID,
        "repository_id": REPOSITORY_ID,
        **payload,
    }
    return create_delivery(
        provider=PpmGitProvider.GITEA,
        delivery_id=delivery_id,
        event_name=event_name,
        raw_body_hash=body_sha256(json.dumps(normalized, sort_keys=True).encode()),
        normalized_payload=normalized,
    )


def enable_code_index(connection):
    return PpmGitCodeIndexPolicy.objects.create(
        workspace_id=connection.workspace_id,
        project_id=connection.project_id,
        repository=connection.repository,
        enabled=True,
        branch="main",
        include_paths=["src/**"],
        updated_by=connection.created_by,
    )


# --- R1c: the neutral paths call the client of the connection's provider --------------------------------------------


def test_reconciliation_calls_the_client_of_the_connection_provider(twins, provider_registry):
    github_client = RecordingClient(GITHUB_URL, "a", twins.key)
    other_client = RecordingClient(OTHER_URL, "b", twins.key)
    provider_registry(PpmGitProvider.GITHUB, lambda: github_client)
    provider_registry(PpmGitProvider.GITEA, lambda: other_client)

    synchronize_connection(twins.other.id)

    assert other_client.calls == [("sync_repository", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME)]
    assert github_client.calls == []
    assert sorted(objects_of(twins.other).values_list("object_type", flat=True)) == ["branch", "commit"]
    assert not objects_of(twins.github).exists()
    assert set(PpmGitLink.objects.filter(work_item=twins.issue).values_list("repository_id", flat=True)) == {
        twins.other.repository_id
    }

    synchronize_connection(twins.github.id)

    assert github_client.calls == [("sync_repository", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME)]
    assert len(other_client.calls) == 1
    assert {item.canonical_url.split("/")[2] for item in objects_of(twins.github)} == {"github.com"}
    assert {item.canonical_url.split("/")[2] for item in objects_of(twins.other)} == {"git.example.test"}
    twins.github.refresh_from_db()
    twins.other.refresh_from_db()
    assert (twins.github.status, twins.other.status) == ("active", "active")


def test_code_indexing_reads_code_through_the_connection_provider(twins, provider_registry):
    other_client = RecordingClient(OTHER_URL, "c", twins.key)
    provider_registry(PpmGitProvider.GITHUB, must_not_be_built)
    provider_registry(PpmGitProvider.GITEA, lambda: other_client)
    enable_code_index(twins.github)
    enable_code_index(twins.other)

    snapshot = synchronize_repository_code(twins.other.repository_id, dispatch=False)

    assert other_client.calls == [
        ("get_code_tree", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME, "main"),
        ("get_code_blobs", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME, ["blob-1"]),
    ]
    assert snapshot.repository_id == twins.other.repository_id
    assert snapshot.status == PpmGitCodeSnapshotStatus.READY
    # The file link follows the provider's own URL layout, not GitHub's `/blob/`.
    assert snapshot.files.get().canonical_url == f"{OTHER_URL}/src/commit/{'c' * 40}/src/app.py"
    assert not PpmGitCodeSnapshot.objects.filter(repository_id=twins.github.repository_id).exists()


@pytest.mark.parametrize(
    ("registered", "code"),
    [(True, "GIT_PROVIDER_NOT_CONFIGURED"), (False, "GIT_PROVIDER_UNSUPPORTED")],
)
def test_reconciliation_without_a_usable_client_records_the_error(twins, provider_registry, registered, code):
    if registered:
        # Registered, but its server settings are incomplete.
        provider_registry(PpmGitProvider.GITEA, must_not_be_built, configured=False)
    else:
        PpmGitInstallation.objects.filter(id=twins.other.installation_id).update(provider=PpmGitProvider.BITBUCKET)
    enable_code_index(twins.other)

    with pytest.raises(PpmGitProviderError) as code_error:
        synchronize_repository_code(twins.other.repository_id, dispatch=False)
    with pytest.raises(PpmGitProviderError) as sync_error:
        synchronize_connection(twins.other.id)

    twins.other.refresh_from_db()
    twins.github.refresh_from_db()
    assert sync_error.value.code == code_error.value.code == code
    # Never left «syncing»: the error is visible on the connection, GitHub is not affected.
    assert (twins.other.status, twins.other.last_error_code) == ("error", code)
    assert (twins.github.status, twins.github.last_error_code) == ("active", "")


# --- R1d/R1e: deliveries are applied to the connections of their own provider only ----------------------------------


@pytest.mark.parametrize("installation", [True, False])
def test_github_delivery_never_touches_another_provider_with_the_same_ids(twins, installation):
    sha = "d" * 40
    delivery = github_push(
        delivery_id=f"github-{installation}",
        sha=sha,
        message=f"{twins.key}: GitHub",
        branch=f"{twins.key}/split",
        installation=installation,
    )

    process_delivery(delivery.id)

    delivery.refresh_from_db()
    twins.github.refresh_from_db()
    twins.other.refresh_from_db()
    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    assert sorted(objects_of(twins.github).values_list("object_type", flat=True)) == ["branch", "commit"]
    assert not objects_of(twins.other).exists()
    assert twins.github.last_event_at is not None
    assert twins.other.last_event_at is None
    assert set(PpmGitLink.objects.filter(work_item=twins.issue).values_list("repository_id", flat=True)) == {
        twins.github.repository_id
    }


def test_second_provider_delivery_needs_only_its_normalization(twins):
    sha = "e" * 40
    branch = f"{twins.key}/split"
    github_delivery = github_push(delivery_id="shared-delivery-id", sha="f" * 40, message=f"{twins.key}: GitHub")
    pushed, duplicate = other_delivery(
        delivery_id="shared-delivery-id",
        event_name="push",
        payload={
            "ref": f"refs/heads/{branch}",
            "deleted": False,
            "branch": branch_object(OTHER_URL, branch, sha),
            "commits": [commit_object(OTHER_URL, sha, f"{twins.key}: второй провайдер")],
        },
    )

    process_delivery(pushed.id)

    pushed.refresh_from_db()
    assert duplicate is False
    assert (pushed.provider, pushed.provider_installation_id, pushed.provider_repository_id) == (
        "gitea",
        INSTALLATION_ID,
        REPOSITORY_ID,
    )
    assert github_delivery.id != pushed.id
    assert pushed.status == PpmGitDeliveryStatus.PROCESSED
    assert sorted(objects_of(twins.other).values_list("object_type", flat=True)) == ["branch", "commit"]
    assert not objects_of(twins.github).exists()
    link = PpmGitLink.objects.get(work_item=twins.issue, object_type="commit")
    assert link.repository_id == twins.other.repository_id

    # A branch deletion event (Forgejo `delete`) is just another normalized ref update.
    deleted, _ = other_delivery(
        delivery_id="branch-deleted",
        event_name="delete",
        payload={
            "ref": f"refs/heads/{branch}",
            "deleted": True,
            "branch": branch_object(OTHER_URL, branch, "", deleted=True),
            "commits": [],
        },
    )
    process_delivery(deleted.id)

    deleted_branch = objects_of(twins.other).get(object_type="branch")
    assert (deleted_branch.state, deleted_branch.is_active) == ("deleted", False)
    assert PpmGitDelivery.objects.get(id=deleted.id).status == PpmGitDeliveryStatus.PROCESSED
    assert not objects_of(twins.github).exists()


def test_delivery_receipts_are_idempotent_per_provider(twins):
    payload = {"branch": branch_object(OTHER_URL, "main", "1" * 40), "commits": [], "ref": "refs/heads/main"}
    first, first_duplicate = other_delivery(delivery_id="receipt-1", event_name="push", payload=payload)
    again, again_duplicate = other_delivery(delivery_id="receipt-1", event_name="push", payload=payload)

    with pytest.raises(PpmGitError) as other_conflict:
        other_delivery(delivery_id="receipt-1", event_name="push", payload={**payload, "deleted": True})
    github_push(delivery_id="receipt-github", sha="2" * 40, message="GitHub")
    with pytest.raises(PpmGitError) as github_conflict:
        github_push(delivery_id="receipt-github", sha="3" * 40, message="GitHub, другое тело")

    assert (first_duplicate, again_duplicate, again.id) == (False, True, first.id)
    assert other_conflict.value.code == "GIT_DELIVERY_CONFLICT"
    assert other_conflict.value.status_code == status.HTTP_409_CONFLICT
    assert github_conflict.value.code == "GITHUB_DELIVERY_CONFLICT"
    assert PpmGitDelivery.objects.filter(provider_delivery_id="receipt-1").count() == 1


def test_github_repository_access_removal_is_scoped_to_github(twins):
    raw_body = json.dumps(
        {
            "action": "removed",
            "installation": {"id": INSTALLATION_ID},
            "repositories_added": [],
            "repositories_removed": [{"id": REPOSITORY_ID, "full_name": FULL_NAME}],
        }
    ).encode()
    delivery, _ = create_delivery(
        delivery_id="access-removed",
        event_name="installation_repositories",
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=parse_github_webhook(raw_body, event_name="installation_repositories"),
    )

    process_delivery(delivery.id)

    twins.github.refresh_from_db()
    twins.other.refresh_from_db()
    assert (twins.github.status, twins.github.last_error_code) == (
        "permission_drift",
        "GITHUB_REPOSITORY_ACCESS_REMOVED",
    )
    assert (twins.other.status, twins.other.last_error_code) == ("active", "")


def test_github_installation_revocation_is_scoped_to_github(twins):
    raw_body = json.dumps(
        {"action": "deleted", "installation": {"id": INSTALLATION_ID, "account": {"id": 71001, "login": "org"}}}
    ).encode()
    delivery, _ = create_delivery(
        delivery_id="installation-deleted",
        event_name="installation",
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=parse_github_webhook(raw_body, event_name="installation"),
    )

    process_delivery(delivery.id)

    twins.github.refresh_from_db()
    twins.other.refresh_from_db()
    assert (twins.github.status, twins.github.installation.status) == ("revoked", "revoked")
    assert (twins.other.status, twins.other.installation.status) == ("active", "active")


def test_normalized_connection_error_marks_only_that_provider_repository(twins, provider_registry):
    provider_registry(PpmGitProvider.GITEA, must_not_be_built)
    for connection in (twins.github, twins.other):
        enable_code_index(connection)
        ingest_code_snapshot(
            connection=connection,
            branch="main",
            commit_sha="4" * 40,
            files=[{"path": "src/app.py", "content": 'KEEP = "code"'}],
            dispatch=False,
        )
    sha = "5" * 40
    pushed, _ = other_delivery(
        delivery_id="before-removal",
        event_name="push",
        payload={"branch": branch_object(OTHER_URL, "main", sha), "commits": [], "ref": "refs/heads/main"},
    )
    process_delivery(pushed.id)
    invalid, _ = other_delivery(
        delivery_id="invalid-directive",
        event_name="repository",
        payload={"connection_error": {"code": "not a code", "message": "x"}},
    )
    removed, _ = other_delivery(
        delivery_id="repository-deleted",
        event_name="repository",
        payload={
            "action": "deleted",
            "connection_error": {
                "code": "GIT_REPOSITORY_DELETED",
                "message": "Репозиторий удалён на Git-сервере.",
                "purge_code": True,
            },
        },
    )

    process_delivery(invalid.id)
    twins.other.refresh_from_db()
    assert twins.other.status == "active"
    process_delivery(removed.id)

    removed.refresh_from_db()
    twins.github.refresh_from_db()
    twins.other.refresh_from_db()
    assert PpmGitDelivery.objects.get(id=invalid.id).status == PpmGitDeliveryStatus.IGNORED
    assert removed.status == PpmGitDeliveryStatus.PROCESSED
    assert (twins.other.status, twins.other.last_error_code, twins.other.last_error_message) == (
        "error",
        "GIT_REPOSITORY_DELETED",
        "Репозиторий удалён на Git-сервере.",
    )
    # History stays; the code index of that repository only is purged.
    assert objects_of(twins.other).filter(object_type="branch").exists()
    assert PpmGitCodeSnapshot.objects.get(repository_id=twins.other.repository_id).status == "revoked"
    assert PpmGitCodeSnapshot.objects.get(repository_id=twins.github.repository_id).status == "ready"
    assert (twins.github.status, twins.github.last_error_code) == ("active", "")


def test_delivery_failure_texts_follow_the_provider(twins):
    broken = {"branch": branch_object(OTHER_URL, "main", "6" * 40), "commits": 7, "ref": "refs/heads/main"}
    unknown_type = {"branch": {**branch_object(OTHER_URL, "main", "6" * 40), "object_type": "tag"}, "ref": "x"}
    other_broken, _ = other_delivery(delivery_id="broken", event_name="push", payload=broken)
    other_unknown, _ = other_delivery(delivery_id="unknown-type", event_name="push", payload=unknown_type)
    github_broken, _ = create_delivery(
        delivery_id="github-broken",
        event_name="push",
        raw_body_hash="0" * 64,
        normalized_payload={
            "event": "push",
            "installation_id": INSTALLATION_ID,
            "repository_id": REPOSITORY_ID,
            **broken,
        },
    )

    for delivery in (other_broken, other_unknown, github_broken):
        with pytest.raises(Exception):
            process_delivery(delivery.id)
        delivery.refresh_from_db()
        assert delivery.status == PpmGitDeliveryStatus.FAILED

    assert (other_broken.last_error_code, other_broken.last_error_message) == (
        "GIT_DELIVERY_FAILED",
        "Не удалось обработать событие Git-сервера.",
    )
    assert (other_unknown.last_error_code, other_unknown.last_error_message) == (
        "GIT_OBJECT_INVALID",
        "Git-сервер вернул неизвестный тип объекта.",
    )
    assert (github_broken.last_error_code, github_broken.last_error_message) == (
        "GITHUB_DELIVERY_FAILED",
        "Не удалось обработать событие GitHub.",
    )


# --- GitHub-only flows refuse another provider's installation or repository -----------------------------------------


@override_settings(PPM_GITHUB_APP_CONFIGURED=True)
def test_github_only_flows_refuse_another_provider_installation(twins, api_client):
    client = Mock()
    other_installation = twins.other.installation

    with pytest.raises(PpmGitError) as listed:
        list_github_repositories(installation=other_installation, client=client)
    with pytest.raises(PpmGitError) as refreshed:
        refresh_github_installation(installation=other_installation, user_id=twins.owner.id, client=client)
    with pytest.raises(PpmGitError) as connected:
        connect_github_repository(
            workspace_id=twins.workspace.id,
            project_id=twins.project.id,
            installation=other_installation,
            provider_repository_id=REPOSITORY_ID,
            user_id=twins.owner.id,
            client=client,
        )
    api_client.force_authenticate(user=twins.owner)
    base = f"/api/ppm/v1/workspaces/{twins.workspace.id}/projects/{twins.project.id}/git/providers/github"
    over_http = api_client.get(f"{base}/installations/{other_installation.id}/repositories/")

    assert {listed.value.code, refreshed.value.code, connected.value.code} == {"GITHUB_INSTALLATION_NOT_FOUND"}
    assert over_http.status_code == status.HTTP_404_NOT_FOUND
    assert over_http.data["error"]["code"] == "GITHUB_INSTALLATION_NOT_FOUND"
    assert client.mock_calls == []


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_git_write_actions_stay_github_only(twins, github):
    connections = PpmGitConnection.objects.select_related("repository", "installation").filter(
        project_id=twins.project.id
    )

    readiness = serialize_git_write_readiness(connections)
    with pytest.raises(PpmGitError) as refused:
        create_git_write_action_preview(
            workspace_id=twins.workspace.id,
            project_id=twins.project.id,
            payload={
                "action_type": "create_branch",
                "repository_id": str(twins.other.repository_id),
                "work_item_id": str(twins.issue.id),
                "base_ref": "main",
                "head_ref": f"{twins.key}/split",
                "title": f"{twins.key} — развести провайдеров",
                "client_operation_id": str(uuid.uuid4()),
            },
            user_id=twins.owner.id,
        )

    assert [item["connection_id"] for item in readiness["connections"]] == [str(twins.github.id)]
    assert refused.value.code == "GIT_WRITE_CONNECTION_REQUIRED"
    assert refused.value.status_code == status.HTTP_409_CONFLICT
    assert github.requests == []


# --- Fix round 1: a halting directive («repository deleted») stops synchronization until «Обновить» -------------------

HALT_CODE = "GIT_REPOSITORY_DELETED"
HALT_MESSAGE = "Репозиторий удалён на Git-сервере."


def apply_connection_error(delivery_id, *, halt_sync):
    directive = {"code": HALT_CODE, "message": HALT_MESSAGE}
    if halt_sync:
        directive["halt_sync"] = True
    delivery, _ = other_delivery(
        delivery_id=delivery_id,
        event_name="repository",
        payload={"action": "deleted", "connection_error": directive},
    )
    process_delivery(delivery.id)
    return PpmGitDelivery.objects.get(id=delivery.id)


def scheduled_reconciliation():
    """Runs the beat job (every 15 minutes in production) and returns the connection ids it queued."""
    with (
        patch("plane.ppm_git.tasks.reconcile_git_connection_task.delay") as enqueue,
        patch("plane.ppm_git.tasks.process_git_delivery_task.delay"),
    ):
        reconcile_active_git_connections()
    return {call.args[0] for call in enqueue.call_args_list}


def connection_url(twins, connection):
    return f"/api/ppm/v1/workspaces/{twins.workspace.id}/projects/{twins.project.id}/git/connections/{connection.id}/"


def test_halting_directive_stops_scheduled_and_retried_reconciliation(twins, provider_registry):
    github_client = RecordingClient(GITHUB_URL, "a", twins.key)
    provider_registry(PpmGitProvider.GITHUB, lambda: github_client)
    provider_registry(PpmGitProvider.GITEA, must_not_be_built)

    delivery = apply_connection_error("halt-scheduled", halt_sync=True)

    twins.other.refresh_from_db()
    assert delivery.status == PpmGitDeliveryStatus.PROCESSED
    assert (twins.other.status, twins.other.last_error_code, twins.other.last_error_message) == (
        "error",
        HALT_CODE,
        HALT_MESSAGE,
    )
    halt = twins.other.sync_cursor["halted"]
    assert halt["code"] == HALT_CODE and halt["at"].startswith("20")

    # (a) The scheduled job does not queue the halted connection; (d) GitHub with the same ids is queued as before.
    assert scheduled_reconciliation() == {str(twins.github.id)}
    # A retry or a sync queued before the halt never reaches the provider and keeps the directive's code and text.
    synchronize_connection(twins.other.id)
    twins.other.refresh_from_db()
    assert (twins.other.status, twins.other.last_error_code, twins.other.last_error_message) == (
        "error",
        HALT_CODE,
        HALT_MESSAGE,
    )
    assert twins.other.sync_cursor["halted"] == halt
    # Events for the halted repository are not applied either: «Обновить» + reconciliation recover them later.
    pushed, _ = other_delivery(
        delivery_id="push-while-halted",
        event_name="push",
        payload={"branch": branch_object(OTHER_URL, "main", "7" * 40), "commits": [], "ref": "refs/heads/main"},
    )
    process_delivery(pushed.id)
    twins.other.refresh_from_db()
    assert PpmGitDelivery.objects.get(id=pushed.id).status == PpmGitDeliveryStatus.IGNORED
    assert not objects_of(twins.other).exists()
    assert (twins.other.status, twins.other.last_error_code) == ("error", HALT_CODE)

    # (d) GitHub is neither halted nor held back.
    synchronize_connection(twins.github.id)
    twins.github.refresh_from_db()
    assert github_client.calls == [("sync_repository", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME)]
    assert (twins.github.status, twins.github.last_error_code) == ("active", "")
    assert "halted" not in twins.github.sync_cursor


def test_manual_refresh_lifts_the_halt_and_synchronizes(twins, provider_registry, api_client):
    other_client = RecordingClient(OTHER_URL, "b", twins.key)
    provider_registry(PpmGitProvider.GITEA, lambda: other_client)
    cursor = {"commits_since": "2026-09-28T09:55:00+00:00"}
    PpmGitConnection.objects.filter(id=twins.other.id).update(sync_cursor=cursor)
    apply_connection_error("halt-manual", halt_sync=True)
    api_client.force_authenticate(user=twins.owner)

    with patch("plane.ppm_git.views.reconcile_git_connection_task.delay") as enqueue:
        response = api_client.post(connection_url(twins, twins.other), format="json")
        github_response = api_client.post(connection_url(twins, twins.github), format="json")

    twins.other.refresh_from_db()
    assert response.status_code == github_response.status_code == status.HTTP_202_ACCEPTED
    assert [call.args[0] for call in enqueue.call_args_list] == [str(twins.other.id), str(twins.github.id)]
    # (b) «Обновить» lifts the halt and keeps the commit cursor; the audit names the lifted code.
    assert twins.other.sync_cursor == cursor
    audits = {
        audit.target_id: audit.metadata
        for audit in PpmGitAudit.objects.filter(project_id=twins.project.id, action="github.repository.sync")
    }
    # (d) The GitHub refresh audits exactly as before.
    assert audits == {twins.other.id: {"resumed_halt": HALT_CODE}, twins.github.id: {}}
    assert scheduled_reconciliation() == {str(twins.github.id), str(twins.other.id)}

    # The queued task synchronizes normally through the provider.
    synchronize_connection(twins.other.id)
    twins.other.refresh_from_db()
    assert other_client.calls == [("sync_repository", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME)]
    assert (twins.other.status, twins.other.last_error_code, twins.other.last_error_message) == ("active", "", "")
    assert sorted(objects_of(twins.other).values_list("object_type", flat=True)) == ["branch", "commit"]


def test_directive_without_halt_is_cleared_by_the_next_reconciliation(twins, provider_registry):
    other_client = RecordingClient(OTHER_URL, "b", twins.key)
    provider_registry(PpmGitProvider.GITEA, lambda: other_client)

    apply_connection_error("temporary-error", halt_sync=False)

    twins.other.refresh_from_db()
    assert (twins.other.status, twins.other.last_error_code) == ("error", HALT_CODE)
    assert "halted" not in twins.other.sync_cursor
    # (c) Documented: without `halt_sync` the error is temporary — the next scheduled reconciliation clears it.
    assert scheduled_reconciliation() == {str(twins.github.id), str(twins.other.id)}
    synchronize_connection(twins.other.id)
    twins.other.refresh_from_db()
    assert other_client.calls == [("sync_repository", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME)]
    assert (twins.other.status, twins.other.last_error_code, twins.other.last_error_message) == ("active", "", "")


def test_refresh_lifts_a_halt_that_landed_after_the_connection_was_read(twins, provider_registry):
    """G2.1 A2, пункт 0 (повторное ревью A1): «Обновить» проверяет остановку только под блокировкой строки.

    Представление читает подключение до вызова `resume_connection_sync`; остановка, пришедшая между чтением и снятием,
    не должна «съесть» нажатие — иначе поставленная сверка увидит маркер и ничего не сделает.
    """
    other_client = RecordingClient(OTHER_URL, "b", twins.key)
    provider_registry(PpmGitProvider.GITEA, lambda: other_client)
    read_before_halt = PpmGitConnection.objects.select_related("installation").get(id=twins.other.id)
    apply_connection_error("halt-after-read", halt_sync=True)

    resumed = resume_connection_sync(connection=read_before_halt, user_id=twins.owner.id)

    twins.other.refresh_from_db()
    assert resumed is not None and resumed["code"] == HALT_CODE
    assert "halted" not in twins.other.sync_cursor
    assert "halted" not in read_before_halt.sync_cursor
    # The queued synchronization reaches the provider normally.
    synchronize_connection(twins.other.id)
    twins.other.refresh_from_db()
    assert other_client.calls == [("sync_repository", INSTALLATION_ID, REPOSITORY_ID, FULL_NAME)]
    assert (twins.other.status, twins.other.last_error_code) == ("active", "")
    # A second press finds nothing to lift and changes nothing.
    assert resume_connection_sync(connection=read_before_halt, user_id=twins.owner.id) is None


@pytest.mark.parametrize("provider_fails", [False, True])
def test_halt_that_lands_during_a_sync_is_kept(twins, provider_registry, provider_fails):
    class HaltDuringSync(RecordingClient):
        def sync_repository(self, *args, **kwargs):
            # The «repository deleted» webhook is applied while PPM is still reading the provider.
            apply_connection_error("halt-during-sync", halt_sync=True)
            if provider_fails:
                raise PpmGitProviderError("GIT_REPOSITORY_NOT_FOUND", "Репозиторий не найден.", http_status=404)
            return super().sync_repository(*args, **kwargs)

    provider_registry(PpmGitProvider.GITEA, lambda: HaltDuringSync(OTHER_URL, "b", twins.key))

    if provider_fails:
        with pytest.raises(PpmGitProviderError):
            synchronize_connection(twins.other.id)
    else:
        synchronize_connection(twins.other.id)

    twins.other.refresh_from_db()
    assert (twins.other.status, twins.other.last_error_code, twins.other.last_error_message) == (
        "error",
        HALT_CODE,
        HALT_MESSAGE,
    )
    assert twins.other.sync_cursor["halted"]["code"] == HALT_CODE
    assert not objects_of(twins.other).exists()
    assert scheduled_reconciliation() == {str(twins.github.id)}
