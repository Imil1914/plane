"""In-memory Forgejo 15 API v1 for the G2.1 contract tests (line A2).

Built from a live Forgejo 15.0.9 (report §1): ``fixtures/forgejo/live_repository.json`` is the state of
``team-alpha/app`` after the live scenario (47 commits, 3 branches, 3 pull requests, trees and blobs),
``answer_shapes.json`` — the key sets of the live answers (a test keeps the fake's answers a superset of them),
``webhooks/*.json`` — real system-webhook deliveries (raw bodies; signatures are computed by the tests).

The fake is plugged into the real ``ForgejoClient`` as its HTTP session and answers like the live server where PPM
depends on it: ``since``/``until`` of the commit listing are ignored, ``Link`` carries the public address, ``limit`` is
cut to 50, ``X-Total-Count`` ends a list, a recursive tree is paged by ``total_count``, a deleted head branch turns a
pull request's ``head.ref`` into ``refs/pull/<N>/head``, a wrong token is answered 401 with the token echoed. An empty
repository (no branch yet) answers as the live one (A2 fix round 1): branches 200 ``null`` with ``X-Total-Count: 0``,
commits 409 «Git Repository is empty.», pull requests 404, a branch 404, a tree 400; pull requests of a repository that
has them switched off, or of a mirror, are 404. Any request it does not model — a write, ``/admin/*``, a public or
foreign host — fails the test loudly.
"""

import base64
import hashlib
import itertools
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

INTERNAL_URL = "http://forgejo.test:3000"
PUBLIC_URL = "https://git.ppm-g21-a2.localhost:19443"
TOKEN = "fake-forgejo-read-token-0000000000000001"
WEBHOOK_SECRET = "fake-forgejo-webhook-secret-for-tests"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "forgejo"
MAX_RESPONSE_ITEMS = 50
DEFAULT_PAGING_NUM = 30
TREES_PER_PAGE = 1000
ZERO_SHA = "0" * 40
VERIFICATION = {
    "verified": False,
    "reason": "gpg.error.not_signed_commit",
    "signature": "",
    "signer": None,
    "payload": "",
}

FORGEJO_SETTINGS = {
    "PPM_FORGEJO_URL": INTERNAL_URL,
    "PPM_FORGEJO_PUBLIC_URL": PUBLIC_URL,
    "PPM_FORGEJO_TOKEN": TOKEN,
    "PPM_FORGEJO_WEBHOOK_SECRET": WEBHOOK_SECRET,
    "PPM_FORGEJO_WEBHOOK_MAX_BYTES": 2_000_000,
    "PPM_FORGEJO_SSH_ENABLED": True,
}


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def webhook_fixture(name):
    """(X-Forgejo-Event, raw body bytes) of a real delivery recorded on the live Forgejo."""
    index = {item["name"]: item for item in load_fixture("webhooks/index.json")}
    return index[name]["event"], (FIXTURES / "webhooks" / f"{name}.json").read_bytes()


def blob_sha(content):
    return hashlib.sha1(b"blob %d\0" % len(content) + content).hexdigest()


def moment(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class FakeResponse:
    def __init__(self, status_code, payload=None, headers=None, *, raw=None):
        self.status_code = status_code
        self._payload = payload
        self._raw = raw
        self.headers = headers or {}
        self.links = {}

    def json(self):
        if self._raw is not None:
            return json.loads(self._raw)
        if self._payload is None and self.status_code != 200:
            return None
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


@dataclass
class FakeCommit:
    sha: str
    parents: list
    message: str
    author: dict  # {"name", "email", "date"}
    committer: dict
    author_login: str = ""


@dataclass
class FakeRepository:
    id: int
    owner: str
    name: str
    description: str = ""
    private: bool = True
    internal: bool = False
    archived: bool = False
    default_branch: str = "main"
    created_at: str = "2026-09-28T13:19:34Z"
    updated_at: str = "2026-09-28T13:32:16Z"
    has_pull_requests: bool = True
    mirror: bool = False  # a pull mirror: Forgejo reports `has_pull_requests: false` for it (live)
    branches: dict = field(default_factory=dict)  # name → head sha
    commits: dict = field(default_factory=dict)  # sha → FakeCommit (insertion order = creation order)
    pulls: list = field(default_factory=list)
    trees: dict = field(default_factory=dict)  # commit sha → [entry]
    blobs: dict = field(default_factory=dict)  # blob sha → bytes

    @property
    def full_name(self):
        return f"{self.owner}/{self.name}"


class FakeForgejoApi:
    def __init__(self, *, token=TOKEN, public_url=PUBLIC_URL, ssh_host="git.ppm-g21-a2.localhost:2222"):
        self.token = token
        # Forgejo's ROOT_URL: every link and every `Link` header of the answers is built on it.
        self.public_url = public_url
        self.ssh_host = ssh_host
        # Page size of the clients the `forgejo` fixture builds (tests shrink it to exercise paging).
        self.page_size = MAX_RESPONSE_ITEMS
        self.repositories = {}
        self.users = {
            "ppm-bot": {"id": 2, "login": "ppm-bot", "is_admin": True},
            "dev1": {"id": 3, "login": "dev1", "is_admin": False},
            "team-alpha": {"id": 4, "login": "team-alpha", "is_admin": False},
        }
        self.requests = []
        self.injected = []
        self._clock = itertools.count(1)

    # --- state -------------------------------------------------------------------------------------------------------

    @classmethod
    def from_live(cls, **kwargs):
        """The live ``team-alpha/app`` (id 1) plus the other repositories the live search returned."""
        api = cls(**kwargs)
        model = load_fixture("live_repository.json")
        live = model["repository"]
        repository = FakeRepository(
            id=live["id"],
            owner=model["owner"]["login"],
            name=live["name"],
            description=live["description"],
            private=live["private"],
            internal=live["internal"],
            archived=live["archived"],
            default_branch=live["default_branch"],
            created_at=live["created_at"],
            updated_at=live["updated_at"],
        )
        # Oldest first, so that insertion order is creation order.
        for item in sorted(model["commits"], key=lambda item: moment(item["committer"]["date"])):
            repository.commits[item["sha"]] = FakeCommit(
                sha=item["sha"],
                parents=item["parents"],
                message=item["message"],
                author=item["author"],
                committer=item["committer"],
                author_login=item["author_login"],
            )
        repository.branches = dict(model["branches"])
        repository.pulls = [dict(item) for item in model["pulls"]]
        repository.trees = {sha: [dict(entry) for entry in entries] for sha, entries in model["trees"].items()}
        repository.blobs = {sha: text.encode("utf-8") for sha, text in model["blobs"].items()}
        api.repositories[repository.id] = repository
        api.add_repository(FakeRepository(id=3, owner="dev1", name="sandbox", updated_at="2026-09-28T13:25:34Z"))
        api.add_repository(
            FakeRepository(
                id=4,
                owner="team-alpha",
                name="legacy",
                private=False,
                archived=True,
                default_branch="trunk",
                updated_at="2026-09-28T13:25:35Z",
            )
        )
        return api

    def html_url(self, repository):
        return f"{self.public_url}/{repository.full_name}"

    def add_repository(self, repository):
        self.repositories[repository.id] = repository
        return repository

    def repository(self, full_name="team-alpha/app"):
        return next(item for item in self.repositories.values() if item.full_name == full_name)

    def commit_on(self, branch, message, *, repository=None, author="dev1", date=None, files=None):
        """A new commit on ``branch`` (created from the default branch when missing); returns its SHA."""
        repository = repository or self.repository()
        parent = repository.branches.get(branch) or repository.branches.get(repository.default_branch)
        when = date or (datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc) + timedelta(seconds=next(self._clock)))
        when = when if isinstance(when, str) else when.isoformat().replace("+00:00", "Z")
        sha = hashlib.sha1(f"{repository.full_name}:{branch}:{message}:{when}:{parent}".encode()).hexdigest()
        person = {"name": "Dev One", "email": f"{author}@example.test", "date": when}
        repository.commits[sha] = FakeCommit(
            sha=sha,
            parents=[parent] if parent else [],
            message=message,
            author=person,
            committer=dict(person),
            author_login=author,
        )
        repository.branches[branch] = sha
        if files is not None:
            self.set_tree(sha, files, repository=repository)
        return sha

    def delete_branch(self, branch, *, repository=None):
        (repository or self.repository()).branches.pop(branch)

    def set_tree(self, commit_sha, files, *, repository=None):
        """The tree of ``commit_sha``: ``{path: bytes}``; directories are listed as tree entries as Forgejo does."""
        repository = repository or self.repository()
        entries = []
        directories = set()
        for path, content in files.items():
            sha = blob_sha(content)
            repository.blobs[sha] = content
            parts = path.split("/")
            for depth in range(1, len(parts)):
                directories.add("/".join(parts[:depth]))
            entries.append({"path": path, "mode": "100644", "type": "blob", "size": len(content), "sha": sha})
        for directory in directories:
            digest = hashlib.sha1(f"tree:{commit_sha}:{directory}".encode()).hexdigest()
            entries.append({"path": directory, "mode": "040000", "type": "tree", "size": 0, "sha": digest})
        repository.trees[commit_sha] = sorted(entries, key=lambda entry: entry["path"])

    def add_pull(self, *, head, title, repository=None, number=None, state="open", draft=False, base="main"):
        repository = repository or self.repository()
        number = number or max([item["number"] for item in repository.pulls] or [0]) + 1
        pull = {
            "id": 100 + number,
            "number": number,
            "title": title,
            "body": "",
            "state": state,
            "draft": draft,
            "merged": False,
            "merged_at": None,
            "merge_commit_sha": None,
            "created_at": "2026-09-29T10:00:00Z",
            "updated_at": "2026-09-29T10:00:00Z",
            "closed_at": None,
            "user_login": "dev1",
            "base": {"label": base, "ref": base, "sha": repository.branches.get(base, "")},
            "head": {"label": head, "ref": head, "sha": repository.branches.get(head, "")},
        }
        repository.pulls.append(pull)
        return pull

    def inject(self, path_pattern, response, *, times=1):
        """Answer the next ``times`` requests whose path matches with ``response`` (rate limits, outages, drift)."""
        self.injected.append([re.compile(path_pattern), response, times])

    def paths(self):
        return [path for path, _ in self.requests]

    # --- HTTP entry point --------------------------------------------------------------------------------------------

    def request(self, method, url, headers=None, params=None, timeout=None, **kwargs):
        assert method == "GET", f"PPM must never write to Forgejo: {method} {url}"
        assert url.startswith(f"{INTERNAL_URL}/api/v1/"), f"Unexpected host (only the internal address): {url}"
        assert not url.startswith(f"{INTERNAL_URL}/api/v1/admin"), f"PPM's token has no read:admin: {url}"
        assert timeout == (5, 15), f"Unexpected timeout: {timeout}"
        path = url[len(f"{INTERNAL_URL}/api/v1") :]
        params = dict(params or {})
        self.requests.append((path, params))
        for entry in self.injected:
            pattern, response, times = entry
            if times > 0 and pattern.search(path):
                entry[2] -= 1
                return response
        value = (headers or {}).get("Authorization", "")
        if not value:
            return FakeResponse(403, {"message": "Only signed in user is allowed to call APIs."})
        if value != f"token {self.token}":
            # Live Forgejo 15 echoes the token it did not find.
            sent = value.removeprefix("token ")
            return FakeResponse(
                401,
                {"message": f"access token does not exist [sha: {sent}]", "url": f"{self.public_url}/api/swagger"},
            )
        return self._dispatch(path, params)

    def _dispatch(self, path, params):
        if path == "/user":
            return FakeResponse(200, self._user_json("ppm-bot"))
        if path == "/repos/search":
            return self._search(params)
        match = re.fullmatch(r"/repositories/(\d+)", path)
        if match:
            repository = self.repositories.get(int(match.group(1)))
            return FakeResponse(200, self._repository_json(repository)) if repository else self._not_found()
        match = re.fullmatch(r"/repos/([^/]+)/([^/]+)(/.*)", path)
        assert match, f"Unexpected Forgejo request: GET {path}"
        full_name = f"{unquote(match.group(1))}/{unquote(match.group(2))}"
        repository = next((item for item in self.repositories.values() if item.full_name == full_name), None)
        if repository is None:
            return self._not_found()
        rest = match.group(3)
        if not repository.branches:
            return self._empty_repository_answer(repository, rest)
        if rest == "/branches":
            return self._paged(params, [self._branch_json(repository, name) for name in repository.branches])
        if rest.startswith("/branches/"):
            name = unquote(rest[len("/branches/") :])
            if name not in repository.branches:
                return self._not_found()
            return FakeResponse(200, self._branch_json(repository, name))
        if rest == "/commits":
            return self._commits(repository, params)
        if rest == "/pulls":
            if repository.mirror or not repository.has_pull_requests:
                # Live Forgejo 15: no pull request unit (switched off, or a mirror) → 404.
                return self._not_found()
            return self._pulls(repository, params)
        match = re.fullmatch(r"/git/trees/([0-9a-f]+)", rest)
        if match:
            return self._tree(repository, match.group(1), params)
        match = re.fullmatch(r"/git/blobs/([0-9a-f]+)", rest)
        if match:
            content = repository.blobs.get(match.group(1))
            if content is None:
                return self._not_found()
            return FakeResponse(
                200,
                {
                    "content": base64.b64encode(content).decode("ascii"),
                    "encoding": "base64",
                    "url": f"{self.public_url}/api/v1/repos/{repository.full_name}/git/blobs/{match.group(1)}",
                    "sha": match.group(1),
                    "size": len(content),
                },
            )
        raise AssertionError(f"Unexpected Forgejo request: GET {path}")

    # --- endpoints ---------------------------------------------------------------------------------------------------

    def _empty_repository_answer(self, repository, rest):
        """What a live Forgejo 15 answers for a repository without any branch yet (A2 fix round 1)."""
        swagger = f"{self.public_url}/api/swagger"
        if rest == "/branches":
            return FakeResponse(200, None, {"X-Total-Count": "0"}, raw="null")
        if rest.startswith("/branches/"):
            name = unquote(rest[len("/branches/") :])
            return FakeResponse(
                404,
                {
                    "message": "The target couldn't be found.",
                    "url": swagger,
                    "errors": [f"branch does not exist [name: {name}]"],
                },
            )
        if rest == "/commits":
            return FakeResponse(409, {"message": "Git Repository is empty.", "url": swagger})
        if rest == "/pulls":
            return self._not_found()
        if rest.startswith("/git/trees/"):
            return FakeResponse(400, {"message": f"sha not found [{rest.rsplit('/', 1)[-1]}]", "url": swagger})
        raise AssertionError(f"Unexpected Forgejo request for the empty {repository.full_name}: GET {rest}")

    def _not_found(self):
        return FakeResponse(
            404, {"message": "The target couldn't be found.", "url": f"{self.public_url}/api/swagger", "errors": []}
        )

    @staticmethod
    def _page_window(params):
        page = max(int(params.get("page") or 1), 1)
        limit = int(params.get("limit") or DEFAULT_PAGING_NUM)
        limit = min(max(limit, 1), MAX_RESPONSE_ITEMS)
        return page, limit

    def _paged(self, params, items, *, envelope=False, extra_headers=None):
        page, limit = self._page_window(params)
        chunk = items[(page - 1) * limit : page * limit]
        headers = {"X-Total-Count": str(len(items)), **(extra_headers or {})}
        if page * limit < len(items):
            # The live Link header points at the public ROOT_URL — the client must not follow it.
            headers["Link"] = f'<{self.public_url}/api/v1/next?page={page + 1}>; rel="next"'
        return FakeResponse(200, {"ok": True, "data": chunk} if envelope else chunk, headers)

    def _search(self, params):
        query = str(params.get("q") or "").casefold()
        found = [
            repository
            for repository in self.repositories.values()
            if query in repository.name.casefold() or query in repository.full_name.casefold()
        ]
        found.sort(key=lambda item: item.full_name.casefold())
        return self._paged(params, [self._repository_json(item) for item in found], envelope=True)

    def _ancestors(self, repository, sha):
        seen = set()
        stack = [sha]
        while stack:
            current = stack.pop()
            if current in seen or current not in repository.commits:
                continue
            seen.add(current)
            stack.extend(repository.commits[current].parents)
        return seen

    def _resolve(self, repository, value):
        if value in repository.branches:
            return repository.branches[value]
        return value if value in repository.commits else None

    def _commits(self, repository, params):
        head = self._resolve(repository, params.get("sha") or repository.default_branch)
        if head is None:
            return FakeResponse(404, None, raw="null")
        reachable = self._ancestors(repository, head)
        if params.get("not"):
            excluded = self._resolve(repository, params["not"])
            if excluded is None:
                bad = params["not"]
                return FakeResponse(500, {"message": f"exit status 128 - fatal: bad object {bad}\n"})
            reachable -= self._ancestors(repository, excluded)
        order = list(repository.commits)
        commits = sorted(
            (repository.commits[sha] for sha in reachable),
            key=lambda commit: (moment(commit.committer["date"]), order.index(commit.sha)),
            reverse=True,
        )
        # `since`/`until` are ignored, as by the live Forgejo 15.
        page, limit = self._page_window(params)
        has_more = page * limit < len(commits)
        return self._paged(
            params,
            [self._commit_json(repository, commit) for commit in commits],
            extra_headers={"X-HasMore": "true" if has_more else "false"},
        )

    def _pulls(self, repository, params):
        pulls = list(repository.pulls)
        state = params.get("state") or "open"
        if state != "all":
            pulls = [item for item in pulls if item["state"] == state]
        if params.get("sort") == "recentupdate":
            pulls.sort(key=lambda item: item["updated_at"], reverse=True)
        return self._paged(params, [self._pull_json(repository, item) for item in pulls])

    def _tree(self, repository, sha, params):
        entries = repository.trees.get(sha)
        if entries is None:
            return self._not_found()
        page = max(int(params.get("page") or 1), 1)
        per_page = int(params.get("per_page") or TREES_PER_PAGE)
        per_page = min(max(per_page, 1), TREES_PER_PAGE)
        chunk = entries[(page - 1) * per_page : page * per_page]
        api = f"{self.public_url}/api/v1/repos/{repository.full_name}"
        return FakeResponse(
            200,
            {
                "sha": sha,
                "url": f"{api}/git/trees/{sha}",
                "tree": [
                    {**entry, "url": f"{api}/git/{'blobs' if entry['type'] == 'blob' else 'trees'}/{entry['sha']}"}
                    for entry in chunk
                ],
                # As live: true on every page while the tree is larger than one page.
                "truncated": len(entries) > per_page,
                "page": page,
                "total_count": len(entries),
            },
            {"X-Total-Count": str(len(entries))},
        )

    # --- JSON shapes (the keys of the live answers, see answer_shapes.json) -------------------------------------------

    def _user_json(self, login):
        user = self.users.get(login, {"id": 99, "login": login, "is_admin": False})
        return {
            "id": user["id"],
            "login": login,
            "login_name": "",
            "source_id": 0,
            "full_name": "",
            "email": f"{login}@example.test",
            "avatar_url": f"{self.public_url}/avatars/{hashlib.md5(login.encode()).hexdigest()}",  # noqa: S324
            "html_url": f"{self.public_url}/{login}",
            "language": "",
            "is_admin": user["is_admin"],
            "last_login": "0001-01-01T00:00:00Z",
            "created": "2026-09-28T13:18:12Z",
            "restricted": False,
            "active": False,
            "prohibit_login": False,
            "location": "",
            "pronouns": "",
            "website": "",
            "description": "",
            "visibility": "public",
            "followers_count": 0,
            "following_count": 0,
            "starred_repos_count": 0,
            "username": login,
        }

    def _repository_json(self, repository):
        api = f"{self.public_url}/api/v1/repos/{repository.full_name}"
        return {
            "id": repository.id,
            "owner": self._user_json(repository.owner),
            "name": repository.name,
            "full_name": repository.full_name,
            "description": repository.description,
            "empty": not repository.branches,
            "private": repository.private,
            "fork": False,
            "template": False,
            "parent": None,
            "mirror": repository.mirror,
            "size": 22,
            "language": "",
            "languages_url": f"{api}/languages",
            "html_url": self.html_url(repository),
            "url": api,
            "link": "",
            "ssh_url": f"ssh://git@{self.ssh_host}/{repository.full_name}.git",
            "clone_url": f"{self.html_url(repository)}.git",
            "original_url": "",
            "website": "",
            "stars_count": 0,
            "forks_count": 0,
            "watchers_count": 2,
            "open_issues_count": 0,
            "open_pr_counter": sum(1 for item in repository.pulls if item["state"] == "open"),
            "release_counter": 0,
            "default_branch": repository.default_branch,
            "archived": repository.archived,
            "created_at": repository.created_at,
            "updated_at": repository.updated_at,
            "archived_at": "1970-01-01T00:00:00Z",
            "permissions": {"admin": True, "push": True, "pull": True},
            "has_issues": True,
            "internal_tracker": {
                "enable_time_tracker": True,
                "allow_only_contributors_to_track_time": True,
                "enable_issue_dependencies": True,
            },
            "has_wiki": True,
            "has_wiki_contents": False,
            "wiki_branch": repository.default_branch,
            "wiki_ssh_url": f"ssh://git@{self.ssh_host}/{repository.full_name}.wiki.git",
            "wiki_clone_url": f"{self.html_url(repository)}.wiki.git",
            "globally_editable_wiki": False,
            "has_pull_requests": repository.has_pull_requests and not repository.mirror,
            "has_projects": True,
            "has_releases": True,
            "has_packages": False,
            "has_actions": False,
            "ignore_whitespace_conflicts": False,
            "allow_merge_commits": True,
            "allow_rebase": True,
            "allow_rebase_explicit": True,
            "allow_squash_merge": True,
            "allow_fast_forward_only_merge": True,
            "allow_rebase_update": True,
            "default_delete_branch_after_merge": False,
            "default_merge_style": "merge",
            "default_update_style": "merge",
            "default_allow_maintainer_edit": False,
            "avatar_url": "",
            "internal": repository.internal,
            "mirror_interval": "",
            "object_format_name": "sha1",
            "mirror_updated": "0001-01-01T00:00:00Z",
            "repo_transfer": None,
            "topics": None,
        }

    def _payload_commit(self, repository, commit):
        def person(block):
            return {"name": block["name"], "email": block["email"], "username": commit.author_login}

        return {
            "id": commit.sha,
            "message": commit.message,
            "url": f"{self.html_url(repository)}/commit/{commit.sha}",
            "author": person(commit.author),
            "committer": person(commit.committer),
            "verification": dict(VERIFICATION),
            "timestamp": commit.author["date"],
            "added": None,
            "removed": None,
            "modified": None,
        }

    def _branch_json(self, repository, name):
        return {
            "name": name,
            "commit": self._payload_commit(repository, repository.commits[repository.branches[name]]),
            "protected": False,
            "required_approvals": 0,
            "enable_status_check": False,
            "status_check_contexts": [],
            "user_can_push": True,
            "user_can_merge": True,
            "effective_branch_protection_name": "",
        }

    def _commit_json(self, repository, commit):
        api = f"{self.public_url}/api/v1/repos/{repository.full_name}"
        user = self._user_json(commit.author_login) if commit.author_login else None
        return {
            "url": f"{api}/git/commits/{commit.sha}",
            "sha": commit.sha,
            "created": commit.committer["date"],
            "html_url": f"{self.html_url(repository)}/commit/{commit.sha}",
            "commit": {
                "url": f"{api}/git/commits/{commit.sha}",
                "author": dict(commit.author),
                "committer": dict(commit.committer),
                "message": commit.message,
                "tree": {
                    "url": f"{api}/git/trees/{commit.sha}",
                    "sha": commit.sha,
                    "created": commit.committer["date"],
                },
                "verification": None,
            },
            "author": user,
            "committer": user,
            "parents": [
                {"url": f"{api}/git/commits/{parent}", "sha": parent, "created": commit.committer["date"]}
                for parent in commit.parents
            ],
            "files": None,
            "stats": None,
        }

    def _pull_json(self, repository, pull):
        def side(value):
            label = value["label"]
            present = label in repository.branches
            return {
                "label": label,
                # As live: once the branch is gone the ref is the pull request's own ref.
                "ref": value["ref"]
                if present or value["ref"].startswith("refs/")
                else f"refs/pull/{pull['number']}/head",
                "sha": repository.branches.get(label, value["sha"]),
                "repo_id": repository.id,
                "repo": self._repository_json(repository),
            }

        html = f"{self.html_url(repository)}/pulls/{pull['number']}"
        return {
            "id": pull["id"],
            "url": html,
            "number": pull["number"],
            "user": self._user_json(pull["user_login"]),
            "title": pull["title"],
            "body": pull["body"],
            "labels": [],
            "milestone": None,
            "assignee": None,
            "assignees": None,
            "requested_reviewers": [],
            "requested_reviewers_teams": [],
            "state": pull["state"],
            "draft": pull["draft"],
            "is_locked": False,
            "comments": 0,
            "review_comments": 0,
            "additions": 1,
            "deletions": 0,
            "changed_files": 1,
            "html_url": html,
            "diff_url": f"{html}.diff",
            "patch_url": f"{html}.patch",
            "mergeable": True,
            "merged": pull["merged"],
            "merged_at": pull["merged_at"],
            "merge_commit_sha": pull["merge_commit_sha"],
            "merged_by": self._user_json(pull["user_login"]) if pull["merged"] else None,
            "allow_maintainer_edit": False,
            "base": side(pull["base"]),
            "head": side(pull["head"]),
            "merge_base": pull["base"]["sha"],
            "due_date": None,
            "created_at": pull["created_at"],
            "updated_at": pull["updated_at"],
            "closed_at": pull["closed_at"],
            "pin_order": 0,
            "flow": 0,
        }
