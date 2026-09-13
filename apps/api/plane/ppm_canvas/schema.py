import hashlib
import json

from rest_framework import serializers


PPM_CANVAS_SCHEMA_VERSION = 1
PPM_CANVAS_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024


def canonical_snapshot_bytes(snapshot):
    try:
        return json.dumps(
            snapshot,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise serializers.ValidationError("Snapshot must contain valid JSON values.") from error


def validate_canvas_snapshot(snapshot):
    if not isinstance(snapshot, dict):
        raise serializers.ValidationError("Snapshot must be a JSON object.")
    if not isinstance(snapshot.get("document"), dict):
        raise serializers.ValidationError("Snapshot document is missing or invalid.")

    encoded = canonical_snapshot_bytes(snapshot)
    if len(encoded) > PPM_CANVAS_MAX_SNAPSHOT_BYTES:
        raise serializers.ValidationError(f"Snapshot exceeds the {PPM_CANVAS_MAX_SNAPSHOT_BYTES} byte limit.")
    return snapshot


def canvas_snapshot_hash(snapshot):
    return hashlib.sha256(canonical_snapshot_bytes(snapshot)).hexdigest()
