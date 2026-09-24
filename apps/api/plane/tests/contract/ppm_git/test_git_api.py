import uuid

import pytest
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_git.models import PpmGitAudit, PpmGitLink, PpmGitRepository
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def make_user(prefix="git"):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


@pytest.fixture
def git_project():
    owner = make_user("git-owner")
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    project = ProjectFactory(workspace=workspace, identifier="GIT")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=owner,
    )
    issue = Issue(name="Связать Git", project=project, state=state)
    issue.save(created_by_id=owner.id)
    return owner, workspace, project, issue


def authenticate(api_client, user):
    api_client.force_authenticate(user=user)


def git_url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/{suffix}"


def repository_payload(**overrides):
    payload = {
        "name": "PPM",
        "provider": "github",
        "canonical_url": "https://github.com/Imil1914/PPM",
        "clone_https": "https://github.com/Imil1914/PPM.git",
        "clone_ssh": "git@github.com:Imil1914/PPM.git",
        "default_branch": "main",
        "visibility": "public",
        "is_default": False,
    }
    payload.update(overrides)
    return payload


def create_repository(api_client, workspace, project, **overrides):
    return api_client.post(
        git_url(workspace, project, "repositories/"),
        repository_payload(**overrides),
        format="json",
    )


def link_payload(repository_id, issue, **overrides):
    payload = {
        "repository_id": repository_id,
        "work_item_id": str(issue.id),
        "object_type": "pull_request",
        "ref": "42",
        "title": "GIT-1 — Git integration",
        "canonical_url": "https://github.com/Imil1914/PPM/pull/42",
    }
    payload.update(overrides)
    return payload


def response_keys(value):
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in response_keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in response_keys(item)}
    return set()


def test_repository_crud_default_constraints_and_audit(api_client, git_project):
    owner, workspace, project, _ = git_project
    authenticate(api_client, owner)

    first = create_repository(api_client, workspace, project)
    duplicate = create_repository(api_client, workspace, project, canonical_url="https://github.com/Imil1914/PPM.git")
    second = create_repository(
        api_client,
        workspace,
        project,
        name="Docs",
        provider="gitlab",
        canonical_url="https://gitlab.com/Imil1914/ppm-docs",
        clone_https="https://gitlab.com/Imil1914/ppm-docs.git",
        clone_ssh="git@gitlab.com:Imil1914/ppm-docs.git",
        is_default=True,
    )
    listing = api_client.get(git_url(workspace, project))

    assert first.status_code == status.HTTP_201_CREATED
    assert first.data["is_default"] is True
    assert duplicate.status_code == status.HTTP_409_CONFLICT
    assert second.status_code == status.HTTP_201_CREATED
    assert second.data["is_default"] is True
    assert PpmGitRepository.objects.get(id=first.data["id"]).is_default is False
    assert listing.status_code == status.HTTP_200_OK
    assert [item["id"] for item in listing.data["repositories"]] == [second.data["id"], first.data["id"]]
    assert listing.data["conventions"]["branch"] == "<WORK_ITEM_KEY>/<short-slug>"

    changed = api_client.patch(
        git_url(workspace, project, f"repositories/{first.data['id']}/"),
        {"is_default": True, "default_branch": "development"},
        format="json",
    )
    archived = api_client.delete(git_url(workspace, project, f"repositories/{first.data['id']}/"))

    assert changed.status_code == status.HTTP_200_OK
    assert changed.data["default_branch"] == "development"
    assert archived.status_code == status.HTTP_204_NO_CONTENT
    assert PpmGitRepository.objects.get(id=second.data["id"]).is_default is True
    assert set(PpmGitAudit.objects.values_list("action", flat=True)) == {
        "repository.create",
        "repository.update",
        "repository.archive",
    }


def test_member_links_work_item_guest_is_read_only_and_outsider_is_denied(api_client, git_project):
    owner, workspace, project, issue = git_project
    member = make_user("git-member")
    guest = make_user("git-guest")
    outsider = make_user("git-outsider")
    WorkspaceMemberFactory(workspace=workspace, member=member, role=15)
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)

    authenticate(api_client, owner)
    repository = create_repository(api_client, workspace, project)
    authenticate(api_client, member)
    member_read = api_client.get(git_url(workspace, project))
    member_repo_write = create_repository(
        api_client,
        workspace,
        project,
        name="Forbidden",
        canonical_url="https://github.com/Imil1914/forbidden",
        clone_https="https://github.com/Imil1914/forbidden.git",
        clone_ssh="git@github.com:Imil1914/forbidden.git",
    )
    linked = api_client.post(
        git_url(workspace, project, "links/"),
        link_payload(repository.data["id"], issue),
        format="json",
    )

    assert member_read.status_code == status.HTTP_200_OK
    assert member_read.data["capabilities"] == {
        "read": True,
        "manage_repositories": False,
        "manage_links": True,
        "manage_provider": False,
        "manage_write_actions": True,
    }
    assert member_repo_write.status_code == status.HTTP_403_FORBIDDEN
    assert linked.status_code == status.HTTP_201_CREATED
    assert linked.data["work_item"]["identifier"] == f"GIT-{issue.sequence_id}"

    authenticate(api_client, guest)
    guest_read = api_client.get(git_url(workspace, project))
    guest_write = api_client.post(
        git_url(workspace, project, "links/"),
        link_payload(repository.data["id"], issue, ref="43", canonical_url="https://github.com/Imil1914/PPM/pull/43"),
        format="json",
    )
    assert guest_read.status_code == status.HTTP_200_OK
    assert guest_read.data["capabilities"]["manage_links"] is False
    assert guest_write.status_code == status.HTTP_403_FORBIDDEN

    authenticate(api_client, outsider)
    assert api_client.get(git_url(workspace, project)).status_code == status.HTTP_403_FORBIDDEN

    authenticate(api_client, member)
    unlinked = api_client.delete(git_url(workspace, project, f"links/{linked.data['id']}/"))
    assert unlinked.status_code == status.HTTP_204_NO_CONTENT
    assert PpmGitLink.objects.get(id=linked.data["id"]).status == "unlinked"
    assert PpmGitRepository.objects.filter(id=repository.data["id"], status="active").exists()


def test_cross_project_work_item_and_foreign_git_object_are_rejected(api_client, git_project):
    owner, workspace, project, issue = git_project
    other_project = ProjectFactory(workspace=workspace, identifier="OUT")
    ProjectMemberFactory(workspace=workspace, project=other_project, member=owner, role=20)
    other_state = State.objects.create(
        name="Other",
        color="#60646C",
        group="backlog",
        default=True,
        project=other_project,
        created_by=owner,
    )
    other_issue = Issue(name="Чужая задача", project=other_project, state=other_state)
    other_issue.save(created_by_id=owner.id)
    authenticate(api_client, owner)
    repository = create_repository(api_client, workspace, project)

    cross_project = api_client.post(
        git_url(workspace, project, "links/"),
        link_payload(repository.data["id"], other_issue),
        format="json",
    )
    foreign_url = api_client.post(
        git_url(workspace, project, "links/"),
        link_payload(repository.data["id"], issue, canonical_url="https://github.com/other/repo/pull/42"),
        format="json",
    )

    assert cross_project.status_code == status.HTTP_404_NOT_FOUND
    assert cross_project.data["error"]["code"] == "GIT_WORK_ITEM_NOT_FOUND"
    assert foreign_url.status_code == status.HTTP_400_BAD_REQUEST
    assert foreign_url.data["error"]["code"] == "GIT_URL_SCOPE_MISMATCH"
    assert not PpmGitLink.objects.exists()


@pytest.mark.parametrize(
    ("overrides", "expected_code"),
    [
        ({"canonical_url": "http://github.com/Imil1914/PPM"}, "GIT_INVALID_URL"),
        ({"canonical_url": "https://token@github.com/Imil1914/PPM"}, "GIT_INVALID_URL"),
        ({"canonical_url": "https://github.com/Imil1914/PPM?token=secret"}, "GIT_INVALID_URL"),
        ({"canonical_url": "https://localhost/Imil1914/PPM"}, "GIT_UNSAFE_URL"),
        ({"canonical_url": "https://10.0.0.1/Imil1914/PPM"}, "GIT_UNSAFE_URL"),
        ({"clone_https": "https://github.com/other/repo.git"}, "GIT_URL_SCOPE_MISMATCH"),
        ({"clone_ssh": "git@github.com:other/repo.git"}, "GIT_URL_SCOPE_MISMATCH"),
        ({"token": "secret-value"}, "GIT_CREDENTIALS_FORBIDDEN"),
    ],
)
def test_repository_input_rejects_unsafe_urls_and_credentials(api_client, git_project, overrides, expected_code):
    owner, workspace, project, _ = git_project
    authenticate(api_client, owner)

    response = create_repository(api_client, workspace, project, **overrides)

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.data["error"]["code"] == expected_code
    assert "secret-value" not in str(response.data)
    assert not PpmGitRepository.objects.exists()


def test_global_admin_can_manage_without_project_membership_and_responses_have_no_credentials(api_client, git_project):
    _, workspace, project, _ = git_project
    global_admin = make_user("git-global")
    PpmGlobalAdmin.objects.create(user=global_admin, reason="Contract test")
    authenticate(api_client, global_admin)

    repository = create_repository(api_client, workspace, project)
    overview = api_client.get(git_url(workspace, project))

    assert repository.status_code == status.HTTP_201_CREATED
    assert overview.status_code == status.HTTP_200_OK
    assert overview.data["capabilities"]["manage_repositories"] is True
    forbidden_keys = {"token", "password", "private_key", "secret", "credentials"}
    assert response_keys(overview.data).isdisjoint(forbidden_keys)
    assert PpmGitAudit.objects.filter(actor_id=global_admin.id, action="repository.create").exists()
