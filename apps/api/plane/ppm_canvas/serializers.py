from rest_framework import serializers

from .schema import PPM_CANVAS_SCHEMA_VERSION, validate_canvas_snapshot


class PpmCanvasSaveSerializer(serializers.Serializer):
    schema_version = serializers.IntegerField(min_value=PPM_CANVAS_SCHEMA_VERSION, max_value=PPM_CANVAS_SCHEMA_VERSION)
    base_version = serializers.IntegerField(min_value=0)
    snapshot = serializers.JSONField()
    client_operation_id = serializers.UUIDField()

    def validate_snapshot(self, value):
        return validate_canvas_snapshot(value)
