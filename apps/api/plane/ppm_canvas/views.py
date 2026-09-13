import logging

from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication

from .permissions import PpmCanvasAccess, get_ppm_canvas_access
from .responses import get_request_id, ppm_error_response
from .serializers import PpmCanvasSaveSerializer
from .services import PpmCanvasConflict, get_canvas_payload, get_or_create_active_canvas, save_canvas_snapshot


logger = logging.getLogger("plane.api")


class PpmCanvasView(APIView):
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
        return super().handle_exception(exc)

    def get(self, request, workspace_id, project_id):
        access = get_ppm_canvas_access(
            user=request.user,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        if access == PpmCanvasAccess.DENY:
            logger.warning(
                "PPM Canvas read denied",
                extra={
                    "workspace_id": str(workspace_id),
                    "project_id": str(project_id),
                    "user_id": str(request.user.id),
                },
            )
            return ppm_error_response(
                request,
                code="CANVAS_PERMISSION_DENIED",
                message="Нет доступа к холсту этого проекта.",
                status_code=status.HTTP_403_FORBIDDEN,
            )

        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        return Response(get_canvas_payload(canvas=canvas, access=access), status=status.HTTP_200_OK)

    def put(self, request, workspace_id, project_id):
        access = get_ppm_canvas_access(
            user=request.user,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        if access != PpmCanvasAccess.EDIT:
            logger.warning(
                "PPM Canvas write denied",
                extra={
                    "workspace_id": str(workspace_id),
                    "project_id": str(project_id),
                    "user_id": str(request.user.id),
                },
            )
            return ppm_error_response(
                request,
                code="CANVAS_WRITE_FORBIDDEN",
                message="Недостаточно прав для изменения холста.",
                status_code=status.HTTP_403_FORBIDDEN,
            )

        serializer = PpmCanvasSaveSerializer(data=request.data)
        if not serializer.is_valid():
            return ppm_error_response(
                request,
                code="CANVAS_INVALID_SNAPSHOT",
                message="Снимок холста не прошёл проверку.",
                status_code=status.HTTP_400_BAD_REQUEST,
                details=serializer.errors,
            )

        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        request_id = get_request_id(request)
        try:
            locked_canvas, saved_version, idempotent_replay = save_canvas_snapshot(
                canvas=canvas,
                user_id=request.user.id,
                request_id=request_id,
                **serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            logger.info(
                "PPM Canvas save conflict",
                extra={
                    "code": conflict.code,
                    "workspace_id": str(workspace_id),
                    "project_id": str(project_id),
                    "user_id": str(request.user.id),
                },
            )
            return ppm_error_response(
                request,
                code=conflict.code,
                message=conflict.message,
                status_code=status.HTTP_409_CONFLICT,
                details=conflict.details,
            )

        logger.info(
            "PPM Canvas saved",
            extra={
                "canvas_id": str(locked_canvas.id),
                "version": saved_version.version,
                "content_hash": saved_version.content_hash,
                "user_id": str(request.user.id),
                "request_id": str(request_id),
                "idempotent_replay": idempotent_replay,
            },
        )
        return Response(
            {
                "canvas_id": str(locked_canvas.id),
                "version": saved_version.version,
                "content_hash": saved_version.content_hash,
                "saved_at": saved_version.created_at.isoformat(),
                "saved_by": str(saved_version.created_by),
                "request_id": str(request_id),
                "idempotent_replay": idempotent_replay,
            },
            status=status.HTTP_200_OK,
        )
