"""Forgejo — PPM's own Git server next to PPM (G2.1, «Наш Git-сервер» in the UI).

PPM reads Forgejo API v1 over the internal address ``PPM_FORGEJO_URL`` with the read-only token of the service account
ppm-bot (``Authorization: token …``; scopes read:repository, read:organization, read:user — no read:admin, so the
repositories to connect come from ``/repos/search``, where the site administrator ppm-bot sees every repository). PPM
never writes to Forgejo. Links shown to people use Forgejo's own public addresses (its ``ROOT_URL`` =
``PPM_FORGEJO_PUBLIC_URL``).

Checked against a live Forgejo 15.0.9 (G2.1 line A2, report §1), where it differs from the Gitea documentation or from
GitHub:

- ``since``/``until`` of ``/repos/{owner}/{repo}/commits`` are ignored (the whole history comes back), so the commit
  cursor is applied here: commits are listed newest first and the listing stops at the first page older than the
  cursor;
- the ``Link`` header carries the public ``ROOT_URL``: pages are requested by ``page``/``limit`` only, never by
  following links; the end of a list is ``X-Total-Count`` (else a short page);
- after the source branch of a pull request is deleted, ``head.ref`` becomes ``refs/pull/<N>/head`` and the branch name
  stays in ``head.label``;
- a wrong token is answered 401 with the token echoed in the message: no text of a Forgejo answer ever reaches an
  exception, a log or a normalized object — only the safe Russian texts below;
- an empty repository (no branch yet) answers branches 200 ``null``, commits 409 «Git Repository is empty.», pull
  requests 404, a branch 404 and a tree 400; pull requests of a repository that has them switched off, or of a mirror
  (``has_pull_requests: false`` — also reported for mirrors), are 404. The client reads ``/repositories/{id}`` first and
  asks only what exists (fix round 1);
- ppm-bot sees every repository, and after a rename the old name may belong to another repository: every read starts
  with ``/repositories/{id}`` of the connected repository and stops with ``GIT_REPOSITORY_MOVED`` when its full name is
  not the connected one — nothing is ever read by a name alone (fix round 1).
"""

import base64
import binascii
import re
from datetime import datetime
from urllib.parse import quote, urlsplit

import requests
from django.conf import settings

from .base import PpmGitProviderError, PpmGitProviderRateLimited


# Forgejo has no app installations: every Forgejo installation row of a project and every normalized Forgejo delivery
# use this constant (controller ruling, G2.1).
FORGEJO_INSTALLATION_ID = 1
REQUEST_TIMEOUT = (5, 15)  # connect, read — seconds
PAGE_SIZE = 50  # Forgejo's default [api] MAX_RESPONSE_ITEMS: a larger `limit` is cut to it
TREE_PAGE_SIZE = 1000  # [api] DEFAULT_GIT_TREES_PER_PAGE
# Branches must be read completely (a branch missing from the answer is marked deleted), so going past this is an error.
BRANCH_PAGE_LIMIT = 40
# Commits and pull requests come newest (most recently updated) first: past the limit only the oldest stay unread.
COMMIT_PAGE_LIMIT = 20
PULL_REQUEST_PAGE_LIMIT = 20
TREE_PAGE_LIMIT = 50
CATCH_UP_LIMIT = 20
DEFAULT_RETRY_AFTER_SECONDS = 60
# 429 and the gateway answers mean «come back later»: the connection waits instead of failing.
WAIT_STATUSES = {429, 502, 503, 504}
COMMIT_LIST_PARAMS = {"stat": "false", "verification": "false", "files": "false"}
SHA_PATTERN = re.compile(r"^[0-9a-f]{40,64}$")
TOKEN_PATTERN = re.compile(r"^[\x21-\x7e]+$")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
# Forgejo's default [repository.pull-request] WORK_IN_PROGRESS_PREFIXES — used only if an answer has no `draft`.
WORK_IN_PROGRESS_PREFIXES = ("wip:", "[wip]")
# `PpmCanvasBinding.source_version` keeps at most 64 characters (A1 finding).
SOURCE_VERSION_LIMIT = 64

INVALID_RESPONSE = ("GIT_PROVIDER_INVALID_RESPONSE", "Git-сервер вернул некорректный ответ.")
MOVED = (
    "GIT_REPOSITORY_MOVED",
    "Репозиторий переименован или перенесён на Git-сервере. Подключите его в разделе «Код» заново.",
)
EMPTY = ("GIT_REPOSITORY_EMPTY", "Репозиторий на Git-сервере пока пуст: код появится после первого push.")
AUTH_FAILED_MESSAGE = (
    "Git-сервер не принял служебный токен PPM. Администратору сервера: перевыпустите его командой "
    "ppm-deploy.sh git-bootstrap --rotate-token."
)


def _setting(name):
    value = getattr(settings, name, "")
    return value.strip() if isinstance(value, str) else ""


def forgejo_is_configured():
    """The provider is on only with the internal address, the public address, the token and the webhook secret."""
    return all(
        _setting(name)
        for name in ("PPM_FORGEJO_URL", "PPM_FORGEJO_PUBLIC_URL", "PPM_FORGEJO_TOKEN", "PPM_FORGEJO_WEBHOOK_SECRET")
    )


def forgejo_public_url():
    """``PPM_FORGEJO_PUBLIC_URL`` without the trailing slash when it is an http(s) address, else ""."""
    value = _setting("PPM_FORGEJO_PUBLIC_URL").rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        return ""
    return value


def forgejo_trusted_origin():
    """``(host, port)`` of an https ``PPM_FORGEJO_PUBLIC_URL``, else None.

    ``services`` refuses local-looking hosts (``*.localhost``, ``.local``, private addresses) in stored Git links. The
    one Git server the operator configured is trusted exactly — this host and port only, and only for repositories of
    this provider (controller ruling after A1): a local stack serves Forgejo on ``git.<…>.localhost``.
    """
    value = forgejo_public_url()
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme.casefold() != "https" or parsed.username or parsed.password:
        return None
    try:
        port = parsed.port or 443
        host = parsed.hostname.rstrip(".").encode("idna").decode("ascii").casefold()
    except (ValueError, UnicodeError):
        return None
    return host, port


def forgejo_ssh_enabled():
    """``PPM_FORGEJO_SSH_ENABLED`` ("0" = off): Forgejo reports an SSH clone address even with its SSH server off."""
    return getattr(settings, "PPM_FORGEJO_SSH_ENABLED", True) is not False


def forgejo_code_file_url(canonical_url, commit_sha, path):
    """Forgejo link to one file at one commit (code index): ``<repository>/src/commit/<sha>/<path>``.

    Checked live: the page exists and carries the line anchors ``L<n>`` that AI answers append (``#L10-L20``).
    """
    return f"{canonical_url.rstrip('/')}/src/commit/{quote(commit_sha, safe='')}/{quote(path, safe='/-._~')}"


def forgejo_branch_url(repository_url, branch):
    return f"{repository_url.rstrip('/')}/src/branch/{quote(branch, safe='/-._')}"


# --- answer parsing --------------------------------------------------------------------------------------------------


def _invalid():
    return PpmGitProviderError(*INVALID_RESPONSE)


def _text(value, *, maximum):
    return value[:maximum] if isinstance(value, str) else ""


def _required_text(payload, key, *, maximum=2048):
    value = payload.get(key) if isinstance(payload, dict) else None
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise _invalid()
    return value


def _required_integer(payload, key):
    value = payload.get(key) if isinstance(payload, dict) else None
    if not isinstance(value, int) or isinstance(value, bool):
        raise _invalid()
    return value


def _required_sha(payload, key):
    value = _required_text(payload, key, maximum=64)
    if not SHA_PATTERN.fullmatch(value):
        raise _invalid()
    return value


def _dict(value):
    return value if isinstance(value, dict) else {}


def _https(value):
    return value if isinstance(value, str) and value.startswith("https://") and len(value) <= 2048 else ""


def _parse_datetime(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _title(value, fallback):
    """One line for a title: whitespace collapsed, control characters dropped, ≤ 500 characters, never empty."""
    line = " ".join(value.split()) if isinstance(value, str) else ""
    line = CONTROL_CHARACTERS.sub("", line)[:500].strip()
    return line or fallback


def _first_line(message):
    for line in message.splitlines():
        if line.strip():
            return line
    return ""


def _branch_name(side):
    """The branch of a pull request side: ``ref``, or ``label`` once the branch is gone (``refs/pull/<N>/head``)."""
    ref = _text(side.get("ref"), maximum=255)
    if ref.startswith("refs/"):
        return _text(side.get("label"), maximum=255)
    return ref


def _has_pull_requests(repository):
    """Pull requests switched off, or a mirror (Forgejo reports `has_pull_requests: false` for it): `/pulls` is 404."""
    return repository.get("has_pull_requests") is not False and repository.get("mirror") is not True


def _total_count(response):
    value = (getattr(response, "headers", None) or {}).get("X-Total-Count")
    return int(value) if isinstance(value, str) and value.isdigit() else None


def _retry_after_seconds(response):
    value = (getattr(response, "headers", None) or {}).get("Retry-After")
    if isinstance(value, str) and value.strip().isdigit():
        return max(1, min(int(value.strip()), 86400))
    return DEFAULT_RETRY_AFTER_SECONDS


def _repository_path(full_name):
    if not isinstance(full_name, str) or full_name.count("/") != 1:
        raise PpmGitProviderError("GIT_REPOSITORY_NOT_FOUND", "Репозиторий не найден на Git-сервере.")
    return "/repos/" + "/".join(quote(part, safe="-._") for part in full_name.split("/"))


# --- normalization (shared with the webhook normalizer) -------------------------------------------------------------


def normalize_forgejo_pull_request(payload):
    """A Forgejo pull request (API answer or webhook ``pull_request``) as ``GitPullRequestObject``."""
    if not isinstance(payload, dict):
        raise _invalid()
    user = _dict(payload.get("user"))
    number = _required_integer(payload, "number")
    updated_at = _parse_datetime(payload.get("updated_at"))
    merged_at = _parse_datetime(payload.get("merged_at"))
    state = _text(payload.get("state"), maximum=32)
    if merged_at is not None or payload.get("merged") is True:
        state = "merged"
    title = _title(payload.get("title"), f"Запрос на слияние #{number}")
    draft = payload.get("draft")
    is_draft = draft if isinstance(draft, bool) else title.casefold().startswith(WORK_IN_PROGRESS_PREFIXES)
    head = _dict(payload.get("head"))
    return {
        "object_type": "pull_request",
        "provider_object_id": str(_required_integer(payload, "id")),
        "ref": str(number),
        "title": title,
        "canonical_url": _required_text(payload, "html_url"),
        "state": state,
        "is_draft": is_draft,
        "author_name": _text(user.get("login"), maximum=255),
        "author_avatar_url": _https(user.get("avatar_url")),
        "base_ref": _branch_name(_dict(payload.get("base"))),
        "head_ref": _branch_name(head),
        "commit_sha": _text(head.get("sha"), maximum=64),
        "metadata": {},
        # No stable global id as GitHub's node_id: the number with the last update — ≤ 55 characters.
        "source_version": f"pr:{number}:{updated_at.isoformat() if updated_at else state}"[:SOURCE_VERSION_LIMIT],
        "provider_updated_at": updated_at,
        "provider_merged_at": merged_at,
    }


def normalize_forgejo_repository(payload):
    """A Forgejo repository as ``ProviderRepository`` (connect flow). No SSH address when PPM's SSH switch is off."""
    if not isinstance(payload, dict):
        raise _invalid()
    owner = _dict(payload.get("owner"))
    if payload.get("private") is True:
        visibility = "private"
    elif payload.get("internal") is True:
        visibility = "internal"
    else:
        visibility = "public"
    return {
        "provider_repository_id": _required_integer(payload, "id"),
        "name": _required_text(payload, "name", maximum=160),
        "full_name": _required_text(payload, "full_name", maximum=255),
        "owner": _text(owner.get("login") or owner.get("username"), maximum=255),
        "canonical_url": _required_text(payload, "html_url"),
        "clone_https": _required_text(payload, "clone_url"),
        "clone_ssh": _text(payload.get("ssh_url"), maximum=2048) if forgejo_ssh_enabled() else "",
        "default_branch": _text(payload.get("default_branch"), maximum=255),
        "visibility": visibility,
        "archived": payload.get("archived") is True,
        "updated_at": _parse_datetime(payload.get("updated_at")),
    }


def _listed_commit(item):
    """``/commits`` item → ``GitCommitObject``."""
    sha = _required_sha(item, "sha")
    commit = _dict(item.get("commit"))
    author_block = _dict(commit.get("author"))
    forgejo_author = _dict(item.get("author"))
    message = _text(commit.get("message"), maximum=10000)
    return {
        "object_type": "commit",
        "provider_object_id": sha,
        "ref": sha[:12],
        "title": _title(_first_line(message), f"Коммит {sha[:12]}"),
        "canonical_url": _required_text(item, "html_url"),
        "state": "committed",
        # The Forgejo login, else the git author name; never an e-mail.
        "author_name": _text(forgejo_author.get("login"), maximum=255) or _text(author_block.get("name"), maximum=255),
        "author_avatar_url": _https(forgejo_author.get("avatar_url")),
        "commit_sha": sha,
        "metadata": {"message": message},
        "source_version": sha,
        "provider_updated_at": _parse_datetime(author_block.get("date")),
    }


def _commit_moment(item):
    commit = _dict(item.get("commit"))
    return _parse_datetime(_dict(commit.get("committer")).get("date")) or _parse_datetime(
        _dict(commit.get("author")).get("date")
    )


def _branch_head_commit(branch_commit):
    """The head commit a branch listing carries (``commit.id``, message, HTML url) → ``GitCommitObject``.

    Unlike GitHub's placeholder for a head the commit listing missed, Forgejo gives the whole commit, so its message
    links it to work items too.
    """
    sha = _required_sha(branch_commit, "id")
    author = _dict(branch_commit.get("author"))
    message = _text(branch_commit.get("message"), maximum=10000)
    return {
        "object_type": "commit",
        "provider_object_id": sha,
        "ref": sha[:12],
        "title": _title(_first_line(message), f"Коммит {sha[:12]}"),
        "canonical_url": _required_text(branch_commit, "url"),
        "state": "committed",
        "author_name": _text(author.get("username"), maximum=255) or _text(author.get("name"), maximum=255),
        "author_avatar_url": "",
        "commit_sha": sha,
        "metadata": {"message": message},
        "source_version": sha,
        "provider_updated_at": _parse_datetime(branch_commit.get("timestamp")),
    }


class ForgejoClient:
    """Read-only Forgejo API v1 client: ``GitProviderClient`` plus the calls of the connect flow.

    The token is read from the settings for each request and is kept nowhere on the client.
    """

    def __init__(self, *, session=None, page_size=PAGE_SIZE):
        self.session = session or requests.Session()
        self.page_size = page_size

    def __repr__(self):
        return "ForgejoClient()"

    # --- GitProviderClient ------------------------------------------------------------------------------------------

    def sync_repository(self, installation_id, repository_id, full_name, *, since=None, catch_up=None):
        """Branches, commits and pull requests of one repository (``SyncRepositoryResult``).

        Commits: the default branch newest first down to the cursor ``since`` (Forgejo ignores ``since``), the head of
        every branch, and — for ``catch_up`` ranges a truncated push left (``providers.base.CatchUpRange``) — every
        commit of the range.
        """
        repository = self._connected_repository(repository_id, full_name)
        if repository.get("empty") is True:
            # Nothing is pushed yet: branches, commits and pull requests of an empty repository are not asked for (its
            # branches answer `null`, its commits 409 and its pull requests 404).
            return {"branches": [], "commits": [], "pull_requests": []}
        repository_url = _required_text(repository, "html_url").rstrip("/")
        default_branch = _text(repository.get("default_branch"), maximum=255)
        path = _repository_path(full_name)
        branches, heads = self._list_branches(path, repository_url)
        commits = self._list_commits(path, since=since)
        known = {commit["provider_object_id"] for commit in commits}
        for entry in (catch_up or [])[:CATCH_UP_LIMIT]:
            for commit in self._catch_up_commits(path, entry, default_branch):
                if commit["provider_object_id"] not in known:
                    known.add(commit["provider_object_id"])
                    commits.append(commit)
        for head in heads:
            if head["provider_object_id"] not in known:
                known.add(head["provider_object_id"])
                commits.append(head)
        pull_requests = []
        if _has_pull_requests(repository):
            pull_requests = [
                normalize_forgejo_pull_request(item)
                for item in self._list(
                    f"{path}/pulls",
                    {"state": "all", "sort": "recentupdate"},
                    max_pages=PULL_REQUEST_PAGE_LIMIT,
                    strict=False,
                )
            ]
        return {"branches": branches, "commits": commits, "pull_requests": pull_requests}

    def get_code_tree(self, installation_id, repository_id, full_name, ref):
        """Every file of branch ``ref`` at its exact head commit; Forgejo pages a recursive tree by ``total_count``.

        Only the connected repository (by id) is read; an empty one has no code yet (``GIT_REPOSITORY_EMPTY``).
        """
        if self._connected_repository(repository_id, full_name).get("empty") is True:
            raise PpmGitProviderError(*EMPTY)
        path = _repository_path(full_name)
        branch = self._get_object(f"{path}/branches/{quote(ref, safe='')}")
        commit_sha = _required_sha(_dict(branch.get("commit")), "id")
        files = []
        seen = 0
        page = 1
        while True:
            tree = self._get_object(
                f"{path}/git/trees/{commit_sha}",
                {"recursive": "true", "page": page, "per_page": TREE_PAGE_SIZE},
            )
            entries = tree.get("tree")
            total = tree.get("total_count")
            if not isinstance(entries, list) or not isinstance(total, int) or isinstance(total, bool):
                raise _invalid()
            seen += len(entries)
            for item in entries:
                if not isinstance(item, dict) or item.get("type") != "blob":
                    continue
                size = item.get("size")
                files.append(
                    {
                        "path": _required_text(item, "path", maximum=1024),
                        "sha": _required_text(item, "sha", maximum=64),
                        "size": size if isinstance(size, int) and not isinstance(size, bool) else None,
                    }
                )
            if seen >= total:
                return {"commit_sha": commit_sha, "files": files}
            if not entries or page >= TREE_PAGE_LIMIT:
                raise PpmGitProviderError(
                    "GIT_CODE_TREE_TOO_LARGE",
                    "Git-сервер не смог вернуть полное дерево репозитория в заданных лимитах.",
                )
            page += 1

    def get_code_blobs(self, installation_id, repository_id, full_name, files):
        """Exactly the requested blobs of the connected repository (checked by id before anything is read)."""
        self._connected_repository(repository_id, full_name)
        path = _repository_path(full_name)
        contents = {}
        for item in files:
            sha = _required_text(item, "sha", maximum=64)
            if sha in contents:
                continue
            payload = self._get_object(f"{path}/git/blobs/{quote(sha, safe='')}")
            content = payload.get("content")
            if payload.get("encoding") != "base64" or not isinstance(content, str):
                raise PpmGitProviderError(
                    "GIT_PROVIDER_INVALID_RESPONSE", "Git-сервер вернул неподдерживаемый Git blob."
                )
            try:
                contents[sha] = base64.b64decode(content.replace("\n", ""), validate=True)
            except (ValueError, binascii.Error):
                raise PpmGitProviderError(
                    "GIT_PROVIDER_INVALID_RESPONSE", "Git-сервер вернул повреждённый Git blob."
                ) from None
        return contents

    def normalize_pull_request(self, payload):
        return normalize_forgejo_pull_request(payload)

    # --- connect flow -----------------------------------------------------------------------------------------------

    def search_repositories(self, *, query="", page=1):
        """One page of ``/repos/search`` (ppm-bot is a site administrator: every repository of the server)."""
        payload, response = self._request(
            "/repos/search",
            {"q": query, "page": page, "limit": self.page_size, "sort": "alpha", "order": "asc"},
        )
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list) or payload.get("ok") is False:
            raise _invalid()
        items = []
        for raw in data:
            if not isinstance(raw, dict):
                continue
            items.append(
                {
                    **normalize_forgejo_repository(raw),
                    "description": _text(raw.get("description"), maximum=2048),
                    "private": raw.get("private") is True,
                }
            )
        total = _total_count(response)
        has_next = page * self.page_size < total if total is not None else len(data) >= self.page_size
        return {"items": items, "page": page, "has_next": has_next}

    def get_repository(self, installation_id, repository_id):
        return normalize_forgejo_repository(self._get_object(f"/repositories/{int(repository_id)}"))

    def get_current_user(self):
        """The account of the token (ppm-bot): recorded on the project's Forgejo installation row."""
        payload = self._get_object("/user")
        return {
            "id": _required_integer(payload, "id"),
            "login": _required_text(payload, "login", maximum=255),
        }

    # --- listings ---------------------------------------------------------------------------------------------------

    def _connected_repository(self, repository_id, full_name):
        """``/repositories/{id}`` of the connected repository; ``GIT_REPOSITORY_MOVED`` when it no longer carries the
        connected full name (renamed or moved — its old name may already belong to another repository)."""
        repository = self._get_object(f"/repositories/{int(repository_id)}")
        if _required_text(repository, "full_name", maximum=255) != full_name:
            raise PpmGitProviderError(*MOVED)
        return repository

    def _list_branches(self, path, repository_url):
        branches = []
        heads = []
        for item in self._list(f"{path}/branches", {}, max_pages=BRANCH_PAGE_LIMIT, strict=True):
            name = _required_text(item, "name", maximum=255)
            commit = _dict(item.get("commit"))
            sha = _required_sha(commit, "id")
            branches.append(
                {
                    "object_type": "branch",
                    "provider_object_id": name,
                    "ref": name,
                    "title": name,
                    "canonical_url": forgejo_branch_url(repository_url, name),
                    "state": "active",
                    "commit_sha": sha,
                    "metadata": {"protected": item.get("protected") is True},
                    "source_version": sha,
                    "provider_updated_at": None,
                }
            )
            heads.append(_branch_head_commit(commit))
        return branches, heads

    def _list_commits(self, path, *, since):
        cursor = _parse_datetime(since) if since else None
        commits = []
        for number, (items, last) in enumerate(self._pages(f"{path}/commits", COMMIT_LIST_PARAMS), start=1):
            newer = 0
            for item in items:
                moment = _commit_moment(item)
                if cursor is None or moment is None or moment >= cursor:
                    commits.append(_listed_commit(item))
                    newer += 1
            if last or number >= COMMIT_PAGE_LIMIT or (cursor is not None and newer == 0):
                break
        return commits

    def _catch_up_commits(self, path, entry, default_branch):
        """Commits of one truncated push: reachable from ``after`` and not from ``before`` (a new branch: not from the
        default branch). An object Forgejo no longer has (force-push) falls back to the default branch, then is
        skipped: the head of every branch is synchronized anyway."""
        if not isinstance(entry, dict):
            return []
        after = entry.get("after")
        if not isinstance(after, str) or not SHA_PATTERN.fullmatch(after):
            return []
        ref = entry.get("ref") if isinstance(entry.get("ref"), str) else ""
        branch = ref.removeprefix("refs/heads/")
        base = entry.get("base") if isinstance(entry.get("base"), str) and entry.get("base") else default_branch
        before = entry.get("before") if isinstance(entry.get("before"), str) else ""
        exclusions = []
        if SHA_PATTERN.fullmatch(before) and set(before) != {"0"}:
            exclusions.append(before)
        if base and base != branch:
            exclusions.append(base)
        for exclusion in exclusions or [None]:
            params = {**COMMIT_LIST_PARAMS, "sha": after}
            if exclusion:
                params["not"] = exclusion
            try:
                items = self._list(f"{path}/commits", params, max_pages=COMMIT_PAGE_LIMIT, strict=False)
            except PpmGitProviderError as exc:
                if exc.http_status in {404, 500}:
                    continue
                raise
            return [_listed_commit(item) for item in items]
        return []

    def _pages(self, path, params):
        """One page after another by ``page``/``limit`` (the ``Link`` header carries the public address). The last page
        is an empty page, the one that reaches ``X-Total-Count``, or — without the header — a short page."""
        seen = 0
        page = 1
        while True:
            payload, response = self._request(path, {**params, "page": page, "limit": self.page_size})
            if payload is None:
                # Live Forgejo 15 answers `null` for an empty list (the branches of an empty repository).
                payload = []
            if not isinstance(payload, list):
                raise _invalid()
            seen += len(payload)
            total = _total_count(response)
            last = (
                not payload
                or (total is not None and seen >= total)
                or (total is None and len(payload) < self.page_size)
            )
            yield [item for item in payload if isinstance(item, dict)], last
            if last:
                return
            page += 1

    def _list(self, path, params, *, max_pages, strict):
        values = []
        for number, (items, last) in enumerate(self._pages(path, params), start=1):
            values.extend(items)
            if last:
                return values
            if number >= max_pages:
                if strict:
                    raise PpmGitProviderError(
                        "GIT_PROVIDER_PAGE_LIMIT", "Git-сервер вернул слишком большой набор данных."
                    )
                return values
        return values

    # --- transport --------------------------------------------------------------------------------------------------

    def _get_object(self, path, params=None):
        payload, _ = self._request(path, params)
        if not isinstance(payload, dict):
            raise _invalid()
        return payload

    def _request(self, path, params=None):
        base = _setting("PPM_FORGEJO_URL").rstrip("/")
        token = _setting("PPM_FORGEJO_TOKEN")
        if not base or not token:
            raise PpmGitProviderError(
                "GIT_PROVIDER_NOT_CONFIGURED",
                "Git-провайдер ещё не настроен администратором PPM.",
            )
        if not TOKEN_PATTERN.fullmatch(token):
            # requests would put the value into its own error text.
            raise PpmGitProviderError("GIT_PROVIDER_AUTH_FAILED", AUTH_FAILED_MESSAGE)
        try:
            response = self.session.request(
                "GET",
                f"{base}/api/v1{path}",
                headers={"Accept": "application/json", "Authorization": f"token {token}"},
                params=params,
                timeout=REQUEST_TIMEOUT,
            )
        except requests.RequestException:
            # No exception chain: a transport error may describe the request it failed on.
            raise PpmGitProviderError("GIT_PROVIDER_UNAVAILABLE", "Git-сервер недоступен.") from None

        status = response.status_code
        if status in WAIT_STATUSES:
            raise PpmGitProviderRateLimited(
                "GIT_PROVIDER_RATE_LIMITED",
                "Git-сервер просит подождать. PPM повторит запрос позже.",
                retry_after_seconds=_retry_after_seconds(response),
                http_status=status,
            )
        if status in {401, 403}:
            raise PpmGitProviderError("GIT_PROVIDER_AUTH_FAILED", AUTH_FAILED_MESSAGE, http_status=status)
        if status == 404:
            raise PpmGitProviderError(
                "GIT_REPOSITORY_NOT_FOUND",
                "Репозиторий или ветка не найдены на Git-сервере.",
                http_status=status,
            )
        if status >= 500:
            raise PpmGitProviderError("GIT_PROVIDER_UNAVAILABLE", "Git-сервер недоступен.", http_status=status)
        if status >= 400:
            raise PpmGitProviderError(
                "GIT_PROVIDER_REQUEST_FAILED", "Git-сервер не выполнил запрос.", http_status=status
            )
        try:
            payload = response.json()
        except ValueError:
            raise PpmGitProviderError(*INVALID_RESPONSE, http_status=status) from None
        return payload, response
