import logging
from urllib.parse import urlencode

from django.conf import settings
from django.db import transaction
from django.http import HttpResponseRedirect
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication
from plane.ppm_canvas.responses import get_request_id, ppm_error_response
from plane.db.models import Project, Workspace
from plane.ppm_core.permissions import PpmProjectAccess

from .models import (
    PpmGitAudit,
    PpmGitConnection,
    PpmGitInstallation,
    PpmGitInstallationStatus,
    PpmGitLink,
    PpmGitLinkStatus,
    PpmGitObject,
    PpmGitRepository,
    PpmGitRepositoryStatus,
    PpmGitWriteAction,
)
from .code_indexing import serialize_code_index, update_code_index_policy
from .permissions import get_ppm_git_capabilities
from .provider_services import (
    begin_github_user_authorization,
    complete_github_connect,
    connect_github_repository,
    create_delivery,
    disconnect_github_connection,
    list_github_repositories,
    provider_summary,
    refresh_github_installation,
    start_github_connect,
)
from .providers.base import PpmGitProviderError
from .services import PpmGitError, archive_repository, create_link, create_repository, update_repository
from .tasks import process_git_delivery_task, reconcile_git_connection_task, synchronize_git_code_task
from .webhooks import body_sha256, parse_github_webhook, verify_github_signature
from .write_actions import (
    create_git_write_action_preview,
    decide_git_write_action,
    serialize_git_write_action,
    serialize_git_write_readiness,
)


logger = logging.getLogger("plane.api")


def serialize_repository(repository):
    return {
        "id": str(repository.id),
        "name": repository.name,
        "provider": repository.provider,
        "provider_repository_id": repository.provider_repository_id,
        "provider_full_name": repository.provider_full_name,
        "canonical_url": repository.canonical_url,
        "clone_https": repository.clone_https,
        "clone_ssh": repository.clone_ssh,
        "default_branch": repository.default_branch,
        "visibility": repository.visibility,
        "is_default": repository.is_default,
        "status": repository.status,
        "created_at": repository.created_at.isoformat(),
        "updated_at": repository.updated_at.isoformat(),
        "code_index": serialize_code_index(repository),
    }


def serialize_link(link):
    return {
        "id": str(link.id),
        "repository_id": str(link.repository_id),
        "repository_name": link.repository.name,
        "repository_provider": link.repository.provider,
        "work_item": {
            "id": str(link.work_item_id),
            "identifier": f"{link.work_item.project.identifier}-{link.work_item.sequence_id}",
            "title": link.work_item.name,
        },
        "object_type": link.object_type,
        "ref": link.ref,
        "title": link.title,
        "canonical_url": link.canonical_url,
        "status": link.status,
        "origin": link.origin,
        "git_object_id": str(link.git_object_id) if link.git_object_id else None,
        "created_at": link.created_at.isoformat(),
        "updated_at": link.updated_at.isoformat(),
    }


def serialize_installation(installation):
    return {
        "id": str(installation.id),
        "provider": installation.provider,
        "account_login": installation.account_login,
        "account_type": installation.account_type,
        "repository_selection": installation.repository_selection,
        "permissions": installation.permissions,
        "events": installation.events,
        "status": installation.status,
        "created_at": installation.created_at.isoformat(),
        "updated_at": installation.updated_at.isoformat(),
    }


def serialize_connection(connection):
    return {
        "id": str(connection.id),
        "repository_id": str(connection.repository_id),
        "installation_id": str(connection.installation_id),
        "provider_repository_id": connection.provider_repository_id,
        "provider_full_name": connection.provider_full_name,
        "status": connection.status,
        "last_sync_at": connection.last_sync_at.isoformat() if connection.last_sync_at else None,
        "last_event_at": connection.last_event_at.isoformat() if connection.last_event_at else None,
        "last_error": (
            {"code": connection.last_error_code, "message": connection.last_error_message}
            if connection.last_error_code
            else None
        ),
        "retry_after": connection.retry_after.isoformat() if connection.retry_after else None,
        "created_at": connection.created_at.isoformat(),
        "updated_at": connection.updated_at.isoformat(),
    }


def serialize_git_object(git_object):
    return {
        "id": str(git_object.id),
        "repository_id": str(git_object.repository_id),
        "connection_id": str(git_object.connection_id),
        "object_type": git_object.object_type,
        "ref": git_object.ref,
        "title": git_object.title,
        "canonical_url": git_object.canonical_url,
        "state": git_object.state,
        "is_draft": git_object.is_draft,
        "author_name": git_object.author_name,
        "author_avatar_url": git_object.author_avatar_url,
        "base_ref": git_object.base_ref,
        "head_ref": git_object.head_ref,
        "commit_sha": git_object.commit_sha,
        "is_active": git_object.is_active,
        "provider_updated_at": (git_object.provider_updated_at.isoformat() if git_object.provider_updated_at else None),
        "last_seen_at": git_object.last_seen_at.isoformat(),
    }


def serialize_provider_repository(repository):
    return {
        **repository,
        "updated_at": repository["updated_at"].isoformat() if repository.get("updated_at") else None,
    }


def error_status(code):
    if code == "GIT_PERMISSION_DENIED":
        return status.HTTP_403_FORBIDDEN
    if code in {
        "GIT_REPOSITORY_NOT_FOUND",
        "GIT_LINK_NOT_FOUND",
        "GIT_WORK_ITEM_NOT_FOUND",
        "GITHUB_INSTALLATION_NOT_FOUND",
        "GITHUB_CONNECTION_NOT_FOUND",
        "GIT_WRITE_ACTION_NOT_FOUND",
    }:
        return status.HTTP_404_NOT_FOUND
    if code in {
        "GIT_REPOSITORY_CONFLICT",
        "GIT_LINK_CONFLICT",
        "GIT_DEFAULT_REQUIRED",
        "GITHUB_DELIVERY_CONFLICT",
        "CODE_INDEX_CONNECTION_REQUIRED",
        "GIT_WRITE_CONNECTION_REQUIRED",
        "GIT_WRITE_OPERATION_REUSED",
        "GIT_WRITE_REF_CONFLICT",
        "GIT_WRITE_DECISION_FINAL",
        "GIT_WRITE_SOURCE_CHANGED",
    }:
        return status.HTTP_409_CONFLICT
    if code == "GITHUB_RATE_LIMITED":
        return status.HTTP_429_TOO_MANY_REQUESTS
    return status.HTTP_400_BAD_REQUEST


class PpmGitAPIView(APIView):
    authentication_classes = [BaseSessionAuthentication]
    permission_classes = [IsAuthenticated]

    def handle_exception(self, exc):
        if isinstance(exc, (AuthenticationFailed, NotAuthenticated)):
            return ppm_error_response(
                self.request,
                code="AUTHENTICATION_REQUIRED",
                message="Требуется авторизация.",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        if isinstance(exc, PpmGitError):
            return ppm_error_response(
                self.request,
                code=exc.code,
                message=exc.message,
                status_code=error_status(exc.code),
                details=exc.details,
            )
        if isinstance(exc, PpmGitProviderError):
            return ppm_error_response(
                self.request,
                code=exc.code,
                message=exc.message,
                status_code=error_status(exc.code),
            )
        return super().handle_exception(exc)

    def require_capability(self, request, workspace_id, project_id, capability="read"):
        access, capabilities = get_ppm_git_capabilities(
            user=request.user,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        if access == PpmProjectAccess.DENY or not capabilities[capability]:
            return None, ppm_error_response(
                request,
                code="GIT_PERMISSION_DENIED",
                message="Недостаточно прав для Git-раздела проекта.",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        return capabilities, None

    def audit(self, request, *, workspace_id, project_id, action, target_type, target_id, metadata=None):
        PpmGitAudit.objects.create(
            workspace_id=workspace_id,
            project_id=project_id,
            actor_id=request.user.id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            request_id=get_request_id(request),
            metadata=metadata or {},
        )

    def get_repository(self, *, workspace_id, project_id, repository_id):
        repository = PpmGitRepository.objects.filter(
            id=repository_id,
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmGitRepositoryStatus.ACTIVE,
        ).first()
        if repository is None:
            raise PpmGitError("GIT_REPOSITORY_NOT_FOUND", "Репозиторий не найден.")
        return repository

    def get_link(self, *, workspace_id, project_id, link_id):
        link = (
            PpmGitLink.objects.select_related("repository", "work_item__project")
            .filter(
                id=link_id,
                workspace_id=workspace_id,
                project_id=project_id,
                status=PpmGitLinkStatus.ACTIVE,
            )
            .first()
        )
        if link is None:
            raise PpmGitError("GIT_LINK_NOT_FOUND", "Git-связь не найдена.")
        return link

    def get_installation(self, *, workspace_id, project_id, installation_id):
        installation = PpmGitInstallation.objects.filter(
            id=installation_id,
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmGitInstallationStatus.ACTIVE,
        ).first()
        if installation is None:
            raise PpmGitError("GITHUB_INSTALLATION_NOT_FOUND", "Подключение GitHub App не найдено.")
        return installation

    def get_connection(self, *, workspace_id, project_id, connection_id):
        connection = (
            PpmGitConnection.objects.select_related("repository", "installation")
            .filter(
                id=connection_id,
                workspace_id=workspace_id,
                project_id=project_id,
            )
            .first()
        )
        if connection is None:
            raise PpmGitError("GITHUB_CONNECTION_NOT_FOUND", "Подключённый репозиторий не найден.")
        return connection

    def get_write_action(self, *, workspace_id, project_id, action_id):
        action = (
            PpmGitWriteAction.objects.select_related(
                "repository",
                "connection__installation",
                "work_item__project",
            )
            .filter(id=action_id, workspace_id=workspace_id, project_id=project_id)
            .first()
        )
        if action is None:
            raise PpmGitError("GIT_WRITE_ACTION_NOT_FOUND", "Предложение Git-действия не найдено.")
        return action


class PpmGitOverviewView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id):
        capabilities, denied = self.require_capability(request, workspace_id, project_id)
        if denied:
            return denied
        repositories = PpmGitRepository.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmGitRepositoryStatus.ACTIVE,
        )
        links = PpmGitLink.objects.select_related("repository", "work_item__project").filter(
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmGitLinkStatus.ACTIVE,
        )
        installations = PpmGitInstallation.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
        )
        connections = PpmGitConnection.objects.select_related("repository", "installation").filter(
            workspace_id=workspace_id,
            project_id=project_id,
        )
        git_objects = PpmGitObject.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            is_active=True,
        )[:100]
        write_actions = PpmGitWriteAction.objects.select_related(
            "repository",
            "connection__installation",
            "work_item__project",
        ).filter(workspace_id=workspace_id, project_id=project_id)[:20]
        return Response(
            {
                "capabilities": capabilities,
                "provider": provider_summary(),
                "repositories": [serialize_repository(repository) for repository in repositories],
                "installations": [serialize_installation(installation) for installation in installations],
                "connections": [serialize_connection(connection) for connection in connections],
                "objects": [serialize_git_object(git_object) for git_object in git_objects],
                "links": [serialize_link(link) for link in links],
                "write_actions": {
                    "provider_writes_enabled": bool(getattr(settings, "PPM_GIT_WRITE_ENABLED", False)),
                    "apply_available": False,
                    "readiness": serialize_git_write_readiness(connections),
                    "items": [serialize_git_write_action(action) for action in write_actions],
                },
                "conventions": {
                    "branch": "<WORK_ITEM_KEY>/<short-slug>",
                    "commit": "<WORK_ITEM_KEY>: <message>",
                    "pull_request": "<WORK_ITEM_KEY> — <title>",
                },
            }
        )


class PpmGitWriteActionListView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id):
        _, denied = self.require_capability(request, workspace_id, project_id)
        if denied:
            return denied
        actions = PpmGitWriteAction.objects.select_related(
            "repository",
            "connection__installation",
            "work_item__project",
        ).filter(workspace_id=workspace_id, project_id=project_id)[:50]
        connections = PpmGitConnection.objects.select_related("repository", "installation").filter(
            workspace_id=workspace_id,
            project_id=project_id,
        )
        return Response(
            {
                "provider_writes_enabled": bool(getattr(settings, "PPM_GIT_WRITE_ENABLED", False)),
                "apply_available": False,
                "readiness": serialize_git_write_readiness(connections),
                "items": [serialize_git_write_action(action) for action in actions],
            }
        )

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_write_actions")
        if denied:
            return denied
        action, created = create_git_write_action_preview(
            workspace_id=workspace_id,
            project_id=project_id,
            payload=request.data,
            user_id=request.user.id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="write_action.preview_created" if created else "write_action.preview_replayed",
            target_type="write_action",
            target_id=action.id,
            metadata={
                "action_type": action.action_type,
                "repository_id": str(action.repository_id),
                "work_item_id": str(action.work_item_id),
                "provider_write_performed": False,
            },
        )
        return Response(
            serialize_git_write_action(action),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class PpmGitWriteActionDetailView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id, action_id):
        _, denied = self.require_capability(request, workspace_id, project_id)
        if denied:
            return denied
        return Response(
            serialize_git_write_action(
                self.get_write_action(workspace_id=workspace_id, project_id=project_id, action_id=action_id)
            )
        )


class PpmGitWriteActionDecisionView(PpmGitAPIView):
    def post(self, request, workspace_id, project_id, action_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_write_actions")
        if denied:
            return denied
        action = self.get_write_action(
            workspace_id=workspace_id,
            project_id=project_id,
            action_id=action_id,
        )
        decision = request.data.get("decision")
        try:
            action, changed = decide_git_write_action(action=action, decision=decision, user_id=request.user.id)
        except PpmGitError as exc:
            if exc.code == "GIT_WRITE_SOURCE_CHANGED":
                self.audit(
                    request,
                    workspace_id=workspace_id,
                    project_id=project_id,
                    action="write_action.conflict",
                    target_type="write_action",
                    target_id=action.id,
                    metadata={"error_code": exc.code, "provider_write_performed": False},
                )
            raise
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action=f"write_action.{decision}" if changed else f"write_action.{decision}_replayed",
            target_type="write_action",
            target_id=action.id,
            metadata={
                "status": action.status,
                "repository_id": str(action.repository_id),
                "work_item_id": str(action.work_item_id),
                "provider_write_performed": False,
            },
        )
        return Response(serialize_git_write_action(action))


class PpmGitRepositoryListView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id):
        capabilities, denied = self.require_capability(request, workspace_id, project_id)
        if denied:
            return denied
        repositories = PpmGitRepository.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmGitRepositoryStatus.ACTIVE,
        )
        return Response(
            {
                "capabilities": capabilities,
                "repositories": [serialize_repository(item) for item in repositories],
            }
        )

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_repositories")
        if denied:
            return denied
        repository = create_repository(
            workspace_id=workspace_id,
            project_id=project_id,
            payload=request.data,
            user_id=request.user.id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="repository.create",
            target_type="repository",
            target_id=repository.id,
            metadata={"provider": repository.provider, "is_default": repository.is_default},
        )
        return Response(serialize_repository(repository), status=status.HTTP_201_CREATED)


class PpmGitRepositoryDetailView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id, repository_id):
        _, denied = self.require_capability(request, workspace_id, project_id)
        if denied:
            return denied
        return Response(
            serialize_repository(
                self.get_repository(workspace_id=workspace_id, project_id=project_id, repository_id=repository_id)
            )
        )

    def patch(self, request, workspace_id, project_id, repository_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_repositories")
        if denied:
            return denied
        repository = self.get_repository(workspace_id=workspace_id, project_id=project_id, repository_id=repository_id)
        changed_fields = sorted(request.data.keys())
        repository = update_repository(repository=repository, payload=request.data, user_id=request.user.id)
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="repository.update",
            target_type="repository",
            target_id=repository.id,
            metadata={"changed_fields": changed_fields},
        )
        return Response(serialize_repository(repository))

    def delete(self, request, workspace_id, project_id, repository_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_repositories")
        if denied:
            return denied
        repository = archive_repository(
            repository=self.get_repository(
                workspace_id=workspace_id, project_id=project_id, repository_id=repository_id
            ),
            user_id=request.user.id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="repository.archive",
            target_type="repository",
            target_id=repository.id,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class PpmGitCodeIndexPolicyView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id, repository_id):
        _, denied = self.require_capability(request, workspace_id, project_id)
        if denied:
            return denied
        repository = self.get_repository(
            workspace_id=workspace_id,
            project_id=project_id,
            repository_id=repository_id,
        )
        return Response(serialize_code_index(repository))

    def patch(self, request, workspace_id, project_id, repository_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        repository = self.get_repository(
            workspace_id=workspace_id,
            project_id=project_id,
            repository_id=repository_id,
        )
        policy = update_code_index_policy(
            repository=repository,
            payload=request.data,
            user_id=request.user.id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="code_index.policy.update",
            target_type="repository",
            target_id=repository.id,
            metadata={
                "enabled": policy.enabled,
                "branch": policy.branch,
                "include_paths": policy.include_paths,
                "exclude_paths": policy.exclude_paths,
            },
        )
        if policy.enabled:
            transaction.on_commit(lambda: synchronize_git_code_task.delay(str(repository.id)))
        return Response(serialize_code_index(repository))

    def post(self, request, workspace_id, project_id, repository_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        repository = self.get_repository(
            workspace_id=workspace_id,
            project_id=project_id,
            repository_id=repository_id,
        )
        code_index = serialize_code_index(repository)
        if not code_index["enabled"]:
            raise PpmGitError("CODE_INDEX_DISABLED", "Сначала включите индексацию кода для репозитория.")
        transaction.on_commit(lambda: synchronize_git_code_task.delay(str(repository.id)))
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="code_index.sync.request",
            target_type="repository",
            target_id=repository.id,
        )
        return Response({"accepted": True, "code_index": code_index}, status=status.HTTP_202_ACCEPTED)


class PpmGitLinkListView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id):
        capabilities, denied = self.require_capability(request, workspace_id, project_id)
        if denied:
            return denied
        links = PpmGitLink.objects.select_related("repository", "work_item__project").filter(
            workspace_id=workspace_id,
            project_id=project_id,
            status=PpmGitLinkStatus.ACTIVE,
        )
        return Response({"capabilities": capabilities, "links": [serialize_link(item) for item in links]})

    def post(self, request, workspace_id, project_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_links")
        if denied:
            return denied
        link = create_link(
            workspace_id=workspace_id,
            project_id=project_id,
            payload=request.data,
            user_id=request.user.id,
        )
        link = PpmGitLink.objects.select_related("repository", "work_item__project").get(id=link.id)
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="link.create",
            target_type="link",
            target_id=link.id,
            metadata={"object_type": link.object_type, "repository_id": str(link.repository_id)},
        )
        return Response(serialize_link(link), status=status.HTTP_201_CREATED)


class PpmGitLinkDetailView(PpmGitAPIView):
    def delete(self, request, workspace_id, project_id, link_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_links")
        if denied:
            return denied
        link = self.get_link(workspace_id=workspace_id, project_id=project_id, link_id=link_id)
        link.unlink(user_id=request.user.id)
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="link.unlink",
            target_type="link",
            target_id=link.id,
            metadata={"repository_id": str(link.repository_id)},
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class PpmGitHubConnectStartView(PpmGitAPIView):
    def post(self, request, workspace_id, project_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        result = start_github_connect(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="github.connect.start",
            target_type="provider",
            target_id=None,
        )
        return Response(result)


class PpmGitHubFlowAPIView(PpmGitAPIView):
    authentication_classes = []
    permission_classes = [AllowAny]


class PpmGitHubSetupView(PpmGitHubFlowAPIView):
    def get(self, request):
        _, authorization_url = begin_github_user_authorization(
            raw_state=request.query_params.get("state"),
            installation_id=request.query_params.get("installation_id"),
        )
        return HttpResponseRedirect(authorization_url)


class PpmGitHubCallbackView(PpmGitHubFlowAPIView):
    def get(self, request):
        connect_state, installation = complete_github_connect(
            raw_state=request.query_params.get("state"),
            code=request.query_params.get("code"),
        )
        PpmGitAudit.objects.create(
            workspace_id=connect_state.workspace_id,
            project_id=connect_state.project_id,
            actor_id=connect_state.user_id,
            action="github.connect.complete",
            target_type="installation",
            target_id=installation.id,
            request_id=get_request_id(request),
            metadata={"account_login": installation.account_login},
        )
        project = (
            Project.objects.filter(
                id=connect_state.project_id,
                workspace_id=connect_state.workspace_id,
            )
            .only("id")
            .first()
        )
        workspace = Workspace.objects.filter(id=connect_state.workspace_id).only("slug").first()
        if project is None or workspace is None:
            raise PpmGitError("GIT_PROJECT_NOT_FOUND", "Проект для подключения GitHub не найден.")
        relative_url = f"/{workspace.slug}/projects/{project.id}/code?{urlencode({'github': 'connected'})}"
        target = f"{settings.APP_BASE_URL.rstrip('/')}{relative_url}" if settings.APP_BASE_URL else relative_url
        return HttpResponseRedirect(target)


class PpmGitHubInstallationRepositoriesView(PpmGitAPIView):
    def get(self, request, workspace_id, project_id, installation_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        installation = self.get_installation(
            workspace_id=workspace_id,
            project_id=project_id,
            installation_id=installation_id,
        )
        repositories = list_github_repositories(installation=installation)
        return Response({"repositories": [serialize_provider_repository(item) for item in repositories]})


class PpmGitHubInstallationRefreshView(PpmGitAPIView):
    def post(self, request, workspace_id, project_id, installation_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        installation = refresh_github_installation(
            installation=self.get_installation(
                workspace_id=workspace_id,
                project_id=project_id,
                installation_id=installation_id,
            ),
            user_id=request.user.id,
        )
        connections = PpmGitConnection.objects.select_related("repository", "installation").filter(
            workspace_id=workspace_id,
            project_id=project_id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="github.installation.permissions.refresh",
            target_type="installation",
            target_id=installation.id,
            metadata={"permissions": installation.permissions},
        )
        return Response(
            {
                "installation": serialize_installation(installation),
                "readiness": serialize_git_write_readiness(connections),
            }
        )


class PpmGitHubRepositoryConnectView(PpmGitAPIView):
    def post(self, request, workspace_id, project_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        installation = self.get_installation(
            workspace_id=workspace_id,
            project_id=project_id,
            installation_id=request.data.get("installation_id"),
        )
        connection = connect_github_repository(
            workspace_id=workspace_id,
            project_id=project_id,
            installation=installation,
            provider_repository_id=request.data.get("provider_repository_id"),
            user_id=request.user.id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="github.repository.connect",
            target_type="connection",
            target_id=connection.id,
            metadata={"provider_full_name": connection.provider_full_name},
        )
        transaction.on_commit(lambda: reconcile_git_connection_task.delay(str(connection.id)))
        return Response(serialize_connection(connection), status=status.HTTP_201_CREATED)


class PpmGitConnectionDetailView(PpmGitAPIView):
    def post(self, request, workspace_id, project_id, connection_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        connection = self.get_connection(
            workspace_id=workspace_id,
            project_id=project_id,
            connection_id=connection_id,
        )
        reconcile_git_connection_task.delay(str(connection.id))
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="github.repository.sync",
            target_type="connection",
            target_id=connection.id,
        )
        return Response(
            {"accepted": True, "connection": serialize_connection(connection)},
            status=status.HTTP_202_ACCEPTED,
        )

    def delete(self, request, workspace_id, project_id, connection_id):
        _, denied = self.require_capability(request, workspace_id, project_id, "manage_provider")
        if denied:
            return denied
        connection = disconnect_github_connection(
            connection=self.get_connection(
                workspace_id=workspace_id,
                project_id=project_id,
                connection_id=connection_id,
            ),
            user_id=request.user.id,
        )
        self.audit(
            request,
            workspace_id=workspace_id,
            project_id=project_id,
            action="github.repository.disconnect",
            target_type="connection",
            target_id=connection.id,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class PpmGitHubWebhookView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        if not settings.PPM_GITHUB_WEBHOOK_SECRET:
            return ppm_error_response(
                request,
                code="GITHUB_APP_NOT_CONFIGURED",
                message="Webhook GitHub App ещё не настроен.",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        content_length = request.META.get("CONTENT_LENGTH")
        if content_length and content_length.isdigit() and int(content_length) > settings.PPM_GITHUB_WEBHOOK_MAX_BYTES:
            return ppm_error_response(
                request,
                code="GITHUB_WEBHOOK_TOO_LARGE",
                message="Событие GitHub превышает допустимый размер.",
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        raw_body = request.body
        if len(raw_body) > settings.PPM_GITHUB_WEBHOOK_MAX_BYTES:
            return ppm_error_response(
                request,
                code="GITHUB_WEBHOOK_TOO_LARGE",
                message="Событие GitHub превышает допустимый размер.",
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        if not verify_github_signature(raw_body, request.META.get("HTTP_X_HUB_SIGNATURE_256")):
            return ppm_error_response(
                request,
                code="GITHUB_WEBHOOK_SIGNATURE_INVALID",
                message="Подпись события GitHub не прошла проверку.",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        delivery_id = request.META.get("HTTP_X_GITHUB_DELIVERY", "")
        event_name = request.META.get("HTTP_X_GITHUB_EVENT", "")
        if not delivery_id or len(delivery_id) > 255 or not event_name or len(event_name) > 64:
            return ppm_error_response(
                request,
                code="GITHUB_WEBHOOK_HEADERS_INVALID",
                message="В событии GitHub отсутствуют обязательные заголовки.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        try:
            normalized_payload = parse_github_webhook(raw_body, event_name=event_name)
            delivery, duplicate = create_delivery(
                delivery_id=delivery_id,
                event_name=event_name,
                raw_body_hash=body_sha256(raw_body),
                normalized_payload=normalized_payload,
            )
        except (PpmGitError, PpmGitProviderError) as exc:
            return ppm_error_response(
                request,
                code=exc.code,
                message=exc.message,
                status_code=error_status(exc.code),
                details=getattr(exc, "details", None),
            )
        except Exception:
            logger.exception(
                "Unexpected GitHub webhook failure",
                extra={
                    "github_delivery_id": delivery_id,
                    "github_event_name": event_name,
                },
            )
            return ppm_error_response(
                request,
                code="GITHUB_WEBHOOK_FAILED",
                message="Не удалось принять событие GitHub.",
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        if not duplicate:
            transaction.on_commit(lambda: process_git_delivery_task.delay(str(delivery.id)))
        return Response(
            {"accepted": True, "duplicate": duplicate},
            status=status.HTTP_200_OK if duplicate else status.HTTP_202_ACCEPTED,
        )
