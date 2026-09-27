import uuid

import pytest
from django.test import override_settings

from plane.db.models import Issue, State
from plane.ppm_git.models import PpmGitConnection, PpmGitInstallation, PpmGitRepository
from plane.ppm_git.providers.github import GitHubAppClient
from plane.tests.contract.ppm_git.github_fake import FakeGitHubApi
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


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


@pytest.fixture
def github(monkeypatch):
    """Mock provider: the real GitHubAppClient talking to an in-memory GitHub; nothing leaves the process."""
    api = FakeGitHubApi()
    monkeypatch.setattr("plane.ppm_git.write_actions.GitHubAppClient", lambda: GitHubAppClient(session=api))
    monkeypatch.setattr(GitHubAppClient, "_app_jwt", lambda self: "fake-app-jwt")
    with override_settings(PPM_GITHUB_APP_CONFIGURED=True, PPM_GITHUB_APP_SLUG="ppm-test-app"):
        yield api
