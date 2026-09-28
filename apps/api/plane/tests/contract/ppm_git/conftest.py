import uuid

import pytest
from django.test import override_settings

from plane.db.models import Issue, State
from plane.ppm_git.models import PpmGitConnection, PpmGitInstallation, PpmGitRepository
from plane.ppm_git.providers.github import GitHubAppClient
from plane.tests.contract.ppm_git.forgejo_fake import FORGEJO_SETTINGS, FakeForgejoApi
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


def forgejo_style_code_file_url(canonical_url, commit_sha, path):
    return f"{canonical_url.rstrip('/')}/src/commit/{commit_sha}/{path}"


@pytest.fixture
def forgejo(monkeypatch, settings):
    """G2.1 A2: PPM's Git server — the real ForgejoClient talking to an in-memory Forgejo 15 built from live answers.

    All ``PPM_FORGEJO_*`` settings are set (the provider is configured); a test clears one to switch it off. The
    registration keeps the real «configured» check and file URL layout; only the HTTP session is the fake.
    """
    from plane.ppm_git.providers import registry
    from plane.ppm_git.providers.forgejo import ForgejoClient, forgejo_code_file_url, forgejo_is_configured

    api = FakeForgejoApi.from_live()
    for name, value in FORGEJO_SETTINGS.items():
        setattr(settings, name, value)
    monkeypatch.setitem(
        registry._REGISTRY,
        "forgejo",
        registry.ProviderRegistration(
            factory=lambda **kwargs: ForgejoClient(session=api, page_size=api.page_size),
            is_configured=forgejo_is_configured,
            code_file_url=forgejo_code_file_url,
        ),
    )
    return api


@pytest.fixture
def provider_registry(monkeypatch):
    """G2.1: substitutes one Git provider registration for a single test; the registry is restored afterwards.

    ``provider_registry(provider, factory, configured=True, code_file_url=None)`` — ``factory(**kwargs)`` builds the
    client. A replaced registration keeps its file URL layout unless another one is given.
    """
    from plane.ppm_git.providers import registry

    def install(provider, factory, *, configured=True, code_file_url=None):
        key = registry.provider_key(provider)
        current = registry._REGISTRY.get(key)
        monkeypatch.setitem(
            registry._REGISTRY,
            key,
            registry.ProviderRegistration(
                factory=factory,
                is_configured=lambda: configured,
                code_file_url=code_file_url or (current.code_file_url if current else forgejo_style_code_file_url),
            ),
        )

    return install
