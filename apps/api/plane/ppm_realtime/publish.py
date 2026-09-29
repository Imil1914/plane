"""UX2.1 U4 — publication of short project events after the transaction commits.

``publish_project_event`` is the one way to announce a change. It waits for ``transaction.on_commit`` (a rolled back
change is never announced), sends ids only — never data of a work item — and never breaks the request that saved the
change: with the flag off or without a channel layer it does nothing, a Redis failure is only logged (without the
exception text: it may carry connection credentials). Model signals (``signals.py``) call it for single saves; bulk
writes that send no signals (``update``, ``bulk_update``, ``bulk_create``, soft deletes of querysets) call it right
where they happen.

One commit — one group message per project: ``changes`` carries every entity at once (a work item together with the
sprints and directions whose numbers it changed), ``batch.publication_batch`` merges a whole cascade of saves (the
soft delete of a work item in Celery) into one. The sockets (``consumers.py``) turn messages into client events: at
most one event per (project, entity, id) every 250 ms, the ids of a burst in one event.
"""

import logging
import uuid

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from django.utils import timezone

from plane.db.models import CycleIssue, Issue, ModuleIssue

from .batch import held_publications
from .flags import realtime_events_enabled
from .protocol import ACTION_STRENGTH, ACTIONS, ENTITIES, GROUP_MESSAGE_TYPE, project_events_group_name


logger = logging.getLogger("plane.api")

# One message carries up to this many ids; a larger batch (thousands of work items at once) is split.
MAX_IDS_PER_MESSAGE = 2000


class _Pending:
    """What one project will be told after commit."""

    def __init__(self):
        self.changes = {}  # entity → {id: action}
        self.creators = {}  # work item id → creator id (None: unknown creator)
        self.with_memberships = set()  # work items whose sprints and directions changed their numbers too

    def add(self, entity, action, ids, creators=None, with_memberships=False):
        bucket = self.changes.setdefault(entity, {})
        for item_id in ids:
            known = bucket.get(item_id)
            if known is None or ACTION_STRENGTH[action] > ACTION_STRENGTH[known]:
                bucket[item_id] = action
        if creators:
            for item_id, creator_id in creators.items():
                self.creators.setdefault(item_id, creator_id)
        if with_memberships:
            self.with_memberships.update(ids)

    def merge(self, other):
        for entity, bucket in other.changes.items():
            for item_id, action in bucket.items():
                self.add(entity, action, [item_id])
        for item_id, creator_id in other.creators.items():
            self.creators.setdefault(item_id, creator_id)
        self.with_memberships |= other.with_memberships

    def __bool__(self):
        return any(self.changes.values())


def publish_project_event(project_id, entity, action, ids, *, visibility=None):
    """After commit, tell the subscribers of the project that ``ids`` of ``entity`` were ``action``.

    ``visibility`` — work items only, never sent to the client: item id → id of its creator, so that the socket of a
    guest who sees only own items (``guest_view_all_features=False``) keeps just those. Without it the creators are
    read after commit, and ids that are not live work items of this project are dropped (a deleted item keeps only
    its «deleted»).
    """
    _publish(project_id, [(entity, action, ids)], visibility=visibility)


def publish_issue_event(
    project_id, action, issue_ids, *, cycle_ids=(), module_ids=(), with_memberships=False, visibility=None
):
    """Work items changed, plus the sprints and directions whose lists, numbers and charts change with them — in one
    message.

    ``cycle_ids``/``module_ids`` name them explicitly (read them with ``issue_memberships`` before a write that removes
    the links); ``with_memberships`` finds the current ones after commit (writes that keep the links).
    """
    _publish(
        project_id,
        [("issue", action, issue_ids), ("cycle", "updated", cycle_ids), ("module", "updated", module_ids)],
        visibility=visibility,
        with_memberships=with_memberships,
    )


def publish_issue_instances(action, issues, *, with_memberships=False):
    """Work item instances changed by a bulk write, one message per project (sub-items may live in other projects)."""
    if not realtime_events_enabled():
        return
    creators_by_project = {}
    for issue in issues:
        creators_by_project.setdefault(issue.project_id, {})[issue.id] = issue.created_by_id
    for project_id, creators in creators_by_project.items():
        _publish(
            project_id, [("issue", action, list(creators))], visibility=creators, with_memberships=with_memberships
        )


def publish_projects_updated(project_ids):
    """Members or roles of these projects changed by a bulk write (``update()``): their sockets re-read access and the
    overviews refresh. ``project_ids`` may be a lazy queryset — it is read only when the channel is on."""
    if not realtime_events_enabled():
        return
    try:
        unique_ids = {str(project_id) for project_id in project_ids if project_id is not None}
    except Exception as exc:
        _log_failure("PPM realtime event could not read the projects", exc)
        return
    for project_id in unique_ids:
        publish_project_event(project_id, "project", "updated", [project_id])


def work_item_ids(queryset):
    """Ids of the work items a bulk write is about to change — read before it (the write may change what selects
    them)."""
    if not realtime_events_enabled():
        return []
    try:
        return [str(value) for value in queryset.values_list("id", flat=True)]
    except Exception as exc:
        _log_failure("PPM realtime event could not read the work items", exc)
        return []


def issue_memberships(issue_ids):
    """Current sprints and directions of the work items — read before a bulk write that removes the links."""
    if not realtime_events_enabled():
        return [], []
    try:
        ids = [value for value in issue_ids if value is not None]
        if not ids:
            return [], []
        return _memberships(ids)
    except Exception as exc:
        _log_failure("PPM realtime event could not read sprints and directions", exc)
        return [], []


def cycle_work_item_ids(cycle_id):
    """Ids of the work items currently in the sprint (to learn what a transfer moved)."""
    if not realtime_events_enabled():
        return set()
    try:
        return {str(value) for value in CycleIssue.objects.filter(cycle_id=cycle_id).values_list("issue_id", flat=True)}
    except Exception as exc:
        _log_failure("PPM realtime event could not read the sprint", exc)
        return set()


def schedule_held(held):
    """Send what a ``publication_batch`` held back: one message per project, after commit."""
    for project_id, pending in held.items():
        _schedule(project_id, pending)


# ---------------- internals ----------------


def _publish(project_id, parts, *, visibility=None, with_memberships=False):
    if not realtime_events_enabled():
        return
    try:
        project_key = str(uuid.UUID(str(project_id)))
        pending = _Pending()
        for entity, action, ids in parts:
            if entity not in ENTITIES or action not in ACTIONS:
                raise ValueError("unknown entity or action")
            normalized_ids = _normalized_ids(ids)
            pending.add(
                entity,
                action,
                normalized_ids,
                creators=_normalized_creators(visibility) if entity == "issue" and visibility is not None else None,
                with_memberships=entity == "issue" and with_memberships,
            )
    except (TypeError, ValueError, AttributeError):
        # A programming error of the caller: the change itself is saved, only the announcement is skipped.
        logger.warning(
            "PPM realtime event was not published: invalid arguments",
            extra={"ppm_realtime_parts": str([(str(part[0])[:32], str(part[1])[:32]) for part in parts])[:200]},
        )
        return
    if not pending:
        return
    held = held_publications()
    if held is not None:
        held.setdefault(project_key, _Pending()).merge(pending)
        return
    _schedule(project_key, pending)


def _schedule(project_id, pending):
    if not pending:
        return
    try:
        transaction.on_commit(lambda: _deliver(project_id, pending))
    except Exception as exc:
        _log_failure("PPM realtime event was not scheduled", exc, project_id=project_id)


def _normalized_ids(values):
    result = []
    seen = set()
    for value in values:
        if value is None:
            continue
        key = str(uuid.UUID(str(value)))
        if key not in seen:
            seen.add(key)
            result.append(key)
    return result


def _normalized_creators(visibility):
    return {str(uuid.UUID(str(key))): (str(value) if value else None) for key, value in visibility.items()}


def _deliver(project_id, pending):
    try:
        channel_layer = get_channel_layer()
        if channel_layer is None:
            # No channel layer configured: nobody can be listening.
            return
        changes = {entity: dict(bucket) for entity, bucket in pending.changes.items() if bucket}
        creators = dict(pending.creators)
        issues = changes.get("issue")
        if issues:
            _resolve_work_items(project_id, issues, creators)
            expand = [item_id for item_id in pending.with_memberships if item_id in issues]
            if expand:
                cycle_ids, module_ids = _memberships(expand, project_id=project_id)
                for entity, ids in (("cycle", cycle_ids), ("module", module_ids)):
                    bucket = changes.setdefault(entity, {})
                    for item_id in ids:
                        bucket.setdefault(item_id, "updated")
        changes = {entity: bucket for entity, bucket in changes.items() if bucket}
        if not changes:
            return
        send = async_to_sync(channel_layer.group_send)
        group = project_events_group_name(project_id)
        at = timezone.now().isoformat()
        for message_changes in _split(changes):
            message = {"type": GROUP_MESSAGE_TYPE, "project_id": project_id, "changes": message_changes, "at": at}
            if "issue" in message_changes:
                message["visibility"] = {item_id: creators.get(item_id) for item_id in message_changes["issue"]}
            send(group, message)
    except Exception as exc:
        # The commit is canonical: the change is saved and the web client catches up on reconnect or by polling.
        _log_failure(
            "PPM realtime event publish failed after commit",
            exc,
            project_id=project_id,
            count=sum(len(bucket) for bucket in pending.changes.values()),
        )


def _resolve_work_items(project_id, issues, creators):
    """Creators of the work items published without them; ids that are not live work items of the project are dropped
    (a deleted item keeps only its «deleted»)."""
    unknown = [item_id for item_id in issues if item_id not in creators]
    if not unknown:
        return
    rows = Issue.all_objects.filter(id__in=unknown, project_id=project_id).values_list(
        "id", "created_by_id", "deleted_at"
    )
    found = {
        str(item_id): (str(creator_id) if creator_id else None, deleted_at) for item_id, creator_id, deleted_at in rows
    }
    for item_id in unknown:
        row = found.get(item_id)
        if row is None or (row[1] is not None and issues[item_id] != "deleted"):
            issues.pop(item_id)
            continue
        creators[item_id] = row[0]


def _split(changes):
    """One message unless a batch is enormous; then parts of at most ``MAX_IDS_PER_MESSAGE`` ids."""
    total = sum(len(bucket) for bucket in changes.values())
    if total <= MAX_IDS_PER_MESSAGE:
        yield changes
        return
    part, size = {}, 0
    for entity, bucket in changes.items():
        for item_id, action in bucket.items():
            part.setdefault(entity, {})[item_id] = action
            size += 1
            if size == MAX_IDS_PER_MESSAGE:
                yield part
                part, size = {}, 0
    if part:
        yield part


def _memberships(issue_ids, *, project_id=None):
    cycles = CycleIssue.objects.filter(issue_id__in=issue_ids)
    modules = ModuleIssue.objects.filter(issue_id__in=issue_ids)
    if project_id is not None:
        cycles = cycles.filter(project_id=project_id)
        modules = modules.filter(project_id=project_id)
    cycle_ids = _normalized_ids(cycles.order_by().values_list("cycle_id", flat=True))
    module_ids = _normalized_ids(modules.order_by().values_list("module_id", flat=True))
    return cycle_ids, module_ids


def _log_failure(message, exc, **context):
    logger.warning(
        message,
        extra={
            **{f"ppm_realtime_{key}": value for key, value in context.items()},
            "error_type": type(exc).__name__,
        },
    )
