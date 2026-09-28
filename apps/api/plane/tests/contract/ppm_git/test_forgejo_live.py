"""G2.1 R5-live — сверка клиента Forgejo с живым Forgejo 15. По умолчанию пропускается.

Нужен одноразовый Forgejo с репозиторием после сценария линии A2 (ветки, PR слит, PR-черновик закрыт с удалённой
веткой) и токен ppm-bot только на чтение. Запуск в стеке тестов (адрес — внутренний, как у API PPM):

    PPM_FORGEJO_LIVE_URL=http://forgejo-live:3000 \\
    PPM_FORGEJO_LIVE_PUBLIC_URL=https://git.<домен стенда> \\
    PPM_FORGEJO_LIVE_TOKEN=<токен из файла 600> PPM_FORGEJO_LIVE_REPOSITORY=team-alpha/app \\
    pytest plane/tests/contract/ppm_git/test_forgejo_live.py

Проверяет формы нормализации на настоящих ответах и то, на чём держится клиент (и поддельный Forgejo): `since`
игнорируется, `Link` — публичный адрес, у PR с удалённой веткой `head.ref = refs/pull/N/head`, неверный токен
возвращается эхом (а клиент его прячет). Ответы сверяются с `fixtures/forgejo/answer_shapes.json`: исчезнувший ключ —
сигнал, что Forgejo после обновления отвечает иначе и поддельный Forgejo надо обновить.
"""

import os
from datetime import datetime, timezone

import pytest
import requests

from plane.ppm_git.providers.base import (
    CodeTree,
    GitBranchObject,
    GitCommitObject,
    GitPullRequestObject,
    PpmGitProviderError,
    ProviderRepository,
    SyncRepositoryResult,
)
from plane.ppm_git.providers.forgejo import ForgejoClient
from plane.tests.contract.ppm_git.forgejo_fake import load_fixture


LIVE_URL = os.environ.get("PPM_FORGEJO_LIVE_URL", "").rstrip("/")
pytestmark = [
    pytest.mark.contract,
    pytest.mark.skipif(not LIVE_URL, reason="живой Forgejo не задан (PPM_FORGEJO_LIVE_URL)"),
]


def keys(typed_dict):
    return set(typed_dict.__required_keys__) | set(typed_dict.__optional_keys__)


def missing_keys(recorded, live, path=""):
    if isinstance(recorded, dict):
        if not isinstance(live, dict):
            return [path or "<root>"]
        found = []
        for key, value in recorded.items():
            if key not in live:
                found.append(f"{path}.{key}")
            elif live[key] is not None:
                found.extend(missing_keys(value, live[key], f"{path}.{key}"))
        return found
    if isinstance(recorded, list) and recorded and isinstance(live, list) and live:
        return missing_keys(recorded[0], live[0], f"{path}[]")
    return []


@pytest.fixture
def live(settings):
    settings.PPM_FORGEJO_URL = LIVE_URL
    settings.PPM_FORGEJO_PUBLIC_URL = os.environ["PPM_FORGEJO_LIVE_PUBLIC_URL"]
    settings.PPM_FORGEJO_TOKEN = os.environ["PPM_FORGEJO_LIVE_TOKEN"]
    settings.PPM_FORGEJO_WEBHOOK_SECRET = "not-used-by-the-live-check"
    settings.PPM_FORGEJO_SSH_ENABLED = True
    full_name = os.environ.get("PPM_FORGEJO_LIVE_REPOSITORY", "team-alpha/app")
    client = ForgejoClient()
    found = [
        item
        for item in client.search_repositories(query=full_name.split("/")[1])["items"]
        if item["full_name"] == full_name
    ]
    assert found, f"{full_name} is not on the live Forgejo"
    return client, found[0], os.environ["PPM_FORGEJO_LIVE_PUBLIC_URL"].rstrip("/")


def raw(path, **params):
    response = requests.get(
        f"{LIVE_URL}/api/v1{path}",
        headers={"Authorization": f"token {os.environ['PPM_FORGEJO_LIVE_TOKEN']}", "Accept": "application/json"},
        params=params,
        timeout=(5, 15),
    )
    return response


def test_live_answers_keep_every_key_the_fake_models(live):
    _, repository, _ = live
    shapes = load_fixture("answer_shapes.json")
    path = f"/repos/{repository['full_name']}"
    branch = raw(f"{path}/branches/{repository['default_branch']}").json()
    tree = raw(f"{path}/git/trees/{branch['commit']['id']}", recursive="true", page=1, per_page=1000).json()
    blob = next(item for item in tree["tree"] if item["type"] == "blob")
    answers = {
        "repository": raw(f"/repositories/{repository['provider_repository_id']}").json(),
        "repos_search": raw("/repos/search", q="").json(),
        "user": raw("/user").json(),
        "branch": raw(f"{path}/branches").json()[0],
        "branch_one": branch,
        "commit": raw(f"{path}/commits", stat="false", verification="false", files="false").json()[0],
        "pull": raw(f"{path}/pulls", state="all").json()[0],
        "tree": tree,
        "blob": raw(f"{path}/git/blobs/{blob['sha']}").json(),
    }

    assert {name: missing_keys(shapes[name], answers[name]) for name in shapes} == {name: [] for name in shapes}


def test_live_client_answers_have_exactly_the_contract_shapes(live):
    client, repository, public_url = live
    repository_url = f"{public_url}/{repository['full_name']}"

    synced = client.sync_repository(1, repository["provider_repository_id"], repository["full_name"])
    tree = client.get_code_tree(
        1, repository["provider_repository_id"], repository["full_name"], repository["default_branch"]
    )
    blobs = client.get_code_blobs(1, repository["provider_repository_id"], repository["full_name"], tree["files"][:3])
    by_id = client.get_repository(1, repository["provider_repository_id"])

    assert set(synced) == keys(SyncRepositoryResult)
    assert synced["branches"] and all(set(item) == keys(GitBranchObject) for item in synced["branches"])
    assert synced["commits"] and all(set(item) == keys(GitCommitObject) for item in synced["commits"])
    assert synced["pull_requests"] and all(set(item) == keys(GitPullRequestObject) for item in synced["pull_requests"])
    everything = [*synced["branches"], *synced["commits"], *synced["pull_requests"]]
    assert all(item["canonical_url"].startswith(f"{repository_url}/") for item in everything)
    assert all(len(item["source_version"]) <= 64 for item in everything)
    assert not any("@" in item.get("author_name", "") for item in everything)
    assert {item["state"] for item in synced["pull_requests"]} >= {"merged"}
    merged = next(item for item in synced["pull_requests"] if item["state"] == "merged")
    assert isinstance(merged["provider_merged_at"], datetime)
    assert set(tree) == keys(CodeTree) and tree["files"]
    assert set(blobs) == {item["sha"] for item in tree["files"][:3]}
    assert set(by_id) == keys(ProviderRepository)
    assert by_id["canonical_url"] == repository_url
    assert client.get_current_user()["login"] == "ppm-bot"


def test_live_facts_the_client_and_the_fake_rely_on(live, settings):
    client, repository, public_url = live
    path = f"/repos/{repository['full_name']}"

    everything = raw(f"{path}/commits", limit=1, stat="false", verification="false", files="false")
    since = raw(
        f"{path}/commits",
        limit=1,
        stat="false",
        verification="false",
        files="false",
        since=datetime.now(timezone.utc).isoformat(),
    )
    pulls = raw(f"{path}/pulls", state="all", limit=50).json()
    branches = {item["name"] for item in raw(f"{path}/branches", limit=50).json()}

    # `since` is ignored by Forgejo 15: the client applies the cursor itself.
    assert everything.headers["X-Total-Count"] == since.headers["X-Total-Count"] != "0"
    # `Link` carries the public address: the client never follows it.
    assert public_url in everything.headers.get("Link", public_url)
    # A pull request whose source branch is gone: `head.ref` is the PR ref, the name stays in `head.label`.
    gone = [item for item in pulls if item["head"]["label"] not in branches]
    assert all(item["head"]["ref"] == f"refs/pull/{item['number']}/head" for item in gone)
    normalized = {
        item["ref"]: item
        for item in client.sync_repository(1, repository["provider_repository_id"], repository["full_name"])[
            "pull_requests"
        ]
    }
    assert all(normalized[str(item["number"])]["head_ref"] == item["head"]["label"] for item in gone)

    # A wrong token is echoed by Forgejo — never by the client.
    wrong = "live-check-wrong-token-000000000000000001"
    echoed = requests.get(f"{LIVE_URL}/api/v1/user", headers={"Authorization": f"token {wrong}"}, timeout=(5, 15))
    assert echoed.status_code == 401 and wrong in echoed.text
    settings.PPM_FORGEJO_TOKEN = wrong
    with pytest.raises(PpmGitProviderError) as exc_info:
        client.get_current_user()
    assert exc_info.value.code == "GIT_PROVIDER_AUTH_FAILED"
    assert wrong not in f"{exc_info.value} {exc_info.value!r}"
