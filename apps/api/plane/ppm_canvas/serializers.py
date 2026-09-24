from rest_framework import serializers

from plane.db.models import Issue

from .models import (
    PpmCanvasEntityType,
    PpmSemanticEdgeConfirmationStatus,
    PpmSemanticEdgeOrigin,
    PpmSemanticRelationType,
)
from .schema import PPM_CANVAS_SCHEMA_VERSION, validate_canvas_snapshot


class PpmCanvasBindingChangesSerializer(serializers.Serializer):
    activate = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        default=list,
        allow_empty=True,
        max_length=100,
    )
    remove = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        default=list,
        allow_empty=True,
        max_length=100,
    )

    def validate(self, attrs):
        activate = attrs["activate"]
        remove = attrs["remove"]
        if len(activate) != len(set(activate)):
            raise serializers.ValidationError({"activate": "Binding IDs must be unique."})
        if len(remove) != len(set(remove)):
            raise serializers.ValidationError({"remove": "Binding IDs must be unique."})
        overlap = set(activate) & set(remove)
        if overlap:
            raise serializers.ValidationError("A binding cannot be activated and removed in one save.")
        return attrs


class PpmCanvasSaveSerializer(serializers.Serializer):
    schema_version = serializers.IntegerField(min_value=PPM_CANVAS_SCHEMA_VERSION, max_value=PPM_CANVAS_SCHEMA_VERSION)
    base_version = serializers.IntegerField(min_value=0)
    snapshot = serializers.JSONField()
    client_operation_id = serializers.UUIDField()
    binding_changes = PpmCanvasBindingChangesSerializer(required=False, default=dict)

    def validate_snapshot(self, value):
        return validate_canvas_snapshot(value)


class PpmCanvasBoardCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, trim_whitespace=True)
    client_operation_id = serializers.UUIDField()


class PpmCanvasBoardPatchSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, trim_whitespace=True)
    client_operation_id = serializers.UUIDField()


class PpmCanvasBoardOperationSerializer(serializers.Serializer):
    client_operation_id = serializers.UUIDField()


class PpmCanvasBoardReorderSerializer(serializers.Serializer):
    board_ids = serializers.ListField(
        child=serializers.UUIDField(),
        min_length=1,
        max_length=100,
    )
    client_operation_id = serializers.UUIDField()

    def validate_board_ids(self, value):
        if len(value) != len(set(value)):
            raise serializers.ValidationError("Board IDs must be unique.")
        return value


class PpmCanvasBoardDuplicateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120, trim_whitespace=True, required=False, allow_blank=True, default="")
    client_operation_id = serializers.UUIDField()


class PpmCanvasSemanticEdgeCreateSerializer(serializers.Serializer):
    from_shape_id = serializers.RegexField(r"^shape:[A-Za-z0-9_-]+$", max_length=255)
    to_shape_id = serializers.RegexField(r"^shape:[A-Za-z0-9_-]+$", max_length=255)
    relation_type = serializers.ChoiceField(choices=PpmSemanticRelationType.choices)
    label = serializers.CharField(max_length=255, required=False, allow_blank=True, allow_null=True, default=None)
    confidence = serializers.DecimalField(
        max_digits=5,
        decimal_places=4,
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
        default=None,
    )
    origin = serializers.ChoiceField(
        choices=PpmSemanticEdgeOrigin.choices,
        required=False,
        default=PpmSemanticEdgeOrigin.USER,
    )
    client_operation_id = serializers.UUIDField()

    def validate(self, attrs):
        if attrs["from_shape_id"] == attrs["to_shape_id"]:
            raise serializers.ValidationError("Semantic edge must connect two different shapes.")
        attrs["confirmation_status"] = (
            PpmSemanticEdgeConfirmationStatus.PROPOSED
            if attrs["origin"] == PpmSemanticEdgeOrigin.AGENT
            else PpmSemanticEdgeConfirmationStatus.CONFIRMED
        )
        return attrs


class PpmCanvasSemanticEdgePatchSerializer(serializers.Serializer):
    relation_type = serializers.ChoiceField(choices=PpmSemanticRelationType.choices, required=False)
    label = serializers.CharField(max_length=255, required=False, allow_blank=True, allow_null=True)
    confidence = serializers.DecimalField(
        max_digits=5,
        decimal_places=4,
        min_value=0,
        max_value=1,
        required=False,
        allow_null=True,
    )
    confirmation_status = serializers.ChoiceField(
        choices=(
            PpmSemanticEdgeConfirmationStatus.CONFIRMED,
            PpmSemanticEdgeConfirmationStatus.REJECTED,
        ),
        required=False,
    )

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("At least one editable field is required.")
        return attrs


class PpmProjectionSearchSerializer(serializers.Serializer):
    types = serializers.CharField(required=False, default=PpmCanvasEntityType.WORK_ITEM)
    q = serializers.CharField(required=False, default="", allow_blank=True, max_length=160, trim_whitespace=True)
    cursor = serializers.IntegerField(required=False, default=0, min_value=0)
    limit = serializers.IntegerField(required=False, default=20, min_value=1, max_value=50)

    def validate_types(self, value):
        entity_types = {item.strip() for item in value.split(",") if item.strip()}
        if entity_types != {PpmCanvasEntityType.WORK_ITEM}:
            raise serializers.ValidationError("Only work_item projections are available in this release.")
        return [PpmCanvasEntityType.WORK_ITEM]


class PpmWorkItemsViewQuerySerializer(serializers.Serializer):
    q = serializers.CharField(required=False, default="", allow_blank=True, max_length=160, trim_whitespace=True)
    cursor = serializers.IntegerField(required=False, default=0, min_value=0)
    limit = serializers.IntegerField(required=False, default=100, min_value=1, max_value=100)
    state_ids = serializers.CharField(required=False, default="", allow_blank=True)
    priorities = serializers.CharField(required=False, default="", allow_blank=True)
    assignee_ids = serializers.CharField(required=False, default="", allow_blank=True)
    include_archived = serializers.BooleanField(required=False, default=False)
    sort = serializers.ChoiceField(
        choices=(
            "updated_desc",
            "updated_asc",
            "created_desc",
            "created_asc",
            "due_asc",
            "due_desc",
        ),
        required=False,
        default="updated_desc",
    )

    def validate_state_ids(self, value):
        return self._uuid_list(value, "state_ids")

    def validate_assignee_ids(self, value):
        return self._uuid_list(value, "assignee_ids")

    def validate_priorities(self, value):
        priorities = self._string_list(value)
        allowed = {item for item, _ in Issue.PRIORITY_CHOICES}
        invalid = set(priorities) - allowed
        if invalid:
            raise serializers.ValidationError("Unknown priority value.")
        return priorities

    @staticmethod
    def _string_list(value):
        items = [item.strip() for item in value.split(",") if item.strip()]
        if len(items) != len(set(items)):
            raise serializers.ValidationError("Filter values must be unique.")
        return items

    @classmethod
    def _uuid_list(cls, value, field_name):
        values = cls._string_list(value)
        uuid_field = serializers.UUIDField()
        try:
            return [uuid_field.run_validation(item) for item in values]
        except serializers.ValidationError as error:
            raise serializers.ValidationError(f"{field_name} must contain UUID values.") from error


class PpmCanvasBindingCreateSerializer(serializers.Serializer):
    shape_id = serializers.RegexField(r"^shape:[A-Za-z0-9_-]+$", max_length=255)
    entity_type = serializers.ChoiceField(choices=PpmCanvasEntityType.choices)
    entity_id = serializers.UUIDField()
    client_operation_id = serializers.UUIDField()


class PpmWorkItemCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, trim_whitespace=True)
    shape_id = serializers.RegexField(r"^shape:[A-Za-z0-9_-]+$", max_length=255)
    client_operation_id = serializers.UUIDField()
    state_id = serializers.UUIDField(required=False)
    priority = serializers.ChoiceField(choices=[value for value, _ in Issue.PRIORITY_CHOICES], required=False)
    assignee_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        max_length=50,
    )
    due_date = serializers.DateField(required=False, allow_null=True)

    def validate_assignee_ids(self, value):
        if len(value) != len(set(value)):
            raise serializers.ValidationError("Assignee IDs must be unique.")
        return value


class PpmWorkItemViewCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, trim_whitespace=True)
    client_operation_id = serializers.UUIDField()
    state_id = serializers.UUIDField(required=False)
    priority = serializers.ChoiceField(choices=[value for value, _ in Issue.PRIORITY_CHOICES], required=False)
    assignee_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        max_length=50,
    )
    due_date = serializers.DateField(required=False, allow_null=True)

    def validate_assignee_ids(self, value):
        if len(value) != len(set(value)):
            raise serializers.ValidationError("Assignee IDs must be unique.")
        return value


class PpmWorkItemPatchSerializer(serializers.Serializer):
    source_version = serializers.CharField(max_length=64)
    state_id = serializers.UUIDField(required=False)
    priority = serializers.ChoiceField(choices=[value for value, _ in Issue.PRIORITY_CHOICES], required=False)
    assignee_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        max_length=50,
    )
    due_date = serializers.DateField(required=False, allow_null=True)

    def validate_assignee_ids(self, value):
        if len(value) != len(set(value)):
            raise serializers.ValidationError("Assignee IDs must be unique.")
        return value

    def validate(self, attrs):
        if not any(field in attrs for field in ("state_id", "priority", "assignee_ids", "due_date")):
            raise serializers.ValidationError("At least one editable field is required.")
        return attrs
