from datetime import datetime, timedelta

from django.conf import settings
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated, NotFound
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication
from plane.db.models import Project, ProjectMember, User, WorkspaceMember
from plane.ppm_canvas.models import (
    PpmCanvasStatus,
    PpmGlobalAdmin,
    PpmGlobalAdminAudit,
    PpmProjectCanvas,
)
from plane.ppm_canvas.responses import get_request_id, ppm_error_response
from plane.ppm_core.permissions import is_ppm_global_admin


ADMIN_REAUTH_SESSION_KEY = "ppm_admin_reauthenticated_at"
DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100


class PpmGlobalAdminPermission(BasePermission):
    message = "Доступ разрешён только глобальному администратору PPM."

    def has_permission(self, request, view):
        return is_ppm_global_admin(user=request.user)


class PpmAdminAccessView(APIView):
    authentication_classes = [BaseSessionAuthentication]
    permission_classes = [IsAuthenticated]

    def get(self, request):
        registry = PpmGlobalAdmin.objects.filter(user=request.user, revoked_at__isnull=True).first()
        expires_at = get_admin_reauth_expiry(request)
        return Response(
            {
                "is_global_admin": bool(registry and getattr(settings, "PPM_ADMIN_CENTER_ENABLED", True)),
                "role": "ppm_global_admin" if registry else None,
                "granted_at": registry.created_at.isoformat() if registry else None,
                "reauthenticated_until": expires_at.isoformat() if expires_at else None,
            },
            status=status.HTTP_200_OK,
        )


class PpmAdminAPIView(APIView):
    authentication_classes = [BaseSessionAuthentication]
    permission_classes = [IsAuthenticated, PpmGlobalAdminPermission]

    def initial(self, request, *args, **kwargs):
        if not getattr(settings, "PPM_ADMIN_CENTER_ENABLED", True):
            raise NotFound("Центр администратора временно отключён.")
        super().initial(request, *args, **kwargs)

    def handle_exception(self, exc):
        if isinstance(exc, (AuthenticationFailed, NotAuthenticated)):
            return ppm_error_response(
                self.request,
                code="AUTHENTICATION_REQUIRED",
                message="Требуется авторизация.",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        return super().handle_exception(exc)

    def get_admin_registry(self, request):
        return PpmGlobalAdmin.objects.select_related("user").get(user=request.user, revoked_at__isnull=True)

    def audit(self, request, action, *, workspace_id=None, project_id=None, metadata=None):
        return PpmGlobalAdminAudit.objects.create(
            global_admin=self.get_admin_registry(request),
            action=action,
            workspace_id=workspace_id,
            project_id=project_id,
            method=request.method,
            path=request.path[:500],
            request_id=get_request_id(request),
            metadata=metadata or {},
        )

    def pagination(self, request):
        try:
            page = int(request.query_params.get("page", 1))
            page_size = int(request.query_params.get("page_size", DEFAULT_PAGE_SIZE))
        except (TypeError, ValueError):
            return None, ppm_error_response(
                request,
                code="ADMIN_INVALID_PAGINATION",
                message="Параметры страницы должны быть целыми числами.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if page < 1 or page_size < 1 or page_size > MAX_PAGE_SIZE:
            return None, ppm_error_response(
                request,
                code="ADMIN_INVALID_PAGINATION",
                message=f"Номер страницы должен быть положительным, размер — от 1 до {MAX_PAGE_SIZE}.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        return (page, page_size), None


class PpmAdminProjectListView(PpmAdminAPIView):
    def get(self, request):
        pagination, invalid = self.pagination(request)
        if invalid:
            return invalid
        page, page_size = pagination
        query = request.query_params.get("q", "").strip()[:160]
        projects = Project.objects.filter(deleted_at__isnull=True).select_related("workspace", "project_lead")
        if query:
            projects = projects.filter(
                Q(name__icontains=query)
                | Q(identifier__icontains=query)
                | Q(workspace__name__icontains=query)
                | Q(workspace__slug__icontains=query)
            )
        projects = projects.order_by("workspace__name", "name", "id")
        total = projects.count()
        offset = (page - 1) * page_size
        selected = list(projects[offset : offset + page_size])
        project_ids = [project.id for project in selected]

        member_counts = {
            row["project_id"]: row["count"]
            for row in ProjectMember.objects.filter(
                project_id__in=project_ids,
                is_active=True,
                deleted_at__isnull=True,
            )
            .values("project_id")
            .annotate(count=Count("id"))
        }
        canvases = {
            canvas.project_id: canvas
            for canvas in PpmProjectCanvas.objects.filter(
                project_id__in=project_ids,
                status=PpmCanvasStatus.ACTIVE,
            ).annotate(
                active_board_count=Count("boards", filter=Q(boards__status=PpmCanvasStatus.ACTIVE)),
                archived_board_count=Count("boards", filter=Q(boards__status=PpmCanvasStatus.ARCHIVED)),
            )
        }

        results = []
        for project in selected:
            canvas = canvases.get(project.id)
            results.append(
                {
                    "project_id": str(project.id),
                    "name": project.name,
                    "identifier": project.identifier,
                    "workspace": {
                        "workspace_id": str(project.workspace_id),
                        "name": project.workspace.name,
                        "slug": project.workspace.slug,
                    },
                    "lead": (
                        {
                            "user_id": str(project.project_lead_id),
                            "display_name": project.project_lead.display_name,
                            "email": project.project_lead.email,
                        }
                        if project.project_lead
                        else None
                    ),
                    "member_count": member_counts.get(project.id, 0),
                    "status": "archived" if project.archived_at else "active",
                    "updated_at": project.updated_at.isoformat(),
                    "integrations": {
                        "canvas": {
                            "status": (
                                "ready"
                                if canvas and canvas.current_version > 0
                                else "empty"
                                if canvas
                                else "not_created"
                            ),
                            "active_boards": canvas.active_board_count if canvas else 0,
                            "archived_boards": canvas.archived_board_count if canvas else 0,
                            "current_version": canvas.current_version if canvas else 0,
                        },
                        "vault": {"status": "not_configured", "available": False},
                        "brain": {"status": "not_configured", "available": False},
                        "git": {"status": "not_configured", "available": False},
                    },
                }
            )

        self.audit(
            request,
            "admin_projects_list",
            metadata={"query": query, "page": page, "result_count": len(results)},
        )
        return Response(
            {
                "results": results,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "has_next": offset + len(results) < total,
                },
            },
            status=status.HTTP_200_OK,
        )


class PpmAdminProjectEnterView(PpmAdminAPIView):
    def post(self, request, project_id):
        project = Project.objects.select_related("workspace").filter(id=project_id, deleted_at__isnull=True).first()
        if project is None:
            return ppm_error_response(
                request,
                code="ADMIN_PROJECT_NOT_FOUND",
                message="Проект не найден.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        self.audit(
            request,
            "project_admin_mode_enter",
            workspace_id=project.workspace_id,
            project_id=project.id,
            metadata={"workspace_slug": project.workspace.slug, "project_identifier": project.identifier},
        )
        return Response(
            {
                "project_id": str(project.id),
                "workspace_id": str(project.workspace_id),
                "workspace_slug": project.workspace.slug,
                "admin_mode": True,
                "navigation_url": f"/{project.workspace.slug}/projects/{project.id}/overview?ppm_admin_mode=1",
            },
            status=status.HTTP_200_OK,
        )


class PpmAdminUserListView(PpmAdminAPIView):
    def get(self, request):
        pagination, invalid = self.pagination(request)
        if invalid:
            return invalid
        page, page_size = pagination
        query = request.query_params.get("q", "").strip()[:160]
        users = User.objects.all().order_by("display_name", "email", "id")
        if query:
            users = users.filter(
                Q(display_name__icontains=query)
                | Q(email__icontains=query)
                | Q(first_name__icontains=query)
                | Q(last_name__icontains=query)
            )
        total = users.count()
        offset = (page - 1) * page_size
        selected = list(users[offset : offset + page_size])
        user_ids = [user.id for user in selected]
        workspace_counts = {
            row["member_id"]: row["count"]
            for row in WorkspaceMember.objects.filter(
                member_id__in=user_ids,
                is_active=True,
                deleted_at__isnull=True,
            )
            .values("member_id")
            .annotate(count=Count("id"))
        }
        project_counts = {
            row["member_id"]: row["count"]
            for row in ProjectMember.objects.filter(
                member_id__in=user_ids,
                is_active=True,
                deleted_at__isnull=True,
            )
            .values("member_id")
            .annotate(count=Count("id"))
        }
        global_admin_ids = set(
            PpmGlobalAdmin.objects.filter(user_id__in=user_ids, revoked_at__isnull=True).values_list(
                "user_id", flat=True
            )
        )
        results = [
            {
                "user_id": str(user.id),
                "display_name": user.display_name,
                "email": user.email,
                "avatar_url": user.avatar_url,
                "is_active": user.is_active,
                "is_bot": user.is_bot,
                "is_global_admin": user.id in global_admin_ids,
                "workspace_count": workspace_counts.get(user.id, 0),
                "project_count": project_counts.get(user.id, 0),
                "last_active": user.last_active.isoformat() if user.last_active else None,
            }
            for user in selected
        ]
        self.audit(request, "admin_users_list", metadata={"query": query, "page": page, "result_count": len(results)})
        return Response(
            {
                "results": results,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "has_next": offset + len(results) < total,
                },
            },
            status=status.HTTP_200_OK,
        )


class PpmAdminAuditListView(PpmAdminAPIView):
    def get(self, request):
        pagination, invalid = self.pagination(request)
        if invalid:
            return invalid
        page, page_size = pagination
        events = PpmGlobalAdminAudit.objects.select_related("global_admin__user").order_by("-created_at", "-id")
        total = events.count()
        offset = (page - 1) * page_size
        selected = list(events[offset : offset + page_size])
        self.audit(request, "admin_audit_list", metadata={"page": page, "result_count": len(selected)})
        return Response(
            {
                "results": [
                    {
                        "audit_id": str(event.id),
                        "action": event.action,
                        "actor": {
                            "user_id": str(event.global_admin.user_id),
                            "display_name": event.global_admin.user.display_name,
                            "email": event.global_admin.user.email,
                        },
                        "workspace_id": str(event.workspace_id) if event.workspace_id else None,
                        "project_id": str(event.project_id) if event.project_id else None,
                        "method": event.method,
                        "path": event.path,
                        "request_id": str(event.request_id),
                        "metadata": event.metadata,
                        "created_at": event.created_at.isoformat(),
                    }
                    for event in selected
                ],
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "has_next": offset + len(selected) < total,
                },
            },
            status=status.HTTP_200_OK,
        )


class PpmAdminReauthenticateView(PpmAdminAPIView):
    def post(self, request):
        password = request.data.get("password")
        if not isinstance(password, str) or not password or len(password) > 1_024:
            return ppm_error_response(
                request,
                code="ADMIN_REAUTH_INVALID",
                message="Введите текущий пароль.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not request.user.check_password(password):
            self.audit(request, "admin_reauth_failed")
            return ppm_error_response(
                request,
                code="ADMIN_REAUTH_FAILED",
                message="Пароль не подтверждён.",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        authenticated_at = timezone.now()
        request.session[ADMIN_REAUTH_SESSION_KEY] = authenticated_at.timestamp()
        request.session.modified = True
        expires_at = authenticated_at + timedelta(seconds=get_admin_reauth_ttl_seconds())
        self.audit(request, "admin_reauth_succeeded")
        return Response(
            {"reauthenticated": True, "reauthenticated_until": expires_at.isoformat()},
            status=status.HTTP_200_OK,
        )


def get_admin_reauth_ttl_seconds():
    return max(60, min(int(getattr(settings, "PPM_ADMIN_REAUTH_TTL_SECONDS", 600)), 3_600))


def get_admin_reauth_expiry(request):
    raw_value = request.session.get(ADMIN_REAUTH_SESSION_KEY)
    if not isinstance(raw_value, (int, float)):
        return None
    authenticated_at = datetime.fromtimestamp(raw_value, tz=timezone.get_current_timezone())
    expires_at = authenticated_at + timedelta(seconds=get_admin_reauth_ttl_seconds())
    if expires_at <= timezone.now():
        request.session.pop(ADMIN_REAUTH_SESSION_KEY, None)
        return None
    return expires_at
