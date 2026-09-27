import uuid

import pytest
from django.test import override_settings
from rest_framework import status

from plane.ppm_git.models import (
    PpmGitAudit,
    PpmGitObject,
    PpmGitWriteAction,
    PpmGitWriteActionStatus,
)
from plane.tests.factories import (
    ProjectMemberFactory,
    UserFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


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


def test_preview_is_exact_idempotent_and_never_mutates_provider_state(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, _ = git_write_project
    authenticate(api_client, owner)
    operation_id = uuid.uuid4()
    payload = preview_payload(repository, issue, operation_id)

    created = api_client.post(write_actions_url(workspace, project), payload, format="json")
    requests_after_preview = len(github.requests)
    replayed = api_client.post(write_actions_url(workspace, project), payload, format="json")
    reused = api_client.post(
        write_actions_url(workspace, project),
        {**payload, "title": "Другое предложение"},
        format="json",
    )

    assert created.status_code == status.HTTP_201_CREATED
    assert replayed.status_code == status.HTTP_200_OK
    assert replayed.data["id"] == created.data["id"]
    # The replay returns the stored preview without asking GitHub again.
    assert len(github.requests) == requests_after_preview
    assert reused.status_code == status.HTTP_409_CONFLICT
    assert reused.data["error"]["code"] == "GIT_WRITE_OPERATION_REUSED"
    assert PpmGitWriteAction.objects.count() == 1
    assert PpmGitObject.objects.count() == 0
    assert github.write_requests() == []
    assert all(body["permissions"] == {"contents": "read", "pull_requests": "read"} for body in github.token_requests())
    assert created.data["status"] == "proposed"
    assert created.data["action_type"] == "create_branch"
    assert created.data["apply_available"] is False
    base_sha = github.branches["main"]
    head_ref = f"GWA-{issue.sequence_id}/safe-git-write"
    assert created.data["preview"] == {
        "stage": "branch",
        "repository": {
            "id": str(repository.id),
            "provider": "github",
            "name": "PPM",
            "full_name": "ppm-test-org/ppm",
            "canonical_url": "https://github.com/ppm-test-org/ppm",
        },
        "provider": {
            "connection_id": str(repository.connection.id),
            "installation_id": str(repository.connection.installation_id),
            "account_login": "ppm-test-org",
            "permissions": {"metadata": "read", "contents": "read", "pull_requests": "read"},
            "write_ready": False,
        },
        "branch": {
            "base_ref": "main",
            "base_sha": base_sha,
            "head_ref": head_ref,
            "canonical_url": f"https://github.com/ppm-test-org/ppm/tree/{head_ref}",
        },
        "draft_pull_request": {
            "title": f"GWA-{issue.sequence_id} — Безопасный Git write",
            "body": "## Что изменится\n\nВетка и draft PR будут созданы только после отдельного применения.",
            "is_draft": True,
            "planned": True,
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
            "message": (
                "Это предварительный просмотр: GitHub не изменится до отдельных подтверждения и применения. "
                "Будет создана только ветка от показанного коммита — без коммитов и изменения файлов."
            ),
        },
    }
    assert set(PpmGitAudit.objects.values_list("action", flat=True)) == {
        "write_action.preview_created",
        "write_action.preview_replayed",
    }


def test_member_can_approve_or_reject_but_guest_cannot(api_client, git_write_project, github):
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
    assert github.write_requests() == []

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
        "decision_status": "accepted",
        "required_permissions": {"metadata": "read", "contents": "write", "pull_requests": "write"},
        "provider_writes_enabled": False,
        "permission_ready": False,
        "apply_available": False,
        "blockers": ["PROVIDER_WRITE_DISABLED", "GITHUB_PERMISSIONS_MISSING"],
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
def test_write_readiness_opens_apply_only_with_flag_and_write_scopes(api_client, git_write_project):
    owner, workspace, project, _, _, connection = git_write_project
    authenticate(api_client, owner)
    before = api_client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/")
    connection.permissions = {"metadata": "read", "contents": "write", "pull_requests": "write"}
    connection.save(update_fields=["permissions", "updated_at"])

    response = api_client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/")

    assert before.data["write_actions"]["readiness"]["blockers"] == ["GITHUB_PERMISSIONS_MISSING"]
    assert response.status_code == status.HTTP_200_OK
    readiness = response.data["write_actions"]["readiness"]
    assert readiness["decision_status"] == "accepted"
    assert readiness["provider_writes_enabled"] is True
    assert readiness["permission_ready"] is True
    assert readiness["apply_available"] is True
    assert readiness["blockers"] == []
    assert readiness["connections"][0]["missing_permissions"] == []
    assert response.data["write_actions"]["apply_available"] is True


def test_source_change_blocks_approval_without_partial_write(api_client, git_write_project, github):
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
    assert github.write_requests() == []
    assert PpmGitAudit.objects.filter(action="write_action.conflict", target_id=action.id).exists()


def test_background_sync_does_not_invalidate_a_preview_but_reinstallation_does(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    authenticate(api_client, owner)
    synced = api_client.post(
        write_actions_url(workspace, project),
        preview_payload(repository, issue, head_ref="gwa-1/synced"),
        format="json",
    )
    # Reconciliation and webhooks touch the connection row all the time; that is not a change of the preview.
    connection.last_event_at = connection.updated_at
    connection.status = "syncing"
    connection.save(update_fields=["last_event_at", "status", "updated_at"])
    approved = api_client.post(
        write_actions_url(workspace, project, f"{synced.data['id']}/decision/"),
        {"decision": "approve"},
        format="json",
    )
    assert approved.status_code == status.HTTP_200_OK, approved.data
    assert approved.data["status"] == "approved"

    connection.status = "active"
    connection.save(update_fields=["status", "updated_at"])
    reinstalled = api_client.post(
        write_actions_url(workspace, project),
        preview_payload(repository, issue, head_ref="gwa-1/reinstalled"),
        format="json",
    )
    other_installation = connection.installation
    other_installation.pk = None
    other_installation.id = uuid.uuid4()
    other_installation.provider_installation_id = 81002
    other_installation.save()
    connection.installation = other_installation
    connection.save(update_fields=["installation", "updated_at"])
    conflict = api_client.post(
        write_actions_url(workspace, project, f"{reinstalled.data['id']}/decision/"),
        {"decision": "approve"},
        format="json",
    )
    assert conflict.status_code == status.HTTP_409_CONFLICT
    assert conflict.data["error"]["code"] == "GIT_WRITE_SOURCE_CHANGED"


@pytest.mark.parametrize(
    "head_ref",
    ["main", "bad branch", "../escape", "refs//heads", "feature.lock", "feature@{old}", "feature\\name"],
)
def test_preview_rejects_unsafe_or_conflicting_branch_names(api_client, git_write_project, github, head_ref):
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
    assert github.requests == []
