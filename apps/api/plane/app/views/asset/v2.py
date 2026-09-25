# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import uuid

# Django imports
from django.conf import settings
from django.http import FileResponse, HttpResponseRedirect
from django.utils import timezone
from django.db import IntegrityError
from django.db.models import Q

# Third party imports
from rest_framework import status
from rest_framework.response import Response
from rest_framework.permissions import AllowAny

# Module imports
from ..base import BaseAPIView
from plane.db.models import (
    DraftIssue,
    FileAsset,
    Issue,
    IssueComment,
    Page,
    ProjectPage,
    Workspace,
    Project,
    User,
    WorkspaceMember,
)
from plane.settings.storage import S3Storage
from plane.app.permissions import allow_permission, ROLE
from plane.utils.cache import invalidate_cache_directly
from plane.utils.path_validator import sanitize_filename
from plane.bgtasks.storage_metadata_task import get_asset_object_metadata
from plane.throttles.asset import AssetRateThrottle
from plane.ppm_core.permissions import PpmProjectAccess, get_ppm_project_access, is_ppm_global_admin
from plane.utils.asset_upload import (
    local_asset_path as _ppm_local_asset_path,
    local_asset_root as _ppm_local_asset_root,
    upload_confirmation_error,
)


def _ppm_can_read_workspace_asset(user, asset):
    if asset.workspace_id is None:
        return False
    if asset.project_id is not None:
        return (
            get_ppm_project_access(user=user, workspace_id=asset.workspace_id, project_id=asset.project_id)
            != PpmProjectAccess.DENY
        )
    return (
        is_ppm_global_admin(user=user, workspace_id=asset.workspace_id)
        or WorkspaceMember.objects.filter(
            workspace_id=asset.workspace_id, member=user, is_active=True, deleted_at__isnull=True
        ).exists()
    )


def _ppm_can_write_workspace_asset(user, asset):
    if asset.workspace_id is None:
        return False
    if is_ppm_global_admin(user=user, workspace_id=asset.workspace_id):
        return True
    if asset.project_id is not None:
        return (
            get_ppm_project_access(user=user, workspace_id=asset.workspace_id, project_id=asset.project_id)
            == PpmProjectAccess.EDIT
        )

    role = (
        WorkspaceMember.objects.filter(
            workspace_id=asset.workspace_id, member=user, is_active=True, deleted_at__isnull=True
        )
        .values_list("role", flat=True)
        .first()
    )
    if asset.entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
        return False
    if asset.entity_type == FileAsset.EntityTypeContext.WORKSPACE_LOGO:
        return role == ROLE.ADMIN.value
    if asset.entity_type in (FileAsset.EntityTypeContext.USER_AVATAR, FileAsset.EntityTypeContext.USER_COVER):
        return role in (ROLE.ADMIN.value, ROLE.MEMBER.value) and asset.user_id == user.id
    return role in (ROLE.ADMIN.value, ROLE.MEMBER.value)


def _ppm_asset_entity_project(workspace_id, entity_type, entity_id, project_id=None):
    """Resolve a linked entity to its real project before binding an asset.

    ``None`` means the upload is still staged and has no entity. ``False`` means
    the supplied identifier does not name an entity in this workspace.
    """
    project_model = {
        FileAsset.EntityTypeContext.ISSUE_ATTACHMENT: Issue,
        FileAsset.EntityTypeContext.ISSUE_DESCRIPTION: Issue,
        FileAsset.EntityTypeContext.COMMENT_DESCRIPTION: IssueComment,
        FileAsset.EntityTypeContext.DRAFT_ISSUE_ATTACHMENT: DraftIssue,
        FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION: DraftIssue,
    }.get(entity_type)
    if project_model is None and entity_type != FileAsset.EntityTypeContext.PAGE_DESCRIPTION:
        return None
    if entity_id in (None, "", False):
        return None
    try:
        entity_id = uuid.UUID(str(entity_id))
    except (TypeError, ValueError, AttributeError):
        return False
    if project_model is not None:
        entity = (
            project_model.objects.filter(id=entity_id, workspace_id=workspace_id, deleted_at__isnull=True)
            .values_list("project_id", flat=True)
            .first()
        )
        if entity is None:
            # Drafts may legitimately have no project yet; verify existence separately.
            if (
                project_model is DraftIssue
                and project_model.objects.filter(
                    id=entity_id, workspace_id=workspace_id, deleted_at__isnull=True
                ).exists()
            ):
                return None
            return False
        return entity

    if not Page.objects.filter(id=entity_id, workspace_id=workspace_id, deleted_at__isnull=True).exists():
        return False
    project_ids = list(
        ProjectPage.objects.filter(page_id=entity_id, workspace_id=workspace_id, deleted_at__isnull=True)
        .values_list("project_id", flat=True)
        .distinct()
    )
    if project_id:
        return uuid.UUID(str(project_id)) if str(project_id) in {str(value) for value in project_ids} else False
    if len(project_ids) > 1:
        # A workspace-scoped upload cannot be safely attributed to several projects.
        return False
    return project_ids[0] if project_ids else None


def _ppm_asset_size(raw_size, uploaded_file):
    if uploaded_file is not None:
        return getattr(uploaded_file, "size", None)
    if isinstance(raw_size, bool):
        return None
    try:
        return int(settings.FILE_SIZE_LIMIT if raw_size in (None, "") else raw_size)
    except (TypeError, ValueError):
        return None


def _ppm_image_mime_type(header):
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def _save_ppm_local_asset(uploaded_file, asset_key, expected_type):
    root = _ppm_local_asset_root()
    root.mkdir(parents=True, exist_ok=True)
    destination = (root / asset_key).resolve()
    if root not in destination.parents:
        raise ValueError("Unsafe local asset path.")
    size = 0
    header = b""
    created = False
    try:
        with destination.open("xb") as output:
            created = True
            for chunk in uploaded_file.chunks():
                size += len(chunk)
                if size > settings.FILE_SIZE_LIMIT:
                    raise ValueError("Image size exceeds the configured limit.")
                header += chunk[: max(0, 12 - len(header))]
                output.write(chunk)
            if size == 0 or _ppm_image_mime_type(header) != expected_type.replace("image/jpg", "image/jpeg"):
                raise ValueError("Image content does not match its declared type.")
    except Exception:
        if created:
            destination.unlink(missing_ok=True)
        raise
    return destination, size


def _ppm_upload_confirmation_error(asset):
    return upload_confirmation_error(asset, storage_factory=S3Storage)


class UserAssetsV2Endpoint(BaseAPIView):
    """This endpoint is used to upload user profile images."""

    def asset_delete(self, asset_id):
        asset = FileAsset.objects.filter(id=asset_id).first()
        if asset is None:
            return
        asset.is_deleted = True
        asset.deleted_at = timezone.now()
        asset.save(update_fields=["is_deleted", "deleted_at"])
        return

    def entity_asset_save(self, asset_id, entity_type, asset, request):
        # User Avatar
        if entity_type == FileAsset.EntityTypeContext.USER_AVATAR:
            user = User.objects.get(id=asset.user_id)
            user.avatar = ""
            # Delete the previous avatar
            if user.avatar_asset_id:
                self.asset_delete(user.avatar_asset_id)
            # Save the new avatar
            user.avatar_asset_id = asset_id
            user.save()
            invalidate_cache_directly(path="/api/users/me/", url_params=False, user=True, request=request)
            invalidate_cache_directly(
                path="/api/users/me/settings/",
                url_params=False,
                user=True,
                request=request,
            )
            return
        # User Cover
        if entity_type == FileAsset.EntityTypeContext.USER_COVER:
            user = User.objects.get(id=asset.user_id)
            user.cover_image = None
            # Delete the previous cover image
            if user.cover_image_asset_id:
                self.asset_delete(user.cover_image_asset_id)
            # Save the new cover image
            user.cover_image_asset_id = asset_id
            user.save()
            invalidate_cache_directly(path="/api/users/me/", url_params=False, user=True, request=request)
            invalidate_cache_directly(
                path="/api/users/me/settings/",
                url_params=False,
                user=True,
                request=request,
            )
            return
        return

    def entity_asset_delete(self, entity_type, asset, request):
        # User Avatar
        if entity_type == FileAsset.EntityTypeContext.USER_AVATAR:
            user = User.objects.get(id=asset.user_id)
            user.avatar_asset_id = None
            user.save()
            invalidate_cache_directly(path="/api/users/me/", url_params=False, user=True, request=request)
            invalidate_cache_directly(
                path="/api/users/me/settings/",
                url_params=False,
                user=True,
                request=request,
            )
            return
        # User Cover
        if entity_type == FileAsset.EntityTypeContext.USER_COVER:
            user = User.objects.get(id=asset.user_id)
            user.cover_image_asset_id = None
            user.save()
            invalidate_cache_directly(path="/api/users/me/", url_params=False, user=True, request=request)
            invalidate_cache_directly(
                path="/api/users/me/settings/",
                url_params=False,
                user=True,
                request=request,
            )
            return
        return

    def post(self, request):
        # get the asset key
        uploaded_file = request.FILES.get("file")
        name = sanitize_filename(request.data.get("name") or getattr(uploaded_file, "name", None)) or "unnamed"
        type = request.data.get("type") or getattr(uploaded_file, "content_type", None) or "image/jpeg"
        size = _ppm_asset_size(request.data.get("size"), uploaded_file)
        entity_type = request.data.get("entity_type", False)

        # Check if the file size is within the limit
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0 or size > settings.FILE_SIZE_LIMIT:
            return Response(
                {"error": "The image size exceeds the configured limit or is invalid.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )
        size_limit = size

        #  Check if the entity type is allowed
        if not entity_type or entity_type not in ["USER_AVATAR", "USER_COVER"]:
            return Response(
                {"error": "Invalid entity type.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Check if the file type is allowed
        allowed_types = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/jpg",
            "image/gif",
        ]
        if type not in allowed_types:
            return Response(
                {
                    "error": "Invalid file type. Only JPEG, PNG, WebP, JPG and GIF files are allowed.",
                    "status": False,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # asset key
        asset_key = f"{uuid.uuid4().hex}-{name}"

        if uploaded_file is not None:
            if not getattr(settings, "PPM_LOCAL_ASSET_UPLOADS", False):
                return Response(
                    {"error": "Local asset uploads are disabled.", "status": False},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                destination, size = _save_ppm_local_asset(uploaded_file, asset_key, type)
            except ValueError:
                return Response(
                    {"error": "Invalid image content or size.", "status": False},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            asset = FileAsset.objects.create(
                attributes={"name": name, "type": type, "size": size},
                asset=f"ppm-local-assets/{asset_key}",
                size=size,
                user=request.user,
                created_by=request.user,
                entity_type=entity_type,
                is_uploaded=True,
                storage_metadata={"ppm_local_path": str(destination)},
            )
            self.entity_asset_save(
                asset_id=asset.id,
                entity_type=entity_type,
                asset=asset,
                request=request,
            )
            return Response(
                {
                    "upload_data": {"url": "", "fields": {}},
                    "asset_id": str(asset.id),
                    "asset_url": asset.asset_url,
                },
                status=status.HTTP_201_CREATED,
            )

        # Create a File Asset
        asset = FileAsset.objects.create(
            attributes={"name": name, "type": type, "size": size_limit},
            asset=asset_key,
            size=size_limit,
            user=request.user,
            created_by=request.user,
            entity_type=entity_type,
        )

        # Get the presigned URL
        storage = S3Storage(request=request)
        # Generate a presigned URL to share an S3 object
        presigned_url = storage.generate_presigned_post(object_name=asset_key, file_type=type, file_size=size_limit)
        if presigned_url is None:
            asset.delete()
            return Response({"error": "Upload storage is unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        # Return the presigned URL
        return Response(
            {
                "upload_data": presigned_url,
                "asset_id": str(asset.id),
                "asset_url": asset.asset_url,
            },
            status=status.HTTP_200_OK,
        )

    def patch(self, request, asset_id):
        # get the asset id
        asset = FileAsset.objects.get(id=asset_id, user_id=request.user.id)
        if (upload_error := _ppm_upload_confirmation_error(asset)) is not None:
            return upload_error
        # get the storage metadata
        asset.is_uploaded = True
        # get the storage metadata
        if not asset.storage_metadata:
            get_asset_object_metadata.delay(asset_id=str(asset_id))
        # get the entity and save the asset id for the request field
        self.entity_asset_save(
            asset_id=asset_id,
            entity_type=asset.entity_type,
            asset=asset,
            request=request,
        )
        # update the attributes
        asset.attributes = request.data.get("attributes", asset.attributes)
        # save the asset
        asset.save(update_fields=["is_uploaded", "attributes"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    def delete(self, request, asset_id):
        asset = FileAsset.objects.get(id=asset_id, user_id=request.user.id)
        local_path = _ppm_local_asset_path(asset)
        if local_path and local_path.is_file():
            local_path.unlink()
        asset.is_deleted = True
        asset.deleted_at = timezone.now()
        # get the entity and save the asset id for the request field
        self.entity_asset_delete(entity_type=asset.entity_type, asset=asset, request=request)
        asset.save(update_fields=["is_deleted", "deleted_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceFileAssetEndpoint(BaseAPIView):
    """This endpoint is used to upload cover images/logos etc for workspace, projects and users."""

    def get_entity_id_field(self, entity_type, entity_id):
        # Workspace Logo
        if entity_type == FileAsset.EntityTypeContext.WORKSPACE_LOGO:
            # The workspace-scoped endpoint already sets workspace from its URL.
            return {}

        # Project Cover
        if entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
            return {"project_id": entity_id}

        # User Avatar and Cover
        if entity_type in [
            FileAsset.EntityTypeContext.USER_AVATAR,
            FileAsset.EntityTypeContext.USER_COVER,
        ]:
            return {"user_id": entity_id}

        # Issue Attachment and Description
        if entity_type in [
            FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
            FileAsset.EntityTypeContext.ISSUE_DESCRIPTION,
        ]:
            return {"issue_id": entity_id}

        # Page Description
        if entity_type == FileAsset.EntityTypeContext.PAGE_DESCRIPTION:
            return {"page_id": entity_id}

        # Comment Description
        if entity_type == FileAsset.EntityTypeContext.COMMENT_DESCRIPTION:
            return {"comment_id": entity_id}
        if entity_type in (
            FileAsset.EntityTypeContext.DRAFT_ISSUE_ATTACHMENT,
            FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION,
        ):
            return {"draft_issue_id": entity_id}
        return {}

    def asset_delete(self, asset_id):
        asset = FileAsset.objects.filter(id=asset_id).first()
        # Check if the asset exists
        if asset is None:
            return
        # Mark the asset as deleted
        asset.is_deleted = True
        asset.deleted_at = timezone.now()
        asset.save(update_fields=["is_deleted", "deleted_at"])
        return

    def entity_asset_save(self, asset_id, entity_type, asset, request):
        # Workspace Logo
        if entity_type == FileAsset.EntityTypeContext.WORKSPACE_LOGO:
            workspace = Workspace.objects.filter(id=asset.workspace_id).first()
            if workspace is None:
                return
            # Delete the previous logo
            if workspace.logo_asset_id:
                self.asset_delete(workspace.logo_asset_id)
            # Save the new logo
            workspace.logo = ""
            workspace.logo_asset_id = asset_id
            workspace.save()
            invalidate_cache_directly(path="/api/workspaces/", url_params=False, user=False, request=request)
            invalidate_cache_directly(
                path="/api/users/me/workspaces/",
                url_params=False,
                user=True,
                request=request,
            )
            invalidate_cache_directly(path="/api/instances/", url_params=False, user=False, request=request)
            return

        # Project Cover
        elif entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
            project = Project.objects.filter(id=asset.project_id).first()
            if project is None:
                return
            # Delete the previous cover image
            if project.cover_image_asset_id:
                self.asset_delete(project.cover_image_asset_id)
            # Save the new cover image
            project.cover_image = ""
            project.cover_image_asset_id = asset_id
            project.save()
            return
        else:
            return

    def entity_asset_delete(self, entity_type, asset, request):
        # Workspace Logo
        if entity_type == FileAsset.EntityTypeContext.WORKSPACE_LOGO:
            workspace = Workspace.objects.get(id=asset.workspace_id)
            if workspace is None:
                return
            workspace.logo_asset_id = None
            workspace.save()
            invalidate_cache_directly(path="/api/workspaces/", url_params=False, user=False, request=request)
            invalidate_cache_directly(
                path="/api/users/me/workspaces/",
                url_params=False,
                user=True,
                request=request,
            )
            invalidate_cache_directly(path="/api/instances/", url_params=False, user=False, request=request)
            return
        # Project Cover
        elif entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
            project = Project.objects.filter(id=asset.project_id).first()
            if project is None:
                return
            project.cover_image_asset_id = None
            project.save()
            return
        else:
            return

    def has_project_asset_access(self, request, asset):
        """Read access follows current project membership, not workspace membership alone."""
        return _ppm_can_read_workspace_asset(request.user, asset)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug):
        uploaded_file = request.FILES.get("file")
        name = sanitize_filename(request.data.get("name") or getattr(uploaded_file, "name", None)) or "unnamed"
        type = request.data.get("type") or getattr(uploaded_file, "content_type", None) or "image/jpeg"
        size = _ppm_asset_size(request.data.get("size"), uploaded_file)
        entity_type = request.data.get("entity_type")
        entity_identifier = request.data.get("entity_identifier", False)

        if isinstance(size, bool) or not isinstance(size, int) or size <= 0 or size > settings.FILE_SIZE_LIMIT:
            return Response(
                {"error": "The image size exceeds the configured limit or is invalid.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Check if the entity type is allowed
        if entity_type not in FileAsset.EntityTypeContext.values:
            return Response(
                {"error": "Invalid entity type.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # WORKSPACE_LOGO may only be uploaded by workspace admins
        if entity_type == FileAsset.EntityTypeContext.WORKSPACE_LOGO:
            workspace_member = WorkspaceMember.objects.filter(
                workspace__slug=slug, member=request.user, is_active=True
            ).first()
            if (not workspace_member or workspace_member.role != ROLE.ADMIN.value) and not is_ppm_global_admin(
                user=request.user, workspace_slug=slug
            ):
                return Response(
                    {"error": "Only workspace admins can upload a workspace logo."},
                    status=status.HTTP_403_FORBIDDEN,
                )

        # Check if the file type is allowed
        allowed_types = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/jpg",
            "image/gif",
        ]
        if type not in allowed_types:
            return Response(
                {
                    "error": "Invalid file type. Only JPEG, PNG, WebP, JPG and GIF files are allowed.",
                    "status": False,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Get the size limit
        size_limit = size

        # Get the workspace
        workspace = Workspace.objects.get(slug=slug)
        entity_project_id = _ppm_asset_entity_project(workspace.id, entity_type, entity_identifier)
        if entity_project_id is False:
            return Response({"error": "Entity not found in this workspace."}, status=status.HTTP_404_NOT_FOUND)
        entity_fields = self.get_entity_id_field(entity_type=entity_type, entity_id=entity_identifier)
        if entity_project_id is not None:
            entity_fields["project_id"] = entity_project_id

        # asset key
        asset_key = f"{workspace.id}/{uuid.uuid4().hex}-{name}"

        if uploaded_file is not None:
            if not getattr(settings, "PPM_LOCAL_ASSET_UPLOADS", False):
                return Response(
                    {"error": "Local asset uploads are disabled.", "status": False},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                destination, size = _save_ppm_local_asset(uploaded_file, asset_key.replace("/", "-"), type)
            except ValueError:
                return Response(
                    {"error": "Invalid image content or size.", "status": False},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            asset = FileAsset.objects.create(
                attributes={"name": name, "type": type, "size": size},
                asset=f"ppm-local-assets/{destination.name}",
                size=size,
                workspace=workspace,
                created_by=request.user,
                entity_type=entity_type,
                is_uploaded=True,
                storage_metadata={"ppm_local_path": str(destination)},
                **entity_fields,
            )
            if not _ppm_can_write_workspace_asset(request.user, asset):
                destination.unlink(missing_ok=True)
                asset.delete()
                return Response(
                    {"error": "You don't have access to this project."},
                    status=status.HTTP_403_FORBIDDEN,
                )
            self.entity_asset_save(
                asset_id=asset.id,
                entity_type=entity_type,
                asset=asset,
                request=request,
            )
            return Response(
                {
                    "upload_data": {"url": "", "fields": {}},
                    "asset_id": str(asset.id),
                    "asset_url": asset.asset_url,
                },
                status=status.HTTP_201_CREATED,
            )

        # Create a File Asset
        asset = FileAsset.objects.create(
            attributes={"name": name, "type": type, "size": size_limit},
            asset=asset_key,
            size=size_limit,
            workspace=workspace,
            created_by=request.user,
            entity_type=entity_type,
            **entity_fields,
        )
        if not _ppm_can_write_workspace_asset(request.user, asset):
            asset.delete()
            return Response(
                {"error": "You don't have access to this project."},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Get the presigned URL
        storage = S3Storage(request=request)
        # Generate a presigned URL to share an S3 object
        presigned_url = storage.generate_presigned_post(object_name=asset_key, file_type=type, file_size=size_limit)
        if presigned_url is None:
            asset.delete()
            return Response({"error": "Upload storage is unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        # Return the presigned URL
        return Response(
            {
                "upload_data": presigned_url,
                "asset_id": str(asset.id),
                "asset_url": asset.asset_url,
            },
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def patch(self, request, slug, asset_id):
        # get the asset id
        asset = FileAsset.objects.get(id=asset_id, workspace__slug=slug)
        if not _ppm_can_write_workspace_asset(request.user, asset):
            return Response(
                {"error": "You don't have access to this asset."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if (upload_error := _ppm_upload_confirmation_error(asset)) is not None:
            return upload_error
        # get the storage metadata
        asset.is_uploaded = True
        # get the storage metadata
        if not asset.storage_metadata:
            get_asset_object_metadata.delay(asset_id=str(asset_id))
        # get the entity and save the asset id for the request field
        self.entity_asset_save(
            asset_id=asset_id,
            entity_type=asset.entity_type,
            asset=asset,
            request=request,
        )
        # update the attributes
        asset.attributes = request.data.get("attributes", asset.attributes)
        # save the asset
        asset.save(update_fields=["is_uploaded", "attributes"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def delete(self, request, slug, asset_id):
        asset = FileAsset.objects.get(id=asset_id, workspace__slug=slug)
        if not _ppm_can_write_workspace_asset(request.user, asset):
            return Response(
                {"error": "You don't have access to this asset."},
                status=status.HTTP_403_FORBIDDEN,
            )
        local_path = _ppm_local_asset_path(asset)
        if local_path and local_path.is_file():
            local_path.unlink()
        asset.is_deleted = True
        asset.deleted_at = timezone.now()
        # get the entity and save the asset id for the request field
        self.entity_asset_delete(entity_type=asset.entity_type, asset=asset, request=request)
        asset.save(update_fields=["is_deleted", "deleted_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, asset_id):
        # get the asset id
        asset = FileAsset.objects.get(id=asset_id, workspace__slug=slug)
        # enforce project-level access for project-bound assets
        if not self.has_project_asset_access(request, asset):
            return Response(
                {"error": "You don't have access to this asset."},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Check if the asset is uploaded
        if not asset.is_uploaded:
            return Response(
                {"error": "The requested asset could not be found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        local_path = _ppm_local_asset_path(asset)
        if local_path is not None:
            if not local_path.is_file():
                return Response(
                    {"error": "The requested asset could not be found."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            asset_mime_type = (asset.attributes.get("type") or "application/octet-stream").split(";")[0].strip()
            return FileResponse(local_path.open("rb"), content_type=asset_mime_type)

        # Get the presigned URL
        storage = S3Storage(request=request)
        # Generate a presigned URL to share an S3 object
        signed_url = storage.generate_presigned_url(
            object_name=asset.asset.name,
            disposition="attachment",
            filename=asset.attributes.get("name"),
        )
        # Redirect to the signed URL
        if not signed_url:
            return Response(
                {"error": "File storage is temporarily unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        return HttpResponseRedirect(signed_url)


class StaticFileAssetEndpoint(BaseAPIView):
    """This endpoint is used to get the signed URL for a static asset."""

    permission_classes = [AllowAny]

    def get(self, request, asset_id):
        # get the asset id
        asset = FileAsset.objects.get(id=asset_id)

        # Check if the asset is uploaded
        if not asset.is_uploaded:
            return Response(
                {"error": "The requested asset could not be found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Check if the entity type is allowed
        if asset.entity_type not in [
            FileAsset.EntityTypeContext.USER_AVATAR,
            FileAsset.EntityTypeContext.USER_COVER,
            FileAsset.EntityTypeContext.WORKSPACE_LOGO,
            FileAsset.EntityTypeContext.PROJECT_COVER,
        ]:
            return Response(
                {"error": "Invalid entity type.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )

        local_path = _ppm_local_asset_path(asset)
        if local_path is not None:
            if not local_path.is_file():
                return Response(
                    {"error": "The requested asset could not be found."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            asset_mime_type = (asset.attributes.get("type") or "application/octet-stream").split(";")[0].strip()
            return FileResponse(local_path.open("rb"), content_type=asset_mime_type)

        # Get the presigned URL.
        # Force attachment disposition for script-capable MIME types to prevent
        # same-origin XSS when assets are served on the application's origin.
        storage = S3Storage(request=request)
        asset_mime_type = (asset.attributes.get("type") or "").split(";")[0].strip().lower()
        disposition = "attachment" if asset_mime_type in settings.SCRIPT_CAPABLE_MIME_TYPES else "inline"
        # Generate a presigned URL to share an S3 object
        signed_url = storage.generate_presigned_url(
            object_name=asset.asset.name,
            disposition=disposition,
        )
        # Redirect to the signed URL
        if not signed_url:
            return Response(
                {"error": "File storage is temporarily unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        return HttpResponseRedirect(signed_url)


class AssetRestoreEndpoint(BaseAPIView):
    """Endpoint to restore a deleted assets."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug, asset_id):
        asset = FileAsset.all_objects.get(id=asset_id, workspace__slug=slug)
        if not _ppm_can_write_workspace_asset(request.user, asset):
            return Response({"error": "You don't have access to this asset."}, status=status.HTTP_403_FORBIDDEN)
        asset.is_deleted = False
        asset.deleted_at = None
        asset.save(update_fields=["is_deleted", "deleted_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectAssetEndpoint(BaseAPIView):
    """This endpoint is used to upload cover images/logos etc for workspace, projects and users."""

    def get_entity_id_field(self, entity_type, entity_id):
        if entity_type == FileAsset.EntityTypeContext.WORKSPACE_LOGO:
            return {"workspace_id": entity_id}

        if entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
            # The project-scoped endpoint already sets project_id from its URL.
            return {}

        if entity_type in [
            FileAsset.EntityTypeContext.USER_AVATAR,
            FileAsset.EntityTypeContext.USER_COVER,
        ]:
            return {"user_id": entity_id}

        if entity_type in [
            FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
            FileAsset.EntityTypeContext.ISSUE_DESCRIPTION,
        ]:
            return {"issue_id": entity_id}

        if entity_type == FileAsset.EntityTypeContext.PAGE_DESCRIPTION:
            return {"page_id": entity_id}

        if entity_type == FileAsset.EntityTypeContext.COMMENT_DESCRIPTION:
            return {"comment_id": entity_id}

        if entity_type in (
            FileAsset.EntityTypeContext.DRAFT_ISSUE_ATTACHMENT,
            FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION,
        ):
            return {"draft_issue_id": entity_id}
        return {}

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def post(self, request, slug, project_id):
        name = sanitize_filename(request.data.get("name")) or "unnamed"
        type = request.data.get("type", "image/jpeg")
        size = _ppm_asset_size(request.data.get("size"), None)
        entity_type = request.data.get("entity_type", "")
        entity_identifier = request.data.get("entity_identifier")

        if isinstance(size, bool) or not isinstance(size, int) or size <= 0 or size > settings.FILE_SIZE_LIMIT:
            return Response(
                {"error": "The image size exceeds the configured limit or is invalid.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Check if the entity type is allowed
        if entity_type not in FileAsset.EntityTypeContext.values:
            return Response(
                {"error": "Invalid entity type.", "status": False},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Check if the file type is allowed
        allowed_types = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/jpg",
            "image/gif",
        ]
        if type not in allowed_types:
            return Response(
                {
                    "error": "Invalid file type. Only JPEG, PNG, WebP, JPG and GIF files are allowed.",
                    "status": False,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Get the size limit
        size_limit = size

        # Get the workspace
        workspace = Workspace.objects.get(slug=slug)
        entity_project_id = _ppm_asset_entity_project(workspace.id, entity_type, entity_identifier, project_id)
        if entity_project_id is False or (entity_project_id is not None and str(entity_project_id) != str(project_id)):
            return Response({"error": "Entity not found in this project."}, status=status.HTTP_404_NOT_FOUND)

        # asset key
        asset_key = f"{workspace.id}/{uuid.uuid4().hex}-{name}"

        # Create a File Asset
        asset = FileAsset.objects.create(
            attributes={"name": name, "type": type, "size": size_limit},
            asset=asset_key,
            size=size_limit,
            workspace=workspace,
            created_by=request.user,
            entity_type=entity_type,
            project_id=project_id,
            **self.get_entity_id_field(entity_type, entity_identifier),
        )

        # Get the presigned URL
        storage = S3Storage(request=request)
        # Generate a presigned URL to share an S3 object
        presigned_url = storage.generate_presigned_post(object_name=asset_key, file_type=type, file_size=size_limit)
        if presigned_url is None:
            asset.delete()
            return Response({"error": "Upload storage is unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        # Return the presigned URL
        return Response(
            {
                "upload_data": presigned_url,
                "asset_id": str(asset.id),
                "asset_url": asset.asset_url,
            },
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def patch(self, request, slug, project_id, pk):
        # get the asset id
        asset = FileAsset.objects.get(id=pk, workspace__slug=slug, project_id=project_id)
        if (upload_error := _ppm_upload_confirmation_error(asset)) is not None:
            return upload_error
        # get the storage metadata
        asset.is_uploaded = True
        # get the storage metadata
        if not asset.storage_metadata:
            get_asset_object_metadata.delay(asset_id=str(pk))

        # update the attributes
        asset.attributes = request.data.get("attributes", asset.attributes)
        # save the asset
        asset.save(update_fields=["is_uploaded", "attributes"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def delete(self, request, slug, project_id, pk):
        # Get the asset
        asset = FileAsset.objects.get(id=pk, workspace__slug=slug, project_id=project_id)
        # Check deleted assets
        asset.is_deleted = True
        asset.deleted_at = timezone.now()
        # Save the asset
        asset.save(update_fields=["is_deleted", "deleted_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id, pk):
        # get the asset id
        asset = FileAsset.objects.get(workspace__slug=slug, project_id=project_id, pk=pk)

        # Check if the asset is uploaded
        if not asset.is_uploaded:
            return Response(
                {"error": "The requested asset could not be found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Get the presigned URL
        storage = S3Storage(request=request)
        # Generate a presigned URL to share an S3 object
        signed_url = storage.generate_presigned_url(
            object_name=asset.asset.name,
            disposition="attachment",
            filename=asset.attributes.get("name"),
        )
        # Redirect to the signed URL
        if not signed_url:
            return Response(
                {"error": "File storage is temporarily unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        return HttpResponseRedirect(signed_url)


class ProjectBulkAssetEndpoint(BaseAPIView):
    def save_project_cover(self, asset, project_id):
        project = Project.objects.get(id=project_id)
        project.cover_image_asset_id = asset.id
        project.save()

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def post(self, request, slug, project_id, entity_id):
        asset_ids = request.data.get("asset_ids", [])

        # Check if the asset ids are provided
        if not asset_ids:
            return Response({"error": "No asset ids provided."}, status=status.HTTP_400_BAD_REQUEST)

        # Scope to the requester's own uploads in this workspace, limited to assets that are
        # either unassociated or already in this project. This endpoint *associates*
        # freshly-uploaded assets, which are not yet project-scoped (e.g. a cover uploaded
        # during project creation has project_id=NULL until this call sets it) — so the
        # earlier project_id=project_id filter 404'd that flow. created_by + the
        # unassociated-or-same-project bound prevent cross-project/user IDOR (a caller can
        # only touch their own uploads, cannot move an asset in from another project, and
        # @allow_permission already scopes them to this project).
        assets = FileAsset.objects.filter(
            id__in=asset_ids,
            workspace__slug=slug,
            created_by=request.user,
        ).filter(Q(project_id=project_id) | Q(project_id__isnull=True))

        # Get the first asset
        asset = assets.first()

        if not asset:
            return Response(
                {"error": "The requested asset could not be found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if assets.count() != len(set(asset_ids)) or assets.exclude(entity_type=asset.entity_type).exists():
            return Response(
                {"error": "Assets must belong to one entity type and project."}, status=status.HTTP_404_NOT_FOUND
            )
        if asset.entity_type in (
            FileAsset.EntityTypeContext.ISSUE_DESCRIPTION,
            FileAsset.EntityTypeContext.COMMENT_DESCRIPTION,
            FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
            FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION,
        ):
            entity_project_id = _ppm_asset_entity_project(asset.workspace_id, asset.entity_type, entity_id, project_id)
            if entity_project_id is False or (
                entity_project_id is not None and str(entity_project_id) != str(project_id)
            ):
                return Response({"error": "Entity not found in this project."}, status=status.HTTP_404_NOT_FOUND)

        # Check if the asset is uploaded
        if asset.entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
            assets.update(project_id=project_id)
            [self.save_project_cover(asset, project_id) for asset in assets]

        if asset.entity_type == FileAsset.EntityTypeContext.ISSUE_DESCRIPTION:
            # For some cases, the bulk api is called after the issue is deleted creating
            # an integrity error
            try:
                assets.update(issue_id=entity_id, project_id=project_id)
            except IntegrityError:
                pass

        if asset.entity_type == FileAsset.EntityTypeContext.COMMENT_DESCRIPTION:
            # For some cases, the bulk api is called after the comment is deleted
            # creating an integrity error
            try:
                assets.update(comment_id=entity_id, project_id=project_id)
            except IntegrityError:
                pass

        if asset.entity_type == FileAsset.EntityTypeContext.PAGE_DESCRIPTION:
            assets.update(page_id=entity_id, project_id=project_id)

        if asset.entity_type == FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION:
            # For some cases, the bulk api is called after the draft issue is deleted
            # creating an integrity error
            try:
                assets.update(draft_issue_id=entity_id, project_id=project_id)
            except IntegrityError:
                pass

        return Response(status=status.HTTP_204_NO_CONTENT)


class AssetCheckEndpoint(BaseAPIView):
    """Endpoint to check if an asset exists."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, asset_id):
        asset = FileAsset.all_objects.filter(id=asset_id, workspace__slug=slug, deleted_at__isnull=True).first()
        exists = asset is not None and _ppm_can_read_workspace_asset(request.user, asset)
        return Response({"exists": exists}, status=status.HTTP_200_OK)


class DuplicateAssetEndpoint(BaseAPIView):
    throttle_classes = [AssetRateThrottle]

    def get_entity_id_field(self, entity_type, entity_id):
        # Workspace Logo
        if entity_type == FileAsset.EntityTypeContext.WORKSPACE_LOGO:
            return {"workspace_id": entity_id}

        # Project Cover
        if entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
            return {}

        # User Avatar and Cover
        if entity_type in [
            FileAsset.EntityTypeContext.USER_AVATAR,
            FileAsset.EntityTypeContext.USER_COVER,
        ]:
            return {"user_id": entity_id}

        # Issue Attachment and Description
        if entity_type in [
            FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
            FileAsset.EntityTypeContext.ISSUE_DESCRIPTION,
        ]:
            return {"issue_id": entity_id}

        # Page Description
        if entity_type == FileAsset.EntityTypeContext.PAGE_DESCRIPTION:
            return {"page_id": entity_id}

        # Comment Description
        if entity_type == FileAsset.EntityTypeContext.COMMENT_DESCRIPTION:
            return {"comment_id": entity_id}

        if entity_type in (
            FileAsset.EntityTypeContext.DRAFT_ISSUE_ATTACHMENT,
            FileAsset.EntityTypeContext.DRAFT_ISSUE_DESCRIPTION,
        ):
            return {"draft_issue_id": entity_id}

        return {}

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def post(self, request, slug, asset_id):
        project_id = request.data.get("project_id", None)
        entity_id = request.data.get("entity_id", None)
        entity_type = request.data.get("entity_type", None)

        if not entity_type or entity_type not in FileAsset.EntityTypeContext.values:
            return Response(
                {"error": "Invalid entity type or entity id"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        workspace = Workspace.objects.get(slug=slug)
        if project_id:
            # check if project exists in the workspace
            if not Project.objects.filter(id=project_id, workspace=workspace).exists():
                return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        entity_project_id = _ppm_asset_entity_project(workspace.id, entity_type, entity_id, project_id)
        if entity_project_id is False or (
            entity_project_id is not None and project_id and str(entity_project_id) != str(project_id)
        ):
            return Response({"error": "Entity not found in this project."}, status=status.HTTP_404_NOT_FOUND)
        destination_project_id = project_id or entity_project_id
        if entity_type == FileAsset.EntityTypeContext.PROJECT_COVER:
            destination_project_id = project_id or entity_id
            if (
                not destination_project_id
                or (entity_id and project_id and str(entity_id) != str(project_id))
                or not Project.objects.filter(id=destination_project_id, workspace=workspace).exists()
            ):
                return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

        # Restrict the source asset to the same destination workspace to prevent cross-workspace asset copying
        original_asset = FileAsset.objects.filter(
            id=asset_id,
            is_uploaded=True,
            workspace=workspace,
        ).first()

        if not original_asset:
            return Response({"error": "Asset not found"}, status=status.HTTP_404_NOT_FOUND)
        if not _ppm_can_read_workspace_asset(request.user, original_asset):
            return Response({"error": "Asset not found"}, status=status.HTTP_404_NOT_FOUND)

        destination_scope = FileAsset(
            workspace=workspace,
            project_id=destination_project_id,
            entity_type=entity_type,
            user_id=entity_id
            if entity_type in (FileAsset.EntityTypeContext.USER_AVATAR, FileAsset.EntityTypeContext.USER_COVER)
            else None,
        )
        if not _ppm_can_write_workspace_asset(request.user, destination_scope):
            return Response({"error": "You don't have access to this asset."}, status=status.HTTP_403_FORBIDDEN)

        storage = S3Storage(request=request)
        sanitized_name = sanitize_filename(original_asset.attributes.get("name")) or "unnamed"
        destination_key = f"{workspace.id}/{uuid.uuid4().hex}-{sanitized_name}"
        duplicated_asset = FileAsset.objects.create(
            attributes={
                "name": original_asset.attributes.get("name"),
                "type": original_asset.attributes.get("type"),
                "size": original_asset.attributes.get("size"),
            },
            asset=destination_key,
            size=original_asset.size,
            workspace=workspace,
            created_by_id=request.user.id,
            entity_type=entity_type,
            project_id=destination_project_id,
            storage_metadata=original_asset.storage_metadata,
            **self.get_entity_id_field(entity_type=entity_type, entity_id=entity_id),
        )
        storage.copy_object(original_asset.asset, destination_key)
        # Update the is_uploaded field for all newly created assets
        FileAsset.objects.filter(id=duplicated_asset.id).update(is_uploaded=True)

        return Response({"asset_id": str(duplicated_asset.id)}, status=status.HTTP_200_OK)


class WorkspaceAssetDownloadEndpoint(BaseAPIView):
    """Endpoint to generate a download link for an asset with content-disposition=attachment."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug, asset_id):
        try:
            asset = FileAsset.objects.get(
                id=asset_id,
                workspace__slug=slug,
                is_uploaded=True,
            )
        except FileAsset.DoesNotExist:
            return Response(
                {"error": "The requested asset could not be found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if (
            asset.project_id is not None
            and get_ppm_project_access(
                user=request.user,
                workspace_id=asset.workspace_id,
                project_id=asset.project_id,
            )
            == PpmProjectAccess.DENY
        ):
            return Response({"error": "Project is not accessible."}, status=status.HTTP_403_FORBIDDEN)

        storage = S3Storage(request=request)
        signed_url = storage.generate_presigned_url(
            object_name=asset.asset.name,
            disposition="attachment",
            filename=asset.attributes.get("name", uuid.uuid4().hex),
        )

        if not signed_url:
            return Response(
                {"error": "File storage is temporarily unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        return HttpResponseRedirect(signed_url)


class ProjectAssetDownloadEndpoint(BaseAPIView):
    """Endpoint to generate a download link for an asset with content-disposition=attachment."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="PROJECT")
    def get(self, request, slug, project_id, asset_id):
        try:
            asset = FileAsset.objects.get(
                id=asset_id,
                workspace__slug=slug,
                project_id=project_id,
                is_uploaded=True,
            )
        except FileAsset.DoesNotExist:
            return Response(
                {"error": "The requested asset could not be found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        storage = S3Storage(request=request)
        signed_url = storage.generate_presigned_url(
            object_name=asset.asset.name,
            disposition="attachment",
            filename=asset.attributes.get("name", uuid.uuid4().hex),
        )

        if not signed_url:
            return Response(
                {"error": "File storage is temporarily unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        return HttpResponseRedirect(signed_url)
