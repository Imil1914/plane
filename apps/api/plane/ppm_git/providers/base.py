from dataclasses import dataclass


@dataclass
class PpmGitProviderError(Exception):
    code: str
    message: str
    retry_after_seconds: int | None = None


class PpmGitProviderRateLimited(PpmGitProviderError):
    pass
