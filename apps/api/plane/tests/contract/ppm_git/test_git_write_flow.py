"""G1.3 (RC-C): two-stage Git write flow — branch first, draft PR after the first push — with the mock provider.

Every test talks to the in-memory GitHub from ``github_fake.py`` through the production ``GitHubAppClient``. The live
GitHub E2E is a documented RC limitation (no test repository); these contracts pin the behaviour instead.
"""

import json
import uuid
from datetime import timedelta

import pytest
from django.test import override_settings
from django.utils import timezone
from rest_framework import status

from plane.ppm_git.models import (
    PpmGitAudit,
    PpmGitLink,
    PpmGitObject,
    PpmGitWriteAction,
    PpmGitWriteActionStatus,
)
from plane.ppm_git.provider_services import create_delivery, process_delivery
from plane.ppm_git.services import PpmGitError
from plane.ppm_git.webhooks import body_sha256, parse_github_webhook
from plane.ppm_git.write_actions import cancel_git_write_action
from plane.tests.contract.ppm_git.github_fake import FakeResponse
from plane.tests.factories import ProjectFactory, ProjectMemberFactory, UserFactory, WorkspaceMemberFactory


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

WRITE_SCOPES = {"metadata": "read", "contents": "write", "pull_requests": "write"}


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


def url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/write-actions/{suffix}"


def grant_write(connection):
    connection.permissions = dict(WRITE_SCOPES)
    connection.save(update_fields=["permissions", "updated_at"])
    installation = connection.installation
    installation.permissions = dict(WRITE_SCOPES)
    installation.save(update_fields=["permissions", "updated_at"])


def branch_payload(repository, issue, **overrides):
    payload = {
        "action_type": "create_branch",
        "repository_id": str(repository.id),
        "work_item_id": str(issue.id),
        "base_ref": "main",
        "head_ref": f"gwa-{issue.sequence_id}/safe-git-write",
        "title": f"GWA-{issue.sequence_id} — Безопасный Git write",
        "body": "Черновик PR появится после первого push.",
        "client_operation_id": str(uuid.uuid4()),
    }
    payload.update(overrides)
    return payload


def pr_payload(branch_action_id, **overrides):
    payload = {
        "action_type": "create_draft_pr",
        "parent_action_id": str(branch_action_id),
        "title": "GWA-1 — Безопасный Git write",
        "body": "## Что изменится\n\nПервый шаг безопасной записи.",
        "client_operation_id": str(uuid.uuid4()),
    }
    payload.update(overrides)
    return payload


def approve(api_client, workspace, project, action_id):
    return api_client.post(url(workspace, project, f"{action_id}/decision/"), {"decision": "approve"}, format="json")


def apply(api_client, workspace, project, action_id):
    return api_client.post(url(workspace, project, f"{action_id}/apply/"), {}, format="json")


def cancel(api_client, workspace, project, action_id):
    return api_client.post(url(workspace, project, f"{action_id}/cancel/"), {}, format="json")


def approved_branch(api_client, workspace, project, repository, issue, **overrides):
    preview = api_client.post(url(workspace, project), branch_payload(repository, issue, **overrides), format="json")
    assert preview.status_code == status.HTTP_201_CREATED, preview.data
    decided = approve(api_client, workspace, project, preview.data["id"])
    assert decided.status_code == status.HTTP_200_OK, decided.data
    return preview.data


def push_webhook(github, *, branch, sha):
    raw_body = json.dumps(
        {
            "ref": f"refs/heads/{branch}",
            "after": sha,
            "repository": {"id": 91001, "full_name": github.full_name},
            "installation": {"id": github.installation_id},
            "head_commit": {"id": sha, "timestamp": "2026-09-26T12:10:00Z"},
            "commits": [
                {
                    "id": sha,
                    "message": github.commits[sha].message,
                    "url": f"https://github.com/{github.full_name}/commit/{sha}",
                    "timestamp": "2026-09-26T12:10:00Z",
                    "author": {"username": "developer"},
                }
            ],
        }
    ).encode()
    delivery, _ = create_delivery(
        delivery_id=str(uuid.uuid4()),
        event_name="push",
        raw_body_hash=body_sha256(raw_body),
        normalized_payload=parse_github_webhook(raw_body, event_name="push"),
    )
    process_delivery(delivery.id)


def audit_actions(action_id):
    return list(PpmGitAudit.objects.filter(target_id=action_id).order_by("created_at").values_list("action", flat=True))


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_work_item_to_branch_to_draft_pr_with_exact_previews_and_replay(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    base_sha = github.branches["main"]
    head_ref = f"gwa-{issue.sequence_id}/safe-git-write"

    # Stage 1 — exact branch preview reads GitHub but never writes.
    preview = api_client.post(url(workspace, project), branch_payload(repository, issue), format="json")
    assert preview.status_code == status.HTTP_201_CREATED, preview.data
    assert preview.data["action_type"] == "create_branch"
    assert preview.data["stage"] == "branch"
    assert preview.data["base_sha"] == base_sha
    assert preview.data["preview"]["branch"] == {
        "base_ref": "main",
        "base_sha": base_sha,
        "head_ref": head_ref,
        "canonical_url": f"https://github.com/ppm-test-org/ppm/tree/{head_ref}",
    }
    assert preview.data["preview"]["provider"]["account_login"] == "ppm-test-org"
    assert preview.data["preview"]["work_item"]["identifier"] == f"GWA-{issue.sequence_id}"
    assert preview.data["preview"]["safety"]["provider_write_performed"] is False
    assert preview.data["preview"]["safety"]["merge_allowed"] is False
    assert preview.data["apply_available"] is False
    assert preview.data["apply_blockers"] == ["APPROVAL_REQUIRED"]
    assert github.write_requests() == []

    action_id = preview.data["id"]
    assert approve(api_client, workspace, project, action_id).data["status"] == "approved"
    assert github.write_requests() == []

    applied = apply(api_client, workspace, project, action_id)
    assert applied.status_code == status.HTTP_200_OK, applied.data
    assert applied.data["status"] == "applied"
    assert applied.data["result"]["branch"] == {
        "ref": head_ref,
        "sha": base_sha,
        "canonical_url": f"https://github.com/ppm-test-org/ppm/tree/{head_ref}",
        "created": True,
    }
    assert github.branches[head_ref] == base_sha
    assert github.write_requests() == [("POST", "/repos/ppm-test-org/ppm/git/refs")]
    assert {"contents": "write"} in [body["permissions"] for body in github.token_requests()]

    # Replaying apply returns the stored result and never calls GitHub again.
    requests_before = len(github.requests)
    replayed = apply(api_client, workspace, project, action_id)
    assert replayed.status_code == status.HTTP_200_OK
    assert replayed.data["result"] == applied.data["result"]
    assert len(github.requests) == requests_before

    branch_object = PpmGitObject.objects.get(repository=repository, object_type="branch", provider_object_id=head_ref)
    assert PpmGitLink.objects.filter(work_item=issue, git_object=branch_object, status="active").exists()
    assert applied.data["follow_up"]["pull_request_ready"] is False

    # Stage 2 is impossible before the first push: no hidden empty commit.
    too_early = api_client.post(url(workspace, project), pr_payload(action_id), format="json")
    assert too_early.status_code == status.HTTP_409_CONFLICT
    assert too_early.data["error"]["code"] == "GIT_WRITE_NO_COMMITS"

    # The developer pushes the first commit; the webhook marks the second preview as ready (it writes nothing).
    head_sha = github.commit_on(head_ref, f"GWA-{issue.sequence_id}: первый шаг")
    push_webhook(github, branch=head_ref, sha=head_sha)
    listed = api_client.get(url(workspace, project))
    branch_item = next(item for item in listed.data["items"] if item["id"] == action_id)
    assert branch_item["follow_up"]["pull_request_ready"] is True
    assert branch_item["follow_up"]["branch_head_sha"] == head_sha
    assert github.write_requests() == [("POST", "/repos/ppm-test-org/ppm/git/refs")]

    pr_preview = api_client.post(url(workspace, project), pr_payload(action_id), format="json")
    assert pr_preview.status_code == status.HTTP_201_CREATED, pr_preview.data
    assert pr_preview.data["action_type"] == "create_draft_pr"
    assert pr_preview.data["stage"] == "pull_request"
    assert pr_preview.data["parent_action_id"] == action_id
    assert pr_preview.data["base_sha"] == base_sha
    assert pr_preview.data["head_sha"] == head_sha
    assert pr_preview.data["preview"]["branch"] == {
        "base_ref": "main",
        "base_sha": base_sha,
        "head_ref": head_ref,
        "head_sha": head_sha,
        "canonical_url": f"https://github.com/ppm-test-org/ppm/tree/{head_ref}",
    }
    assert pr_preview.data["preview"]["commits"] == {
        "ahead_by": 1,
        "truncated": False,
        "items": [
            {
                "sha": head_sha,
                "title": f"GWA-{issue.sequence_id}: первый шаг",
                "author": "developer",
                "canonical_url": f"https://github.com/ppm-test-org/ppm/commit/{head_sha}",
            }
        ],
    }
    assert pr_preview.data["preview"]["draft_pull_request"]["is_draft"] is True
    pr_action_id = pr_preview.data["id"]

    # Idempotent preview replay with the same operation id; a different payload is rejected.
    replay_preview = api_client.post(
        url(workspace, project),
        pr_payload(action_id, client_operation_id=pr_preview.data["client_operation_id"]),
        format="json",
    )
    assert replay_preview.status_code == status.HTTP_200_OK
    assert replay_preview.data["id"] == pr_action_id

    assert approve(api_client, workspace, project, pr_action_id).data["status"] == "approved"
    pr_applied = apply(api_client, workspace, project, pr_action_id)
    assert pr_applied.status_code == status.HTTP_200_OK, pr_applied.data
    pull_request = pr_applied.data["result"]["pull_request"]
    assert pull_request["canonical_url"] == "https://github.com/ppm-test-org/ppm/pull/1"
    assert pull_request["is_draft"] is True
    assert pull_request["created"] is True
    assert pull_request["head_sha"] == head_sha
    assert github.write_requests() == [
        ("POST", "/repos/ppm-test-org/ppm/git/refs"),
        ("POST", "/repos/ppm-test-org/ppm/pulls"),
    ]
    assert {"contents": "read", "pull_requests": "write"} in [body["permissions"] for body in github.token_requests()]

    requests_before = len(github.requests)
    assert apply(api_client, workspace, project, pr_action_id).data["result"] == pr_applied.data["result"]
    assert len(github.requests) == requests_before

    # The draft PR is linked to the Work Item and its canonical provider URL (and so to the Canvas projection).
    pr_object = PpmGitObject.objects.get(repository=repository, object_type="pull_request")
    assert pr_object.canonical_url == "https://github.com/ppm-test-org/ppm/pull/1"
    assert pr_object.is_draft is True
    link = PpmGitLink.objects.get(work_item=issue, object_type="pull_request", status="active")
    assert link.git_object_id == pr_object.id
    assert link.canonical_url == pr_object.canonical_url

    # A second PR proposal for the same branch is refused while the first one exists.
    second = api_client.post(url(workspace, project), pr_payload(action_id), format="json")
    assert second.status_code == status.HTTP_409_CONFLICT
    assert second.data["error"]["code"] == "GIT_WRITE_PULL_REQUEST_EXISTS"

    # Audit completeness: initiator, provider identity, request and outcome for every step, and no secrets.
    assert audit_actions(uuid.UUID(action_id)) == [
        "write_action.preview_created",
        "write_action.approve",
        "write_action.apply_started",
        "write_action.apply_succeeded",
        "write_action.apply_replayed",
    ]
    assert audit_actions(uuid.UUID(pr_action_id)) == [
        "write_action.preview_created",
        "write_action.preview_replayed",
        "write_action.approve",
        "write_action.apply_started",
        "write_action.apply_succeeded",
        "write_action.apply_replayed",
    ]
    started = PpmGitAudit.objects.get(target_id=pr_action_id, action="write_action.apply_started")
    assert started.actor_id == owner.id
    assert started.metadata["provider"] == {
        "provider": "github",
        "account_login": "ppm-test-org",
        "provider_installation_id": 81001,
        "repository_full_name": "ppm-test-org/ppm",
    }
    assert started.metadata["request"] == {
        "action_type": "create_draft_pr",
        "base_ref": "main",
        "base_sha": base_sha,
        "head_ref": head_ref,
        "head_sha": head_sha,
    }
    succeeded = PpmGitAudit.objects.get(target_id=pr_action_id, action="write_action.apply_succeeded")
    assert succeeded.metadata["outcome"]["canonical_url"] == pull_request["canonical_url"]
    assert succeeded.metadata["provider_write_performed"] is True
    serialized_audit = json.dumps(list(PpmGitAudit.objects.values_list("metadata", flat=True)), ensure_ascii=False)
    assert "ghs_" not in serialized_audit
    assert "Bearer" not in serialized_audit
    assert "fake-app-jwt" not in serialized_audit


@override_settings(PPM_GIT_WRITE_ENABLED=False)
def test_write_flag_off_keeps_preview_approve_audit_but_refuses_apply(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue)

    detail = api_client.get(url(workspace, project, f"{action['id']}/"))
    assert detail.data["status"] == "approved"
    assert detail.data["apply_available"] is False
    assert detail.data["apply_blockers"] == ["PROVIDER_WRITE_DISABLED"]

    refused = apply(api_client, workspace, project, action["id"])
    assert refused.status_code == status.HTTP_403_FORBIDDEN
    assert refused.data["error"]["code"] == "GIT_WRITE_DISABLED"
    assert "выключена администратором" in refused.data["error"]["message"]
    assert PpmGitWriteAction.objects.get(id=action["id"]).status == PpmGitWriteActionStatus.APPROVED
    assert github.write_requests() == []
    assert f"gwa-{issue.sequence_id}/safe-git-write" not in github.branches
    refusal = PpmGitAudit.objects.get(target_id=action["id"], action="write_action.apply_refused")
    assert refusal.metadata["reason"] == "PROVIDER_WRITE_DISABLED"
    assert refusal.metadata["provider_write_performed"] is False

    overview = api_client.get(f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/")
    readiness = overview.data["write_actions"]["readiness"]
    assert readiness["decision_status"] == "accepted"
    assert readiness["provider_writes_enabled"] is False
    assert readiness["apply_available"] is False
    assert readiness["blockers"] == ["PROVIDER_WRITE_DISABLED"]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_apply_needs_approval_and_rejected_or_cancelled_actions_never_write(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)

    proposed = api_client.post(url(workspace, project), branch_payload(repository, issue), format="json").data
    not_approved = apply(api_client, workspace, project, proposed["id"])
    assert not_approved.status_code == status.HTTP_409_CONFLICT
    assert not_approved.data["error"]["code"] == "GIT_WRITE_NOT_APPROVED"
    # Even a refusal before any state change leaves an audit trail with its reason.
    refused = PpmGitAudit.objects.get(target_id=proposed["id"], action="write_action.apply_refused")
    assert refused.actor_id == owner.id
    assert refused.metadata["reason"] == "APPROVAL_REQUIRED"

    rejected = api_client.post(
        url(workspace, project, f"{proposed['id']}/decision/"), {"decision": "reject"}, format="json"
    )
    assert rejected.data["status"] == "rejected"
    after_reject = apply(api_client, workspace, project, proposed["id"])
    assert after_reject.status_code == status.HTTP_409_CONFLICT
    assert after_reject.data["error"]["code"] == "GIT_WRITE_DECISION_FINAL"

    approved = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/cancelled")
    cancelled = cancel(api_client, workspace, project, approved["id"])
    assert cancelled.status_code == status.HTTP_200_OK
    assert cancelled.data["status"] == "cancelled"
    assert cancelled.data["cancelled_by"] == str(owner.id)
    assert cancel(api_client, workspace, project, approved["id"]).status_code == status.HTTP_200_OK
    after_cancel = apply(api_client, workspace, project, approved["id"])
    assert after_cancel.status_code == status.HTTP_409_CONFLICT
    assert after_cancel.data["error"]["code"] == "GIT_WRITE_DECISION_FINAL"
    assert github.write_requests() == []
    assert audit_actions(uuid.UUID(approved["id"]))[-3:] == [
        "write_action.cancel",
        "write_action.cancel_replayed",
        "write_action.apply_refused",
    ]

    applied = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/applied")
    assert apply(api_client, workspace, project, applied["id"]).data["status"] == "applied"
    too_late = cancel(api_client, workspace, project, applied["id"])
    assert too_late.status_code == status.HTTP_409_CONFLICT
    assert too_late.data["error"]["code"] == "GIT_WRITE_ALREADY_APPLIED"


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_concurrent_branch_name_conflict_never_adopts_or_moves_a_branch(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)

    first = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/race")
    second = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/race")
    assert apply(api_client, workspace, project, first["id"]).data["status"] == "applied"
    lost = apply(api_client, workspace, project, second["id"])
    assert lost.status_code == status.HTTP_409_CONFLICT
    assert lost.data["error"]["code"] == "GITHUB_BRANCH_CONFLICT"
    assert PpmGitWriteAction.objects.get(id=second["id"]).status == PpmGitWriteActionStatus.CONFLICT
    assert github.write_requests() == [("POST", "/repos/ppm-test-org/ppm/git/refs")]

    # A branch that already exists in GitHub is refused at preview time — PPM never takes over a foreign branch.
    github.create_foreign_branch("gwa-1/foreign")
    taken = api_client.post(
        url(workspace, project), branch_payload(repository, issue, head_ref="gwa-1/foreign"), format="json"
    )
    assert taken.status_code == status.HTTP_409_CONFLICT
    assert taken.data["error"]["code"] == "GIT_WRITE_BRANCH_EXISTS"

    # Someone creates the same name (even at the same commit) between approval and the first apply attempt.
    late = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/late")
    github.create_foreign_branch("gwa-1/late")
    conflict = apply(api_client, workspace, project, late["id"])
    assert conflict.status_code == status.HTTP_409_CONFLICT
    assert conflict.data["error"]["code"] == "GITHUB_BRANCH_CONFLICT"
    assert github.write_requests() == [("POST", "/repos/ppm-test-org/ppm/git/refs")]
    assert "write_action.apply_conflict" in audit_actions(uuid.UUID(late["id"]))


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_base_moved_after_preview_is_conflict_without_write(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue)
    github.commit_on("main", "Someone merged something")

    response = apply(api_client, workspace, project, action["id"])

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.data["error"]["code"] == "GITHUB_BASE_MOVED"
    stored = PpmGitWriteAction.objects.get(id=action["id"])
    assert stored.status == PpmGitWriteActionStatus.CONFLICT
    assert stored.error_code == "GITHUB_BASE_MOVED"
    assert github.write_requests() == []


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_revoked_token_or_installation_is_a_visible_failure_without_hidden_retry(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)

    revoked_token = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/token")
    github.revoke_tokens_on_use = True
    response = apply(api_client, workspace, project, revoked_token["id"])
    github.revoke_tokens_on_use = False
    # The provider's 401 never reaches the browser as 401 (that would log the PPM user out).
    assert response.status_code == status.HTTP_502_BAD_GATEWAY
    assert response.data["error"]["code"] == "GITHUB_AUTH_FAILED"
    stored = PpmGitWriteAction.objects.get(id=revoked_token["id"])
    assert stored.status == PpmGitWriteActionStatus.FAILED
    assert stored.apply_attempts == 1
    assert github.write_requests() == []

    uninstalled = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/uninstalled")
    github.installation_state = "deleted"
    gone = apply(api_client, workspace, project, uninstalled["id"])
    assert gone.status_code == status.HTTP_502_BAD_GATEWAY
    assert gone.data["error"]["code"] == "GITHUB_INSTALLATION_REVOKED"
    assert PpmGitWriteAction.objects.get(id=uninstalled["id"]).status == PpmGitWriteActionStatus.FAILED

    # Once PPM knows the connection was revoked (webhook), apply stops before any provider call.
    github.installation_state = "active"
    disconnected = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/revoked")
    connection.status = "revoked"
    connection.save(update_fields=["status", "updated_at"])
    requests_before = len(github.requests)
    refused = apply(api_client, workspace, project, disconnected["id"])
    assert refused.status_code == status.HTTP_409_CONFLICT
    assert refused.data["error"]["code"] == "GIT_WRITE_CONNECTION_REQUIRED"
    assert len(github.requests) == requests_before
    assert PpmGitWriteAction.objects.get(id=disconnected["id"]).status == PpmGitWriteActionStatus.APPROVED


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_rate_limit_is_recorded_and_explicit_retry_waits_for_retry_after(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue)
    github.inject("POST", r"/git/refs$", FakeResponse(429, {"message": "slow down"}, {"Retry-After": "120"}))

    limited = apply(api_client, workspace, project, action["id"])

    assert limited.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert limited.data["error"]["code"] == "GITHUB_RATE_LIMITED"
    assert limited.data["error"]["details"]["retry_after_seconds"] == 120
    stored = PpmGitWriteAction.objects.get(id=action["id"])
    assert stored.status == PpmGitWriteActionStatus.FAILED
    assert stored.retry_after is not None

    requests_before = len(github.requests)
    too_soon = apply(api_client, workspace, project, action["id"])
    assert too_soon.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert too_soon.data["error"]["code"] == "GIT_WRITE_RETRY_LATER"
    assert len(github.requests) == requests_before

    PpmGitWriteAction.objects.filter(id=action["id"]).update(retry_after=timezone.now() - timedelta(seconds=1))
    retried = apply(api_client, workspace, project, action["id"])
    assert retried.status_code == status.HTTP_200_OK, retried.data
    assert retried.data["status"] == "applied"
    assert retried.data["apply_attempts"] == 2
    assert retried.data["result"]["branch"]["created"] is True


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_missing_or_drifted_permissions_refuse_without_partial_write(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    api_client.force_authenticate(user=owner)

    # PPM knows the App only has read scopes: refuse before touching GitHub, keep the approval.
    read_only = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/read-only")
    requests_before = len(github.requests)
    refused = apply(api_client, workspace, project, read_only["id"])
    assert refused.status_code == status.HTTP_409_CONFLICT
    assert refused.data["error"]["code"] == "GIT_WRITE_PERMISSIONS_MISSING"
    assert refused.data["error"]["details"]["missing_permissions"] == ["contents"]
    assert len(github.requests) == requests_before
    assert PpmGitWriteAction.objects.get(id=read_only["id"]).status == PpmGitWriteActionStatus.APPROVED

    # PPM believes the scopes are granted, GitHub disagrees (permission drift): visible failure, nothing created.
    grant_write(connection)
    github.granted_permissions = {"metadata": "read", "contents": "read", "pull_requests": "read"}
    drift = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/drift")
    drifted = apply(api_client, workspace, project, drift["id"])
    assert drifted.status_code == status.HTTP_502_BAD_GATEWAY
    assert drifted.data["error"]["code"] == "GITHUB_WRITE_PERMISSION_MISSING"
    assert github.write_requests() == []

    # Repository rules (protected branch patterns) reject the ref: visible failure, no retry behind the user's back.
    github.granted_permissions = dict(WRITE_SCOPES)
    github.rule_rejected_branches.add("release/gwa-1")
    protected = approved_branch(api_client, workspace, project, repository, issue, head_ref="release/gwa-1")
    rejected = apply(api_client, workspace, project, protected["id"])
    assert rejected.status_code == status.HTTP_502_BAD_GATEWAY
    assert rejected.data["error"]["code"] == "GITHUB_BRANCH_REJECTED"
    assert "release/gwa-1" not in github.branches
    assert github.write_requests() == [("POST", "/repos/ppm-test-org/ppm/git/refs")]
    # GitHub answered with a definite refusal: nothing was written, so the step may be cancelled.
    failed = PpmGitAudit.objects.get(target_id=protected["id"], action="write_action.apply_failed")
    assert failed.metadata["write_outcome"] == "not_performed"
    assert failed.metadata["provider_write_performed"] is False
    assert cancel(api_client, workspace, project, protected["id"]).data["status"] == "cancelled"


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_applying_is_fenced_and_a_stale_attempt_replays_the_branch_it_created(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/crash")

    # Another request holds a fresh lease: this request neither calls GitHub nor changes the action.
    PpmGitWriteAction.objects.filter(id=action["id"]).update(
        status=PpmGitWriteActionStatus.APPLYING,
        apply_fence=uuid.uuid4(),
        apply_attempts=1,
        apply_started_at=timezone.now(),
    )
    requests_before = len(github.requests)
    busy = apply(api_client, workspace, project, action["id"])
    assert busy.status_code == status.HTTP_409_CONFLICT
    assert busy.data["error"]["code"] == "GIT_WRITE_APPLY_IN_PROGRESS"
    assert len(github.requests) == requests_before

    # The first attempt created the ref and crashed before recording it; its lease expired.
    github.create_foreign_branch("gwa-1/crash", github.branches["main"])
    PpmGitWriteAction.objects.filter(id=action["id"]).update(apply_started_at=timezone.now() - timedelta(minutes=10))
    recovered = apply(api_client, workspace, project, action["id"])
    assert recovered.status_code == status.HTTP_200_OK, recovered.data
    assert recovered.data["status"] == "applied"
    assert recovered.data["apply_attempts"] == 2
    assert recovered.data["result"]["branch"]["created"] is False
    assert github.write_requests() == []


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_a_superseded_attempt_never_overwrites_the_new_fence_holder(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/fenced")
    takeover_fence = uuid.uuid4()
    original_request = github.request

    def request_and_lose_the_lease(method, url_value, **kwargs):
        if method == "POST" and url_value.endswith("/git/refs"):
            # While GitHub is answering, a newer attempt takes over the expired lease.
            PpmGitWriteAction.objects.filter(id=action["id"]).update(apply_fence=takeover_fence, apply_attempts=2)
        return original_request(method, url_value, **kwargs)

    github.request = request_and_lose_the_lease
    response = apply(api_client, workspace, project, action["id"])

    stored = PpmGitWriteAction.objects.get(id=action["id"])
    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.data["error"]["code"] == "GIT_WRITE_APPLY_SUPERSEDED"
    assert stored.status == PpmGitWriteActionStatus.APPLYING
    assert stored.apply_fence == takeover_fence
    # Only bookkeeping (when the first attempt started) — the lost attempt never records its result.
    assert set(stored.result) == {"first_attempt_at"}
    assert "write_action.apply_superseded" in audit_actions(stored.id)


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_draft_pr_stage_guards_commits_existing_pr_moved_head_and_draft_support(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/pr-guards")

    not_applied = api_client.post(url(workspace, project), pr_payload(branch["id"]), format="json")
    assert not_applied.status_code == status.HTTP_409_CONFLICT
    assert not_applied.data["error"]["code"] == "GIT_WRITE_PARENT_NOT_APPLIED"

    assert apply(api_client, workspace, project, branch["id"]).data["status"] == "applied"
    github.commit_on("gwa-1/pr-guards", "GWA-1: first")
    preview = api_client.post(url(workspace, project), pr_payload(branch["id"]), format="json")
    assert preview.status_code == status.HTTP_201_CREATED, preview.data
    assert approve(api_client, workspace, project, preview.data["id"]).status_code == status.HTTP_200_OK

    # New commits after the preview: the PR would contain commits nobody reviewed — conflict, no PR.
    github.commit_on("gwa-1/pr-guards", "GWA-1: second")
    moved = apply(api_client, workspace, project, preview.data["id"])
    assert moved.status_code == status.HTTP_409_CONFLICT
    assert moved.data["error"]["code"] == "GITHUB_HEAD_MOVED"
    assert ("POST", "/repos/ppm-test-org/ppm/pulls") not in github.write_requests()

    # Private repository on a plan without draft PRs: visible failure, no ready-for-review PR instead.
    github.draft_supported = False
    fresh = api_client.post(url(workspace, project), pr_payload(branch["id"]), format="json")
    assert fresh.status_code == status.HTTP_201_CREATED, fresh.data
    assert fresh.data["preview"]["commits"]["ahead_by"] == 2
    approve(api_client, workspace, project, fresh.data["id"])
    unsupported = apply(api_client, workspace, project, fresh.data["id"])
    assert unsupported.status_code == status.HTTP_502_BAD_GATEWAY
    assert unsupported.data["error"]["code"] == "GITHUB_DRAFT_UNSUPPORTED"
    assert github.pulls == []

    # A PR someone opened by hand is never adopted on the first attempt.
    github.draft_supported = True
    cancel(api_client, workspace, project, fresh.data["id"])
    github.pulls.append(
        {
            "id": 99999,
            "node_id": "PR_manual",
            "number": 77,
            "title": "Manual PR",
            "body": "",
            "html_url": "https://github.com/ppm-test-org/ppm/pull/77",
            "state": "open",
            "draft": False,
            "merged_at": None,
            "updated_at": "2026-09-26T12:00:00Z",
            "user": {"login": "developer"},
            "base": {"ref": "main", "sha": github.branches["main"]},
            "head": {"ref": "gwa-1/pr-guards", "sha": github.branches["gwa-1/pr-guards"]},
        }
    )
    existing = api_client.post(url(workspace, project), pr_payload(branch["id"]), format="json")
    assert existing.status_code == status.HTTP_409_CONFLICT
    assert existing.data["error"]["code"] == "GIT_WRITE_PULL_REQUEST_EXISTS"
    assert existing.data["error"]["details"]["canonical_url"] == "https://github.com/ppm-test-org/ppm/pull/77"
    # Only the branch and the one draft attempt GitHub rejected ever reached a write endpoint.
    assert [path for method, path in github.write_requests()] == [
        "/repos/ppm-test-org/ppm/git/refs",
        "/repos/ppm-test-org/ppm/pulls",
    ]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_only_project_managers_and_members_can_prepare_decide_apply_or_cancel(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    member = make_user("git-flow-member")
    guest = make_user("git-flow-guest")
    outsider = make_user("git-flow-outsider")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    WorkspaceMemberFactory(workspace=workspace, member=outsider, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)

    api_client.force_authenticate(user=member)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/member")

    for user in (guest, outsider):
        api_client.force_authenticate(user=user)
        assert apply(api_client, workspace, project, action["id"]).status_code == status.HTTP_403_FORBIDDEN
        assert cancel(api_client, workspace, project, action["id"]).status_code == status.HTTP_403_FORBIDDEN
        denied = api_client.post(url(workspace, project), branch_payload(repository, issue), format="json")
        assert denied.status_code == status.HTTP_403_FORBIDDEN
    assert github.write_requests() == []

    api_client.force_authenticate(user=member)
    applied = apply(api_client, workspace, project, action["id"])
    assert applied.status_code == status.HTTP_200_OK
    assert applied.data["applied_by"] == str(member.id)


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_legacy_combined_proposal_cannot_be_applied_or_created(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    legacy = PpmGitWriteAction.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        repository=repository,
        connection=connection,
        work_item=issue,
        action_type="create_branch_draft_pr",
        status=PpmGitWriteActionStatus.APPROVED,
        client_operation_id=uuid.uuid4(),
        request_fingerprint="0" * 64,
        repository_updated_at=repository.updated_at,
        connection_updated_at=connection.updated_at,
        work_item_updated_at=issue.updated_at,
        base_ref="main",
        head_ref="gwa-1/legacy",
        title="Legacy",
        preview={},
        created_by=owner.id,
    )

    refused = apply(api_client, workspace, project, legacy.id)
    assert refused.status_code == status.HTTP_409_CONFLICT
    assert refused.data["error"]["code"] == "GIT_WRITE_ACTION_TYPE_UNSUPPORTED"
    created = api_client.post(
        url(workspace, project), branch_payload(repository, issue, action_type="create_branch_draft_pr"), format="json"
    )
    assert created.status_code == status.HTTP_400_BAD_REQUEST
    assert created.data["error"]["code"] == "GIT_WRITE_ACTION_TYPE_UNSUPPORTED"
    assert github.write_requests() == []


@pytest.mark.parametrize(
    "head_ref",
    ["x';calc;#", "x&calc&", "gwa-1/$(id)", "a|b", "a`id`", 'a"b', "a%b", "a+b", "a@b", "-a", "a/", "a" * 245],
)
def test_branch_names_a_shell_could_interpret_are_refused_before_github(
    api_client, git_write_project, github, head_ref
):
    owner, workspace, project, issue, repository, _ = git_write_project
    api_client.force_authenticate(user=owner)

    response = api_client.post(
        url(workspace, project), branch_payload(repository, issue, head_ref=head_ref), format="json"
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == "GIT_WRITE_INVALID_REF"
    assert "латинские буквы" in response.data["error"]["message"]
    assert github.requests == []
    assert not PpmGitWriteAction.objects.exists()


def test_the_longest_allowed_branch_name_and_safe_base_are_accepted(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, _ = git_write_project
    api_client.force_authenticate(user=owner)
    longest = "gwa-1/" + "a" * 238

    accepted = api_client.post(
        url(workspace, project), branch_payload(repository, issue, head_ref=longest), format="json"
    )
    bad_base = api_client.post(
        url(workspace, project), branch_payload(repository, issue, base_ref="main;calc"), format="json"
    )

    assert accepted.status_code == status.HTTP_201_CREATED, accepted.data
    assert len(accepted.data["preview"]["branch"]["head_ref"]) == 244
    assert bad_base.status_code == status.HTTP_400_BAD_REQUEST
    assert bad_base.data["error"]["code"] == "GIT_WRITE_INVALID_REF"


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_apply_rechecks_the_shown_work_item_and_an_active_installation(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)

    # The Work Item title shown in the preview changed after approval: conflict, GitHub untouched.
    renamed = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/renamed")
    issue.name = "Другая задача"
    issue.save(update_fields=["name", "updated_at"])
    requests_before = len(github.requests)
    conflict = apply(api_client, workspace, project, renamed["id"])
    assert conflict.status_code == status.HTTP_409_CONFLICT
    assert conflict.data["error"]["code"] == "GIT_WRITE_SOURCE_CHANGED"
    assert PpmGitWriteAction.objects.get(id=renamed["id"]).status == PpmGitWriteActionStatus.CONFLICT
    assert len(github.requests) == requests_before

    # A field the preview did not show (priority/state) is not a change of what was approved.
    moved = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/moved")
    issue.priority = "high"
    issue.save(update_fields=["priority", "updated_at"])
    assert apply(api_client, workspace, project, moved["id"]).data["status"] == "applied"

    # The GitHub App installation was suspended (the connection row still says active): refuse before GitHub.
    suspended = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/suspended")
    installation = connection.installation
    installation.status = "suspended"
    installation.save(update_fields=["status", "updated_at"])
    requests_before = len(github.requests)
    refused = apply(api_client, workspace, project, suspended["id"])
    assert refused.status_code == status.HTTP_409_CONFLICT
    assert refused.data["error"]["code"] == "GIT_WRITE_CONNECTION_REQUIRED"
    assert len(github.requests) == requests_before
    assert PpmGitWriteAction.objects.get(id=suspended["id"]).status == PpmGitWriteActionStatus.APPROVED
    audit = PpmGitAudit.objects.get(target_id=suspended["id"], action="write_action.apply_refused")
    assert audit.metadata["reason"] == "GIT_WRITE_CONNECTION_REQUIRED"


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_a_running_or_interrupted_apply_can_only_be_retried_and_retry_reconciles(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/lost")
    head_url = "https://github.com/ppm-test-org/ppm/tree/gwa-1/lost"

    # A live attempt: cancel is refused.
    PpmGitWriteAction.objects.filter(id=action["id"]).update(
        status=PpmGitWriteActionStatus.APPLYING,
        apply_fence=uuid.uuid4(),
        apply_attempts=1,
        apply_started_at=timezone.now(),
    )
    running = cancel(api_client, workspace, project, action["id"])
    assert running.status_code == status.HTTP_409_CONFLICT
    assert running.data["error"]["code"] == "GIT_WRITE_APPLY_IN_PROGRESS"
    assert api_client.get(url(workspace, project, f"{action['id']}/")).data["can_cancel"] is False

    # The attempt died (lease expired): its outcome is unknown, so cancel is still refused.
    PpmGitWriteAction.objects.filter(id=action["id"]).update(apply_started_at=timezone.now() - timedelta(minutes=10))
    stale = cancel(api_client, workspace, project, action["id"])
    assert stale.status_code == status.HTTP_409_CONFLICT
    assert stale.data["error"]["code"] == "GIT_WRITE_OUTCOME_UNKNOWN"
    assert PpmGitAudit.objects.filter(target_id=action["id"], action="write_action.cancel_refused").count() == 2

    # The retry's own write request reaches GitHub but the answer is lost: the outcome stays unknown.
    github.lose_response("POST", r"/git/refs$")
    timeout = apply(api_client, workspace, project, action["id"])
    assert timeout.status_code == status.HTTP_502_BAD_GATEWAY
    assert timeout.data["error"]["code"] == "GITHUB_UNAVAILABLE"
    assert timeout.data["error"]["details"]["outcome_unknown"] is True
    assert github.branches["gwa-1/lost"] == github.branches["main"]
    detail = api_client.get(url(workspace, project, f"{action['id']}/")).data
    assert (detail["status"], detail["outcome_unknown"], detail["can_cancel"]) == ("failed", True, False)
    failed = PpmGitAudit.objects.get(target_id=action["id"], action="write_action.apply_failed")
    assert failed.metadata["write_outcome"] == "unknown"
    assert failed.metadata["provider_write_performed"] is None
    refused = cancel(api_client, workspace, project, action["id"])
    assert refused.data["error"]["code"] == "GIT_WRITE_OUTCOME_UNKNOWN"

    # The developer already pushed to the branch the lost request created; the retry adopts it (no new write).
    pushed = github.commit_on("gwa-1/lost", "GWA-1: early push")
    writes_before = github.write_requests()
    retried = apply(api_client, workspace, project, action["id"])
    assert retried.status_code == status.HTTP_200_OK, retried.data
    assert retried.data["status"] == "applied"
    assert retried.data["outcome_unknown"] is False
    assert retried.data["result"]["branch"] == {
        "ref": "gwa-1/lost",
        "sha": pushed,
        "canonical_url": head_url,
        "created": False,
    }
    assert github.write_requests() == writes_before
    succeeded = PpmGitAudit.objects.get(target_id=action["id"], action="write_action.apply_succeeded")
    assert succeeded.metadata["reconciled"] is True
    assert succeeded.metadata["outcome"]["canonical_url"] == head_url


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_late_success_of_a_superseded_attempt_is_audited_with_its_url(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/late-success")
    original_request = github.request
    seen = {}

    def slow_github(method, url_value, **kwargs):
        if method == "POST" and url_value.endswith("/git/refs") and "lease" not in seen:
            # GitHub is slow: the lease expires, someone presses «Отменить» (refused), another attempt takes over.
            PpmGitWriteAction.objects.filter(id=action["id"]).update(
                apply_started_at=timezone.now() - timedelta(minutes=10)
            )
            try:
                cancel_git_write_action(action=PpmGitWriteAction.objects.get(id=action["id"]), user_id=owner.id)
            except PpmGitError as exc:
                seen["cancel"] = exc.code
            PpmGitWriteAction.objects.filter(id=action["id"]).update(
                apply_fence=uuid.uuid4(), apply_attempts=2, apply_started_at=timezone.now() - timedelta(minutes=10)
            )
            seen["lease"] = True
        return original_request(method, url_value, **kwargs)

    github.request = slow_github
    late = apply(api_client, workspace, project, action["id"])
    github.request = original_request

    assert seen["cancel"] == "GIT_WRITE_OUTCOME_UNKNOWN"
    assert late.status_code == status.HTTP_409_CONFLICT
    assert late.data["error"]["code"] == "GIT_WRITE_APPLY_SUPERSEDED"
    superseded = PpmGitAudit.objects.get(target_id=action["id"], action="write_action.apply_superseded")
    assert superseded.metadata["provider_write_performed"] is True
    assert (
        superseded.metadata["outcome"]["canonical_url"] == "https://github.com/ppm-test-org/ppm/tree/gwa-1/late-success"
    )
    assert superseded.metadata["outcome"]["created"] is True

    # The next retry reconciles with GitHub and records what the late attempt created.
    recorded = apply(api_client, workspace, project, action["id"])
    assert recorded.data["status"] == "applied"
    assert recorded.data["result"]["branch"]["created"] is False
    assert github.write_requests() == [("POST", "/repos/ppm-test-org/ppm/git/refs")]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_first_apply_attempt_never_adopts_an_open_pull_request(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/adopt")
    apply(api_client, workspace, project, branch["id"])
    github.commit_on("gwa-1/adopt", "GWA-1: work")
    payload = pr_payload(branch["id"])
    preview = api_client.post(url(workspace, project), payload, format="json")
    approve(api_client, workspace, project, preview.data["id"])
    # Between approval and apply someone opens a PR by hand — even with the very same title and body.
    github.add_pull_request(head="gwa-1/adopt", title=payload["title"], body=payload["body"])

    response = apply(api_client, workspace, project, preview.data["id"])

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.data["error"]["code"] == "GITHUB_PULL_REQUEST_EXISTS"
    assert response.data["error"]["details"]["canonical_url"].startswith("https://github.com/ppm-test-org/ppm/pull/")
    assert PpmGitWriteAction.objects.get(id=preview.data["id"]).status == PpmGitWriteActionStatus.CONFLICT
    assert ("POST", "/repos/ppm-test-org/ppm/pulls") not in github.write_requests()


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_a_closed_pull_request_does_not_block_a_new_draft(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/reopen")
    apply(api_client, workspace, project, branch["id"])
    github.commit_on("gwa-1/reopen", "GWA-1: work")
    closed = github.add_pull_request(head="gwa-1/reopen", title="Старый PR", state="closed")

    preview = api_client.post(url(workspace, project), pr_payload(branch["id"]), format="json")
    assert preview.status_code == status.HTTP_201_CREATED, preview.data
    assert [item["canonical_url"] for item in preview.data["preview"]["previous_pull_requests"]] == [closed["html_url"]]
    approve(api_client, workspace, project, preview.data["id"])
    applied = apply(api_client, workspace, project, preview.data["id"])

    assert applied.status_code == status.HTTP_200_OK, applied.data
    assert applied.data["result"]["pull_request"]["created"] is True
    assert applied.data["result"]["pull_request"]["canonical_url"] != closed["html_url"]


def test_pull_request_title_is_capped_at_the_github_limit(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, _ = git_write_project
    api_client.force_authenticate(user=owner)

    too_long = api_client.post(
        url(workspace, project), branch_payload(repository, issue, title="Т" * 257), format="json"
    )
    longest = api_client.post(
        url(workspace, project),
        branch_payload(repository, issue, head_ref="gwa-1/title", title="Т" * 256),
        format="json",
    )

    assert too_long.status_code == status.HTTP_400_BAD_REQUEST
    assert too_long.data["error"]["code"] == "GIT_WRITE_TITLE_TOO_LONG"
    assert longest.status_code == status.HTTP_201_CREATED, longest.data


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_write_actions_never_cross_project_boundaries(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    foreign_project = ProjectFactory(workspace=workspace, identifier="FRN")
    ProjectMemberFactory(workspace=workspace, project=foreign_project, member=owner, role=20)
    branch = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/scoped")
    apply(api_client, workspace, project, branch["id"])
    github.commit_on("gwa-1/scoped", "GWA-1: work")

    parent_elsewhere = api_client.post(url(workspace, foreign_project), pr_payload(branch["id"]), format="json")
    assert parent_elsewhere.status_code == status.HTTP_404_NOT_FOUND
    assert parent_elsewhere.data["error"]["code"] == "GIT_WRITE_ACTION_NOT_FOUND"
    for suffix, body in (("apply/", {}), ("cancel/", {}), ("decision/", {"decision": "approve"}), ("", None)):
        path = url(workspace, foreign_project, f"{branch['id']}/{suffix}")
        response = api_client.get(path) if body is None else api_client.post(path, body, format="json")
        assert response.status_code == status.HTTP_404_NOT_FOUND, suffix
    assert PpmGitWriteAction.objects.get(id=branch["id"]).status == PpmGitWriteActionStatus.APPLIED


# --- Fix round 2 (re-review R1/R2, m1–m4): PR identity by marker, honest reconciliation -------------------------------


def applied_branch_with_commit(api_client, workspace, project, repository, issue, github, head_ref):
    branch = approved_branch(api_client, workspace, project, repository, issue, head_ref=head_ref)
    assert apply(api_client, workspace, project, branch["id"]).data["status"] == "applied"
    github.commit_on(head_ref, "GWA-1: work")
    return branch


def approved_pull_request(api_client, workspace, project, branch_id, **overrides):
    preview = api_client.post(url(workspace, project), pr_payload(branch_id, **overrides), format="json")
    assert preview.status_code == status.HTTP_201_CREATED, preview.data
    assert approve(api_client, workspace, project, preview.data["id"]).status_code == status.HTTP_200_OK
    return preview.data


def attempt_audits(action_id, attempt):
    return [
        (item.action, item.metadata.get("write_outcome"), item.metadata.get("provider_write_performed"))
        for item in PpmGitAudit.objects.filter(target_id=action_id).order_by("created_at")
        if item.metadata.get("attempt") == attempt and item.action != "write_action.apply_started"
    ]


def stale_takeover_state(action_id, **result):
    PpmGitWriteAction.objects.filter(id=action_id).update(
        status=PpmGitWriteActionStatus.APPLYING,
        apply_fence=uuid.uuid4(),
        apply_attempts=1,
        apply_started_at=timezone.now() - timedelta(minutes=10),
        result=result,
    )


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_every_ppm_pull_request_carries_its_action_marker_shown_in_the_preview(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/marked")
    preview = approved_pull_request(api_client, workspace, project, branch["id"])
    marker = f"<!-- ppm-write-action:{preview['id']} -->"

    assert preview["preview"]["draft_pull_request"]["marker"] == marker
    assert apply(api_client, workspace, project, preview["id"]).data["status"] == "applied"
    posted = [
        kwargs["json"] for method, path, kwargs in github.requests if method == "POST" and path.endswith("/pulls")
    ]
    assert posted[0]["body"] == f"{pr_payload(branch['id'])['body']}\n\n{marker}"


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_probe1_takeover_failing_before_any_write_keeps_the_outcome_unknown(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/probe-takeover")
    stale_takeover_state(action["id"])
    github.inject("POST", r"/access_tokens$", FakeResponse(502, {"message": "Server Error"}))

    failed = apply(api_client, workspace, project, action["id"])

    detail = api_client.get(url(workspace, project, f"{action['id']}/")).data
    assert (detail["status"], detail["outcome_unknown"], detail["can_cancel"]) == ("failed", True, False), detail
    assert "Не удалось подтвердить, создана ли ветка" in failed.data["error"]["message"]
    assert cancel(api_client, workspace, project, action["id"]).data["error"]["code"] == "GIT_WRITE_OUTCOME_UNKNOWN"
    assert attempt_audits(uuid.UUID(action["id"]), 2) == [("write_action.apply_failed", "unknown", False)]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_probe2_retry_after_a_rate_limit_never_adopts_an_older_closed_look_alike(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/probe-closed")
    payload = pr_payload(branch["id"])
    closed = github.add_pull_request(
        head="gwa-1/probe-closed", title=payload["title"], body=payload["body"], state="closed"
    )
    preview = approved_pull_request(api_client, workspace, project, branch["id"])
    github.inject("POST", r"/pulls$", FakeResponse(429, {"message": "slow down"}, {"Retry-After": "60"}))
    limited = apply(api_client, workspace, project, preview["id"])
    assert limited.data["error"]["code"] == "GITHUB_RATE_LIMITED", limited.data
    PpmGitWriteAction.objects.filter(id=preview["id"]).update(retry_after=timezone.now() - timedelta(seconds=1))

    retried = apply(api_client, workspace, project, preview["id"])

    assert retried.status_code == status.HTTP_200_OK, retried.data
    got = retried.data["result"]["pull_request"]
    assert got["created"] is True
    assert got["state"] == "open"
    assert got["canonical_url"] != closed["html_url"]
    assert github.pulls[-1]["draft"] is True


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_probe3_a_lost_answer_then_an_edited_title_is_still_recognised_by_the_marker(
    api_client, git_write_project, github
):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/probe-edited")
    preview = approved_pull_request(api_client, workspace, project, branch["id"])
    github.lose_response("POST", r"/pulls$")
    lost = apply(api_client, workspace, project, preview["id"])
    assert lost.data["error"]["details"]["outcome_unknown"] is True, lost.data
    assert len(github.pulls) == 1
    github.pulls[-1]["title"] = "Отредактировано разработчиком"

    retried = apply(api_client, workspace, project, preview["id"])

    assert retried.status_code == status.HTTP_200_OK, retried.data
    assert retried.data["status"] == "applied"
    assert retried.data["result"]["pull_request"]["canonical_url"] == github.pulls[-1]["html_url"]
    assert retried.data["result"]["pull_request"]["created"] is False
    assert len(github.pulls) == 1
    assert attempt_audits(uuid.UUID(preview["id"]), 2) == [("write_action.apply_succeeded", "exists", False)]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_probe4_already_exists_in_a_lease_race_is_reconciled_not_audited_as_no_write(
    api_client, git_write_project, github
):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/probe-race")
    stale_takeover_state(action["id"])
    original = github.request

    def racing(method, url_value, **kwargs):
        if method == "POST" and url_value.endswith("/git/refs") and "gwa-1/probe-race" not in github.branches:
            github.create_foreign_branch("gwa-1/probe-race", github.branches["main"])  # the dead attempt lands
        return original(method, url_value, **kwargs)

    github.request = racing
    raced = apply(api_client, workspace, project, action["id"])
    github.request = original

    assert raced.status_code == status.HTTP_200_OK, raced.data
    assert raced.data["result"]["branch"]["created"] is False
    assert attempt_audits(uuid.UUID(action["id"]), 2) == [("write_action.apply_succeeded", "exists", False)]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_reconciliation_calls_a_look_alike_pr_foreign_only_when_it_predates_the_first_attempt(
    api_client, git_write_project, github
):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    first_attempt_at = (timezone.now() - timedelta(minutes=30)).isoformat()

    # Opened after our first attempt, without our marker: maybe ours with the marker edited away — unconfirmed.
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/lookalike")
    preview = approved_pull_request(api_client, workspace, project, branch["id"])
    stale_takeover_state(preview["id"], first_attempt_at=first_attempt_at)
    github.add_pull_request(head="gwa-1/lookalike", title="Похожий PR", body="без отметки")
    unconfirmed = apply(api_client, workspace, project, preview["id"])
    assert unconfirmed.status_code == status.HTTP_409_CONFLICT, unconfirmed.data
    assert unconfirmed.data["error"]["code"] == "GITHUB_PULL_REQUEST_UNCONFIRMED"
    assert unconfirmed.data["error"]["message"].startswith("Не удалось подтвердить, создан ли PR — проверьте в GitHub")
    assert unconfirmed.data["error"]["details"]["canonical_url"] == (
        "https://github.com/ppm-test-org/ppm/pulls?q=is%3Apr%20head%3Agwa-1%2Flookalike"
    )
    stored = PpmGitWriteAction.objects.get(id=preview["id"])
    assert (stored.status, stored.result["outcome_unknown"]) == (PpmGitWriteActionStatus.CONFLICT, True)
    assert attempt_audits(stored.id, 2) == [("write_action.apply_conflict", "unknown", False)]
    assert cancel(api_client, workspace, project, preview["id"]).status_code == status.HTTP_409_CONFLICT

    # Opened a day before our first attempt, without our marker: proven someone else's.
    older = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/older")
    second = approved_pull_request(api_client, workspace, project, older["id"])
    stale_takeover_state(second["id"], first_attempt_at=first_attempt_at)
    github.add_pull_request(
        head="gwa-1/older", title="Чужой PR", created_at=(timezone.now() - timedelta(days=1)).isoformat()
    )
    foreign = apply(api_client, workspace, project, second["id"])
    assert foreign.data["error"]["code"] == "GITHUB_PULL_REQUEST_EXISTS"
    assert attempt_audits(uuid.UUID(second["id"]), 2) == [("write_action.apply_conflict", "not_performed", False)]
    assert [path for method, path in github.write_requests() if path.endswith("/pulls")] == []


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_this_actions_closed_pr_is_reported_as_existing_never_adopted_and_does_not_block_a_new_step(
    api_client, git_write_project, github
):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/closed-own")
    preview = approved_pull_request(api_client, workspace, project, branch["id"])
    github.lose_response("POST", r"/pulls$")
    apply(api_client, workspace, project, preview["id"])
    github.pulls[-1]["state"] = "closed"

    retried = apply(api_client, workspace, project, preview["id"])

    assert retried.data["error"]["code"] == "GITHUB_PULL_REQUEST_CLOSED"
    assert retried.data["error"]["details"]["canonical_url"] == github.pulls[-1]["html_url"]
    assert attempt_audits(uuid.UUID(preview["id"]), 2) == [("write_action.apply_conflict", "exists", False)]
    assert PpmGitWriteAction.objects.get(id=preview["id"]).status == PpmGitWriteActionStatus.CONFLICT

    # m3: that closed PPM PR does not block step 2 — a new draft can be prepared and created.
    again = approved_pull_request(api_client, workspace, project, branch["id"])
    created = apply(api_client, workspace, project, again["id"])
    assert created.data["status"] == "applied", created.data
    assert created.data["result"]["pull_request"]["created"] is True
    assert len(github.pulls) == 2


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_m3_an_applied_ppm_pr_blocks_step_two_only_while_it_is_open(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/reopen-own")
    first = approved_pull_request(api_client, workspace, project, branch["id"])
    assert apply(api_client, workspace, project, first["id"]).data["status"] == "applied"

    blocked = api_client.post(url(workspace, project), pr_payload(branch["id"]), format="json")
    assert blocked.data["error"]["code"] == "GIT_WRITE_PULL_REQUEST_EXISTS"

    github.pulls[-1]["state"] = "closed"
    reopened = api_client.post(url(workspace, project), pr_payload(branch["id"]), format="json")
    assert reopened.status_code == status.HTTP_201_CREATED, reopened.data
    assert [item["state"] for item in reopened.data["preview"]["previous_pull_requests"]] == ["closed"]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_m1_retry_with_an_unknown_outcome_reconciles_even_after_a_source_edit(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/edited-source")
    github.lose_response("POST", r"/git/refs$")
    assert apply(api_client, workspace, project, action["id"]).data["error"]["details"]["outcome_unknown"] is True
    issue.name = "Задачу переименовали после сбоя"
    issue.save(update_fields=["name", "updated_at"])

    retried = apply(api_client, workspace, project, action["id"])

    # The approved write may already exist: the retry records it instead of hiding it behind a source conflict.
    assert retried.status_code == status.HTTP_200_OK, retried.data
    assert retried.data["status"] == "applied"
    assert retried.data["result"]["branch"]["created"] is False


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_m2_branch_names_are_rechecked_at_apply(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/checked")
    PpmGitWriteAction.objects.filter(id=action["id"]).update(head_ref="x';calc;#")
    requests_before = len(github.requests)

    refused = apply(api_client, workspace, project, action["id"])

    assert refused.status_code == status.HTTP_409_CONFLICT
    assert refused.data["error"]["code"] == "GIT_WRITE_INVALID_REF"
    assert len(github.requests) == requests_before
    assert (
        PpmGitAudit.objects.get(target_id=action["id"], action="write_action.apply_refused").metadata["reason"]
        == "INVALID_REF"
    )


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_m4_a_non_hex_head_sha_from_github_is_never_stored(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/odd-sha")
    preview = approved_pull_request(api_client, workspace, project, branch["id"])
    marker = f"<!-- ppm-write-action:{preview['id']} -->"
    github.inject(
        "POST",
        r"/pulls$",
        FakeResponse(
            201,
            {
                "id": 93001,
                "node_id": "PR_odd",
                "number": 9,
                "title": pr_payload(branch["id"])["title"],
                "body": marker,
                "html_url": "https://github.com/ppm-test-org/ppm/pull/9",
                "state": "open",
                "draft": True,
                "updated_at": "2026-09-27T01:00:00Z",
                "user": {"login": "ppm-test-app[bot]"},
                "base": {"ref": "main", "sha": github.branches["main"]},
                "head": {"ref": "gwa-1/odd-sha", "sha": "$(id)"},
            },
        ),
    )

    applied = apply(api_client, workspace, project, preview["id"])

    assert applied.data["status"] == "applied", applied.data
    assert applied.data["result"]["pull_request"]["head_sha"] == ""


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_retry_after_a_definite_refusal_never_adopts_a_branch_created_meanwhile(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    action = approved_branch(api_client, workspace, project, repository, issue, head_ref="gwa-1/after-429")
    github.inject("POST", r"/git/refs$", FakeResponse(429, {"message": "slow down"}, {"Retry-After": "60"}))
    assert apply(api_client, workspace, project, action["id"]).data["error"]["code"] == "GITHUB_RATE_LIMITED"
    # GitHub definitely refused, so nothing of ours exists; a branch that appears now is someone else's.
    github.create_foreign_branch("gwa-1/after-429")
    PpmGitWriteAction.objects.filter(id=action["id"]).update(retry_after=timezone.now() - timedelta(seconds=1))

    retried = apply(api_client, workspace, project, action["id"])

    assert retried.status_code == status.HTTP_409_CONFLICT
    assert retried.data["error"]["code"] == "GITHUB_BRANCH_CONFLICT"
    assert attempt_audits(uuid.UUID(action["id"]), 2) == [("write_action.apply_conflict", "not_performed", False)]


@override_settings(PPM_GIT_WRITE_ENABLED=True)
def test_a_pull_request_race_with_the_dead_attempt_is_reconciled_by_its_marker(api_client, git_write_project, github):
    owner, workspace, project, issue, repository, connection = git_write_project
    grant_write(connection)
    api_client.force_authenticate(user=owner)
    branch = applied_branch_with_commit(api_client, workspace, project, repository, issue, github, "gwa-1/pr-race")
    preview = approved_pull_request(api_client, workspace, project, branch["id"])
    stale_takeover_state(preview["id"], first_attempt_at=(timezone.now() - timedelta(minutes=10)).isoformat())
    marker = f"<!-- ppm-write-action:{preview['id']} -->"
    original = github.request

    def racing(method, url_value, **kwargs):
        if method == "POST" and url_value.endswith("/pulls") and not github.pulls:
            # The dead attempt's PR lands between our listing and our write (GitHub then answers 422).
            github.add_pull_request(
                head="gwa-1/pr-race",
                title=preview["preview"]["draft_pull_request"]["title"],
                body=f"текст\n\n{marker}",
                draft=True,
            )
        return original(method, url_value, **kwargs)

    github.request = racing
    raced = apply(api_client, workspace, project, preview["id"])
    github.request = original

    assert raced.status_code == status.HTTP_200_OK, raced.data
    assert raced.data["result"]["pull_request"]["created"] is False
    assert raced.data["result"]["pull_request"]["canonical_url"] == github.pulls[0]["html_url"]
    assert len(github.pulls) == 1
    assert attempt_audits(uuid.UUID(preview["id"]), 2) == [("write_action.apply_succeeded", "exists", False)]
