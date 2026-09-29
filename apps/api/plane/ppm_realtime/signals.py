"""UX2.1 U4 — model signals that announce changes of work items, sprints, directions and projects after commit.

Only saves and deletes of single instances send signals. Bulk writes (``update``, ``bulk_update``, ``bulk_create``,
soft deletes of querysets) call ``plane.ppm_realtime.publish`` themselves where they happen. A soft delete is a save
with ``deleted_at`` — «deleted»; a hard delete of a row users already saw deleted (the periodic purge) is silent.
Each save publishes one message: the work item together with the sprints and directions whose numbers it changed.
"""

from django.db.models.signals import post_delete, post_init, post_save
from django.dispatch import receiver

from plane.db.models import (
    Cycle,
    CycleIssue,
    Issue,
    IssueAssignee,
    IssueLabel,
    Module,
    ModuleIssue,
    Project,
    ProjectMember,
)

from .flags import realtime_events_enabled
from .publish import publish_issue_event, publish_project_event


# ``issue_activity`` bumps ``updated_at`` after every journal entry: nothing a list shows has changed.
TIMESTAMP_ONLY = frozenset({"updated_at"})
# Fields of a work item that change the numbers and charts of its sprints and directions. Name, description (saved
# again and again while typing), assignees and labels do not — they are announced for the item alone.
WORK_ITEM_STATS_FIELDS = (
    "state_id",
    "estimate_point_id",
    "completed_at",
    "archived_at",
    "start_date",
    "target_date",
    "priority",
    "parent_id",
    "deleted_at",
    "is_draft",
)
_ARCHIVED_AT = WORK_ITEM_STATS_FIELDS.index("archived_at")
_DELETED_AT = WORK_ITEM_STATS_FIELDS.index("deleted_at")
# What decides who may read a project; view settings and preferences of a membership do not.
MEMBERSHIP_FIELDS = ("member_id", "role", "is_active", "deleted_at")
# A deferred field is not read (that would cost a query per loaded row); it counts as changed when it is saved loaded.
_NOT_LOADED = object()


def _loaded(instance, fields):
    return tuple(instance.__dict__.get(field, _NOT_LOADED) for field in fields)


def _skip_save(kwargs):
    if kwargs.get("raw") or not realtime_events_enabled():
        return True
    update_fields = kwargs.get("update_fields")
    return update_fields is not None and set(update_fields) <= TIMESTAMP_ONLY


def _skip_delete(instance):
    return not realtime_events_enabled() or getattr(instance, "deleted_at", None) is not None


def _saved_action(instance, created):
    if created:
        return "created"
    return "deleted" if instance.deleted_at is not None else "updated"


# ---------------- work items ----------------


@receiver(post_init, sender=Issue, dispatch_uid="ppm_realtime_issue_loaded")
def issue_loaded(sender, instance, **kwargs):
    instance._ppm_realtime_stats = _loaded(instance, WORK_ITEM_STATS_FIELDS)


@receiver(post_save, sender=Issue, dispatch_uid="ppm_realtime_issue_saved")
def issue_saved(sender, instance, created, **kwargs):
    previous = getattr(instance, "_ppm_realtime_stats", None)
    current = _loaded(instance, WORK_ITEM_STATS_FIELDS)
    instance._ppm_realtime_stats = current
    if _skip_save(kwargs):
        return
    if created:
        # A new item is in no sprint yet; adding it to one is announced by the link.
        publish_issue_event(
            instance.project_id, "created", [instance.id], visibility={instance.id: instance.created_by_id}
        )
        return
    changed = previous is None or previous != current
    deleted_at = current[_DELETED_AT]
    if deleted_at is not None and deleted_at is not _NOT_LOADED:
        action = "deleted"
    elif previous is not None and previous[_ARCHIVED_AT] != current[_ARCHIVED_AT]:
        # Archived or taken back: the item leaves or re-enters the lists.
        action = "moved"
    else:
        action = "updated"
    publish_issue_event(
        instance.project_id,
        action,
        [instance.id],
        visibility={instance.id: instance.created_by_id},
        with_memberships=changed,
    )


@receiver(post_delete, sender=Issue, dispatch_uid="ppm_realtime_issue_deleted")
def issue_deleted(sender, instance, **kwargs):
    if _skip_delete(instance):
        return
    publish_issue_event(instance.project_id, "deleted", [instance.id], visibility={instance.id: instance.created_by_id})


@receiver(post_save, sender=IssueAssignee, dispatch_uid="ppm_realtime_issue_assignee_saved")
@receiver(post_save, sender=IssueLabel, dispatch_uid="ppm_realtime_issue_label_saved")
def work_item_detail_saved(sender, instance, **kwargs):
    if _skip_save(kwargs):
        return
    publish_issue_event(instance.project_id, "updated", [instance.issue_id])


@receiver(post_delete, sender=IssueAssignee, dispatch_uid="ppm_realtime_issue_assignee_deleted")
@receiver(post_delete, sender=IssueLabel, dispatch_uid="ppm_realtime_issue_label_deleted")
def work_item_detail_deleted(sender, instance, **kwargs):
    if _skip_delete(instance):
        return
    publish_issue_event(instance.project_id, "updated", [instance.issue_id])


# ---------------- sprints and directions ----------------


@receiver(post_save, sender=Cycle, dispatch_uid="ppm_realtime_cycle_saved")
@receiver(post_save, sender=Module, dispatch_uid="ppm_realtime_module_saved")
def plan_item_saved(sender, instance, created, **kwargs):
    if _skip_save(kwargs):
        return
    entity = "cycle" if sender is Cycle else "module"
    publish_project_event(instance.project_id, entity, _saved_action(instance, created), [instance.id])


@receiver(post_delete, sender=Cycle, dispatch_uid="ppm_realtime_cycle_deleted")
@receiver(post_delete, sender=Module, dispatch_uid="ppm_realtime_module_deleted")
def plan_item_deleted(sender, instance, **kwargs):
    if _skip_delete(instance):
        return
    publish_project_event(instance.project_id, "cycle" if sender is Cycle else "module", "deleted", [instance.id])


# A membership row can be pointed to another sprint or direction by a save: remember where it was loaded from, so that
# the one it left is announced too.
@receiver(post_init, sender=CycleIssue, dispatch_uid="ppm_realtime_cycle_issue_loaded")
def cycle_issue_loaded(sender, instance, **kwargs):
    instance._ppm_realtime_plan_id = instance.__dict__.get("cycle_id")


@receiver(post_init, sender=ModuleIssue, dispatch_uid="ppm_realtime_module_issue_loaded")
def module_issue_loaded(sender, instance, **kwargs):
    instance._ppm_realtime_plan_id = instance.__dict__.get("module_id")


def _plan_ids(instance, current):
    previous = getattr(instance, "_ppm_realtime_plan_id", None)
    instance._ppm_realtime_plan_id = current
    return [current, previous]


@receiver(post_save, sender=CycleIssue, dispatch_uid="ppm_realtime_cycle_issue_saved")
def cycle_issue_saved(sender, instance, **kwargs):
    cycle_ids = _plan_ids(instance, instance.cycle_id)
    if _skip_save(kwargs):
        return
    publish_issue_event(instance.project_id, "moved", [instance.issue_id], cycle_ids=cycle_ids)


@receiver(post_save, sender=ModuleIssue, dispatch_uid="ppm_realtime_module_issue_saved")
def module_issue_saved(sender, instance, **kwargs):
    module_ids = _plan_ids(instance, instance.module_id)
    if _skip_save(kwargs):
        return
    publish_issue_event(instance.project_id, "moved", [instance.issue_id], module_ids=module_ids)


@receiver(post_delete, sender=CycleIssue, dispatch_uid="ppm_realtime_cycle_issue_deleted")
def cycle_issue_deleted(sender, instance, **kwargs):
    if _skip_delete(instance):
        return
    publish_issue_event(instance.project_id, "moved", [instance.issue_id], cycle_ids=[instance.cycle_id])


@receiver(post_delete, sender=ModuleIssue, dispatch_uid="ppm_realtime_module_issue_deleted")
def module_issue_deleted(sender, instance, **kwargs):
    if _skip_delete(instance):
        return
    publish_issue_event(instance.project_id, "moved", [instance.issue_id], module_ids=[instance.module_id])


# ---------------- projects and their members ----------------


@receiver(post_save, sender=Project, dispatch_uid="ppm_realtime_project_saved")
def project_saved(sender, instance, created, **kwargs):
    # A new project has no subscribers yet.
    if created or _skip_save(kwargs):
        return
    publish_project_event(instance.id, "project", _saved_action(instance, created), [instance.id])


@receiver(post_delete, sender=Project, dispatch_uid="ppm_realtime_project_deleted")
def project_deleted(sender, instance, **kwargs):
    if _skip_delete(instance):
        return
    publish_project_event(instance.id, "project", "deleted", [instance.id])


@receiver(post_init, sender=ProjectMember, dispatch_uid="ppm_realtime_project_member_loaded")
def project_member_loaded(sender, instance, **kwargs):
    instance._ppm_realtime_membership = _loaded(instance, MEMBERSHIP_FIELDS)


@receiver(post_save, sender=ProjectMember, dispatch_uid="ppm_realtime_project_member_saved")
def project_member_saved(sender, instance, created, **kwargs):
    previous = getattr(instance, "_ppm_realtime_membership", None)
    current = _loaded(instance, MEMBERSHIP_FIELDS)
    instance._ppm_realtime_membership = current
    if kwargs.get("raw") or not realtime_events_enabled():
        return
    if not created and previous == current:
        return
    # Members and roles show in the project overview; the sockets of the project re-read their access on this event.
    publish_project_event(instance.project_id, "project", "updated", [instance.project_id])


@receiver(post_delete, sender=ProjectMember, dispatch_uid="ppm_realtime_project_member_deleted")
def project_member_deleted(sender, instance, **kwargs):
    if _skip_delete(instance):
        return
    publish_project_event(instance.project_id, "project", "updated", [instance.project_id])
