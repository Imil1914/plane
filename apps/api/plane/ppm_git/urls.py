from django.urls import path

from .views import (
    PpmForgejoAccessStatusView,
    PpmForgejoAccessSyncView,
    PpmForgejoRepositoriesView,
    PpmForgejoWebhookView,
    PpmGitCodeIndexPolicyView,
    PpmGitConnectionDetailView,
    PpmGitHubCallbackView,
    PpmGitHubConnectStartView,
    PpmGitHubInstallationRepositoriesView,
    PpmGitHubInstallationRefreshView,
    PpmGitHubRepositoryConnectView,
    PpmGitHubSetupView,
    PpmGitHubWebhookView,
    PpmGitLinkDetailView,
    PpmGitLinkListView,
    PpmGitOverviewView,
    PpmGitRepositoryDetailView,
    PpmGitRepositoryListView,
    PpmGitWriteActionApplyView,
    PpmGitWriteActionCancelView,
    PpmGitWriteActionDecisionView,
    PpmGitWriteActionDetailView,
    PpmGitWriteActionListView,
)


PROJECT = "workspaces/<uuid:workspace_id>/projects/<uuid:project_id>/git/"

urlpatterns = [
    path("git/github/setup/", PpmGitHubSetupView.as_view(), name="ppm-github-setup"),
    path("git/github/callback/", PpmGitHubCallbackView.as_view(), name="ppm-github-callback"),
    path("git/github/webhook/", PpmGitHubWebhookView.as_view(), name="ppm-github-webhook"),
    # G2.1: the system webhook of PPM's own Git server (Forgejo calls http://api:8000/api/ppm/v1/git/forgejo/webhook/).
    path("git/forgejo/webhook/", PpmForgejoWebhookView.as_view(), name="ppm-forgejo-webhook"),
    # G2.2 R18–R19: the «Git-сервер» tab of the admin centre (PPM global administrators only).
    path("git/forgejo/access/status/", PpmForgejoAccessStatusView.as_view(), name="ppm-forgejo-access-status"),
    path("git/forgejo/access/sync/", PpmForgejoAccessSyncView.as_view(), name="ppm-forgejo-access-sync"),
    path(PROJECT, PpmGitOverviewView.as_view(), name="ppm-project-git"),
    path(
        f"{PROJECT}providers/github/start/",
        PpmGitHubConnectStartView.as_view(),
        name="ppm-github-connect-start",
    ),
    path(
        f"{PROJECT}providers/github/installations/<uuid:installation_id>/repositories/",
        PpmGitHubInstallationRepositoriesView.as_view(),
        name="ppm-github-installation-repositories",
    ),
    path(
        f"{PROJECT}providers/github/installations/<uuid:installation_id>/refresh/",
        PpmGitHubInstallationRefreshView.as_view(),
        name="ppm-github-installation-refresh",
    ),
    path(
        f"{PROJECT}providers/github/repositories/",
        PpmGitHubRepositoryConnectView.as_view(),
        name="ppm-github-repository-connect",
    ),
    path(
        f"{PROJECT}providers/forgejo/repositories/",
        PpmForgejoRepositoriesView.as_view(),
        name="ppm-forgejo-repositories",
    ),
    path(
        f"{PROJECT}connections/<uuid:connection_id>/",
        PpmGitConnectionDetailView.as_view(),
        name="ppm-git-connection",
    ),
    path(f"{PROJECT}repositories/", PpmGitRepositoryListView.as_view(), name="ppm-git-repositories"),
    path(
        f"{PROJECT}repositories/<uuid:repository_id>/",
        PpmGitRepositoryDetailView.as_view(),
        name="ppm-git-repository",
    ),
    path(
        f"{PROJECT}repositories/<uuid:repository_id>/code-index/",
        PpmGitCodeIndexPolicyView.as_view(),
        name="ppm-git-code-index-policy",
    ),
    path(f"{PROJECT}links/", PpmGitLinkListView.as_view(), name="ppm-git-links"),
    path(f"{PROJECT}links/<uuid:link_id>/", PpmGitLinkDetailView.as_view(), name="ppm-git-link"),
    path(f"{PROJECT}write-actions/", PpmGitWriteActionListView.as_view(), name="ppm-git-write-actions"),
    path(
        f"{PROJECT}write-actions/<uuid:action_id>/",
        PpmGitWriteActionDetailView.as_view(),
        name="ppm-git-write-action",
    ),
    path(
        f"{PROJECT}write-actions/<uuid:action_id>/decision/",
        PpmGitWriteActionDecisionView.as_view(),
        name="ppm-git-write-action-decision",
    ),
    path(
        f"{PROJECT}write-actions/<uuid:action_id>/apply/",
        PpmGitWriteActionApplyView.as_view(),
        name="ppm-git-write-action-apply",
    ),
    path(
        f"{PROJECT}write-actions/<uuid:action_id>/cancel/",
        PpmGitWriteActionCancelView.as_view(),
        name="ppm-git-write-action-cancel",
    ),
]
