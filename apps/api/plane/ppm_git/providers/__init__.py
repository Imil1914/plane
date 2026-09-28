"""Git providers of PPM: the shared contract (``base``), the client registry (``registry``), GitHub (``github``)
and PPM's own Git server Forgejo (``forgejo``, G2.1 line A2).
"""

from ..models import PpmGitProvider
from .base import GitProviderClient, PpmGitProviderError, PpmGitProviderRateLimited
from .forgejo import (
    FORGEJO_INSTALLATION_ID,
    ForgejoClient,
    forgejo_code_file_url,
    forgejo_is_configured,
    forgejo_public_url,
    forgejo_ssh_enabled,
    forgejo_trusted_origin,
)
from .github import GitHubAppClient, github_app_is_configured, github_code_file_url
from .registry import (
    get_provider_client,
    provider_code_file_url,
    provider_is_configured,
    register_provider,
    registered_providers,
)

register_provider(
    PpmGitProvider.GITHUB,
    factory=GitHubAppClient,
    is_configured=github_app_is_configured,
    code_file_url=github_code_file_url,
)
register_provider(
    PpmGitProvider.FORGEJO,
    factory=ForgejoClient,
    is_configured=forgejo_is_configured,
    code_file_url=forgejo_code_file_url,
)

__all__ = (
    "FORGEJO_INSTALLATION_ID",
    "ForgejoClient",
    "GitHubAppClient",
    "GitProviderClient",
    "PpmGitProviderError",
    "PpmGitProviderRateLimited",
    "forgejo_code_file_url",
    "forgejo_is_configured",
    "forgejo_public_url",
    "forgejo_ssh_enabled",
    "forgejo_trusted_origin",
    "get_provider_client",
    "github_app_is_configured",
    "provider_code_file_url",
    "provider_is_configured",
    "register_provider",
    "registered_providers",
)
