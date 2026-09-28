"""Webhook receipt and normalization — provider-specific (G2.1 R1e).

A provider's normalizer turns its raw event into ``providers.base.NormalizedDelivery``; applying it
(``provider_services.process_delivery``) is provider-neutral. GitHub: ``verify_github_signature`` +
``parse_github_webhook``; Forgejo (G2.1 A2): ``verify_forgejo_signature`` + ``parse_forgejo_webhook``.
"""

import hashlib
import hmac
import json
import re
from urllib.parse import quote

from django.conf import settings

from .providers.base import PpmGitProviderError
from .providers.forgejo import FORGEJO_INSTALLATION_ID, forgejo_branch_url, normalize_forgejo_pull_request
from .providers.github import GitHubAppClient


SUPPORTED_EVENTS = {"ping", "installation", "installation_repositories", "push", "pull_request"}
# The events of the system webhook `ppm-deploy.sh git-bootstrap` creates (pull_request_sync arrives as pull_request).
FORGEJO_SUPPORTED_EVENTS = {"push", "pull_request", "create", "delete", "repository"}
FORGEJO_SIGNATURE = re.compile(r"^[0-9a-f]{64}$")
FORGEJO_SHA = re.compile(r"^[0-9a-f]{40,64}$")
# Forgejo puts at most [webhook] PAYLOAD_COMMIT_LIMIT (15) commits of a push into a delivery, and for a new branch only
# its last 10 — with `total_commits` 10 (checked on the live Forgejo 15.0.9): such a push is completed by a
# synchronization (`catch_up`).
FORGEJO_NEW_BRANCH_COMMITS = 10
FORGEJO_REPOSITORY_DELETED = {
    "code": "GIT_REPOSITORY_DELETED",
    "message": "Репозиторий удалён на Git-сервере. История и связи в PPM сохранены; чтобы продолжить, подключите "
    "репозиторий заново.",
    # The code of a repository that no longer exists is not searchable any more.
    "purge_code": True,
    # The scheduled reconciliation would only keep hitting 404: it waits for «Обновить» or a new connection.
    "halt_sync": True,
}
# Moments a normalized Git object may carry (providers.base.Moment).
GIT_OBJECT_MOMENT_KEYS = ("provider_updated_at", "provider_merged_at")


def json_safe_git_object(git_object):
    """A normalized Git object ready for ``PpmGitDelivery.payload`` (JSON): moments become ISO 8601 strings, which
    ``upsert_git_object`` parses back. Shared by every provider's webhook normalizer."""
    safe = dict(git_object)
    for key in GIT_OBJECT_MOMENT_KEYS:
        moment = safe.get(key)
        if hasattr(moment, "isoformat"):
            safe[key] = moment.isoformat()
    return safe


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
        # Доставка хранится в JSON: даты — строками ISO 8601 (upsert_git_object разбирает их обратно).
        normalized["pull_request"] = json_safe_git_object(GitHubAppClient().normalize_pull_request(pull_request))
    return normalized


def body_sha256(raw_body):
    return hashlib.sha256(raw_body).hexdigest()


# --- Forgejo (G2.1 A2) ------------------------------------------------------------------------------------------------


def verify_forgejo_signature(raw_body, signature):
    """``X-Forgejo-Signature``: lower-case hex HMAC-SHA256 of the raw body with ``PPM_FORGEJO_WEBHOOK_SECRET``."""
    secret = settings.PPM_FORGEJO_WEBHOOK_SECRET
    if not secret or not isinstance(signature, str) or not FORGEJO_SIGNATURE.fullmatch(signature):
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def parse_forgejo_webhook(raw_body, *, event_name):
    """A Forgejo system-webhook delivery as ``NormalizedDelivery`` — the same events GitHub's normalizer produces.

    ``push`` → ref update (tags and other refs: ignored; a cut push also asks for ``catch_up``); ``pull_request`` →
    the PR (``synchronized`` included); ``create``/``delete`` of a branch → ref update without commits; ``repository``
    ``deleted`` → the halting ``connection_error``. Everything else is accepted and ignored. Only fixed fields are
    copied: never the raw body, e-mails, the sender or the repository object.
    """
    if event_name not in FORGEJO_SUPPORTED_EVENTS:
        return {"event": event_name, "installation_id": FORGEJO_INSTALLATION_ID, "ignored": True}
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PpmGitProviderError("FORGEJO_WEBHOOK_INVALID", "Git-сервер прислал некорректное событие.") from exc
    if not isinstance(payload, dict):
        raise PpmGitProviderError("FORGEJO_WEBHOOK_INVALID", "Git-сервер прислал некорректное событие.")

    repository = payload.get("repository") if isinstance(payload.get("repository"), dict) else {}
    normalized = {
        "event": event_name,
        "action": _short_text(payload.get("action"), maximum=64),
        "installation_id": FORGEJO_INSTALLATION_ID,
        "repository_id": _integer(repository.get("id")),
    }
    if event_name == "push":
        normalized.update(_normalize_forgejo_push(payload, repository))
    elif event_name == "pull_request":
        pull_request = payload.get("pull_request")
        if not isinstance(pull_request, dict):
            raise PpmGitProviderError("FORGEJO_WEBHOOK_INVALID", "В событии Git-сервера нет запроса на слияние.")
        try:
            normalized["pull_request"] = json_safe_git_object(normalize_forgejo_pull_request(pull_request))
        except PpmGitProviderError as exc:
            # A signed delivery with a broken pull request is a bad request (400), not a failing Git server (502).
            raise PpmGitProviderError(
                "FORGEJO_WEBHOOK_INVALID", "В событии Git-сервера некорректный запрос на слияние."
            ) from exc
    elif event_name in {"create", "delete"}:
        normalized.update(_normalize_forgejo_ref_event(payload, repository, deleted=event_name == "delete"))
    elif normalized["action"] == "deleted":
        normalized["connection_error"] = dict(FORGEJO_REPOSITORY_DELETED)
    else:
        normalized["ignored"] = True
    return normalized


def _forgejo_branch_name(ref):
    """``create``/``delete`` of Forgejo 15 carry the full ``refs/heads/<branch>`` (older Gitea: the short name)."""
    branch = ref.removeprefix("refs/heads/")
    if not branch or branch.startswith("refs/"):
        raise PpmGitProviderError("FORGEJO_WEBHOOK_INVALID", "В событии Git-сервера нет ветки.")
    return branch


def _forgejo_branch(repository, branch, *, sha, deleted, updated_at=""):
    repository_url = _short_text(repository.get("html_url"), maximum=2048)
    return {
        "object_type": "branch",
        "provider_object_id": branch,
        "ref": branch,
        "title": branch,
        "canonical_url": forgejo_branch_url(repository_url, branch) if repository_url else "",
        "state": "deleted" if deleted else "active",
        "commit_sha": sha,
        "metadata": {},
        # ≤ 64 characters (a Canvas card keeps it): the head SHA; a deleted branch — 40 zeros, as GitHub's `after`.
        "source_version": sha or ("0" * 40 if deleted else branch[:64]),
        "provider_updated_at": updated_at,
    }


def _normalize_forgejo_push(payload, repository):
    ref = _short_text(payload.get("ref"), maximum=512)
    if not ref.startswith("refs/heads/"):
        # A tag (or another ref): nothing PPM keeps.
        return {"ignored": True}
    branch = _forgejo_branch_name(ref)
    after = _short_text(payload.get("after"), maximum=64)
    deleted = bool(after) and set(after) == {"0"}
    head = payload.get("head_commit") if isinstance(payload.get("head_commit"), dict) else {}
    raw_commits = payload.get("commits") if isinstance(payload.get("commits"), list) else []
    commits = []
    for commit in raw_commits[:100]:
        if not isinstance(commit, dict):
            continue
        sha = _short_text(commit.get("id"), maximum=64)
        url = _short_text(commit.get("url"), maximum=2048)
        if not FORGEJO_SHA.fullmatch(sha) or not url:
            continue
        author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
        message = _short_text(commit.get("message"), maximum=10000)
        first_line = next((line for line in message.splitlines() if line.strip()), "")
        commits.append(
            {
                "object_type": "commit",
                "provider_object_id": sha,
                "ref": sha[:12],
                "title": _one_line(first_line, maximum=500) or f"Коммит {sha[:12]}",
                "canonical_url": url,
                "state": "committed",
                # The Forgejo login, else the git author name; never the e-mail.
                "author_name": _short_text(author.get("username"), maximum=255)
                or _short_text(author.get("name"), maximum=255),
                "author_avatar_url": "",
                "commit_sha": sha,
                "metadata": {"message": message},
                "source_version": sha,
                "provider_updated_at": _short_text(commit.get("timestamp"), maximum=64),
            }
        )
    normalized = {
        "ref": ref,
        "deleted": deleted,
        "branch": _forgejo_branch(
            repository,
            branch,
            sha=after if FORGEJO_SHA.fullmatch(after) else "",
            deleted=deleted,
            updated_at=_short_text(head.get("timestamp"), maximum=64),
        ),
        "commits": commits,
    }
    catch_up = _forgejo_catch_up(payload, repository, ref=ref, after=after, deleted=deleted, delivered=len(commits))
    if catch_up is not None:
        normalized["catch_up"] = catch_up
    return normalized


def _forgejo_catch_up(payload, repository, *, ref, after, deleted, delivered):
    before = _short_text(payload.get("before"), maximum=64)
    new_branch = not before or set(before) == {"0"}
    total = _integer(payload.get("total_commits"))
    cut = (total is not None and total > delivered) or (new_branch and delivered >= FORGEJO_NEW_BRANCH_COMMITS)
    if deleted or not cut or not FORGEJO_SHA.fullmatch(after):
        return None
    return {
        "ref": ref,
        "before": "" if new_branch or not FORGEJO_SHA.fullmatch(before) else before,
        "after": after,
        "base": _short_text(repository.get("default_branch"), maximum=255),
    }


def _normalize_forgejo_ref_event(payload, repository, *, deleted):
    if payload.get("ref_type") != "branch":
        # A tag: nothing PPM keeps.
        return {"ignored": True}
    branch = _forgejo_branch_name(_short_text(payload.get("ref"), maximum=512))
    sha = "" if deleted else _short_text(payload.get("sha"), maximum=64)
    return {
        "ref": f"refs/heads/{branch}",
        "deleted": deleted,
        "branch": _forgejo_branch(repository, branch, sha=sha if FORGEJO_SHA.fullmatch(sha) else "", deleted=deleted),
        "commits": [],
    }


def _one_line(value, *, maximum):
    return re.sub(r"[\x00-\x1f\x7f]", "", " ".join(value.split()))[:maximum].strip()


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
