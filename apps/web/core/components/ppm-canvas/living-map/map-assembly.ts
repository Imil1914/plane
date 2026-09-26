/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmTranslationKey } from "@ppm/brand";
import type { TPpmCanvasBinding, TPpmCanvasBoard } from "@ppm/canvas";
import { formatPpmSprintRange } from "@/components/ppm-tasks/sprint";
import {
  PPM_CANVAS_BATCH_LIMIT,
  type TPpmCanvasBatchBindingItem,
  type TPpmCanvasBatchBindingResult,
} from "@/services/ppm-canvas-map.service";
import { fillCanvasTemplate } from "../canvas-grammar";
import { sectionsThatFit } from "./map-layout";
import {
  groupSprintTasks,
  uniqueMapBoardName,
  type TMapCycle,
  type TMapIssue,
  type TMapModule,
  type TSprintCandidate,
} from "./map-model";
import { buildSprintMapChange, type TMapShapeChange, type TSprintMapSectionShapes } from "./map-shapes";

// AF2.2 M1: «Собрать карту спринта». Диалог доски, где нажали, читает спринт и направления, планирует раскладку и
// создаёт НОВУЮ доску (существующие не меняются); собирает её редактор новой доски (map-assembly-dialog.tsx):
// пакетная привязка S1 → фигуры одним шагом истории → args.registerBindings (активация ближайшим сохранением).

/** Одно сохранение доски активирует не больше 200 привязок (линия S): на карту — первые 200 задач по порядку секций. */
export const MAP_ASSEMBLY_LIMIT = PPM_CANVAS_BATCH_LIMIT;
const BOARD_NAME_ATTEMPTS = 5;

export type TSprintMapTaskPlan = { shapeId: string; workItemId: string };
export type TSprintMapSectionPlan = {
  key: string;
  moduleId: string | null;
  tasks: TSprintMapTaskPlan[];
  title: string;
};
export type TSprintMapPlan = {
  cycleId: string;
  frameTitle: string;
  /** Задачи спринта, которых карта не берёт (сверх 200 или их секции не помещаются в рамку), — в «Не на карте». */
  overflow: number;
  sections: TSprintMapSectionPlan[];
};

/**
 * Первые 200 задач по порядку секций (одно сохранение активирует ≤ 200), затем — секции, что помещаются в рамку не
 * выше предела группы F (ревью M1, раунд 1: 60 направлений по одной задаче — уже выше 20 000). Остальное ждёт в «Не на
 * карте», итог сборки называет их число.
 */
export function planSprintMap(input: {
  cycle: TMapCycle;
  frameTitle: string;
  issues: readonly TMapIssue[];
  modules: readonly TMapModule[];
  newShapeId: () => string;
  noDirectionTitle: string;
}): TSprintMapPlan {
  let room: number = MAP_ASSEMBLY_LIMIT;
  const taken = groupSprintTasks(input.issues, input.modules, input.noDirectionTitle).flatMap((group) => {
    const tasks = group.tasks.slice(0, Math.max(0, room));
    room -= tasks.length;
    return tasks.length > 0 ? [{ group, tasks }] : [];
  });
  const fitting = taken.slice(0, sectionsThatFit(taken.map(({ tasks }) => tasks.length)));
  const sections = fitting.map(
    ({ group, tasks }): TSprintMapSectionPlan => ({
      key: group.key,
      moduleId: group.moduleId,
      tasks: tasks.map((item): TSprintMapTaskPlan => ({ shapeId: input.newShapeId(), workItemId: item.id })),
      title: group.title,
    })
  );
  const planned = sections.reduce((sum, section) => sum + section.tasks.length, 0);
  return { cycleId: input.cycle.id, frameTitle: input.frameTitle, overflow: input.issues.length - planned, sections };
}

export type TSprintMapBuildDeps = {
  /** Есть ли свободная вкладка для новой доски (args.canOpenBoard, предел вкладок workspace.tsx). */
  canOpenBoard: () => boolean;
  createBoard: (name: string) => Promise<TPpmCanvasBoard>;
  existingBoardNames: () => readonly string[];
  loadModules: () => Promise<TMapModule[]>;
  loadSprintIssues: (cycleId: string) => Promise<TMapIssue[]>;
  locale: string;
  newShapeId: () => string;
  onBoardCreated: (board: TPpmCanvasBoard) => void;
  queue: (boardId: string, plan: TSprintMapPlan) => void;
  t: (key: TPpmTranslationKey) => string;
};
export type TSprintMapBuildResult =
  | { boardId: string; boardName: string; status: "created"; tasks: number }
  | { status: "empty" }
  | { status: "tab_limit" };

export function isBoardNameConflict(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "CANVAS_BOARD_NAME_CONFLICT"
  );
}

/**
 * Диалог: пустой спринт — доска не создаётся; нет свободной вкладки — тоже (ревью M1, раунд 1: иначе пустая доска
 * «Карта · …» без вкладки, а план теряется с перезагрузкой); иначе новая доска с незанятым именем, план — в очередь,
 * затем открыть. Сбой чтения направлений — ошибка сборки («Повторить»): 403/404 сервис уже отдал пустым списком.
 */
export async function buildSprintMapBoard(
  deps: TSprintMapBuildDeps,
  cycle: TSprintCandidate
): Promise<TSprintMapBuildResult> {
  const [issues, modules] = await Promise.all([deps.loadSprintIssues(cycle.id), deps.loadModules()]);
  if (issues.length === 0) return { status: "empty" };
  if (!deps.canOpenBoard()) return { status: "tab_limit" };
  const range = formatPpmSprintRange(cycle.start_date, cycle.end_date, deps.locale);
  const frameTitle = range
    ? fillCanvasTemplate(deps.t("canvas.map.sprint_title"), { name: cycle.name, range })
    : cycle.name;
  const plan = planSprintMap({
    cycle,
    frameTitle,
    issues,
    modules,
    newShapeId: deps.newShapeId,
    noDirectionTitle: deps.t("canvas.map.section_no_direction"),
  });
  const tried: string[] = [];
  for (let attempt = 0; attempt < BOARD_NAME_ATTEMPTS; attempt += 1) {
    const name = uniqueMapBoardName(deps.t("canvas.map.board_name"), cycle.name, [
      ...deps.existingBoardNames(),
      ...tried,
    ]);
    try {
      // oxlint-disable-next-line no-await-in-loop -- a retry waits for the previous name to be refused
      const board = await deps.createBoard(name);
      // Сначала очередь, потом открытие: редактор новой доски может смонтироваться сразу.
      deps.queue(board.board_id, plan);
      deps.onBoardCreated(board);
      return { boardId: board.board_id, boardName: board.name, status: "created", tasks: issues.length };
    } catch (error) {
      if (!isBoardNameConflict(error)) throw error;
      tried.push(name);
    }
  }
  throw new Error("No free name for the sprint map board.");
}

export type TSprintMapAssemblyDeps = {
  applyChange: (change: TMapShapeChange) => boolean;
  authorId: string;
  bindBatch: (items: readonly TPpmCanvasBatchBindingItem[]) => Promise<TPpmCanvasBatchBindingResult[]>;
  cancelBinding: (bindingId: string) => Promise<void>;
  newShapeId: () => string;
  now: () => string;
  registerBindings: (bindings: readonly TPpmCanvasBinding[]) => void;
};
export type TSprintMapAssemblyResult = { failed: number; frameId: string; placed: number };

/**
 * Редактор новой доски: S1 → рамка, секции (только с привязанными задачами) и карточки одним изменением → регистрация.
 * Всё после S1 — одна попытка (ревью M1, раунд 1): любой сбой (узел не прошёл схему, доска только для чтения, фигуры не
 * легли) — шаг истории откатан applyMapChange, все привязки, что создал S1, отменяются, доска не меняется. Привязки,
 * которые S1 создал, но карточка не нарисована, отменяются и после удачной сборки. failed — не легли на карту: отказы
 * S1 и задачи сверх плана (plan.overflow) — они в «Не на карте».
 */
export async function assembleSprintMap(
  deps: TSprintMapAssemblyDeps,
  plan: TSprintMapPlan
): Promise<TSprintMapAssemblyResult> {
  const tasks = plan.sections.flatMap((section) => section.tasks);
  const results = await deps.bindBatch(
    tasks.map(
      (task): TPpmCanvasBatchBindingItem => ({
        entity_id: task.workItemId,
        entity_type: "work_item",
        shape_id: task.shapeId,
      })
    )
  );
  const created = results.flatMap((result) => (result.status === "created" ? [result.binding] : []));
  const cancel = (bindings: readonly TPpmCanvasBinding[]) =>
    Promise.all(bindings.map((binding) => deps.cancelBinding(binding.binding_id).catch(() => undefined)));
  let frameId: string;
  let drawn: TPpmCanvasBinding[];
  try {
    const bound = new Map<string, TPpmCanvasBinding>();
    results.forEach((result, index) => {
      const task = tasks[index];
      if (result.status !== "created" || !task) return;
      if (result.binding.entity_type === "work_item" && result.binding.entity_id === task.workItemId)
        bound.set(task.shapeId, result.binding);
    });
    frameId = deps.newShapeId();
    const sections: TSprintMapSectionShapes[] = [];
    for (const section of plan.sections) {
      const cards = section.tasks.flatMap((task) => {
        const binding = bound.get(task.shapeId);
        return binding ? [{ binding, shapeId: task.shapeId }] : [];
      });
      if (cards.length > 0)
        sections.push({ cards, id: deps.newShapeId(), moduleId: section.moduleId, title: section.title });
    }
    const built = buildSprintMapChange({
      authorId: deps.authorId,
      cycleId: plan.cycleId,
      frameId,
      frameTitle: plan.frameTitle,
      now: deps.now(),
      sections,
    });
    if (!deps.applyChange(built.change)) throw new Error("The sprint map could not be added to the board.");
    drawn = built.bindings;
  } catch (error) {
    await cancel(created);
    throw error;
  }
  deps.registerBindings(drawn);
  const registered = new Set(drawn.map((binding) => binding.binding_id));
  const leftovers = created.filter((binding) => !registered.has(binding.binding_id));
  if (leftovers.length > 0) await cancel(leftovers);
  return { failed: tasks.length - drawn.length + plan.overflow, frameId, placed: drawn.length };
}

// ─────────────── RM14 · отметка «просмотрено» у сборщика после сохранения новой карты ───────────────

/** Карточка новой карты и её свежая (pending) привязка. */
export type TPlacedMapCard = { bindingId: string; shapeId: string };

/**
 * Новая карта сохранена: каждая её привязка, что ещё лежит на доске, стала active. editor.tsx (flushSave) помечает
 * active только привязки успешно сохранённого запроса; при 409 отменяет их — active они не станут. Карточку, которую
 * убрали до сохранения, не ждём; не осталось ни одной — «сохранено» не наступает.
 */
export function sprintMapSaved(
  cards: readonly TPlacedMapCard[],
  bindingsByShapeId: ReadonlyMap<string, TPpmCanvasBinding>
): boolean {
  let active = 0;
  for (const card of cards) {
    const binding = bindingsByShapeId.get(card.shapeId);
    if (!binding || binding.binding_id !== card.bindingId) continue;
    if (binding.binding_status !== "active") return false;
    active += 1;
  }
  return active > 0;
}

export type TSeenAfterSave = {
  /** Сборка положила карточки (сразу после args.registerBindings): ждать их сохранения. */
  expect: (bindings: readonly TPpmCanvasBinding[]) => void;
  /** После каждого изменения привязок доски; true — отметка отправлена (один раз на сборку). */
  check: (bindingsByShapeId: ReadonlyMap<string, TPpmCanvasBinding>) => boolean;
};

/**
 * Решение контроллера (RM14): свежая карта сборщика не открывается с «добавлено» на всех карточках. После успешного
 * сохранения — одна личная отметка S3 (markSeen — сервис линии C); её ошибка молча пропускается: карта уже собрана.
 */
export function createSeenAfterSave(markSeen: () => Promise<unknown>): TSeenAfterSave {
  let waiting: TPlacedMapCard[] | null = null;
  return {
    check: (bindingsByShapeId) => {
      if (!waiting || !sprintMapSaved(waiting, bindingsByShapeId)) return false;
      waiting = null;
      void markSeen().catch(() => undefined);
      return true;
    },
    expect: (bindings) => {
      waiting =
        bindings.length > 0
          ? bindings.map((binding) => ({ bindingId: binding.binding_id, shapeId: binding.shape_id }))
          : null;
    },
  };
}
