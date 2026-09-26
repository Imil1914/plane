import base64
import binascii
import hashlib
import time
from datetime import datetime
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

    def create_branch(self, installation_id, repository_id, full_name, *, base_ref, head_ref):
        token = self.create_installation_token(
            installation_id,
            repository_ids=[int(repository_id)],
            permissions=BRANCH_WRITE_PERMISSIONS,
        )
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        base = self._get_git_ref(token, safe_full_name, base_ref)
        existing = self._get_git_ref(token, safe_full_name, head_ref, required=False)
        base_sha = base["sha"]
        if existing is not None:
            if existing["sha"] != base_sha:
                raise PpmGitProviderError(
                    "GITHUB_BRANCH_CONFLICT",
                    "Ветка с таким именем уже существует и указывает на другой commit.",
                )
            return self._branch_result(full_name, head_ref, existing["sha"], created=False)

        payload = self._request(
            "POST",
            f"{GITHUB_API_URL}/repos/{safe_full_name}/git/refs",
            token=token,
            json={"ref": f"refs/heads/{head_ref}", "sha": base_sha},
            conflict_code="GITHUB_BRANCH_CONFLICT",
            conflict_message="GitHub не создал ветку: имя уже занято или исходная ветка изменилась.",
        )
        created = self._normalize_git_ref(payload)
        if created["ref"] != f"refs/heads/{head_ref}" or created["sha"] != base_sha:
            raise PpmGitProviderError(
                "GITHUB_INVALID_RESPONSE",
                "GitHub вернул неожиданную созданную ветку.",
            )
        return self._branch_result(full_name, head_ref, base_sha, created=True)

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
    ):
        token = self.create_installation_token(
            installation_id,
            repository_ids=[int(repository_id)],
            permissions=DRAFT_PULL_REQUEST_WRITE_PERMISSIONS,
        )
        safe_full_name = "/".join(quote(part, safe="-._") for part in full_name.split("/"))
        base = self._get_git_ref(token, safe_full_name, base_ref)
        head = self._get_git_ref(token, safe_full_name, head_ref)
        if base["sha"] == head["sha"]:
            raise PpmGitProviderError(
                "GITHUB_PULL_REQUEST_EMPTY",
                "Сначала добавьте и отправьте хотя бы один commit в новую ветку.",
            )

        owner = full_name.split("/", 1)[0]
        existing = self._request(
            "GET",
            f"{GITHUB_API_URL}/repos/{safe_full_name}/pulls",
            token=token,
            params={"state": "all", "head": f"{owner}:{head_ref}", "base": base_ref, "per_page": 100},
        )
        if not isinstance(existing, list):
            raise PpmGitProviderError(
                "GITHUB_INVALID_RESPONSE",
                "GitHub вернул некорректный список pull requests.",
            )
        matching = [item for item in existing if isinstance(item, dict)]
        if matching:
            if len(matching) != 1:
                raise PpmGitProviderError(
                    "GITHUB_PULL_REQUEST_CONFLICT",
                    "Для выбранных веток найдено несколько pull requests.",
                )
            pull_request = matching[0]
            if pull_request.get("title") != title or (pull_request.get("body") or "") != body:
                raise PpmGitProviderError(
                    "GITHUB_PULL_REQUEST_CONFLICT",
                    "Pull request для этих веток уже существует с другим названием или описанием.",
                )
            return {**self.normalize_pull_request(pull_request), "created": False}

        payload = self._request(
            "POST",
            f"{GITHUB_API_URL}/repos/{safe_full_name}/pulls",
            token=token,
            json={"title": title, "body": body, "head": head_ref, "base": base_ref, "draft": True},
            conflict_code="GITHUB_PULL_REQUEST_CONFLICT",
            conflict_message="GitHub не создал draft PR: проверьте ветки и существующие pull requests.",
        )
        return {**self.normalize_pull_request(payload), "created": True}

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
        sha = _required_string(git_object, "sha", maximum=64)
        return {"ref": reference, "sha": sha}

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
        payload = self._request(
            "POST",
            f"{GITHUB_API_URL}/app/installations/{int(installation_id)}/access_tokens",
            token=self._app_jwt(),
            json=body,
        )
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

        if response.status_code in {403, 429} and (
            response.status_code == 429 or response.headers.get("X-RateLimit-Remaining") == "0"
        ):
            retry_after = self._retry_after_seconds(response)
            raise PpmGitProviderRateLimited(
                "GITHUB_RATE_LIMITED",
                "GitHub временно ограничил частоту синхронизации.",
                retry_after_seconds=retry_after,
            )
        if response.status_code == 401:
            raise PpmGitProviderError("GITHUB_AUTH_FAILED", "GitHub отклонил авторизацию приложения.")
        if response.status_code == 403:
            raise PpmGitProviderError("GITHUB_PERMISSION_DENIED", "GitHub не предоставил необходимые права.")
        if response.status_code == 404:
            raise PpmGitProviderError("GITHUB_NOT_FOUND", "Объект GitHub не найден или больше недоступен.")
        if response.status_code in {409, 422} and conflict_code:
            raise PpmGitProviderError(
                conflict_code,
                conflict_message or "GitHub отклонил действие из-за конфликта.",
            )
        if response.status_code >= 400:
            raise PpmGitProviderError("GITHUB_REQUEST_FAILED", "GitHub не выполнил запрос.")
        if response.status_code == 204:
            return {}, response
        try:
            payload = response.json()
        except ValueError as exc:
            raise PpmGitProviderError("GITHUB_INVALID_RESPONSE", "GitHub вернул некорректный ответ.") from exc
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
