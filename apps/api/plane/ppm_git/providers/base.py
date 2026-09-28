"""Git provider contract of ``ppm_git`` (G2.1 R1).

The provider-neutral paths — reconciliation (``provider_services.synchronize_connection``), code indexing
(``code_indexing.synchronize_repository_code``) and delivery application (``provider_services.process_delivery``) —
reach a Git provider only through ``GitProviderClient`` (built by ``providers.registry``) and consume only the
normalized shapes below. Everything else — GitHub App installation, OAuth, choosing installation repositories, G1.3
writes, the webhook status command — is provider-specific and stays on the concrete client.

The shapes document what ``GitHubAppClient`` and the GitHub webhook normalizer return today (G1.1/G1.2/AF2.2); they
are the contract a second provider must meet, not a new format. ``tests/contract/ppm_git/test_provider_registry.py``
keeps them equal to the GitHub output.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, NotRequired, Protocol, TypedDict, runtime_checkable


@dataclass
class PpmGitProviderError(Exception):
    code: str
    message: str
    retry_after_seconds: int | None = None
    # Safe, user-facing context (for example the canonical URL of an existing pull request). Never secrets.
    details: dict | None = None
    # HTTP status of the failed GitHub answer; None for transport failures (timeout, connection reset).
    http_status: int | None = None
    # G1.3 write steps — what GitHub may hold for the action: "not_performed" (proven: checked or definitely
    # refused), "exists" (this action's object was found), "unknown" (cannot be proven either way); None — this
    # attempt learned nothing about earlier ones.
    write_outcome: str | None = None
    # True when this attempt's own write request was sent and no definite answer came back (timeout, 5xx, broken
    # body): its own write is then «неизвестно», not «не было».
    write_request_unanswered: bool = False


class PpmGitProviderRateLimited(PpmGitProviderError):
    pass


# A provider error with one of these codes says that the repository at the connected id is no longer the connected one
# (G2.1 A2 fix round 1: renamed or moved — its old name may already belong to another repository). Synchronization and
# code indexing then drop the code index of the connection: its file links would lead elsewhere, and search and AI
# answers must not keep code PPM can no longer vouch for. GitHub never raises them.
REPOSITORY_MOVED_CODES = frozenset({"GIT_REPOSITORY_MOVED"})


# --- Normalized Git objects (``upsert_git_object`` input) -------------------------------------------------------------
# A client returns moments as aware ``datetime`` (or ``None``); a webhook normalizer stores them in
# ``PpmGitDelivery.payload`` (JSON) as ISO 8601 strings — ``webhooks.json_safe_git_object``. ``upsert_git_object``
# accepts both; an empty string means «unknown».
#
# What ``upsert_git_object`` checks (``provider_services.py``). ``provider_object_id`` (≤ 255), ``title`` (≤ 500) and
# ``source_version`` (≤ 255) pass ``services.normalize_name``: the value must be a ``str``; it is stripped and every
# inner whitespace run (spaces, tabs, line breaks) becomes one space — the collapsed value is stored and the limit
# applies to it; empty, longer or still containing a control character (U+0000–U+001F, U+007F) → ``PpmGitError``
# ``GIT_INVALID_FIELD``. ``canonical_url`` → ``GIT_INVALID_URL`` / ``GIT_UNSAFE_URL`` / ``GIT_URL_SCOPE_MISMATCH``, an
# unknown ``object_type`` → ``GITHUB_OBJECT_INVALID`` / ``GIT_OBJECT_INVALID``. The other fields never fail: text is
# cut to its column (``ref``, ``author_name``, ``base_ref``, ``head_ref`` 255; ``state`` 32; ``commit_sha`` 64; NUL
# removed), a non-https or longer than 2048 ``author_avatar_url`` becomes "", a non-dict ``metadata`` becomes {}, an
# unparsable moment becomes None. One refused object fails the whole unit: a delivery turns ``failed`` (the scheduled
# job retries the same payload with a growing pause, up to 60 min); a reconciliation rolls back everything it was
# writing and raises ``PpmGitError`` — not a provider error, so the Celery task does not retry and the connection stays
# «syncing» until «Обновить» (behaviour of G1.1). A normalizer must never emit such values.
Moment = datetime | str | None


class GitBranchObject(TypedDict):
    object_type: Literal["branch"]
    provider_object_id: str  # branch name — unique per repository
    ref: str  # branch name (auto-link to «KEY-12» reads it)
    title: str  # branch name
    # Every object URL is HTTPS and lies under the repository's canonical URL (``normalize_git_object_url``),
    # otherwise the object is refused with GIT_URL_SCOPE_MISMATCH.
    canonical_url: str
    state: str  # "active" | "deleted" ("deleted" stores the object inactive; reconciliation lists live branches only)
    # Head commit SHA. Webhook: the provider's `after` exactly as sent — GitHub sends 40 zeros ("0" * 40) for a
    # deleted branch, so `state`, not this field, tells a deletion; "" only when the provider omitted `after`.
    commit_sha: str
    metadata: dict  # reconciliation: {"protected": bool}; webhook: {}
    # Reconciliation: head SHA. Webhook: `after` (40 zeros for a deleted branch), else the head commit id, else the
    # branch name. Keep it ≤ 64 characters: a Canvas card stores it (`PpmCanvasBinding.source_version`, 64).
    source_version: str
    provider_updated_at: Moment  # reconciliation: None; webhook: head commit time, "" without a head commit (deleted)


class GitCommitObject(TypedDict):
    object_type: Literal["commit"]
    provider_object_id: str  # full SHA
    ref: str  # SHA[:12]
    title: str  # first line of the message, ≤ 500 characters
    canonical_url: str
    state: Literal["committed"]
    author_name: str  # provider login, else the git author name; "" when unknown. Never an e-mail.
    author_avatar_url: str  # HTTPS URL or ""
    commit_sha: str  # full SHA
    # {"message": full message ≤ 10 000 characters} — auto-link reads it; reconciliation fallback for a branch head the
    # commit listing missed: {"branch_refs": [branch, …], "reconciliation_fallback": True}.
    metadata: dict
    source_version: str  # SHA
    provider_updated_at: Moment  # author date


class GitPullRequestObject(TypedDict):
    object_type: Literal["pull_request"]
    provider_object_id: str  # str(provider's numeric PR id) — stable, not the number
    ref: str  # str(number)
    title: str  # ≤ 500 characters
    canonical_url: str
    state: str  # "open" | "closed" | "merged" (merged wins whenever the provider reports a merge time)
    is_draft: bool
    author_name: str
    author_avatar_url: str
    base_ref: str
    head_ref: str  # auto-link reads it
    commit_sha: str  # head SHA; "" when unknown
    metadata: dict  # {}
    # GitHub: the PR's `node_id` — a global id that stays the same for the PR's whole life, so it does NOT change when
    # the PR is updated, closed or merged; only without `node_id`: "pr:<number>:<updated_at ISO | state>", which does.
    # Forgejo has no such id: always "pr:<number>:<updated_at ISO | state>" (≤ 55 characters).
    # PPM always overwrites the stored object regardless of it; a Canvas card shows it as the source version
    # (`ppm_canvas.services.git_source_version`) and stores at most 64 characters of it (`PpmCanvasBinding`).
    source_version: str
    provider_updated_at: Moment
    # AF2.2 S2a: the real merge time (None while not merged). Always present in a PR object: payloads without this key
    # (deliveries stored before AF2.2) never erase a known value.
    provider_merged_at: Moment


GitObject = GitBranchObject | GitCommitObject | GitPullRequestObject


class SyncRepositoryResult(TypedDict):
    """``sync_repository``: the whole current picture of one repository (all pages, bounded by the client)."""

    branches: list[GitBranchObject]  # every branch; branches missing here are marked deleted
    commits: list[GitCommitObject]  # commits since the cursor plus every branch head
    pull_requests: list[GitPullRequestObject]  # open, closed and merged


# --- Code index ------------------------------------------------------------------------------------------------------


class CodeTreeFile(TypedDict):
    path: str  # repository-relative POSIX path
    sha: str  # blob id; the key of the ``get_code_blobs`` answer
    size: int | None  # bytes; None when unknown (the file is then skipped)


class CodeTree(TypedDict):
    """``get_code_tree``: every file (blob) of the tree at the exact commit ``ref`` points to — not truncated."""

    commit_sha: str  # the snapshot is pinned to this commit
    files: list[CodeTreeFile]  # blobs only: no directories, no submodules


CodeBlobs = dict[str, bytes]  # blob sha → raw content (``get_code_blobs``)
# Link to one file at one commit: (repository canonical URL, commit SHA, path) → URL. Registered per provider.
CodeFileUrl = Callable[[str, str, str], str]


# --- Repository as a provider lists it for connecting -----------------------------------------------------------------


class ProviderRepository(TypedDict):
    """``GitHubAppClient.normalize_repository``; a second provider's connect flow returns the same shape."""

    provider_repository_id: int
    name: str
    full_name: str  # "owner/name"
    owner: str
    canonical_url: str  # HTTPS page of the repository (``html_url``) — the public address users open
    clone_https: str
    clone_ssh: str  # "" when the provider has no SSH address
    default_branch: str
    visibility: str  # "public" | "private" | "internal"
    archived: bool
    updated_at: datetime | None


# --- Normalized delivery (``PpmGitDelivery.payload``) -----------------------------------------------------------------


class ConnectionErrorDirective(TypedDict):
    """The provider reports that the repository can no longer be synchronized (for example it was deleted).

    The connections of that provider and repository turn «error» with ``code`` and ``message``; Git objects and links
    stay. Without ``halt_sync`` the state is temporary: the next successful synchronization — the scheduled one runs
    every 15 minutes — returns the connection to «active». With ``halt_sync: True`` synchronization stops: the marker
    ``sync_cursor["halted"] = {"code", "at"}`` is written, scheduled reconciliation, Celery retries and deliveries skip
    the connection without calling the provider, and only «Обновить» (POST on the connection) lifts the marker and
    synchronizes normally. An invalid directive (bad code, empty text) is ignored — the delivery changes nothing.
    """

    code: str  # machine code, upper case: [A-Z][A-Z0-9_]{0,63}, e.g. "GIT_REPOSITORY_DELETED"
    message: str  # safe Russian text for «Код», ≤ 500 characters; never provider payload text
    purge_code: NotRequired[bool]  # also drop the code index of the repository (default False)
    halt_sync: NotRequired[bool]  # stop synchronization until «Обновить» (default False: the state is temporary)


class CatchUpRange(TypedDict):
    """A push the provider delivered only in part (G2.1 A2: Forgejo sends at most 15 commits of a push, and only the
    last 10 of a new branch): the commits reachable from ``after`` and not from ``before`` still have to be read.

    The applier keeps the range in ``sync_cursor["catch_up"]`` (at most 20, the newest win) and queues a
    synchronization of the connection; ``synchronize_connection`` then passes the pending ranges to
    ``sync_repository(..., catch_up=[…])`` and drops them once the synchronization succeeded. Only a provider whose
    normalizer emits ``catch_up`` receives the argument (GitHub never does).
    """

    ref: str  # "refs/heads/<branch>"
    before: str  # the previous head SHA; "" for a new branch
    after: str  # the new head SHA (40–64 lower-case hex characters)
    base: str  # the repository's default branch: a new branch is read up to it


class NormalizedDelivery(TypedDict, total=False):
    """What a provider webhook normalizer stores in ``PpmGitDelivery.payload`` (JSON only).

    The delivery row itself carries ``provider``, ``event_name``, ``provider_installation_id`` (``installation_id``)
    and ``provider_repository_id`` (``repository_id``). The neutral applier matches active connections by exactly
    (provider, repository id[, installation id]) and applies the content it finds, in this order:
    ``ignored`` → nothing; ``connection_error`` → the connection turns «error», history stays (``halt_sync`` also stops
    its synchronization until «Обновить»); ``branch``/``commits`` → a ref update (push, branch created or deleted; the
    code index follows the indexed branch; with ``catch_up`` the rest of a truncated push is read by a synchronization
    queued right away); ``pull_request`` → the PR is stored. A payload with none of these is accepted and changes
    nothing. A halted connection takes no delivery until «Обновить».
    """

    event: str  # the provider's event name (informational)
    action: str  # ≤ 64 characters
    installation_id: int | None
    repository_id: int | None
    ignored: bool  # an event PPM does not use: accepted, recorded, never applied
    # Ref update.
    ref: str  # "refs/heads/<branch>"
    deleted: bool  # the branch was removed
    branch: GitBranchObject
    commits: list[GitCommitObject]  # new commits of the push (at most 100)
    catch_up: CatchUpRange  # the provider cut the push: read the rest with a synchronization
    # Pull request event.
    pull_request: GitPullRequestObject
    # Repository-level state reported by the provider.
    connection_error: ConnectionErrorDirective
    # GitHub App lifecycle — only with provider "github"; applied by the GitHub-specific appliers.
    zen: str
    installation: dict
    repository_ids: list[int]
    repositories_added: list[int]
    repositories_removed: list[int]


# --- The client ------------------------------------------------------------------------------------------------------


@runtime_checkable
class GitProviderClient(Protocol):
    """Read-only provider calls of the neutral paths; signatures are those of ``GitHubAppClient``.

    ``installation_id`` is the connection's ``PpmGitInstallation.provider_installation_id`` (a provider without app
    installations uses a constant), ``repository_id`` and ``full_name`` come from ``PpmGitConnection``. Failures raise
    ``PpmGitProviderError`` with a safe Russian message (``PpmGitProviderRateLimited`` with ``retry_after_seconds``
    when the provider asks to wait); secrets never reach an exception, a log or a normalized object.
    """

    def sync_repository(
        self, installation_id: int, repository_id: int, full_name: str, *, since: str | None = None
    ) -> SyncRepositoryResult:
        """Branches, commits (since the ISO 8601 cursor ``since``, plus every branch head) and all pull requests.

        A provider whose webhook normalizer emits ``NormalizedDelivery.catch_up`` also accepts
        ``catch_up: list[CatchUpRange]`` and returns the commits of those ranges too; the argument is passed only when
        ranges are pending.
        """
        ...

    def get_code_tree(self, installation_id: int, repository_id: int, full_name: str, ref: str) -> CodeTree:
        """The complete file list of branch ``ref`` pinned to its exact commit; a truncated tree is an error."""
        ...

    def get_code_blobs(
        self, installation_id: int, repository_id: int, full_name: str, files: list[CodeTreeFile]
    ) -> CodeBlobs:
        """Raw content of exactly the requested blobs (read by ``sha``)."""
        ...

    def normalize_pull_request(self, payload: dict) -> GitPullRequestObject:
        """The provider's own PR payload (API answer or webhook ``pull_request``) as a normalized PR object."""
        ...
