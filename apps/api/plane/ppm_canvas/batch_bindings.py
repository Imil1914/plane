"""AF2.2 S1 — пакетная привязка фигур доски к источникам (сборка карты спринта одним запросом).

Каждый пункт проходит ровно тот же путь, что одиночная привязка (`create_work_item_binding`,
`create_content_binding`, `create_git_binding`): те же проверки видимости, идемпотентность по
`client_operation_id`, привязка остаётся `pending` до сохранения доски. Пакет — одна транзакция, доска
заблокирована один раз на весь пакет; каждый пункт — в своей точке сохранения (savepoint), поэтому ошибка
одного пункта откатывает только его, а остальные сохраняются. Результаты — в порядке входа.

Общие для пакета проверки делаются один раз до цикла (финальная волна, M-10 и final-pass S1): видимость всех задач
пакета — одним запросом той же `get_visible_work_items(include_inactive=False)`, что у одиночной привязки; правило
ограниченного гостя для страниц — один запрос роли на пакет (и он же — для ответа). Замер пакета из 200 задач
(тестовый стенд, docker на macOS, A/B подряд): до — медиана 982 мс, 2227 запросов (≈ 11 на пункт, из них 3 — чтение
задачи с проектом, статусом и исполнителями); после — медиана 345 мс, 1629 запросов. Доска заблокирована на время
пакета — теперь втрое короче.
"""

import uuid

from django.db import IntegrityError, transaction

from .models import PpmCanvasBoard, PpmCanvasEntityType, PpmCanvasStatus
from .serializers import PpmCanvasBatchBindingItemSerializer
from .services import (
    GIT_ENTITY_TYPES,
    PpmCanvasConflict,
    PpmProjectionConflict,
    _serialize_resolved_binding,
    _user_is_restricted_guest,
    create_content_binding,
    create_git_binding,
    create_work_item_binding,
    get_visible_work_items,
    serialize_binding,
    serialize_missing_work_item,
    serialize_work_item,
)
from .work_item_version import current_assignees_prefetch


def batch_client_operation_id(*, board_id, shape_id, entity_type, entity_id):
    """Идентификатор операции для пункта без `client_operation_id`: один и тот же для одной и той же фигуры и
    источника на этой доске, поэтому повтор пакета после обрыва сети возвращает уже созданные привязки."""
    return uuid.uuid5(uuid.NAMESPACE_URL, f"ppm:canvas:{board_id}:batch-binding:{shape_id}:{entity_type}:{entity_id}")


def create_binding(
    *,
    board,
    project,
    user,
    shape_id,
    entity_type,
    entity_id,
    client_operation_id,
    visible_work_items=None,
    restricted_guest=None,
):
    """Тот же выбор сервиса по типу источника, что в `PpmCanvasBindingListCreateView.post`. `visible_work_items` и
    `restricted_guest` — общие для пакета проверки, вычисленные один раз (см. `create_bindings_batch`); `None` — сервис
    вычисляет их сам, как у одиночной привязки."""
    if entity_type == PpmCanvasEntityType.WORK_ITEM:
        return create_work_item_binding(
            board=board,
            project=project,
            user=user,
            shape_id=shape_id,
            entity_id=entity_id,
            client_operation_id=client_operation_id,
            visible_work_items=visible_work_items,
        )
    if entity_type in GIT_ENTITY_TYPES:
        return create_git_binding(
            board=board,
            project=project,
            user=user,
            shape_id=shape_id,
            entity_type=entity_type,
            entity_id=entity_id,
            client_operation_id=client_operation_id,
        )
    return create_content_binding(
        board=board,
        project=project,
        user=user,
        shape_id=shape_id,
        entity_type=entity_type,
        entity_id=entity_id,
        client_operation_id=client_operation_id,
        restricted_guest=restricted_guest,
    )


def _item_shape_id(item):
    shape_id = item.get("shape_id") if isinstance(item, dict) else None
    return shape_id if isinstance(shape_id, str) and len(shape_id) <= 255 else None


def _error(shape_id, *, code, message, details=None):
    return {
        "shape_id": shape_id,
        "status": "error",
        "error": {"code": code, "message": message, "details": details or {}},
    }


def create_bindings_batch(*, board, project, user, access, items):
    # Проверка пунктов не зависит от базы — до блокировки доски, чтобы общие проверки пакета сделать одним запросом.
    checked = []
    for item in items:
        serializer = PpmCanvasBatchBindingItemSerializer(data=item)
        checked.append((item, serializer.validated_data if serializer.is_valid() else None, serializer))
    valid = [data for _, data, _ in checked if data is not None]
    work_item_ids = {data["entity_id"] for data in valid if data["entity_type"] == PpmCanvasEntityType.WORK_ITEM}
    outcomes = []
    with transaction.atomic():
        locked_board = PpmCanvasBoard.objects.select_for_update().get(pk=board.pk)
        if locked_board.status != PpmCanvasStatus.ACTIVE:
            raise PpmCanvasConflict(
                code="CANVAS_BOARD_ARCHIVED",
                message="Доска находится в архиве и не принимает изменения.",
                details={"board_id": str(locked_board.id)},
            )
        # Видимость всех задач пакета — один запрос (та же функция, что у одиночной привязки); роль для правила
        # ограниченного гостя — один запрос, если в пакете есть страницы.
        # RC-F1: версия источника задачи (`work_item_source_version`) читает текущих исполнителей — одним запросом
        # на пакет, а не запросом на пункт.
        visible_work_items = (
            {
                issue.id: issue
                for issue in get_visible_work_items(project=project, user=user, include_inactive=False)
                .filter(id__in=work_item_ids)
                .prefetch_related(current_assignees_prefetch())
            }
            if work_item_ids
            else {}
        )
        restricted_guest = (
            _user_is_restricted_guest(project=project, user=user)
            if any(data["entity_type"] == PpmCanvasEntityType.PAGE for data in valid)
            else None
        )
        for item, data, serializer in checked:
            if data is None:
                outcomes.append(
                    _error(
                        _item_shape_id(item),
                        code="BINDING_INVALID",
                        message="Пункт пакета не прошёл проверку.",
                        details=serializer.errors,
                    )
                )
                continue
            operation_id = data["client_operation_id"] or batch_client_operation_id(
                board_id=locked_board.id,
                shape_id=data["shape_id"],
                entity_type=data["entity_type"],
                entity_id=data["entity_id"],
            )
            try:
                with transaction.atomic():
                    binding, replay = create_binding(
                        board=locked_board,
                        project=project,
                        user=user,
                        shape_id=data["shape_id"],
                        entity_type=data["entity_type"],
                        entity_id=data["entity_id"],
                        client_operation_id=operation_id,
                        visible_work_items=visible_work_items,
                        restricted_guest=restricted_guest,
                    )
            except PpmProjectionConflict as conflict:
                outcomes.append(
                    _error(data["shape_id"], code=conflict.code, message=conflict.message, details=conflict.details)
                )
            except IntegrityError:
                outcomes.append(
                    _error(
                        data["shape_id"],
                        code="BINDING_CONFLICT",
                        message="Привязку не удалось сохранить: фигура или операция уже заняты.",
                    )
                )
            else:
                outcomes.append({"shape_id": binding.shape_id, "binding": binding, "replay": replay})

    created = [outcome["binding"] for outcome in outcomes if "binding" in outcome]
    payloads = serialize_bindings(
        bindings=created,
        access=access,
        user=user,
        project=project,
        restricted_guest=restricted_guest,
    )
    return [
        {
            "shape_id": outcome["shape_id"],
            "status": "created",
            "binding": {**payloads[outcome["binding"].id], "idempotent_replay": outcome["replay"]},
        }
        if "binding" in outcome
        else outcome
        for outcome in outcomes
    ]


def serialize_bindings(*, bindings, access, user, project, restricted_guest=None):
    """JSON привязок — побайтно как у одиночной привязки (`serialize_binding`), но задачи читаются одним запросом,
    а проверка ограниченного гостя делается один раз на пакет (как в `get_canvas_bindings_payload`); уже вычисленную
    для пакета (`restricted_guest`) не повторяем."""
    work_item_ids = [binding.entity_id for binding in bindings if binding.entity_type == PpmCanvasEntityType.WORK_ITEM]
    issues_by_id = {}
    if work_item_ids:
        issues = (
            get_visible_work_items(project=project, user=user, include_inactive=True)
            .filter(id__in=work_item_ids)
            .select_related("project", "workspace", "state")
            .prefetch_related(current_assignees_prefetch())
        )
        issues_by_id = {issue.id: issue for issue in issues}
    if restricted_guest is None and any(binding.entity_type == PpmCanvasEntityType.PAGE for binding in bindings):
        restricted_guest = _user_is_restricted_guest(project=project, user=user)
    payloads = {}
    for binding in bindings:
        if binding.entity_type == PpmCanvasEntityType.WORK_ITEM:
            issue = issues_by_id.get(binding.entity_id)
            source = (
                serialize_work_item(issue=issue, access=access)
                if issue
                else serialize_missing_work_item(binding=binding)
            )
            payloads[binding.id] = _serialize_resolved_binding(binding=binding, source=source)
        else:
            payloads[binding.id] = serialize_binding(
                binding=binding,
                access=access,
                user=user,
                project=project,
                restricted_guest=restricted_guest,
            )
    return payloads
