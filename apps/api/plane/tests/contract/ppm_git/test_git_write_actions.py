import uuid

import pytest
from django.test import override_settings
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_git.models import (
    PpmGitAudit,
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitObject,
    PpmGitRepository,
    PpmGitWriteAction,
    PpmGitWriteActionStatus,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def git_write_project():
    owner = make_user("git-write-owner")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    project = ProjectFactory(workspace=workspace, identifier="GWA")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=owner,
    )
    issue = Issue(name="Подготовить безопасный Git write", project=project, state=state)
    issue.save(created_by_id=owner.id)
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider="github",
        provider_installation_id=81001,
        provider_account_id=71001,
        account_login="ppm-test-org",
        account_type="Organization",
        repository_selection="selected",
        permissions={"metadata": "read", "contents": "read", "pull_requests": "read"},
        events=["push", "pull_request"],
        created_by=owner.id,
        updated_by=owner.id,
    )
    repository = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name="PPM",
        normalized_name="ppm",
        provider="github",
        provider_repository_id=91001,
        provider_full_name="ppm-test-org/ppm",
        canonical_url="https://github.com/ppm-test-org/ppm",
        clone_https="https://github.com/ppm-test-org/ppm.git",
        clone_ssh="git@github.com:ppm-test-org/ppm.git",
        default_branch="main",
        visibility="private",
        is_default=True,
        created_by=owner.id,
        updated_by=owner.id,
    )
    connection = PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=repository.provider_repository_id,
        provider_full_name=repository.provider_full_name,
        permissions=installation.permissions,
        events=installation.events,
        created_by=owner.id,
        updated_by=owner.id,
    )
    return owner, workspace, project, issue, repository, connection


def write_actions_url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/write-actions/{suffix}"


def preview_payload(repository, issue, operation_id=None, **overrides):
    payload = {
        "repository_id": str(repository.id),
        "work_item_id": str(issue.id),
        "base_ref": "main",
        "head_ref": f"GWA-{issue.sequence_id}/safe-git-write",
        "title": f"GWA-{issue.sequence_id} — Безопасный Git write",
        "body": "## Что изменится\n\nВетка и draft PR будут созданы только после отдельного применения.",
        "client_operation_id": str(operation_id or uuid.uuid4()),
    }
    payload.update(overrides)
    return payload


def authenticate(api_client, user):
    api_client.force_authenticate(user=user)


def test_preview_is_exact_idempotent_and_never_mutates_provider_state(api_client, git_write_project):
    owner, workspace, project, issue, repository, _ = git_write_project
    authenticate(api_client, owner)
    operation_id = uuid.uuid4()
    payload = preview_payload(repository, issue, operation_id)

    created = api_client.post(write_actions_url(workspace, project), payload, format="json")
    replayed = api_client.post(write_actions_url(workspace, project), payload, format="json")
    reused = api_client.post(
        write_actions_url(workspace, project),
        {**payload, "title": "Другое предложение"},
        format="json",
    )

    assert created.status_code == status.HTTP_201_CREATED
    assert replayed.status_code == status.HTTP_200_OK
    assert replayed.data["id"] == created.data["id"]
    assert reused.status_code == status.HTTP_409_CONFLICT
    assert reused.data["error"]["code"] == "GIT_WRITE_OPERATION_REUSED"
    assert PpmGitWriteAction.objects.count() == 1
    assert PpmGitObject.objects.count() == 0
    assert created.data["status"] == "proposed"
    assert created.data["apply_available"] is False
    assert created.data["preview"] == {
        "repository": {
            "id": str(repository.id),
            "provider": "github",
            "name": "PPM",
            "full_name": "ppm-test-org/ppm",
            "canonical_url": "https://github.com/ppm-test-org/ppm",
        },
        "provider": {
            "connection_id": str(repository.connection.id),
            "account_login": "ppm-test-org",
            "permissions": {"metadata": "read", "contents": "read", "pull_requests": "read"},
            "write_ready": False,
        },
        "branch": {"base_ref": "main", "head_ref": f"GWA-{issue.sequence_id}/safe-git-write"},
        "draft_pull_request": {
            "title": f"GWA-{issue.sequence_id} — Безопасный Git write",
            "body": "## Что изменится\n\nВетка и draft PR будут созданы только после отдельного применения.",
            "is_draft": True,
        },
        "work_item": {
            "id": str(issue.id),
            "identifier": f"GWA-{issue.sequence_id}",
            "title": issue.name,
            "updated_at": issue.updated_at.isoformat(),
        },
        "safety": {
            "provider_write_performed": False,
            "merge_allowed": False,
            "message": "Это предварительный просмотр. GitHub не изменяется до отдельной команды применения.",
        },
    }
    assert set(PpmGitAudit.objects.values_list("action", flat=True)) == {
        "write_action.preview_created",
        "write_action.preview_replayed",
    }


def test_member_can_approve_or_reject_but_guest_cannot(api_client, git_write_project):
    owner, workspace, project, issue, repository, _ = git_write_project
    member = make_user("git-write-member")
    guest = make_user("git-write-guest")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)

    authenticate(api_client, member)
    first = api_client.post(write_actions_url(workspace, project), preview_payload(repository, issue), format="json")
    approved = api_client.post(
        write_actions_url(workspace, project, f"{first.data['id']}/decision/"),
        {"decision": "approve"},
        format="json",
    )
    approved_replay = api_client.post(
        write_actions_url(workspace, project, f"{first.data['id']}/decision/"),
        {"decision": "approve"},
        format="json",
    )
    second = api_client.post(write_actions_url(workspace, project), preview_payload(repository, issue), format="json")
    rejected = api_client.post(
        write_actions_url(workspace, project, f"{second.data['id']}/decision/"),
        {"decision": "reject"},
        format="json",
    )
    changed_decision = api_client.post(
        write_actions_url(workspace, project, f"{second.data['id']}/decision/"),
        {"decision": "approve"},
        format="json",
    )

    assert first.status_code == status.HTTP_201_CREATED
    assert approved.status_code == status.HTTP_200_OK
    assert approved.data["status"] == "approved"
    assert approved_replay.status_code == status.HTTP_200_OK
    assert rejected.status_code == status.HTTP_200_OK
    assert rejected.data["status"] == "rejected"
    assert changed_decision.status_code == status.HTTP_409_CONFLICT
    assert changed_decision.data["error"]["code"] == "GIT_WRITE_DECISION_FINAL"
    assert not PpmGitObject.objects.exists()

    authenticate(api_client, guest)
    denied = api_client.post(write_actions_url(workspace, project), preview_payload(repository, issue), format="json")
    assert denied.status_code == status.HTTP_403_FORBIDDEN
    assert PpmGitWriteAction.objects.count() == 2

    authenticate(api_client, owner)
    overview = api_client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/")
    assert overview.status_code == status.HTTP_200_OK
    assert overview.data["write_actions"]["apply_available"] is False
    assert overview.data["write_actions"]["provider_writes_enabled"] is False
    assert overview.data["write_actions"]["readiness"] == {
        "provider": "github",
        "flow": "branch_then_commit_then_draft_pr",
        "decision_status": "proposed",
        "required_permissions": {"metadata": "read", "contents": "write", "pull_requests": "write"},
        "provider_writes_enabled": False,
        "permission_ready": False,
        "apply_available": False,
        "blockers": [
            "OWNER_DECISION_REQUIRED",
            "APPLY_ENDPOINT_PENDING",
            "PROVIDER_WRITE_DISABLED",
            "GITHUB_PERMISSIONS_MISSING",
        ],
        "connections": [
            {
                "connection_id": str(repository.connection.id),
                "repository_id": str(repository.id),
                "repository_full_name": "ppm-test-org/ppm",
                "connection_status": "active",
                "current_permissions": {"metadata": "read", "contents": "read", "pull_requests": "read"},
                "missing_permissions": ["contents", "pull_requests"],
                "permission_ready": False,
            }
        ],
    }
    assert [item["status"] for item in overview.data["write_actions"]["items"]] == ["rejected", "approved"]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_write_readiness_keeps_apply_closed_after_scopes_are_ready(api_client, git_write_project):
    owner, workspace, project, _, _, connection = git_write_project
    connection.permissions = {"metadata": "read", "contents": "write", "pull_requests": "write"}
    connection.save(update_fields=["permissions", "updated_at"])
    authenticate(api_client, owner)

    response = api_client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/")

    assert response.status_code == status.HTTP_200_OK
    readiness = response.data["write_actions"]["readiness"]
    assert readiness["provider_writes_enabled"] is True
    assert readiness["permission_ready"] is True
    assert readiness["apply_available"] is False
    assert readiness["blockers"] == ["OWNER_DECISION_REQUIRED", "APPLY_ENDPOINT_PENDING"]
    assert readiness["connections"][0]["missing_permissions"] == []


def test_source_change_blocks_approval_without_partial_write(api_client, git_write_project):
    owner, workspace, project, issue, repository, _ = git_write_project
    authenticate(api_client, owner)
    preview = api_client.post(write_actions_url(workspace, project), preview_payload(repository, issue), format="json")
    issue.name = "Задача изменилась после preview"
    issue.save(update_fields=["name", "updated_at"])

    response = api_client.post(
        write_actions_url(workspace, project, f"{preview.data['id']}/decision/"),
        {"decision": "approve"},
        format="json",
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.data["error"]["code"] == "GIT_WRITE_SOURCE_CHANGED"
    action = PpmGitWriteAction.objects.get(id=preview.data["id"])
    assert action.status == PpmGitWriteActionStatus.CONFLICT
    assert action.error_code == "GIT_WRITE_SOURCE_CHANGED"
    assert not PpmGitObject.objects.exists()
    assert PpmGitAudit.objects.filter(action="write_action.conflict", target_id=action.id).exists()


@pytest.mark.parametrize(
    "head_ref",
    ["main", "bad branch", "../escape", "refs//heads", "feature.lock", "feature@{old}", "feature\\name"],
)
def test_preview_rejects_unsafe_or_conflicting_branch_names(api_client, git_write_project, head_ref):
    owner, workspace, project, issue, repository, _ = git_write_project
    authenticate(api_client, owner)

    response = api_client.post(
        write_actions_url(workspace, project),
        preview_payload(repository, issue, head_ref=head_ref),
        format="json",
    )

    assert response.status_code in {status.HTTP_400_BAD_REQUEST, status.HTTP_409_CONFLICT}
    assert response.data["error"]["code"] in {"GIT_WRITE_INVALID_REF", "GIT_WRITE_REF_CONFLICT"}
    assert not PpmGitWriteAction.objects.exists()
