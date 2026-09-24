from collections import defaultdict, deque

from plane.ppm_canvas.models import (
    PpmCanvasBinding,
    PpmCanvasBindingStatus,
    PpmCanvasBoard,
    PpmCanvasEntityType,
    PpmCanvasSemanticEdge,
    PpmCanvasStatus,
    PpmSemanticEdgeConfirmationStatus,
)

from .flags import graph_enabled
from .models import PpmKnowledgeSourceType
from .services import PpmBrainConflict


MAX_GRAPH_DEPTH = 2


def normalize_graph_depth(value):
    try:
        depth = int(value)
    except (TypeError, ValueError) as exc:
        raise PpmBrainConflict(
            code="BRAIN_INVALID_GRAPH_DEPTH", message="Глубина графа должна быть от 0 до 2."
        ) from exc
    if depth < 0 or depth > MAX_GRAPH_DEPTH:
        raise PpmBrainConflict(code="BRAIN_INVALID_GRAPH_DEPTH", message="Глубина графа должна быть от 0 до 2.")
    return depth


def _knowledge_source_key(entity_type, entity_id):
    if entity_type == PpmCanvasEntityType.WORK_ITEM:
        return PpmKnowledgeSourceType.WORK_ITEM, str(entity_id)
    if entity_type == PpmCanvasEntityType.VAULT_FILE:
        return PpmKnowledgeSourceType.VAULT_FILE, str(entity_id)
    return None


def _edge_step(edge, *, traversal_direction):
    return {
        "edge_id": str(edge.id),
        "from_shape_id": edge.from_shape_id,
        "to_shape_id": edge.to_shape_id,
        "relation_type": edge.relation_type,
        "label": edge.label,
        "traversal_direction": traversal_direction,
    }


def resolve_graph_context(*, workspace_id, project_id, board_id, selected_shape_ids, graph_depth=1):
    requested_depth = normalize_graph_depth(graph_depth)
    depth = requested_depth if graph_enabled() else 0
    selected_shape_ids = list(dict.fromkeys(str(shape_id) for shape_id in selected_shape_ids or []))
    if not selected_shape_ids:
        return (
            None,
            {
                "mode": "project",
                "selected": 0,
                "bound_sources": 0,
                "graph": {
                    "enabled": False,
                    "requested_depth": requested_depth,
                    "applied_depth": 0,
                    "neighbor_shapes": 0,
                    "confirmed_edges_considered": 0,
                    "source_paths": [],
                },
            },
            {},
        )
    if not board_id:
        raise PpmBrainConflict(
            code="BRAIN_SELECTION_BOARD_REQUIRED",
            message="Для выбранного контекста укажите доску холста.",
        )
    board = PpmCanvasBoard.objects.filter(
        id=board_id,
        workspace_id=workspace_id,
        project_id=project_id,
        status=PpmCanvasStatus.ACTIVE,
    ).first()
    if board is None:
        raise PpmBrainConflict(code="BRAIN_BOARD_NOT_FOUND", message="Доска холста не найдена.")

    edges = []
    if depth > 0:
        edges = list(
            PpmCanvasSemanticEdge.objects.filter(
                workspace_id=workspace_id,
                project_id=project_id,
                board=board,
                confirmation_status=PpmSemanticEdgeConfirmationStatus.CONFIRMED,
            ).order_by("created_at", "id")
        )
    adjacency = defaultdict(list)
    for edge in edges:
        adjacency[edge.from_shape_id].append((edge.to_shape_id, edge, "forward"))
        adjacency[edge.to_shape_id].append((edge.from_shape_id, edge, "reverse"))

    paths_by_shape = {shape_id: [] for shape_id in selected_shape_ids}
    distances = {shape_id: 0 for shape_id in selected_shape_ids}
    queue = deque(selected_shape_ids)
    while queue:
        shape_id = queue.popleft()
        current_depth = distances[shape_id]
        if current_depth >= depth:
            continue
        for neighbor_id, edge, traversal_direction in adjacency.get(shape_id, []):
            if neighbor_id in distances:
                continue
            distances[neighbor_id] = current_depth + 1
            paths_by_shape[neighbor_id] = [
                *paths_by_shape[shape_id],
                _edge_step(edge, traversal_direction=traversal_direction),
            ]
            queue.append(neighbor_id)

    bindings = PpmCanvasBinding.objects.filter(
        workspace_id=workspace_id,
        project_id=project_id,
        board=board,
        shape_id__in=distances,
        status=PpmCanvasBindingStatus.ACTIVE,
    ).order_by("created_at", "id")
    paths_by_source = {}
    shape_by_source = {}
    for binding in bindings:
        source_key = _knowledge_source_key(binding.entity_type, binding.entity_id)
        if source_key is None:
            continue
        candidate_path = paths_by_shape[binding.shape_id]
        existing = paths_by_source.get(source_key)
        if existing is None or len(candidate_path) < len(existing):
            paths_by_source[source_key] = candidate_path
            shape_by_source[source_key] = binding.shape_id

    source_paths = [
        {
            "source_type": source_type,
            "source_id": source_id,
            "shape_id": shape_by_source[(source_type, source_id)],
            "depth": len(path),
            "edges": path,
        }
        for (source_type, source_id), path in sorted(
            paths_by_source.items(),
            key=lambda item: (len(item[1]), item[0][0], item[0][1]),
        )
    ]
    neighbor_shapes = [shape_id for shape_id, item_depth in distances.items() if item_depth > 0]
    scope = {
        "mode": "selection",
        "selected": len(selected_shape_ids),
        "bound_sources": len(paths_by_source),
        "graph": {
            "enabled": depth > 0,
            "requested_depth": requested_depth,
            "applied_depth": max(distances.values(), default=0),
            "neighbor_shapes": len(neighbor_shapes),
            "confirmed_edges_considered": len(edges),
            "source_paths": source_paths,
        },
    }
    return list(paths_by_source), scope, paths_by_source
