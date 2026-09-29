"""G2.2 S2a: migration 0009 is additive; unapplying it gives the engine's system audit rows the zero UUID first, so the
audit columns can require an actor, a workspace and a project again. Other rows are never touched."""

import importlib
import uuid

import pytest
from django.apps import apps

from plane.ppm_git.models import PpmGitAudit


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

migration = importlib.import_module("plane.ppm_git.migrations.0009_forgejo_access")


def test_reverse_step_fills_only_the_empty_audit_fields():
    person, workspace, project = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    human = PpmGitAudit.objects.create(
        workspace_id=workspace,
        project_id=project,
        actor_id=person,
        action="forgejo.repository.connect",
        target_type="repository",
        request_id=uuid.uuid4(),
    )
    system = PpmGitAudit.objects.create(
        workspace_id=None,
        project_id=None,
        actor_id=None,
        action="forgejo.access.account_created",
        target_type="forgejo_account",
        request_id=uuid.uuid4(),
    )

    migration.restore_required_audit_fields(apps, None)

    human.refresh_from_db()
    system.refresh_from_db()
    assert (human.workspace_id, human.project_id, human.actor_id) == (workspace, project, person)
    assert (system.workspace_id, system.project_id, system.actor_id) == (uuid.UUID(int=0),) * 3
