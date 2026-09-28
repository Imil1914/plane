"""G2.1 R8 — сверка, индексация кода и автосвязь для подключений Forgejo через реестр провайдеров.

Forgejo не настроен → подключение получает `GIT_PROVIDER_NOT_CONFIGURED`, задача завершается без повторов; Forgejo
просит подождать (429/5xx) → ожидание, как у GitHub; подключения GitHub при этом не затрагиваются.
"""

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

from plane.db.models import Issue, State
from plane.ppm_git.code_indexing import synchronize_repository_code, update_code_index_policy
from plane.ppm_git.models import (
    PpmGitCodeIndexPolicy,
    PpmGitCodeSnapshot,
    PpmGitDelivery,
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitObject,
    PpmGitProvider,
    PpmGitRepository,
)
from plane.ppm_git.provider_services import (
    connect_forgejo_repository,
    create_delivery,
    process_delivery,
    synchronize_connection,
)
from plane.ppm_git.webhooks import body_sha256, parse_forgejo_webhook
from plane.ppm_git.providers.base import PpmGitProviderError, PpmGitProviderRateLimited
from plane.ppm_git.services import PpmGitError
from plane.ppm_git.tasks import (
    reconcile_active_git_connections,
    reconcile_git_connection_task,
    synchronize_git_code_task,
)
from plane.tests.contract.ppm_git.forgejo_fake import PUBLIC_URL, FakeRepository, FakeResponse, webhook_fixture
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

APP = f"{PUBLIC_URL}/team-alpha/app"
MAIN_HEAD = "097f3ee58ccd2e6259bf755652b9420ac28bf9bc"


class GitHubTwin:
    """GitHub answers for the GitHub connection of the same project."""

    def __init__(self):
        self.calls = 0

    def sync_repository(self, installation_id, repository_id, full_name, *, since=None):
        self.calls += 1
        return {"branches": [], "commits": [], "pull_requests": []}


@pytest.fixture
def project_with_both(forgejo, provider_registry):
    """Project KEY (tasks KEY-1…KEY-5) with team-alpha/app on the Git server and a GitHub repository next to it."""
    marker = uuid.uuid4().hex
    owner = UserFactory(username=f"sync-{marker}", email=f"sync-{marker}@plane.test")
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
    _, forgejo_connection = connect_forgejo_repository(
        workspace_id=workspace.id, project_id=project.id, provider_repository_id=1, user_id=owner.id
    )
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider="github",
        provider_installation_id=81001,
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
        name="github",
        normalized_name="github",
        provider="github",
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm",
        canonical_url="https://github.com/ppm-test-org/ppm",
        clone_https="https://github.com/ppm-test-org/ppm.git",
        created_by=owner.id,
        updated_by=owner.id,
    )
    github_connection = PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm",
        created_by=owner.id,
        updated_by=owner.id,
    )
    github = GitHubTwin()
    provider_registry(PpmGitProvider.GITHUB, lambda **kwargs: github)
    forgejo.requests.clear()
    return owner, issues, forgejo_connection, github_connection, github


def objects_of(connection):
    return PpmGitObject.objects.filter(repository_id=connection.repository_id)


def test_initial_synchronization_goes_through_the_registry_and_links_by_key(project_with_both, forgejo):
    _, issues, connection, _, _ = project_with_both

    synchronize_connection(connection.id)

    connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("active", "")
    assert connection.last_sync_at is not None and "commits_since" in connection.sync_cursor
    objects = objects_of(connection)
    assert sorted(objects.filter(object_type="branch").values_list("provider_object_id", flat=True)) == [
        "KEY-4/docs",
        "KEY-5/bulk",
        "main",
    ]
    assert objects.filter(object_type="commit").count() == 8
    pulls = {item.ref: item for item in objects.filter(object_type="pull_request")}
    assert (pulls["1"].state, pulls["1"].provider_merged_at.isoformat()) == ("merged", "2026-09-28T13:21:05+00:00")
    assert (pulls["2"].state, pulls["2"].is_draft, pulls["2"].head_ref) == ("closed", True, "KEY-3/wip")
    assert pulls["3"].state == "open"
    assert all(item.canonical_url.startswith(f"{APP}/") for item in objects)
    linked = {
        number: set(
            PpmGitLink.objects.filter(work_item=issues[number], status="active").values_list("object_type", flat=True)
        )
        for number in issues
    }
    assert linked[1] == {"commit"}
    assert linked[2] == {"commit", "pull_request"}
    assert linked[4] == {"branch", "commit", "pull_request"}
    assert linked[5] == {"branch", "commit"}
    assert {path for path, _ in forgejo.requests} >= {
        "/repositories/1",
        "/repos/team-alpha/app/branches",
        "/repos/team-alpha/app/commits",
        "/repos/team-alpha/app/pulls",
    }

    # The next synchronization reads the commit listing only down to its cursor.
    forgejo.requests.clear()
    new_head = forgejo.commit_on("main", "KEY-3: новый коммит после сверки", date=timezone.now().isoformat())
    synchronize_connection(connection.id)
    assert objects_of(connection).filter(provider_object_id=new_head, object_type="commit").exists()
    assert [params["page"] for path, params in forgejo.requests if path.endswith("/commits")] == [1]
    assert PpmGitLink.objects.filter(work_item=issues[3], object_type="commit", status="active").exists()


def test_a_branch_gone_from_forgejo_is_marked_deleted(project_with_both, forgejo):
    _, _, connection, _, _ = project_with_both
    synchronize_connection(connection.id)

    forgejo.delete_branch("KEY-4/docs")
    synchronize_connection(connection.id)

    branch = objects_of(connection).get(object_type="branch", provider_object_id="KEY-4/docs")
    assert (branch.state, branch.is_active) == ("deleted", False)
    # The open PR of the deleted branch keeps its branch name (Forgejo's `head.label`).
    assert objects_of(connection).get(object_type="pull_request", ref="3").head_ref == "KEY-4/docs"


def test_unconfigured_git_server_is_recorded_without_retries_and_github_goes_on(project_with_both, forgejo, settings):
    _, _, connection, github_connection, github = project_with_both
    settings.PPM_FORGEJO_TOKEN = ""

    # The Celery task body: no retry (it would only fail the same way until the settings change).
    reconcile_git_connection_task.run(str(connection.id))
    reconcile_git_connection_task.run(str(github_connection.id))

    connection.refresh_from_db()
    github_connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("error", "GIT_PROVIDER_NOT_CONFIGURED")
    assert (github_connection.status, github.calls) == ("active", 1)
    assert forgejo.requests == []
    # The scheduled reconciliation keeps looking (the error is not a halt) and never breaks the queue.
    with patch("plane.ppm_git.tasks.reconcile_git_connection_task.delay") as enqueue:
        reconcile_active_git_connections()
    assert {call.args[0] for call in enqueue.call_args_list} == {str(connection.id), str(github_connection.id)}

    settings.PPM_FORGEJO_TOKEN = "fake-forgejo-read-token-0000000000000001"
    synchronize_connection(connection.id)
    connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("active", "")


def test_unconfigured_git_server_stops_code_indexing_without_retries(project_with_both, forgejo, settings):
    owner, _, connection, _, _ = project_with_both
    PpmGitCodeIndexPolicy.objects.create(
        workspace_id=connection.workspace_id,
        project_id=connection.project_id,
        repository=connection.repository,
        enabled=True,
        branch="main",
        updated_by=owner.id,
    )
    settings.PPM_FORGEJO_URL = ""

    assert synchronize_git_code_task.run(str(connection.repository_id)) is None
    with pytest.raises(PpmGitProviderError) as exc_info:
        synchronize_repository_code(connection.repository_id, dispatch=False)
    assert exc_info.value.code == "GIT_PROVIDER_NOT_CONFIGURED"


@pytest.mark.parametrize(
    ("response", "status_after", "code", "wait"),
    [
        (
            FakeResponse(429, {"message": "slow down"}, {"Retry-After": "120"}),
            "rate_limited",
            "GIT_PROVIDER_RATE_LIMITED",
            120,
        ),
        (FakeResponse(503, None), "rate_limited", "GIT_PROVIDER_RATE_LIMITED", 60),
        (FakeResponse(500, {"message": "boom"}), "error", "GIT_PROVIDER_UNAVAILABLE", None),
    ],
)
def test_forgejo_asking_to_wait_or_failing_does_not_touch_github(
    project_with_both, forgejo, response, status_after, code, wait
):
    _, _, connection, github_connection, github = project_with_both
    forgejo.inject(r"/repositories/1$", response)
    before = timezone.now()

    with pytest.raises(PpmGitProviderError) as exc_info:
        synchronize_connection(connection.id)
    synchronize_connection(github_connection.id)

    connection.refresh_from_db()
    github_connection.refresh_from_db()
    assert isinstance(exc_info.value, PpmGitProviderRateLimited) is (status_after == "rate_limited")
    assert (connection.status, connection.last_error_code) == (status_after, code)
    if wait:
        assert (
            before + timedelta(seconds=wait - 5) <= connection.retry_after <= timezone.now() + timedelta(seconds=wait)
        )
    else:
        assert connection.retry_after is None
    assert (github_connection.status, github_connection.last_error_code, github.calls) == ("active", "", 1)


def test_code_is_indexed_through_forgejo_with_forgejo_file_links(project_with_both, forgejo):
    owner, _, connection, _, _ = project_with_both
    PpmGitCodeIndexPolicy.objects.create(
        workspace_id=connection.workspace_id,
        project_id=connection.project_id,
        repository=connection.repository,
        enabled=True,
        branch="main",
        updated_by=owner.id,
    )

    snapshot = synchronize_repository_code(connection.repository_id, dispatch=False)

    files = {item.path: item for item in snapshot.files.all()}
    assert (snapshot.status, snapshot.commit_sha, snapshot.branch) == ("ready", MAIN_HEAD, "main")
    assert set(files) == {"README.md", "src/limits.py", "src/login.py", "src/sensor.py"}
    assert files["src/sensor.py"].content_text == "def read_sensor():\n    return 42\n"
    assert files["src/sensor.py"].canonical_url == f"{APP}/src/commit/{MAIN_HEAD}/src/sensor.py"
    blob_requests = [path for path, _ in forgejo.requests if "/git/blobs/" in path]
    assert len(blob_requests) == 4


def test_code_index_policy_speaks_of_the_git_server_for_forgejo(project_with_both):
    owner, _, connection, github_connection, _ = project_with_both
    PpmGitConnection.objects.filter(id__in=[connection.id, github_connection.id]).update(status="error")

    with pytest.raises(PpmGitError) as forgejo_error:
        update_code_index_policy(
            repository=PpmGitRepository.objects.get(id=connection.repository_id),
            payload={"enabled": True},
            user_id=owner.id,
        )
    with pytest.raises(PpmGitError) as github_error:
        update_code_index_policy(
            repository=PpmGitRepository.objects.get(id=github_connection.repository_id),
            payload={"enabled": True},
            user_id=owner.id,
        )

    assert forgejo_error.value.code == github_error.value.code == "CODE_INDEX_CONNECTION_REQUIRED"
    assert "GitHub" not in forgejo_error.value.message
    assert (
        github_error.value.message
        == "Для индексации кода нужен активный GitHub App и доступ к содержимому репозитория."
    )


# --- fix round 1: empty repositories, repositories without pull requests, a name taken by another repository ----------


def connect_extra(project_with_both, repository):
    owner, _, connection, _, _ = project_with_both
    return connect_forgejo_repository(
        workspace_id=connection.workspace_id,
        project_id=connection.project_id,
        provider_repository_id=repository.id,
        user_id=owner.id,
    )[1]


def deliver_first_push(repository_id, full_name):
    """The live first push into a repository (recorded on team-alpha/app), re-addressed to ``full_name``."""
    event, raw_body = webhook_fixture("push_main_initial")
    body = json.loads(raw_body.decode().replace("team-alpha/app", full_name))
    body["repository"]["id"] = repository_id
    raw_body = json.dumps(body).encode()
    delivery, _ = create_delivery(
        provider="forgejo",
        delivery_id=f"first-push-{repository_id}",
        event_name=event,
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=parse_forgejo_webhook(raw_body, event_name=event),
    )
    process_delivery(delivery.id)
    return PpmGitDelivery.objects.get(id=delivery.id)


def test_an_empty_repository_syncs_and_its_first_push_brings_the_objects(project_with_both, forgejo):
    _, issues, _, _, _ = project_with_both
    fresh = forgejo.add_repository(FakeRepository(id=8, owner="team-alpha", name="fresh"))
    connection = connect_extra(project_with_both, fresh)
    forgejo.requests.clear()

    # The first synchronization right after «created → connected»: the Celery task body, no retry, no error.
    reconcile_git_connection_task.run(str(connection.id))

    connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("active", "")
    assert connection.last_sync_at is not None
    assert not objects_of(connection).exists()
    assert forgejo.paths() == ["/repositories/8"]

    # The first push: Forgejo sends it at once, the next reconciliation reads the repository as usual.
    forgejo.commit_on("main", "KEY-3: первый коммит нового репозитория", repository=fresh)
    delivery = deliver_first_push(8, "team-alpha/fresh")
    assert delivery.status == "processed"
    assert sorted(objects_of(connection).values_list("object_type", flat=True)) == ["branch", "commit", "commit"]
    assert PpmGitLink.objects.filter(work_item=issues[1], repository_id=connection.repository_id).exists()
    synchronize_connection(connection.id)
    connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("active", "")
    assert objects_of(connection).filter(title="KEY-3: первый коммит нового репозитория").exists()
    assert PpmGitLink.objects.filter(work_item=issues[3], repository_id=connection.repository_id).exists()


@pytest.mark.parametrize("kind", ["pull_requests_off", "mirror"])
def test_a_repository_without_pull_requests_synchronizes(project_with_both, forgejo, kind):
    other = forgejo.add_repository(
        FakeRepository(
            id=9,
            owner="team-alpha",
            name=kind.replace("_", "-"),
            has_pull_requests=kind != "pull_requests_off",
            mirror=kind == "mirror",
        )
    )
    forgejo.commit_on("main", "KEY-4: код без запросов на слияние", repository=other)
    connection = connect_extra(project_with_both, other)
    forgejo.requests.clear()

    reconcile_git_connection_task.run(str(connection.id))

    connection.refresh_from_db()
    assert (connection.status, connection.last_error_code) == ("active", "")
    assert sorted(objects_of(connection).values_list("object_type", flat=True)) == ["branch", "commit"]
    assert not any(path.endswith("/pulls") for path in forgejo.paths())


def enable_index(owner, connection, branch="main"):
    return PpmGitCodeIndexPolicy.objects.create(
        workspace_id=connection.workspace_id,
        project_id=connection.project_id,
        repository=connection.repository,
        enabled=True,
        branch=branch,
        updated_by=owner.id,
    )


@pytest.mark.parametrize("noticed_by", ["reconciliation", "code_index"])
def test_a_name_taken_by_another_repository_is_never_read_and_the_index_is_dropped(
    project_with_both, forgejo, noticed_by
):
    """team-alpha/app (id 1) is renamed and a different repository takes the old name: PPM reads nothing of it, and the
    code of the connected repository leaves search and AI answers (the links would now lead to the other one)."""
    owner, _, connection, _, _ = project_with_both
    enable_index(owner, connection)
    indexed = synchronize_repository_code(connection.repository_id, dispatch=False)
    assert indexed.status == "ready" and indexed.files.exists()
    forgejo.repository().name = "app-old"
    other = forgejo.add_repository(FakeRepository(id=7, owner="team-alpha", name="app"))
    forgejo.commit_on("main", "init", repository=other, files={"SECRET.md": b"other repository content\n"})
    forgejo.requests.clear()

    with pytest.raises(PpmGitProviderError) as exc_info:
        if noticed_by == "reconciliation":
            synchronize_connection(connection.id)
        else:
            synchronize_repository_code(connection.repository_id, dispatch=False)

    assert exc_info.value.code == "GIT_REPOSITORY_MOVED"
    # Only the check of the connected id: nothing is read under the old name.
    assert forgejo.paths() == ["/repositories/1"]
    snapshot = PpmGitCodeSnapshot.objects.get(id=indexed.id)
    assert (snapshot.status, snapshot.is_current, snapshot.files.exists()) == ("revoked", False, False)
    assert not PpmGitCodeSnapshot.objects.filter(repository_id=connection.repository_id, status="ready").exists()
    if noticed_by == "reconciliation":
        connection.refresh_from_db()
        assert (connection.status, connection.last_error_code) == ("error", "GIT_REPOSITORY_MOVED")
    # Retrying cannot help until an administrator connects the repository again: no retries (the scheduled
    # reconciliation still looks every 15 minutes).
    assert synchronize_git_code_task.run(str(connection.repository_id)) is None
    assert reconcile_git_connection_task.run(str(connection.id)) is None
    assert not any(path.startswith("/repos/team-alpha/app/") for path in forgejo.paths())


def test_the_code_index_of_an_empty_repository_waits_for_the_first_push(project_with_both, forgejo):
    owner, _, _, _, _ = project_with_both
    fresh = forgejo.add_repository(FakeRepository(id=8, owner="team-alpha", name="fresh"))
    connection = connect_extra(project_with_both, fresh)
    enable_index(owner, connection)
    forgejo.requests.clear()

    assert synchronize_git_code_task.run(str(connection.repository_id)) is None
    with pytest.raises(PpmGitProviderError) as exc_info:
        synchronize_repository_code(connection.repository_id, dispatch=False)

    assert exc_info.value.code == "GIT_REPOSITORY_EMPTY"
    assert set(forgejo.paths()) == {"/repositories/8"}
    assert not PpmGitCodeSnapshot.objects.filter(repository_id=connection.repository_id).exists()
