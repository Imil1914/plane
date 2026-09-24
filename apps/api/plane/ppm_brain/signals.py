from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from plane.db.models import Issue
from plane.ppm_vault.models import PpmVaultEntry, PpmVaultEntryKind, PpmVaultEntryStatus, PpmVaultIndexPolicy

from .flags import brain_enabled
from .memory import refresh_project_memory_freshness
from .models import PpmKnowledgeSource, PpmKnowledgeSourceType
from .services import exclude_source, request_source_index


def _dispatch_index(*, workspace_id, project_id, source_type, source_id):
    transaction.on_commit(
        lambda: request_source_index(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            dispatch=True,
        )
    )


@receiver(post_save, sender=Issue, dispatch_uid="ppm_brain_issue_saved")
def issue_saved(sender, instance, **kwargs):
    if not brain_enabled():
        return
    if instance.deleted_at is not None or instance.is_draft:
        transaction.on_commit(
            lambda: exclude_source(
                workspace_id=instance.workspace_id,
                project_id=instance.project_id,
                source_type=PpmKnowledgeSourceType.WORK_ITEM,
                source_id=instance.id,
                deleted=True,
            )
        )
        return
    _dispatch_index(
        workspace_id=instance.workspace_id,
        project_id=instance.project_id,
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=instance.id,
    )


@receiver(post_delete, sender=Issue, dispatch_uid="ppm_brain_issue_deleted")
def issue_deleted(sender, instance, **kwargs):
    if not brain_enabled():
        return
    transaction.on_commit(
        lambda: exclude_source(
            workspace_id=instance.workspace_id,
            project_id=instance.project_id,
            source_type=PpmKnowledgeSourceType.WORK_ITEM,
            source_id=instance.id,
            deleted=True,
        )
    )


@receiver(post_save, sender=PpmVaultEntry, dispatch_uid="ppm_brain_vault_entry_saved")
def vault_entry_saved(sender, instance, **kwargs):
    if not brain_enabled():
        return
    if instance.kind not in {PpmVaultEntryKind.MARKDOWN, PpmVaultEntryKind.PDF}:
        return
    if instance.status != PpmVaultEntryStatus.ACTIVE or instance.index_policy == PpmVaultIndexPolicy.EXCLUDE:
        transaction.on_commit(
            lambda: exclude_source(
                workspace_id=instance.workspace_id,
                project_id=instance.project_id,
                source_type=PpmKnowledgeSourceType.VAULT_FILE,
                source_id=instance.id,
                deleted=instance.status == PpmVaultEntryStatus.TRASHED,
            )
        )
        return
    if instance.current_version_id:
        _dispatch_index(
            workspace_id=instance.workspace_id,
            project_id=instance.project_id,
            source_type=PpmKnowledgeSourceType.VAULT_FILE,
            source_id=instance.id,
        )


@receiver(post_save, sender=PpmKnowledgeSource, dispatch_uid="ppm_brain_memory_freshness")
def knowledge_source_saved(sender, instance, **kwargs):
    transaction.on_commit(
        lambda: refresh_project_memory_freshness(
            workspace_id=instance.workspace_id,
            project_id=instance.project_id,
        )
    )
