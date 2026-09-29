"""G2.3 G1 — поиск Git-объектов проекта для «Вставить коммит/PR»: ``GET …/git/objects/search/?q=&type=&limit=``.

Проверяется: виды запроса (название и сообщение коммита, ветка PR, начало SHA от 4 символов, номер PR «#12»/«12»),
фильтр «Коммиты / PR», подписи по-русски (дата слияния — в часовом поясе проекта, год — только не текущий), пустой
запрос (последние объекты) и лимит ≤ 20, только активные коммиты и PR подключённых репозиториев этого проекта (ветки,
неактивные объекты, архивный репозиторий и чужой проект — никогда, в том числе по подобранному SHA), права как у «Кода»
(гость проекта читает, посторонний и участник чужого проекта — 403 без данных), число запросов не растёт с числом
объектов.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone as django_timezone
from rest_framework import status

from plane.ppm_git.models import (
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitObject,
    PpmGitRepository,
    PpmGitRepositoryStatus,
)
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)


pytestmark = [pytest.mark.contract, pytest.mark.django_db]

SHA_LOGIN = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
SHA_DEPS = "b7e1d2c3a4f5061728394a5b6c7d8e9f01234567"
SHA_FOREIGN = "a1b2ffffeeee0718293a4b5c6d7e8f9012345678"  # same first four characters as SHA_LOGIN, another project
OBJECT_FIELDS = {
    "id",
    "repository_id",
    "connection_id",
    "object_type",
    "ref",
    "title",
    "canonical_url",
    "state",
    "is_draft",
    "author_name",
    "author_avatar_url",
    "base_ref",
    "head_ref",
    "commit_sha",
    "is_active",
    "provider_updated_at",
    "provider_merged_at",
    "last_seen_at",
    "label",
}


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


def search_url(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/objects/search/"


def search(api_client, env, project=None, **params):
    return api_client.get(search_url(env["workspace"], project or env["project"]), params)


def make_repository(owner, project, *, slug, provider_id):
    repository = PpmGitRepository.objects.create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        name=slug,
        normalized_name=slug,
        provider="github",
        provider_repository_id=provider_id,
        provider_full_name=f"ppm-g23/{slug}",
        canonical_url=f"https://github.com/ppm-g23/{slug}",
        clone_https=f"https://github.com/ppm-g23/{slug}.git",
        default_branch="main",
        created_by=owner.id,
        updated_by=owner.id,
    )
    installation = PpmGitInstallation.objects.create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        provider_installation_id=provider_id + 1,
        provider_account_id=provider_id + 2,
        account_login="ppm-g23",
        created_by=owner.id,
        updated_by=owner.id,
    )
    git_connection = PpmGitConnection.objects.create(
        workspace_id=project.workspace_id,
        project_id=project.id,
        installation=installation,
        repository=repository,
        provider_repository_id=provider_id,
        provider_full_name=f"ppm-g23/{slug}",
        created_by=owner.id,
        updated_by=owner.id,
    )
    return repository, git_connection


def commit(repo, *, sha, title, updated, message=None, is_active=True):
    repository, git_connection = repo
    return PpmGitObject.objects.create(
        workspace_id=repository.workspace_id,
        project_id=repository.project_id,
        connection=git_connection,
        repository=repository,
        object_type="commit",
        provider_object_id=sha,
        ref=sha[:12],
        title=title,
        canonical_url=f"{repository.canonical_url}/commit/{sha}",
        state="committed",
        author_name="dev",
        commit_sha=sha,
        metadata={"message": message if message is not None else title},
        source_version=sha,
        provider_updated_at=updated,
        is_active=is_active,
    )


def pull_request(repo, *, number, title, updated, state="open", is_draft=False, merged=None, head_ref="feature"):
    repository, git_connection = repo
    return PpmGitObject.objects.create(
        workspace_id=repository.workspace_id,
        project_id=repository.project_id,
        connection=git_connection,
        repository=repository,
        object_type="pull_request",
        provider_object_id=str(700000 + number),
        ref=str(number),
        title=title,
        canonical_url=f"{repository.canonical_url}/pull/{number}",
        state=state,
        is_draft=is_draft,
        author_name="dev",
        base_ref="main",
        head_ref=head_ref,
        commit_sha=SHA_DEPS,
        source_version=f"pr:{number}",
        provider_updated_at=updated,
        provider_merged_at=merged,
    )


def branch(repo, *, name, updated):
    repository, git_connection = repo
    return PpmGitObject.objects.create(
        workspace_id=repository.workspace_id,
        project_id=repository.project_id,
        connection=git_connection,
        repository=repository,
        object_type="branch",
        provider_object_id=name,
        ref=name,
        title=name,
        canonical_url=f"{repository.canonical_url}/tree/{name}",
        state="active",
        commit_sha=SHA_LOGIN,
        source_version=SHA_LOGIN,
        provider_updated_at=updated,
    )


@pytest.fixture
def env():
    """Project ROBOT (Moscow time) with commits, PRs of every status, a branch, an inactive commit and an archived
    repository; project OTHER of the same workspace with a commit whose SHA starts like ours and its own PR #12."""
    lead = make_user("g23-search-lead")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="ROBOT", timezone="Europe/Moscow")
    ProjectMemberFactory(workspace=workspace, project=project, member=lead, role=20)
    other = ProjectFactory(workspace=workspace, identifier="OTHER", timezone="Europe/Moscow")
    ProjectMemberFactory(workspace=workspace, project=other, member=lead, role=20)

    now = django_timezone.now()
    year = now.astimezone(timezone(timedelta(hours=3))).year
    repo = make_repository(lead, project, slug="robot", provider_id=51000)
    objects = {
        "login": commit(
            repo,
            sha=SHA_LOGIN,
            title="ROBOT-7: Исправить вход",
            message="ROBOT-7: Исправить вход\n\nСбрасываем кэш сессий после смены пароля",
            updated=now - timedelta(hours=1),
        ),
        "deps": commit(repo, sha=SHA_DEPS, title="Обновить зависимости", updated=now - timedelta(hours=2)),
        # 22:30 UTC on 14 March is already 15 March in Moscow — the label must use the project's timezone.
        "merged": pull_request(
            repo,
            number=12,
            title="ROBOT-7 — Вход через SSO",
            state="merged",
            head_ref="robot-7/sso-login",
            merged=datetime(year, 3, 14, 22, 30, tzinfo=timezone.utc),
            updated=now - timedelta(days=3),
        ),
        "old_merge": pull_request(
            repo,
            number=4,
            title="Прошлогодний релиз",
            state="merged",
            merged=datetime(year - 1, 12, 30, 9, 0, tzinfo=timezone.utc),
            updated=now - timedelta(days=300),
        ),
        "draft": pull_request(repo, number=5, title="Поиск по коду", is_draft=True, updated=now - timedelta(days=4)),
        "open": pull_request(repo, number=6, title="Экспорт отчёта", updated=now - timedelta(days=5)),
        "closed": pull_request(
            repo, number=7, title="Старый эксперимент", state="closed", updated=now - timedelta(days=6)
        ),
        "branch": branch(repo, name="robot-7/sso-login", updated=now),
        "inactive": commit(
            repo,
            sha="c" * 40,
            title="ROBOT-7: Исправить вход (переписанная история)",
            updated=now,
            is_active=False,
        ),
    }
    archived_repo = make_repository(lead, project, slug="archived", provider_id=52000)
    objects["archived"] = commit(archived_repo, sha="d" * 40, title="ROBOT-7: Исправить вход в архиве", updated=now)
    PpmGitRepository.objects.filter(id=archived_repo[0].id).update(status=PpmGitRepositoryStatus.ARCHIVED)

    foreign_repo = make_repository(lead, other, slug="other", provider_id=53000)
    objects["foreign_commit"] = commit(foreign_repo, sha=SHA_FOREIGN, title="ROBOT-7: Исправить вход", updated=now)
    objects["foreign_pr"] = pull_request(foreign_repo, number=12, title="Чужой PR", updated=now)
    return {
        "lead": lead,
        "workspace": workspace,
        "project": project,
        "other": other,
        "repo": repo,
        "objects": objects,
        "now": now,
        "year": year,
    }


def ids(response):
    return [item["id"] for item in response.data["results"]]


def ref(env, *names):
    return [str(env["objects"][name].id) for name in names]


def test_text_query_matches_title_commit_message_and_pull_request_branch(api_client, env):
    api_client.force_authenticate(user=env["lead"])

    by_title = search(api_client, env, q="исправить ВХОД")
    by_message = search(api_client, env, q="кэш сессий")
    by_branch = search(api_client, env, q="sso-login")

    assert by_title.status_code == status.HTTP_200_OK
    # Only this project's active objects of connected repositories: not the inactive commit, not the archived
    # repository, not project OTHER's commit with the same message.
    assert ids(by_title) == ref(env, "login")
    assert ids(by_message) == ref(env, "login")
    # The branch of a PR finds the PR; the branch object itself is never offered (only commits and PRs are inserted).
    assert ids(by_branch) == ref(env, "merged")


def test_sha_prefix_from_four_characters_only_in_this_project(api_client, env):
    api_client.force_authenticate(user=env["lead"])

    four = search(api_client, env, q="a1b2")
    upper = search(api_client, env, q="A1B2C3D")
    three = search(api_client, env, q="a1b")
    full_foreign = search(api_client, env, q=SHA_FOREIGN)
    with_nul = search(api_client, env, q="\x00a1b2")

    assert ids(four) == ref(env, "login")
    assert with_nul.status_code == status.HTTP_200_OK
    assert ids(with_nul) == ref(env, "login")
    assert ids(upper) == ref(env, "login")
    assert ids(three) == []
    # A guessed SHA of another project's object finds nothing, although the viewer can read that project too.
    assert ids(full_foreign) == []


def test_pull_request_number_with_or_without_hash_comes_first(api_client, env):
    api_client.force_authenticate(user=env["lead"])
    # Newer objects whose text merely contains «12» must not push PR #12 out of the list.
    for index in range(3):
        commit(
            env["repo"],
            sha=f"{index}e" + "0" * 38,
            title=f"Поднять лимит до 12{index} МБ",
            updated=env["now"],
        )

    with_hash = search(api_client, env, q="#12")
    without_hash = search(api_client, env, q="12")
    pull_requests_only = search(api_client, env, q="12", type="pull_request")

    assert ids(with_hash) == ref(env, "merged")
    assert ids(without_hash)[0] == str(env["objects"]["merged"].id)
    assert len(ids(without_hash)) == 4
    assert ids(pull_requests_only) == ref(env, "merged")


def test_type_filter_labels_and_fields(api_client, env):
    api_client.force_authenticate(user=env["lead"])

    commits = search(api_client, env, type="commit")
    pull_requests = search(api_client, env, type="pull_request")
    unknown = search(api_client, env, type="branch")

    assert commits.status_code == status.HTTP_200_OK
    assert ids(commits) == ref(env, "login", "deps")
    assert ids(pull_requests) == ref(env, "merged", "draft", "open", "closed", "old_merge")
    assert set(commits.data["results"][0]) == OBJECT_FIELDS
    labels = {item["id"]: item["label"] for item in [*commits.data["results"], *pull_requests.data["results"]]}
    objects = env["objects"]
    assert labels[str(objects["login"].id)] == "коммит a1b2c3d «ROBOT-7: Исправить вход»"
    assert labels[str(objects["merged"].id)] == "PR #12 «ROBOT-7 — Вход через SSO» · Слит 15 мар."
    assert labels[str(objects["old_merge"].id)] == f"PR #4 «Прошлогодний релиз» · Слит 30 дек. {env['year'] - 1}"
    assert labels[str(objects["draft"].id)] == "PR #5 «Поиск по коду» · Черновик"
    assert labels[str(objects["open"].id)] == "PR #6 «Экспорт отчёта» · Открыт"
    assert labels[str(objects["closed"].id)] == "PR #7 «Старый эксперимент» · Закрыт"
    assert unknown.status_code == status.HTTP_400_BAD_REQUEST
    assert unknown.data["error"]["code"] == "GIT_OBJECT_SEARCH_INVALID"
    assert "results" not in unknown.data


def test_long_commit_message_is_cut_to_72_characters(api_client, env):
    api_client.force_authenticate(user=env["lead"])
    long_title = "ROBOT-9: " + "очень длинное сообщение коммита " * 5
    long_commit = commit(env["repo"], sha="e" * 40, title=long_title.strip(), updated=env["now"])

    response = search(api_client, env, q="ROBOT-9")

    [item] = response.data["results"]
    quoted = item["label"].split("«", 1)[1].rstrip("»")
    assert item["id"] == str(long_commit.id)
    assert item["label"].startswith("коммит eeeeeee «ROBOT-9: очень длинное")
    assert len(quoted) == 72
    assert quoted.endswith("…")
    assert item["title"] == long_title.strip()


def test_empty_query_returns_recent_objects_and_limit_is_at_most_20(api_client, env):
    api_client.force_authenticate(user=env["lead"])

    recent = search(api_client, env)
    blank = search(api_client, env, q="   ")
    two = search(api_client, env, limit=2)
    for index in range(25):
        commit(env["repo"], sha=f"{index:02d}f" + "0" * 37, title=f"Коммит {index}", updated=env["now"])
    too_many = search(api_client, env, limit=500)
    default = search(api_client, env)
    garbage = search(api_client, env, limit="много")

    # Freshest first (`provider_updated_at`), commits and PRs only.
    assert ids(recent) == ref(env, "login", "deps", "merged", "draft", "open", "closed", "old_merge")
    assert ids(blank) == ids(recent)
    assert ids(two) == ref(env, "login", "deps")
    assert len(ids(too_many)) == 20
    assert len(ids(default)) == 20
    assert len(ids(garbage)) == 20


def test_other_project_guest_and_outsider(api_client, env):
    workspace, project = env["workspace"], env["project"]
    robot_member = make_user("g23-search-robot-member")
    WorkspaceMemberFactory(workspace=workspace, member=robot_member, role=15)
    ProjectMemberFactory(workspace=workspace, project=project, member=robot_member, role=15)
    guest = make_user("g23-search-guest")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    workspace_guest = make_user("g23-search-workspace-guest")
    WorkspaceMemberFactory(workspace=workspace, member=workspace_guest, role=5)
    outsider = make_user("g23-search-outsider")

    api_client.force_authenticate(user=robot_member)
    own = search(api_client, env, q="12")
    foreign = search(api_client, env, project=env["other"], q=SHA_FOREIGN)
    api_client.force_authenticate(user=guest)
    guest_reads = search(api_client, env, q="a1b2")
    api_client.force_authenticate(user=workspace_guest)
    not_in_project = search(api_client, env, q="a1b2")
    api_client.force_authenticate(user=outsider)
    stranger = search(api_client, env, q="a1b2")
    api_client.force_authenticate(user=None)
    anonymous = search(api_client, env, q="a1b2")

    assert own.status_code == status.HTTP_200_OK
    assert str(env["objects"]["foreign_pr"].id) not in ids(own)
    # «Код» of a project the person is not a member of: 403 and nothing about its objects.
    for denied in (foreign, not_in_project, stranger):
        assert denied.status_code == status.HTTP_403_FORBIDDEN
        assert denied.data["error"]["code"] == "GIT_PERMISSION_DENIED"
        assert "results" not in denied.data
        assert SHA_FOREIGN not in str(denied.data)
    # A project guest reads «Код» (as `GET …/git/`), so the search answers too.
    assert guest_reads.status_code == status.HTTP_200_OK
    assert ids(guest_reads) == ref(env, "login")
    assert anonymous.status_code == status.HTTP_401_UNAUTHORIZED


def test_query_count_does_not_grow_with_results(api_client, env):
    api_client.force_authenticate(user=env["lead"])
    search(api_client, env, q="a1b2")  # warm-up: the first request of a test may load caches

    with CaptureQueriesContext(connection) as one:
        single = search(api_client, env, q="a1b2")
    for index in range(12):
        commit(env["repo"], sha=f"a1b2{index:02d}" + "0" * 34, title=f"Ещё коммит {index}", updated=env["now"])
    with CaptureQueriesContext(connection) as many:
        several = search(api_client, env, q="a1b2")

    assert len(ids(single)) == 1
    assert len(ids(several)) == 13
    assert len(many.captured_queries) == len(one.captured_queries)
