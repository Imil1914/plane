"""G2.2 S2a — движок доступов на живом Forgejo 15. По умолчанию пропускается.

Нужен одноразовый Forgejo 15 (образ комплекта) с источником входа «PPM» и токеном ppm-bot с областями R8
(`write:admin,write:organization,read:repository,read:user`). Запуск в стеке тестов:

    PPM_FORGEJO_ACCESS_LIVE_URL=http://host.docker.internal:<порт> \\
    PPM_FORGEJO_ACCESS_LIVE_TOKEN_FILE=<файл 600 с токеном, смонтированный в контейнер> \\
    PPM_FORGEJO_ACCESS_LIVE_SOURCE_ID=<id источника из `forgejo admin auth list`> \\
    pytest plane/tests/contract/ppm_git/test_forgejo_access_live.py -s

Проверяет, что тела запросов клиента и движка принимает настоящий Forgejo: учётка с `source_id`/`login_name` без
пароля, организация, команды по ролям (`units_map` у не-admin), члены, репозиторий в командах, `prohibit_login`,
администратор, повторная сверка без изменений. Имена создаваемых учёток печатаются (`LIVE-ACCOUNTS: …`), чтобы снаружи
проверить `must_change_password` токеном самого человека (через API и Sudo он не виден).
"""

import os
import uuid

import pytest
from django.utils import timezone

from plane.db.models import User
from plane.ppm_canvas.models import PpmGlobalAdmin
from plane.ppm_git import forgejo_access
from plane.ppm_git.forgejo_access import (
    apply_user_access,
    ensure_account_for_login,
    run_access_sync,
    run_full_reconcile,
)
from plane.ppm_git.forgejo_admin import TEAM_UNITS, ForgejoAdminClient
from plane.ppm_git.models import PpmGitConnection, PpmGitInstallation, PpmGitRepository
from plane.tests.factories import (
    ProjectFactory,
    ProjectMemberFactory,
    UserFactory,
    WorkspaceFactory,
    WorkspaceMemberFactory,
)

LIVE_URL = os.environ.get("PPM_FORGEJO_ACCESS_LIVE_URL", "").rstrip("/")
pytestmark = [
    pytest.mark.contract,
    pytest.mark.django_db,
    pytest.mark.skipif(not LIVE_URL, reason="живой Forgejo не задан (PPM_FORGEJO_ACCESS_LIVE_URL)"),
]


def logins(members):
    return [member["login"] for member in members]


@pytest.fixture
def live(settings, monkeypatch):
    with open(os.environ["PPM_FORGEJO_ACCESS_LIVE_TOKEN_FILE"], encoding="utf-8") as handle:
        token = handle.read().strip()
    settings.PPM_GIT_SSO_ENABLED = True
    settings.PPM_FORGEJO_URL = LIVE_URL
    settings.PPM_FORGEJO_PUBLIC_URL = LIVE_URL
    settings.PPM_FORGEJO_TOKEN = "not-used-by-the-live-check"
    settings.PPM_FORGEJO_WEBHOOK_SECRET = "not-used-by-the-live-check"
    settings.PPM_FORGEJO_ADMIN_TOKEN = token
    settings.PPM_FORGEJO_SSO_SOURCE_ID = int(os.environ["PPM_FORGEJO_ACCESS_LIVE_SOURCE_ID"])
    monkeypatch.setattr("plane.ppm_git.tasks.sync_forgejo_access_task.apply_async", lambda *args, **kwargs: None)
    forgejo_access.clear_access_cache()
    yield ForgejoAdminClient()
    forgejo_access.clear_access_cache()


def test_the_engine_against_a_live_forgejo(live):
    marker = uuid.uuid4().hex[:6]
    owner = UserFactory(email=f"owner-{marker}@example.test", username=uuid.uuid4().hex)
    workspace = WorkspaceFactory(slug=f"s2a-live-{marker}", name=f"Живая проба {marker}", owner=owner)
    project = ProjectFactory(workspace=workspace, identifier=f"L{marker[:4].upper()}", name="Живой проект")
    people = {}
    for key, role in (("lead", 20), ("dev", 15), ("guest", 5)):
        user = UserFactory(
            email=f"live-{key}-{marker}@example.test",
            username=uuid.uuid4().hex,
            display_name=f"Живой {key}",
        )
        WorkspaceMemberFactory(workspace=workspace, member=user, role=15 if role == 20 else role)
        ProjectMemberFactory(project=project, member=user, role=role)
        people[key] = user

    accounts = {}
    for key, user in people.items():
        accounts[key] = ensure_account_for_login(user)
        assert apply_user_access(user) is True
    print("LIVE-ACCOUNTS:", " ".join(account.username for account in accounts.values()))

    source_id = int(os.environ["PPM_FORGEJO_ACCESS_LIVE_SOURCE_ID"])
    for key, account in accounts.items():
        remote = live.get_user(account.username)
        assert account.username == f"live-{key}-{marker}"
        assert (remote["source_id"], remote["login_name"]) == (source_id, str(people[key].id))
        assert remote["full_name"] == f"Живой {key}" and remote["prohibit_login"] is False
        assert [item["login"] for item in live.find_users_by_login(source_id, str(people[key].id))] == [
            account.username
        ]

    organization = live.get_organization(f"s2a-live-{marker}")
    assert organization["visibility"] == "private" and organization["full_name"] == f"Живая проба {marker}"
    key = project.identifier
    teams = {item["name"]: item for item in live.list_organization_teams(organization["name"])}
    admin, write, read = teams[f"{key}-admin"], teams[key], teams[f"{key}-read"]
    assert (admin["permission"], admin["can_create_org_repo"]) == ("admin", True)
    assert (write["permission"], write["units_map"]) == ("write", {unit: "write" for unit in TEAM_UNITS})
    assert (read["permission"], read["units_map"]) == ("read", {unit: "read" for unit in TEAM_UNITS})
    assert write["description"] == "PPM: Запись проекта «Живой проект». Состав ведёт PPM — не меняйте вручную"
    assert logins(live.list_team_members(admin["id"])) == [accounts["lead"].username]
    assert logins(live.list_team_members(write["id"])) == [accounts["dev"].username]
    assert logins(live.list_team_members(read["id"])) == [accounts["guest"].username]

    # A repository of the organization, connected to the project, is in every team of the project.
    repository = live._object(
        "POST",
        f"/orgs/{organization['name']}/repos",
        body={"name": "app", "private": True, "auto_init": True, "default_branch": "main"},
    )
    actor = uuid.uuid4()
    installation = PpmGitInstallation.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        provider="forgejo",
        provider_installation_id=1,
        provider_account_id=1,
        account_login="ppm-bot",
        created_by=actor,
        updated_by=actor,
    )
    record = PpmGitRepository.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        name="app",
        normalized_name="app",
        provider="forgejo",
        provider_repository_id=repository["id"],
        provider_full_name=repository["full_name"],
        canonical_url=f"{LIVE_URL}/{repository['full_name']}",
        clone_https=f"{LIVE_URL}/{repository['full_name']}.git",
        created_by=actor,
        updated_by=actor,
    )
    connection = PpmGitConnection.objects.create(
        workspace_id=workspace.id,
        project_id=project.id,
        installation=installation,
        repository=record,
        provider_repository_id=repository["id"],
        provider_full_name=repository["full_name"],
        created_by=actor,
        updated_by=actor,
    )
    run = run_access_sync({"project_ids": [str(project.id)]})
    assert run.status == "ok" and run.counts["repositories_added"] == 3
    for team in (admin, write, read):
        assert [item["full_name"] for item in live.list_team_repositories(team["id"])] == [repository["full_name"]]
    assert live.repository_permission(repository["full_name"], accounts["dev"].username) == "write"
    assert live.repository_permission(repository["full_name"], accounts["guest"].username) == "read"
    reachable = {
        item["full_name"]: item["permissions"] for item in live.list_user_repositories(accounts["dev"].username)
    }
    assert reachable[repository["full_name"]] == {"admin": False, "push": True, "pull": True}
    whole = {item["full_name"]: item for item in live.list_repositories_as(accounts["dev"].username)}
    assert whole[repository["full_name"]]["permissions"]["push"] is True
    assert {"html_url", "clone_url", "default_branch", "archived"} <= set(whole[repository["full_name"]])

    # A disabled person is locked out and leaves the teams; back — access returns. A global administrator is an admin.
    User.objects.filter(id=people["dev"].id).update(is_active=False)
    run_full_reconcile()
    assert live.get_user(accounts["dev"].username)["prohibit_login"] is True
    assert logins(live.list_team_members(write["id"])) == []
    User.objects.filter(id=people["dev"].id).update(is_active=True)
    PpmGlobalAdmin.objects.create(user=people["lead"], reason="live")
    run_full_reconcile()
    assert live.get_user(accounts["dev"].username)["prohibit_login"] is False
    assert logins(live.list_team_members(write["id"])) == [accounts["dev"].username]
    assert live.get_user(accounts["lead"].username)["is_admin"] is True

    # Disconnected — the repository leaves the teams (and stays in the organization); a second pass changes nothing.
    PpmGitConnection.objects.filter(id=connection.id).update(status="disconnected")
    PpmGlobalAdmin.objects.filter(user=people["lead"]).update(revoked_at=timezone.now())
    run_full_reconcile()
    assert live.list_team_repositories(write["id"]) == []
    assert live.get_repository(repository["id"]) is not None
    assert live.get_user(accounts["lead"].username)["is_admin"] is False
    again = run_full_reconcile()
    assert again.counts["changes"] == 0, again.counts
    assert again.status == "ok", again.problems

    # Round 1 of the review: a local account holding a person's e-mail is never adopted — the sign-in is refused
    # (Forgejo keeps e-mails unique) and the local account stays exactly as it was.
    local_login = f"live-local-{marker}"
    live._object(
        "POST",
        "/admin/users",
        body={
            "username": local_login,
            "email": f"{local_login}@example.test",
            "password": f"{uuid.uuid4().hex}Aa1!",
            "must_change_password": False,
        },
    )
    local_before = live.get_user(local_login)
    newcomer = UserFactory(email=f"{local_login}@example.test", username=uuid.uuid4().hex)
    with pytest.raises(forgejo_access.ForgejoAccessError) as caught:
        ensure_account_for_login(newcomer)
    assert caught.value.code == "FORGEJO_EMAIL_TAKEN"
    assert f"локальной учёткой Forgejo {local_login}" in caught.value.message
    assert live.get_user(local_login) == local_before
    assert live.find_users_by_login(source_id, str(newcomer.id)) == []

    # A team with PPM's name that PPM does not manage is never taken over: PPM's own gets «-ppm».
    second = ProjectFactory(workspace=workspace, identifier=f"M{marker[:4].upper()}", name="Второй проект")
    foreign = live.create_team(
        organization["name"],
        name=second.identifier,
        description="Команда без PPM",
        permission="read",
        can_create_org_repo=False,
    )
    ProjectMemberFactory(project=second, member=people["dev"], role=15)
    run = run_access_sync({"project_ids": [str(second.id)]})
    teams = {item["name"]: item for item in live.list_organization_teams(organization["name"])}
    ours = teams[f"{second.identifier}-ppm"]
    assert logins(live.list_team_members(ours["id"])) == [accounts["dev"].username]
    assert logins(live.list_team_members(foreign["id"])) == []
    assert live.get_team(foreign["id"])["description"] == "Команда без PPM"
    assert any(problem["message"].endswith(f"PPM создал {second.identifier}-ppm") for problem in run.problems)
    assert run_full_reconcile().counts["changes"] == 0
