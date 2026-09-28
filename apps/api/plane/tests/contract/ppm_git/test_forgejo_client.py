"""G2.1 R5 — клиент Forgejo (`providers/forgejo.py`) на поддельном Forgejo, построенном по живому Forgejo 15.0.9.

Нормализация даёт ровно формы контракта A1 (те же, что у GitHub-клиента), страницы — по `page`/`limit`, курсор коммитов
применяется на стороне клиента (Forgejo 15 игнорирует `since`), ошибки — безопасные тексты, токен никуда не попадает.
"""

import logging
from datetime import datetime, timezone

import pytest
import requests

from plane.ppm_git.models import PpmGitProvider
from plane.ppm_git.providers import (
    ForgejoClient,
    forgejo_is_configured,
    forgejo_trusted_origin,
    get_provider_client,
    provider_code_file_url,
    provider_is_configured,
)
from plane.ppm_git.providers import forgejo as forgejo_module
from plane.ppm_git.providers.base import (
    CodeTree,
    CodeTreeFile,
    GitBranchObject,
    GitCommitObject,
    GitProviderClient,
    GitPullRequestObject,
    PpmGitProviderError,
    PpmGitProviderRateLimited,
    ProviderRepository,
    SyncRepositoryResult,
)
from plane.ppm_git.providers.forgejo import normalize_forgejo_pull_request
from plane.tests.contract.ppm_git.forgejo_fake import (
    FORGEJO_SETTINGS,
    INTERNAL_URL,
    PUBLIC_URL,
    TOKEN,
    FakeForgejoApi,
    FakeRepository,
    FakeResponse,
    load_fixture,
)


pytestmark = [pytest.mark.contract]

REPOSITORY = "team-alpha/app"
APP = f"{PUBLIC_URL}/{REPOSITORY}"
MAIN_HEAD = "097f3ee58ccd2e6259bf755652b9420ac28bf9bc"
DOCS_HEAD = "c02501c4323ed74cc45a89a8db0774ff51b58cfe"
BULK_FIRST_PUSH = "605e512f1a59749c195663d2ff266d8e4d422097"
BULK_HEAD = "c7eb742b6962b2d76a17746ffcf154f3a03dd423"
MAIN_TITLES = {
    "Merge pull request 'KEY-2 — форма входа и проверка' (#1) from KEY-2/login-form into main",
    "KEY-2: limit attempts",
    "KEY-2: validate input",
    "KEY-2: login form",
    "KEY-1: add sensor driver",
    "Initial commit",
}


def keys(typed_dict):
    return set(typed_dict.__required_keys__) | set(typed_dict.__optional_keys__)


@pytest.fixture
def api(settings):
    for name, value in FORGEJO_SETTINGS.items():
        setattr(settings, name, value)
    return FakeForgejoApi.from_live()


def client_for(api, **kwargs):
    return ForgejoClient(session=api, **kwargs)


def sync(api, **kwargs):
    return client_for(api).sync_repository(1, 1, REPOSITORY, **kwargs)


def missing_keys(live, fake, path=""):
    """Keys the live answer has and the fake's answer lacks (the fake may carry more)."""
    if isinstance(live, dict):
        if not isinstance(fake, dict):
            return [path or "<root>"]
        found = []
        for key, value in live.items():
            if key not in fake:
                found.append(f"{path}.{key}")
            elif fake[key] is not None:
                found.extend(missing_keys(value, fake[key], f"{path}.{key}"))
        return found
    if isinstance(live, list) and live and isinstance(fake, list) and fake:
        return missing_keys(live[0], fake[0], f"{path}[]")
    return []


# --- the fake stays faithful to the live answers ---------------------------------------------------------------------


def test_fake_answers_carry_every_key_of_the_live_answers(api):
    shapes = load_fixture("answer_shapes.json")
    answers = {
        "repository": api.request(
            "GET", f"{INTERNAL_URL}/api/v1/repositories/1", {"Authorization": f"token {TOKEN}"}, timeout=(5, 15)
        ).json(),
        "repos_search": api.request(
            "GET",
            f"{INTERNAL_URL}/api/v1/repos/search",
            {"Authorization": f"token {TOKEN}"},
            {"q": ""},
            timeout=(5, 15),
        ).json(),
        "user": api.request(
            "GET", f"{INTERNAL_URL}/api/v1/user", {"Authorization": f"token {TOKEN}"}, timeout=(5, 15)
        ).json(),
    }
    path = f"{INTERNAL_URL}/api/v1/repos/{REPOSITORY}"
    auth = {"Authorization": f"token {TOKEN}"}
    answers["branch"] = api.request("GET", f"{path}/branches", auth, timeout=(5, 15)).json()[0]
    answers["branch_one"] = api.request("GET", f"{path}/branches/main", auth, timeout=(5, 15)).json()
    answers["commit"] = api.request("GET", f"{path}/commits", auth, timeout=(5, 15)).json()[0]
    answers["pull"] = api.request("GET", f"{path}/pulls", auth, {"state": "all"}, timeout=(5, 15)).json()[0]
    answers["tree"] = api.request("GET", f"{path}/git/trees/{MAIN_HEAD}", auth, timeout=(5, 15)).json()
    blob = answers["tree"]["tree"][0]["sha"]
    answers["blob"] = api.request("GET", f"{path}/git/blobs/{blob}", auth, timeout=(5, 15)).json()

    assert {name: missing_keys(shapes[name], answers[name]) for name in shapes} == {name: [] for name in shapes}


# --- R5: the contract shapes ---------------------------------------------------------------------------------------


def test_sync_repository_returns_exactly_the_contract_shapes(api):
    result = sync(api)

    assert isinstance(client_for(api), GitProviderClient)
    assert set(result) == keys(SyncRepositoryResult)
    assert [set(item) for item in result["branches"]] == [keys(GitBranchObject)] * 3
    assert all(set(item) == keys(GitCommitObject) for item in result["commits"])
    assert [set(item) for item in result["pull_requests"]] == [keys(GitPullRequestObject)] * 3

    branches = {item["provider_object_id"]: item for item in result["branches"]}
    assert branches["KEY-4/docs"] == {
        "object_type": "branch",
        "provider_object_id": "KEY-4/docs",
        "ref": "KEY-4/docs",
        "title": "KEY-4/docs",
        "canonical_url": f"{APP}/src/branch/KEY-4/docs",
        "state": "active",
        "commit_sha": DOCS_HEAD,
        "metadata": {"protected": False},
        "source_version": DOCS_HEAD,
        "provider_updated_at": None,
    }

    commits = {item["provider_object_id"]: item for item in result["commits"]}
    # The default branch (6 commits) plus the head of every other branch — with its message (auto-link).
    assert len(result["commits"]) == len(commits) == 8
    assert {item["title"] for item in result["commits"]} == MAIN_TITLES | {
        "KEY-4: документация датчика",
        "KEY-5: bulk step 40",
    }
    assert commits[DOCS_HEAD]["metadata"] == {"message": "KEY-4: документация датчика\n"}
    assert commits[DOCS_HEAD]["title"] == "KEY-4: документация датчика"
    assert commits[BULK_HEAD]["title"] == "KEY-5: bulk step 40"
    sensor = next(item for item in result["commits"] if item["title"] == "KEY-1: add sensor driver")
    assert sensor == {
        "object_type": "commit",
        "provider_object_id": "2afb6d980cb230732d188de52866425cac96b979",
        "ref": "2afb6d980cb2",
        "title": "KEY-1: add sensor driver",
        "canonical_url": f"{APP}/commit/2afb6d980cb230732d188de52866425cac96b979",
        "state": "committed",
        "author_name": "dev1",
        "author_avatar_url": sensor["author_avatar_url"],
        "commit_sha": "2afb6d980cb230732d188de52866425cac96b979",
        "metadata": {"message": "KEY-1: add sensor driver\n\nReads the value once per second.\n"},
        "source_version": "2afb6d980cb230732d188de52866425cac96b979",
        "provider_updated_at": datetime.fromisoformat("2026-09-28T10:05:00+03:00"),
    }
    assert sensor["author_avatar_url"].startswith(f"{PUBLIC_URL}/avatars/")
    # Never an e-mail as the author.
    assert not any("@" in item["author_name"] for item in result["commits"])

    pulls = {item["ref"]: item for item in result["pull_requests"]}
    assert pulls["1"] == {
        "object_type": "pull_request",
        "provider_object_id": "1",
        "ref": "1",
        "title": "KEY-2 — форма входа и проверка",
        "canonical_url": f"{APP}/pulls/1",
        "state": "merged",
        "is_draft": False,
        "author_name": "dev1",
        "author_avatar_url": pulls["1"]["author_avatar_url"],
        "base_ref": "main",
        # The branch is deleted: Forgejo answers `head.ref = refs/pull/1/head`, the name stays in `head.label`.
        "head_ref": "KEY-2/login-form",
        "commit_sha": "50f9a1b5cd565e9994a612369de848d7cf200adc",
        "metadata": {},
        "source_version": "pr:1:2026-09-28T13:21:05+00:00",
        "provider_updated_at": datetime(2026, 9, 28, 13, 21, 5, tzinfo=timezone.utc),
        "provider_merged_at": datetime(2026, 9, 28, 13, 21, 5, tzinfo=timezone.utc),
    }
    assert (pulls["2"]["state"], pulls["2"]["is_draft"], pulls["2"]["head_ref"]) == ("closed", True, "KEY-3/wip")
    assert pulls["2"]["provider_merged_at"] is None
    assert (pulls["3"]["state"], pulls["3"]["head_ref"]) == ("open", "KEY-4/docs")
    assert all(len(item["source_version"]) <= 64 for group in result.values() for item in group)


def test_code_tree_and_blobs_are_read_from_the_exact_branch_head(api, monkeypatch):
    monkeypatch.setattr(forgejo_module, "TREE_PAGE_SIZE", 2)
    client = client_for(api)

    tree = client.get_code_tree(1, 1, REPOSITORY, "main")
    blobs = client.get_code_blobs(1, 1, REPOSITORY, tree["files"])

    assert set(tree) == keys(CodeTree)
    assert tree["commit_sha"] == MAIN_HEAD
    assert [set(item) for item in tree["files"]] == [keys(CodeTreeFile)] * 4
    assert sorted(item["path"] for item in tree["files"]) == [
        "README.md",
        "src/limits.py",
        "src/login.py",
        "src/sensor.py",
    ]
    sensor = next(item for item in tree["files"] if item["path"] == "src/sensor.py")
    assert blobs[sensor["sha"]] == b"def read_sensor():\n    return 42\n"
    # A recursive tree of 5 entries in pages of 2: pages 1–3, each with `truncated: true` — not an error.
    tree_pages = [params["page"] for path, params in api.requests if "/git/trees/" in path]
    assert tree_pages == [1, 2, 3]


def test_an_incomplete_tree_is_an_error(api, monkeypatch):
    monkeypatch.setattr(forgejo_module, "TREE_PAGE_SIZE", 2)
    api.inject(r"/git/trees/", FakeResponse(200, {"sha": MAIN_HEAD, "tree": [], "truncated": True, "total_count": 5}))

    with pytest.raises(PpmGitProviderError) as exc_info:
        client_for(api).get_code_tree(1, 1, REPOSITORY, "main")

    assert exc_info.value.code == "GIT_CODE_TREE_TOO_LARGE"


# --- pages and the cursor ------------------------------------------------------------------------------------------


def test_lists_are_read_by_page_and_limit_up_to_the_total_count(api):
    result = client_for(api, page_size=2).sync_repository(1, 1, REPOSITORY)

    assert len(result["branches"]) == 3
    assert len(result["pull_requests"]) == 3
    pages = {}
    for path, params in api.requests:
        pages.setdefault(path.rsplit("/", 1)[-1], []).append((params.get("page"), params.get("limit")))
    # X-Total-Count 3 with pages of 2: exactly two pages; the public `Link` header is never followed.
    assert pages["branches"] == [(1, 2), (2, 2)]
    assert pages["pulls"] == [(1, 2), (2, 2)]
    assert pages["commits"] == [(1, 2), (2, 2), (3, 2)]
    assert all(not path.startswith("http") for path, _ in api.requests)


def test_a_list_without_total_count_ends_at_a_short_page(api):
    branch = api.request(
        "GET",
        f"{INTERNAL_URL}/api/v1/repos/{REPOSITORY}/branches/main",
        {"Authorization": f"token {TOKEN}"},
        timeout=(5, 15),
    ).json()
    api.inject(r"/branches$", FakeResponse(200, [branch, {**branch, "name": "second"}]))
    api.inject(r"/branches$", FakeResponse(200, [{**branch, "name": "third"}]))

    result = client_for(api, page_size=2).sync_repository(1, 1, REPOSITORY)

    assert [item["ref"] for item in result["branches"]] == ["main", "second", "third"]
    assert [params["page"] for path, params in api.requests if path.endswith("/branches")] == [1, 2]


def test_branches_beyond_the_page_limit_are_an_error(api, monkeypatch):
    monkeypatch.setattr(forgejo_module, "BRANCH_PAGE_LIMIT", 1)

    with pytest.raises(PpmGitProviderError) as exc_info:
        client_for(api, page_size=2).sync_repository(1, 1, REPOSITORY)

    # A branch PPM did not read would be marked deleted — never guess.
    assert exc_info.value.code == "GIT_PROVIDER_PAGE_LIMIT"


def test_the_commit_cursor_is_applied_by_the_client(api):
    # Forgejo 15 ignores `since` — the client stops at the first page older than the cursor.
    result = client_for(api, page_size=2).sync_repository(1, 1, REPOSITORY, since="2026-09-28T09:00:00+00:00")

    listed = [item["provider_object_id"] for item in result["commits"] if item["provider_object_id"] == MAIN_HEAD]
    assert listed == [MAIN_HEAD]
    assert {item["provider_object_id"] for item in result["commits"]} == {MAIN_HEAD, DOCS_HEAD, BULK_HEAD}
    assert [params["page"] for path, params in api.requests if path.endswith("/commits")] == [1, 2]
    assert all("since" not in params for _, params in api.requests)


def test_catch_up_ranges_read_every_commit_of_a_truncated_push(api):
    ranges = [
        # An existing branch: 20 commits, the webhook carried 15.
        {"ref": "refs/heads/KEY-5/bulk", "before": BULK_FIRST_PUSH, "after": BULK_HEAD, "base": "main"},
    ]
    result = sync(api, catch_up=ranges)

    bulk = sorted(item["title"] for item in result["commits"] if item["title"].startswith("KEY-5"))
    assert bulk == sorted(f"KEY-5: bulk step {number}" for number in range(21, 41))
    assert (
        "/repos/team-alpha/app/commits",
        {
            "stat": "false",
            "verification": "false",
            "files": "false",
            "sha": BULK_HEAD,
            "not": BULK_FIRST_PUSH,
            "page": 1,
            "limit": 50,
        },
    ) in api.requests

    # A new branch (the webhook carried its last 10 commits only): everything not on the default branch.
    api.requests.clear()
    result = sync(
        api, catch_up=[{"ref": "refs/heads/KEY-5/bulk", "before": "", "after": BULK_FIRST_PUSH, "base": "main"}]
    )
    bulk = {item["title"] for item in result["commits"] if item["title"].startswith("KEY-5")}
    assert {f"KEY-5: bulk step {number}" for number in range(1, 21)} <= bulk


def test_a_catch_up_range_forgejo_no_longer_has_falls_back_then_is_skipped(api):
    gone = "1" * 40
    result = sync(
        api,
        catch_up=[
            # `before` was rewritten away (force-push): Forgejo answers 500 «bad object» — read up to the default
            # branch.
            {"ref": "refs/heads/KEY-5/bulk", "before": gone, "after": BULK_HEAD, "base": "main"},
            # `after` is gone too: nothing to read, the synchronization still succeeds.
            {"ref": "refs/heads/KEY-9/gone", "before": "", "after": gone, "base": "main"},
        ],
    )

    assert len({item["title"] for item in result["commits"] if item["title"].startswith("KEY-5")}) == 40


def test_a_renamed_repository_is_reported_instead_of_mismatched_links(api):
    with pytest.raises(PpmGitProviderError) as exc_info:
        client_for(api).sync_repository(1, 1, "team-alpha/old-name")

    assert exc_info.value.code == "GIT_REPOSITORY_MOVED"


# --- fix round 1: repositories a live Forgejo 15 answers differently ------------------------------------------------


def test_an_empty_repository_syncs_to_an_empty_picture_with_one_request(api):
    """Live: branches 200 `null`, commits 409 «Git Repository is empty.», pull requests 404 — none of them is read."""
    api.add_repository(FakeRepository(id=8, owner="team-alpha", name="fresh"))

    result = client_for(api).sync_repository(1, 8, "team-alpha/fresh")

    assert result == {"branches": [], "commits": [], "pull_requests": []}
    assert api.paths() == ["/repositories/8"]


@pytest.mark.parametrize("switch", ["has_pull_requests", "mirror"])
def test_pull_requests_are_not_requested_where_forgejo_has_none(api, switch):
    repository = api.repository()
    setattr(repository, switch, switch == "mirror")

    result = sync(api)

    assert result["pull_requests"] == []
    assert len(result["branches"]) == 3 and len(result["commits"]) == 8
    assert not any(path.endswith("/pulls") for path in api.paths())


def test_a_null_page_is_an_empty_page(api):
    api.inject(r"/branches$", FakeResponse(200, None, {"X-Total-Count": "0"}, raw="null"))
    api.inject(r"/pulls$", FakeResponse(200, None, {"X-Total-Count": "0"}, raw="null"))

    result = sync(api)

    assert (result["branches"], result["pull_requests"]) == ([], [])
    assert len(result["commits"]) == 6  # the default branch only: no branch heads came


@pytest.mark.parametrize("read", ["tree", "blobs"])
def test_code_is_read_only_from_the_connected_repository(api, read):
    """The connected repository (id 1) is renamed and another one takes its old name: its code is never read."""
    client = client_for(api)
    files = client.get_code_tree(1, 1, REPOSITORY, "main")["files"]
    api.repository().name = "app-old"
    other = api.add_repository(FakeRepository(id=7, owner="team-alpha", name="app"))
    api.commit_on("main", "init", repository=other, files={"SECRET.md": b"other repository content\n"})
    api.requests.clear()

    with pytest.raises(PpmGitProviderError) as exc_info:
        if read == "tree":
            client.get_code_tree(1, 1, REPOSITORY, "main")
        else:
            client.get_code_blobs(1, 1, REPOSITORY, files)

    assert exc_info.value.code == "GIT_REPOSITORY_MOVED"
    assert api.paths() == ["/repositories/1"]


def test_the_code_of_an_empty_repository_is_not_read(api):
    api.add_repository(FakeRepository(id=8, owner="team-alpha", name="fresh"))

    with pytest.raises(PpmGitProviderError) as exc_info:
        client_for(api).get_code_tree(1, 8, "team-alpha/fresh", "main")

    assert (exc_info.value.code, exc_info.value.http_status) == ("GIT_REPOSITORY_EMPTY", None)
    assert api.paths() == ["/repositories/8"]


# --- connect flow calls --------------------------------------------------------------------------------------------


def test_search_repository_by_id_and_current_user(api):
    client = client_for(api)

    page = client.search_repositories(query="", page=1)
    found = client.search_repositories(query="app", page=1)
    repository = client.get_repository(1, 1)

    assert [item["full_name"] for item in page["items"]] == ["dev1/sandbox", "team-alpha/app", "team-alpha/legacy"]
    assert (page["page"], page["has_next"]) == (1, False)
    assert [item["full_name"] for item in found["items"]] == ["team-alpha/app"]
    assert set(repository) == keys(ProviderRepository)
    assert repository == {
        "provider_repository_id": 1,
        "name": "app",
        "full_name": REPOSITORY,
        "owner": "team-alpha",
        "canonical_url": APP,
        "clone_https": f"{APP}.git",
        "clone_ssh": "ssh://git@git.ppm-g21-a2.localhost:2222/team-alpha/app.git",
        "default_branch": "main",
        "visibility": "private",
        "archived": False,
        "updated_at": datetime(2026, 9, 28, 13, 32, 16, tzinfo=timezone.utc),
    }
    legacy = page["items"][2]
    assert (legacy["visibility"], legacy["private"], legacy["archived"], legacy["default_branch"]) == (
        "public",
        False,
        True,
        "trunk",
    )
    assert page["items"][1]["description"] == "Приложение команды"
    assert client.get_current_user() == {"id": 2, "login": "ppm-bot"}
    assert all(path.startswith(("/repos/", "/repositories/", "/user")) for path, _ in api.requests)


def test_search_pages(api):
    client = client_for(api, page_size=2)

    first = client.search_repositories(query="", page=1)
    second = client.search_repositories(query="", page=2)

    assert ([item["name"] for item in first["items"]], first["has_next"]) == (["sandbox", "app"], True)
    assert ([item["name"] for item in second["items"]], second["has_next"]) == (["legacy"], False)


def test_no_ssh_address_when_ppm_switches_ssh_off(api, settings):
    settings.PPM_FORGEJO_SSH_ENABLED = False
    client = client_for(api)

    assert client.get_repository(1, 1)["clone_ssh"] == ""
    assert {item["clone_ssh"] for item in client.search_repositories(query="")["items"]} == {""}


# --- errors, waits and the token -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("response", "code", "http_status", "retry_after"),
    [
        (FakeResponse(429, {"message": "slow down"}, {"Retry-After": "120"}), "GIT_PROVIDER_RATE_LIMITED", 429, 120),
        (FakeResponse(503, {"message": "maintenance"}), "GIT_PROVIDER_RATE_LIMITED", 503, 60),
        (FakeResponse(502, None), "GIT_PROVIDER_RATE_LIMITED", 502, 60),
        (FakeResponse(504, None), "GIT_PROVIDER_RATE_LIMITED", 504, 60),
        (FakeResponse(401, {"message": "bad"}), "GIT_PROVIDER_AUTH_FAILED", 401, None),
        (FakeResponse(403, {"message": "scope"}), "GIT_PROVIDER_AUTH_FAILED", 403, None),
        (FakeResponse(404, {"message": "gone"}), "GIT_REPOSITORY_NOT_FOUND", 404, None),
        (FakeResponse(500, {"message": "panic"}), "GIT_PROVIDER_UNAVAILABLE", 500, None),
        (FakeResponse(422, {"message": "odd"}), "GIT_PROVIDER_REQUEST_FAILED", 422, None),
        (FakeResponse(200, None, raw="<html>"), "GIT_PROVIDER_INVALID_RESPONSE", 200, None),
    ],
)
def test_answers_map_to_safe_codes_and_waits(api, response, code, http_status, retry_after):
    api.inject(r"/repositories/1$", response)

    with pytest.raises(PpmGitProviderError) as exc_info:
        sync(api)

    error = exc_info.value
    assert (error.code, error.http_status, error.retry_after_seconds) == (code, http_status, retry_after)
    assert isinstance(error, PpmGitProviderRateLimited) is (code == "GIT_PROVIDER_RATE_LIMITED")
    # Only PPM's own Russian texts: nothing of the answer.
    assert not any(word in error.message for word in ("slow", "maintenance", "bad", "scope", "gone", "panic", "odd"))


class BrokenSession:
    def __init__(self, error):
        self.error = error

    def request(self, *args, **kwargs):
        raise self.error


@pytest.mark.parametrize(
    "error",
    [
        requests.ConnectionError("connection refused"),
        requests.ReadTimeout("read timed out"),
        requests.TooManyRedirects(),
    ],
)
def test_transport_failures_are_unavailable_without_a_status(api, error):
    with pytest.raises(PpmGitProviderError) as exc_info:
        ForgejoClient(session=BrokenSession(error)).get_current_user()

    assert (exc_info.value.code, exc_info.value.http_status) == ("GIT_PROVIDER_UNAVAILABLE", None)
    assert exc_info.value.__cause__ is None and exc_info.value.__suppress_context__ is True


def test_the_token_never_reaches_an_error_a_log_or_the_client(api, settings, caplog):
    leaked = "secret-token-that-forgejo-echoes-0000001"
    settings.PPM_FORGEJO_TOKEN = leaked
    client = client_for(api)
    caplog.set_level(logging.DEBUG)

    with pytest.raises(PpmGitProviderError) as exc_info:
        client.sync_repository(1, 1, REPOSITORY)

    error = exc_info.value
    assert error.code == "GIT_PROVIDER_AUTH_FAILED"
    # The live Forgejo 15 echoes a wrong token in its 401 text — none of it gets through.
    assert (
        api.request("GET", f"{INTERNAL_URL}/api/v1/user", {"Authorization": f"token {leaked}"}, timeout=(5, 15))
        .json()["message"]
        .endswith(f"[sha: {leaked}]")
    )
    for text in (str(error), repr(error), error.message, repr(client), repr(vars(client)), caplog.text):
        assert leaked not in text
    assert error.__cause__ is None

    # A token requests would refuse to send (a line break) is refused before any request, without its value.
    settings.PPM_FORGEJO_TOKEN = "line\nbreak-token"
    with pytest.raises(PpmGitProviderError) as exc_info:
        client.get_current_user()
    assert exc_info.value.code == "GIT_PROVIDER_AUTH_FAILED"
    assert "break-token" not in str(exc_info.value) + repr(exc_info.value)


# --- registry, settings, file links --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "missing", ["PPM_FORGEJO_URL", "PPM_FORGEJO_PUBLIC_URL", "PPM_FORGEJO_TOKEN", "PPM_FORGEJO_WEBHOOK_SECRET"]
)
def test_the_provider_is_on_only_with_all_four_settings(settings, missing):
    for name, value in FORGEJO_SETTINGS.items():
        setattr(settings, name, value)
    assert forgejo_is_configured() is True
    assert type(get_provider_client(PpmGitProvider.FORGEJO)) is ForgejoClient
    assert provider_is_configured("forgejo") is True

    setattr(settings, missing, "   ")

    assert forgejo_is_configured() is False
    with pytest.raises(PpmGitProviderError) as exc_info:
        get_provider_client("forgejo")
    assert exc_info.value.code == "GIT_PROVIDER_NOT_CONFIGURED"


def test_forgejo_file_links_and_trusted_origin(settings):
    build = provider_code_file_url(PpmGitProvider.FORGEJO)
    settings.PPM_FORGEJO_PUBLIC_URL = f"{PUBLIC_URL}/"

    assert build(APP, MAIN_HEAD, "src/app file.py") == f"{APP}/src/commit/{MAIN_HEAD}/src/app%20file.py"
    assert forgejo_trusted_origin() == ("git.ppm-g21-a2.localhost", 19443)
    settings.PPM_FORGEJO_PUBLIC_URL = "https://Git.Example.TEST"
    assert forgejo_trusted_origin() == ("git.example.test", 443)
    settings.PPM_FORGEJO_PUBLIC_URL = "http://git.example.test"
    assert forgejo_trusted_origin() is None
    settings.PPM_FORGEJO_PUBLIC_URL = ""
    assert forgejo_trusted_origin() is None


def test_pull_request_normalization_edge_cases():
    base = {
        "id": 7,
        "number": 9223372036854775807,
        "title": "  WIP:  черновик\tбез поля draft\x1b ",
        "html_url": f"{APP}/pulls/7",
        "state": "closed",
        "merged": True,
        "merged_at": None,
        "updated_at": "2026-09-28T13:21:05.123456+03:00",
        "user": {"login": "dev1", "avatar_url": "http://insecure.example.test/a.png"},
        "base": {"ref": "main", "label": "main"},
        "head": {"ref": "refs/pull/7/head", "label": "KEY-7/branch", "sha": "a" * 40},
    }

    normalized = normalize_forgejo_pull_request(base)
    untitled = normalize_forgejo_pull_request({**base, "title": " \n ", "draft": False})

    assert normalized["title"] == "WIP: черновик без поля draft"
    assert normalized["is_draft"] is True
    assert normalized["state"] == "merged"
    assert normalized["provider_merged_at"] is None
    assert normalized["author_avatar_url"] == ""
    assert normalized["head_ref"] == "KEY-7/branch"
    assert len(normalized["source_version"]) <= 64
    assert (untitled["title"], untitled["is_draft"]) == ("Запрос на слияние #9223372036854775807", False)
