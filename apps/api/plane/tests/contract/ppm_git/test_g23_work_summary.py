"""G2.3 G2 — сводка «Что сделано за период»: ``GET …/git/work-summary/?from=YYYY-MM-DD&to=YYYY-MM-DD``.

Проверяется: задачи проекта, сменившие статус за период (границы — сутки в часовом поясе проекта, включительно:
закрыта в воскресенье в 23:30 по Москве — в неделе, в понедельник в 00:30 по Москве — в следующей), их итоговый статус
на конец периода и группа, коммиты и PR этих задач за период (слит в периоде / открыт и живой в периоде), задачи без
Git, коммит без задачи и Git задачи без смены статуса не попадают, итоги, готовый текст markdown и HTML по-русски
(только безопасные теги, всё экранировано, ссылки — только на задачи и Git-объекты этого проекта), ограничение 92 дня,
права (как чтение «Кода»; ограниченный гость — только свои задачи), число запросов не растёт с числом задач.
"""

import uuid
from datetime import date, datetime, timedelta, timezone
from html import escape as html_escape
from html.parser import HTMLParser

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone as django_timezone
from rest_framework import status

from plane.db.models import Issue, IssueActivity, Project, State
from plane.ppm_git import work_summary
from plane.ppm_git.models import (
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitLink,
    PpmGitLinkOrigin,
    PpmGitLinkStatus,
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

MSK = timezone(timedelta(hours=3))
WEEK = {"from": "2026-09-22", "to": "2026-09-28"}  # Monday … Sunday
BASE = "https://ppm.example.ru"
SAFE_TAGS = {"h3", "p", "ul", "li", "a", "strong"}


def msk(day, hour, minute=0, month=9):
    return datetime(2026, month, day, hour, minute, tzinfo=MSK)


def make_user(prefix):
    marker = uuid.uuid4().hex
    return UserFactory(username=f"{prefix}-{marker}", email=f"{prefix}-{marker}@plane.test")


def summary_url(workspace, project):
    return f"/api/ppm/v1/workspaces/{workspace.id}/projects/{project.id}/git/work-summary/"


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


def make_states(project, owner):
    def state(name, group, **extra):
        return State.objects.create(name=name, color="#60646C", group=group, project=project, created_by=owner, **extra)

    return {
        "backlog": state("Бэклог", "backlog", default=True),
        "started": state("В работе", "started"),
        "review": state("На ревью", "started"),
        "done": state("Готово", "completed"),
        "cancelled": state("Отменена", "cancelled"),
    }


def task(env, name, state, *, creator=None, project=None):
    target = env["states"][state] if project is None else state
    issue = Issue(name=name, project=project or env["project"], state=target)
    issue.save(created_by_id=(creator or env["lead"]).id)
    return issue


def state_change(env, issue, moment, state, *, project=None, field="state"):
    target = env["states"][state] if project is None else state
    row = IssueActivity.objects.create(
        issue=issue,
        project=project or env["project"],
        workspace=env["workspace"],
        verb="updated",
        field=field,
        old_value="Бэклог",
        new_value=target.name,
        new_identifier=target.id,
        actor=env["lead"],
        epoch=moment.timestamp(),
        comment="",
    )
    IssueActivity.objects.filter(id=row.id).update(created_at=moment)
    return row


def git_commit(repo, sha, title, authored):
    repository, git_connection = repo
    git_object = PpmGitObject.objects.create(
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
        commit_sha=sha,
        metadata={"message": title},
        source_version=sha,
        provider_updated_at=authored,
    )
    PpmGitObject.objects.filter(id=git_object.id).update(first_seen_at=authored)
    git_object.refresh_from_db()
    return git_object


def git_pull_request(repo, number, title, *, state, first_seen, updated, merged=None, is_draft=False):
    repository, git_connection = repo
    git_object = PpmGitObject.objects.create(
        workspace_id=repository.workspace_id,
        project_id=repository.project_id,
        connection=git_connection,
        repository=repository,
        object_type="pull_request",
        provider_object_id=str(800000 + number),
        ref=str(number),
        title=title,
        canonical_url=f"{repository.canonical_url}/pull/{number}",
        state=state,
        is_draft=is_draft,
        base_ref="main",
        head_ref=f"robot-{number}",
        source_version=f"pr:{number}",
        provider_updated_at=updated,
        provider_merged_at=merged,
    )
    PpmGitObject.objects.filter(id=git_object.id).update(first_seen_at=first_seen)
    git_object.refresh_from_db()
    return git_object


def link(env, issue, git_object, *, repo=None, status_value=PpmGitLinkStatus.ACTIVE, project=None):
    repository = (repo or env["repo"])[0]
    return PpmGitLink.objects.create(
        workspace_id=env["workspace"].id,
        project_id=(project or env["project"]).id,
        repository=repository,
        git_object=git_object,
        work_item=issue,
        object_type=git_object.object_type,
        ref=git_object.ref,
        title=git_object.title[:255],
        canonical_url=git_object.canonical_url,
        status=status_value,
        origin=PpmGitLinkOrigin.PROVIDER,
        created_by=env["lead"].id,
        updated_by=env["lead"].id,
    )


@pytest.fixture
def env(settings):
    settings.APP_BASE_URL = None
    settings.WEB_URL = BASE
    lead = make_user("g23-summary-lead")
    workspace = WorkspaceFactory(owner=lead)
    WorkspaceMemberFactory(workspace=workspace, member=lead, role=20)
    project = ProjectFactory(workspace=workspace, identifier="ROBOT", timezone="Europe/Moscow")
    ProjectMemberFactory(workspace=workspace, project=project, member=lead, role=20)
    data = {"lead": lead, "workspace": workspace, "project": project}
    data["states"] = make_states(project, lead)
    data["repo"] = make_repository(lead, project, slug="robot", provider_id=61000)
    return data


@pytest.fixture
def week(env):
    """The sample week of the G2.3 card: tasks around the week's borders in Moscow time, their commits and PRs."""
    repo = env["repo"]
    items = {}
    # ROBOT-1: in progress on Wednesday, done on Sunday at 23:30 Moscow time (20:30 UTC) — inside the week.
    items["sso"] = task(env, "Вход через SSO", "done")
    state_change(env, items["sso"], msk(23, 10), "started")
    state_change(env, items["sso"], msk(28, 23, 30), "done")
    # ROBOT-2: taken into work on Monday at 00:30 Moscow time — still Sunday 21:30 in UTC, but inside the project's
    # week.
    items["search"] = task(env, "Поиск", "started")
    state_change(env, items["search"], msk(22, 0, 30), "started")
    # ROBOT-3: cancelled in the week, no Git at all.
    items["no_git"] = task(env, "Без Git", "cancelled")
    state_change(env, items["no_git"], msk(24, 15), "cancelled")
    # ROBOT-4: done on the next Monday at 00:30 Moscow time (Sunday 21:30 UTC) — the next week.
    items["next_week"] = task(env, "Следующая неделя", "done")
    state_change(env, items["next_week"], msk(29, 0, 30), "done")
    # ROBOT-5: done on the previous Sunday at 23:30 Moscow time — the previous week.
    items["last_week"] = task(env, "Прошлая неделя", "done")
    state_change(env, items["last_week"], msk(21, 23, 30), "done")
    # ROBOT-6: renamed in the week, no status change — its commit in the week does not make it part of the summary.
    items["renamed"] = task(env, "Без смены статуса", "started")
    state_change(env, items["renamed"], msk(24, 12), "started", field="name")
    # ROBOT-7: done in the week, back in work after it — the summary shows the status at the end of the period.
    items["reopened"] = task(env, "Вернули в работу", "started")
    state_change(env, items["reopened"], msk(25, 18), "done")
    state_change(env, items["reopened"], msk(1, 9, month=10), "started")

    objects = {
        "login": git_commit(repo, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "ROBOT-1: Исправить вход", msk(24, 12)),
        "old_commit": git_commit(repo, "0" * 39 + "1", "ROBOT-1: Подготовка", msk(20, 12)),
        # Merged at 22:30 UTC on 27 September — 01:30 on the 28th in Moscow.
        "sso_pr": git_pull_request(
            repo,
            12,
            "ROBOT-1 — Вход через SSO",
            state="merged",
            first_seen=msk(23, 11),
            updated=msk(28, 9),
            merged=datetime(2026, 9, 27, 22, 30, tzinfo=timezone.utc),
        ),
        "early_pr": git_pull_request(
            repo, 9, "ROBOT-1 — подготовка", state="merged", first_seen=msk(5, 9), updated=msk(24, 9), merged=msk(10, 9)
        ),
        "open_pr": git_pull_request(repo, 15, "Поиск по коду", state="open", first_seen=msk(23, 9), updated=msk(25, 9)),
        "later_pr": git_pull_request(
            repo, 16, "Поиск: черновик", state="open", is_draft=True, first_seen=msk(30, 9), updated=msk(30, 9)
        ),
        "stale_pr": git_pull_request(
            repo, 17, "Поиск: старая попытка", state="closed", first_seen=msk(1, 9), updated=msk(15, 9)
        ),
        "renamed_commit": git_commit(repo, "3" * 40, "ROBOT-6: Переименовать", msk(24, 13)),
        "orphan_commit": git_commit(repo, "9" * 40, "Коммит без задачи", msk(24, 14)),
    }
    for name in ("login", "old_commit", "sso_pr", "early_pr"):
        link(env, items["sso"], objects[name])
    for name in ("open_pr", "later_pr", "stale_pr"):
        link(env, items["search"], objects[name])
    link(env, items["renamed"], objects["renamed_commit"])
    return items, objects


def get_summary(api_client, env, project=None, **params):
    return api_client.get(summary_url(env["workspace"], project or env["project"]), params)


def task_url(env, issue):
    return f"{BASE}/{env['workspace'].slug}/browse/ROBOT-{issue.sequence_id}/"


class TagCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = set()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        if tag == "a":
            self.hrefs.append(dict(attrs)["href"])


def parse_html(html):
    collector = TagCollector()
    collector.feed(html)
    return collector


def test_week_in_project_timezone_statuses_git_and_totals(api_client, env, week):
    items, objects = week
    api_client.force_authenticate(user=env["lead"])

    response = get_summary(api_client, env, **WEEK)

    assert response.status_code == status.HTTP_200_OK
    data = response.data
    assert (data["from"], data["to"]) == ("2026-09-22", "2026-09-28")
    assert data["totals"] == {"done": 2, "in_progress": 1, "other": 1, "commits": 1, "pull_requests": 2}
    assert data["truncated"] is False
    assert [item["work_item"]["id"] for item in data["items"]] == [
        str(items[name].id) for name in ("sso", "reopened", "search", "no_git")
    ]
    sso, reopened, search, no_git = data["items"]
    assert sso["work_item"] == {
        "id": str(items["sso"].id),
        "key": f"ROBOT-{items['sso'].sequence_id}",
        "name": "Вход через SSO",
        "url": task_url(env, items["sso"]),
        "state_name": "Готово",
        "state_group": "done",
    }
    assert [item["id"] for item in sso["commits"]] == [str(objects["login"].id)]
    assert sso["commits"][0]["label"] == "коммит a1b2c3d «ROBOT-1: Исправить вход»"
    assert sso["commits"][0]["canonical_url"] == objects["login"].canonical_url
    assert [item["id"] for item in sso["pull_requests"]] == [str(objects["sso_pr"].id)]
    assert sso["pull_requests"][0]["label"] == "PR #12 «ROBOT-1 — Вход через SSO» · Слит 28 сент."
    # Done inside the period, back in work after it: the period's own outcome.
    assert (reopened["work_item"]["state_name"], reopened["work_item"]["state_group"]) == ("Готово", "done")
    assert (reopened["commits"], reopened["pull_requests"]) == ([], [])
    assert (search["work_item"]["state_name"], search["work_item"]["state_group"]) == ("В работе", "in_progress")
    assert search["commits"] == []
    assert [item["label"] for item in search["pull_requests"]] == ["PR #15 «Поиск по коду» · Открыт"]
    assert (no_git["work_item"]["state_name"], no_git["work_item"]["state_group"]) == ("Отменена", "other")
    assert (no_git["commits"], no_git["pull_requests"]) == ([], [])

    slug = env["workspace"].slug
    assert data["markdown"] == "\n".join(
        [
            "### Что сделано с 22 по 28 сент. 2026",
            "",
            "Сделано: 2 · В работе: 1 · Прочее: 1 · Коммитов: 1 · PR: 2",
            "",
            "**Сделано**",
            "",
            f"- [ROBOT-1 «Вход через SSO»](<{BASE}/{slug}/browse/ROBOT-1/>) · Готово",
            "  - [коммит a1b2c3d «ROBOT-1: Исправить вход»]"
            "(<https://github.com/ppm-g23/robot/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678>)",
            "  - [PR #12 «ROBOT-1 — Вход через SSO» · Слит 28 сент.](<https://github.com/ppm-g23/robot/pull/12>)",
            f"- [ROBOT-7 «Вернули в работу»](<{BASE}/{slug}/browse/ROBOT-7/>) · Готово",
            "",
            "**В работе**",
            "",
            f"- [ROBOT-2 «Поиск»](<{BASE}/{slug}/browse/ROBOT-2/>) · В работе",
            "  - [PR #15 «Поиск по коду» · Открыт](<https://github.com/ppm-g23/robot/pull/15>)",
            "",
            "**Прочее**",
            "",
            f"- [ROBOT-3 «Без Git»](<{BASE}/{slug}/browse/ROBOT-3/>) · Отменена",
            "",
        ]
    )
    html = data["html"]
    parsed = parse_html(html)
    assert parsed.tags <= SAFE_TAGS
    assert html.startswith("<h3>Что сделано с 22 по 28 сент. 2026</h3>")
    assert "<p>Сделано: 2 · В работе: 1 · Прочее: 1 · Коммитов: 1 · PR: 2</p>" in html
    assert "<p><strong>Сделано</strong></p>" in html
    assert (
        f'<li><p><a href="{BASE}/{slug}/browse/ROBOT-1/" target="_blank" rel="noopener noreferrer">'
        "ROBOT-1 «Вход через SSO»</a> · Готово</p><ul><li><p>"
        '<a href="https://github.com/ppm-g23/robot/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" target="_blank" '
        'rel="noopener noreferrer">коммит a1b2c3d «ROBOT-1: Исправить вход»</a></p></li>'
    ) in html
    assert parsed.hrefs == [
        task_url(env, items["sso"]),
        objects["login"].canonical_url,
        objects["sso_pr"].canonical_url,
        task_url(env, items["reopened"]),
        task_url(env, items["search"]),
        objects["open_pr"].canonical_url,
        task_url(env, items["no_git"]),
    ]
    for hidden in ("Следующая неделя", "Прошлая неделя", "Без смены статуса", "Коммит без задачи", "#9 ", "#16", "#17"):
        assert hidden not in str(data)


def test_the_same_moments_in_utc_project_give_another_week(api_client, env, week):
    """Control for the timezone boundary: the same data in a UTC project moves Monday 00:30 MSK out of the week and
    Monday 29th 00:30 MSK (Sunday 21:30 UTC) in."""
    items, _ = week
    type(env["project"]).objects.filter(id=env["project"].id).update(timezone="UTC")
    api_client.force_authenticate(user=env["lead"])

    response = get_summary(api_client, env, **WEEK)

    listed = {item["work_item"]["id"] for item in response.data["items"]}
    assert str(items["search"].id) not in listed
    assert str(items["next_week"].id) in listed
    assert str(items["sso"].id) in listed


def test_escaping_in_markdown_and_html(api_client, env):
    api_client.force_authenticate(user=env["lead"])
    tricky = task(env, 'Фикс <b>"жирный"</b> [x](y) \\ конец', "done")
    state_change(env, tricky, msk(24, 10), "done")
    evil_commit = git_commit(env["repo"], "f" * 40, "<script>alert(1)</script> ] ) [", msk(24, 11))
    evil_pr = git_pull_request(
        env["repo"],
        21,
        'Тег "a" & <i>курсив</i>',
        state="merged",
        first_seen=msk(23, 9),
        updated=msk(24, 9),
        merged=msk(24, 9),
    )
    link(env, tricky, evil_commit)
    link(env, tricky, evil_pr)

    response = get_summary(api_client, env, **WEEK)

    html, markdown = response.data["html"], response.data["markdown"]
    parsed = parse_html(html)
    assert parsed.tags <= SAFE_TAGS
    assert "<script" not in html and "<b>" not in html and "<i>" not in html
    assert "ROBOT-1 «Фикс &lt;b&gt;&quot;жирный&quot;&lt;/b&gt; [x](y) \\ конец»</a>" in html
    assert "коммит fffffff «&lt;script&gt;alert(1)&lt;/script&gt; ] ) [»</a>" in html
    assert "PR #21 «Тег &quot;a&quot; &amp; &lt;i&gt;курсив&lt;/i&gt;» · Слит 24 сент.</a>" in html
    slug = env["workspace"].slug
    assert (
        f'- [ROBOT-1 «Фикс &lt;b>"жирный"&lt;/b> \\[x\\](y) \\\\ конец»](<{BASE}/{slug}/browse/ROBOT-1/>) · Готово'
        in markdown.splitlines()
    )
    assert (
        "  - [коммит fffffff «&lt;script>alert(1)&lt;/script> \\] ) \\[»]"
        f"(<https://github.com/ppm-g23/robot/commit/{'f' * 40}>)"
    ) in markdown.splitlines()
    assert (
        '  - [PR #21 «Тег "a" & &lt;i>курсив&lt;/i>» · Слит 24 сент.](<https://github.com/ppm-g23/robot/pull/21>)'
    ) in markdown.splitlines()
    # JSON keeps the raw text: escaping belongs to the ready-made text only.
    assert response.data["items"][0]["work_item"]["name"] == 'Фикс <b>"жирный"</b> [x](y) \\ конец'


def test_only_this_project_active_links_of_connected_repositories(api_client, env):
    lead, workspace = env["lead"], env["workspace"]
    api_client.force_authenticate(user=lead)
    sso = task(env, "Вход через SSO", "done")
    state_change(env, sso, msk(24, 10), "done")
    kept = git_commit(env["repo"], "1" * 40, "ROBOT-1: остаётся", msk(24, 11))
    unlinked = git_commit(env["repo"], "2" * 40, "ROBOT-1: связь снята", msk(24, 11))
    link(env, sso, kept)
    link(env, sso, unlinked, status_value=PpmGitLinkStatus.UNLINKED)
    archived_repo = make_repository(lead, env["project"], slug="archived", provider_id=62000)
    archived_commit = git_commit(archived_repo, "4" * 40, "ROBOT-1: архивный репозиторий", msk(24, 11))
    link(env, sso, archived_commit, repo=archived_repo)
    PpmGitRepository.objects.filter(id=archived_repo[0].id).update(status=PpmGitRepositoryStatus.ARCHIVED)
    PpmGitLink.objects.create(  # a manual link without a Git object has no date — not part of a period
        workspace_id=workspace.id,
        project_id=env["project"].id,
        repository=env["repo"][0],
        work_item=sso,
        object_type="commit",
        ref="5555555",
        title="ROBOT-1: ручная ссылка",
        canonical_url="https://github.com/ppm-g23/robot/commit/5555555",
        created_by=lead.id,
        updated_by=lead.id,
    )
    # An archived task keeps its place with its archive address; a deleted one disappears.
    archived_task = task(env, "Архивная задача", "done")
    state_change(env, archived_task, msk(25, 10), "done")
    Issue.all_objects.filter(id=archived_task.id).update(archived_at=date(2026, 9, 26))
    deleted_task = task(env, "Удалённая задача", "done")
    state_change(env, deleted_task, msk(25, 11), "done")
    Issue.all_objects.filter(id=deleted_task.id).update(deleted_at=django_timezone.now())
    # Another project of the same workspace, visible to the same person: nothing of it leaks into ROBOT's summary.
    other = ProjectFactory(workspace=workspace, identifier="OTHER", timezone="Europe/Moscow")
    ProjectMemberFactory(workspace=workspace, project=other, member=lead, role=20)
    other_state = State.objects.create(
        name="Готово", color="#46A758", group="completed", project=other, created_by=lead
    )
    other_task = task(env, "Чужая задача", other_state, project=other)
    state_change(env, other_task, msk(24, 10), other_state, project=other)
    other_repo = make_repository(lead, other, slug="other", provider_id=63000)
    other_commit = git_commit(other_repo, "6" * 40, "OTHER-1: чужой коммит", msk(24, 12))
    link(env, other_task, other_commit, repo=other_repo, project=other)

    response = get_summary(api_client, env, **WEEK)

    data = response.data
    assert [item["work_item"]["id"] for item in data["items"]] == [str(sso.id), str(archived_task.id)]
    assert [item["id"] for item in data["items"][0]["commits"]] == [str(kept.id)]
    assert data["items"][1]["work_item"]["url"] == (
        f"{BASE}/{workspace.slug}/projects/{env['project'].id}/archives/issues/{archived_task.id}"
    )
    assert data["totals"] == {"done": 2, "in_progress": 0, "other": 0, "commits": 1, "pull_requests": 0}
    for hidden in ("связь снята", "архивный репозиторий", "ручная ссылка", "Удалённая", "Чужая", "чужой", "OTHER"):
        assert hidden not in str(data)


def test_shared_commit_counts_once_and_merge_without_its_time(api_client, env):
    api_client.force_authenticate(user=env["lead"])
    first = task(env, "Первая", "done")
    state_change(env, first, msk(24, 10), "done")
    second = task(env, "Вторая", "review")
    state_change(env, second, msk(25, 10), "review")
    shared = git_commit(env["repo"], "7" * 40, "ROBOT-1 ROBOT-2: общий коммит", msk(24, 12))
    link(env, first, shared)
    link(env, second, shared)
    # Merged before PPM kept merge times: the last update puts it into the period, the label has no date.
    old_style = git_pull_request(
        env["repo"], 31, "Старый слитый PR", state="merged", first_seen=msk(20, 9), updated=msk(26, 9)
    )
    link(env, second, old_style)

    response = get_summary(api_client, env, **WEEK)

    data = response.data
    assert data["totals"] == {"done": 1, "in_progress": 1, "other": 0, "commits": 1, "pull_requests": 1}
    assert [[item["id"] for item in entry["commits"]] for entry in data["items"]] == [[str(shared.id)]] * 2
    assert data["items"][1]["work_item"]["state_name"] == "На ревью"
    assert [item["label"] for item in data["items"][1]["pull_requests"]] == ["PR #31 «Старый слитый PR» · Слит"]


def test_unsafe_addresses_and_markup_from_a_provider_never_become_links(api_client, env):
    """Review round 1: a broken or hostile provider record. A Git object's address must be http(s) with a host and no
    backslash, space or control character — otherwise its label is text without a link (a line break in the address
    cannot break the markdown line either); markup in a status, a PR branch or a provider state never becomes a tag."""
    api_client.force_authenticate(user=env["lead"])
    status_payload = "Готово\"><img src=x onerror=alert('status')>"
    hostile_state = State.objects.create(
        name=status_payload, color="#46A758", group="completed", project=env["project"], created_by=env["lead"]
    )
    issue = task(env, "Задача", hostile_state, project=env["project"])
    state_change(env, issue, msk(24, 10), hostile_state, project=env["project"])
    bad_urls = [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "https://github.com/ppm-g23/robot/commit/1\n[evil](javascript:alert(1))",
        "/\\evil.example/x",
        "//evil.example/x",
        "/ppm-g23/robot/commit/1",
        "https:///ppm-g23/robot/commit/1",
        "https://github.com/ppm-g23/robot/commit/2 x",
        "https://github.com/ppm-g23/robot/commit/3\u2028x",
    ]
    for index, url in enumerate(bad_urls):
        git_object = git_commit(env["repo"], f"{index}d" + "0" * 38, f"Коммит {index}", msk(24, 11, index))
        PpmGitObject.objects.filter(id=git_object.id).update(canonical_url=url)
        git_object.refresh_from_db()
        link(env, issue, git_object)
    quoted_path = 'https://github.com/ppm-g23/robot/pull/77"><img/src=x/onerror=alert(1)>'
    hostile_pr = git_pull_request(
        env["repo"], 77, "PR с разметкой", state="open", first_seen=msk(23, 9), updated=msk(24, 12)
    )
    PpmGitObject.objects.filter(id=hostile_pr.id).update(
        canonical_url=quoted_path,
        state='"><b>state</b>',
        head_ref="\"><img src=x onerror=alert('branch')>",
    )
    hostile_pr.refresh_from_db()
    link(env, issue, hostile_pr)

    response = get_summary(api_client, env, **WEEK)

    html, markdown = response.data["html"], response.data["markdown"]
    parsed = parse_html(html)
    assert parsed.tags <= SAFE_TAGS
    # Only the task and the one well-formed address are links; the quote in it stays inside the attribute.
    assert parsed.hrefs == [task_url(env, issue), quoted_path]
    assert html_escape(status_payload) in html
    for text in (html, markdown):
        assert "<img" not in text
        assert "state</b>" not in text  # an unknown provider state is not shown at all
        assert "alert('branch')" not in text  # the branch is not part of the text
        assert "evil" not in text
    object_lines = [line for line in markdown.splitlines() if line.startswith("  - ")]
    assert len(object_lines) == len(bad_urls) + 1
    assert [line for line in object_lines if "](<" in line] == [
        '  - [PR #77 «PR с разметкой»](<https://github.com/ppm-g23/robot/pull/77"%3E%3Cimg/src=x/onerror=alert(1)%3E>)'
    ]
    assert "  - коммит 0d00000 «Коммит 0»" in object_lines
    status_text = "Готово\">&lt;img src=x onerror=alert('status')>"
    assert f"- [ROBOT-1 «Задача»](<{task_url(env, issue)}>) · {status_text}" in markdown.splitlines()


def test_pull_request_merged_after_the_period_is_open_at_its_end(api_client, env):
    """Review round 1 (ruling): the summary shows the state at the end of the period and does not change afterwards —
    PR #88, opened in the period and merged after it, is «Открыт» there and «Слит» in the next period; a PR closed
    after the period (its closing time is unknown, the last activity is later) is «Открыт», closed inside — «Закрыт»;
    a PR PPM first saw after the period is not part of it."""
    api_client.force_authenticate(user=env["lead"])
    issue = task(env, "Интеграция", "started")
    state_change(env, issue, msk(24, 10), "started")
    state_change(env, issue, msk(1, 10, month=10), "done")
    probe = git_pull_request(
        env["repo"], 88, "Проба слияния", state="merged", first_seen=msk(23, 9), updated=msk(30, 12), merged=msk(30, 12)
    )
    closed_after = git_pull_request(
        env["repo"], 89, "Закрыт позже", state="closed", first_seen=msk(23, 9), updated=msk(1, 9, month=10)
    )
    closed_inside = git_pull_request(
        env["repo"], 90, "Закрыт в периоде", state="closed", first_seen=msk(23, 9), updated=msk(26, 9)
    )
    seen_later = git_pull_request(
        env["repo"], 91, "Увиден после", state="merged", first_seen=msk(30, 9), updated=msk(30, 10), merged=msk(30, 10)
    )
    for pull_request in (probe, closed_after, closed_inside, seen_later):
        link(env, issue, pull_request)

    week = get_summary(api_client, env, **WEEK)
    next_week = get_summary(api_client, env, **{"from": "2026-09-29", "to": "2026-10-05"})

    assert [item["label"] for item in week.data["items"][0]["pull_requests"]] == [
        "PR #89 «Закрыт позже» · Открыт",
        "PR #88 «Проба слияния» · Открыт",
        "PR #90 «Закрыт в периоде» · Закрыт",
    ]
    assert week.data["totals"]["pull_requests"] == 3
    assert "  - [PR #88 «Проба слияния» · Открыт](<https://github.com/ppm-g23/robot/pull/88>)" in week.data["markdown"]
    # The JSON keeps the object as it is now; only the report text is «as of the end of the period».
    assert week.data["items"][0]["pull_requests"][1]["state"] == "merged"
    assert [item["label"] for item in next_week.data["items"][0]["pull_requests"]] == [
        "PR #89 «Закрыт позже» · Закрыт",
        "PR #88 «Проба слияния» · Слит 30 сент.",
        "PR #91 «Увиден после» · Слит 30 сент.",
    ]


@pytest.mark.parametrize(
    ("day", "inside", "outside", "heading", "merged_label"),
    [
        # 25 October 2026 in Berlin lasts 25 hours: 00:00 CEST (22:00 UTC the day before) … 24:00 CET (23:00 UTC).
        (
            "2026-10-25",
            [datetime(2026, 10, 24, 22, 30, tzinfo=timezone.utc), datetime(2026, 10, 25, 22, 30, tzinfo=timezone.utc)],
            [datetime(2026, 10, 24, 21, 30, tzinfo=timezone.utc), datetime(2026, 10, 25, 23, 30, tzinfo=timezone.utc)],
            "### Что сделано за 25 окт. 2026",
            "Слит 25 окт.",
        ),
        # 29 March 2026 lasts 23 hours: 00:00 CET (23:00 UTC the day before) … 24:00 CEST (22:00 UTC).
        (
            "2026-03-29",
            [datetime(2026, 3, 28, 23, 30, tzinfo=timezone.utc), datetime(2026, 3, 29, 21, 30, tzinfo=timezone.utc)],
            [datetime(2026, 3, 28, 22, 30, tzinfo=timezone.utc), datetime(2026, 3, 29, 22, 30, tzinfo=timezone.utc)],
            "### Что сделано за 29 мар. 2026",
            "Слит 29 мар.",
        ),
    ],
)
def test_daylight_saving_days_follow_the_project_timezone(api_client, env, day, inside, outside, heading, merged_label):
    """Review round 1: day boundaries come from the project's timezone with its daylight saving changes (Berlin)."""
    Project.objects.filter(id=env["project"].id).update(timezone="Europe/Berlin")
    api_client.force_authenticate(user=env["lead"])
    issues = []
    for index, moment in enumerate([*inside, *outside]):
        issue = task(env, f"Задача {index + 1}", "done")
        state_change(env, issue, moment, "done")
        issues.append(issue)
    merged_at = inside[-1] + timedelta(minutes=10)
    link(
        env,
        issues[1],
        git_pull_request(
            env["repo"], 50, "Слияние", state="merged", first_seen=inside[0], updated=merged_at, merged=merged_at
        ),
    )

    response = get_summary(api_client, env, **{"from": day, "to": day})

    assert [item["work_item"]["name"] for item in response.data["items"]] == ["Задача 1", "Задача 2"]
    assert response.data["markdown"].startswith(heading + "\n")
    assert [item["label"] for item in response.data["items"][1]["pull_requests"]] == [
        f"PR #50 «Слияние» · {merged_label}"
    ]


def test_relative_task_links_without_public_address(api_client, env, settings):
    settings.APP_BASE_URL = None
    settings.WEB_URL = None
    api_client.force_authenticate(user=env["lead"])
    issue = task(env, "Вход через SSO", "done")
    state_change(env, issue, msk(24, 10), "done")

    response = get_summary(api_client, env, **WEEK)

    relative = f"/{env['workspace'].slug}/browse/ROBOT-1/"
    assert response.data["items"][0]["work_item"]["url"] == relative
    assert f"[ROBOT-1 «Вход через SSO»](<{relative}>)" in response.data["markdown"]
    assert f'<a href="{relative}"' in response.data["html"]


def test_empty_period_and_single_day_heading(api_client, env):
    api_client.force_authenticate(user=env["lead"])

    empty = get_summary(api_client, env, **WEEK)
    one_day = get_summary(api_client, env, **{"from": "2026-09-28", "to": "2026-09-28"})
    across_months = get_summary(api_client, env, **{"from": "2026-09-29", "to": "2026-10-05"})
    across_years = get_summary(api_client, env, **{"from": "2025-12-29", "to": "2026-01-04"})

    assert empty.status_code == status.HTTP_200_OK
    assert empty.data["items"] == []
    assert empty.data["totals"] == {"done": 0, "in_progress": 0, "other": 0, "commits": 0, "pull_requests": 0}
    assert empty.data["markdown"] == "\n".join(
        [
            "### Что сделано с 22 по 28 сент. 2026",
            "",
            "Сделано: 0 · В работе: 0 · Прочее: 0 · Коммитов: 0 · PR: 0",
            "",
            "За этот период ни одна задача не сменила статус.",
            "",
        ]
    )
    assert empty.data["html"] == (
        "<h3>Что сделано с 22 по 28 сент. 2026</h3>"
        "<p>Сделано: 0 · В работе: 0 · Прочее: 0 · Коммитов: 0 · PR: 0</p>"
        "<p>За этот период ни одна задача не сменила статус.</p>"
    )
    assert one_day.data["markdown"].startswith("### Что сделано за 28 сент. 2026\n")
    assert across_months.data["markdown"].startswith("### Что сделано с 29 сент. по 5 окт. 2026\n")
    assert across_years.data["markdown"].startswith("### Что сделано с 29 дек. 2025 по 4 янв. 2026\n")


@pytest.mark.parametrize(
    ("params", "valid"),
    [
        ({"from": "2026-07-01", "to": "2026-09-30"}, True),  # 92 days, both ends included
        ({"from": "2026-07-01", "to": "2026-10-01"}, False),  # 93 days
        ({"from": "2026-09-28", "to": "2026-09-22"}, False),
        ({"from": "2026-09-22"}, False),
        ({"to": "2026-09-28"}, False),
        ({"from": "2026-9-22", "to": "2026-09-28"}, False),
        ({"from": "20260922", "to": "2026-09-28"}, False),
        ({"from": "2026-02-30", "to": "2026-03-01"}, False),
        ({"from": "9999-12-30", "to": "9999-12-31"}, False),
        ({"from": "0001-01-01", "to": "0001-01-02"}, False),  # Moscow midnight is still year 0 in UTC
    ],
)
def test_period_is_at_most_92_days(api_client, env, params, valid):
    api_client.force_authenticate(user=env["lead"])

    response = get_summary(api_client, env, **params)

    if valid:
        assert response.status_code == status.HTTP_200_OK
    else:
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.data["error"]["code"] == "WORK_SUMMARY_RANGE_INVALID"
        assert response.data["error"]["details"] == {"max_days": 92}
        assert "items" not in response.data


def test_rights_follow_project_reading_and_guest_sees_own_tasks(api_client, env):
    workspace, project = env["workspace"], env["project"]
    guest = make_user("g23-summary-guest")
    WorkspaceMemberFactory(workspace=workspace, member=guest, role=5)
    ProjectMemberFactory(workspace=workspace, project=project, member=guest, role=5)
    stranger = make_user("g23-summary-stranger")
    WorkspaceMemberFactory(workspace=workspace, member=stranger, role=15)
    outsider = make_user("g23-summary-outsider")
    own = task(env, "Задача гостя", "done", creator=guest)
    state_change(env, own, msk(24, 10), "done")
    team = task(env, "Задача команды", "done")
    state_change(env, team, msk(24, 11), "done")

    api_client.force_authenticate(user=guest)
    limited = get_summary(api_client, env, **WEEK)
    type(project).objects.filter(id=project.id).update(guest_view_all_features=True)
    full = get_summary(api_client, env, **WEEK)
    api_client.force_authenticate(user=stranger)
    not_member = get_summary(api_client, env, **WEEK)
    api_client.force_authenticate(user=outsider)
    foreign = get_summary(api_client, env, **{"from": "2026-01-01", "to": "2026-12-31"})
    api_client.force_authenticate(user=None)
    anonymous = get_summary(api_client, env, **WEEK)

    assert limited.status_code == status.HTTP_200_OK
    assert [item["work_item"]["id"] for item in limited.data["items"]] == [str(own.id)]
    assert "Задача команды" not in limited.data["markdown"] + limited.data["html"]
    assert [item["work_item"]["id"] for item in full.data["items"]] == [str(own.id), str(team.id)]
    # No access: 403 before the period is even read (an invalid period does not tell anything either).
    for denied in (not_member, foreign):
        assert denied.status_code == status.HTTP_403_FORBIDDEN
        assert denied.data["error"]["code"] == "GIT_PERMISSION_DENIED"
        assert "items" not in denied.data
    assert anonymous.status_code == status.HTTP_401_UNAUTHORIZED


def test_long_summary_is_cut_with_exact_totals(api_client, env, monkeypatch):
    api_client.force_authenticate(user=env["lead"])
    issues = []
    for index in range(4):
        issue = task(env, f"Задача {index + 1}", "done")
        state_change(env, issue, msk(24, 10 + index), "done")
        link(env, issue, git_commit(env["repo"], f"{index}a" + "0" * 38, f"ROBOT-{index + 1}: коммит", msk(24, 12)))
        issues.append(issue)
    monkeypatch.setattr(work_summary, "WORK_SUMMARY_MAX_ITEMS", 2)

    response = get_summary(api_client, env, **WEEK)

    data = response.data
    assert data["truncated"] is True
    assert [item["work_item"]["id"] for item in data["items"]] == [str(issues[0].id), str(issues[1].id)]
    assert data["totals"] == {"done": 4, "in_progress": 0, "other": 0, "commits": 4, "pull_requests": 0}
    note = "Задач больше, чем помещается в сводку: показаны 2 из 4. Сократите период, чтобы увидеть все."
    assert note in data["markdown"].splitlines()
    assert f"<p>{note}</p>" in data["html"]

    monkeypatch.setattr(work_summary, "WORK_SUMMARY_MAX_ITEMS", 10)
    monkeypatch.setattr(work_summary, "WORK_SUMMARY_MAX_GIT_OBJECTS", 3)
    objects_cut = get_summary(api_client, env, **WEEK)

    assert objects_cut.data["truncated"] is True
    assert len(objects_cut.data["items"]) == 4
    assert sum(len(item["commits"]) for item in objects_cut.data["items"]) == 3
    assert objects_cut.data["totals"]["commits"] == 4
    assert (
        "Коммитов и PR больше, чем помещается в сводку: показаны не все. Сократите период, чтобы увидеть все."
        in objects_cut.data["markdown"].splitlines()
    )


def test_query_count_does_not_grow_with_tasks(api_client, env):
    api_client.force_authenticate(user=env["lead"])

    def add_task(index):
        issue = task(env, f"Задача {index}", "started" if index % 2 else "done")
        state_change(env, issue, msk(24, 10), "started" if index % 2 else "done")
        link(env, issue, git_commit(env["repo"], f"{index:02d}c" + "0" * 37, f"Коммит {index}", msk(24, 12)))
        link(
            env,
            issue,
            git_pull_request(
                env["repo"],
                100 + index,
                f"PR {index}",
                state="merged",
                first_seen=msk(23, 9),
                updated=msk(25, 9),
                merged=msk(25, 9),
            ),
        )

    add_task(1)
    get_summary(api_client, env, **WEEK)  # warm-up
    with CaptureQueriesContext(connection) as one:
        single = get_summary(api_client, env, **WEEK)
    for index in range(2, 8):
        add_task(index)
    with CaptureQueriesContext(connection) as many:
        several = get_summary(api_client, env, **WEEK)

    assert len(single.data["items"]) == 1
    assert len(several.data["items"]) == 7
    assert several.data["totals"]["commits"] == 7
    assert len(many.captured_queries) == len(one.captured_queries)
