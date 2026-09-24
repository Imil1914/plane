from django.db import transaction
from django.utils.html import escape, strip_tags

from plane.db.models import Page, ProjectPage

from .models import PpmVaultEntryKind, PpmVaultTransferDirection, PpmVaultTransferRecord
from .services import PpmVaultConflict, create_markdown


def get_project_page(*, workspace_id, project_id, page_id):
    page = (
        Page.objects.filter(
            id=page_id,
            workspace_id=workspace_id,
            archived_at__isnull=True,
            project_pages__project_id=project_id,
            project_pages__workspace_id=workspace_id,
            project_pages__deleted_at__isnull=True,
        )
        .distinct()
        .first()
    )
    if page is None:
        raise PpmVaultConflict(code="VAULT_PAGE_NOT_FOUND", message="Документ проекта не найден.")
    return page


def list_project_pages(*, workspace_id, project_id):
    return (
        Page.objects.filter(
            workspace_id=workspace_id,
            archived_at__isnull=True,
            project_pages__project_id=project_id,
            project_pages__workspace_id=workspace_id,
            project_pages__deleted_at__isnull=True,
        )
        .distinct()
        .order_by("name", "id")
    )


def import_page_to_vault(*, vault, page, parent_id, user_id):
    name = (page.name or "Документ").strip() or "Документ"
    content = page.description_stripped
    if content is None:
        content = strip_tags(page.description_html or "")
    with transaction.atomic():
        entry = create_markdown(
            vault=vault,
            parent_id=parent_id,
            name=name,
            content=content,
            user_id=user_id,
        )
        transfer = PpmVaultTransferRecord.objects.create(
            workspace_id=vault.workspace_id,
            project_id=vault.project_id,
            vault=vault,
            entry=entry,
            page_id=page.id,
            direction=PpmVaultTransferDirection.PAGE_TO_VAULT,
            entry_version=entry.version,
            page_version=page.updated_at.isoformat(),
            created_by=user_id,
        )
    return entry, transfer


def export_markdown_to_page(*, entry, user_id):
    if entry.kind != PpmVaultEntryKind.MARKDOWN or entry.current_version is None:
        raise PpmVaultConflict(code="VAULT_MARKDOWN_REQUIRED", message="Выберите Markdown-документ.")
    page_name = entry.name[:-3] if entry.name.casefold().endswith(".md") else entry.name
    content = entry.current_version.content_text
    html = f"<pre>{escape(content)}</pre>"
    with transaction.atomic():
        page = Page.objects.create(
            workspace_id=entry.workspace_id,
            name=page_name,
            description_html=html,
            owned_by_id=user_id,
            access=Page.PUBLIC_ACCESS,
        )
        ProjectPage.objects.create(
            workspace_id=entry.workspace_id,
            project_id=entry.project_id,
            page=page,
        )
        transfer = PpmVaultTransferRecord.objects.create(
            workspace_id=entry.workspace_id,
            project_id=entry.project_id,
            vault=entry.vault,
            entry=entry,
            page_id=page.id,
            direction=PpmVaultTransferDirection.VAULT_TO_PAGE,
            entry_version=entry.version,
            page_version=page.updated_at.isoformat(),
            created_by=user_id,
        )
    return page, transfer


def serialize_transfer(transfer):
    return {
        "id": str(transfer.id),
        "direction": transfer.direction,
        "entry_id": str(transfer.entry_id),
        "entry_version": transfer.entry_version,
        "page_id": str(transfer.page_id),
        "page_version": transfer.page_version,
        "created_by": str(transfer.created_by),
        "created_at": transfer.created_at.isoformat(),
    }
