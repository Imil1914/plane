import hashlib
import json

from rest_framework import serializers


PPM_CANVAS_SCHEMA_VERSION = 2
PPM_CANVAS_READABLE_SCHEMA_VERSIONS = frozenset({1, PPM_CANVAS_SCHEMA_VERSION})
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


def canvas_snapshot_shape_ids(snapshot):
    """Id фигур снимка: `record.id`, а без него — ключ записи в `document.store` (только записи `typeName = "shape"`).

    AF2.2: это правило повторено там, где нужен не набор id, а SQL или сами записи, — менять только вместе:
    `changes._shape_records` (записи текущего снимка ленты «Что изменилось»), `changes.VERSION_SHAPE_IDS_SQL` (id фигур
    версии в SQL: `COALESCE(record.value ->> 'id', record.key)`), `services.PREVIOUS_VERSION_SHAPES_SQL` и
    `services._snapshot_node_texts` (отметки версии при сохранении, S2a)."""
    store = snapshot.get("document", {}).get("store", {})
    if not isinstance(store, dict):
        return set()
    return {
        str(record.get("id", record_id))
        for record_id, record in store.items()
        if isinstance(record, dict) and record.get("typeName") == "shape"
    }
