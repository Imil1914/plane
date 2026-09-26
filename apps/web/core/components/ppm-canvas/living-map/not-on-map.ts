/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmTranslationKey } from "@ppm/brand";
import { PPM_CANVAS_NODE_REGISTRY, type TPpmCanvasBinding, type TPpmWorkItemEditOptions } from "@ppm/canvas";
import { formatPpmIssueIdentifier, formatPpmPullRequestRef } from "@/components/ppm-tasks/evidence";
import {
  PPM_CANVAS_BATCH_LIMIT,
  type TPpmCanvasBatchBindingItem,
  type TPpmCanvasBatchBindingResult,
} from "@/services/ppm-canvas-map.service";
import { mapPlacementFits, planMapPlacement, type TMapState } from "./map-layout";
import {
  primaryModuleId,
  type TLivingMapCard,
  type TMapIssue,
  type TMapModule,
  type TMapPlacementRequest,
  type TMapPullRequest,
  type TNotOnMapItem,
  type TPlaceOnMapResult,
} from "./map-model";
import { buildPlacementChange, liveCardNode, type TMapShapeChange } from "./map-shapes";

// AF2.2 M4: лоток «Не на карте» (K5): задачи спринта без карточки на доске и активные PR этих задач без карточки PR
// (закрытые без слияния — нет, итоговое ревью M-6).
// Ничего не добавляет сам: «+ Добавить» / «Разложить всё» — по нажатию редактора, одним S1 и одним шагом истории.
// Решения контроллера: RM-c — ручной PR без объекта Git виден, но не кладётся; RM-d — за нажатие ≤ 200 карточек.
// Ревью M4, раунд 1: один PR — один пункт; отбор нажатия — selectTrayRequests; «развёрнут» — по доске в браузере.

type TPullRequestTrayItem = Extract<TNotOnMapItem, { kind: "pull_request" }>;

/** За нажатие — не больше, чем принимает S1 и активирует одно сохранение. */
export const MAP_PLACEMENT_LIMIT = PPM_CANVAS_BATCH_LIMIT;

export function collectNotOnMap(input: {
  cards: readonly TLivingMapCard[];
  issues: ReadonlyMap<string, TMapIssue>;
  modules: ReadonlyMap<string, TMapModule>;
  options: TPpmWorkItemEditOptions;
  projectIdentifier: string | null;
  pullRequests: readonly TMapPullRequest[];
  sprintIssueIds: readonly string[];
}): TNotOnMapItem[] {
  const tasksOnBoard = new Set<string>();
  const gitOnBoard = new Set<string>();
  for (const item of input.cards) {
    if (item.binding.entity_type === "work_item") tasksOnBoard.add(item.binding.entity_id);
    else if (item.binding.entity_type === "pull_request") gitOnBoard.add(item.binding.entity_id);
  }
  const states = new Map(input.options.states.map((state) => [state.id, state]));
  const people = new Map(input.options.assignees.map((person) => [person.id, person.display_name]));
  const sprint = input.sprintIssueIds
    .map((id) => input.issues.get(id))
    .filter((item): item is TMapIssue => Boolean(item));
  // oxlint-disable-next-line unicorn/no-array-sort -- sprint is a fresh array (lib ES2022: no toSorted).
  sprint.sort((left, right) => left.sequence_id - right.sequence_id);
  const directionOf = (item: TMapIssue) => {
    const moduleId = primaryModuleId(item.module_ids, input.modules);
    return { moduleId, moduleName: moduleId ? (input.modules.get(moduleId)?.name ?? null) : null };
  };
  const tasks = sprint
    .filter((item) => !tasksOnBoard.has(item.id))
    .map((item): TNotOnMapItem => {
      const state = item.state_id ? states.get(item.state_id) : undefined;
      const direction = directionOf(item);
      return {
        assignees: item.assignee_ids
          .map((id) => people.get(id))
          .filter(Boolean)
          .join(", "),
        identifier: formatPpmIssueIdentifier(input.projectIdentifier, item.sequence_id),
        key: `task:${item.id}`,
        kind: "task",
        moduleId: direction.moduleId,
        moduleName: direction.moduleName,
        stateGroup: state?.group ?? null,
        stateName: state?.name ?? null,
        title: item.name,
        workItemId: item.id,
      };
    });
  const sprintById = new Map(sprint.map((item) => [item.id, item]));
  const pulls: { item: TPullRequestTrayItem; sequence: number }[] = [];
  for (const link of input.pullRequests) {
    const owner = sprintById.get(link.work_item.id);
    if (!owner || link.object_type !== "pull_request" || link.status !== "active") continue;
    // Итоговое ревью M-6: PR, закрытый без слияния, — не работа спринта; влитый, открытый и без состояния (старый
    // сервер не отдаёт поле) — как раньше.
    if (link.git_object_state === "closed") continue;
    const entityId = link.git_object_id ?? link.id;
    if (gitOnBoard.has(entityId) || gitOnBoard.has(link.id)) continue;
    const direction = directionOf(owner);
    pulls.push({
      item: {
        entityId,
        hasGitObject: link.git_object_id !== null,
        key: `pr:${link.id}`,
        kind: "pull_request",
        moduleId: direction.moduleId,
        moduleName: direction.moduleName,
        ref: formatPpmPullRequestRef(link.ref),
        repositoryName: link.repository_name,
        title: link.title,
        workItemId: owner.id,
        workItemIdentifier: link.work_item.identifier,
      },
      sequence: owner.sequence_id,
    });
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- pulls is built here (lib ES2022: no toSorted).
  pulls.sort((left, right) => left.sequence - right.sequence || left.item.key.localeCompare(right.item.key));
  // Ревью M4: PR, связанный с двумя задачами спринта, — две Git-связи, но один объект Git: один пункт (у первой по
  // номеру задачи), иначе «Разложить всё» положило бы две карточки одного PR. Ручная ссылка — по своему id, он уникален.
  const unique = new Map<string, TPullRequestTrayItem>();
  for (const { item } of pulls) if (!unique.has(item.entityId)) unique.set(item.entityId, item);
  return [...tasks, ...unique.values()];
}

/** RM-c: ручная ссылка на PR без объекта Git — в лотке видна, но на доску не кладётся («Разложить всё» пропускает). */
export function isPlaceableTrayItem(item: TNotOnMapItem): boolean {
  return item.kind === "task" || item.hasGitObject;
}

/**
 * RM-d: сколько карточек можно положить до ближайшего сохранения доски. Сохранение активирует ≤ 200 привязок, а свежие
 * (pending) привязки доски — положенные, но ещё не сохранённые — уйдут в то же сохранение.
 */
export function placementRoom(bindings: ReadonlyMap<string, TPpmCanvasBinding>): number {
  let pending = 0;
  for (const binding of bindings.values()) if (binding.binding_status === "pending") pending += 1;
  return Math.max(0, MAP_PLACEMENT_LIMIT - pending);
}

/**
 * Что кладёт одно нажатие («+ Добавить» — один ключ, «Разложить всё» — все): RM-c — только задачи и PR с объектом Git
 * (нечего — null); RM-d — не больше, чем принимает S1, и не больше места в ближайшем сохранении доски (placementRoom).
 * remaining — что это нажатие не взяло из-за предела («нажмите ещё раз»).
 */
export function selectTrayRequests(input: {
  bindings: ReadonlyMap<string, TPpmCanvasBinding>;
  items: readonly TNotOnMapItem[];
  keys: readonly string[];
  noDirectionTitle: string;
}): { remaining: number; requests: TMapPlacementRequest[] } | null {
  const wanted = new Set(input.keys);
  const placeable = input.items.filter((item) => wanted.has(item.key) && isPlaceableTrayItem(item));
  if (placeable.length === 0) return null;
  const requests = placeable
    .slice(0, Math.min(MAP_PLACEMENT_LIMIT, placementRoom(input.bindings)))
    .map((item) => trayPlacementRequest(item, input.noDirectionTitle));
  return { remaining: placeable.length - requests.length, requests };
}

/** Итог нажатия — строка уведомления холста. */
export function trayPlacementNotice(result: TPlaceOnMapResult): {
  key: TPpmTranslationKey;
  values: Record<string, number>;
} {
  if (result.noRoom) return { key: "canvas.tray.no_room", values: {} };
  // Ничего не пробовали класть: прошлые карточки ещё не сохранены (RM-d, placementRoom).
  if (result.placed === 0 && result.failed === 0) return { key: "canvas.tray.saving", values: {} };
  if (result.placed === 0) return { key: "canvas.tray.place_error", values: {} };
  const more = (result.remaining ?? 0) > 0;
  if (result.failed > 0)
    return {
      key: more ? "canvas.tray.placed_partial_more" : "canvas.tray.placed_partial",
      values: { failed: result.failed, placed: result.placed },
    };
  return { key: more ? "canvas.tray.placed_more" : "canvas.tray.placed", values: { count: result.placed } };
}

// ─────────────── «Свёрнут / развёрнут»: по доске, у пользователя в браузере (ревью M4, раунд 1) ───────────────

// Лоток открывается свёрнутым — на карте по умолчанию виден инспектор (RM-b). Выбор помним по доске: в памяти страницы
// (лоток живёт в CanvasControls и пересоздаётся) и, если можно, в localStorage; первое чтение кешируется.
const trayMemory = new Map<string, boolean>();

export function trayStorageKey(authorId: string, boardId: string): string {
  return ["ppm", "af22", "not-on-map", authorId, boardId].map(encodeURIComponent).join(":");
}

/** Развёрнут ли лоток этой доски; нет выбора или хранилище бросает (приватный режим) — свёрнут. */
export function readTrayExpanded(storage: Pick<Storage, "getItem"> | undefined, key: string): boolean {
  const remembered = trayMemory.get(key);
  if (remembered !== undefined) return remembered;
  let expanded = false;
  try {
    expanded = storage?.getItem(key) === "expanded";
  } catch {
    expanded = false;
  }
  trayMemory.set(key, expanded);
  return expanded;
}

export function writeTrayExpanded(storage: Pick<Storage, "setItem"> | undefined, key: string, expanded: boolean): void {
  trayMemory.set(key, expanded);
  try {
    storage?.setItem(key, expanded ? "expanded" : "collapsed");
  } catch {
    // Private mode or a full quota: the choice still holds for this page.
  }
}

/** Пункт лотка → запрос раскладки: задача — живая карточка 360 × 248, PR — карточка Git 360 × 220. */
export function trayPlacementRequest(item: TNotOnMapItem, noDirectionTitle: string): TMapPlacementRequest {
  const sectionTitle = item.moduleName ?? noDirectionTitle;
  if (item.kind === "task")
    return {
      entityId: item.workItemId,
      entityType: "work_item",
      key: item.key,
      moduleId: item.moduleId,
      sectionTitle,
      size: {
        h: PPM_CANVAS_NODE_REGISTRY.work_item_ref.defaultHeight,
        w: PPM_CANVAS_NODE_REGISTRY.work_item_ref.defaultWidth,
      },
    };
  return {
    entityId: item.entityId,
    entityType: "pull_request",
    key: item.key,
    moduleId: item.moduleId,
    sectionTitle,
    size: { h: PPM_CANVAS_NODE_REGISTRY.git_ref.defaultHeight, w: PPM_CANVAS_NODE_REGISTRY.git_ref.defaultWidth },
  };
}

export type TPlaceOnMapDeps = {
  applyChange: (change: TMapShapeChange) => boolean;
  authorId: string;
  bindBatch: (items: readonly TPpmCanvasBatchBindingItem[]) => Promise<TPpmCanvasBatchBindingResult[]>;
  cancelBinding: (bindingId: string) => Promise<void>;
  newShapeId: () => string;
  now: () => string;
  readState: () => TMapState | null;
  registerBindings: (bindings: readonly TPpmCanvasBinding[]) => void;
};

/**
 * S1 → раскладка по свежему состоянию доски (могла измениться за время запроса) → одно изменение → регистрация.
 * Рамка не выше предела группы (ревью M1): не помещается уже до запроса — S1 не зовём; перестала помещаться, пока он
 * шёл, — созданные привязки отменяются (noRoom). Всё после S1 — одна попытка, как сборка M1: доска отказала или что-то
 * бросило — отменяются все привязки, что создал S1; созданные, но не нарисованные — отменяются и после удачи.
 */
export async function placeOnMap(
  deps: TPlaceOnMapDeps,
  requests: readonly TMapPlacementRequest[]
): Promise<TPlaceOnMapResult> {
  const failure = (noRoom: boolean): TPlaceOnMapResult =>
    noRoom
      ? { cardIds: [], failed: requests.length, noRoom, placed: 0 }
      : { cardIds: [], failed: requests.length, placed: 0 };
  const before = requests.length > 0 ? deps.readState() : null;
  if (!before) return failure(false);
  if (!mapPlacementFits(planMapPlacement(before, requests))) return failure(true);
  const shapeIds = new Map(requests.map((item) => [item.key, deps.newShapeId()]));
  const results = await deps.bindBatch(
    requests.map(
      (item): TPpmCanvasBatchBindingItem => ({
        entity_id: item.entityId,
        entity_type: item.entityType,
        shape_id: shapeIds.get(item.key) ?? "",
      })
    )
  );
  const created = results.flatMap((result) => (result.status === "created" ? [result.binding] : []));
  const cancel = (list: readonly TPpmCanvasBinding[]) =>
    Promise.all(list.map((binding) => deps.cancelBinding(binding.binding_id).catch(() => undefined)));
  let built: ReturnType<typeof buildPlacementChange>;
  try {
    const now = deps.now();
    const bindings = new Map<string, TPpmCanvasBinding>();
    requests.forEach((item, index) => {
      const result = results[index];
      if (result?.status !== "created") return;
      const { binding } = result;
      if (
        binding.entity_type === item.entityType &&
        binding.entity_id === item.entityId &&
        liveCardNode(binding, deps.authorId, now)
      )
        bindings.set(item.key, binding);
    });
    const state = bindings.size > 0 ? deps.readState() : null;
    if (!state) {
      await cancel(created);
      return failure(false);
    }
    const plan = planMapPlacement(
      state,
      requests.filter((item) => bindings.has(item.key))
    );
    if (!mapPlacementFits(plan)) {
      await cancel(created);
      return failure(true);
    }
    built = buildPlacementChange({
      authorId: deps.authorId,
      bindings,
      frameId: state.frame.id,
      frameNode: state.frame.node,
      newSectionId: deps.newShapeId,
      now,
      plan,
      shapeIds,
    });
    let applied = false;
    try {
      applied = deps.applyChange(built.change);
    } catch {
      applied = false;
    }
    if (!applied) {
      await cancel(created);
      return failure(false);
    }
  } catch (error) {
    await cancel(created);
    throw error;
  }
  deps.registerBindings(built.bindings);
  const registered = new Set(built.bindings.map((binding) => binding.binding_id));
  const leftovers = created.filter((binding) => !registered.has(binding.binding_id));
  if (leftovers.length > 0) await cancel(leftovers);
  return { cardIds: built.cardIds, failed: requests.length - built.bindings.length, placed: built.bindings.length };
}
