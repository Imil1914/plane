"""In-memory GitHub REST API for G1.3 write-flow contract tests (RC-C).

The fake is plugged into the real ``GitHubAppClient`` as its HTTP session, so the tests exercise the production client
code (token scopes, error mapping, replay rules) while no request ever leaves the process. Any request the fake does
not model fails the test loudly — this is also how the suite proves that PPM never merges, force-pushes, updates or
deletes refs.
"""

import itertools
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import unquote

import requests

API = "https://api.github.com"


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class FakeResponse:
    def __init__(self, status_code, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.links = {}

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


@dataclass
class FakeCommit:
    sha: str
    parent: str | None
    message: str
    author: str


@dataclass
class FakeGitHubApi:
    full_name: str = "ppm-test-org/ppm"
    installation_id: int = 81001
    granted_permissions: dict = field(
        default_factory=lambda: {"metadata": "read", "contents": "write", "pull_requests": "write"}
    )
    installation_state: str = "active"
    draft_supported: bool = True
    app_login: str = "ppm-test-app[bot]"

    def __post_init__(self):
        self._sha_counter = itertools.count(1)
        self._token_counter = itertools.count(1)
        self._pull_counter = itertools.count(1)
        self.commits = {}
        self.branches = {}
        self.pulls = []
        self.tokens = {}
        self.revoked_tokens = set()
        self.revoke_tokens_on_use = False
        self.rule_rejected_branches = set()
        self.injected = []
        self.lost_responses = []
        self.requests = []
        root = self.commit_on("main", "Initial commit", author="founder")
        self.base_sha = root

    # --- repository state helpers -----------------------------------------------------------------------------------
    def next_sha(self):
        return f"{next(self._sha_counter):040x}"

    def commit_on(self, branch, message, *, author="developer"):
        parent = self.branches.get(branch)
        sha = self.next_sha()
        self.commits[sha] = FakeCommit(sha=sha, parent=parent, message=message, author=author)
        self.branches[branch] = sha
        return sha

    def create_foreign_branch(self, name, sha=None):
        self.branches[name] = sha or self.branches["main"]

    def inject(self, method, path_pattern, response, *, times=1):
        """Answer the next ``times`` matching requests with ``response`` (rate limits, outages, drift)."""
        self.injected.append([method, re.compile(path_pattern), response, times])

    def lose_response(self, method, path_pattern, *, times=1):
        """GitHub performs the next ``times`` matching requests, but their answers never arrive (read timeout)."""
        self.lost_responses.append([method, re.compile(path_pattern), times])

    def add_pull_request(
        self, *, head, base="main", title="Manual PR", body="", state="open", draft=False, created_at=None
    ):
        number = next(self._pull_counter)
        pull = {
            "id": 92000 + number,
            "node_id": f"PR_fake_{number}",
            "number": number,
            "title": title,
            "body": body,
            "html_url": f"https://github.com/{self.full_name}/pull/{number}",
            "state": state,
            "draft": draft,
            "merged_at": None,
            "created_at": created_at or now_iso(),
            "updated_at": created_at or now_iso(),
            "user": {"login": "developer", "avatar_url": "https://avatars.example.test/developer"},
            "base": {"ref": base, "sha": self.branches[base]},
            "head": {"ref": head, "sha": self.branches[head]},
        }
        self.pulls.append(pull)
        return pull

    def write_requests(self):
        return [(method, path) for method, path, _ in self.requests if method != "GET" and "/access_tokens" not in path]

    def token_requests(self):
        return [kwargs["json"] for method, path, kwargs in self.requests if path.endswith("/access_tokens")]

    def _ancestors(self, sha):
        seen = []
        while sha is not None:
            seen.append(sha)
            sha = self.commits[sha].parent
        return seen

    # --- HTTP entry point -------------------------------------------------------------------------------------------
    def request(self, method, url, headers=None, params=None, data=None, json=None, timeout=None):
        assert url.startswith(API), f"Unexpected host: {url}"
        path = unquote(url[len(API) :])
        self.requests.append((method, path, {"headers": headers or {}, "params": params, "json": json}))
        for entry in self.injected:
            injected_method, pattern, response, times = entry
            if times > 0 and injected_method == method and pattern.search(path):
                entry[3] -= 1
                return response
        response = self._dispatch(method, path, headers or {}, params, json)
        for entry in self.lost_responses:
            lost_method, pattern, times = entry
            if times > 0 and lost_method == method and pattern.search(path):
                entry[2] -= 1
                raise requests.ReadTimeout("simulated: GitHub performed the request but the answer was lost")
        return response

    def _dispatch(self, method, path, headers, params, json):
        token_match = re.fullmatch(r"/app/installations/(\d+)/access_tokens", path)
        if method == "POST" and token_match:
            return self._issue_token(int(token_match.group(1)), json or {})

        repo_prefix = f"/repos/{self.full_name}/"
        assert path.startswith(repo_prefix), f"Unexpected GitHub request: {method} {path}"
        token = self._authorize(headers)
        if isinstance(token, FakeResponse):
            return token
        rest = path[len(repo_prefix) :]

        if method == "GET" and rest.startswith("git/ref/heads/"):
            return self._get_ref(rest[len("git/ref/heads/") :])
        if method == "POST" and rest == "git/refs":
            return self._create_ref(token, json or {})
        if method == "GET" and rest.startswith("compare/"):
            base, head = rest[len("compare/") :].split("...", 1)
            return self._compare(base, head)
        if method == "GET" and rest == "pulls":
            return self._list_pulls(params or {})
        if method == "POST" and rest == "pulls":
            return self._create_pull(token, json or {})
        raise AssertionError(f"Unexpected GitHub request: {method} {path}")

    # --- endpoints --------------------------------------------------------------------------------------------------
    def _issue_token(self, installation_id, body):
        if installation_id != self.installation_id or self.installation_state == "deleted":
            return FakeResponse(404, {"message": "Not Found"})
        if self.installation_state == "suspended":
            return FakeResponse(403, {"message": "This installation has been suspended"})
        requested = body.get("permissions") or {}
        levels = {"read": 1, "write": 2}
        for name, level in requested.items():
            if levels.get(self.granted_permissions.get(name), 0) < levels[level]:
                return FakeResponse(422, {"message": "The permissions requested are not granted to this installation."})
        token = f"ghs_fake_installation_token_{next(self._token_counter)}"
        self.tokens[token] = dict(requested)
        return FakeResponse(201, {"token": token, "expires_at": "2026-09-26T23:00:00Z"})

    def _authorize(self, headers):
        value = headers.get("Authorization", "")
        token = value.removeprefix("Bearer ")
        if token not in self.tokens or token in self.revoked_tokens:
            return FakeResponse(401, {"message": "Bad credentials"})
        if self.revoke_tokens_on_use:
            # The next call with this token sees it revoked (installation token revoked mid-flight).
            self.revoked_tokens.add(token)
        return token

    def _ref_payload(self, name):
        return {"ref": f"refs/heads/{name}", "object": {"sha": self.branches[name], "type": "commit"}}

    def _get_ref(self, name):
        if name not in self.branches:
            return FakeResponse(404, {"message": "Not Found"})
        return FakeResponse(200, self._ref_payload(name))

    def _create_ref(self, token, body):
        if self.tokens[token].get("contents") != "write":
            return FakeResponse(403, {"message": "Resource not accessible by integration"})
        ref = body.get("ref", "")
        sha = body.get("sha")
        name = ref.removeprefix("refs/heads/")
        if name in self.rule_rejected_branches:
            return FakeResponse(
                422,
                {"message": "Repository rule violations found\n\nCannot create ref due to creations being restricted."},
            )
        if name in self.branches:
            return FakeResponse(422, {"message": "Reference already exists"})
        if sha not in self.commits:
            return FakeResponse(422, {"message": "Object does not exist"})
        self.branches[name] = sha
        return FakeResponse(201, self._ref_payload(name))

    def _commit_payload(self, sha):
        commit = self.commits[sha]
        return {
            "sha": sha,
            "html_url": f"https://github.com/{self.full_name}/commit/{sha}",
            "commit": {"message": commit.message, "author": {"name": commit.author, "date": "2026-09-26T12:00:00Z"}},
            "author": {"login": commit.author},
        }

    def _compare(self, base, head):
        base_sha = self.branches.get(base, base)
        head_sha = self.branches.get(head, head)
        if base_sha not in self.commits or head_sha not in self.commits:
            return FakeResponse(404, {"message": "Not Found"})
        base_ancestors = set(self._ancestors(base_sha))
        head_ancestors = self._ancestors(head_sha)
        ahead = [sha for sha in reversed(head_ancestors) if sha not in base_ancestors]
        behind = [sha for sha in self._ancestors(base_sha) if sha not in set(head_ancestors)]
        merge_base = next((sha for sha in head_ancestors if sha in base_ancestors), None)
        if not ahead and not behind:
            status = "identical"
        elif not behind:
            status = "ahead"
        else:
            status = "diverged" if ahead else "behind"
        return FakeResponse(
            200,
            {
                "status": status,
                "ahead_by": len(ahead),
                "behind_by": len(behind),
                "total_commits": len(ahead),
                "base_commit": self._commit_payload(base_sha),
                "merge_base_commit": self._commit_payload(merge_base) if merge_base else None,
                "commits": [self._commit_payload(sha) for sha in ahead],
            },
        )

    def _list_pulls(self, params):
        owner = self.full_name.split("/", 1)[0]
        values = self.pulls
        if params.get("head"):
            values = [pr for pr in values if f"{owner}:{pr['head']['ref']}" == params["head"]]
        if params.get("base"):
            values = [pr for pr in values if pr["base"]["ref"] == params["base"]]
        if params.get("state", "open") != "all":
            values = [pr for pr in values if pr["state"] == params.get("state", "open")]
        return FakeResponse(200, list(values))

    def _create_pull(self, token, body):
        if self.tokens[token].get("pull_requests") != "write":
            return FakeResponse(403, {"message": "Resource not accessible by integration"})
        base, head = body.get("base"), body.get("head")
        if body.get("draft") is not True:
            raise AssertionError("PPM must create draft pull requests only")
        if not self.draft_supported:
            return FakeResponse(422, {"message": "Draft pull requests are not supported in this repository."})
        owner = self.full_name.split("/", 1)[0]
        if any(pr["head"]["ref"] == head and pr["base"]["ref"] == base and pr["state"] == "open" for pr in self.pulls):
            return FakeResponse(422, {"message": f"A pull request already exists for {owner}:{head}."})
        if base not in self.branches or head not in self.branches:
            return FakeResponse(422, {"message": "Validation Failed"})
        if self._compare(base, head).json()["ahead_by"] == 0:
            return FakeResponse(422, {"message": f"No commits between {base} and {head}"})
        number = next(self._pull_counter)
        pull = {
            "id": 92000 + number,
            "node_id": f"PR_fake_{number}",
            "number": number,
            "title": body.get("title"),
            "body": body.get("body"),
            "html_url": f"https://github.com/{self.full_name}/pull/{number}",
            "state": "open",
            "draft": True,
            "merged_at": None,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "user": {"login": self.app_login, "avatar_url": "https://avatars.example.test/app"},
            "base": {"ref": base, "sha": self.branches[base]},
            "head": {"ref": head, "sha": self.branches[head]},
        }
        self.pulls.append(pull)
        return FakeResponse(201, pull)
