from dataclasses import dataclass
from enum import Enum
from typing import Any
from uuid import UUID

from .models import PpmAgentKind


class PpmAgentToolMode(str, Enum):
    READ = "read"
    PROPOSE = "propose"
    APPLY = "apply"


class PpmAgentRegistryError(ValueError):
    def __init__(self, *, code, message, details=None):
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)


@dataclass(frozen=True)
class PpmAgentToolDefinition:
    name: str
    mode: PpmAgentToolMode
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class PpmAgentDefinition:
    kind: str
    title: str
    description: str
    allowed_tools: tuple[str, ...]


def _object_schema(*, properties, required=()):
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
    }


STRING_ID = {"type": "string", "minLength": 1, "maxLength": 255}
UUID_STRING = {"type": "string", "format": "uuid"}

TOOL_REGISTRY = {
    "search_project_knowledge": PpmAgentToolDefinition(
        name="search_project_knowledge",
        mode=PpmAgentToolMode.READ,
        input_schema=_object_schema(
            properties={
                "query": {"type": "string", "minLength": 1, "maxLength": 500},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            required=("query",),
        ),
    ),
    "read_source_fragment": PpmAgentToolDefinition(
        name="read_source_fragment",
        mode=PpmAgentToolMode.READ,
        input_schema=_object_schema(
            properties={"source_type": STRING_ID, "source_id": STRING_ID, "chunk_id": UUID_STRING},
            required=("source_type", "source_id"),
        ),
    ),
    "list_work_items": PpmAgentToolDefinition(
        name="list_work_items",
        mode=PpmAgentToolMode.READ,
        input_schema=_object_schema(
            properties={
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "state_group": {
                    "type": "string",
                    "enum": ["backlog", "unstarted", "started", "completed", "cancelled"],
                },
            }
        ),
    ),
    "read_work_item": PpmAgentToolDefinition(
        name="read_work_item",
        mode=PpmAgentToolMode.READ,
        input_schema=_object_schema(properties={"work_item_id": UUID_STRING}, required=("work_item_id",)),
    ),
    "read_canvas_neighborhood": PpmAgentToolDefinition(
        name="read_canvas_neighborhood",
        mode=PpmAgentToolMode.READ,
        input_schema=_object_schema(
            properties={
                "board_id": UUID_STRING,
                "shape_ids": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1, "maxLength": 255},
                    "minItems": 1,
                    "maxItems": 50,
                },
                "depth": {"type": "integer", "minimum": 0, "maximum": 2},
            },
            required=("board_id", "shape_ids"),
        ),
    ),
    "read_vault_file": PpmAgentToolDefinition(
        name="read_vault_file",
        mode=PpmAgentToolMode.READ,
        input_schema=_object_schema(properties={"entry_id": UUID_STRING}, required=("entry_id",)),
    ),
    "read_git_metadata": PpmAgentToolDefinition(
        name="read_git_metadata",
        mode=PpmAgentToolMode.READ,
        input_schema=_object_schema(
            properties={
                "entity_type": {
                    "type": "string",
                    "enum": ["repository", "branch", "commit", "pull_request"],
                },
                "entity_id": UUID_STRING,
            },
            required=("entity_type", "entity_id"),
        ),
    ),
    "propose_work_items": PpmAgentToolDefinition(
        name="propose_work_items",
        mode=PpmAgentToolMode.PROPOSE,
        input_schema=_object_schema(
            properties={
                "items": {
                    "type": "array",
                    "items": _object_schema(
                        properties={
                            "title": {"type": "string", "minLength": 1, "maxLength": 255},
                            "description": {"type": "string", "maxLength": 10_000},
                            "acceptance_criteria": {
                                "type": "array",
                                "items": {"type": "string", "minLength": 1, "maxLength": 1_000},
                                "minItems": 1,
                                "maxItems": 20,
                            },
                            "source_ids": {
                                "type": "array",
                                "items": STRING_ID,
                                "minItems": 1,
                                "maxItems": 50,
                            },
                        },
                        required=("title", "acceptance_criteria", "source_ids"),
                    ),
                    "minItems": 1,
                    "maxItems": 10,
                }
            },
            required=("items",),
        ),
    ),
    "propose_semantic_edges": PpmAgentToolDefinition(
        name="propose_semantic_edges",
        mode=PpmAgentToolMode.PROPOSE,
        input_schema=_object_schema(
            properties={
                "edges": {
                    "type": "array",
                    "items": _object_schema(
                        properties={
                            "board_id": UUID_STRING,
                            "from_shape_id": STRING_ID,
                            "to_shape_id": STRING_ID,
                            "relation": {
                                "type": "string",
                                "enum": [
                                    "relates_to",
                                    "depends_on",
                                    "blocks",
                                    "explains",
                                    "implements",
                                    "evidence_for",
                                    "contradicts",
                                    "derived_from",
                                    "result_of",
                                ],
                            },
                            "reason": {"type": "string", "minLength": 1, "maxLength": 1_000},
                            "source_ids": {
                                "type": "array",
                                "items": STRING_ID,
                                "minItems": 1,
                                "maxItems": 50,
                            },
                        },
                        required=(
                            "board_id",
                            "from_shape_id",
                            "to_shape_id",
                            "relation",
                            "reason",
                            "source_ids",
                        ),
                    ),
                    "minItems": 1,
                    "maxItems": 50,
                }
            },
            required=("edges",),
        ),
    ),
    "propose_page_or_vault_note": PpmAgentToolDefinition(
        name="propose_page_or_vault_note",
        mode=PpmAgentToolMode.PROPOSE,
        input_schema=_object_schema(
            properties={
                "target": {"type": "string", "enum": ["page", "vault_markdown"]},
                "title": {"type": "string", "minLength": 1, "maxLength": 255},
                "body": {"type": "string", "minLength": 1, "maxLength": 50_000},
                "source_ids": {
                    "type": "array",
                    "items": STRING_ID,
                    "minItems": 1,
                    "maxItems": 50,
                },
            },
            required=("target", "title", "body", "source_ids"),
        ),
    ),
    "create_work_items_from_action": PpmAgentToolDefinition(
        name="create_work_items_from_action",
        mode=PpmAgentToolMode.APPLY,
        input_schema=_object_schema(properties={"action_id": UUID_STRING}, required=("action_id",)),
    ),
    "apply_semantic_edges": PpmAgentToolDefinition(
        name="apply_semantic_edges",
        mode=PpmAgentToolMode.APPLY,
        input_schema=_object_schema(properties={"action_id": UUID_STRING}, required=("action_id",)),
    ),
    "write_vault_file_from_action": PpmAgentToolDefinition(
        name="write_vault_file_from_action",
        mode=PpmAgentToolMode.APPLY,
        input_schema=_object_schema(properties={"action_id": UUID_STRING}, required=("action_id",)),
    ),
    "create_git_branch_from_action": PpmAgentToolDefinition(
        name="create_git_branch_from_action",
        mode=PpmAgentToolMode.APPLY,
        input_schema=_object_schema(properties={"action_id": UUID_STRING}, required=("action_id",)),
    ),
    "create_pull_request_from_action": PpmAgentToolDefinition(
        name="create_pull_request_from_action",
        mode=PpmAgentToolMode.APPLY,
        input_schema=_object_schema(properties={"action_id": UUID_STRING}, required=("action_id",)),
    ),
}


COMMON_READ_TOOLS = (
    "search_project_knowledge",
    "read_source_fragment",
    "list_work_items",
    "read_work_item",
    "read_canvas_neighborhood",
    "read_vault_file",
    "read_git_metadata",
)

AGENT_REGISTRY = {
    PpmAgentKind.PROJECT_REPORTER: PpmAgentDefinition(
        kind=PpmAgentKind.PROJECT_REPORTER,
        title="Сводка проекта",
        description="Готовит проверяемую сводку проекта с источниками.",
        allowed_tools=COMMON_READ_TOOLS + ("propose_page_or_vault_note",),
    ),
    PpmAgentKind.WORK_DECOMPOSER: PpmAgentDefinition(
        kind=PpmAgentKind.WORK_DECOMPOSER,
        title="Декомпозиция работы",
        description="Предлагает задачи с критериями приёмки и зависимостями.",
        allowed_tools=COMMON_READ_TOOLS + ("propose_work_items",),
    ),
    PpmAgentKind.KNOWLEDGE_LIBRARIAN: PpmAgentDefinition(
        kind=PpmAgentKind.KNOWLEDGE_LIBRARIAN,
        title="Библиотекарь знаний",
        description="Находит пробелы и предлагает аккуратные изменения базы знаний.",
        allowed_tools=COMMON_READ_TOOLS + ("propose_page_or_vault_note",),
    ),
    PpmAgentKind.RELATIONSHIP_ANALYST: PpmAgentDefinition(
        kind=PpmAgentKind.RELATIONSHIP_ANALYST,
        title="Аналитик связей",
        description="Предлагает типизированные смысловые связи на холсте.",
        allowed_tools=COMMON_READ_TOOLS + ("propose_semantic_edges",),
    ),
}


def _validation_error(path, message):
    raise PpmAgentRegistryError(
        code="AGENT_TOOL_PAYLOAD_INVALID",
        message="Параметры инструмента не соответствуют разрешённой схеме.",
        details={"path": path or "$", "reason": message},
    )


def _validate_schema(value, schema, *, path="$"):
    expected_type = schema.get("type")
    if expected_type == "object":
        if not isinstance(value, dict):
            _validation_error(path, "ожидается объект")
        properties = schema.get("properties", {})
        unknown = sorted(set(value) - set(properties))
        if unknown and not schema.get("additionalProperties", True):
            _validation_error(path, f"неизвестные поля: {', '.join(unknown)}")
        for required in schema.get("required", []):
            if required not in value:
                _validation_error(path, f"отсутствует поле {required}")
        for key, item in value.items():
            if key in properties:
                _validate_schema(item, properties[key], path=f"{path}.{key}")
        return
    if expected_type == "array":
        if not isinstance(value, list):
            _validation_error(path, "ожидается список")
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
            _validation_error(path, "недопустимое количество элементов")
        for index, item in enumerate(value):
            _validate_schema(item, schema["items"], path=f"{path}[{index}]")
        return
    if expected_type == "string":
        if not isinstance(value, str):
            _validation_error(path, "ожидается строка")
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
            _validation_error(path, "недопустимая длина строки")
        if "enum" in schema and value not in schema["enum"]:
            _validation_error(path, "значение не входит в allowlist")
        if schema.get("format") == "uuid":
            try:
                UUID(value)
            except (TypeError, ValueError) as exc:
                raise PpmAgentRegistryError(
                    code="AGENT_TOOL_PAYLOAD_INVALID",
                    message="Параметры инструмента не соответствуют разрешённой схеме.",
                    details={"path": path, "reason": "ожидается UUID"},
                ) from exc
        return
    if expected_type == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            _validation_error(path, "ожидается целое число")
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            _validation_error(path, "число вне разрешённого диапазона")
        return
    _validation_error(path, "неподдерживаемый тип схемы")


def get_agent_definition(agent_kind):
    definition = AGENT_REGISTRY.get(str(agent_kind))
    if definition is None:
        raise PpmAgentRegistryError(code="AGENT_KIND_NOT_ALLOWED", message="Неизвестный тип проектного агента.")
    return definition


def get_agent_tool_definition(tool_name):
    tool = TOOL_REGISTRY.get(str(tool_name))
    if tool is None:
        raise PpmAgentRegistryError(
            code="AGENT_TOOL_NOT_ALLOWED",
            message="Инструмент не входит в allowlist проектных агентов.",
            details={"tool_name": str(tool_name)},
        )
    return tool


def validate_agent_tool_call(*, agent_kind, tool_name, payload):
    agent = get_agent_definition(agent_kind)
    try:
        tool = get_agent_tool_definition(tool_name)
    except PpmAgentRegistryError as exc:
        raise PpmAgentRegistryError(
            code="AGENT_TOOL_NOT_ALLOWED",
            message="Агенту запрещён этот инструмент.",
            details={"agent_kind": agent.kind, "tool_name": str(tool_name)},
        ) from exc
    if tool.name not in agent.allowed_tools or tool.mode == PpmAgentToolMode.APPLY:
        raise PpmAgentRegistryError(
            code="AGENT_TOOL_NOT_ALLOWED",
            message="Агенту запрещён этот инструмент.",
            details={"agent_kind": agent.kind, "tool_name": str(tool_name)},
        )
    _validate_schema(payload, tool.input_schema)
    return tool


def validate_approved_action_tool_call(*, tool_name, payload):
    try:
        tool = get_agent_tool_definition(tool_name)
    except PpmAgentRegistryError as exc:
        raise PpmAgentRegistryError(
            code="AGENT_APPLIER_NOT_ALLOWED",
            message="Инструмент не входит в allowlist применения подтверждённых действий.",
        ) from exc
    if tool.mode != PpmAgentToolMode.APPLY:
        raise PpmAgentRegistryError(
            code="AGENT_APPLIER_NOT_ALLOWED",
            message="Инструмент не входит в allowlist применения подтверждённых действий.",
        )
    _validate_schema(payload, tool.input_schema)
    return tool


def serialize_agent_registry():
    return [
        {
            "kind": agent.kind,
            "title": agent.title,
            "description": agent.description,
            "tools": [
                {
                    "name": TOOL_REGISTRY[name].name,
                    "mode": TOOL_REGISTRY[name].mode.value,
                    "input_schema": TOOL_REGISTRY[name].input_schema,
                }
                for name in agent.allowed_tools
            ],
        }
        for agent in AGENT_REGISTRY.values()
    ]
