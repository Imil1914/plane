# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser

# Module imports
from ..base import BaseAPIView, BaseViewSet
from plane.app.permissions import WorkspaceMemberPermission
from plane.db.models import FileAsset, Workspace
from plane.app.serializers import FileAssetSerializer
from .v2 import _ppm_asset_entity_project, _ppm_can_read_workspace_asset, _ppm_can_write_workspace_asset


class FileAssetEndpoint(BaseAPIView):
    parser_classes = (MultiPartParser, FormParser, JSONParser)
    permission_classes = [IsAuthenticated, WorkspaceMemberPermission]

    """
    A viewset for viewing and editing task instances.
    """

    def get(self, request, workspace_id, asset_key):
        asset_key = str(workspace_id) + "/" + asset_key
        files = list(FileAsset.objects.filter(asset=asset_key, workspace_id=workspace_id))
        readable_files = [asset for asset in files if _ppm_can_read_workspace_asset(request.user, asset)]
        if readable_files:
            serializer = FileAssetSerializer(readable_files, context={"request": request}, many=True)
            return Response({"data": serializer.data, "status": True}, status=status.HTTP_200_OK)
        if files:
            return Response({"error": "You don't have access to this asset."}, status=status.HTTP_403_FORBIDDEN)
        else:
            return Response(
                {"error": "Asset key does not exist", "status": False},
                status=status.HTTP_200_OK,
            )

    def post(self, request, slug):
        # WorkspaceMemberPermission already rejects unknown slugs before this runs.
        # Use .get() so any TOCTOU race still surfaces as a 404 via ObjectDoesNotExist.
        workspace = Workspace.objects.get(slug=slug)
        serializer = FileAssetSerializer(data=request.data)
        if serializer.is_valid():
            submitted_project = serializer.validated_data.get("project")
            if submitted_project and submitted_project.workspace_id != workspace.id:
                return Response({"error": "Project not found in this workspace."}, status=status.HTTP_404_NOT_FOUND)
            linked_entities = [
                (name, serializer.validated_data[name])
                for name in ("issue", "comment", "page", "draft_issue")
                if serializer.validated_data.get(name)
            ]
            if len(linked_entities) > 1:
                return Response({"error": "An asset cannot belong to multiple entities."}, status=400)
            entity_type = {
                "issue": FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
                "comment": FileAsset.EntityTypeContext.COMMENT_DESCRIPTION,
                "page": FileAsset.EntityTypeContext.PAGE_DESCRIPTION,
                "draft_issue": FileAsset.EntityTypeContext.DRAFT_ISSUE_ATTACHMENT,
            }
            entity_project_id = _ppm_asset_entity_project(
                workspace.id,
                entity_type[linked_entities[0][0]] if linked_entities else None,
                linked_entities[0][1].id if linked_entities else None,
                submitted_project.id if submitted_project else None,
            )
            if entity_project_id is False or (
                entity_project_id is not None
                and submitted_project is not None
                and entity_project_id != submitted_project.id
            ):
                return Response({"error": "Entity not found in this project."}, status=status.HTTP_404_NOT_FOUND)
            scope = FileAsset(
                workspace=workspace,
                project_id=entity_project_id or (submitted_project.id if submitted_project else None),
                user=serializer.validated_data.get("user"),
                entity_type=serializer.validated_data.get("entity_type"),
            )
            if not _ppm_can_write_workspace_asset(request.user, scope):
                return Response({"error": "You don't have access to this asset."}, status=status.HTTP_403_FORBIDDEN)
            serializer.save(workspace_id=workspace.id, project_id=scope.project_id)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, workspace_id, asset_key):
        asset_key = str(workspace_id) + "/" + asset_key
        file_asset = FileAsset.objects.get(asset=asset_key, workspace_id=workspace_id)
        if not _ppm_can_write_workspace_asset(request.user, file_asset):
            return Response({"error": "You don't have access to this asset."}, status=status.HTTP_403_FORBIDDEN)
        file_asset.is_deleted = True
        file_asset.save(update_fields=["is_deleted"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class FileAssetViewSet(BaseViewSet):
    permission_classes = [IsAuthenticated, WorkspaceMemberPermission]

    def restore(self, request, workspace_id, asset_key):
        asset_key = str(workspace_id) + "/" + asset_key
        file_asset = FileAsset.all_objects.get(asset=asset_key, workspace_id=workspace_id)
        if not _ppm_can_write_workspace_asset(request.user, file_asset):
            return Response({"error": "You don't have access to this asset."}, status=status.HTTP_403_FORBIDDEN)
        file_asset.is_deleted = False
        file_asset.save(update_fields=["is_deleted"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserAssetsEndpoint(BaseAPIView):
    parser_classes = (MultiPartParser, FormParser)

    def get(self, request, asset_key):
        files = FileAsset.objects.filter(asset=asset_key, created_by=request.user)
        if files.exists():
            serializer = FileAssetSerializer(files, context={"request": request})
            return Response({"data": serializer.data, "status": True}, status=status.HTTP_200_OK)
        else:
            return Response(
                {"error": "Asset key does not exist", "status": False},
                status=status.HTTP_200_OK,
            )

    def post(self, request):
        serializer = FileAssetSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def delete(self, request, asset_key):
        file_asset = FileAsset.objects.get(asset=asset_key, created_by=request.user)
        file_asset.is_deleted = True
        file_asset.save(update_fields=["is_deleted"])
        return Response(status=status.HTTP_204_NO_CONTENT)
