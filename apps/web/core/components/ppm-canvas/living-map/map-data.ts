/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { reaction } from "mobx";
import type { TPpmCanvasBinding, TPpmWorkItemEditOptions } from "@ppm/canvas";
import type { TMapSectionSummary, TWorkItemFacts } from "./living-map-types";
import {
  EMPTY_LIVING_MAP_TRAY,
  sprintFrameOf,
  type TLivingMapCard,
  type TLivingMapSprint,
  type TLivingMapTray,
  type TMapCycle,
  type TMapGroup,
  type TMapIssue,
  type TMapModule,
  type TMapPullRequest,
  type TTaskRelationEdge,
} from "./map-model";
import { collectNotOnMap } from "./not-on-map";
import { collectTaskRelations, taskCards } from "./task-relations";
import { computeWorkItemFacts } from "./traffic-light";

// AF2.2 M: данные «Живой карты» без React: загрузка из Plane и сведение в то, что показывают рамка, секции, связи
// «из Задач», «Светофор» и лоток. Читает только активная вкладка (living-map-facts.ts); в доску ничего не пишет.

export type TLivingMapLoaders = {
  cycle: (cycleId: string) => Promise<TMapCycle | null>;
  modules: () => Promise<TMapModule[]>;
  projectIssues: () => Promise<TMapIssue[]>;
  pullRequests: () => Promise<TMapPullRequest[]>;
  sprintIssues: (cycleId: string) => Promise<TMapIssue[]>;
};
export type TLivingMapRequest = { boardWorkItemIds: readonly string[]; cycleId: string | null; now: number };
export type TLivingMapData = {
  cycle: TMapCycle | null;
  cycleId: string | null;
  issues: ReadonlyMap<string, TMapIssue>;
  loadedAt: number;
  modules: readonly TMapModule[];
  pullRequests: readonly TMapPullRequest[];
  sprintIssueIds: readonly string[] | null;
};
export const EMPTY_LIVING_MAP_DATA: TLivingMapData = {
  cycle: null,
  cycleId: null,
  issues: new Map(),
  loadedAt: 0,
  modules: [],
  pullRequests: [],
  sprintIssueIds: null,
};

const CARD_FIELD = "\t";

/**
 * final-pass M1: идентификатор проекта («ROBOT») для «заблокирована ROBOT-12» и номеров в лотке. PpmCanvasEditor — не
 * observer MobX, и прочитанный при отрисовке идентификатор сам не обновлялся (проект догрузился позже, его переименовали).
 * Реакция на стор проекта сообщает текущее значение сразу и каждое новое; вернёт отписку (эффект редактора).
 */
export function watchProjectIdentifier(
  read: () => string | null | undefined,
  onChange: (identifier: string | null) => void
): () => void {
  return reaction(() => read() || null, onChange, { fireImmediately: true });
}

/**
 * Итоговое ревью M-3 (решение контроллера): проектный список задач (последние 1000 по обновлению — ради карточек вне
 * спринта карты) читается не чаще раза в 5 минут для доски; задачи спринта — по-прежнему опросом раз в 60 с. Предел
 * 1000 — известное ограничение (CHANGELOG).
 */
export const PROJECT_ISSUES_TTL_MS = 5 * 60_000;

/**
 * Проектный список с памятью на 5 минут: повтор в срок отдаёт тот же ответ (или ждёт тот же запрос), позже — читает
 * заново; сбой не запоминается. Задача, которой в запомненном списке нет (карточку положили позже), нейтральна до
 * следующего чтения. Память — у загрузчиков одной доски и проекта (living-map-facts.ts).
 */
export function cacheProjectIssues(
  load: () => Promise<TMapIssue[]>,
  now: () => number = Date.now,
  ttlMs: number = PROJECT_ISSUES_TTL_MS
): () => Promise<TMapIssue[]> {
  let cached: { at: number; issues: Promise<TMapIssue[]> } | null = null;
  return () => {
    const at = now();
    if (cached && at - cached.at < ttlMs) return cached.issues;
    const entry = { at, issues: load() };
    cached = entry;
    entry.issues.catch(() => {
      if (cached === entry) cached = null;
    });
    return entry.issues;
  };
}

/** Живые карточки задач и PR, чья фигура есть на доске, — строкой: меняется при добавлении, удалении и новой версии. */
export function liveCardsSignature(
  bindings: ReadonlyMap<string, TPpmCanvasBinding>,
  hasShape: (shapeId: string) => boolean
): string {
  const rows: string[] = [];
  for (const [shapeId, binding] of bindings) {
    if (binding.entity_type !== "work_item" && binding.entity_type !== "pull_request") continue;
    if (!hasShape(shapeId)) continue;
    rows.push([shapeId, binding.entity_type, binding.entity_id, binding.source_version ?? ""].join(CARD_FIELD));
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- rows is a local array (lib ES2022: no toSorted).
  return rows.sort().join("\n");
}

export function liveCardsFromSignature(
  signature: string,
  bindings: ReadonlyMap<string, TPpmCanvasBinding>
): TLivingMapCard[] {
  if (!signature) return [];
  const cards: TLivingMapCard[] = [];
  for (const row of signature.split("\n")) {
    const shapeId = row.split(CARD_FIELD)[0];
    const binding = bindings.get(shapeId);
    if (binding) cards.push({ binding, shapeId });
  }
  return cards;
}

export function boardWorkItemIds(cards: readonly TLivingMapCard[]): string[] {
  const ids = new Set<string>();
  for (const card of cards) if (card.binding.entity_type === "work_item") ids.add(card.binding.entity_id);
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array from the set (lib ES2022: no toSorted).
  return [...ids].sort();
}

/** Что читать заново: спринт рамки и задачи на доске с их версиями; пусто — доска без карты и карточек, чтения нет. */
export function livingMapLoadKey(cycleId: string | null, cards: readonly TLivingMapCard[]): string {
  const workItems = new Set<string>();
  for (const card of cards)
    if (card.binding.entity_type === "work_item")
      workItems.add(`${card.binding.entity_id}@${card.binding.source_version ?? ""}`);
  if (!cycleId && workItems.size === 0) return "";
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array from the set (lib ES2022: no toSorted).
  return `${cycleId ?? "-"}|${[...workItems].sort().join(",")}`;
}

export async function loadLivingMapData(
  loaders: TLivingMapLoaders,
  request: TLivingMapRequest
): Promise<TLivingMapData> {
  const { cycleId } = request;
  let cycle: TMapCycle | null = null;
  let modules: TMapModule[] = [];
  let sprintIssues: TMapIssue[] | null = null;
  let pullRequests: TMapPullRequest[] = [];
  if (cycleId) {
    [cycle, modules, sprintIssues, pullRequests] = await Promise.all([
      loaders.cycle(cycleId),
      loaders.modules().catch((): TMapModule[] => []),
      loaders.sprintIssues(cycleId),
      loaders.pullRequests().catch((): TMapPullRequest[] => []),
    ]);
  }
  const issues = new Map<string, TMapIssue>();
  for (const item of sprintIssues ?? []) issues.set(item.id, item);
  // Проектный список (последние 1000 по обновлению) — только ради карточек вне спринта карты или доски без карты;
  // загрузчик доски помнит его 5 минут (cacheProjectIssues, M-3).
  if (request.boardWorkItemIds.some((id) => !issues.has(id))) {
    for (const item of await loaders.projectIssues().catch((): TMapIssue[] => []))
      if (!issues.has(item.id)) issues.set(item.id, item);
  }
  return {
    ...EMPTY_LIVING_MAP_DATA,
    cycle,
    cycleId,
    issues,
    loadedAt: request.now,
    modules,
    pullRequests,
    sprintIssueIds: sprintIssues ? sprintIssues.map((item) => item.id) : null,
  };
}

/** Шапки рамки и секций: живые карточки задач среди потомков группы и их «Светофор». */
export function summarizeMapGroups(
  groups: readonly TMapGroup[],
  cards: readonly TLivingMapCard[],
  facts: ReadonlyMap<string, TWorkItemFacts>
): Map<string, TMapSectionSummary> {
  const workItems = new Map<string, string>();
  for (const card of cards)
    if (card.binding.entity_type === "work_item") workItems.set(card.shapeId, card.binding.entity_id);
  const summaries = new Map<string, TMapSectionSummary>();
  for (const group of groups) {
    const summary: TMapSectionSummary = { blocked: 0, done: 0, overdue: 0, role: group.map.role, total: 0 };
    for (const shapeId of group.descendants) {
      const workItemId = workItems.get(shapeId);
      if (!workItemId) continue;
      summary.total += 1;
      const traffic = facts.get(workItemId)?.traffic;
      if (traffic === "done") summary.done += 1;
      else if (traffic === "blocked") summary.blocked += 1;
      else if (traffic === "overdue") summary.overdue += 1;
    }
    summaries.set(group.id, summary);
  }
  return summaries;
}

export type TLivingMapViewInput = {
  cards: readonly TLivingMapCard[];
  data: TLivingMapData;
  groups: readonly TMapGroup[];
  options: TPpmWorkItemEditOptions;
  projectId: string;
  projectIdentifier: string | null;
  today: Date;
};
export type TLivingMapView = {
  facts: ReadonlyMap<string, TWorkItemFacts>;
  mapSections: ReadonlyMap<string, TMapSectionSummary>;
  modules: ReadonlyMap<string, TMapModule>;
  relationEdges: readonly TTaskRelationEdge[];
  sprint: TLivingMapSprint | null;
  tray: TLivingMapTray;
};

export function computeLivingMapView(input: TLivingMapViewInput): TLivingMapView {
  const frame = sprintFrameOf(input.groups);
  const current = frame !== null && input.data.cycleId === frame.map.cycle_id;
  const cycle = current ? input.data.cycle : null;
  const modules = new Map(input.data.modules.map((direction) => [direction.id, direction]));
  const facts: ReadonlyMap<string, TWorkItemFacts> = computeWorkItemFacts({
    cards: input.cards,
    issues: input.data.issues,
    projectId: input.projectId,
    projectIdentifier: input.projectIdentifier,
    states: input.options.states,
    today: input.today,
  });
  return {
    facts,
    mapSections: summarizeMapGroups(input.groups, input.cards, facts),
    modules,
    relationEdges: collectTaskRelations(input.data.issues.values(), taskCards(input.cards)),
    sprint:
      frame && current
        ? {
            cycleId: frame.map.cycle_id,
            done: cycle?.completed_issues ?? 0,
            endDate: cycle?.end_date ?? null,
            missing: cycle === null,
            name: cycle?.name ?? "",
            startDate: cycle?.start_date ?? null,
            total: cycle?.total_issues ?? 0,
          }
        : null,
    tray:
      frame && current && input.data.sprintIssueIds
        ? {
            builtAt: frame.createdAt,
            enabled: true,
            items: collectNotOnMap({
              cards: input.cards,
              issues: input.data.issues,
              modules,
              options: input.options,
              projectIdentifier: input.projectIdentifier,
              pullRequests: input.data.pullRequests,
              sprintIssueIds: input.data.sprintIssueIds,
            }),
          }
        : EMPTY_LIVING_MAP_TRAY,
  };
}
