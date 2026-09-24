import uuid
from unittest.mock import patch

import pytest
from rest_framework import status

from plane.ppm_brain.answers import create_answer_run, process_answer_run
from plane.ppm_brain.models import PpmIndexJob, PpmKnowledgeIndexState, PpmKnowledgeSourceType
from plane.ppm_brain.services import exclude_source, process_index_job, request_source_index, retrieve_chunks
from plane.ppm_git.code_indexing import ingest_code_snapshot, synchronize_repository_code, update_code_index_policy
from plane.ppm_git.models import (
    PpmGitCodeFile,
    PpmGitCodeIndexPolicy,
    PpmGitCodeSnapshotStatus,
    PpmGitConnection,
    PpmGitConnectionStatus,
    PpmGitAudit,
    PpmGitInstallation,
    PpmGitRepository,
)
from plane.ppm_git.provider_services import disconnect_github_connection
from plane.ppm_git.services import PpmGitError
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def code_project():
    marker = uuid.uuid4().hex
    user = UserFactory(username=f"code-{marker}", email=f"code-{marker}@plane.test")
    workspace = WorkspaceFactory(owner=user)
    WorkspaceMemberFactory(workspace=workspace, member=user, role=20)
    project = ProjectFactory(workspace=workspace, identifier="CODE")
    ProjectMemberFactory(workspace=workspace, project=project, member=user, role=20)
    repository = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name="PPM",
        normalized_name="ppm",
        provider="github",
        provider_repository_id=1001,
        provider_full_name="ppm/ppm",
        canonical_url="https://github.com/ppm/ppm",
        clone_https="https://github.com/ppm/ppm.git",
        default_branch="main",
        visibility="private",
        is_default=True,
        created_by=user.id,
        updated_by=user.id,
    )
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=2001,
        provider_account_id=3001,
        account_login="ppm",
        created_by=user.id,
        updated_by=user.id,
    )
    connection = PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=1001,
        provider_full_name="ppm/ppm",
        created_by=user.id,
        updated_by=user.id,
    )
    policy = PpmGitCodeIndexPolicy.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        repository=repository,
        enabled=True,
        branch="main",
        include_paths=["src/**"],
        exclude_paths=["src/generated/**"],
        updated_by=user.id,
    )
    return user, workspace, project, repository, connection, policy


def test_code_snapshot_filters_secrets_and_keeps_exact_commit_path_lines(code_project):
    user, workspace, project, repository, connection, _ = code_project
    lines = [f"value_{number} = {number}" for number in range(1, 101)]
    lines[84] = 'RETRIEVAL-CODE-MARKER = "verified"'
    snapshot = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="a" * 40,
        dispatch=False,
        files=[
            {"path": "src/app.py", "content": "\n".join(lines)},
            {"path": "src/generated/client.ts", "content": "generated marker"},
            {"path": "src/secret.ts", "content": 'const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";'},
            {"path": "node_modules/pkg/index.js", "content": "vendor marker"},
            {"path": "src/image.png", "content": b"\x00\x01binary"},
            {"path": ".env", "content": "TOKEN=secret"},
        ],
    )

    assert snapshot.status == PpmGitCodeSnapshotStatus.READY
    assert snapshot.file_count == 1
    assert snapshot.excluded_stats == {
        "secret_or_lockfile": 1,
        "secret_detected": 1,
        "unsupported_or_binary": 1,
        "vendor_or_generated": 2,
    }
    code_file = PpmGitCodeFile.objects.get(snapshot=snapshot)
    job = PpmIndexJob.objects.get(
        source__source_type=PpmKnowledgeSourceType.GIT_CODE, source__source_id=str(code_file.id)
    )
    process_index_job(job.id)

    results = retrieve_chunks(
        workspace_id=workspace.id,
        project_id=project.id,
        query="RETRIEVAL-CODE-MARKER verified",
    )

    assert results[0]["source_type"] == PpmKnowledgeSourceType.GIT_CODE
    assert results[0]["source_version"].startswith("a" * 40)
    assert results[0]["locator"] == {
        "kind": "git_code",
        "repository_id": str(repository.id),
        "repository_name": "ppm/ppm",
        "branch": "main",
        "commit_sha": "a" * 40,
        "path": "src/app.py",
        "language": "python",
        "line_start": 71,
        "line_end": 100,
        "canonical_url": f"https://github.com/ppm/ppm/blob/{'a' * 40}/src/app.py#L71-L100",
    }

    run, _ = create_answer_run(
        workspace_id=workspace.id,
        project_id=project.id,
        user_id=user.id,
        query="RETRIEVAL-CODE-MARKER verified",
        client_operation_id=uuid.uuid4(),
    )
    completed = process_answer_run(run.id)
    assert completed.citations_json[0]["source_url"].endswith("/src/app.py#L71-L100")


def test_code_index_remains_readable_while_connection_is_syncing(code_project):
    _, workspace, project, _, connection, _ = code_project
    snapshot = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="f" * 40,
        dispatch=False,
        files=[{"path": "src/app.py", "content": 'SYNCING-CODE-MARKER = "available"'}],
    )
    code_file = snapshot.files.get()
    connection.status = PpmGitConnectionStatus.SYNCING
    connection.save(update_fields=["status", "updated_at"])

    job = PpmIndexJob.objects.get(
        source__source_type=PpmKnowledgeSourceType.GIT_CODE,
        source__source_id=str(code_file.id),
    )
    process_index_job(job.id)

    assert retrieve_chunks(
        workspace_id=workspace.id,
        project_id=project.id,
        query="SYNCING-CODE-MARKER available",
    )


def test_deleted_code_source_can_be_reindexed_at_same_version(code_project):
    _, workspace, project, _, connection, _ = code_project
    snapshot = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="1" * 40,
        dispatch=False,
        files=[{"path": "src/app.py", "content": 'RECOVERED-CODE-MARKER = "ready"'}],
    )
    code_file = snapshot.files.get()
    source, original_job = request_source_index(
        workspace_id=workspace.id,
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.GIT_CODE,
        source_id=code_file.id,
        dispatch=False,
    )
    exclude_source(
        workspace_id=workspace.id,
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.GIT_CODE,
        source_id=code_file.id,
        deleted=True,
        code="SOURCE_NOT_FOUND",
    )
    original_job.refresh_from_db()

    recovered_source, recovered_job = request_source_index(
        workspace_id=workspace.id,
        project_id=project.id,
        source_type=PpmKnowledgeSourceType.GIT_CODE,
        source_id=code_file.id,
        dispatch=False,
    )
    process_index_job(recovered_job.id)
    recovered_source.refresh_from_db()

    assert recovered_source.index_state == PpmKnowledgeIndexState.READY
    assert retrieve_chunks(
        workspace_id=workspace.id,
        project_id=project.id,
        query="RECOVERED-CODE-MARKER ready",
    )


def test_force_push_and_policy_revoke_purge_derived_code(code_project):
    user, workspace, project, repository, connection, _ = code_project
    first = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="b" * 40,
        files=[{"path": "src/app.py", "content": 'MARKER-OLD = "old"'}],
        dispatch=False,
    )
    first_file = first.files.get()
    process_index_job(
        PpmIndexJob.objects.get(
            source__source_type=PpmKnowledgeSourceType.GIT_CODE,
            source__source_id=str(first_file.id),
        ).id
    )

    second = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="c" * 40,
        files=[{"path": "src/app.py", "content": 'MARKER-NEW = "new"'}],
        dispatch=False,
    )
    second_file = second.files.get()
    process_index_job(
        PpmIndexJob.objects.get(
            source__source_type=PpmKnowledgeSourceType.GIT_CODE,
            source__source_id=str(second_file.id),
        ).id
    )
    first.refresh_from_db()

    assert first.status == PpmGitCodeSnapshotStatus.SUPERSEDED
    assert first.is_current is False
    assert not PpmGitCodeFile.objects.filter(id=first_file.id).exists()
    assert not retrieve_chunks(workspace_id=workspace.id, project_id=project.id, query="MARKER-OLD")
    assert retrieve_chunks(workspace_id=workspace.id, project_id=project.id, query="MARKER-NEW")

    update_code_index_policy(repository=repository, payload={"enabled": False}, user_id=user.id)
    second.refresh_from_db()
    old_source = PpmIndexJob.objects.get(
        source__source_type=PpmKnowledgeSourceType.GIT_CODE,
        source__source_id=str(second_file.id),
    ).source
    old_source.refresh_from_db()

    assert second.status == PpmGitCodeSnapshotStatus.REVOKED
    assert not PpmGitCodeFile.objects.filter(id=second_file.id).exists()
    assert old_source.index_state == PpmKnowledgeIndexState.DELETED
    assert not retrieve_chunks(workspace_id=workspace.id, project_id=project.id, query="MARKER-NEW")


def test_stale_code_worker_cannot_restore_index_after_disconnect(code_project):
    user, _, _, repository, stale_connection, _ = code_project
    PpmGitConnection.objects.filter(id=stale_connection.id).update(status=PpmGitConnectionStatus.DISCONNECTED)

    with pytest.raises(PpmGitError, match="Подключение Git provider неактивно"):
        ingest_code_snapshot(
            connection=stale_connection,
            branch="main",
            commit_sha="9" * 40,
            files=[{"path": "src/app.py", "content": 'STALE-WORKER = "must-not-return"'}],
            dispatch=False,
        )

    assert not PpmGitCodeFile.objects.filter(repository=repository).exists()

    PpmGitConnection.objects.filter(id=stale_connection.id).update(status=PpmGitConnectionStatus.ACTIVE)
    snapshot = ingest_code_snapshot(
        connection=stale_connection,
        branch="main",
        commit_sha="8" * 40,
        files=[{"path": "src/app.py", "content": 'STALE-WORKER = "repair"'}],
        dispatch=False,
    )
    PpmGitConnection.objects.filter(id=stale_connection.id).update(status=PpmGitConnectionStatus.DISCONNECTED)
    disconnect_github_connection(connection=stale_connection, user_id=user.id)
    snapshot.refresh_from_db()

    assert snapshot.status == PpmGitCodeSnapshotStatus.REVOKED
    assert snapshot.is_current is False
    assert not PpmGitCodeFile.objects.filter(repository=repository).exists()


def test_code_index_isolated_from_other_project(code_project):
    _, workspace, project, _, connection, _ = code_project
    snapshot = ingest_code_snapshot(
        connection=connection,
        branch="main",
        commit_sha="d" * 40,
        files=[{"path": "src/app.py", "content": 'PROJECT-PRIVATE-CODE = "secretless"'}],
        dispatch=False,
    )
    code_file = snapshot.files.get()
    process_index_job(
        PpmIndexJob.objects.get(
            source__source_type=PpmKnowledgeSourceType.GIT_CODE,
            source__source_id=str(code_file.id),
        ).id
    )
    foreign_project = ProjectFactory(workspace=workspace, identifier="OTHER")

    assert retrieve_chunks(
        workspace_id=workspace.id,
        project_id=project.id,
        query="PROJECT-PRIVATE-CODE",
    )
    assert not retrieve_chunks(
        workspace_id=workspace.id,
        project_id=foreign_project.id,
        query="PROJECT-PRIVATE-CODE",
    )


def test_code_index_policy_api_is_opt_in_audited_and_manager_only(
    api_client, code_project, django_capture_on_commit_callbacks
):
    user, workspace, project, repository, _, policy = code_project
    policy.enabled = False
    policy.save(update_fields=["enabled", "updated_at"])
    member = UserFactory(username=f"member-{uuid.uuid4().hex}", email=f"member-{uuid.uuid4().hex}@plane.test")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    endpoint = (
        f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/repositories/{repository.id}/code-index/"
    )

    api_client.force_authenticate(user=member)
    denied = api_client.patch(endpoint, {"enabled": True, "branch": "main"}, format="json")
    api_client.force_authenticate(user=user)
    with (
        patch("plane.ppm_git.views.synchronize_git_code_task.delay") as dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        enabled = api_client.patch(
            endpoint,
            {
                "enabled": True,
                "branch": "main",
                "include_paths": ["src/**"],
                "exclude_paths": ["src/generated/**"],
            },
            format="json",
        )

    assert denied.status_code == status.HTTP_403_FORBIDDEN
    assert enabled.status_code == status.HTTP_200_OK
    assert enabled.data["enabled"] is True
    assert enabled.data["branch"] == "main"
    assert enabled.data["limits"]["max_file_bytes"] == 512 * 1024
    dispatch.assert_called_once_with(str(repository.id))
    assert PpmGitAudit.objects.filter(
        project_id=project.id,
        action="code_index.policy.update",
        target_id=repository.id,
    ).exists()


def test_provider_sync_fetches_only_safe_allowlisted_blobs(code_project):
    _, _, _, repository, _, _ = code_project

    class SafeCodeClient:
        requested_files = []

        def get_code_tree(self, installation_id, repository_id, full_name, ref):
            assert installation_id == 2001
            assert repository_id == 1001
            assert full_name == "ppm/ppm"
            assert ref == "main"
            return {
                "commit_sha": "e" * 40,
                "files": [
                    {"path": "src/app.py", "sha": "safe", "size": 28},
                    {"path": "src/generated/client.ts", "sha": "generated", "size": 20},
                    {"path": "node_modules/pkg/index.js", "sha": "vendor", "size": 20},
                    {"path": "src/archive.zip", "sha": "binary", "size": 20},
                    {"path": "src/unknown.py", "sha": "unknown-size", "size": None},
                    {"path": "src/huge.py", "sha": "huge", "size": 600 * 1024},
                ],
            }

        def get_code_blobs(self, installation_id, repository_id, full_name, files):
            self.requested_files = files
            return {"safe": b'PROVIDER-SAFE-MARKER = "ok"'}

    client = SafeCodeClient()
    snapshot = synchronize_repository_code(repository.id, client=client, dispatch=False)

    assert client.requested_files == [{"path": "src/app.py", "sha": "safe", "size": 28}]
    assert snapshot.status == PpmGitCodeSnapshotStatus.READY
    assert list(snapshot.files.values_list("path", flat=True)) == ["src/app.py"]
