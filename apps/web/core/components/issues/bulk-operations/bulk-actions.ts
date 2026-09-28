/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (просьба владельца 2026-09-28): логика панели массовых действий без React и сторов — что доступно для
// выделения, что и куда отправить, как собрать итог. Сеть и сторы приходят снаружи функциями, поэтому всё проверяется
// тестами в среде node (apps/web/tests/ppm-bulk).
import type { TPpmTranslationKey } from "@ppm/brand";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import { selectPpmPluralKey } from "@/components/ppm-tasks/sprint";
import type { TPpmPluralKey } from "@/components/ppm-tasks/sprint";

/** Значение пунктов «Без исполнителя» и «Без спринта» в меню панели. */
export const PPM_BULK_NONE = "__ppm_bulk_none__";
/** Сколько задач обновляется одновременно, когда у стора нет массового метода. */
export const PPM_BULK_CONCURRENCY = 5;
/** Сколько задач назвать в итоге, остальные — «и ещё N». */
export const PPM_BULK_FAILED_LIST_LIMIT = 5;

export type TPpmBulkTranslate = (key: TPpmTranslationKey) => string;

/** Выделенная задача глазами панели: только то, что нужно для решений и итога. */
export type TPpmBulkIssue = {
  id: string;
  projectId: string | null;
  /** Как задачу назвать в итоге: «ROBOT-12». */
  label: string;
  stateId: string | null;
  assigneeIds: string[];
  cycleId: string | null;
  /** Кто создал задачу (created_by) — автор может удалить свою задачу и без прав администратора. */
  createdBy: string | null;
  /** Родитель (parent_id): удаление родителя удаляет и его подзадачи — на сервере, как при обычном удалении. */
  parentId: string | null;
  /** Сколько у задачи прямых подзадач (sub_issues_count) — для строки «Вместе с ними удалятся подзадачи: M». */
  subIssuesCount: number;
};

/**
 * Каждая задача один раз: при группировке по исполнителю, метке или направлению она стоит в нескольких группах и
 * могла попасть в выделение дважды.
 */
export function uniquePpmIssues(issues: readonly TPpmBulkIssue[]): TPpmBulkIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.id)) return false;
    seen.add(issue.id);
    return true;
  });
}

/** Итог действия: успешно изменённые, уже имевшие нужное значение, неудачи и не отправленные из-за прав. */
export type TPpmBulkOutcome = {
  succeededIds: string[];
  unchangedIds: string[];
  failedIds: string[];
  deniedIds: string[];
};

export type TPpmBulkToast = { type: "success" | "warning" | "error"; title: string; message: string };

// ---------------- формы числа ----------------

export type TPpmBulkPluralBase =
  | "bulk.selected"
  | "bulk.delete_title"
  | "bulk.deleted"
  | "bulk.not_deleted_rights"
  | "bulk.not_deleted_error"
  | "bulk.updated";

/** Ключ нужной формы числа; отсутствие любой формы в словаре — ошибка компиляции. */
export function getPpmBulkPluralKey(base: TPpmBulkPluralBase, count: number, locale: string | undefined) {
  const key: `${TPpmBulkPluralBase}_${TPpmPluralKey}` = `${base}_${selectPpmPluralKey(count, locale)}`;
  const checked: TPpmTranslationKey = key;
  return checked;
}

/** «Выбрано: 5 задач», «Удалить 1 задачу?» — строка словаря нужной формы с подставленным числом. */
export function formatPpmBulkCount(
  translate: TPpmBulkTranslate,
  base: TPpmBulkPluralBase,
  count: number,
  locale: string | undefined
): string {
  return formatPpmTemplate(translate(getPpmBulkPluralKey(base, count, locale)), { count });
}

// ---------------- что доступно ----------------

export type TPpmBulkRules = {
  /** Может ли пользователь удалить задачу — правило обычного удаления, см. canPpmDeleteIssue. */
  canDelete: (issue: TPpmBulkIssue) => boolean;
  /** Включены ли в проекте спринты. */
  isSprintEnabled: (projectId: string) => boolean;
};

export type TPpmBulkDeleteRights = {
  currentUserId: string | undefined;
  /** Администратор проекта (глобальный администратор PPM — администратор всех проектов). */
  isProjectAdmin: (projectId: string) => boolean;
};

/**
 * Права на удаление — те же, что у обычного диалога удаления задачи (issues/delete-issue-modal.tsx) и у сервера
 * (IssueViewSet.destroy: allow_permission([ADMIN], creator=True)): автор задачи или администратор её проекта.
 */
export function canPpmDeleteIssue(issue: TPpmBulkIssue, rights: TPpmBulkDeleteRights): boolean {
  if (!issue.projectId) return false;
  const isCreator = !!rights.currentUserId && issue.createdBy === rights.currentUserId;
  return isCreator || rights.isProjectAdmin(issue.projectId);
}

export type TPpmBulkAvailability = {
  total: number;
  /** Проекты выделения в порядке первого появления. */
  projectIds: string[];
  /** Проект, если все выделенные задачи из одного проекта. */
  singleProjectId: string | null;
  /** null — кнопка доступна; иначе ключ подсказки, почему нет. */
  statusHintKey: TPpmTranslationKey | null;
  assigneeHintKey: TPpmTranslationKey | null;
  sprintHintKey: TPpmTranslationKey | null;
  deleteHintKey: TPpmTranslationKey | null;
  /** Сколько выделенных задач удалится (см. planPpmBulkDelete) — «Можно удалить K из N». */
  deletableCount: number;
};

export function getPpmBulkProjectIds(issues: readonly TPpmBulkIssue[]): string[] {
  const ids: string[] = [];
  for (const issue of issues) if (issue.projectId && !ids.includes(issue.projectId)) ids.push(issue.projectId);
  return ids;
}

export function getPpmBulkAvailability(
  selected: readonly TPpmBulkIssue[],
  rules: TPpmBulkRules & { getParentId?: TPpmGetParentId }
): TPpmBulkAvailability {
  const issues = uniquePpmIssues(selected);
  const projectIds = getPpmBulkProjectIds(issues);
  const total = issues.length;
  const singleProjectId = projectIds.length === 1 && issues.every((issue) => issue.projectId) ? projectIds[0] : null;
  const deletableCount = planPpmBulkDelete(issues, rules.canDelete, rules.getParentId).deleteCount;
  if (total === 0)
    return {
      total,
      projectIds,
      singleProjectId: null,
      statusHintKey: "bulk.empty_hint",
      assigneeHintKey: "bulk.empty_hint",
      sprintHintKey: "bulk.empty_hint",
      deleteHintKey: "bulk.empty_hint",
      deletableCount: 0,
    };
  // Статусы и спринты свои у каждого проекта — только для задач одного проекта.
  const projectFieldsHintKey: TPpmTranslationKey | null = singleProjectId ? null : "bulk.one_project_hint";
  return {
    total,
    projectIds,
    singleProjectId,
    statusHintKey: projectFieldsHintKey,
    assigneeHintKey: null,
    sprintHintKey:
      projectFieldsHintKey ?? (rules.isSprintEnabled(singleProjectId ?? "") ? null : "bulk.sprints_off_hint"),
    deleteHintKey: deletableCount > 0 ? null : "bulk.delete_no_rights_hint",
    deletableCount,
  };
}

// ---------------- удаление ----------------

/** Родитель задачи по данным списка (parent_id); null — задача верхнего уровня, undefined — неизвестно. */
export type TPpmGetParentId = (issueId: string) => string | null | undefined;

const MAX_PARENT_DEPTH = 50;

/** Предки задачи от ближайшего, по данным списка; защищено от циклов в данных. */
function collectPpmAncestors(issue: TPpmBulkIssue, getParentId: TPpmGetParentId): string[] {
  const ancestors: string[] = [];
  let parentId = issue.parentId ?? getParentId(issue.id) ?? null;
  while (parentId && !ancestors.includes(parentId) && parentId !== issue.id && ancestors.length < MAX_PARENT_DEPTH) {
    ancestors.push(parentId);
    parentId = getParentId(parentId) ?? null;
  }
  return ancestors;
}

export type TPpmBulkDeletePlan = {
  /** Задачи, которые отправляем сразу — по одной, как обычный диалог удаления, в порядке выделения. */
  items: { issueId: string; projectId: string }[];
  /**
   * Выделенные задачи, чей предок тоже удаляется: сервер удалит их вместе с ним (как при обычном удалении родителя),
   * поэтому их не отправляем — иначе второе удаление упало бы и строка осталась бы в списке.
   */
  cascadeIds: string[];
  /** Не удалятся: нет прав (не автор и не администратор проекта) и нет удаляемого предка. */
  deniedIds: string[];
  /** Выделено задач (без повторов) — N. */
  total: number;
  /** Сколько выделенных задач удалится: отправленные и ушедшие вместе с предком — K. */
  deleteCount: number;
  /** Подзадачи вне выделения, которые удалятся вместе с родителями (по sub_issues_count) — M. */
  extraSubItemsCount: number;
  /** Для повторных шагов, если предок не удалился: предки каждой задачи, права и проекты. */
  ancestorsOf: Record<string, string[]>;
  allowedIds: string[];
  projectOf: Record<string, string>;
};

export function planPpmBulkDelete(
  selected: readonly TPpmBulkIssue[],
  canDelete: (issue: TPpmBulkIssue) => boolean,
  getParentId: TPpmGetParentId = () => undefined
): TPpmBulkDeletePlan {
  const issues = uniquePpmIssues(selected);
  const known = new Map(issues.map((issue) => [issue.id, issue]));
  const parentOf: TPpmGetParentId = (id) => (known.has(id) ? (known.get(id)?.parentId ?? null) : getParentId(id));
  const ancestorsOf = Object.fromEntries(issues.map((issue) => [issue.id, collectPpmAncestors(issue, parentOf)]));
  const allowed = new Set(issues.filter((issue) => !!issue.projectId && canDelete(issue)).map((issue) => issue.id));
  const hasDeletingAncestor = (issue: TPpmBulkIssue) => ancestorsOf[issue.id].some((id) => allowed.has(id));

  const items: TPpmBulkDeletePlan["items"] = [];
  const cascadeIds: string[] = [];
  const deniedIds: string[] = [];
  const projectOf: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.projectId) projectOf[issue.id] = issue.projectId;
    if (hasDeletingAncestor(issue)) cascadeIds.push(issue.id);
    else if (issue.projectId && allowed.has(issue.id)) items.push({ issueId: issue.id, projectId: issue.projectId });
    else deniedIds.push(issue.id);
  }

  const deleted = new Set([...items.map((item) => item.issueId), ...cascadeIds]);
  const directSubItems = issues
    .filter((issue) => deleted.has(issue.id))
    .reduce((sum, issue) => sum + Math.max(0, issue.subIssuesCount), 0);
  const selectedSubItems = issues.filter((issue) => !!issue.parentId && deleted.has(issue.parentId)).length;
  return {
    items,
    cascadeIds,
    deniedIds,
    total: issues.length,
    deleteCount: deleted.size,
    extraSubItemsCount: Math.max(0, directSubItems - selectedSubItems),
    ancestorsOf,
    allowedIds: [...allowed],
    projectOf,
  };
}

type TPpmErrorLike = { status?: unknown; error?: unknown; detail?: unknown; response?: { status?: unknown } };

/**
 * Сервер отказал в правах. Сервис задач бросает тело ответа без кода: allow_permission отвечает
 * «You don't have the required permissions.», DRF — «You do not have permission…».
 */
export function isPpmPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as TPpmErrorLike;
  if (value.status === 403 || value.response?.status === 403) return true;
  const message = [value.error, value.detail].find((part): part is string => typeof part === "string") ?? "";
  return /permission|admin or creator/i.test(message);
}

export type TPpmBulkDeleteOutcome = TPpmBulkOutcome & {
  /** Удалены сервером вместе с предком (их не отправляли) — строки убрать из списка вручную. */
  cascadedIds: string[];
};

/**
 * Удаляет по одной задаче — тем же действием, что и обычный диалог удаления (история, уведомления, вебхуки, списки и
 * счётчики — как при обычном удалении), не больше `limit` одновременно; неудача одной не мешает другим. Шагами: сначала
 * задачи без удаляемого предка; удалился предок — его выделенные потомки удалены сервером вместе с ним; не удался —
 * потомки с правами отправляются следующим шагом, без прав — «нет прав».
 */
export async function runPpmBulkDelete(
  plan: TPpmBulkDeletePlan,
  removeIssue: (projectId: string, issueId: string) => Promise<unknown>,
  limit = PPM_BULK_CONCURRENCY
): Promise<TPpmBulkDeleteOutcome> {
  const allowed = new Set(plan.allowedIds);
  const ancestorsOf = (id: string) => plan.ancestorsOf[id] ?? [];
  const remaining = new Set([...plan.items.map((item) => item.issueId), ...plan.cascadeIds]);
  const outcome: TPpmBulkDeleteOutcome = {
    succeededIds: [],
    unchangedIds: [],
    failedIds: [],
    deniedIds: [...plan.deniedIds],
    cascadedIds: [],
  };
  let round = plan.items.map((item) => item.issueId);
  while (round.length > 0) {
    const refusedIds = new Set<string>();
    // Шаг ждёт свой предыдущий: потомков отправляем, только если их предок не удалился.
    // oxlint-disable-next-line no-await-in-loop
    const { fulfilled } = await runPpmWithConcurrency(round, limit, async (issueId) => {
      try {
        await removeIssue(plan.projectOf[issueId], issueId);
      } catch (error) {
        if (isPpmPermissionError(error)) refusedIds.add(issueId);
        throw error;
      }
    });
    for (const issueId of round) {
      remaining.delete(issueId);
      if (!fulfilled.includes(issueId)) {
        (refusedIds.has(issueId) ? outcome.deniedIds : outcome.failedIds).push(issueId);
        continue;
      }
      outcome.succeededIds.push(issueId);
      for (const descendantId of [...remaining].filter((id) => ancestorsOf(id).includes(issueId))) {
        remaining.delete(descendantId);
        outcome.succeededIds.push(descendantId);
        outcome.cascadedIds.push(descendantId);
      }
    }
    // Следующий шаг — задачи с правами, у которых не осталось удаляемого предка (его удаление не удалось).
    round = [...remaining].filter(
      (id) =>
        allowed.has(id) && !ancestorsOf(id).some((ancestorId) => remaining.has(ancestorId) && allowed.has(ancestorId))
    );
  }
  // Остались задачи без прав, чьи удаляемые предки не удалились.
  outcome.deniedIds.push(...remaining);
  return outcome;
}

// ---------------- статус, исполнитель ----------------

export type TPpmBulkFieldChange = {
  issueId: string;
  projectId: string;
  data: { state_id: string } | { assignee_ids: string[] };
};

export type TPpmBulkFieldPlan = { changes: TPpmBulkFieldChange[]; unchangedIds: string[] };

export function planPpmStateChange(selected: readonly TPpmBulkIssue[], stateId: string): TPpmBulkFieldPlan {
  const plan: TPpmBulkFieldPlan = { changes: [], unchangedIds: [] };
  for (const issue of uniquePpmIssues(selected)) {
    if (issue.stateId === stateId || !issue.projectId) plan.unchangedIds.push(issue.id);
    else plan.changes.push({ issueId: issue.id, projectId: issue.projectId, data: { state_id: stateId } });
  }
  return plan;
}

/** Исполнитель ЗАМЕНЯЕТ исполнителей задачи; null — «Без исполнителя». */
export function planPpmAssigneeChange(selected: readonly TPpmBulkIssue[], memberId: string | null): TPpmBulkFieldPlan {
  const target = memberId ? [memberId] : [];
  const plan: TPpmBulkFieldPlan = { changes: [], unchangedIds: [] };
  for (const issue of uniquePpmIssues(selected)) {
    const same = issue.assigneeIds.length === target.length && target.every((id) => issue.assigneeIds.includes(id));
    if (same || !issue.projectId) plan.unchangedIds.push(issue.id);
    else plan.changes.push({ issueId: issue.id, projectId: issue.projectId, data: { assignee_ids: target } });
  }
  return plan;
}

/** Выполняет задания не более чем по `limit` одновременно; сбой задания не останавливает остальные. */
export async function runPpmWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<unknown>
): Promise<{ fulfilled: T[]; rejected: T[] }> {
  const fulfilled: T[] = [];
  const rejected: T[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      try {
        // Каждая «дорожка» ждёт своё задание — так одновременно идут не больше `limit` запросов.
        // oxlint-disable-next-line no-await-in-loop
        await worker(item);
        fulfilled.push(item);
      } catch {
        rejected.push(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return { fulfilled, rejected };
}

export async function runPpmFieldChanges(
  plan: TPpmBulkFieldPlan,
  apply: (change: TPpmBulkFieldChange) => Promise<unknown>,
  limit = PPM_BULK_CONCURRENCY
): Promise<TPpmBulkOutcome> {
  const { fulfilled, rejected } = await runPpmWithConcurrency(plan.changes, limit, apply);
  const order = (changes: TPpmBulkFieldChange[]) =>
    plan.changes.filter((change) => changes.includes(change)).map((change) => change.issueId);
  return {
    succeededIds: order(fulfilled),
    unchangedIds: [...plan.unchangedIds],
    failedIds: order(rejected),
    deniedIds: [],
  };
}

// ---------------- спринт ----------------

export type TPpmCycleChangePlan = {
  /** Куда переносим; null — «Без спринта». */
  cycleId: string | null;
  projectId: string | null;
  /** Задачи для массового переноса в спринт (один запрос). */
  moveIds: string[];
  /** Задачи, которые убираем из их спринта (по одной). */
  removeItems: { issueId: string; projectId: string }[];
  unchangedIds: string[];
};

export function planPpmCycleChange(selected: readonly TPpmBulkIssue[], cycleId: string | null): TPpmCycleChangePlan {
  const issues = uniquePpmIssues(selected);
  const projectIds = getPpmBulkProjectIds(issues);
  const plan: TPpmCycleChangePlan = {
    cycleId,
    projectId: projectIds.length === 1 ? projectIds[0] : null,
    moveIds: [],
    removeItems: [],
    unchangedIds: [],
  };
  for (const issue of issues) {
    if (!issue.projectId || issue.cycleId === cycleId || (!cycleId && !issue.cycleId)) plan.unchangedIds.push(issue.id);
    else if (cycleId) plan.moveIds.push(issue.id);
    else plan.removeItems.push({ issueId: issue.id, projectId: issue.projectId });
  }
  return plan;
}

export type TPpmCycleActions = {
  /** Массовый метод стора: один POST …/cycles/<id>/cycle-issues/ (сервер сам снимает задачи с прежних спринтов). */
  addIssuesToCycle: (projectId: string, cycleId: string, issueIds: string[]) => Promise<unknown>;
  removeIssueFromCycle: (projectId: string, issueId: string) => Promise<unknown>;
};

export async function runPpmCycleChange(
  plan: TPpmCycleChangePlan,
  actions: TPpmCycleActions,
  limit = PPM_BULK_CONCURRENCY
): Promise<TPpmBulkOutcome> {
  const outcome: TPpmBulkOutcome = {
    succeededIds: [],
    unchangedIds: [...plan.unchangedIds],
    failedIds: [],
    deniedIds: [],
  };
  if (plan.cycleId && plan.moveIds.length > 0) {
    if (!plan.projectId) outcome.failedIds.push(...plan.moveIds);
    else
      try {
        await actions.addIssuesToCycle(plan.projectId, plan.cycleId, plan.moveIds);
        outcome.succeededIds.push(...plan.moveIds);
      } catch {
        outcome.failedIds.push(...plan.moveIds);
      }
  }
  if (plan.removeItems.length > 0) {
    const { fulfilled, rejected } = await runPpmWithConcurrency(plan.removeItems, limit, (item) =>
      actions.removeIssueFromCycle(item.projectId, item.issueId)
    );
    const order = (items: TPpmCycleChangePlan["removeItems"]) =>
      plan.removeItems.filter((item) => items.includes(item)).map((item) => item.issueId);
    outcome.succeededIds.push(...order(fulfilled));
    outcome.failedIds.push(...order(rejected));
  }
  return outcome;
}

export type TPpmBulkSprintPhase = "current" | "upcoming" | "draft";

export type TPpmBulkCycleLike = {
  id: string;
  name: string;
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  archived_at?: string | null;
};

export type TPpmBulkSprintOption = { id: string; name: string; phase: TPpmBulkSprintPhase };

const dayOf = (value: string | null | undefined): number | null => {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return match ? Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]) : null;
};

function getPpmSprintPhase(cycle: TPpmBulkCycleLike, today: number): TPpmBulkSprintPhase | "completed" {
  const status = cycle.status?.toLowerCase();
  if (status === "current" || status === "upcoming" || status === "draft" || status === "completed") return status;
  const start = dayOf(cycle.start_date);
  const end = dayOf(cycle.end_date);
  if (start === null || end === null) return "draft";
  if (end < today) return "completed";
  return start > today ? "upcoming" : "current";
}

/** Спринты для меню: текущий, будущие (по дате начала) и без дат; завершённые и архивные — нет. */
export function getPpmBulkSprintOptions(cycles: readonly TPpmBulkCycleLike[], today: Date): TPpmBulkSprintOption[] {
  const todayKey = today.getFullYear() * 10_000 + (today.getMonth() + 1) * 100 + today.getDate();
  const rank: Record<TPpmBulkSprintPhase, number> = { current: 0, upcoming: 1, draft: 2 };
  const options = cycles
    .filter((cycle) => !cycle.archived_at)
    .map((cycle) => ({ cycle, phase: getPpmSprintPhase(cycle, todayKey) }))
    .filter((item): item is { cycle: TPpmBulkCycleLike; phase: TPpmBulkSprintPhase } => item.phase !== "completed");
  options.sort(
    (a, b) =>
      rank[a.phase] - rank[b.phase] ||
      (dayOf(a.cycle.start_date) ?? 0) - (dayOf(b.cycle.start_date) ?? 0) ||
      a.cycle.name.localeCompare(b.cycle.name)
  );
  return options.map(({ cycle, phase }) => ({ id: cycle.id, name: cycle.name, phase }));
}

// ---------------- исполнители задач нескольких проектов ----------------

/**
 * Участники, общие для всех проектов выделения (сервер молча выбрасывает исполнителя, который не участник проекта —
 * задача осталась бы без исполнителя). null — чьи-то участники ещё не загружены.
 */
export function intersectPpmMemberIds(lists: readonly (readonly string[] | null | undefined)[]): string[] | null {
  if (lists.length === 0 || lists.some((list) => !list)) return null;
  const [first, ...rest] = lists as readonly (readonly string[])[];
  return first.filter((id) => rest.every((list) => list.includes(id)));
}

// ---------------- итог ----------------

function listPpmFailed(
  ids: readonly string[],
  labels: Readonly<Record<string, string>>,
  translate: TPpmBulkTranslate
): string {
  const named = ids.slice(0, PPM_BULK_FAILED_LIST_LIMIT).map((id) => labels[id] ?? id);
  const items = named.join(", ");
  const more = ids.length - named.length;
  return more > 0 ? formatPpmTemplate(translate("bulk.failed_more"), { items, count: more }) : items;
}

function toastKind(done: number, problems: number): TPpmBulkToast["type"] {
  if (problems === 0) return "success";
  return done > 0 ? "warning" : "error";
}

const TOAST_TITLE: Record<TPpmBulkToast["type"], TPpmTranslationKey> = {
  success: "bulk.toast_done",
  warning: "bulk.toast_partial",
  error: "bulk.toast_failed",
};

/** «Удалено K задач; M не удалены — нет прав; F не удалены — ошибка сервера». */
export function describePpmBulkDelete(
  outcome: TPpmBulkOutcome,
  translate: TPpmBulkTranslate,
  locale: string | undefined
): TPpmBulkToast {
  const deleted = outcome.succeededIds.length;
  const denied = outcome.deniedIds.length;
  const failed = outcome.failedIds.length;
  const parts: string[] = [];
  if (deleted > 0) parts.push(formatPpmBulkCount(translate, "bulk.deleted", deleted, locale));
  if (denied > 0) parts.push(formatPpmBulkCount(translate, "bulk.not_deleted_rights", denied, locale));
  if (failed > 0) parts.push(formatPpmBulkCount(translate, "bulk.not_deleted_error", failed, locale));
  const type = toastKind(deleted, denied + failed);
  return { type, title: translate(TOAST_TITLE[type]), message: parts.join("; ") };
}

/** «Обновлено K задач» или список неудач: «…; не удалось: ROBOT-2, ROBOT-3». */
export function describePpmBulkUpdate(
  outcome: TPpmBulkOutcome,
  labels: Readonly<Record<string, string>>,
  translate: TPpmBulkTranslate,
  locale: string | undefined
): TPpmBulkToast {
  // Задачи, у которых значение уже было нужным, тоже «обновлены»: после действия у них то, что выбрано.
  const updated = outcome.succeededIds.length + outcome.unchangedIds.length;
  const failed = outcome.failedIds.length;
  const parts: string[] = [];
  if (updated > 0) parts.push(formatPpmBulkCount(translate, "bulk.updated", updated, locale));
  if (failed > 0) {
    const items = listPpmFailed(outcome.failedIds, labels, translate);
    parts.push(
      formatPpmTemplate(translate(updated > 0 ? "bulk.update_failed_tail" : "bulk.update_failed_all"), { items })
    );
  }
  const type = toastKind(updated, failed);
  return { type, title: translate(TOAST_TITLE[type]), message: parts.join("; ") };
}

// ---------------- блокировка повторного запуска ----------------

export type TPpmBulkRunGuard = {
  isBusy: () => boolean;
  subscribe: (listener: () => void) => () => void;
  /** Запускает действие, если другое не идёт; иначе `{ started: false }` и действие не вызывается. */
  run: <T>(task: () => Promise<T>) => Promise<{ started: true; value: T } | { started: false }>;
};

export function createPpmBulkRunGuard(): TPpmBulkRunGuard {
  let busy = false;
  const listeners = new Set<() => void>();
  const setBusy = (value: boolean) => {
    busy = value;
    for (const listener of listeners) listener();
  };
  return {
    isBusy: () => busy,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    run: async (task) => {
      if (busy) return { started: false };
      setBusy(true);
      try {
        return { started: true, value: await task() };
      } finally {
        setBusy(false);
      }
    },
  };
}

/** Одна блокировка на приложение: второе действие не начнётся и с другой панели (после перехода между списками). */
export const ppmBulkRunGuard = createPpmBulkRunGuard();
