/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (раунд 3): что панель делает по нажатию — без React и сторов. Всё внешнее (подтверждение, удаление и
// изменение задач, выделение, тост) приходит функциями, поэтому поведение проверяется тестами в среде node
// (apps/web/tests/ppm-bulk/bulk-flow.test.ts); root.tsx только подключает сторы.
import type { TEntityDetails } from "@/hooks/use-multiple-select";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import {
  canPpmDeleteIssue,
  describePpmBulkDelete,
  describePpmBulkUpdate,
  formatPpmBulkCount,
  planPpmAssigneeChange,
  planPpmBulkDelete,
  planPpmCycleChange,
  planPpmStateChange,
  ppmBulkRunGuard,
  runPpmBulkDelete,
  runPpmCycleChange,
  runPpmFieldChanges,
} from "./bulk-actions";
import type {
  TPpmBulkDeletePlan,
  TPpmBulkDeleteRights,
  TPpmBulkFieldChange,
  TPpmBulkIssue,
  TPpmBulkOutcome,
  TPpmBulkRunGuard,
  TPpmBulkToast,
  TPpmBulkTranslate,
  TPpmGetParentId,
} from "./bulk-actions";

export type TPpmBulkFlowResult =
  | { status: "done"; outcome: TPpmBulkOutcome }
  | { status: "busy" | "cancelled" | "empty" | "error" };

export type TPpmBulkFlowIO = {
  translate: TPpmBulkTranslate;
  locale: string | undefined;
  /** Одна блокировка на приложение (по умолчанию общая): второе действие не начинается, пока идёт первое. */
  guard?: TPpmBulkRunGuard;
  notify: (toast: TPpmBulkToast) => void;
  /** Снять выделение с задач — только с успешно обработанных. */
  deselect: (issueIds: string[]) => void;
  /** Вернуть в выделение строки неудачных задач, которые оптимистичное обновление успело убрать из списка. */
  reselect: (entities: TEntityDetails[]) => void;
};

// ---------------- удаление ----------------

export type TPpmBulkDeleteDialog = {
  /** «Удалить 3 задачи?» */
  title: string;
  /** «Можно удалить K из N: …», «Вместе с ними удалятся подзадачи: M», «Это действие нельзя отменить.» */
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
  /** Первый фокус — на «Отмена»: два Enter подряд не удаляют N задач. */
  initialFocus: "secondary";
};

export type TPpmBulkDeleteIO = TPpmBulkFlowIO & {
  /** Права — как у обычного диалога удаления: автор задачи или администратор проекта. */
  rights: TPpmBulkDeleteRights;
  /** Родитель невыделенной задачи по данным списка — для цепочки «предок удаляется». */
  getParentId?: TPpmGetParentId;
  confirm: (dialog: TPpmBulkDeleteDialog) => Promise<boolean>;
  /** Действие обычного удаления (useIssuesActions → removeIssue). */
  removeIssue: (projectId: string, issueId: string) => Promise<unknown>;
  /** Убрать из списка строки задач, которые сервер удалил вместе с предком (их не отправляли). */
  removeFromList: (issueIds: string[]) => void;
};

/** Текст подтверждения по плану: числа — только то, что действительно удалится. */
export function describePpmBulkDeleteDialog(
  plan: TPpmBulkDeletePlan,
  translate: TPpmBulkTranslate,
  locale: string | undefined
): TPpmBulkDeleteDialog {
  const lines: string[] = [];
  if (plan.deleteCount < plan.total)
    lines.push(formatPpmTemplate(translate("bulk.delete_partial"), { allowed: plan.deleteCount, total: plan.total }));
  if (plan.extraSubItemsCount > 0)
    lines.push(formatPpmTemplate(translate("bulk.delete_sub_items"), { count: plan.extraSubItemsCount }));
  lines.push(translate("bulk.delete_body"));
  return {
    title: formatPpmBulkCount(translate, "bulk.delete_title", plan.deleteCount, locale),
    lines,
    confirmLabel: translate("bulk.delete_confirm"),
    cancelLabel: translate("confirm.cancel"),
    initialFocus: "secondary",
  };
}

/** Строки выделения неудачных задач — вернуть в выделение, если список их на время убрал. */
function failedSelection(selection: readonly TEntityDetails[], outcome: TPpmBulkOutcome): TEntityDetails[] {
  const failed = new Set([...outcome.failedIds, ...outcome.deniedIds]);
  const seen = new Set<string>();
  return selection.filter((entity) => {
    if (!failed.has(entity.entityID) || seen.has(entity.entityID)) return false;
    seen.add(entity.entityID);
    return true;
  });
}

export async function runPpmBulkDeleteFlow(
  selectedIssues: readonly TPpmBulkIssue[],
  io: TPpmBulkDeleteIO,
  selection: readonly TEntityDetails[] = []
): Promise<TPpmBulkFlowResult> {
  const guard = io.guard ?? ppmBulkRunGuard;
  if (guard.isBusy()) return { status: "busy" };
  const plan = planPpmBulkDelete(selectedIssues, (issue) => canPpmDeleteIssue(issue, io.rights), io.getParentId);
  if (plan.deleteCount === 0) return { status: "empty" };
  const confirmed = await io.confirm(describePpmBulkDeleteDialog(plan, io.translate, io.locale));
  if (!confirmed) return { status: "cancelled" };
  try {
    const result = await guard.run(async () => {
      const outcome = await runPpmBulkDelete(plan, io.removeIssue);
      if (outcome.cascadedIds.length > 0) io.removeFromList(outcome.cascadedIds);
      return outcome;
    });
    if (!result.started) return { status: "busy" };
    const outcome = result.value;
    if (outcome.succeededIds.length > 0) io.deselect(outcome.succeededIds);
    const restore = failedSelection(selection, outcome);
    if (restore.length > 0) io.reselect(restore);
    io.notify(describePpmBulkDelete(outcome, io.translate, io.locale));
    return { status: "done", outcome };
  } catch {
    notifyUnexpected(io);
    return { status: "error" };
  }
}

// ---------------- статус, исполнитель, спринт ----------------

export type TPpmBulkUpdateCommand =
  | { kind: "state"; stateId: string }
  | { kind: "assignee"; memberId: string | null }
  | { kind: "cycle"; cycleId: string | null };

export type TPpmBulkUpdateIO = TPpmBulkFlowIO & {
  updateIssue: (projectId: string, issueId: string, data: TPpmBulkFieldChange["data"]) => Promise<unknown>;
  /** Массовый метод стора: один POST …/cycles/<id>/cycle-issues/. */
  addIssuesToCycle: (projectId: string, cycleId: string, issueIds: string[]) => Promise<unknown>;
  removeIssueFromCycle: (projectId: string, issueId: string) => Promise<unknown>;
  /** После изменения спринтов — обновить счётчики открытого спринта одним запросом. */
  refreshCycleStats?: (projectId: string) => void;
};

async function runPpmBulkUpdate(
  selectedIssues: readonly TPpmBulkIssue[],
  command: TPpmBulkUpdateCommand,
  io: TPpmBulkUpdateIO
): Promise<TPpmBulkOutcome> {
  const applyChange = (change: TPpmBulkFieldChange) => io.updateIssue(change.projectId, change.issueId, change.data);
  if (command.kind === "state")
    return runPpmFieldChanges(planPpmStateChange(selectedIssues, command.stateId), applyChange);
  if (command.kind === "assignee")
    return runPpmFieldChanges(planPpmAssigneeChange(selectedIssues, command.memberId), applyChange);
  const plan = planPpmCycleChange(selectedIssues, command.cycleId);
  const outcome = await runPpmCycleChange(plan, {
    addIssuesToCycle: io.addIssuesToCycle,
    removeIssueFromCycle: io.removeIssueFromCycle,
  });
  if (plan.projectId && outcome.succeededIds.length > 0)
    try {
      io.refreshCycleStats?.(plan.projectId);
    } catch {
      // счётчики обновятся при следующей загрузке спринта
    }
  return outcome;
}

export async function runPpmBulkUpdateFlow(
  selectedIssues: readonly TPpmBulkIssue[],
  selection: readonly TEntityDetails[],
  command: TPpmBulkUpdateCommand,
  io: TPpmBulkUpdateIO
): Promise<TPpmBulkFlowResult> {
  const guard = io.guard ?? ppmBulkRunGuard;
  const labels = Object.fromEntries(selectedIssues.map((issue) => [issue.id, issue.label]));
  try {
    const result = await guard.run(() => runPpmBulkUpdate(selectedIssues, command, io));
    if (!result.started) return { status: "busy" };
    const outcome = result.value;
    const done = [...outcome.succeededIds, ...outcome.unchangedIds];
    if (done.length > 0) io.deselect(done);
    // «Без спринта» на странице этого спринта убирает строку из списка до ответа сервера — неудачу возвращаем.
    const restore = failedSelection(selection, outcome);
    if (restore.length > 0) io.reselect(restore);
    io.notify(describePpmBulkUpdate(outcome, labels, io.translate, io.locale));
    return { status: "done", outcome };
  } catch {
    notifyUnexpected(io);
    return { status: "error" };
  }
}

function notifyUnexpected(io: TPpmBulkFlowIO) {
  io.notify({
    type: "error",
    title: io.translate("bulk.toast_failed"),
    message: io.translate("bulk.unexpected_error"),
  });
}
