"""Registry of Git provider clients (G2.1 R1c).

A provider is registered once (``providers/__init__.py``) with a client factory, a «configured» check and its file URL
layout. The neutral paths ask for the client of a connection's (``connection.installation.provider``) or a
delivery's (``delivery.provider``) provider; they never name a provider class. Tests substitute a registration with
the ``provider_registry`` fixture (``tests/contract/ppm_git/conftest.py``).
"""

import enum
from collections.abc import Callable
from dataclasses import dataclass

from .base import CodeFileUrl, GitProviderClient, PpmGitProviderError


@dataclass(frozen=True)
class ProviderRegistration:
    factory: Callable[..., GitProviderClient]  # factory(**kwargs) → client; kwargs as the client accepts (session=…)
    is_configured: Callable[[], bool]  # all server settings of the provider are present
    code_file_url: CodeFileUrl  # (repository canonical URL, commit SHA, path) → link to the file at that commit


_REGISTRY: dict[str, ProviderRegistration] = {}


def provider_key(provider):
    """``PpmGitProvider.GITHUB`` and the stored string ``"github"`` are the same key."""
    return provider.value if isinstance(provider, enum.Enum) else provider


def register_provider(provider, *, factory, is_configured, code_file_url):
    _REGISTRY[provider_key(provider)] = ProviderRegistration(
        factory=factory,
        is_configured=is_configured,
        code_file_url=code_file_url,
    )


def registered_providers():
    return tuple(_REGISTRY)


def _registration(provider):
    registration = _REGISTRY.get(provider_key(provider))
    if registration is None:
        # The value comes from our own data, but it is still never echoed: the text stays the same for any input.
        raise PpmGitProviderError("GIT_PROVIDER_UNSUPPORTED", "Этот Git-провайдер не поддерживается PPM.")
    return registration


def provider_is_configured(provider):
    registration = _REGISTRY.get(provider_key(provider))
    return registration is not None and bool(registration.is_configured())


def get_provider_client(provider, **kwargs) -> GitProviderClient:
    """The client of ``provider``; refuses an unknown provider and one whose server settings are incomplete."""
    registration = _registration(provider)
    if not registration.is_configured():
        raise PpmGitProviderError(
            "GIT_PROVIDER_NOT_CONFIGURED",
            "Git-провайдер ещё не настроен администратором PPM.",
        )
    return registration.factory(**kwargs)


def provider_code_file_url(provider) -> CodeFileUrl:
    """How ``provider`` links a file at a commit. Needs no credentials, so no «configured» check."""
    return _registration(provider).code_file_url
