from dataclasses import dataclass
import csv
import hashlib
import io
import json
import uuid

from django.db import IntegrityError, transaction
from django.db.models import Case, Count, F, IntegerField, Max, Q, Value, When
from django.utils.html import strip_tags
from django.utils import timezone
from rest_framework import serializers

from plane.app.serializers import IssueCreateSerializer
from plane.db.models import FileAsset, Issue, Page, Project, ProjectMember, ProjectPage, State
from plane.db.models.project import ROLE
from plane.ppm_git.models import (
    PpmGitLink,
    PpmGitLinkStatus,
    PpmGitObject,
    PpmGitRepository,
    PpmGitRepositoryStatus,
)
from plane.ppm_vault.models import PpmVaultEntry, PpmVaultEntryKind, PpmVaultEntryStatus

from .models import (
    PpmCanvasBinding,
    PpmCanvasBindingStatus,
    PpmCanvasBoard,
    PpmCanvasEntityType,
    PpmCanvasOperation,
    PpmCanvasSemanticEdge,
    PpmCanvasStatus,
    PpmCanvasVersion,
    PpmProjectCanvas,
    PpmSemanticEdgeConfirmationStatus,
)
from .schema import (
    PPM_CANVAS_READABLE_SCHEMA_VERSIONS,
    PPM_CANVAS_SCHEMA_VERSION,
    canvas_snapshot_hash,
    canvas_snapshot_shape_ids,
    validate_canvas_snapshot,
)


@dataclass(frozen=True)
class PpmCanvasConflict(Exception):
    code: str
    message: str
    details: dict


@dataclass(frozen=True)
class PpmProjectionConflict(Exception):
    code: str
    message: str
    details: dict


GIT_ENTITY_TYPES = {
    PpmCanvasEntityType.REPOSITORY,
    PpmCanvasEntityType.BRANCH,
    PpmCanvasEntityType.COMMIT,
    PpmCanvasEntityType.PULL_REQUEST,
}


def get_or_create_active_canvas(*, workspace_id, project_id, user_id):
    try:
        with transaction.atomic():
            canvas = PpmProjectCanvas.objects.get_or_create(
                project_id=project_id,
                status=PpmCanvasStatus.ACTIVE,
                defaults={"workspace_id": workspace_id, "created_by": user_id},
            )[0]
    except IntegrityError:
        canvas = PpmProjectCanvas.objects.get(project_id=project_id, status=PpmCanvasStatus.ACTIVE)
    get_or_create_default_board(canvas=canvas, user_id=user_id)
    canvas.refresh_from_db(fields=["default_board", "current_version", "updated_at"])
    return canvas


def normalize_board_name(name):
    display_name = " ".join(str(name).split())
    if not display_name:
        raise PpmCanvasConflict(
            code="CANVAS_BOARD_NAME_REQUIRED",
            message="Укажите название доски.",
            details={},
        )
    return display_name, display_name.casefold()


def get_or_create_default_board(*, canvas, user_id):
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=canvas.pk)
        if locked_canvas.default_board_id:
            board = PpmCanvasBoard.objects.filter(
                id=locked_canvas.default_board_id,
                canvas=locked_canvas,
            ).first()
            if board is not None:
                return board

        board = locked_canvas.boards.filter(status=PpmCanvasStatus.ACTIVE).order_by("position", "created_at").first()
        if board is None:
            operation_id = uuid.uuid5(uuid.NAMESPACE_URL, f"ppm:canvas:{locked_canvas.id}:default-board-operation")
            board = PpmCanvasBoard.objects.create(
                workspace_id=locked_canvas.workspace_id,
                project_id=locked_canvas.project_id,
                canvas=locked_canvas,
                name="Главная",
                normalized_name="главная",
                position=0,
                current_version=locked_canvas.current_version,
                created_operation_id=operation_id,
                created_by=user_id,
                updated_by=user_id,
            )
            PpmCanvasVersion.objects.filter(canvas=locked_canvas, board__isnull=True).update(board=board)
            PpmCanvasBinding.objects.filter(canvas=locked_canvas, board__isnull=True).update(board=board)
        locked_canvas.default_board = board
        locked_canvas.current_version = board.current_version
        locked_canvas.updated_at = timezone.now()
        locked_canvas.save(update_fields=["default_board", "current_version", "updated_at"])
        return board


def serialize_board(board):
    return {
        "board_id": str(board.id),
        "name": board.name,
        "position": board.position,
        "status": board.status,
        "version": board.current_version,
        "created_by": str(board.created_by),
        "updated_by": str(board.updated_by),
        "created_at": board.created_at.isoformat(),
        "updated_at": board.updated_at.isoformat(),
        "archived_at": board.archived_at.isoformat() if board.archived_at else None,
    }


def get_canvas_boards_payload(*, canvas, include_archived=False):
    boards = canvas.boards.all()
    if not include_archived:
        boards = boards.filter(status=PpmCanvasStatus.ACTIVE)
    return [serialize_board(board) for board in boards.order_by("position", "created_at", "id")]


def get_canvas_board(*, canvas, board_id, include_archived=False):
    boards = PpmCanvasBoard.objects.filter(
        id=board_id,
        canvas=canvas,
        workspace_id=canvas.workspace_id,
        project_id=canvas.project_id,
    )
    if not include_archived:
        boards = boards.filter(status=PpmCanvasStatus.ACTIVE)
    return boards.first()


def get_canvas_payload(*, canvas, access, user, capabilities=None):
    default_board = get_or_create_default_board(canvas=canvas, user_id=user.id)
    payload = get_board_payload(board=default_board, access=access, user=user)
    payload.update(
        {
            "name": canvas.name,
            "default_board_id": str(default_board.id),
            "boards": get_canvas_boards_payload(canvas=canvas),
            "capabilities": capabilities or {},
            "deprecated_default_board_adapter": True,
        }
    )
    return payload


def get_board_payload(*, board, access, user):
    canvas = board.canvas
    payload = {
        "canvas_id": str(canvas.id),
        "board_id": str(board.id),
        "workspace_id": str(canvas.workspace_id),
        "project_id": str(canvas.project_id),
        "name": board.name,
        "position": board.position,
        "status": board.status,
        "schema_version": PPM_CANVAS_SCHEMA_VERSION,
        "version": board.current_version,
        "snapshot": None,
        "snapshot_status": "empty",
        "content_hash": None,
        "saved_at": None,
        "saved_by": None,
        "access": access.value,
        "bindings": get_canvas_bindings_payload(board=board, access=access, user=user),
        "work_item_options": get_work_item_edit_options(
            workspace_id=canvas.workspace_id,
            project_id=canvas.project_id,
        ),
    }
    if board.current_version == 0:
        return payload

    current = PpmCanvasVersion.objects.filter(board=board, version=board.current_version).first()
    if current is None:
        payload["snapshot_status"] = "corrupt"
        return payload

    try:
        validate_canvas_snapshot(current.snapshot_json)
        current_hash = canvas_snapshot_hash(current.snapshot_json)
    except serializers.ValidationError:
        payload["snapshot_status"] = "corrupt"
        return payload

    if current.schema_version not in PPM_CANVAS_READABLE_SCHEMA_VERSIONS or current_hash != current.content_hash:
        payload["snapshot_status"] = "corrupt"
        return payload

    payload.update(
        {
            "snapshot": current.snapshot_json,
            "snapshot_status": "ready",
            "content_hash": current.content_hash,
            "saved_at": current.created_at.isoformat(),
            "saved_by": str(current.created_by),
        }
    )
    return payload


def get_project(*, workspace_id, project_id):
    return Project.objects.filter(
        id=project_id,
        workspace_id=workspace_id,
        deleted_at__isnull=True,
    ).first()


def get_visible_work_items(*, project, user, include_inactive=False):
    manager = Issue.all_objects if include_inactive else Issue.issue_objects
    queryset = manager.filter(workspace_id=project.workspace_id, project_id=project.id)
    role = (
        ProjectMember.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            member=user,
            is_active=True,
            deleted_at__isnull=True,
        )
        .values_list("role", flat=True)
        .first()
    )
    if role == ROLE.GUEST.value and not project.guest_view_all_features:
        queryset = queryset.filter(created_by_id=user.id)
    return queryset


def search_work_items(*, project, user, query, cursor, limit):
    queryset = (
        get_visible_work_items(project=project, user=user)
        .select_related("project", "workspace", "state")
        .prefetch_related("assignees")
    )
    if query:
        filters = Q(name__icontains=query)
        identifier = query.upper()
        prefix = f"{project.identifier}-"
        if identifier.startswith(prefix) and identifier[len(prefix) :].isdigit():
            filters |= Q(sequence_id=int(identifier[len(prefix) :]))
        elif query.isdigit():
            filters |= Q(sequence_id=int(query))
        queryset = queryset.filter(filters)

    page = list(queryset.order_by("-updated_at", "-id")[cursor : cursor + limit + 1])
    has_more = len(page) > limit
    page = page[:limit]
    return page, str(cursor + limit) if has_more else None


WORK_ITEMS_VIEW_SORTS = {
    "updated_desc": ("-updated_at", "-id"),
    "updated_asc": ("updated_at", "id"),
    "created_desc": ("-created_at", "-id"),
    "created_asc": ("created_at", "id"),
    "due_asc": (F("target_date").asc(nulls_last=True), "id"),
    "due_desc": (F("target_date").desc(nulls_last=True), "-id"),
}


def get_work_items_view_queryset(*, project, user, filters):
    queryset = get_visible_work_items(
        project=project,
        user=user,
        include_inactive=filters["include_archived"],
    ).filter(deleted_at__isnull=True, is_draft=False)
    if not filters["include_archived"]:
        queryset = queryset.filter(archived_at__isnull=True)
    if filters["q"]:
        query = filters["q"]
        lookup = Q(name__icontains=query)
        identifier = query.upper()
        prefix = f"{project.identifier}-"
        if identifier.startswith(prefix) and identifier[len(prefix) :].isdigit():
            lookup |= Q(sequence_id=int(identifier[len(prefix) :]))
        elif query.isdigit():
            lookup |= Q(sequence_id=int(query))
        queryset = queryset.filter(lookup)
    if filters["state_ids"]:
        queryset = queryset.filter(state_id__in=filters["state_ids"])
    if filters["priorities"]:
        queryset = queryset.filter(priority__in=filters["priorities"])
    if filters["assignee_ids"]:
        queryset = queryset.filter(assignees__id__in=filters["assignee_ids"]).distinct()
    return queryset


def validate_work_items_view_scope(*, project, filters):
    if filters["state_ids"]:
        found = set(
            State.objects.filter(
                workspace_id=project.workspace_id,
                project_id=project.id,
                id__in=filters["state_ids"],
                deleted_at__isnull=True,
            ).values_list("id", flat=True)
        )
        if found != set(filters["state_ids"]):
            raise PpmProjectionConflict(
                code="WORK_ITEM_VIEW_FILTER_NOT_FOUND",
                message="Один из статусов не принадлежит текущему проекту.",
                details={"filter": "state_ids"},
            )
    if filters["assignee_ids"]:
        found = set(
            ProjectMember.objects.filter(
                workspace_id=project.workspace_id,
                project_id=project.id,
                member_id__in=filters["assignee_ids"],
                is_active=True,
                deleted_at__isnull=True,
            ).values_list("member_id", flat=True)
        )
        if found != set(filters["assignee_ids"]):
            raise PpmProjectionConflict(
                code="WORK_ITEM_VIEW_FILTER_NOT_FOUND",
                message="Один из исполнителей не принадлежит текущему проекту.",
                details={"filter": "assignee_ids"},
            )


def get_work_items_view(*, project, user, filters):
    validate_work_items_view_scope(project=project, filters=filters)
    filtered = get_work_items_view_queryset(project=project, user=user, filters=filters)
    summary = summarize_work_items_view(filtered)
    queryset = filtered.select_related("project", "workspace", "state").prefetch_related("assignees")
    ordering = WORK_ITEMS_VIEW_SORTS[filters["sort"]]
    page = list(queryset.order_by(*ordering)[filters["cursor"] : filters["cursor"] + filters["limit"] + 1])
    has_more = len(page) > filters["limit"]
    page = page[: filters["limit"]]
    next_cursor = str(filters["cursor"] + filters["limit"]) if has_more else None
    return page, next_cursor, summary


def summarize_work_items_view(queryset):
    by_state = list(
        queryset.values("state_id", "state__name", "state__group", "state__color")
        .annotate(count=Count("id", distinct=True))
        .order_by("state__sequence", "state__name")
    )
    total = sum(item["count"] for item in by_state)
    completed = sum(item["count"] for item in by_state if item["state__group"] == "completed")
    return {
        "total": total,
        "completed": completed,
        "progress_percent": round((completed / total) * 100) if total else 0,
        "by_state": [
            {
                "state_id": str(item["state_id"]) if item["state_id"] else None,
                "name": item["state__name"] or "Без статуса",
                "group": item["state__group"] or "none",
                "color": item["state__color"] or "#8B93A3",
                "count": item["count"],
            }
            for item in by_state
        ],
    }


def create_work_item_from_view(*, board, project, user, validated_data):
    operation_type = "create_view_work_item"
    client_operation_id = validated_data["client_operation_id"]
    operation_fingerprint = _operation_fingerprint({"operation": operation_type, **validated_data})
    with transaction.atomic():
        locked_board = PpmCanvasBoard.objects.select_for_update().select_related("canvas").get(pk=board.pk)
        replay = _get_lifecycle_replay(
            canvas=locked_board.canvas,
            operation_type=operation_type,
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
        )
        if replay:
            issue = get_work_item(
                project=project,
                user=user,
                entity_id=replay.result_json["entity_id"],
                include_inactive=True,
            )
            if issue is None:
                raise PpmProjectionConflict(
                    code="WORK_ITEM_NOT_FOUND",
                    message="Созданная ранее задача больше недоступна.",
                    details={},
                )
            return issue, True

        plane_data = {"name": validated_data["name"]}
        for field in ("state_id", "priority", "assignee_ids"):
            if field in validated_data:
                plane_data[field] = validated_data[field]
        if "due_date" in validated_data:
            plane_data["target_date"] = validated_data["due_date"]
        serializer = IssueCreateSerializer(
            data=plane_data,
            context={
                "project_id": project.id,
                "workspace_id": project.workspace_id,
                "default_assignee_id": project.default_assignee_id,
            },
        )
        serializer.is_valid(raise_exception=True)
        issue = serializer.save(created_by=user, updated_by=user)
        _record_lifecycle_operation(
            canvas=locked_board.canvas,
            board=locked_board,
            operation_type=operation_type,
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
            result={"entity_id": str(issue.id)},
            user_id=user.id,
        )
        return issue, False


def export_work_items_csv(*, project, user, filters):
    validate_work_items_view_scope(project=project, filters=filters)
    queryset = (
        get_work_items_view_queryset(project=project, user=user, filters=filters)
        .select_related("project", "workspace", "state")
        .prefetch_related("assignees")
        .order_by("sequence_id", "id")
    )
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(("Ключ", "Название", "Статус", "Приоритет", "Исполнитель", "Срок"))
    for issue in queryset.iterator(chunk_size=100):
        assignees = ", ".join(
            assignee.display_name
            or " ".join(part for part in (assignee.first_name, assignee.last_name) if part).strip()
            or assignee.email
            or "Участник"
            for assignee in issue.assignees.all()
        )
        writer.writerow(
            (
                f"{project.identifier}-{issue.sequence_id}",
                issue.name,
                issue.state.name if issue.state else "Без статуса",
                issue.priority,
                assignees,
                issue.target_date.isoformat() if issue.target_date else "",
            )
        )
    return "\ufeff" + stream.getvalue()


def export_work_items_markdown(*, project, user, filters):
    validate_work_items_view_scope(project=project, filters=filters)
    queryset = (
        get_work_items_view_queryset(project=project, user=user, filters=filters)
        .select_related("state")
        .order_by("state__sequence", "sequence_id", "id")
    )
    summary = summarize_work_items_view(queryset)
    items = list(queryset[:100])
    active_items = [item for item in items if not item.state or item.state.group not in ("completed", "cancelled")]
    blockers = [
        item
        for item in active_items
        if item.state and ("block" in item.state.name.casefold() or "блок" in item.state.name.casefold())
    ]
    goal = strip_tags(project.description or "").strip() or "Не указана."
    lines = [
        f"# Сводка проекта {project.name}",
        "",
        "## Цель",
        "",
        goal,
        "",
        "## Прогресс",
        "",
        f"- Выполнено: {summary['completed']} из {summary['total']} ({summary['progress_percent']}%).",
    ]
    for state in summary["by_state"]:
        lines.append(f"- {state['name']}: {state['count']}.")
    lines.extend(("", "## Активные работы", ""))
    if active_items:
        lines.extend(
            (
                f"- **{project.identifier}-{item.sequence_id}** — {item.name} "
                f"({item.state.name if item.state else 'Без статуса'})."
            )
            for item in active_items
        )
    else:
        lines.append("Активных задач нет.")
    lines.extend(("", "## Блокировки", ""))
    if blockers:
        lines.extend(f"- **{project.identifier}-{item.sequence_id}** — {item.name}." for item in blockers)
    else:
        lines.append("Явно отмеченных блокировок нет.")
    lines.append("")
    return "\n".join(lines)


def get_work_item(*, project, user, entity_id, include_inactive=True):
    return (
        get_visible_work_items(project=project, user=user, include_inactive=include_inactive)
        .select_related("project", "workspace", "state")
        .prefetch_related("assignees")
        .filter(id=entity_id)
        .first()
    )


def work_item_source_version(issue):
    return issue.updated_at.isoformat()


def serialize_work_item(*, issue, access):
    source_status = "deleted" if issue.deleted_at else "archived" if issue.archived_at else "active"
    can_update = access.value == "edit" and source_status == "active" and not issue.is_draft
    source_url = None
    if source_status != "deleted":
        if source_status == "archived":
            source_url = f"/{issue.workspace.slug}/projects/{issue.project_id}/archives/issues/{issue.id}"
        else:
            source_url = f"/{issue.workspace.slug}/browse/{issue.project.identifier}-{issue.sequence_id}/"
    state = None
    if issue.state_id and issue.state:
        state = {
            "id": str(issue.state_id),
            "name": issue.state.name,
            "group": issue.state.group,
            "color": issue.state.color,
        }
    assignees = [
        {
            "id": str(assignee.id),
            "display_name": assignee.display_name
            or " ".join(part for part in (assignee.first_name, assignee.last_name) if part).strip()
            or assignee.email
            or "Участник",
            "avatar_url": assignee.avatar_url or None,
        }
        for assignee in issue.assignees.all()
    ]
    return {
        "identity": {
            "entity_type": PpmCanvasEntityType.WORK_ITEM,
            "entity_id": str(issue.id),
            "workspace_id": str(issue.workspace_id),
            "project_id": str(issue.project_id),
            "identifier": f"{issue.project.identifier}-{issue.sequence_id}",
            "source_url": source_url,
        },
        "display": {
            "title": issue.name,
            "state": state,
            "priority": issue.priority,
            "assignees": assignees,
            "due_date": issue.target_date.isoformat() if issue.target_date else None,
            "source_status": source_status,
        },
        "capabilities": {
            "read": True,
            "update": can_update,
            "delete_source": False,
            "editable_fields": ["state_id", "priority", "assignee_ids", "due_date"] if can_update else [],
        },
        "source_version": work_item_source_version(issue),
    }


def serialize_missing_work_item(*, binding):
    return {
        "identity": {
            "entity_type": binding.entity_type,
            "entity_id": str(binding.entity_id),
            "workspace_id": str(binding.workspace_id),
            "project_id": str(binding.project_id),
            "identifier": None,
            "source_url": None,
        },
        "display": {
            "title": "Удалённая или недоступная задача",
            "state": None,
            "priority": "none",
            "assignees": [],
            "due_date": None,
            "source_status": "deleted",
        },
        "capabilities": {
            "read": False,
            "update": False,
            "delete_source": False,
            "editable_fields": [],
        },
        "source_version": binding.source_version,
    }


def _user_is_restricted_guest(*, project, user):
    """Mirrors Plane's page guest rule (app/views/page/base.py list/retrieve ~294-304, ~212-221):
    a project GUEST (role=5) who is active is restricted to pages they own themselves, unless the
    project opted into guest_view_all_features. Keeps ppm_canvas page visibility in step with it."""
    if project.guest_view_all_features:
        return False
    role = (
        ProjectMember.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            member_id=user.id,
            is_active=True,
            deleted_at__isnull=True,
        )
        .values_list("role", flat=True)
        .first()
    )
    return role == ROLE.GUEST.value


def search_project_pages(*, project, user, query, cursor, limit):
    """Pages the user may attach to a board: public, top-level pages only (matching Plane's own
    page list). A private page is never offered here, even the requester's own one, because a
    bound card's title becomes part of the board's shared snapshot for every viewer. A restricted
    guest (see `_user_is_restricted_guest`) is further limited to public pages they own themselves,
    matching Plane's guest rule."""
    queryset = Page.objects.filter(
        workspace_id=project.workspace_id,
        archived_at__isnull=True,
        parent__isnull=True,
        access=Page.PUBLIC_ACCESS,
        project_pages__project_id=project.id,
        project_pages__workspace_id=project.workspace_id,
        project_pages__deleted_at__isnull=True,
    ).select_related("owned_by")
    if _user_is_restricted_guest(project=project, user=user):
        queryset = queryset.filter(owned_by_id=user.id)
    ordering = ["-updated_at", "-id"]
    if query:
        queryset = queryset.filter(Q(name__icontains=query) | Q(description_stripped__icontains=query)).annotate(
            name_rank=Case(When(name__icontains=query, then=Value(0)), default=Value(1), output_field=IntegerField())
        )
        ordering.insert(0, "name_rank")
    page = list(queryset.order_by(*ordering)[cursor : cursor + limit + 1])
    has_more = len(page) > limit
    return page[:limit], str(cursor + limit) if has_more else None


def serialize_page_search_result(*, page, project, access):
    owner = page.owned_by
    return {
        **serialize_content_source(source=page, entity_type=PpmCanvasEntityType.PAGE, project=project, access=access),
        "page": {
            "updated_at": page.updated_at.isoformat(),
            "owned_by": {
                "id": str(page.owned_by_id),
                "display_name": (owner.display_name or owner.first_name or "") if owner else "",
            },
            "access": "private" if page.access == Page.PRIVATE_ACCESS else "public",
        },
    }


def _content_source_url(*, project, entity_type, entity_id):
    if entity_type == PpmCanvasEntityType.PAGE:
        return f"/{project.workspace.slug}/projects/{project.id}/pages/{entity_id}"
    if entity_type == PpmCanvasEntityType.VAULT_FILE:
        return f"/{project.workspace.slug}/projects/{project.id}/knowledge?entry_id={entity_id}"
    return None


def _content_preview_url(*, project, entity_type, entity_id):
    if entity_type == PpmCanvasEntityType.VAULT_FILE:
        return f"/api/ppm/v1/workspaces/{project.workspace_id}/projects/{project.id}/vault/entries/{entity_id}/file/"
    return None


def get_content_source(*, project, user, entity_type, entity_id, restricted_guest=None):
    """`restricted_guest` lets a caller that resolves many bindings for the same (project, user) in
    one request (see `get_canvas_bindings_payload`) pass in an already-computed
    `_user_is_restricted_guest` result instead of paying one ProjectMember query per PAGE binding.
    Leave it `None` (default) for a single-lookup call site; it is then computed here, same as
    before."""
    if entity_type == PpmCanvasEntityType.PAGE:
        project_page = (
            ProjectPage.objects.filter(
                workspace_id=project.workspace_id,
                project_id=project.id,
                page_id=entity_id,
                deleted_at__isnull=True,
                page__deleted_at__isnull=True,
            )
            .select_related("page", "project__workspace")
            .first()
        )
        if project_page is None:
            return None
        page = project_page.page
        if page.access == Page.PRIVATE_ACCESS and page.owned_by_id != user.id:
            return None
        if page.owned_by_id != user.id:
            is_restricted = (
                _user_is_restricted_guest(project=project, user=user) if restricted_guest is None else restricted_guest
            )
            if is_restricted:
                return None
        return page

    if entity_type == PpmCanvasEntityType.ATTACHMENT:
        asset = (
            FileAsset.objects.filter(
                id=entity_id,
                workspace_id=project.workspace_id,
                project_id=project.id,
                entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
                is_uploaded=True,
                is_deleted=False,
            )
            .select_related("workspace", "project", "issue")
            .first()
        )
        if asset is None or asset.issue_id is None:
            return None
        visible_issue = get_work_item(project=project, user=user, entity_id=asset.issue_id, include_inactive=True)
        return asset if visible_issue is not None else None

    if entity_type == PpmCanvasEntityType.VAULT_FILE:
        return (
            PpmVaultEntry.objects.filter(
                id=entity_id,
                workspace_id=project.workspace_id,
                project_id=project.id,
            )
            .exclude(kind=PpmVaultEntryKind.FOLDER)
            .select_related("current_version")
            .first()
        )
    return None


def content_source_version(source):
    if isinstance(source, PpmVaultEntry):
        return str(source.version)
    return source.updated_at.isoformat()


def serialize_content_source(*, source, entity_type, project, access):
    if isinstance(source, Page):
        source_status = "archived" if source.archived_at else "active"
        title = source.name or "Без названия"
        excerpt = (source.description_stripped or "").strip()[:500] or None
        extension = ".page"
        mime_type = "text/html"
        size_bytes = len((source.description_stripped or "").encode("utf-8"))
        source_url = _content_source_url(
            project=project,
            entity_type=PpmCanvasEntityType.PAGE,
            entity_id=source.id,
        )
        preview_url = None
    elif isinstance(source, FileAsset):
        source_status = "archived" if source.is_archived else "active"
        title = str((source.attributes or {}).get("name") or source.asset.name.rsplit("/", 1)[-1] or "Вложение")
        excerpt = None
        suffix = title.rsplit(".", 1)[-1].lower() if "." in title else ""
        extension = f".{suffix}" if suffix else None
        mime_type = str((source.attributes or {}).get("type") or "application/octet-stream")
        size_bytes = int(source.size or 0)
        source_url = source.asset_url
        preview_url = source.asset_url
    else:
        source_status = (
            "quarantined"
            if source.status == PpmVaultEntryStatus.QUARANTINED
            else "deleted"
            if source.status == PpmVaultEntryStatus.TRASHED
            else "active"
        )
        title = source.name
        excerpt = None
        if source.kind == PpmVaultEntryKind.MARKDOWN and source.current_version_id:
            excerpt = (source.current_version.content_text or "").strip()[:500] or None
        extension = f".{source.extension}" if source.extension else None
        mime_type = source.mime_type or "application/octet-stream"
        size_bytes = source.size_bytes
        source_url = _content_source_url(
            project=project,
            entity_type=PpmCanvasEntityType.VAULT_FILE,
            entity_id=source.id,
        )
        preview_url = _content_preview_url(
            project=project,
            entity_type=PpmCanvasEntityType.VAULT_FILE,
            entity_id=source.id,
        )

    can_update = access.value == "edit" and source_status == "active"
    return {
        "identity": {
            "entity_type": entity_type,
            "entity_id": str(source.id),
            "workspace_id": str(project.workspace_id),
            "project_id": str(project.id),
            "source_url": source_url,
        },
        "display": {
            "title": title,
            "excerpt": excerpt,
            "extension": extension,
            "mime_type": mime_type,
            "size_bytes": size_bytes,
            "preview_url": preview_url,
            "source_status": source_status,
        },
        "capabilities": {
            "read": source_status not in {"deleted", "quarantined"},
            "update": can_update,
            "delete_source": False,
        },
        "source_version": content_source_version(source),
    }


def serialize_missing_content(*, binding):
    return {
        "identity": {
            "entity_type": binding.entity_type,
            "entity_id": str(binding.entity_id),
            "workspace_id": str(binding.workspace_id),
            "project_id": str(binding.project_id),
            "source_url": None,
        },
        "display": {
            "title": "Удалённый или недоступный материал",
            "excerpt": None,
            "extension": None,
            "mime_type": "application/octet-stream",
            "size_bytes": 0,
            "preview_url": None,
            "source_status": "deleted",
        },
        "capabilities": {"read": False, "update": False, "delete_source": False},
        "source_version": binding.source_version,
    }


def get_git_source(*, project, entity_type, entity_id, active_only=False):
    if entity_type == PpmCanvasEntityType.REPOSITORY:
        repositories = PpmGitRepository.objects.filter(
            id=entity_id,
            workspace_id=project.workspace_id,
            project_id=project.id,
        )
        if active_only:
            repositories = repositories.filter(status=PpmGitRepositoryStatus.ACTIVE)
        return repositories.first()

    if entity_type not in GIT_ENTITY_TYPES:
        return None
    objects = PpmGitObject.objects.select_related("repository").filter(
        id=entity_id,
        workspace_id=project.workspace_id,
        project_id=project.id,
        object_type=entity_type,
    )
    if active_only:
        objects = objects.filter(is_active=True, repository__status=PpmGitRepositoryStatus.ACTIVE)
    git_object = objects.first()
    if git_object is not None:
        return git_object

    links = PpmGitLink.objects.select_related("repository", "git_object", "work_item__project").filter(
        id=entity_id,
        workspace_id=project.workspace_id,
        project_id=project.id,
        object_type=entity_type,
    )
    if active_only:
        links = links.filter(status=PpmGitLinkStatus.ACTIVE, repository__status=PpmGitRepositoryStatus.ACTIVE)
    return links.first()


def _serialize_git_work_item(link):
    return {
        "id": str(link.work_item_id),
        "identifier": f"{link.work_item.project.identifier}-{link.work_item.sequence_id}",
        "title": link.work_item.name,
    }


def git_source_version(source):
    if isinstance(source, PpmGitObject):
        return source.source_version
    return source.updated_at.isoformat()


def serialize_git_source(*, source, entity_type, project):
    if isinstance(source, PpmGitRepository):
        repository = source
        git_object = None
        title = repository.name
        canonical_url = repository.canonical_url
        ref = repository.default_branch
        state = repository.status
        author_name = ""
        base_ref = ""
        head_ref = ""
        commit_sha = ""
        source_status = "active" if repository.status == PpmGitRepositoryStatus.ACTIVE else "archived"
        links = repository.links.filter(status=PpmGitLinkStatus.ACTIVE).select_related("work_item__project")[:20]
    elif isinstance(source, PpmGitObject):
        repository = source.repository
        git_object = source
        title = source.title
        canonical_url = source.canonical_url
        ref = source.ref
        state = source.state
        author_name = source.author_name
        base_ref = source.base_ref
        head_ref = source.head_ref
        commit_sha = source.commit_sha
        source_status = (
            "active" if source.is_active and repository.status == PpmGitRepositoryStatus.ACTIVE else "deleted"
        )
        links = source.work_item_links.filter(status=PpmGitLinkStatus.ACTIVE).select_related("work_item__project")[:20]
    else:
        repository = source.repository
        git_object = source.git_object
        title = git_object.title if git_object else source.title
        canonical_url = git_object.canonical_url if git_object else source.canonical_url
        ref = git_object.ref if git_object else source.ref
        state = git_object.state if git_object else "linked"
        author_name = git_object.author_name if git_object else ""
        base_ref = git_object.base_ref if git_object else ""
        head_ref = git_object.head_ref if git_object else ""
        commit_sha = git_object.commit_sha if git_object else ""
        source_status = (
            "active"
            if source.status == PpmGitLinkStatus.ACTIVE
            and repository.status == PpmGitRepositoryStatus.ACTIVE
            and (git_object is None or git_object.is_active)
            else "deleted"
        )
        links = [source]

    return {
        "identity": {
            "entity_type": entity_type,
            "entity_id": str(source.id),
            "workspace_id": str(project.workspace_id),
            "project_id": str(project.id),
            "source_url": canonical_url,
        },
        "display": {
            "title": title,
            "provider": repository.provider,
            "repository_name": repository.provider_full_name or repository.name,
            "object_type": entity_type,
            "ref": ref,
            "state": state,
            "author_name": author_name,
            "base_ref": base_ref,
            "head_ref": head_ref,
            "commit_sha": commit_sha,
            "work_items": [_serialize_git_work_item(link) for link in links],
            "source_status": source_status,
        },
        "capabilities": {"read": source_status == "active", "update": False, "delete_source": False},
        "source_version": git_source_version(git_object or source),
    }


def serialize_missing_git(*, binding):
    return {
        "identity": {
            "entity_type": binding.entity_type,
            "entity_id": str(binding.entity_id),
            "workspace_id": str(binding.workspace_id),
            "project_id": str(binding.project_id),
            "source_url": None,
        },
        "display": {
            "title": "Удалённый или недоступный Git-объект",
            "provider": "generic",
            "repository_name": "",
            "object_type": binding.entity_type,
            "ref": "",
            "state": "deleted",
            "author_name": "",
            "base_ref": "",
            "head_ref": "",
            "commit_sha": "",
            "work_items": [],
            "source_status": "deleted",
        },
        "capabilities": {"read": False, "update": False, "delete_source": False},
        "source_version": binding.source_version,
    }


def serialize_binding(*, binding, access, user, project=None, restricted_guest=None):
    project = project or get_project(workspace_id=binding.workspace_id, project_id=binding.project_id)
    if project and binding.entity_type == PpmCanvasEntityType.WORK_ITEM:
        issue = get_work_item(project=project, user=user, entity_id=binding.entity_id)
        source = (
            serialize_work_item(issue=issue, access=access) if issue else serialize_missing_work_item(binding=binding)
        )
    elif project and binding.entity_type in GIT_ENTITY_TYPES:
        git_source = get_git_source(
            project=project,
            entity_type=binding.entity_type,
            entity_id=binding.entity_id,
        )
        source = (
            serialize_git_source(source=git_source, entity_type=binding.entity_type, project=project)
            if git_source
            else serialize_missing_git(binding=binding)
        )
    elif project:
        content = get_content_source(
            project=project,
            user=user,
            entity_type=binding.entity_type,
            entity_id=binding.entity_id,
            restricted_guest=restricted_guest,
        )
        source = (
            serialize_content_source(
                source=content,
                entity_type=binding.entity_type,
                project=project,
                access=access,
            )
            if content
            else serialize_missing_content(binding=binding)
        )
    else:
        if binding.entity_type == PpmCanvasEntityType.WORK_ITEM:
            source = serialize_missing_work_item(binding=binding)
        elif binding.entity_type in GIT_ENTITY_TYPES:
            source = serialize_missing_git(binding=binding)
        else:
            source = serialize_missing_content(binding=binding)
    return _serialize_resolved_binding(binding=binding, source=source)


def _serialize_resolved_binding(*, binding, source):
    return {
        "binding_id": str(binding.id),
        "board_id": str(binding.board_id),
        "binding_status": binding.status,
        "shape_id": binding.shape_id,
        "entity_type": binding.entity_type,
        "entity_id": str(binding.entity_id),
        "source_version": source["source_version"],
        "source": source,
    }


def get_canvas_bindings_payload(*, board, access, user):
    canvas = board.canvas
    project = get_project(workspace_id=canvas.workspace_id, project_id=canvas.project_id)
    # Computed once per request here rather than once per PAGE binding inside get_content_source:
    # opening a board with many page cards must not add one ProjectMember query per card.
    restricted_guest = _user_is_restricted_guest(project=project, user=user) if project else None
    bindings = list(board.bindings.filter(status=PpmCanvasBindingStatus.ACTIVE))
    work_item_ids = [binding.entity_id for binding in bindings if binding.entity_type == PpmCanvasEntityType.WORK_ITEM]
    issues_by_id = {}
    if project and work_item_ids:
        issues = (
            get_visible_work_items(project=project, user=user, include_inactive=True)
            .filter(id__in=work_item_ids)
            .select_related("project", "workspace", "state")
            .prefetch_related("assignees")
        )
        issues_by_id = {issue.id: issue for issue in issues}
    payload = []
    for binding in bindings:
        if binding.entity_type == PpmCanvasEntityType.WORK_ITEM:
            issue = issues_by_id.get(binding.entity_id)
            source = (
                serialize_work_item(issue=issue, access=access)
                if issue
                else serialize_missing_work_item(binding=binding)
            )
            payload.append(_serialize_resolved_binding(binding=binding, source=source))
        else:
            payload.append(
                serialize_binding(
                    binding=binding,
                    access=access,
                    user=user,
                    project=project,
                    restricted_guest=restricted_guest,
                )
            )
    return payload


def get_work_item_edit_options(*, workspace_id, project_id):
    states = State.objects.filter(
        workspace_id=workspace_id,
        project_id=project_id,
        deleted_at__isnull=True,
    ).order_by("sequence", "name")
    members = (
        ProjectMember.objects.filter(
            workspace_id=workspace_id,
            project_id=project_id,
            is_active=True,
            deleted_at__isnull=True,
            role__gte=ROLE.MEMBER.value,
        )
        .select_related("member")
        .order_by("member__display_name", "member__email")
    )
    return {
        "states": [
            {"id": str(state.id), "name": state.name, "group": state.group, "color": state.color} for state in states
        ],
        "priorities": [value for value, _ in Issue.PRIORITY_CHOICES],
        "assignees": [
            {
                "id": str(member.member_id),
                "display_name": member.member.display_name
                or " ".join(part for part in (member.member.first_name, member.member.last_name) if part).strip()
                or member.member.email
                or "Участник",
                "avatar_url": member.member.avatar_url or None,
            }
            for member in members
        ],
    }


def _operation_fingerprint(payload):
    encoded = json.dumps(payload, default=str, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


def _normalize_binding_changes(binding_changes):
    binding_changes = binding_changes or {}
    return {
        "activate": sorted(str(binding_id) for binding_id in binding_changes.get("activate", [])),
        "remove": sorted(str(binding_id) for binding_id in binding_changes.get("remove", [])),
    }


def _binding_change_conflict(*, code, message, binding_ids):
    raise PpmCanvasConflict(
        code=code,
        message=message,
        details={"binding_ids": sorted(str(binding_id) for binding_id in binding_ids)},
    )


def _validate_and_lock_binding_changes(*, board, snapshot, binding_changes):
    activate_ids = set(binding_changes["activate"])
    remove_ids = set(binding_changes["remove"])
    requested_ids = activate_ids | remove_ids
    bindings = {
        str(binding.id): binding
        for binding in PpmCanvasBinding.objects.select_for_update().filter(board=board, id__in=requested_ids)
    }
    missing_ids = requested_ids - bindings.keys()
    if missing_ids:
        _binding_change_conflict(
            code="CANVAS_BINDING_NOT_FOUND",
            message="Одна или несколько проекций не принадлежат этому холсту.",
            binding_ids=missing_ids,
        )

    invalid_activations = {
        binding_id for binding_id in activate_ids if bindings[binding_id].status != PpmCanvasBindingStatus.PENDING
    }
    if invalid_activations:
        _binding_change_conflict(
            code="CANVAS_BINDING_NOT_PENDING",
            message="Проекцию уже активировали или отменили.",
            binding_ids=invalid_activations,
        )
    invalid_removals = {
        binding_id for binding_id in remove_ids if bindings[binding_id].status != PpmCanvasBindingStatus.ACTIVE
    }
    if invalid_removals:
        _binding_change_conflict(
            code="CANVAS_BINDING_NOT_ACTIVE",
            message="Удалить можно только активную проекцию.",
            binding_ids=invalid_removals,
        )

    snapshot_shape_ids = canvas_snapshot_shape_ids(snapshot)
    activations_without_shapes = {
        binding_id for binding_id in activate_ids if bindings[binding_id].shape_id not in snapshot_shape_ids
    }
    if activations_without_shapes:
        _binding_change_conflict(
            code="CANVAS_BINDING_SHAPE_MISSING",
            message="Снимок холста не содержит фигуру активируемой проекции.",
            binding_ids=activations_without_shapes,
        )
    removals_with_shapes = {
        binding_id for binding_id in remove_ids if bindings[binding_id].shape_id in snapshot_shape_ids
    }
    if removals_with_shapes:
        _binding_change_conflict(
            code="CANVAS_BINDING_SHAPE_PRESENT",
            message="Фигура удаляемой проекции всё ещё присутствует в снимке холста.",
            binding_ids=removals_with_shapes,
        )

    retained_active_bindings = PpmCanvasBinding.objects.select_for_update().filter(
        board=board,
        status=PpmCanvasBindingStatus.ACTIVE,
    )
    if remove_ids:
        retained_active_bindings = retained_active_bindings.exclude(id__in=remove_ids)
    missing_active_ids = {
        str(binding.id) for binding in retained_active_bindings if binding.shape_id not in snapshot_shape_ids
    }
    if missing_active_ids:
        _binding_change_conflict(
            code="CANVAS_ACTIVE_BINDING_SHAPE_MISSING",
            message="Снимок не содержит фигуру действующей проекции.",
            binding_ids=missing_active_ids,
        )
    return bindings, activate_ids, remove_ids


def _get_operation_replay(*, board, shape_id, client_operation_id, operation_fingerprint):
    existing = PpmCanvasBinding.objects.filter(board=board, client_operation_id=client_operation_id).first()
    if existing is None:
        return None
    same_request = existing.shape_id == shape_id and existing.operation_fingerprint == operation_fingerprint
    if not same_request:
        raise PpmProjectionConflict(
            code="BINDING_OPERATION_REUSED",
            message="Идентификатор операции уже использован для другой проекции.",
            details={"binding_id": str(existing.id)},
        )
    return existing


def create_work_item_binding(*, board, project, user, shape_id, entity_id, client_operation_id):
    operation_fingerprint = _operation_fingerprint(
        {"operation": "bind", "shape_id": shape_id, "entity_id": entity_id, "entity_type": "work_item"}
    )
    with transaction.atomic():
        locked_board = PpmCanvasBoard.objects.select_for_update().select_related("canvas").get(pk=board.pk)
        replay = _get_operation_replay(
            board=locked_board,
            shape_id=shape_id,
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
        )
        if replay:
            return replay, True

        issue = get_work_item(project=project, user=user, entity_id=entity_id, include_inactive=False)
        if issue is None:
            raise PpmProjectionConflict(
                code="WORK_ITEM_NOT_FOUND",
                message="Задача не найдена в текущем проекте.",
                details={},
            )
        if PpmCanvasBinding.objects.filter(board=locked_board, shape_id=shape_id).exists():
            raise PpmProjectionConflict(
                code="BINDING_SHAPE_CONFLICT",
                message="Эта фигура уже связана с источником.",
                details={"shape_id": shape_id},
            )
        binding = PpmCanvasBinding.objects.create(
            workspace_id=project.workspace_id,
            project_id=project.id,
            canvas=locked_board.canvas,
            board=locked_board,
            shape_id=shape_id,
            entity_type=PpmCanvasEntityType.WORK_ITEM,
            entity_id=issue.id,
            source_version=work_item_source_version(issue),
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
            created_by=user.id,
        )
        return binding, False


def create_content_binding(*, board, project, user, shape_id, entity_type, entity_id, client_operation_id):
    if entity_type not in {
        PpmCanvasEntityType.PAGE,
        PpmCanvasEntityType.ATTACHMENT,
        PpmCanvasEntityType.VAULT_FILE,
    }:
        raise PpmProjectionConflict(
            code="PROJECTION_TYPE_UNSUPPORTED",
            message="Этот тип проекции пока не поддерживается.",
            details={"entity_type": entity_type},
        )
    operation_fingerprint = _operation_fingerprint(
        {"operation": "bind", "shape_id": shape_id, "entity_id": entity_id, "entity_type": entity_type}
    )
    with transaction.atomic():
        locked_board = PpmCanvasBoard.objects.select_for_update().select_related("canvas").get(pk=board.pk)
        replay = _get_operation_replay(
            board=locked_board,
            shape_id=shape_id,
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
        )
        if replay:
            return replay, True

        source = get_content_source(
            project=project,
            user=user,
            entity_type=entity_type,
            entity_id=entity_id,
        )
        if source is None:
            raise PpmProjectionConflict(
                code="CONTENT_SOURCE_NOT_FOUND",
                message="Материал не найден в текущем проекте или недоступен.",
                details={"entity_type": entity_type},
            )
        if isinstance(source, PpmVaultEntry) and source.status != PpmVaultEntryStatus.ACTIVE:
            raise PpmProjectionConflict(
                code="CONTENT_SOURCE_QUARANTINED",
                message="Материал нельзя добавить, пока он находится в карантине.",
                details={"entity_type": entity_type},
            )
        if PpmCanvasBinding.objects.filter(board=locked_board, shape_id=shape_id).exists():
            raise PpmProjectionConflict(
                code="BINDING_SHAPE_CONFLICT",
                message="Эта фигура уже связана с источником.",
                details={"shape_id": shape_id},
            )
        binding = PpmCanvasBinding.objects.create(
            workspace_id=project.workspace_id,
            project_id=project.id,
            canvas=locked_board.canvas,
            board=locked_board,
            shape_id=shape_id,
            entity_type=entity_type,
            entity_id=source.id,
            source_version=content_source_version(source),
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
            created_by=user.id,
        )
        return binding, False


def create_git_binding(*, board, project, user, shape_id, entity_type, entity_id, client_operation_id):
    if entity_type not in GIT_ENTITY_TYPES:
        raise PpmProjectionConflict(
            code="PROJECTION_TYPE_UNSUPPORTED",
            message="Этот тип Git-проекции пока не поддерживается.",
            details={"entity_type": entity_type},
        )
    operation_fingerprint = _operation_fingerprint(
        {"operation": "bind", "shape_id": shape_id, "entity_id": entity_id, "entity_type": entity_type}
    )
    with transaction.atomic():
        locked_board = PpmCanvasBoard.objects.select_for_update().select_related("canvas").get(pk=board.pk)
        replay = _get_operation_replay(
            board=locked_board,
            shape_id=shape_id,
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
        )
        if replay:
            return replay, True

        source = get_git_source(
            project=project,
            entity_type=entity_type,
            entity_id=entity_id,
            active_only=True,
        )
        if source is None:
            raise PpmProjectionConflict(
                code="GIT_SOURCE_NOT_FOUND",
                message="Git-объект не найден в текущем проекте или больше недоступен.",
                details={"entity_type": entity_type},
            )
        if PpmCanvasBinding.objects.filter(board=locked_board, shape_id=shape_id).exists():
            raise PpmProjectionConflict(
                code="BINDING_SHAPE_CONFLICT",
                message="Эта фигура уже связана с источником.",
                details={"shape_id": shape_id},
            )
        binding = PpmCanvasBinding.objects.create(
            workspace_id=project.workspace_id,
            project_id=project.id,
            canvas=locked_board.canvas,
            board=locked_board,
            shape_id=shape_id,
            entity_type=entity_type,
            entity_id=source.id,
            source_version=git_source_version(source.git_object or source)
            if isinstance(source, PpmGitLink)
            else git_source_version(source),
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
            created_by=user.id,
        )
        return binding, False


def create_work_item_and_binding(*, board, project, user, validated_data):
    shape_id = validated_data["shape_id"]
    client_operation_id = validated_data["client_operation_id"]
    operation_fingerprint = _operation_fingerprint({"operation": "create", **validated_data})
    with transaction.atomic():
        locked_board = PpmCanvasBoard.objects.select_for_update().select_related("canvas").get(pk=board.pk)
        replay = _get_operation_replay(
            board=locked_board,
            shape_id=shape_id,
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
        )
        if replay:
            issue = Issue.all_objects.select_related("project", "workspace", "state").get(
                id=replay.entity_id,
                workspace_id=project.workspace_id,
                project_id=project.id,
            )
            return issue, replay, True
        if PpmCanvasBinding.objects.filter(board=locked_board, shape_id=shape_id).exists():
            raise PpmProjectionConflict(
                code="BINDING_SHAPE_CONFLICT",
                message="Эта фигура уже связана с источником.",
                details={"shape_id": shape_id},
            )

        plane_data = {"name": validated_data["name"]}
        for field in ("state_id", "priority", "assignee_ids"):
            if field in validated_data:
                plane_data[field] = validated_data[field]
        if "due_date" in validated_data:
            plane_data["target_date"] = validated_data["due_date"]
        serializer = IssueCreateSerializer(
            data=plane_data,
            context={
                "project_id": project.id,
                "workspace_id": project.workspace_id,
                "default_assignee_id": project.default_assignee_id,
            },
        )
        serializer.is_valid(raise_exception=True)
        issue = serializer.save(created_by=user, updated_by=user)
        binding = PpmCanvasBinding.objects.create(
            workspace_id=project.workspace_id,
            project_id=project.id,
            canvas=locked_board.canvas,
            board=locked_board,
            shape_id=shape_id,
            entity_type=PpmCanvasEntityType.WORK_ITEM,
            entity_id=issue.id,
            source_version=work_item_source_version(issue),
            client_operation_id=client_operation_id,
            operation_fingerprint=operation_fingerprint,
            created_by=user.id,
        )
        return issue, binding, False


def update_work_item(*, project, user, entity_id, validated_data):
    with transaction.atomic():
        issue = (
            get_visible_work_items(project=project, user=user, include_inactive=True)
            .select_for_update()
            .filter(id=entity_id)
            .first()
        )
        if issue is None:
            raise PpmProjectionConflict(
                code="WORK_ITEM_NOT_FOUND",
                message="Задача не найдена в текущем проекте.",
                details={},
            )
        if issue.deleted_at or issue.archived_at or issue.is_draft:
            raise PpmProjectionConflict(
                code="WORK_ITEM_NOT_EDITABLE",
                message="Удалённую или архивную задачу нельзя изменить с холста.",
                details={"source_version": work_item_source_version(issue)},
            )
        current_version = work_item_source_version(issue)
        if validated_data["source_version"] != current_version:
            raise PpmProjectionConflict(
                code="WORK_ITEM_VERSION_CONFLICT",
                message="Задача была изменена в другом представлении.",
                details={"current_source_version": current_version},
            )

        plane_data = {}
        for field in ("state_id", "priority", "assignee_ids"):
            if field in validated_data:
                plane_data[field] = validated_data[field]
        if "due_date" in validated_data:
            plane_data["target_date"] = validated_data["due_date"]
        serializer = IssueCreateSerializer(
            issue,
            data=plane_data,
            partial=True,
            context={
                "project_id": project.id,
                "workspace_id": project.workspace_id,
                "default_assignee_id": project.default_assignee_id,
            },
        )
        serializer.is_valid(raise_exception=True)
        issue = serializer.save(updated_by=user)
        new_version = work_item_source_version(issue)
        PpmCanvasBinding.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            entity_type=PpmCanvasEntityType.WORK_ITEM,
            entity_id=issue.id,
        ).update(source_version=new_version, updated_at=timezone.now())
        return issue


def save_canvas_snapshot(
    *,
    board,
    user_id,
    request_id,
    base_version,
    schema_version,
    snapshot,
    client_operation_id,
    binding_changes=None,
):
    content_hash = canvas_snapshot_hash(snapshot)
    normalized_binding_changes = _normalize_binding_changes(binding_changes)
    binding_changes_fingerprint = _operation_fingerprint(normalized_binding_changes)
    with transaction.atomic():
        # Board lifecycle operations lock the canvas before its boards. Keep the
        # same order here so a concurrent archive cannot deadlock a save.
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=board.canvas_id)
        locked_board = PpmCanvasBoard.objects.select_for_update().get(pk=board.pk, canvas=locked_canvas)
        if locked_canvas.status != PpmCanvasStatus.ACTIVE or locked_board.status != PpmCanvasStatus.ACTIVE:
            raise PpmCanvasConflict(
                code="CANVAS_BOARD_ARCHIVED",
                message="Доска находится в архиве и не принимает изменения.",
                details={"board_id": str(locked_board.id)},
            )
        existing = PpmCanvasVersion.objects.filter(
            board=locked_board,
            client_operation_id=client_operation_id,
        ).first()
        if existing is not None:
            if (
                existing.content_hash != content_hash
                or existing.schema_version != schema_version
                or existing.binding_changes_fingerprint != binding_changes_fingerprint
            ):
                raise PpmCanvasConflict(
                    code="CANVAS_OPERATION_REUSED",
                    message="Идентификатор сохранения уже использован для другого снимка.",
                    details={"current_version": locked_board.current_version},
                )
            return locked_board, existing, True

        if locked_board.current_version != base_version:
            raise PpmCanvasConflict(
                code="CANVAS_VERSION_CONFLICT",
                message="Доска была изменена другим участником.",
                details={"current_version": locked_board.current_version},
            )

        _, activate_ids, remove_ids = _validate_and_lock_binding_changes(
            board=locked_board,
            snapshot=snapshot,
            binding_changes=normalized_binding_changes,
        )

        saved_version = PpmCanvasVersion.objects.create(
            canvas=locked_canvas,
            board=locked_board,
            version=locked_board.current_version + 1,
            schema_version=schema_version,
            snapshot_json=snapshot,
            content_hash=content_hash,
            binding_changes_fingerprint=binding_changes_fingerprint,
            client_operation_id=client_operation_id,
            request_id=request_id,
            created_by=user_id,
        )
        if activate_ids:
            PpmCanvasBinding.objects.filter(id__in=activate_ids).update(
                status=PpmCanvasBindingStatus.ACTIVE,
                updated_at=timezone.now(),
            )
        if remove_ids:
            PpmCanvasBinding.objects.filter(id__in=remove_ids).delete()
        locked_board.current_version = saved_version.version
        locked_board.updated_by = user_id
        locked_board.updated_at = timezone.now()
        locked_board.save(update_fields=["current_version", "updated_by", "updated_at"])
        if locked_canvas.default_board_id == locked_board.id:
            PpmProjectCanvas.objects.filter(id=locked_canvas.id).update(
                current_version=saved_version.version,
                updated_at=timezone.now(),
            )
        return locked_board, saved_version, False


def _get_lifecycle_replay(*, canvas, operation_type, client_operation_id, operation_fingerprint):
    existing = (
        PpmCanvasOperation.objects.select_for_update()
        .filter(
            canvas=canvas,
            client_operation_id=client_operation_id,
        )
        .first()
    )
    if existing is None:
        return None
    if existing.operation_type != operation_type or existing.operation_fingerprint != operation_fingerprint:
        raise PpmCanvasConflict(
            code="CANVAS_OPERATION_REUSED",
            message="Идентификатор операции уже использован для другого действия.",
            details={"operation_type": existing.operation_type},
        )
    return existing


def _record_lifecycle_operation(
    *, canvas, board, operation_type, client_operation_id, operation_fingerprint, result, user_id
):
    return PpmCanvasOperation.objects.create(
        canvas=canvas,
        board=board,
        operation_type=operation_type,
        client_operation_id=client_operation_id,
        operation_fingerprint=operation_fingerprint,
        result_json=result,
        created_by=user_id,
    )


def _assert_active_name_available(*, canvas, normalized_name, exclude_board_id=None):
    existing = canvas.boards.filter(
        normalized_name=normalized_name,
        status=PpmCanvasStatus.ACTIVE,
    )
    if exclude_board_id:
        existing = existing.exclude(id=exclude_board_id)
    if existing.exists():
        raise PpmCanvasConflict(
            code="CANVAS_BOARD_NAME_CONFLICT",
            message="Активная доска с таким названием уже существует.",
            details={},
        )


def create_canvas_board(*, canvas, name, user_id, client_operation_id):
    display_name, normalized_name = normalize_board_name(name)
    fingerprint = _operation_fingerprint({"operation": "create_board", "name": normalized_name})
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=canvas.pk)
        replay = _get_lifecycle_replay(
            canvas=locked_canvas,
            operation_type="create_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
        )
        if replay:
            board = locked_canvas.boards.get(id=replay.result_json["board_id"])
            return board, True
        _assert_active_name_available(canvas=locked_canvas, normalized_name=normalized_name)
        max_position = locked_canvas.boards.filter(status=PpmCanvasStatus.ACTIVE).aggregate(value=Max("position"))[
            "value"
        ]
        board = PpmCanvasBoard.objects.create(
            workspace_id=locked_canvas.workspace_id,
            project_id=locked_canvas.project_id,
            canvas=locked_canvas,
            name=display_name,
            normalized_name=normalized_name,
            position=(max_position + 1) if max_position is not None else 0,
            created_operation_id=client_operation_id,
            created_by=user_id,
            updated_by=user_id,
        )
        result = {"board_id": str(board.id)}
        _record_lifecycle_operation(
            canvas=locked_canvas,
            board=board,
            operation_type="create_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
            result=result,
            user_id=user_id,
        )
        if locked_canvas.default_board_id is None:
            locked_canvas.default_board = board
            locked_canvas.save(update_fields=["default_board", "updated_at"])
        return board, False


def rename_canvas_board(*, board, name, user_id, client_operation_id):
    display_name, normalized_name = normalize_board_name(name)
    fingerprint = _operation_fingerprint(
        {"operation": "rename_board", "board_id": str(board.id), "name": normalized_name}
    )
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=board.canvas_id)
        replay = _get_lifecycle_replay(
            canvas=locked_canvas,
            operation_type="rename_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
        )
        if replay:
            return locked_canvas.boards.get(id=replay.result_json["board_id"]), True
        locked_board = PpmCanvasBoard.objects.select_for_update().get(pk=board.pk, canvas=locked_canvas)
        if locked_board.status != PpmCanvasStatus.ACTIVE:
            raise PpmCanvasConflict(
                code="CANVAS_BOARD_ARCHIVED",
                message="Архивную доску нельзя переименовать до восстановления.",
                details={"board_id": str(locked_board.id)},
            )
        _assert_active_name_available(
            canvas=locked_board.canvas,
            normalized_name=normalized_name,
            exclude_board_id=locked_board.id,
        )
        locked_board.name = display_name
        locked_board.normalized_name = normalized_name
        locked_board.updated_by = user_id
        locked_board.save(update_fields=["name", "normalized_name", "updated_by", "updated_at"])
        _record_lifecycle_operation(
            canvas=locked_canvas,
            board=locked_board,
            operation_type="rename_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
            result={"board_id": str(locked_board.id)},
            user_id=user_id,
        )
        return locked_board, False


def reorder_canvas_boards(*, canvas, board_ids, user_id, client_operation_id):
    normalized_ids = [str(board_id) for board_id in board_ids]
    fingerprint = _operation_fingerprint({"operation": "reorder_boards", "board_ids": normalized_ids})
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=canvas.pk)
        replay = _get_lifecycle_replay(
            canvas=locked_canvas,
            operation_type="reorder_boards",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
        )
        if replay:
            return get_canvas_boards_payload(canvas=locked_canvas), True

        active_boards = list(
            locked_canvas.boards.select_for_update()
            .filter(status=PpmCanvasStatus.ACTIVE)
            .order_by("position", "created_at", "id")
        )
        active_by_id = {str(board.id): board for board in active_boards}
        if len(normalized_ids) != len(set(normalized_ids)) or set(normalized_ids) != set(active_by_id):
            raise PpmCanvasConflict(
                code="CANVAS_BOARD_ORDER_INVALID",
                message="Порядок должен содержать каждую активную доску ровно один раз.",
                details={"active_board_ids": sorted(active_by_id)},
            )

        offset = len(active_boards) + 1000
        locked_canvas.boards.filter(status=PpmCanvasStatus.ACTIVE).update(position=F("position") + offset)
        for position, board_id in enumerate(normalized_ids):
            PpmCanvasBoard.objects.filter(id=board_id, canvas=locked_canvas).update(
                position=position,
                updated_by=user_id,
                updated_at=timezone.now(),
            )
        result = {"board_ids": normalized_ids}
        _record_lifecycle_operation(
            canvas=locked_canvas,
            board=None,
            operation_type="reorder_boards",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
            result=result,
            user_id=user_id,
        )
        return get_canvas_boards_payload(canvas=locked_canvas), False


def _next_copy_name(canvas, source_name):
    suffix = "копия"
    suffix_text = f" — {suffix}"
    candidate = f"{source_name[: 120 - len(suffix_text)]}{suffix_text}"
    number = 2
    while canvas.boards.filter(
        normalized_name=candidate.casefold(),
        status=PpmCanvasStatus.ACTIVE,
    ).exists():
        numbered_suffix = f" — {suffix} {number}"
        candidate = f"{source_name[: 120 - len(numbered_suffix)]}{numbered_suffix}"
        number += 1
    return candidate


def duplicate_canvas_board(*, board, name, user_id, client_operation_id, request_id):
    requested_name = " ".join(str(name or "").split())
    fingerprint = _operation_fingerprint(
        {"operation": "duplicate_board", "source_board_id": str(board.id), "name": requested_name.casefold()}
    )
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=board.canvas_id)
        source = PpmCanvasBoard.objects.select_for_update().get(
            pk=board.pk,
            canvas=locked_canvas,
            status=PpmCanvasStatus.ACTIVE,
        )
        replay = _get_lifecycle_replay(
            canvas=locked_canvas,
            operation_type="duplicate_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
        )
        if replay:
            duplicate = locked_canvas.boards.get(id=replay.result_json["board_id"])
            return duplicate, True

        display_name, normalized_name = normalize_board_name(
            requested_name or _next_copy_name(locked_canvas, source.name)
        )
        _assert_active_name_available(canvas=locked_canvas, normalized_name=normalized_name)
        max_position = locked_canvas.boards.filter(status=PpmCanvasStatus.ACTIVE).aggregate(value=Max("position"))[
            "value"
        ]
        current = source.versions.filter(version=source.current_version).first() if source.current_version else None
        if source.current_version and current is None:
            raise PpmCanvasConflict(
                code="CANVAS_BOARD_CORRUPT",
                message="Текущая версия исходной доски не найдена.",
                details={"board_id": str(source.id)},
            )
        duplicate = PpmCanvasBoard.objects.create(
            workspace_id=source.workspace_id,
            project_id=source.project_id,
            canvas=locked_canvas,
            name=display_name,
            normalized_name=normalized_name,
            position=(max_position + 1) if max_position is not None else 0,
            current_version=1 if current else 0,
            created_operation_id=client_operation_id,
            created_by=user_id,
            updated_by=user_id,
        )
        if current:
            PpmCanvasVersion.objects.create(
                canvas=locked_canvas,
                board=duplicate,
                version=1,
                schema_version=current.schema_version,
                snapshot_json=current.snapshot_json,
                content_hash=current.content_hash,
                binding_changes_fingerprint=current.binding_changes_fingerprint,
                client_operation_id=uuid.uuid5(uuid.NAMESPACE_URL, f"ppm:duplicate:{client_operation_id}:version"),
                request_id=request_id,
                created_by=user_id,
            )
        for binding in source.bindings.filter(status=PpmCanvasBindingStatus.ACTIVE):
            PpmCanvasBinding.objects.create(
                workspace_id=binding.workspace_id,
                project_id=binding.project_id,
                canvas=locked_canvas,
                board=duplicate,
                shape_id=binding.shape_id,
                entity_type=binding.entity_type,
                entity_id=binding.entity_id,
                status=binding.status,
                source_version=binding.source_version,
                client_operation_id=uuid.uuid5(
                    uuid.NAMESPACE_URL, f"ppm:duplicate:{client_operation_id}:binding:{binding.id}"
                ),
                operation_fingerprint=binding.operation_fingerprint,
                created_by=user_id,
            )
        for edge in source.semantic_edges.all():
            PpmCanvasSemanticEdge.objects.create(
                workspace_id=edge.workspace_id,
                project_id=edge.project_id,
                canvas=locked_canvas,
                board=duplicate,
                from_shape_id=edge.from_shape_id,
                to_shape_id=edge.to_shape_id,
                relation_type=edge.relation_type,
                label=edge.label,
                confidence=edge.confidence,
                origin=edge.origin,
                confirmation_status=edge.confirmation_status,
                confirmed_by=edge.confirmed_by,
                confirmed_at=edge.confirmed_at,
                client_operation_id=uuid.uuid5(
                    uuid.NAMESPACE_URL, f"ppm:duplicate:{client_operation_id}:edge:{edge.id}"
                ),
                created_by=user_id,
            )
        result = {"board_id": str(duplicate.id)}
        _record_lifecycle_operation(
            canvas=locked_canvas,
            board=duplicate,
            operation_type="duplicate_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
            result=result,
            user_id=user_id,
        )
        return duplicate, False


def archive_canvas_board(*, board, user_id, client_operation_id):
    fingerprint = _operation_fingerprint({"operation": "archive_board", "board_id": str(board.id)})
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=board.canvas_id)
        replay = _get_lifecycle_replay(
            canvas=locked_canvas,
            operation_type="archive_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
        )
        if replay:
            return locked_canvas.boards.get(id=replay.result_json["board_id"]), True
        locked_board = PpmCanvasBoard.objects.select_for_update().get(pk=board.pk, canvas=locked_canvas)
        if locked_board.status != PpmCanvasStatus.ACTIVE:
            raise PpmCanvasConflict(
                code="CANVAS_BOARD_ARCHIVED",
                message="Доска уже находится в архиве.",
                details={"board_id": str(locked_board.id)},
            )
        active_boards = list(
            locked_canvas.boards.select_for_update()
            .filter(status=PpmCanvasStatus.ACTIVE)
            .order_by("position", "created_at", "id")
        )
        if len(active_boards) <= 1:
            raise PpmCanvasConflict(
                code="CANVAS_LAST_BOARD",
                message="Последнюю активную доску нельзя архивировать.",
                details={"board_id": str(locked_board.id)},
            )
        locked_board.status = PpmCanvasStatus.ARCHIVED
        locked_board.archived_at = timezone.now()
        locked_board.updated_by = user_id
        locked_board.save(update_fields=["status", "archived_at", "updated_by", "updated_at"])
        remaining = [item for item in active_boards if item.id != locked_board.id]
        offset = len(remaining) + 1000
        locked_canvas.boards.filter(id__in=[item.id for item in remaining]).update(position=F("position") + offset)
        for position, item in enumerate(remaining):
            PpmCanvasBoard.objects.filter(id=item.id).update(position=position)
        if locked_canvas.default_board_id == locked_board.id:
            locked_canvas.default_board = remaining[0]
            locked_canvas.current_version = remaining[0].current_version
            locked_canvas.save(update_fields=["default_board", "current_version", "updated_at"])
        _record_lifecycle_operation(
            canvas=locked_canvas,
            board=locked_board,
            operation_type="archive_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
            result={"board_id": str(locked_board.id)},
            user_id=user_id,
        )
        return locked_board, False


def restore_canvas_board(*, board, user_id, client_operation_id):
    fingerprint = _operation_fingerprint({"operation": "restore_board", "board_id": str(board.id)})
    with transaction.atomic():
        locked_canvas = PpmProjectCanvas.objects.select_for_update().get(pk=board.canvas_id)
        replay = _get_lifecycle_replay(
            canvas=locked_canvas,
            operation_type="restore_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
        )
        if replay:
            return locked_canvas.boards.get(id=replay.result_json["board_id"]), True
        locked_board = PpmCanvasBoard.objects.select_for_update().get(pk=board.pk, canvas=locked_canvas)
        if locked_board.status != PpmCanvasStatus.ARCHIVED:
            raise PpmCanvasConflict(
                code="CANVAS_BOARD_ACTIVE",
                message="Доска уже активна.",
                details={"board_id": str(locked_board.id)},
            )
        _assert_active_name_available(canvas=locked_canvas, normalized_name=locked_board.normalized_name)
        max_position = locked_canvas.boards.filter(status=PpmCanvasStatus.ACTIVE).aggregate(value=Max("position"))[
            "value"
        ]
        locked_board.status = PpmCanvasStatus.ACTIVE
        locked_board.position = (max_position + 1) if max_position is not None else 0
        locked_board.archived_at = None
        locked_board.updated_by = user_id
        locked_board.save(update_fields=["status", "position", "archived_at", "updated_by", "updated_at"])
        _record_lifecycle_operation(
            canvas=locked_canvas,
            board=locked_board,
            operation_type="restore_board",
            client_operation_id=client_operation_id,
            operation_fingerprint=fingerprint,
            result={"board_id": str(locked_board.id)},
            user_id=user_id,
        )
        return locked_board, False


def get_board_versions_payload(*, board):
    return [
        {
            "version": version.version,
            "schema_version": version.schema_version,
            "content_hash": version.content_hash,
            "saved_by": str(version.created_by),
            "saved_at": version.created_at.isoformat(),
        }
        for version in board.versions.order_by("-version")
    ]


def get_board_version_payload(*, board, version):
    saved = board.versions.filter(version=version).first()
    if saved is None:
        return None
    return {
        "board_id": str(board.id),
        "version": saved.version,
        "schema_version": saved.schema_version,
        "snapshot": saved.snapshot_json,
        "content_hash": saved.content_hash,
        "saved_by": str(saved.created_by),
        "saved_at": saved.created_at.isoformat(),
    }


def serialize_semantic_edge(edge):
    return {
        "edge_id": str(edge.id),
        "board_id": str(edge.board_id),
        "from_shape_id": edge.from_shape_id,
        "to_shape_id": edge.to_shape_id,
        "relation_type": edge.relation_type,
        "label": edge.label,
        "confidence": float(edge.confidence) if edge.confidence is not None else None,
        "origin": edge.origin,
        "confirmation_status": edge.confirmation_status,
        "confirmed_by": str(edge.confirmed_by) if edge.confirmed_by else None,
        "confirmed_at": edge.confirmed_at.isoformat() if edge.confirmed_at else None,
        "created_by": str(edge.created_by),
        "created_at": edge.created_at.isoformat(),
        "updated_at": edge.updated_at.isoformat(),
    }


def create_semantic_edge(*, board, user_id, validated_data):
    fingerprint = _operation_fingerprint({"operation": "create_semantic_edge", **validated_data})
    with transaction.atomic():
        locked_board = PpmCanvasBoard.objects.select_for_update().select_related("canvas").get(pk=board.pk)
        operation_id = validated_data["client_operation_id"]
        existing = locked_board.semantic_edges.filter(client_operation_id=operation_id).first()
        if existing:
            existing_fingerprint = _operation_fingerprint(
                {
                    "operation": "create_semantic_edge",
                    "from_shape_id": existing.from_shape_id,
                    "to_shape_id": existing.to_shape_id,
                    "relation_type": existing.relation_type,
                    "label": existing.label,
                    "confidence": existing.confidence,
                    "origin": existing.origin,
                    "confirmation_status": existing.confirmation_status,
                    "client_operation_id": existing.client_operation_id,
                }
            )
            if existing_fingerprint != fingerprint:
                raise PpmCanvasConflict(
                    code="CANVAS_OPERATION_REUSED",
                    message="Идентификатор операции уже использован для другой смысловой связи.",
                    details={"edge_id": str(existing.id)},
                )
            return existing, True
        current = locked_board.versions.filter(version=locked_board.current_version).first()
        shape_ids = canvas_snapshot_shape_ids(current.snapshot_json) if current else set()
        requested_shapes = {validated_data["from_shape_id"], validated_data["to_shape_id"]}
        if not requested_shapes.issubset(shape_ids):
            raise PpmCanvasConflict(
                code="CANVAS_EDGE_SHAPE_NOT_FOUND",
                message="Одна или обе фигуры смысловой связи отсутствуют в текущей версии доски.",
                details={"shape_ids": sorted(requested_shapes - shape_ids)},
            )
        edge = PpmCanvasSemanticEdge.objects.create(
            workspace_id=locked_board.workspace_id,
            project_id=locked_board.project_id,
            canvas=locked_board.canvas,
            board=locked_board,
            created_by=user_id,
            confirmed_by=(
                user_id
                if validated_data["confirmation_status"] == PpmSemanticEdgeConfirmationStatus.CONFIRMED
                else None
            ),
            confirmed_at=(
                timezone.now()
                if validated_data["confirmation_status"] == PpmSemanticEdgeConfirmationStatus.CONFIRMED
                else None
            ),
            **validated_data,
        )
        return edge, False
