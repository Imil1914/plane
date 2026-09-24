import json
import logging

from django.conf import settings
from django.core.serializers.json import DjangoJSONEncoder
from django.db import IntegrityError, transaction
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated, NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication
from plane.bgtasks.issue_activities_task import issue_activity
from plane.bgtasks.issue_description_version_task import issue_description_version_task
from plane.bgtasks.webhook_task import model_activity
from plane.utils.host import base_host

from .permissions import PpmCanvasAccess, get_ppm_canvas_access, get_ppm_canvas_capabilities
from .realtime import broadcast_canvas_board_changed
from .models import (
    PpmCanvasBindingStatus,
    PpmCanvasEntityType,
    PpmCanvasSemanticEdge,
    PpmGlobalAdmin,
    PpmGlobalAdminAudit,
    PpmSemanticEdgeConfirmationStatus,
)
from .responses import get_request_id, ppm_error_response
from .serializers import (
    PpmCanvasBindingCreateSerializer,
    PpmCanvasBoardCreateSerializer,
    PpmCanvasBoardDuplicateSerializer,
    PpmCanvasBoardOperationSerializer,
    PpmCanvasBoardPatchSerializer,
    PpmCanvasBoardReorderSerializer,
    PpmCanvasSaveSerializer,
    PpmCanvasSemanticEdgeCreateSerializer,
    PpmCanvasSemanticEdgePatchSerializer,
    PpmProjectionSearchSerializer,
    PpmWorkItemCreateSerializer,
    PpmWorkItemPatchSerializer,
    PpmWorkItemsViewQuerySerializer,
    PpmWorkItemViewCreateSerializer,
)
from .services import (
    PpmCanvasConflict,
    PpmProjectionConflict,
    archive_canvas_board,
    create_canvas_board,
    create_content_binding,
    create_git_binding,
    create_semantic_edge,
    create_work_item_and_binding,
    create_work_item_binding,
    create_work_item_from_view,
    duplicate_canvas_board,
    get_board_payload,
    get_board_version_payload,
    get_board_versions_payload,
    get_canvas_board,
    get_canvas_bindings_payload,
    get_canvas_boards_payload,
    get_canvas_payload,
    get_or_create_default_board,
    get_or_create_active_canvas,
    get_project,
    get_content_source,
    get_git_source,
    get_work_item_edit_options,
    get_work_item,
    get_work_items_view,
    rename_canvas_board,
    reorder_canvas_boards,
    restore_canvas_board,
    save_canvas_snapshot,
    search_work_items,
    serialize_board,
    serialize_binding,
    serialize_content_source,
    serialize_git_source,
    serialize_semantic_edge,
    serialize_work_item,
    export_work_items_csv,
    export_work_items_markdown,
    update_work_item,
)


logger = logging.getLogger("plane.api")


class PpmSessionAPIView(APIView):
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

    def require_project_access(self, request, workspace_id, project_id, *, edit=False):
        access = get_ppm_canvas_access(user=request.user, workspace_id=workspace_id, project_id=project_id)
        if access == PpmCanvasAccess.DENY or (edit and access != PpmCanvasAccess.EDIT):
            logger.warning(
                "PPM project access denied",
                extra={
                    "workspace_id": str(workspace_id),
                    "project_id": str(project_id),
                    "user_id": str(request.user.id),
                    "edit": edit,
                },
            )
            code = "CANVAS_WRITE_FORBIDDEN" if edit else "CANVAS_PERMISSION_DENIED"
            message = "Недостаточно прав для изменения холста." if edit else "Нет доступа к холсту этого проекта."
            return (
                None,
                None,
                ppm_error_response(
                    request,
                    code=code,
                    message=message,
                    status_code=status.HTTP_403_FORBIDDEN,
                ),
            )
        project = get_project(workspace_id=workspace_id, project_id=project_id)
        if project is None:
            return (
                None,
                None,
                ppm_error_response(
                    request,
                    code="PROJECT_NOT_FOUND",
                    message="Проект не найден.",
                    status_code=status.HTTP_404_NOT_FOUND,
                ),
            )
        global_admin = PpmGlobalAdmin.objects.filter(user=request.user, revoked_at__isnull=True).first()
        if global_admin:
            PpmGlobalAdminAudit.objects.create(
                global_admin=global_admin,
                action="project_api_access",
                workspace_id=workspace_id,
                project_id=project_id,
                method=request.method,
                path=request.path[:500],
                request_id=get_request_id(request),
            )
        return access, project, None

    def require_canvas_capability(self, request, workspace_id, project_id, capability):
        access, project, denied = self.require_project_access(
            request,
            workspace_id,
            project_id,
            edit=capability != "read",
        )
        if denied:
            return None, None, None, denied
        capabilities = get_ppm_canvas_capabilities(
            user=request.user,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        if not capabilities.get(capability, False):
            return (
                None,
                None,
                None,
                ppm_error_response(
                    request,
                    code="CANVAS_CAPABILITY_FORBIDDEN",
                    message="Недостаточно прав для этого действия с доской.",
                    status_code=status.HTTP_403_FORBIDDEN,
                    details={"capability": capability},
                ),
            )
        return access, project, capabilities, None

    def resolve_board(self, request, canvas, board_id, *, include_archived=False):
        board = get_canvas_board(canvas=canvas, board_id=board_id, include_archived=include_archived)
        if board is None:
            return (
                None,
                ppm_error_response(
                    request,
                    code="CANVAS_BOARD_NOT_FOUND",
                    message="Доска не найдена в этом проекте.",
                    status_code=status.HTTP_404_NOT_FOUND,
                ),
            )
        return board, None

    def invalid_payload(self, request, serializer, *, code):
        return ppm_error_response(
            request,
            code=code,
            message="Данные запроса не прошли проверку.",
            status_code=status.HTTP_400_BAD_REQUEST,
            details=serializer.errors,
        )

    def projection_conflict_response(self, request, conflict):
        status_code = (
            status.HTTP_404_NOT_FOUND
            if conflict.code in {"WORK_ITEM_NOT_FOUND", "CONTENT_SOURCE_NOT_FOUND", "GIT_SOURCE_NOT_FOUND"}
            else status.HTTP_409_CONFLICT
        )
        return ppm_error_response(
            request,
            code=conflict.code,
            message=conflict.message,
            status_code=status_code,
            details=conflict.details,
        )

    def canvas_conflict_response(self, request, conflict):
        return ppm_error_response(
            request,
            code=conflict.code,
            message=conflict.message,
            status_code=status.HTTP_409_CONFLICT,
            details=conflict.details,
        )


class PpmMultiBoardAPIView(PpmSessionAPIView):
    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if not getattr(settings, "PPM_CANVAS_MULTIBOARD_ENABLED", True):
            raise NotFound("Многодосочный режим Canvas временно отключён.")


class PpmCanvasView(PpmSessionAPIView):
    def get(self, request, workspace_id, project_id):
        access, _, denied = self.require_project_access(request, workspace_id, project_id)
        if denied:
            return denied

        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        capabilities = get_ppm_canvas_capabilities(
            user=request.user,
            workspace_id=workspace_id,
            project_id=project_id,
        )
        return Response(
            {
                **get_canvas_payload(
                    canvas=canvas,
                    access=access,
                    user=request.user,
                    capabilities=capabilities,
                ),
                "feature_flags": {
                    "multi_board": getattr(settings, "PPM_CANVAS_MULTIBOARD_ENABLED", True),
                },
            },
            status=status.HTTP_200_OK,
        )

    def put(self, request, workspace_id, project_id):
        _, _, denied = self.require_project_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied

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
        board = get_or_create_default_board(canvas=canvas, user_id=request.user.id)
        request_id = get_request_id(request)
        try:
            locked_board, saved_version, idempotent_replay = save_canvas_snapshot(
                board=board,
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
                "canvas_id": str(locked_board.canvas_id),
                "board_id": str(locked_board.id),
                "version": saved_version.version,
                "content_hash": saved_version.content_hash,
                "user_id": str(request.user.id),
                "request_id": str(request_id),
                "idempotent_replay": idempotent_replay,
            },
        )
        if not idempotent_replay:
            transaction.on_commit(
                lambda: broadcast_canvas_board_changed(
                    project_id=project_id,
                    board_id=locked_board.id,
                    version=saved_version.version,
                    content_hash=saved_version.content_hash,
                    saved_at=saved_version.created_at,
                    saved_by=saved_version.created_by,
                    client_operation_id=saved_version.client_operation_id,
                )
            )
        return Response(
            {
                "canvas_id": str(locked_board.canvas_id),
                "board_id": str(locked_board.id),
                "version": saved_version.version,
                "content_hash": saved_version.content_hash,
                "saved_at": saved_version.created_at.isoformat(),
                "saved_by": str(saved_version.created_by),
                "request_id": str(request_id),
                "idempotent_replay": idempotent_replay,
            },
            status=status.HTTP_200_OK,
        )


class PpmCanvasBoardListCreateView(PpmMultiBoardAPIView):
    def get(self, request, workspace_id, project_id):
        access, _, capabilities, denied = self.require_canvas_capability(request, workspace_id, project_id, "read")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        include_archived = request.query_params.get("include_archived") == "true"
        if include_archived and not capabilities["manage_canvas"]:
            return ppm_error_response(
                request,
                code="CANVAS_CAPABILITY_FORBIDDEN",
                message="Архив досок доступен только руководителю проекта или глобальному администратору.",
                status_code=status.HTTP_403_FORBIDDEN,
                details={"capability": "manage_canvas"},
            )
        return Response(
            {
                "canvas_id": str(canvas.id),
                "default_board_id": str(canvas.default_board_id),
                "boards": get_canvas_boards_payload(canvas=canvas, include_archived=include_archived),
                "access": access.value,
                "capabilities": capabilities,
            },
            status=status.HTTP_200_OK,
        )

    def post(self, request, workspace_id, project_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "create_board")
        if denied:
            return denied
        serializer = PpmCanvasBoardCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_BOARD_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        try:
            board, replay = create_canvas_board(
                canvas=canvas,
                user_id=request.user.id,
                **serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        return Response(
            {**serialize_board(board), "idempotent_replay": replay},
            status=status.HTTP_200_OK if replay else status.HTTP_201_CREATED,
        )


class PpmCanvasBoardReorderView(PpmMultiBoardAPIView):
    def post(self, request, workspace_id, project_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "reorder_boards")
        if denied:
            return denied
        serializer = PpmCanvasBoardReorderSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_BOARD_ORDER_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        try:
            boards, replay = reorder_canvas_boards(
                canvas=canvas,
                user_id=request.user.id,
                **serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        return Response({"boards": boards, "idempotent_replay": replay}, status=status.HTTP_200_OK)


class PpmCanvasBoardDetailView(PpmMultiBoardAPIView):
    def get(self, request, workspace_id, project_id, board_id):
        access, _, capabilities, denied = self.require_canvas_capability(request, workspace_id, project_id, "read")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        payload = get_board_payload(board=board, access=access, user=request.user)
        payload["capabilities"] = capabilities
        return Response(payload, status=status.HTTP_200_OK)

    def patch(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "rename_board")
        if denied:
            return denied
        serializer = PpmCanvasBoardPatchSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_BOARD_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        try:
            board, replay = rename_canvas_board(board=board, user_id=request.user.id, **serializer.validated_data)
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        return Response({**serialize_board(board), "idempotent_replay": replay}, status=status.HTTP_200_OK)


class PpmCanvasBoardSnapshotView(PpmMultiBoardAPIView):
    def put(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "edit")
        if denied:
            return denied
        serializer = PpmCanvasSaveSerializer(data=request.data)
        if not serializer.is_valid():
            return ppm_error_response(
                request,
                code="CANVAS_INVALID_SNAPSHOT",
                message="Снимок доски не прошёл проверку.",
                status_code=status.HTTP_400_BAD_REQUEST,
                details=serializer.errors,
            )
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        request_id = get_request_id(request)
        try:
            locked_board, saved_version, replay = save_canvas_snapshot(
                board=board,
                user_id=request.user.id,
                request_id=request_id,
                **serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        if not replay:
            transaction.on_commit(
                lambda: broadcast_canvas_board_changed(
                    project_id=project_id,
                    board_id=locked_board.id,
                    version=saved_version.version,
                    content_hash=saved_version.content_hash,
                    saved_at=saved_version.created_at,
                    saved_by=saved_version.created_by,
                    client_operation_id=saved_version.client_operation_id,
                )
            )
        return Response(
            {
                "canvas_id": str(locked_board.canvas_id),
                "board_id": str(locked_board.id),
                "version": saved_version.version,
                "content_hash": saved_version.content_hash,
                "saved_at": saved_version.created_at.isoformat(),
                "saved_by": str(saved_version.created_by),
                "request_id": str(request_id),
                "idempotent_replay": replay,
            },
            status=status.HTTP_200_OK,
        )


class PpmCanvasBoardDuplicateView(PpmMultiBoardAPIView):
    def post(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "duplicate_board")
        if denied:
            return denied
        serializer = PpmCanvasBoardDuplicateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_BOARD_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        try:
            duplicate, replay = duplicate_canvas_board(
                board=board,
                user_id=request.user.id,
                request_id=get_request_id(request),
                **serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        return Response(
            {**serialize_board(duplicate), "idempotent_replay": replay},
            status=status.HTTP_200_OK if replay else status.HTTP_201_CREATED,
        )


class PpmCanvasBoardArchiveView(PpmMultiBoardAPIView):
    def post(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "archive_board")
        if denied:
            return denied
        serializer = PpmCanvasBoardOperationSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_BOARD_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id, include_archived=True)
        if missing:
            return missing
        try:
            archived, replay = archive_canvas_board(
                board=board,
                user_id=request.user.id,
                **serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        return Response({**serialize_board(archived), "idempotent_replay": replay}, status=status.HTTP_200_OK)


class PpmCanvasBoardRestoreView(PpmMultiBoardAPIView):
    def post(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "restore_board")
        if denied:
            return denied
        serializer = PpmCanvasBoardOperationSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_BOARD_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id, include_archived=True)
        if missing:
            return missing
        try:
            restored, replay = restore_canvas_board(
                board=board,
                user_id=request.user.id,
                **serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        return Response({**serialize_board(restored), "idempotent_replay": replay}, status=status.HTTP_200_OK)


class PpmCanvasBoardVersionListView(PpmMultiBoardAPIView):
    def get(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "read")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        return Response({"versions": get_board_versions_payload(board=board)}, status=status.HTTP_200_OK)


class PpmCanvasBoardVersionDetailView(PpmMultiBoardAPIView):
    def get(self, request, workspace_id, project_id, board_id, version):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "read")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        payload = get_board_version_payload(board=board, version=version)
        if payload is None:
            return ppm_error_response(
                request,
                code="CANVAS_VERSION_NOT_FOUND",
                message="Версия доски не найдена.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return Response(payload, status=status.HTTP_200_OK)


class PpmCanvasSemanticEdgeListCreateView(PpmMultiBoardAPIView):
    def get(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "read")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        return Response(
            {"semantic_edges": [serialize_semantic_edge(edge) for edge in board.semantic_edges.all()]},
            status=status.HTTP_200_OK,
        )

    def post(self, request, workspace_id, project_id, board_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "edit")
        if denied:
            return denied
        serializer = PpmCanvasSemanticEdgeCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_EDGE_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        try:
            edge, replay = create_semantic_edge(
                board=board,
                user_id=request.user.id,
                validated_data=serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        return Response(
            {**serialize_semantic_edge(edge), "idempotent_replay": replay},
            status=status.HTTP_200_OK if replay else status.HTTP_201_CREATED,
        )


class PpmCanvasSemanticEdgeDetailView(PpmMultiBoardAPIView):
    def patch(self, request, workspace_id, project_id, board_id, edge_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "edit")
        if denied:
            return denied
        serializer = PpmCanvasSemanticEdgePatchSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="CANVAS_EDGE_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        edge = PpmCanvasSemanticEdge.objects.filter(id=edge_id, board=board, canvas=canvas).first()
        if edge is None:
            return ppm_error_response(
                request,
                code="CANVAS_EDGE_NOT_FOUND",
                message="Смысловая связь не найдена на этой доске.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        confirmation_status = serializer.validated_data.get("confirmation_status")
        if confirmation_status and edge.confirmation_status != PpmSemanticEdgeConfirmationStatus.PROPOSED:
            return ppm_error_response(
                request,
                code="CANVAS_EDGE_ALREADY_REVIEWED",
                message="Предложение связи уже рассмотрено.",
                status_code=status.HTTP_409_CONFLICT,
            )
        for field, value in serializer.validated_data.items():
            setattr(edge, field, value)
        update_fields = [*serializer.validated_data.keys(), "updated_at"]
        if confirmation_status:
            edge.confirmed_by = request.user.id
            edge.confirmed_at = timezone.now()
            update_fields.extend(["confirmed_by", "confirmed_at"])
        try:
            edge.save(update_fields=update_fields)
        except IntegrityError as error:
            logger.info(
                "PPM semantic edge update conflict", extra={"edge_id": str(edge.id), "error": type(error).__name__}
            )
            return ppm_error_response(
                request,
                code="CANVAS_EDGE_CONFLICT",
                message="Такая смысловая связь уже существует.",
                status_code=status.HTTP_409_CONFLICT,
            )
        return Response(serialize_semantic_edge(edge), status=status.HTTP_200_OK)

    def delete(self, request, workspace_id, project_id, board_id, edge_id):
        _, _, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "edit")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        deleted, _ = PpmCanvasSemanticEdge.objects.filter(id=edge_id, board=board, canvas=canvas).delete()
        if not deleted:
            return ppm_error_response(
                request,
                code="CANVAS_EDGE_NOT_FOUND",
                message="Смысловая связь не найдена на этой доске.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class PpmProjectionSearchView(PpmSessionAPIView):
    def get(self, request, workspace_id, project_id):
        access, project, denied = self.require_project_access(request, workspace_id, project_id)
        if denied:
            return denied
        serializer = PpmProjectionSearchSerializer(data=request.query_params)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="PROJECTION_SEARCH_INVALID")
        work_items, next_cursor = search_work_items(
            project=project,
            user=request.user,
            query=serializer.validated_data["q"],
            cursor=serializer.validated_data["cursor"],
            limit=serializer.validated_data["limit"],
        )
        return Response(
            {
                "results": [serialize_work_item(issue=issue, access=access) for issue in work_items],
                "next_cursor": next_cursor,
            },
            status=status.HTTP_200_OK,
        )


class PpmProjectionDetailView(PpmSessionAPIView):
    def get(self, request, workspace_id, project_id, entity_type, entity_id):
        access, project, denied = self.require_project_access(request, workspace_id, project_id)
        if denied:
            return denied
        if entity_type == PpmCanvasEntityType.WORK_ITEM:
            issue = get_work_item(project=project, user=request.user, entity_id=entity_id)
            if issue is None:
                return ppm_error_response(
                    request,
                    code="WORK_ITEM_NOT_FOUND",
                    message="Задача не найдена в текущем проекте.",
                    status_code=status.HTTP_404_NOT_FOUND,
                )
            return Response(serialize_work_item(issue=issue, access=access), status=status.HTTP_200_OK)
        if entity_type in {
            PpmCanvasEntityType.REPOSITORY,
            PpmCanvasEntityType.BRANCH,
            PpmCanvasEntityType.COMMIT,
            PpmCanvasEntityType.PULL_REQUEST,
        }:
            source = get_git_source(
                project=project,
                entity_type=entity_type,
                entity_id=entity_id,
            )
            if source is None:
                return ppm_error_response(
                    request,
                    code="GIT_SOURCE_NOT_FOUND",
                    message="Git-объект не найден в текущем проекте или недоступен.",
                    status_code=status.HTTP_404_NOT_FOUND,
                )
            return Response(
                serialize_git_source(source=source, entity_type=entity_type, project=project),
                status=status.HTTP_200_OK,
            )
        if entity_type not in {
            PpmCanvasEntityType.PAGE,
            PpmCanvasEntityType.ATTACHMENT,
            PpmCanvasEntityType.VAULT_FILE,
        }:
            return ppm_error_response(
                request,
                code="PROJECTION_TYPE_UNSUPPORTED",
                message="Этот тип проекции пока не поддерживается.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        source = get_content_source(
            project=project,
            user=request.user,
            entity_type=entity_type,
            entity_id=entity_id,
        )
        if source is None:
            return ppm_error_response(
                request,
                code="CONTENT_SOURCE_NOT_FOUND",
                message="Материал не найден в текущем проекте или недоступен.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return Response(
            serialize_content_source(
                source=source,
                entity_type=entity_type,
                project=project,
                access=access,
            ),
            status=status.HTTP_200_OK,
        )


class PpmCanvasBindingListCreateView(PpmSessionAPIView):
    def get(self, request, workspace_id, project_id, board_id=None):
        access, _, denied = self.require_project_access(request, workspace_id, project_id)
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        if board_id:
            board, missing = self.resolve_board(request, canvas, board_id)
            if missing:
                return missing
        else:
            board = get_or_create_default_board(canvas=canvas, user_id=request.user.id)
        return Response(
            {
                "board_id": str(board.id),
                "bindings": get_canvas_bindings_payload(board=board, access=access, user=request.user),
                "work_item_options": get_work_item_edit_options(
                    workspace_id=workspace_id,
                    project_id=project_id,
                ),
            },
            status=status.HTTP_200_OK,
        )

    def post(self, request, workspace_id, project_id, board_id=None):
        access, project, denied = self.require_project_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        serializer = PpmCanvasBindingCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="BINDING_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        if board_id:
            board, missing = self.resolve_board(request, canvas, board_id)
            if missing:
                return missing
        else:
            board = get_or_create_default_board(canvas=canvas, user_id=request.user.id)
        try:
            entity_type = serializer.validated_data["entity_type"]
            if entity_type == PpmCanvasEntityType.WORK_ITEM:
                create_binding = create_work_item_binding
            elif entity_type in {
                PpmCanvasEntityType.REPOSITORY,
                PpmCanvasEntityType.BRANCH,
                PpmCanvasEntityType.COMMIT,
                PpmCanvasEntityType.PULL_REQUEST,
            }:
                create_binding = create_git_binding
            else:
                create_binding = create_content_binding
            binding, replay = create_binding(
                board=board,
                project=project,
                user=request.user,
                shape_id=serializer.validated_data["shape_id"],
                entity_id=serializer.validated_data["entity_id"],
                client_operation_id=serializer.validated_data["client_operation_id"],
                **(
                    {"entity_type": entity_type}
                    if create_binding in {create_content_binding, create_git_binding}
                    else {}
                ),
            )
        except PpmProjectionConflict as conflict:
            return self.projection_conflict_response(request, conflict)
        logger.info(
            "PPM Canvas projection bound",
            extra={
                "binding_id": str(binding.id),
                "entity_id": str(binding.entity_id),
                "project_id": str(project.id),
                "user_id": str(request.user.id),
                "idempotent_replay": replay,
            },
        )
        return Response(
            {
                **serialize_binding(binding=binding, access=access, user=request.user, project=project),
                "idempotent_replay": replay,
            },
            status=status.HTTP_200_OK if replay else status.HTTP_201_CREATED,
        )


class PpmCanvasBindingDetailView(PpmSessionAPIView):
    def delete(self, request, workspace_id, project_id, binding_id, board_id=None):
        _, _, denied = self.require_project_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        if board_id:
            board, missing = self.resolve_board(request, canvas, board_id)
            if missing:
                return missing
        else:
            board = get_or_create_default_board(canvas=canvas, user_id=request.user.id)
        with transaction.atomic():
            binding = (
                board.bindings.select_for_update()
                .filter(
                    id=binding_id,
                    workspace_id=workspace_id,
                    project_id=project_id,
                )
                .first()
            )
            if binding is None:
                return ppm_error_response(
                    request,
                    code="BINDING_NOT_FOUND",
                    message="Проекция не найдена на холсте этого проекта.",
                    status_code=status.HTTP_404_NOT_FOUND,
                )
            if binding.status == PpmCanvasBindingStatus.ACTIVE:
                return ppm_error_response(
                    request,
                    code="BINDING_ACTIVE_REQUIRES_CANVAS_SAVE",
                    message="Активную проекцию нужно удалить вместе с новой версией холста.",
                    status_code=status.HTTP_409_CONFLICT,
                    details={"binding_id": str(binding.id)},
                )
            audit = {
                "binding_id": str(binding.id),
                "entity_type": binding.entity_type,
                "entity_id": str(binding.entity_id),
                "shape_id": binding.shape_id,
                "project_id": str(project_id),
                "user_id": str(request.user.id),
            }
            binding.delete()
        logger.info("PPM Canvas projection removed without deleting source", extra=audit)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PpmWorkItemListCreateView(PpmSessionAPIView):
    def post(self, request, workspace_id, project_id, board_id=None):
        access, project, denied = self.require_project_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        serializer = PpmWorkItemCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="WORK_ITEM_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        if board_id:
            board, missing = self.resolve_board(request, canvas, board_id)
            if missing:
                return missing
        else:
            board = get_or_create_default_board(canvas=canvas, user_id=request.user.id)
        try:
            issue, binding, replay = create_work_item_and_binding(
                board=board,
                project=project,
                user=request.user,
                validated_data=serializer.validated_data,
            )
        except PpmProjectionConflict as conflict:
            return self.projection_conflict_response(request, conflict)
        except ValidationError as validation_error:
            return ppm_error_response(
                request,
                code="WORK_ITEM_INVALID",
                message="PPM отклонил данные задачи.",
                status_code=status.HTTP_400_BAD_REQUEST,
                details=validation_error.detail,
            )
        if not replay:
            plane_data = _plane_issue_request_data(serializer.validated_data)
            _track_issue_create(request=request, project=project, issue=issue, plane_data=plane_data)
        logger.info(
            "PPM Canvas work item created and bound",
            extra={
                "binding_id": str(binding.id),
                "issue_id": str(issue.id),
                "project_id": str(project.id),
                "user_id": str(request.user.id),
                "idempotent_replay": replay,
            },
        )
        return Response(
            {
                **serialize_binding(binding=binding, access=access, user=request.user, project=project),
                "idempotent_replay": replay,
            },
            status=status.HTTP_200_OK if replay else status.HTTP_201_CREATED,
        )


class PpmWorkItemDetailView(PpmSessionAPIView):
    def patch(self, request, workspace_id, project_id, entity_id):
        access, project, denied = self.require_project_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        serializer = PpmWorkItemPatchSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="WORK_ITEM_INVALID")
        before = get_work_item(project=project, user=request.user, entity_id=entity_id)
        current_instance = _plane_issue_audit_data(before) if before else None
        try:
            issue = update_work_item(
                project=project,
                user=request.user,
                entity_id=entity_id,
                validated_data=serializer.validated_data,
            )
        except PpmProjectionConflict as conflict:
            return self.projection_conflict_response(request, conflict)
        except ValidationError as validation_error:
            return ppm_error_response(
                request,
                code="WORK_ITEM_INVALID",
                message="PPM отклонил изменение задачи.",
                status_code=status.HTTP_400_BAD_REQUEST,
                details=validation_error.detail,
            )
        plane_data = _plane_issue_request_data(serializer.validated_data)
        _track_issue_update(
            request=request,
            project=project,
            issue=issue,
            plane_data=plane_data,
            current_instance=current_instance,
        )
        return Response(serialize_work_item(issue=issue, access=access), status=status.HTTP_200_OK)


class PpmCanvasWorkItemsView(PpmMultiBoardAPIView):
    def get(self, request, workspace_id, project_id, board_id):
        access, project, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "read")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        _, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        serializer = PpmWorkItemsViewQuerySerializer(data=request.query_params)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="WORK_ITEM_VIEW_INVALID")
        try:
            work_items, next_cursor, summary = get_work_items_view(
                project=project,
                user=request.user,
                filters=serializer.validated_data,
            )
        except PpmProjectionConflict as conflict:
            return self.projection_conflict_response(request, conflict)
        return Response(
            {
                "results": [serialize_work_item(issue=issue, access=access) for issue in work_items],
                "next_cursor": next_cursor,
                "summary": summary,
                "work_item_options": get_work_item_edit_options(
                    workspace_id=workspace_id,
                    project_id=project_id,
                ),
            },
            status=status.HTTP_200_OK,
        )

    def post(self, request, workspace_id, project_id, board_id):
        access, project, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "edit")
        if denied:
            return denied
        serializer = PpmWorkItemViewCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="WORK_ITEM_INVALID")
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        board, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        try:
            issue, replay = create_work_item_from_view(
                board=board,
                project=project,
                user=request.user,
                validated_data=serializer.validated_data,
            )
        except PpmCanvasConflict as conflict:
            return self.canvas_conflict_response(request, conflict)
        except PpmProjectionConflict as conflict:
            return self.projection_conflict_response(request, conflict)
        except ValidationError as validation_error:
            return ppm_error_response(
                request,
                code="WORK_ITEM_INVALID",
                message="PPM отклонил данные задачи.",
                status_code=status.HTTP_400_BAD_REQUEST,
                details=validation_error.detail,
            )
        if not replay:
            plane_data = _plane_issue_request_data(serializer.validated_data)
            _track_issue_create(request=request, project=project, issue=issue, plane_data=plane_data)
        payload = serialize_work_item(issue=issue, access=access)
        payload["idempotent_replay"] = replay
        return Response(payload, status=status.HTTP_200_OK if replay else status.HTTP_201_CREATED)


class PpmCanvasWorkItemsViewExport(PpmMultiBoardAPIView):
    def get(self, request, workspace_id, project_id, board_id, export_format):
        _, project, _, denied = self.require_canvas_capability(request, workspace_id, project_id, "read")
        if denied:
            return denied
        canvas = get_or_create_active_canvas(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        _, missing = self.resolve_board(request, canvas, board_id)
        if missing:
            return missing
        serializer = PpmWorkItemsViewQuerySerializer(data=request.query_params)
        if not serializer.is_valid():
            return self.invalid_payload(request, serializer, code="WORK_ITEM_VIEW_INVALID")
        try:
            if export_format == "csv":
                content = export_work_items_csv(
                    project=project,
                    user=request.user,
                    filters=serializer.validated_data,
                )
                content_type = "text/csv; charset=utf-8"
                extension = "csv"
            elif export_format == "markdown":
                content = export_work_items_markdown(
                    project=project,
                    user=request.user,
                    filters=serializer.validated_data,
                )
                content_type = "text/markdown; charset=utf-8"
                extension = "md"
            else:
                return ppm_error_response(
                    request,
                    code="WORK_ITEM_EXPORT_UNSUPPORTED",
                    message="Этот формат экспорта не поддерживается.",
                    status_code=status.HTTP_404_NOT_FOUND,
                )
        except PpmProjectionConflict as conflict:
            return self.projection_conflict_response(request, conflict)
        filename = f"ppm-{project.identifier.lower()}-work-items.{extension}"
        response = HttpResponse(content, content_type=content_type)
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


def _plane_issue_request_data(validated_data):
    data = {}
    for field in ("name", "priority"):
        if field in validated_data:
            data[field] = validated_data[field]
    if "state_id" in validated_data:
        data["state_id"] = str(validated_data["state_id"])
    if "assignee_ids" in validated_data:
        data["assignee_ids"] = [str(assignee_id) for assignee_id in validated_data["assignee_ids"]]
    if "due_date" in validated_data:
        due_date = validated_data["due_date"]
        data["target_date"] = due_date.isoformat() if due_date else None
    return data


def _plane_issue_audit_data(issue):
    if issue is None:
        return None
    return {
        "id": str(issue.id),
        "name": issue.name,
        "state_id": str(issue.state_id) if issue.state_id else None,
        "priority": issue.priority,
        "target_date": issue.target_date,
        "assignee_ids": [str(assignee_id) for assignee_id in issue.assignees.values_list("id", flat=True)],
    }


def _track_issue_create(*, request, project, issue, plane_data):
    requested_data = json.dumps(plane_data, cls=DjangoJSONEncoder)
    issue_activity.delay(
        type="issue.activity.created",
        requested_data=requested_data,
        actor_id=str(request.user.id),
        issue_id=str(issue.id),
        project_id=str(project.id),
        current_instance=None,
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=base_host(request=request, is_app=True),
    )
    model_activity.delay(
        model_name="issue",
        model_id=str(issue.id),
        requested_data=plane_data,
        current_instance=None,
        actor_id=request.user.id,
        slug=project.workspace.slug,
        origin=base_host(request=request, is_app=True),
    )
    issue_description_version_task.delay(
        updated_issue=requested_data,
        issue_id=str(issue.id),
        user_id=request.user.id,
        is_creating=True,
    )


def _track_issue_update(*, request, project, issue, plane_data, current_instance):
    current_json = json.dumps(current_instance, cls=DjangoJSONEncoder)
    requested_json = json.dumps(plane_data, cls=DjangoJSONEncoder)
    issue_activity.delay(
        type="issue.activity.updated",
        requested_data=requested_json,
        actor_id=str(request.user.id),
        issue_id=str(issue.id),
        project_id=str(project.id),
        current_instance=current_json,
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=base_host(request=request, is_app=True),
    )
    model_activity.delay(
        model_name="issue",
        model_id=str(issue.id),
        requested_data=plane_data,
        current_instance=current_json,
        actor_id=request.user.id,
        slug=project.workspace.slug,
        origin=base_host(request=request, is_app=True),
    )
