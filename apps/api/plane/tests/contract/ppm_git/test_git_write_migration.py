"""G1.3 (RC-C): the two-stage migration closes open legacy proposals reversibly and never touches other rows."""

import importlib
import uuid

import pytest
from django.apps import apps

from plane.ppm_git.models import PpmGitWriteAction, PpmGitWriteActionStatus


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

migration = importlib.import_module("plane.ppm_git.migrations.0007_git_write_two_stage")


def make_action(project_bundle, *, action_type, status, error_code="", error_message="", result=None):
    owner, workspace, project, issue, repository, connection = project_bundle
    return PpmGitWriteAction.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        repository=repository,
        connection=connection,
        work_item=issue,
        action_type=action_type,
        status=status,
        client_operation_id=uuid.uuid4(),
        request_fingerprint="0" * 64,
        repository_updated_at=repository.updated_at,
        connection_updated_at=connection.updated_at,
        work_item_updated_at=issue.updated_at,
        base_ref="main",
        head_ref=f"gwa-1/{uuid.uuid4().hex[:8]}",
        title="Legacy",
        preview={},
        result=result or {},
        error_code=error_code,
        error_message=error_message,
        created_by=owner.id,
    )


def test_open_legacy_proposals_are_closed_and_restored_by_the_reverse_migration(git_write_project):
    legacy = "create_branch_draft_pr"
    proposed = make_action(git_write_project, action_type=legacy, status=PpmGitWriteActionStatus.PROPOSED)
    approved = make_action(
        git_write_project, action_type=legacy, status=PpmGitWriteActionStatus.APPROVED, result={"note": "kept"}
    )
    rejected = make_action(git_write_project, action_type=legacy, status=PpmGitWriteActionStatus.REJECTED)
    conflict = make_action(
        git_write_project,
        action_type=legacy,
        status=PpmGitWriteActionStatus.CONFLICT,
        error_code="GIT_WRITE_SOURCE_CHANGED",
    )
    new_flow = make_action(git_write_project, action_type="create_branch", status=PpmGitWriteActionStatus.APPROVED)
    with_error = make_action(
        git_write_project,
        action_type=legacy,
        status=PpmGitWriteActionStatus.APPROVED,
        error_code="OLD_NOTE",
        error_message="Старая пометка",
    )

    migration.close_open_legacy_proposals(apps, None)

    for action in (proposed, approved):
        action.refresh_from_db()
        assert action.status == PpmGitWriteActionStatus.CANCELLED
        assert action.error_code == "GIT_WRITE_FLOW_SUPERSEDED"
        assert "подготовьте новый предпросмотр ветки" in action.error_message
    assert proposed.result == {"superseded_from_status": "proposed"}
    assert approved.result == {"note": "kept", "superseded_from_status": "approved"}
    for action, expected in ((rejected, "rejected"), (conflict, "conflict"), (new_flow, "approved")):
        action.refresh_from_db()
        assert action.status == expected

    with_error.refresh_from_db()
    assert with_error.error_code == "GIT_WRITE_FLOW_SUPERSEDED"
    assert with_error.result["superseded_from_error"] == {"code": "OLD_NOTE", "message": "Старая пометка"}

    migration.reopen_legacy_proposals(apps, None)

    proposed.refresh_from_db()
    approved.refresh_from_db()
    conflict.refresh_from_db()
    assert (proposed.status, proposed.error_code, proposed.error_message, proposed.result) == ("proposed", "", "", {})
    assert (approved.status, approved.result) == ("approved", {"note": "kept"})
    assert (conflict.status, conflict.error_code) == ("conflict", "GIT_WRITE_SOURCE_CHANGED")
    with_error.refresh_from_db()
    assert (with_error.status, with_error.error_code, with_error.error_message, with_error.result) == (
        "approved",
        "OLD_NOTE",
        "Старая пометка",
        {},
    )
