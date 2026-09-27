import base64
import binascii
import hashlib
import re
import time
from datetime import datetime, timedelta
from urllib.parse import quote, urlencode

import jwt
import requests
from django.conf import settings

from .base import PpmGitProviderError, PpmGitProviderRateLimited


GITHUB_API_URL = "https://api.github.com"
GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_ACCEPT = "application/vnd.github+json"
REQUEST_TIMEOUT = (3.05, 15)
READ_PERMISSIONS = {"contents": "read", "pull_requests": "read"}
BRANCH_WRITE_PERMISSIONS = {"contents": "write"}
DRAFT_PULL_REQUEST_WRITE_PERMISSIONS = {"contents": "read", "pull_requests": "write"}
COMMIT_SUMMARY_LIMIT = 20
# G1.3: every SHA that PPM shows, stores or puts into a manual command must be a plain hex object id.
SHA_PATTERN = re.compile(r"^[0-9a-f]{40,64}$")
# A PR without our marker counts as someone else's only if it clearly predates our first attempt (clock skew).
FOREIGN_PULL_REQUEST_MARGIN = timedelta(minutes=2)


def github_app_is_configured():
    return bool(settings.PPM_GITHUB_APP_CONFIGURED)


def _required_string(payload, key, *, maximum=2048):
    value = payload.get(key)
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул неполные данные.")
    return value


def _optional_string(payload, key, *, maximum=2048):
    value = payload.get(key)
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > maximum:
        return ""
    return value


def _required_integer(payload, key):
    value = payload.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул неполные данные.")
    return value


def _parse_datetime(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _error_message(response):
    """GitHub's short error text, used only to classify an answer — never shown or logged verbatim."""
    try:
        payload = response.json()
    except (AttributeError, TypeError, ValueError):
        return ""
    message = payload.get("message") if isinstance(payload, dict) else None
    return message[:500] if isinstance(message, str) else ""


def _is_rate_limited(response):
    """Primary limits carry ``X-RateLimit-Remaining: 0``; secondary limits come as 403/429 with ``Retry-After``
    and/or a "secondary rate limit" message while the primary budget is still positive."""
    if response.status_code == 429:
        return True
    if response.status_code != 403:
        return False
    headers = response.headers or {}
    if headers.get("X-RateLimit-Remaining") == "0" or headers.get("Retry-After"):
        return True
    return "rate limit" in _error_message(response).casefold()


def _require_sha(payload, key):
    sha = _required_string(payload, key, maximum=64)
    if not SHA_PATTERN.fullmatch(sha):
        raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул некорректный идентификатор коммита.")
    return sha


def pull_request_marker(action_id):
    """Hidden, per-action marker PPM puts into every PR body it creates; the only proof a PR is PPM's own."""
    return f"<!-- ppm-write-action:{action_id} -->"


def pull_request_body_with_marker(body, marker):
    return f"{body}\n\n{marker}" if body else marker


def _definitive_rejection(error):
    """A 4xx answer means GitHub refused the write; transport errors, 5xx and broken 2xx bodies leave it unknown."""
    return error.http_status is not None and 400 <= error.http_status < 500


def _mark_write_outcome(error):
    definitive = _definitive_rejection(error)
    error.write_outcome = "not_performed" if definitive else "unknown"
    error.write_request_unanswered = not definitive
    return error


def _classify_ref_rejection(message):
    if "already exists" in message.casefold():
        return (
            "GITHUB_BRANCH_CONFLICT",
            "GitHub не создал ветку: ветка с таким именем уже существует. PPM её не изменяет.",
        )
    return (
        "GITHUB_BRANCH_REJECTED",
        "GitHub отклонил создание ветки. Проверьте правила репозитория (защищённые ветки, rulesets) и права "
        "приложения.",
    )


def _classify_pull_request_rejection(message):
    text = message.casefold()
    if "draft pull requests are not supported" in text:
        return (
            "GITHUB_DRAFT_UNSUPPORTED",
            "GitHub не поддерживает черновики PR в этом репозитории (ограничение тарифа GitHub). "
            "Создайте PR в GitHub вручную.",
        )
    if "already exists" in text:
        return (
            "GITHUB_PULL_REQUEST_EXISTS",
            "Для этой ветки в GitHub уже есть pull request. PPM не создаёт дубликаты.",
        )
    if "no commits between" in text:
        return (
            "GITHUB_PULL_REQUEST_EMPTY",
            "Между ветками нет новых коммитов. Сначала отправьте коммит в новую ветку.",
        )
    return (
        "GITHUB_PULL_REQUEST_REJECTED",
        "GitHub отклонил создание черновика PR. Проверьте ветки, правила репозитория и права приложения.",
    )


class GitHubAppClient:
    def __init__(self, *, session=None, clock=None):
        self.session = session or requests.Session()
        self.clock = clock or time.time

    @property
    def installation_url(self):
        slug = quote(settings.PPM_GITHUB_APP_SLUG, safe="-")
        return f"https://github.com/apps/{slug}/installations/new"

    def installation_url_with_state(self, state):
        return f"{self.installation_url}?state={quote(state, safe='')}"

    def user_authorization_url(self, state, code_verifier):
        challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("ascii")).digest()).rstrip(b"=")
        query = urlencode(
            {
                "client_id": settings.PPM_GITHUB_APP_CLIENT_ID,
                "redirect_uri": settings.PPM_GITHUB_CALLBACK_URL,
                "state": state,
                "code_challenge": challenge.decode("ascii"),
                "code_challenge_method": "S256",
            }
        )
        return f"https://github.com/login/oauth/authorize?{query}"

    def exchange_user_code(self, code, code_verifier):
        if not isinstance(code, str) or not code or len(code) > 512:
            raise PpmGitProviderError("GITHUB_CONNECT_INVALID", "GitHub не вернул код подтверждения.")
        if not isinstance(code_verifier, str) or not 43 <= len(code_verifier) <= 128:
            raise PpmGitProviderError("GITHUB_CONNECT_INVALID", "Проверка подключения GitHub недействительна.")
        response = self._request(
            "POST",
            GITHUB_OAUTH_TOKEN_URL,
            headers={"Accept": "application/json"},
            data={
                "client_id": settings.PPM_GITHUB_APP_CLIENT_ID,
                "client_secret": settings.PPM_GITHUB_APP_CLIENT_SECRET,
                "code": code,
                "redirect_uri": settings.PPM_GITHUB_CALLBACK_URL,
                "code_verifier": code_verifier,
            },
            include_api_headers=False,
        )
        token = _required_string(response, "access_token", maximum=4096)
        return token

    def get_app_webhook_configuration(self):
        payload = self._request(
            "GET",
            f"{GITHUB_API_URL}/app/hook/config",
            token=self._app_jwt(),
        )
        if not isinstance(payload, dict):
            raise PpmGitProviderError(
                "GITHUB_INVALID_RESPONSE",
                "GitHub вернул некорректную конфигурацию webhook.",
            )
        return {
            "url": _required_string(payload, "url"),
            "content_type": _optional_string(payload, "content_type", maximum=32),
            "insecure_ssl": str(payload.get("insecure_ssl", "0")),
        }

    def list_app_webhook_deliveries(self, *, limit=10):
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        payload = self._request(
            "GET",
            f"{GITHUB_API_URL}/app/hook/deliveries",
            token=self._app_jwt(),
            params={"per_page": limit},
        )
        if not isinstance(payload, list):
            raise PpmGitProviderError(
                "GITHUB_INVALID_RESPONSE",
                "GitHub вернул некорректный список доставок webhook.",
            )
        return [item for item in payload if isinstance(item, dict)][:limit]

    def get_user_installation(self, user_token, installation_id):
        requested = int(installation_id)
        url = f"{GITHUB_API_URL}/user/installations"
        while url:
            payload, response = self._request_with_response(
                "GET",
                url,
                token=user_token,
                params={"per_page": 100},
            )
            installations = payload.get("installations") if isinstance(payload, dict) else None
            if not isinstance(installations, list):
                raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул неполные данные установки.")
            for installation in installations:
                if isinstance(installation, dict) and installation.get("id") == requested:
                    return self.normalize_installation(installation)
            url = self._next_url(response)
        raise PpmGitProviderError(
            "GITHUB_INSTALLATION_NOT_OWNED",
            "Установка GitHub App не принадлежит текущему пользователю GitHub.",
        )

    def get_installation(self, installation_id):
        payload = self._request(
            "GET",
            f"{GITHUB_API_URL}/app/installations/{int(installation_id)}",
            token=self._app_jwt(),
        )
        if not isinstance(payload, dict):
            raise PpmGitProviderError(
                "GITHUB_INVALID_RESPONSE",
                "GitHub вернул некорректные данные установки.",
            )
        return self.normalize_installation(payload)

    def list_repositories(self, installation_id):
        token = self.create_installation_token(installation_id)
        repositories = []
        url = f"{GITHUB_API_URL}/installation/repositories"
        while url:
            payload, response = self._request_with_response(
                "GET",
                url,
                token=token,
                params={"per_page": 100},
            )
            items = payload.get("repositories") if isinstance(payload, dict) else None
            if not isinstance(items, list):
                raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub не вернул список репозиториев.")
            repositories.extend(self.normalize_repository(item) for item in items if isinstance(item, dict))
            url = self._next_url(response)
        return repositories

    def get_repository(self, installation_id, repository_id):
        token = self.create_installation_token(installation_id, repository_ids=[int(repository_id)])
        payload = self._request("GET", f"{GITHUB_API_URL}/repositories/{int(repository_id)}", token=token)
        if not isinstance(payload, dict):
            raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub не вернул данные репозитория.")
        return self.normalize_repository(payload)

    def sync_repository(self, installation_id, repository_id, full_name, *, since=None):
        token = self.create_installation_token(installation_id, repository_ids=[int(repository_id)])
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        branches = self._list_branches(token, safe_full_name, full_name)
        commits = self._list_commits(token, safe_full_name, since=since)
        commits.extend(self._missing_branch_head_commits(branches, commits, full_name))
        pull_requests = self._list_pull_requests(token, safe_full_name)
        return {"branches": branches, "commits": commits, "pull_requests": pull_requests}

    def get_code_tree(self, installation_id, repository_id, full_name, ref):
        token = self.create_installation_token(installation_id, repository_ids=[int(repository_id)])
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        commit = self._request(
            "GET",
            f"{GITHUB_API_URL}/repos/{safe_full_name}/commits/{quote(ref, safe='/-._')}",
            token=token,
        )
        if not isinstance(commit, dict):
            raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub не вернул commit для индексации.")
        commit_sha = _required_string(commit, "sha", maximum=64)
        tree = self._request(
            "GET",
            f"{GITHUB_API_URL}/repos/{safe_full_name}/git/trees/{quote(commit_sha, safe='')}",
            token=token,
            params={"recursive": "1"},
        )
        if not isinstance(tree, dict) or tree.get("truncated") is True or not isinstance(tree.get("tree"), list):
            raise PpmGitProviderError(
                "GITHUB_CODE_TREE_TOO_LARGE",
                "GitHub не смог вернуть полное дерево репозитория в заданных лимитах.",
            )
        files = []
        for item in tree["tree"]:
            if not isinstance(item, dict) or item.get("type") != "blob":
                continue
            files.append(
                {
                    "path": _required_string(item, "path", maximum=1024),
                    "sha": _required_string(item, "sha", maximum=64),
                    "size": item.get("size") if isinstance(item.get("size"), int) else None,
                }
            )
        return {"commit_sha": commit_sha, "files": files}

    def get_code_blobs(self, installation_id, repository_id, full_name, files):
        token = self.create_installation_token(installation_id, repository_ids=[int(repository_id)])
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        contents = {}
        for item in files:
            sha = _required_string(item, "sha", maximum=64)
            payload = self._request(
                "GET",
                f"{GITHUB_API_URL}/repos/{safe_full_name}/git/blobs/{quote(sha, safe='')}",
                token=token,
            )
            if not isinstance(payload, dict) or payload.get("encoding") != "base64":
                raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул неподдерживаемый Git blob.")
            encoded = _required_string(payload, "content", maximum=2_000_000).replace("\n", "")
            try:
                contents[sha] = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise PpmGitProviderError(
                    "GITHUB_INVALID_RESPONSE",
                    "GitHub вернул повреждённый Git blob.",
                ) from exc
        return contents

    def get_branch_heads(self, installation_id, repository_id, full_name, refs):
        """Read-only: the exact head SHA of each branch (``None`` when it does not exist). Never writes."""
        token = self.create_installation_token(installation_id, repository_ids=[int(repository_id)])
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        heads = {}
        for ref in refs:
            value = self._get_git_ref(token, safe_full_name, ref, required=False)
            heads[ref] = value["sha"] if value else None
        return heads

    def get_pull_request_preview(
        self,
        installation_id,
        repository_id,
        full_name,
        *,
        base_ref,
        head_ref,
        commit_limit=COMMIT_SUMMARY_LIMIT,
    ):
        """Read-only state for the draft PR preview: exact base/head SHA, commits ahead and PRs for these branches.

        Only an open PR blocks a new one (GitHub allows a new PR after a closed one); closed and merged PRs are
        returned separately for reference.
        """
        token = self.create_installation_token(installation_id, repository_ids=[int(repository_id)])
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        base = self._get_git_ref(token, safe_full_name, base_ref)
        head = self._get_git_ref(token, safe_full_name, head_ref)
        comparison = self._compare(token, safe_full_name, base["sha"], head["sha"])
        ahead_by = comparison.get("ahead_by")
        behind_by = comparison.get("behind_by")
        if not isinstance(ahead_by, int) or isinstance(ahead_by, bool) or ahead_by < 0:
            raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул некорректное сравнение веток.")
        raw_commits = comparison.get("commits") if isinstance(comparison.get("commits"), list) else []
        commits = [self._normalize_compare_commit(item) for item in raw_commits if isinstance(item, dict)]
        raw_pull_requests = self._branch_pull_requests(token, safe_full_name, full_name, base_ref, head_ref)
        pull_requests = []
        for raw in raw_pull_requests:
            item = self.normalize_pull_request(raw)
            pull_requests.append(
                {
                    "provider_object_id": item["provider_object_id"],
                    "number": item["ref"],
                    "title": item["title"],
                    "canonical_url": item["canonical_url"],
                    "state": item["state"],
                    "is_draft": item["is_draft"],
                }
            )
        return {
            "base_ref": base_ref,
            "base_sha": base["sha"],
            "head_ref": head_ref,
            "head_sha": head["sha"],
            "ahead_by": ahead_by,
            "behind_by": behind_by if isinstance(behind_by, int) and not isinstance(behind_by, bool) else 0,
            "truncated": ahead_by > min(len(commits), commit_limit),
            "commits": commits[:commit_limit],
            "existing_pull_requests": [item for item in pull_requests if item["state"] == "open"],
            "previous_pull_requests": [item for item in pull_requests if item["state"] != "open"],
        }

    def create_branch(
        self,
        installation_id,
        repository_id,
        full_name,
        *,
        base_ref,
        head_ref,
        base_sha=None,
        allow_replay=False,
    ):
        """Create only the new ref ``head_ref`` at the exact base commit. Never updates, deletes or force-moves refs.

        ``base_sha`` fences the write to the commit shown in the preview. ``allow_replay`` (reconciling) is set only
        while an earlier attempt of the same action may have written: a branch with exactly this name that stands
        on the previewed commit or descends from it (pushed to since) is then that attempt's result. Any other
        existing branch cannot be proven either way and is reported as unconfirmed — never as someone else's. On a
        first attempt (nothing written before) an existing branch is someone else's.
        """
        token = self.create_installation_token(
            installation_id,
            repository_ids=[int(repository_id)],
            permissions=BRANCH_WRITE_PERMISSIONS,
        )
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        base = self._get_git_ref(token, safe_full_name, base_ref)
        target_sha = base_sha or base["sha"]
        existing = self._get_git_ref(token, safe_full_name, head_ref, required=False)
        if existing is not None:
            if allow_replay and self._is_our_branch(token, safe_full_name, target_sha, existing["sha"], base_sha):
                return self._branch_result(full_name, head_ref, existing["sha"], created=False)
            if allow_replay:
                raise self._unconfirmed_branch(full_name, head_ref)
            if existing["sha"] != target_sha:
                raise PpmGitProviderError(
                    "GITHUB_BRANCH_CONFLICT",
                    "Ветка с таким именем уже существует и указывает на другой commit. "
                    "PPM не изменяет чужие ветки — выберите другое имя.",
                    write_outcome="not_performed",
                )
            raise PpmGitProviderError(
                "GITHUB_BRANCH_CONFLICT",
                "Ветка с таким именем уже существует в GitHub. PPM не присваивает чужие ветки — выберите другое имя.",
                write_outcome="not_performed",
            )
        # The branch is absent: no earlier attempt of this action created it.
        if base_sha is not None and base["sha"] != base_sha:
            raise PpmGitProviderError(
                "GITHUB_BASE_MOVED",
                "Базовая ветка изменилась после предпросмотра. Подготовьте новый предпросмотр ветки.",
                write_outcome="not_performed",
            )
        try:
            payload = self._request(
                "POST",
                f"{GITHUB_API_URL}/repos/{safe_full_name}/git/refs",
                token=token,
                json={"ref": f"refs/heads/{head_ref}", "sha": target_sha},
                conflict_code=_classify_ref_rejection,
            )
            created = self._normalize_git_ref(payload)
            if created["ref"] != f"refs/heads/{head_ref}" or created["sha"] != target_sha:
                raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул неожиданную созданную ветку.")
        except PpmGitProviderError as exc:
            if allow_replay and exc.code == "GITHUB_BRANCH_CONFLICT":
                # 422 «Reference already exists»: the branch appeared between our read and our write — possibly
                # the earlier attempt landing late. Look again instead of guessing.
                again = self._get_git_ref(token, safe_full_name, head_ref, required=False)
                if again is not None and self._is_our_branch(token, safe_full_name, target_sha, again["sha"], base_sha):
                    return self._branch_result(full_name, head_ref, again["sha"], created=False)
                raise self._unconfirmed_branch(full_name, head_ref) from exc
            raise _mark_write_outcome(exc)
        return self._branch_result(full_name, head_ref, target_sha, created=True)

    def create_draft_pull_request(
        self,
        installation_id,
        repository_id,
        full_name,
        *,
        base_ref,
        head_ref,
        title,
        body,
        marker,
        base_sha=None,
        head_sha=None,
        reconciling=False,
        first_attempt_at=None,
    ):
        """Create only a draft pull request. Never merges, never marks ready for review, never pushes commits.

        Every PR PPM creates carries ``marker`` (hidden HTML comment tied to the write action) in its body; only an
        OPEN PR with that marker for exactly these branches is ever taken as this action's result — never a closed
        one, never a look-alike without the marker. ``base_sha``/``head_sha`` fence the write to the previewed
        commits. While ``reconciling`` (an earlier attempt may have written), an open PR without the marker is
        called someone else's only when it clearly predates ``first_attempt_at``; otherwise the outcome is reported
        as unconfirmed.
        """
        token = self.create_installation_token(
            installation_id,
            repository_ids=[int(repository_id)],
            permissions=DRAFT_PULL_REQUEST_WRITE_PERMISSIONS,
        )
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        base = self._get_git_ref(token, safe_full_name, base_ref)
        head = self._get_git_ref(token, safe_full_name, head_ref)
        empty = PpmGitProviderError(
            "GITHUB_PULL_REQUEST_EMPTY",
            "Сначала добавьте и отправьте хотя бы один commit в новую ветку.",
            write_outcome="not_performed",
        )
        if not reconciling and base["sha"] == head["sha"]:
            raise empty

        pull_requests = self._branch_pull_requests(token, safe_full_name, full_name, base_ref, head_ref)
        ours = self._our_pull_request(pull_requests, marker, base_ref=base_ref, head_ref=head_ref)
        if ours is not None:
            return ours
        foreign_open = [
            item for item in pull_requests if item.get("state") == "open" and marker not in (item.get("body") or "")
        ]
        if foreign_open:
            if reconciling and not self._predates(foreign_open, first_attempt_at):
                raise self._unconfirmed_pull_request(full_name, head_ref)
            first = self.normalize_pull_request(foreign_open[0])
            raise PpmGitProviderError(
                "GITHUB_PULL_REQUEST_EXISTS",
                "Для этой ветки в GitHub уже есть открытый pull request, созданный не через PPM. PPM не присваивает "
                "чужие PR — откройте его в GitHub.",
                details={"canonical_url": first["canonical_url"]},
                write_outcome="not_performed",
            )
        # No PR of this action exists in GitHub (checked above, PRs cannot be deleted); fence to the previewed commits.
        if base["sha"] == head["sha"]:
            raise empty
        if head_sha is not None and head["sha"] != head_sha:
            raise PpmGitProviderError(
                "GITHUB_HEAD_MOVED",
                "В ветку отправлены новые коммиты после предпросмотра. Подготовьте новый предпросмотр, "
                "чтобы проверить их перед созданием черновика PR.",
                write_outcome="not_performed",
            )
        if base_sha is not None and base["sha"] != base_sha:
            raise PpmGitProviderError(
                "GITHUB_BASE_MOVED",
                "Базовая ветка изменилась после предпросмотра. Подготовьте новый предпросмотр черновика PR.",
                write_outcome="not_performed",
            )
        try:
            payload = self._request(
                "POST",
                f"{GITHUB_API_URL}/repos/{safe_full_name}/pulls",
                token=token,
                json={
                    "title": title,
                    "body": pull_request_body_with_marker(body, marker),
                    "head": head_ref,
                    "base": base_ref,
                    "draft": True,
                },
                conflict_code=_classify_pull_request_rejection,
            )
            result = self._normalize_written_pull_request(payload)
        except PpmGitProviderError as exc:
            if exc.code == "GITHUB_PULL_REQUEST_EXISTS":
                # 422 «A pull request already exists»: a PR appeared between our listing and our write — possibly
                # the earlier attempt landing late. Look again instead of guessing.
                again = self._branch_pull_requests(token, safe_full_name, full_name, base_ref, head_ref)
                ours = self._our_pull_request(again, marker, base_ref=base_ref, head_ref=head_ref)
                if ours is not None:
                    return ours
                if reconciling:
                    raise self._unconfirmed_pull_request(full_name, head_ref) from exc
            raise _mark_write_outcome(exc)
        return {**result, "created": True}

    def _our_pull_request(self, pull_requests, marker, *, base_ref, head_ref):
        """This action's open PR (by marker and exact branches); a closed one is reported, never adopted."""
        ours = [item for item in pull_requests if marker in (item.get("body") or "")]
        for item in ours:
            head = item.get("head") if isinstance(item.get("head"), dict) else {}
            base = item.get("base") if isinstance(item.get("base"), dict) else {}
            if item.get("state") == "open" and head.get("ref") == head_ref and base.get("ref") == base_ref:
                return {**self._normalize_written_pull_request(item), "created": False}
        if ours:
            closed = self.normalize_pull_request(ours[0])
            raise PpmGitProviderError(
                "GITHUB_PULL_REQUEST_CLOSED",
                "Черновик PR, созданный прошлой попыткой этого действия, уже закрыт в GitHub. PPM не открывает его "
                "заново и не создаёт дубликат — при необходимости подготовьте новый черновик.",
                details={"canonical_url": closed["canonical_url"]},
                write_outcome="exists",
            )
        return None

    def _normalize_written_pull_request(self, payload):
        result = self.normalize_pull_request(payload)
        if result["commit_sha"] and not SHA_PATTERN.fullmatch(result["commit_sha"]):
            result["commit_sha"] = ""
        return result

    @staticmethod
    def _predates(pull_requests, first_attempt_at):
        if first_attempt_at is None:
            return False
        for item in pull_requests:
            created_at = _parse_datetime(item.get("created_at"))
            if created_at is None or created_at >= first_attempt_at - FOREIGN_PULL_REQUEST_MARGIN:
                return False
        return True

    def _is_our_branch(self, token, safe_full_name, target_sha, sha, base_sha):
        return sha == target_sha or (
            base_sha is not None and self._descends_from(token, safe_full_name, target_sha, sha)
        )

    @staticmethod
    def _unconfirmed_branch(full_name, head_ref):
        return PpmGitProviderError(
            "GITHUB_BRANCH_UNCONFIRMED",
            "Не удалось подтвердить, создана ли ветка прошлой попыткой — проверьте в GitHub. Ветка с этим именем "
            "есть, но PPM не может доказать, что она своя, и ничего с ней не делает.",
            details={"canonical_url": f"https://github.com/{full_name}/tree/{quote(head_ref, safe='/-._')}"},
            write_outcome="unknown",
        )

    @staticmethod
    def _unconfirmed_pull_request(full_name, head_ref):
        search = quote(f"is:pr head:{head_ref}", safe="")
        return PpmGitProviderError(
            "GITHUB_PULL_REQUEST_UNCONFIRMED",
            "Не удалось подтвердить, создан ли PR — проверьте в GitHub. Для этой ветки есть открытый PR без отметки "
            "PPM, появившийся после первой попытки: PPM не может доказать, что он свой, и не создаёт второй.",
            details={"canonical_url": f"https://github.com/{full_name}/pulls?q={search}"},
            write_outcome="unknown",
        )

    def _branch_pull_requests(self, token, safe_full_name, full_name, base_ref, head_ref):
        owner = full_name.split("/", 1)[0]
        pull_requests = self._request(
            "GET",
            f"{GITHUB_API_URL}/repos/{safe_full_name}/pulls",
            token=token,
            params={"state": "all", "head": f"{owner}:{head_ref}", "base": base_ref, "per_page": 100},
        )
        if not isinstance(pull_requests, list):
            raise PpmGitProviderError(
                "GITHUB_INVALID_RESPONSE",
                "GitHub вернул некорректный список pull requests.",
            )
        return [item for item in pull_requests if isinstance(item, dict)]

    def _compare(self, token, safe_full_name, base_sha, head_sha):
        spec = f"{quote(base_sha, safe='')}...{quote(head_sha, safe='')}"
        comparison = self._request("GET", f"{GITHUB_API_URL}/repos/{safe_full_name}/compare/{spec}", token=token)
        if not isinstance(comparison, dict):
            raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул некорректное сравнение веток.")
        return comparison

    def _descends_from(self, token, safe_full_name, ancestor_sha, sha):
        """True when ``sha`` is ``ancestor_sha`` or has it in its history (the branch was pushed to since)."""
        comparison = self._compare(token, safe_full_name, ancestor_sha, sha)
        return comparison.get("status") in {"ahead", "identical"}

    @staticmethod
    def _normalize_compare_commit(item):
        commit = item.get("commit") if isinstance(item.get("commit"), dict) else {}
        author_block = commit.get("author") if isinstance(commit.get("author"), dict) else {}
        github_author = item.get("author") if isinstance(item.get("author"), dict) else {}
        message = _optional_string(commit, "message", maximum=10000)
        return {
            "sha": _require_sha(item, "sha"),
            "title": (message.splitlines()[0] if message else "")[:200],
            "author": _optional_string(github_author, "login", maximum=255)
            or _optional_string(author_block, "name", maximum=255),
            "canonical_url": _optional_string(item, "html_url"),
        }

    def _get_git_ref(self, token, safe_full_name, ref, *, required=True):
        try:
            payload = self._request(
                "GET",
                f"{GITHUB_API_URL}/repos/{safe_full_name}/git/ref/heads/{quote(ref, safe='/-._')}",
                token=token,
            )
        except PpmGitProviderError as exc:
            if not required and exc.code == "GITHUB_NOT_FOUND":
                return None
            if required and exc.code == "GITHUB_NOT_FOUND":
                raise PpmGitProviderError(
                    "GITHUB_BRANCH_NOT_FOUND",
                    "GitHub не нашёл указанную ветку.",
                ) from exc
            raise
        return self._normalize_git_ref(payload)

    @staticmethod
    def _normalize_git_ref(payload):
        reference = payload.get("ref") if isinstance(payload, dict) else None
        git_object = payload.get("object") if isinstance(payload, dict) else None
        if not isinstance(git_object, dict):
            git_object = {}
        if not isinstance(reference, str) or not reference.startswith("refs/heads/"):
            raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул некорректную ветку.")
        return {"ref": reference, "sha": _require_sha(git_object, "sha")}

    @staticmethod
    def _branch_result(full_name, head_ref, sha, *, created):
        return {
            "ref": head_ref,
            "sha": sha,
            "canonical_url": f"https://github.com/{full_name}/tree/{quote(head_ref, safe='/-._')}",
            "created": created,
        }

    def create_installation_token(self, installation_id, *, repository_ids=None, permissions=None):
        body = {"permissions": dict(permissions or READ_PERMISSIONS)}
        if repository_ids:
            body["repository_ids"] = [int(value) for value in repository_ids]
        wants_write = "write" in body["permissions"].values()
        try:
            payload = self._request(
                "POST",
                f"{GITHUB_API_URL}/app/installations/{int(installation_id)}/access_tokens",
                token=self._app_jwt(),
                json=body,
                conflict_code="GITHUB_WRITE_PERMISSION_MISSING" if wants_write else "GITHUB_PERMISSIONS_MISSING",
                conflict_message=(
                    "GitHub App не получила запрошенные права для этого репозитория. Проверьте права приложения "
                    "в GitHub и нажмите «Проверить права»."
                ),
            )
        except PpmGitProviderRateLimited:
            raise
        except PpmGitProviderError as exc:
            # G1.3 (RC-C): a revoked or suspended installation must read as such, not as a generic 404/403.
            if exc.code == "GITHUB_NOT_FOUND":
                raise PpmGitProviderError(
                    "GITHUB_INSTALLATION_REVOKED",
                    "Установка GitHub App удалена или больше недоступна. Подключите репозиторий заново.",
                ) from exc
            if exc.code == "GITHUB_PERMISSION_DENIED":
                raise PpmGitProviderError(
                    "GITHUB_INSTALLATION_SUSPENDED",
                    "GitHub не выдал доступ приложению: установка приостановлена или ограничена.",
                ) from exc
            raise
        return _required_string(payload, "token", maximum=4096)

    def normalize_installation(self, payload):
        account = payload.get("account")
        if not isinstance(account, dict):
            raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub не вернул владельца установки.")
        permissions = payload.get("permissions") if isinstance(payload.get("permissions"), dict) else {}
        events = payload.get("events") if isinstance(payload.get("events"), list) else []
        return {
            "provider_installation_id": _required_integer(payload, "id"),
            "provider_account_id": _required_integer(account, "id"),
            "account_login": _required_string(account, "login", maximum=255),
            "account_type": _optional_string(account, "type", maximum=32),
            "repository_selection": _optional_string(payload, "repository_selection", maximum=16) or "selected",
            "permissions": {
                str(key): str(value)
                for key, value in permissions.items()
                if isinstance(key, str) and isinstance(value, str)
            },
            "events": [str(value) for value in events if isinstance(value, str)][:64],
        }

    def normalize_repository(self, payload):
        owner = payload.get("owner") if isinstance(payload.get("owner"), dict) else {}
        visibility = payload.get("visibility")
        if visibility not in {"public", "private", "internal"}:
            visibility = "private" if payload.get("private") is True else "public"
        full_name = _required_string(payload, "full_name", maximum=255)
        return {
            "provider_repository_id": _required_integer(payload, "id"),
            "name": _required_string(payload, "name", maximum=160),
            "full_name": full_name,
            "owner": _optional_string(owner, "login", maximum=255),
            "canonical_url": _required_string(payload, "html_url"),
            "clone_https": _required_string(payload, "clone_url"),
            "clone_ssh": _optional_string(payload, "ssh_url"),
            "default_branch": _optional_string(payload, "default_branch", maximum=255),
            "visibility": visibility,
            "archived": payload.get("archived") is True,
            "updated_at": _parse_datetime(payload.get("updated_at")),
        }

    def _list_branches(self, token, safe_full_name, display_full_name):
        values = []
        for item in self._paginate(
            f"{GITHUB_API_URL}/repos/{safe_full_name}/branches",
            token=token,
            params={"per_page": 100},
        ):
            commit = item.get("commit") if isinstance(item, dict) and isinstance(item.get("commit"), dict) else {}
            name = _required_string(item, "name", maximum=255)
            sha = _required_string(commit, "sha", maximum=64)
            values.append(
                {
                    "object_type": "branch",
                    "provider_object_id": name,
                    "ref": name,
                    "title": name,
                    "canonical_url": f"https://github.com/{display_full_name}/tree/{quote(name, safe='/-._')}",
                    "state": "active",
                    "commit_sha": sha,
                    "metadata": {"protected": item.get("protected") is True},
                    "source_version": sha,
                    "provider_updated_at": None,
                }
            )
        return values

    def _list_commits(self, token, safe_full_name, *, since=None):
        params = {"per_page": 100}
        if since:
            params["since"] = since
        values = []
        for item in self._paginate(f"{GITHUB_API_URL}/repos/{safe_full_name}/commits", token=token, params=params):
            commit = item.get("commit") if isinstance(item, dict) and isinstance(item.get("commit"), dict) else {}
            author_block = commit.get("author") if isinstance(commit.get("author"), dict) else {}
            github_author = item.get("author") if isinstance(item.get("author"), dict) else {}
            sha = _required_string(item, "sha", maximum=64)
            message = _required_string(commit, "message", maximum=10000)
            values.append(
                {
                    "object_type": "commit",
                    "provider_object_id": sha,
                    "ref": sha[:12],
                    "title": message.splitlines()[0][:500],
                    "canonical_url": _required_string(item, "html_url"),
                    "state": "committed",
                    "author_name": _optional_string(github_author, "login", maximum=255)
                    or _optional_string(author_block, "name", maximum=255),
                    "author_avatar_url": _optional_string(github_author, "avatar_url"),
                    "commit_sha": sha,
                    "metadata": {"message": message[:10000]},
                    "source_version": sha,
                    "provider_updated_at": _parse_datetime(author_block.get("date")),
                }
            )
        return values

    @staticmethod
    def _missing_branch_head_commits(branches, commits, display_full_name):
        """Keep reconciliation complete when GitHub lists commits from the default branch only."""
        known_shas = {item.get("provider_object_id") for item in commits}
        branch_refs_by_sha = {}
        for branch in branches:
            sha = branch.get("commit_sha")
            ref = branch.get("ref")
            if isinstance(sha, str) and sha and isinstance(ref, str) and ref:
                branch_refs_by_sha.setdefault(sha, []).append(ref)

        values = []
        for sha, branch_refs in branch_refs_by_sha.items():
            if sha in known_shas:
                continue
            values.append(
                {
                    "object_type": "commit",
                    "provider_object_id": sha,
                    "ref": sha[:12],
                    "title": f"Коммит {sha[:12]}",
                    "canonical_url": f"https://github.com/{display_full_name}/commit/{quote(sha, safe='')}",
                    "state": "committed",
                    "author_name": "",
                    "author_avatar_url": "",
                    "commit_sha": sha,
                    "metadata": {
                        "branch_refs": branch_refs,
                        "reconciliation_fallback": True,
                    },
                    "source_version": sha,
                    "provider_updated_at": None,
                }
            )
        return values

    def _list_pull_requests(self, token, safe_full_name):
        values = []
        params = {"state": "all", "sort": "updated", "direction": "desc", "per_page": 100}
        for item in self._paginate(f"{GITHUB_API_URL}/repos/{safe_full_name}/pulls", token=token, params=params):
            values.append(self.normalize_pull_request(item))
        return values

    def normalize_pull_request(self, payload):
        user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
        base = payload.get("base") if isinstance(payload.get("base"), dict) else {}
        head = payload.get("head") if isinstance(payload.get("head"), dict) else {}
        number = _required_integer(payload, "number")
        updated_at = _parse_datetime(payload.get("updated_at"))
        state = _optional_string(payload, "state", maximum=32)
        if payload.get("merged_at"):
            state = "merged"
        return {
            "object_type": "pull_request",
            "provider_object_id": str(_required_integer(payload, "id")),
            "ref": str(number),
            "title": _required_string(payload, "title", maximum=500),
            "canonical_url": _required_string(payload, "html_url"),
            "state": state,
            "is_draft": payload.get("draft") is True,
            "author_name": _optional_string(user, "login", maximum=255),
            "author_avatar_url": _optional_string(user, "avatar_url"),
            "base_ref": _optional_string(base, "ref", maximum=255),
            "head_ref": _optional_string(head, "ref", maximum=255),
            "commit_sha": _optional_string(head, "sha", maximum=64),
            "metadata": {},
            "source_version": _optional_string(payload, "node_id", maximum=255)
            or f"pr:{number}:{updated_at.isoformat() if updated_at else state}",
            "provider_updated_at": updated_at,
            "provider_merged_at": _parse_datetime(payload.get("merged_at")),
        }

    def _app_jwt(self):
        now = int(self.clock())
        try:
            return jwt.encode(
                {"iat": now - 60, "exp": now + 540, "iss": settings.PPM_GITHUB_APP_ID},
                settings.PPM_GITHUB_APP_PRIVATE_KEY,
                algorithm="RS256",
            )
        except (ValueError, TypeError, jwt.PyJWTError) as exc:
            raise PpmGitProviderError(
                "GITHUB_APP_KEY_INVALID",
                "Серверный ключ GitHub App настроен неверно.",
            ) from exc

    def _paginate(self, url, *, token, params=None):
        page_url = url
        page_params = params
        pages = 0
        while page_url:
            payload, response = self._request_with_response(
                "GET",
                page_url,
                token=token,
                params=page_params,
            )
            if not isinstance(payload, list):
                raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул неожиданный список данных.")
            for item in payload:
                if isinstance(item, dict):
                    yield item
            page_url = self._next_url(response)
            page_params = None
            pages += 1
            if pages >= 20:
                raise PpmGitProviderError("GITHUB_PAGE_LIMIT", "GitHub вернул слишком большой набор данных.")

    def _request(
        self,
        method,
        url,
        *,
        token=None,
        headers=None,
        params=None,
        data=None,
        json=None,
        include_api_headers=True,
        conflict_code=None,
        conflict_message=None,
    ):
        payload, _ = self._request_with_response(
            method,
            url,
            token=token,
            headers=headers,
            params=params,
            data=data,
            json=json,
            include_api_headers=include_api_headers,
            conflict_code=conflict_code,
            conflict_message=conflict_message,
        )
        return payload

    def _request_with_response(
        self,
        method,
        url,
        *,
        token=None,
        headers=None,
        params=None,
        data=None,
        json=None,
        include_api_headers=True,
        conflict_code=None,
        conflict_message=None,
    ):
        request_headers = dict(headers or {})
        if include_api_headers:
            request_headers.setdefault("Accept", GITHUB_ACCEPT)
            request_headers.setdefault("X-GitHub-Api-Version", settings.PPM_GITHUB_API_VERSION)
        if token:
            request_headers["Authorization"] = f"Bearer {token}"
        try:
            response = self.session.request(
                method,
                url,
                headers=request_headers,
                params=params,
                data=data,
                json=json,
                timeout=REQUEST_TIMEOUT,
            )
        except (requests.Timeout, requests.ConnectionError) as exc:
            raise PpmGitProviderError("GITHUB_UNAVAILABLE", "GitHub временно недоступен.") from exc
        except requests.RequestException as exc:
            raise PpmGitProviderError("GITHUB_REQUEST_FAILED", "Не удалось выполнить запрос к GitHub.") from exc

        status_code = response.status_code
        if _is_rate_limited(response):
            retry_after = self._retry_after_seconds(response)
            raise PpmGitProviderRateLimited(
                "GITHUB_RATE_LIMITED",
                "GitHub временно ограничил частоту запросов.",
                retry_after_seconds=retry_after,
                http_status=status_code,
            )
        if status_code == 401:
            raise PpmGitProviderError(
                "GITHUB_AUTH_FAILED", "GitHub отклонил авторизацию приложения.", http_status=status_code
            )
        if status_code == 403:
            raise PpmGitProviderError(
                "GITHUB_PERMISSION_DENIED", "GitHub не предоставил необходимые права.", http_status=status_code
            )
        if status_code == 404:
            raise PpmGitProviderError(
                "GITHUB_NOT_FOUND", "Объект GitHub не найден или больше недоступен.", http_status=status_code
            )
        if status_code in {409, 422} and conflict_code:
            if callable(conflict_code):
                code, message = conflict_code(_error_message(response))
                raise PpmGitProviderError(code, message, http_status=status_code)
            raise PpmGitProviderError(
                conflict_code,
                conflict_message or "GitHub отклонил действие из-за конфликта.",
                http_status=status_code,
            )
        if status_code >= 400:
            raise PpmGitProviderError("GITHUB_REQUEST_FAILED", "GitHub не выполнил запрос.", http_status=status_code)
        if status_code == 204:
            return {}, response
        try:
            payload = response.json()
        except ValueError as exc:
            raise PpmGitProviderError(
                "GITHUB_INVALID_RESPONSE", "GitHub вернул некорректный ответ.", http_status=status_code
            ) from exc
        return payload, response

    def _retry_after_seconds(self, response):
        retry_after = response.headers.get("Retry-After")
        if retry_after and retry_after.isdigit():
            return max(1, min(int(retry_after), 86400))
        reset = response.headers.get("X-RateLimit-Reset")
        if reset and reset.isdigit():
            return max(1, min(int(reset) - int(self.clock()), 86400))
        return 60

    @staticmethod
    def _next_url(response):
        links = getattr(response, "links", {})
        next_link = links.get("next") if isinstance(links, dict) else None
        url = next_link.get("url") if isinstance(next_link, dict) else None
        return url if isinstance(url, str) and url.startswith(f"{GITHUB_API_URL}/") else None
