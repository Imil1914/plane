"""G2.1 M-1/M-5: серверные ответы отдают настоящее время слияния PR (`PpmGitObject.provider_merged_at`)
для надписи «Слит 28 сент., 14:05» — `serialize_git_object` (раздел «Код», поле `objects`) и `serialize_link`
(блок Git задачи, поле `links`, имя `git_object_merged_at` — в стиле соседнего `git_object_state`).

Время есть только у слитого PR; у открытых/закрытых PR, веток и коммитов — `null`. Читается вместе с объектом,
который уже выбран через `select_related` — без дополнительного запроса на строку (см.
`test_pull_request_merged_at.py` для нормализации/upsert на уровне модели — этот файл проверяет сериализацию
и HTTP-ответ «Код»)."""

import uuid
from datetime import datetime, timezone

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework import status

from plane.db.models import Issue, State
from plane.ppm_git.models import (
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitLinkOrigin,
    PpmGitObject,
    PpmGitRepository,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

MERGED_AT = datetime(2026, 9, 28, 14, 5, tzinfo=timezone.utc)


def make_user(prefix="git-merged-api"):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


def git_url(workspace, project, suffix=""):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/{suffix}"


@pytest.fixture
def git_project():
    owner = make_user()
    workspace = WorkspaceFactory(owner=owner)
    WorkspaceMemberFactory(workspace=workspace, member=owner, role=20)
    project = ProjectFactory(workspace=workspace, identifier="MRG")
    ProjectMemberFactory(workspace=workspace, project=project, member=owner, role=20)
    state = State.objects.create(
        name="Backlog",
        color="#60646C",
        group="backlog",
        default=True,
        project=project,
        created_by=owner,
    )
    issue = Issue(name="Проверить дату слияния", project=project, state=state)
    issue.save(created_by_id=owner.id)
    return owner, workspace, project, issue


def make_repository(owner, workspace, project):
    return PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name="PPM",
        normalized_name="ppm",
        provider="github",
        provider_repository_id=90001,
        provider_full_name="Imil1914/PPM",
        canonical_url="https://github.com/Imil1914/PPM",
        clone_https="https://github.com/Imil1914/PPM.git",
        default_branch="main",
        created_by=owner.id,
        updated_by=owner.id,
    )


def make_connection(owner, workspace, project, repository):
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider_installation_id=4101,
        provider_account_id=4201,
        account_login="Imil1914",
        created_by=owner.id,
        updated_by=owner.id,
    )
    return PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=4301,
        provider_full_name="Imil1914/PPM",
        created_by=owner.id,
        updated_by=owner.id,
    )


def make_git_object(repository, git_connection, *, object_type, number, state="", provider_merged_at=None):
    ref = str(number) if object_type == "pull_request" else f"feature-{number}"
    return PpmGitObject.objects.create(
        workspace_id=repository.workspace_id,
        project_id=repository.project_id,
        connection=git_connection,
        repository=repository,
        object_type=object_type,
        provider_object_id=str(6000 + number),
        ref=ref,
        title=f"Объект {number}",
        canonical_url=f"https://github.com/Imil1914/PPM/pull/{number}",
        state=state,
        provider_merged_at=provider_merged_at,
        source_version=f"obj:{number}",
    )


def make_link(repository, issue, git_object):
    return PpmGitLink.objects.create(
        workspace_id=repository.workspace_id,
        project_id=repository.project_id,
        repository=repository,
        git_object=git_object,
        work_item=issue,
        object_type=git_object.object_type,
        ref=git_object.ref,
        title=git_object.title,
        canonical_url=git_object.canonical_url,
        origin=PpmGitLinkOrigin.PROVIDER,
        created_by=repository.created_by,
        updated_by=repository.created_by,
    )


def test_overview_objects_and_links_carry_the_merge_time_only_for_merged_pull_requests(api_client, git_project):
    owner, workspace, project, issue = git_project
    repository = make_repository(owner, workspace, project)
    git_connection = make_connection(owner, workspace, project, repository)

    merged_pr = make_git_object(
        repository,
        git_connection,
        object_type="pull_request",
        number=1,
        state="merged",
        provider_merged_at=MERGED_AT,
    )
    open_pr = make_git_object(repository, git_connection, object_type="pull_request", number=2, state="open")
    closed_pr = make_git_object(repository, git_connection, object_type="pull_request", number=3, state="closed")
    branch = make_git_object(repository, git_connection, object_type="branch", number=4)
    commit = make_git_object(repository, git_connection, object_type="commit", number=5)
    merged_link = make_link(repository, issue, merged_pr)
    open_link = make_link(repository, issue, open_pr)
    manual_link = PpmGitLink.objects.create(
        workspace_id=repository.workspace_id,
        project_id=repository.project_id,
        repository=repository,
        git_object=None,
        work_item=issue,
        object_type="pull_request",
        ref="99",
        title="Ручная ссылка",
        canonical_url="https://github.com/Imil1914/PPM/pull/99",
        origin=PpmGitLinkOrigin.MANUAL,
        created_by=repository.created_by,
        updated_by=repository.created_by,
    )

    api_client.force_authenticate(user=owner)
    response = api_client.get(git_url(workspace, project))

    assert response.status_code == status.HTTP_200_OK
    objects_by_id = {item["id"]: item["provider_merged_at"] for item in response.data["objects"]}
    assert objects_by_id[str(merged_pr.id)] == MERGED_AT.isoformat()
    assert objects_by_id[str(open_pr.id)] is None
    assert objects_by_id[str(closed_pr.id)] is None
    assert objects_by_id[str(branch.id)] is None
    assert objects_by_id[str(commit.id)] is None

    links_by_id = {item["id"]: item["git_object_merged_at"] for item in response.data["links"]}
    assert links_by_id[str(merged_link.id)] == MERGED_AT.isoformat()
    assert links_by_id[str(open_link.id)] is None
    # Ручная ссылка без Git-объекта — время неизвестно, а не ошибка.
    assert links_by_id[str(manual_link.id)] is None

    # Тот же список отдаёт и выделенный эндпоинт связей (блок Git задачи использует его напрямую).
    links_response = api_client.get(git_url(workspace, project, "links/"))
    assert links_response.status_code == status.HTTP_200_OK
    assert {item["id"]: item["git_object_merged_at"] for item in links_response.data["links"]} == links_by_id


def test_links_carry_the_merge_time_without_a_query_per_link(api_client, git_project):
    owner, workspace, project, issue = git_project
    repository = make_repository(owner, workspace, project)
    git_connection = make_connection(owner, workspace, project, repository)
    for number in range(1, 4):
        make_link(
            repository,
            issue,
            make_git_object(
                repository,
                git_connection,
                object_type="pull_request",
                number=number,
                state="merged",
                provider_merged_at=MERGED_AT,
            ),
        )
    api_client.force_authenticate(user=owner)

    with CaptureQueriesContext(connection) as few_queries:
        few = api_client.get(git_url(workspace, project, "links/"))
    with CaptureQueriesContext(connection) as overview_few_queries:
        overview_few = api_client.get(git_url(workspace, project))
    for number in range(4, 9):
        make_link(
            repository,
            issue,
            make_git_object(
                repository,
                git_connection,
                object_type="pull_request",
                number=number,
                state="merged",
                provider_merged_at=MERGED_AT,
            ),
        )
    with CaptureQueriesContext(connection) as many_queries:
        many = api_client.get(git_url(workspace, project, "links/"))
    with CaptureQueriesContext(connection) as overview_many_queries:
        overview_many = api_client.get(git_url(workspace, project))

    assert few.status_code == status.HTTP_200_OK
    assert all(item["git_object_merged_at"] == MERGED_AT.isoformat() for item in few.data["links"])
    assert len(many.data["links"]) == len(few.data["links"]) + 5
    # Время слияния читается вместе со связью (select_related("git_object")) — без запроса на каждую строку.
    assert len(many_queries.captured_queries) == len(few_queries.captured_queries)
    assert len(overview_many_queries.captured_queries) == len(overview_few_queries.captured_queries)
    assert overview_few.status_code == status.HTTP_200_OK
    assert overview_many.status_code == status.HTTP_200_OK
