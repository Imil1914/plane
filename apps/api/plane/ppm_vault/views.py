from django.http import FileResponse, HttpResponseRedirect
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication
from plane.ppm_canvas.responses import ppm_error_response
from plane.ppm_core.permissions import PpmProjectAccess, get_ppm_project_access

from .models import (
    PpmVaultEntry,
    PpmVaultEntryKind,
    PpmVaultEntryStatus,
    PpmVaultIndexPolicy,
    PpmVaultLink,
    PpmVaultLinkStatus,
)
from .services import (
    ENTRY_PARENT_UNSET,
    PpmVaultConflict,
    create_folder,
    create_markdown,
    create_pdf,
    create_uploaded_file,
    get_or_create_project_vault,
    replace_uploaded_file,
    restore_entry_version,
    restore_trashed_entry,
    trash_entry,
    update_entry_metadata,
    update_markdown,
)
from .exporting import build_vault_export
from .links import entry_path, serialize_link
from .storage import open_private_object, private_object_url
from .transfers import (
    export_markdown_to_page,
    get_project_page,
    import_page_to_vault,
    list_project_pages,
    serialize_transfer,
)


def serialize_entry(entry, *, include_children=False):
    payload = {
        "id": str(entry.id),
        "parent_id": str(entry.parent_id) if entry.parent_id else None,
        "kind": entry.kind,
        "status": entry.status,
        "name": entry.name,
        "path": entry_path(entry),
        "extension": entry.extension or "",
        "mime_type": entry.mime_type or "",
        "size_bytes": entry.size_bytes,
        "content_hash": entry.content_hash or "",
        "version": entry.version,
        "index_policy": entry.index_policy,
        "created_at": entry.created_at.isoformat(),
        "updated_at": entry.updated_at.isoformat(),
    }
    if include_children:
        payload["children"] = [
            serialize_entry(child, include_children=True)
            for child in entry.children.filter(status=PpmVaultEntryStatus.ACTIVE)
        ]
    return payload


def error_status(code):
    if code in {"VAULT_ENTRY_NOT_FOUND", "VAULT_PARENT_NOT_FOUND", "VAULT_PAGE_NOT_FOUND", "VAULT_VERSION_NOT_FOUND"}:
        return status.HTTP_404_NOT_FOUND
    if code in {
        "VAULT_ENTRY_NOT_TRASHED",
        "VAULT_FOLDER_NOT_EMPTY",
        "VAULT_MOVE_CYCLE",
        "VAULT_NAME_CONFLICT",
        "VAULT_RESTORE_PARENT_MISSING",
        "VAULT_VERSION_CONFLICT",
    }:
        return status.HTTP_409_CONFLICT
    if code == "VAULT_STORAGE_FAILED":
        return status.HTTP_503_SERVICE_UNAVAILABLE
    return status.HTTP_400_BAD_REQUEST


class PpmVaultAPIView(APIView):
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
        if isinstance(exc, PpmVaultConflict):
            return ppm_error_response(
                self.request,
                code=exc.code,
                message=exc.message,
                status_code=error_status(exc.code),
                details=exc.details,
            )
        return super().handle_exception(exc)

    def require_access(self, request, workspace_id, project_id, *, edit=False):
        access = get_ppm_project_access(user=request.user, workspace_id=workspace_id, project_id=project_id)
        if access == PpmProjectAccess.DENY or (edit and access != PpmProjectAccess.EDIT):
            return (
                None,
                None,
                ppm_error_response(
                    request,
                    code="VAULT_WRITE_FORBIDDEN" if edit else "VAULT_PERMISSION_DENIED",
                    message="Недостаточно прав для изменения хранилища."
                    if edit
                    else "Нет доступа к хранилищу проекта.",
                    status_code=status.HTTP_403_FORBIDDEN,
                ),
            )
        vault = get_or_create_project_vault(
            workspace_id=workspace_id,
            project_id=project_id,
            user_id=request.user.id,
        )
        return access, vault, None

    def get_entry(self, *, vault, entry_id, kind=None):
        query = PpmVaultEntry.objects.filter(id=entry_id, vault=vault, status=PpmVaultEntryStatus.ACTIVE)
        if kind:
            query = query.filter(kind=kind)
        entry = query.first()
        if entry is None:
            raise PpmVaultConflict(code="VAULT_ENTRY_NOT_FOUND", message="Материал не найден.")
        return entry


class PpmVaultView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id):
        access, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        roots = vault.entries.filter(parent=vault.root_entry, status=PpmVaultEntryStatus.ACTIVE)
        return Response(
            {
                "vault_id": str(vault.id),
                "root_entry_id": str(vault.root_entry_id),
                "project_id": str(vault.project_id),
                "name": vault.name,
                "access": access.value,
                "index_policy_values": list(PpmVaultIndexPolicy.values),
                "entries": [serialize_entry(entry, include_children=True) for entry in roots],
            }
        )


class PpmVaultFolderCreateView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = create_folder(
            vault=vault,
            parent_id=request.data.get("parent_id"),
            name=request.data.get("name", ""),
            user_id=request.user.id,
        )
        return Response(serialize_entry(entry), status=status.HTTP_201_CREATED)


class PpmVaultMarkdownCreateView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = create_markdown(
            vault=vault,
            parent_id=request.data.get("parent_id"),
            name=request.data.get("name", ""),
            content=str(request.data.get("content", "")),
            user_id=request.user.id,
        )
        return Response(serialize_entry(entry), status=status.HTTP_201_CREATED)


class PpmVaultPdfUploadView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        uploaded_file = request.FILES.get("file")
        if uploaded_file is None:
            raise PpmVaultConflict(code="VAULT_FILE_REQUIRED", message="Выберите PDF-файл.")
        entry = create_pdf(
            vault=vault,
            parent_id=request.data.get("parent_id"),
            uploaded_file=uploaded_file,
            user_id=request.user.id,
        )
        return Response(serialize_entry(entry), status=status.HTTP_201_CREATED)


class PpmVaultFileUploadView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        uploaded_file = request.FILES.get("file")
        if uploaded_file is None:
            raise PpmVaultConflict(code="VAULT_FILE_REQUIRED", message="Выберите файл.")
        entry = create_uploaded_file(
            vault=vault,
            parent_id=request.data.get("parent_id"),
            uploaded_file=uploaded_file,
            user_id=request.user.id,
        )
        return Response(serialize_entry(entry), status=status.HTTP_201_CREATED)


class PpmVaultEntryView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id):
        access, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        payload = serialize_entry(entry)
        payload["access"] = access.value
        return Response(payload)

    def patch(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        if "index_policy" in request.data:
            policy = request.data.get("index_policy")
            if policy not in PpmVaultIndexPolicy.values:
                raise PpmVaultConflict(code="VAULT_INVALID_INDEX_POLICY", message="Неизвестная политика индексации.")
            entry.index_policy = policy
            entry.updated_by = request.user.id
            entry.save(update_fields=["index_policy", "updated_by", "updated_at"])
        if "name" in request.data or "parent_id" in request.data:
            entry = update_entry_metadata(
                entry=entry,
                name=request.data.get("name") if "name" in request.data else None,
                parent_id=request.data.get("parent_id") if "parent_id" in request.data else ENTRY_PARENT_UNSET,
                user_id=request.user.id,
            )
        return Response(serialize_entry(entry))

    def delete(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        trash_entry(entry=entry, user_id=request.user.id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PpmVaultMarkdownContentView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id):
        access, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id, kind=PpmVaultEntryKind.MARKDOWN)
        version = entry.versions.get(version=entry.version)
        return Response(
            {
                "entry": serialize_entry(entry),
                "content": version.content_text,
                "access": access.value,
            }
        )

    def put(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id, kind=PpmVaultEntryKind.MARKDOWN)
        try:
            base_version = int(request.data.get("base_version"))
        except (TypeError, ValueError):
            raise PpmVaultConflict(
                code="VAULT_BASE_VERSION_REQUIRED",
                message="Укажите версию, которую вы редактировали.",
            )
        entry = update_markdown(
            entry=entry,
            base_version=base_version,
            content=str(request.data.get("content", "")),
            user_id=request.user.id,
        )
        return Response(serialize_entry(entry))


class PpmVaultPdfContentView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id, kind=PpmVaultEntryKind.PDF)
        version = entry.versions.get(version=entry.version)
        signed_url = private_object_url(object_key=version.object_key, filename=entry.name)
        if signed_url:
            return HttpResponseRedirect(signed_url)
        file_obj = open_private_object(version.object_key)
        if file_obj is None:
            raise PpmVaultConflict(code="VAULT_STORAGE_FAILED", message="PDF-файл временно недоступен.")
        response = FileResponse(file_obj, content_type="application/pdf")
        response["Content-Disposition"] = f'inline; filename="{entry.id}.pdf"'
        response["Cache-Control"] = "private, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response


class PpmVaultFileContentView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        if entry.kind in {PpmVaultEntryKind.FOLDER, PpmVaultEntryKind.MARKDOWN}:
            raise PpmVaultConflict(code="VAULT_INVALID_FILE_TYPE", message="У материала нет бинарного файла.")
        version = entry.versions.get(version=entry.version)
        signed_url = private_object_url(object_key=version.object_key, filename=entry.name)
        if signed_url:
            return HttpResponseRedirect(signed_url)
        file_obj = open_private_object(version.object_key)
        if file_obj is None:
            raise PpmVaultConflict(code="VAULT_STORAGE_FAILED", message="Файл временно недоступен.")
        response = FileResponse(file_obj, content_type=entry.mime_type or "application/octet-stream")
        disposition = "inline" if entry.kind in {PpmVaultEntryKind.PDF, PpmVaultEntryKind.IMAGE} else "attachment"
        response["Content-Disposition"] = f'{disposition}; filename="{entry.id}.{entry.extension}"'
        response["Cache-Control"] = "private, no-store"
        response["Content-Security-Policy"] = "default-src 'none'; sandbox"
        response["X-Content-Type-Options"] = "nosniff"
        return response

    def put(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        if entry.kind in {PpmVaultEntryKind.FOLDER, PpmVaultEntryKind.MARKDOWN}:
            raise PpmVaultConflict(code="VAULT_INVALID_FILE_TYPE", message="Этот материал заменяется другим способом.")
        uploaded_file = request.FILES.get("file")
        if uploaded_file is None:
            raise PpmVaultConflict(code="VAULT_FILE_REQUIRED", message="Выберите новую версию файла.")
        try:
            base_version = int(request.data.get("base_version"))
        except (TypeError, ValueError):
            raise PpmVaultConflict(
                code="VAULT_BASE_VERSION_REQUIRED",
                message="Укажите версию, которую вы заменяете.",
            )
        entry = replace_uploaded_file(
            entry=entry,
            base_version=base_version,
            uploaded_file=uploaded_file,
            user_id=request.user.id,
        )
        return Response(serialize_entry(entry))


class PpmVaultBacklinksView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        incoming = PpmVaultLink.objects.filter(
            vault=vault,
            target_entry=entry,
            status=PpmVaultLinkStatus.RESOLVED,
            source_entry__status=PpmVaultEntryStatus.ACTIVE,
        ).select_related("source_entry")
        outgoing = PpmVaultLink.objects.filter(vault=vault, source_entry=entry).select_related("target_entry")
        return Response(
            {
                "entry": serialize_entry(entry),
                "incoming": [
                    {**serialize_link(link), "source_entry": serialize_entry(link.source_entry)} for link in incoming
                ],
                "outgoing": [
                    {
                        **serialize_link(link),
                        "target_entry": serialize_entry(link.target_entry) if link.target_entry else None,
                    }
                    for link in outgoing
                ],
            }
        )


class PpmVaultGraphView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entries = list(
            vault.entries.filter(status=PpmVaultEntryStatus.ACTIVE)
            .exclude(id=vault.root_entry_id)
            .select_related("parent", "current_version")
        )
        links = vault.links.filter(source_entry__status=PpmVaultEntryStatus.ACTIVE).select_related(
            "source_entry", "target_entry"
        )
        return Response(
            {
                "nodes": [serialize_entry(entry) for entry in entries],
                "edges": [serialize_link(link) for link in links],
            }
        )


class PpmVaultVersionsView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        if entry.kind == PpmVaultEntryKind.FOLDER:
            raise PpmVaultConflict(code="VAULT_INVALID_FILE_TYPE", message="У папки нет версий.")
        return Response(
            {
                "entry": serialize_entry(entry),
                "versions": [
                    {
                        "version": version.version,
                        "size_bytes": version.size_bytes,
                        "content_hash": version.content_hash,
                        "mime_type": version.mime_type,
                        "created_by": str(version.created_by),
                        "created_at": version.created_at.isoformat(),
                        "current": version.id == entry.current_version_id,
                    }
                    for version in entry.versions.all()
                ],
            }
        )


class PpmVaultVersionContentView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id, version_number):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        version = entry.versions.filter(version=version_number).first()
        if version is None:
            raise PpmVaultConflict(code="VAULT_VERSION_NOT_FOUND", message="Версия не найдена.")
        if entry.kind == PpmVaultEntryKind.MARKDOWN:
            return Response(
                {
                    "entry": serialize_entry(entry),
                    "version": version_number,
                    "content": version.content_text,
                }
            )
        signed_url = private_object_url(object_key=version.object_key, filename=entry.name)
        if signed_url:
            return HttpResponseRedirect(signed_url)
        file_obj = open_private_object(version.object_key)
        if file_obj is None:
            raise PpmVaultConflict(code="VAULT_STORAGE_FAILED", message="Версия файла временно недоступна.")
        response = FileResponse(file_obj, content_type=version.mime_type or "application/octet-stream")
        response["Content-Disposition"] = f'attachment; filename="{entry.id}-v{version_number}.{entry.extension}"'
        response["Cache-Control"] = "private, no-store"
        response["Content-Security-Policy"] = "default-src 'none'; sandbox"
        response["X-Content-Type-Options"] = "nosniff"
        return response


class PpmVaultVersionRestoreView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id, entry_id, version_number):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        try:
            base_version = int(request.data.get("base_version"))
        except (TypeError, ValueError):
            raise PpmVaultConflict(code="VAULT_BASE_VERSION_REQUIRED", message="Укажите текущую версию материала.")
        entry = restore_entry_version(
            entry=entry,
            version_number=version_number,
            base_version=base_version,
            user_id=request.user.id,
        )
        return Response(serialize_entry(entry))


class PpmVaultTrashView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entries = vault.entries.filter(status=PpmVaultEntryStatus.TRASHED).select_related("parent", "current_version")
        return Response({"entries": [serialize_entry(entry) for entry in entries]})


class PpmVaultTrashRestoreView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = PpmVaultEntry.objects.filter(
            id=entry_id,
            vault=vault,
            status=PpmVaultEntryStatus.TRASHED,
        ).first()
        if entry is None:
            raise PpmVaultConflict(code="VAULT_ENTRY_NOT_FOUND", message="Материал не найден в корзине.")
        return Response(serialize_entry(restore_trashed_entry(entry=entry, user_id=request.user.id)))


class PpmVaultExportView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        archive = build_vault_export(vault)
        response = FileResponse(archive, content_type="application/zip")
        response["Content-Disposition"] = f'attachment; filename="ppm-vault-{project_id}.zip"'
        response["Cache-Control"] = "private, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response


class PpmVaultTransferPagesView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        pages = list_project_pages(workspace_id=workspace_id, project_id=project_id)
        return Response(
            {
                "pages": [
                    {
                        "id": str(page.id),
                        "name": page.name or "Без названия",
                        "updated_at": page.updated_at.isoformat(),
                    }
                    for page in pages
                ]
            }
        )


class PpmVaultPageImportView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id, page_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        page = get_project_page(workspace_id=workspace_id, project_id=project_id, page_id=page_id)
        entry, transfer = import_page_to_vault(
            vault=vault,
            page=page,
            parent_id=request.data.get("parent_id"),
            user_id=request.user.id,
        )
        return Response(
            {"entry": serialize_entry(entry), "transfer": serialize_transfer(transfer)},
            status=status.HTTP_201_CREATED,
        )


class PpmVaultPageExportView(PpmVaultAPIView):
    def post(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id, edit=True)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id, kind=PpmVaultEntryKind.MARKDOWN)
        page, transfer = export_markdown_to_page(entry=entry, user_id=request.user.id)
        return Response(
            {
                "page": {"id": str(page.id), "name": page.name, "updated_at": page.updated_at.isoformat()},
                "transfer": serialize_transfer(transfer),
            },
            status=status.HTTP_201_CREATED,
        )


class PpmVaultEntryTransfersView(PpmVaultAPIView):
    def get(self, request, workspace_id, project_id, entry_id):
        _, vault, denied = self.require_access(request, workspace_id, project_id)
        if denied:
            return denied
        entry = self.get_entry(vault=vault, entry_id=entry_id)
        return Response({"transfers": [serialize_transfer(item) for item in entry.transfers.all()]})
