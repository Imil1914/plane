"""AF2.2 S4 — на каких досках лежит задача (строка «На карте» в карточке задачи).

Поиск идёт по индексу `ppm_binding_source_idx` (workspace_id, project_id, entity_type, entity_id). Учитываются только
активные привязки на активных досках активного холста; ожидающие привязки (фигура ещё не сохранена) и архивные доски
не показываются. Права на доски у PPM — на уровне проекта: кто может читать Холст проекта, читает все его доски.
"""

from .models import PpmCanvasBinding, PpmCanvasBindingStatus, PpmCanvasEntityType, PpmCanvasStatus


WORK_ITEM_BOARDS_SCAN_LIMIT = 500


def get_work_item_boards(*, project, work_item_id):
    bindings = (
        PpmCanvasBinding.objects.filter(
            workspace_id=project.workspace_id,
            project_id=project.id,
            entity_type=PpmCanvasEntityType.WORK_ITEM,
            entity_id=work_item_id,
            status=PpmCanvasBindingStatus.ACTIVE,
            board__status=PpmCanvasStatus.ACTIVE,
            canvas__status=PpmCanvasStatus.ACTIVE,
        )
        .order_by("board__position", "board__created_at", "board_id", "created_at", "id")
        .values_list("board_id", "board__name", "shape_id")[:WORK_ITEM_BOARDS_SCAN_LIMIT]
    )
    results = []
    seen_boards = set()
    for board_id, name, shape_id in bindings:
        # Задача может лежать на доске несколькими карточками — в списке досок она одна, с первой по времени карточкой.
        if board_id in seen_boards:
            continue
        seen_boards.add(board_id)
        results.append({"board_id": str(board_id), "name": name, "shape_id": shape_id})
    return results
