import logging
import traceback
from pathlib import PurePath

from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from plane.db.models import Issue
from plane.ppm_vault.models import PpmVaultEntry, PpmVaultEntryKind, PpmVaultEntryStatus, PpmVaultIndexPolicy

from .flags import brain_enabled
from .memory import refresh_project_memory_freshness
from .models import PpmKnowledgeSource, PpmKnowledgeSourceType
from .services import exclude_source, request_source_index


logger = logging.getLogger("plane.api")


def _error_location(exc):
    """Место ошибки — файл, строка и функция последнего кадра кода PPM/Plane: только код, без данных."""
    frames = traceback.extract_tb(exc.__traceback__)
    own = [frame for frame in frames if "/plane/" in frame.filename.replace("\\", "/")] or frames
    if not own:
        return ""
    frame = own[-1]
    return f"{PurePath(frame.filename).name}:{frame.lineno} {frame.name}"


def _after_commit(operation, callback, **context):
    """RC-F1 (D-1): побочные действия Мозга после фиксации (индексация, исключение источника, свежесть памяти)
    никогда не влияют на сохранение, которое их вызвало. В autocommit-режиме (обычный запрос Plane) колбэк
    выполняется прямо внутри `save()`, и исключение ушло бы в ответ API (500) — данные при этом уже сохранены; внутри
    транзакции оно оборвало бы остальные `on_commit`-колбэки той же транзакции (например, задачи журнала Plane).
    Ошибка пишется в лог без текста исключения и без содержимого источника (там могут быть персональные данные):
    только операция, идентификаторы и тип/место ошибки. Пропущенную индексацию догонит сверка
    `reconcile_all_brain_projects` (каждые 15 минут), неотправленное задание — `recover_brain_index_jobs`."""

    def run():
        try:
            callback()
        except Exception as exc:
            logger.error(
                "PPM Project Brain side effect failed after commit; the saved data is kept",
                extra={
                    "ppm_brain_operation": operation,
                    **{key: str(value) for key, value in context.items()},
                    "error_type": type(exc).__name__,
                    "error_location": _error_location(exc),
                },
            )

    transaction.on_commit(run)


def _dispatch_index(*, operation, workspace_id, project_id, source_type, source_id):
    _after_commit(
        operation,
        lambda: request_source_index(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            dispatch=True,
        ),
        workspace_id=workspace_id,
        project_id=project_id,
        source_type=source_type,
        source_id=source_id,
    )


def _dispatch_exclude(*, operation, workspace_id, project_id, source_type, source_id, deleted):
    _after_commit(
        operation,
        lambda: exclude_source(
            workspace_id=workspace_id,
            project_id=project_id,
            source_type=source_type,
            source_id=source_id,
            deleted=deleted,
        ),
        workspace_id=workspace_id,
        project_id=project_id,
        source_type=source_type,
        source_id=source_id,
    )


@receiver(post_save, sender=Issue, dispatch_uid="ppm_brain_issue_saved")
def issue_saved(sender, instance, **kwargs):
    if not brain_enabled():
        return
    if instance.deleted_at is not None or instance.is_draft:
        _dispatch_exclude(
            operation="exclude_work_item",
            workspace_id=instance.workspace_id,
            project_id=instance.project_id,
            source_type=PpmKnowledgeSourceType.WORK_ITEM,
            source_id=instance.id,
            deleted=True,
        )
        return
    _dispatch_index(
        operation="index_work_item",
        workspace_id=instance.workspace_id,
        project_id=instance.project_id,
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=instance.id,
    )


@receiver(post_delete, sender=Issue, dispatch_uid="ppm_brain_issue_deleted")
def issue_deleted(sender, instance, **kwargs):
    if not brain_enabled():
        return
    _dispatch_exclude(
        operation="exclude_work_item",
        workspace_id=instance.workspace_id,
        project_id=instance.project_id,
        source_type=PpmKnowledgeSourceType.WORK_ITEM,
        source_id=instance.id,
        deleted=True,
    )


@receiver(post_save, sender=PpmVaultEntry, dispatch_uid="ppm_brain_vault_entry_saved")
def vault_entry_saved(sender, instance, **kwargs):
    if not brain_enabled():
        return
    if instance.kind not in {PpmVaultEntryKind.MARKDOWN, PpmVaultEntryKind.PDF}:
        return
    if instance.status != PpmVaultEntryStatus.ACTIVE or instance.index_policy == PpmVaultIndexPolicy.EXCLUDE:
        _dispatch_exclude(
            operation="exclude_vault_file",
            workspace_id=instance.workspace_id,
            project_id=instance.project_id,
            source_type=PpmKnowledgeSourceType.VAULT_FILE,
            source_id=instance.id,
            deleted=instance.status == PpmVaultEntryStatus.TRASHED,
        )
        return
    if instance.current_version_id:
        _dispatch_index(
            operation="index_vault_file",
            workspace_id=instance.workspace_id,
            project_id=instance.project_id,
            source_type=PpmKnowledgeSourceType.VAULT_FILE,
            source_id=instance.id,
        )


@receiver(post_save, sender=PpmKnowledgeSource, dispatch_uid="ppm_brain_memory_freshness")
def knowledge_source_saved(sender, instance, **kwargs):
    _after_commit(
        "refresh_memory_freshness",
        lambda: refresh_project_memory_freshness(
            workspace_id=instance.workspace_id,
            project_id=instance.project_id,
        ),
        workspace_id=instance.workspace_id,
        project_id=instance.project_id,
    )
