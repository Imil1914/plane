from dataclasses import dataclass


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
