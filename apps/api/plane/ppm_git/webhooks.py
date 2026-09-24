import hashlib
import hmac
import json
from urllib.parse import quote

from django.conf import settings

from .providers.base import PpmGitProviderError
from .providers.github import GitHubAppClient


SUPPORTED_EVENTS = {"ping", "installation", "installation_repositories", "push", "pull_request"}


def verify_github_signature(raw_body, signature):
    if not isinstance(signature, str) or not signature.startswith("sha256="):
        return False
    expected = (
        "sha256="
        + hmac.new(
            settings.PPM_GITHUB_WEBHOOK_SECRET.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).hexdigest()
    )
    return hmac.compare_digest(expected, signature)


def parse_github_webhook(raw_body, *, event_name):
    if event_name not in SUPPORTED_EVENTS:
        return {"ignored": True, "event": event_name}
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PpmGitProviderError("GITHUB_WEBHOOK_INVALID", "GitHub прислал некорректное событие.") from exc
    if not isinstance(payload, dict):
        raise PpmGitProviderError("GITHUB_WEBHOOK_INVALID", "GitHub прислал некорректное событие.")

    installation = payload.get("installation") if isinstance(payload.get("installation"), dict) else {}
    repository = payload.get("repository") if isinstance(payload.get("repository"), dict) else {}
    normalized = {
        "event": event_name,
        "action": _short_text(payload.get("action"), maximum=64),
        "installation_id": _integer(installation.get("id")),
        "repository_id": _integer(repository.get("id")),
    }
    if event_name == "ping":
        normalized["zen"] = _short_text(payload.get("zen"), maximum=255)
    elif event_name == "installation":
        normalized["installation"] = _normalize_installation(installation)
        repositories = payload.get("repositories")
        normalized["repository_ids"] = _repository_ids(repositories)
    elif event_name == "installation_repositories":
        normalized["repositories_added"] = _repository_ids(payload.get("repositories_added"))
        normalized["repositories_removed"] = _repository_ids(payload.get("repositories_removed"))
    elif event_name == "push":
        normalized.update(_normalize_push(payload, repository))
    elif event_name == "pull_request":
        pull_request = payload.get("pull_request")
        if not isinstance(pull_request, dict):
            raise PpmGitProviderError("GITHUB_WEBHOOK_INVALID", "В событии GitHub отсутствует pull request.")
        normalized_pull_request = GitHubAppClient().normalize_pull_request(pull_request)
        provider_updated_at = normalized_pull_request.get("provider_updated_at")
        if hasattr(provider_updated_at, "isoformat"):
            normalized_pull_request["provider_updated_at"] = provider_updated_at.isoformat()
        normalized["pull_request"] = normalized_pull_request
    return normalized


def body_sha256(raw_body):
    return hashlib.sha256(raw_body).hexdigest()


def _normalize_installation(payload):
    account = payload.get("account") if isinstance(payload.get("account"), dict) else {}
    permissions = payload.get("permissions") if isinstance(payload.get("permissions"), dict) else {}
    events = payload.get("events") if isinstance(payload.get("events"), list) else []
    return {
        "provider_installation_id": _integer(payload.get("id")),
        "provider_account_id": _integer(account.get("id")),
        "account_login": _short_text(account.get("login"), maximum=255),
        "account_type": _short_text(account.get("type"), maximum=32),
        "repository_selection": _short_text(payload.get("repository_selection"), maximum=16) or "selected",
        "permissions": {
            str(key): str(value)
            for key, value in permissions.items()
            if isinstance(key, str) and isinstance(value, str)
        },
        "events": [str(value) for value in events if isinstance(value, str)][:64],
    }


def _normalize_push(payload, repository):
    ref = _short_text(payload.get("ref"), maximum=512)
    if not ref:
        raise PpmGitProviderError("GITHUB_WEBHOOK_INVALID", "В push-событии GitHub отсутствует ветка.")
    branch_name = ref.removeprefix("refs/heads/")
    full_name = _short_text(repository.get("full_name"), maximum=255)
    head_commit = payload.get("head_commit") if isinstance(payload.get("head_commit"), dict) else {}
    commits = payload.get("commits") if isinstance(payload.get("commits"), list) else []
    normalized_commits = []
    for commit in commits[:100]:
        if not isinstance(commit, dict):
            continue
        author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
        sha = _short_text(commit.get("id"), maximum=64)
        message = _short_text(commit.get("message"), maximum=10000)
        url = _short_text(commit.get("url"), maximum=2048)
        if not sha or not message or not url:
            continue
        normalized_commits.append(
            {
                "object_type": "commit",
                "provider_object_id": sha,
                "ref": sha[:12],
                "title": message.splitlines()[0][:500],
                "canonical_url": url,
                "state": "committed",
                "author_name": _short_text(author.get("username"), maximum=255)
                or _short_text(author.get("name"), maximum=255),
                "author_avatar_url": "",
                "commit_sha": sha,
                "metadata": {"message": message},
                "source_version": sha,
                "provider_updated_at": _short_text(commit.get("timestamp"), maximum=64),
            }
        )
    after = _short_text(payload.get("after"), maximum=64)
    return {
        "ref": ref,
        "deleted": payload.get("deleted") is True,
        "branch": {
            "object_type": "branch",
            "provider_object_id": branch_name,
            "ref": branch_name,
            "title": branch_name,
            "canonical_url": (
                f"https://github.com/{full_name}/tree/{quote(branch_name, safe='/-._')}" if full_name else ""
            ),
            "state": "deleted" if payload.get("deleted") is True else "active",
            "commit_sha": after,
            "metadata": {},
            "source_version": after or _short_text(head_commit.get("id"), maximum=64) or branch_name,
            "provider_updated_at": _short_text(head_commit.get("timestamp"), maximum=64),
        },
        "commits": normalized_commits,
    }


def _repository_ids(value):
    if not isinstance(value, list):
        return []
    repository_ids = []
    for item in value:
        if not isinstance(item, dict):
            continue
        repository_id = _integer(item.get("id"))
        if repository_id is not None:
            repository_ids.append(repository_id)
    return repository_ids


def _integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _short_text(value, *, maximum):
    return value[:maximum] if isinstance(value, str) else ""
