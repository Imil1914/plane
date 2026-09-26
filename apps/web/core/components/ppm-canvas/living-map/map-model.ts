/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { z } from "zod";
import { resolvePpmLocale, type TPpmTranslationKey } from "@ppm/brand";
import {
  getPpmCanvasMap,
  parseSerializedPpmCanvasNode,
  PPM_CANVAS_GROUP_MAX_SIZE,
  type TPpmCanvasBinding,
  type TPpmCanvasMap,
  type TPpmCanvasNode,
  type TPpmCanvasSprintMap,
} from "@ppm/canvas";
import { MAX_OPEN_CANVAS_BOARDS } from "../board-workspace-state";
import { fillCanvasTemplate } from "../canvas-grammar";

// AF2.2 M: модель «Живой карты» без React и tldraw (тесты — env node): данные Plane, выбор спринта, имя доски,
// раскладка задач по направлениям (R7), роли групп карты на доске, пределы размера и типы необязательных полей M,
// на которые ссылаются блоки M в living-map-types.ts.

// ─────────────── Данные Plane (элемент разбирается отдельно: битый выпадает, остальные остаются) ───────────────

export const mapIssueRelationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  project_id: z.string().uuid(),
  relation_type: z.string(),
  sequence_id: z.number().int(),
  state_id: z.string().uuid().nullable().catch(null),
});

/** Задача из issues-detail с expand=issue_relation (IssueListDetailSerializer, serializers/issue.py:824-897). */
export const mapIssueSchema = z.object({
  assignee_ids: z.array(z.string()).catch([]),
  cycle_id: z.string().nullable().catch(null),
  id: z.string().uuid(),
  issue_relation: z.array(mapIssueRelationSchema).catch([]),
  module_ids: z.array(z.string()).catch([]),
  name: z.string(),
  project_id: z.string().uuid(),
  sequence_id: z.number().int(),
  state_id: z.string().uuid().nullable().catch(null),
  target_date: z.string().nullable().catch(null),
});

export const mapCycleSchema = z.object({
  archived_at: z.string().nullable().catch(null),
  completed_issues: z.number().int().nonnegative().catch(0),
  end_date: z.string().nullable().catch(null),
  id: z.string().uuid(),
  name: z.string(),
  start_date: z.string().nullable().catch(null),
  total_issues: z.number().int().nonnegative().catch(0),
});

export const mapModuleSchema = z.object({
  archived_at: z.string().nullable().catch(null),
  id: z.string().uuid(),
  name: z.string(),
});

/**
 * Git-связь задачи (GET …/git/links/, ppm-git.service.ts TPpmGitLink) — то, что нужно лотку «Не на карте».
 * git_object_state (итоговое ревью M-6, сервер FW-S): open | closed | merged | null; старый сервер поля не отдаёт.
 */
export const mapPullRequestSchema = z.object({
  git_object_id: z.string().uuid().nullable().catch(null),
  git_object_state: z.string().nullable().catch(null).optional(),
  id: z.string().uuid(),
  object_type: z.string(),
  ref: z.string(),
  repository_name: z.string(),
  status: z.string(),
  title: z.string(),
  updated_at: z.string(),
  work_item: z.object({ id: z.string().uuid(), identifier: z.string(), title: z.string() }),
});

export type TMapIssue = z.infer<typeof mapIssueSchema>;
export type TMapCycle = z.infer<typeof mapCycleSchema>;
export type TMapModule = z.infer<typeof mapModuleSchema>;
export type TMapPullRequest = z.infer<typeof mapPullRequestSchema>;

export function parseMapList<TSchema extends z.ZodTypeAny>(schema: TSchema, raw: unknown): z.infer<TSchema>[] {
  if (!Array.isArray(raw)) return [];
  const items: z.infer<TSchema>[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

// ─────────────── Даты: календарные дни YYYY-MM-DD (как ppm-tasks/sprint.ts), «сегодня» — местная дата ───────────────

export function dateOnly(value: string | null | undefined): string | null {
  return /^(\d{4}-\d{2}-\d{2})/.exec(value ?? "")?.[1] ?? null;
}

export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDateKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// ─────────────── Диалог «Карта спринта»: какие спринты предлагать ───────────────

export type TSprintPhase = "completed" | "current" | "upcoming";
export type TSprintCandidate = TMapCycle & { phase: TSprintPhase };
export const SPRINT_MAP_COMPLETED_DAYS = 60;
const PHASE_ORDER: Record<TSprintPhase, number> = { completed: 2, current: 0, upcoming: 1 };

/** Текущий (сегодня в его датах), затем будущие по началу, затем завершённые за 60 дней — последние первыми. */
export function selectSprintCandidates(cycles: readonly TMapCycle[], today: Date): TSprintCandidate[] {
  const todayKey = localDateKey(today);
  const oldest = shiftDateKey(todayKey, -SPRINT_MAP_COMPLETED_DAYS);
  const candidates: TSprintCandidate[] = [];
  for (const item of cycles) {
    const start = dateOnly(item.start_date);
    const end = dateOnly(item.end_date);
    if (item.archived_at || !start || !end || end < start) continue;
    if (start <= todayKey && todayKey <= end) candidates.push({ ...item, phase: "current" });
    else if (start > todayKey) candidates.push({ ...item, phase: "upcoming" });
    else if (end >= oldest) candidates.push({ ...item, phase: "completed" });
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- candidates is built here (lib ES2022: no toSorted).
  return candidates.sort(
    (left, right) =>
      PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase] ||
      (left.phase === "completed"
        ? (dateOnly(right.end_date) ?? "").localeCompare(dateOnly(left.end_date) ?? "")
        : (dateOnly(left.start_date) ?? "").localeCompare(dateOnly(right.start_date) ?? "")) ||
      left.name.localeCompare(right.name, "ru")
  );
}

// ─────────────── Имя новой доски ───────────────

export const MAP_BOARD_NAME_MAX = 120;

/** Как сервер (normalize_board_name, ppm_canvas/services.py:84): пробелы схлопнуты, регистр не важен. */
export function normalizeMapBoardName(name: string): string {
  return name.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, Math.max(0, max)).join("").trimEnd();
}

/** «Карта · {спринт}»; занято активной доской — «(2)», «(3)»…; не длиннее 120 знаков (схема доски). */
export function uniqueMapBoardName(template: string, cycleName: string, existing: readonly string[]): string {
  const taken = new Set(existing.map(normalizeMapBoardName));
  const frame = Array.from(fillCanvasTemplate(template, { name: "" })).length;
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const suffix = attempt === 1 ? "" : ` (${attempt})`;
    const name = `${fillCanvasTemplate(template, { name: clip(cycleName, MAP_BOARD_NAME_MAX - frame - suffix.length) })}${suffix}`;
    if (!taken.has(normalizeMapBoardName(name))) return name;
  }
  return fillCanvasTemplate(template, { name: clip(cycleName, MAP_BOARD_NAME_MAX - frame) });
}

/** Имена активных досок проекта: с ними имя новой карты не должно совпасть (архивные сервер не сравнивает). */
export function activeBoardNames(boards: readonly { name: string; status: string }[]): string[] {
  return boards.filter((item) => item.status === "active").map((item) => item.name);
}

/**
 * Новая доска карты открывается вкладкой рабочего пространства: есть ли свободная (предел MAX_OPEN_CANVAS_BOARDS,
 * workspace.tsx). Число вкладок неизвестно (одна доска, без вкладок) — место есть. Решение контроллера (ревью M1):
 * вкладок нет — доска не создаётся, вкладки сами не закрываются.
 */
export function hasFreeBoardTab(openBoardCount: number | undefined): boolean {
  return openBoardCount === undefined || openBoardCount < MAX_OPEN_CANVAS_BOARDS;
}

/**
 * Опрос привязок доски (refreshWorkItems в editor.tsx: раз в 30 с и при фокусе окна) приносит с сервера только active.
 * Карточки, положенные в этой вкладке и ещё не сохранённые, он не стирает (ревью M4): иначе лоток снова показал бы их
 * задачи (вторая карточка той же задачи), а placementRoom не увидел бы очереди активаций. unsavedBindingIds — очередь
 * активаций и сохранение в пути на момент запроса и ответа (сохранение могло закончиться, пока шёл опрос). Фигуру, чью
 * привязку сервер уже знает, берём у сервера.
 */
export function mergeRefreshedBindings(
  local: ReadonlyMap<string, TPpmCanvasBinding>,
  server: readonly TPpmCanvasBinding[],
  unsavedBindingIds: ReadonlySet<string>
): Map<string, TPpmCanvasBinding> {
  const merged = new Map(server.map((binding) => [binding.shape_id, binding]));
  for (const [shapeId, binding] of local)
    if (!merged.has(shapeId) && unsavedBindingIds.has(binding.binding_id)) merged.set(shapeId, binding);
  return merged;
}

// ─────────────── Раскладка по направлениям (R7) ───────────────

export const NO_DIRECTION_KEY = "none";
export type TMapTaskGroup = { key: string; moduleId: string | null; tasks: TMapIssue[]; title: string };

function compareDirections(left: TMapModule, right: TMapModule): number {
  return left.name.localeCompare(right.name, "ru", { sensitivity: "base" }) || left.id.localeCompare(right.id);
}

/** R7: задача в нескольких направлениях — в первом по названию; неизвестные (архивные) направления не считаются. */
export function primaryModuleId(
  moduleIds: readonly string[],
  modulesById: ReadonlyMap<string, TMapModule>
): string | null {
  let first: TMapModule | undefined;
  for (const id of moduleIds) {
    const direction = modulesById.get(id);
    if (direction && (!first || compareDirections(direction, first) < 0)) first = direction;
  }
  return first?.id ?? null;
}

/** Секции по направлениям (по названию, «Без направления» — последней), задачи в секции — по номеру. */
export function groupSprintTasks(
  issues: readonly TMapIssue[],
  modules: readonly TMapModule[],
  noDirectionTitle: string
): TMapTaskGroup[] {
  const modulesById = new Map(modules.map((direction) => [direction.id, direction]));
  const groups = new Map<string, TMapTaskGroup>();
  for (const item of issues) {
    const moduleId = primaryModuleId(item.module_ids, modulesById);
    const key = moduleId ?? NO_DIRECTION_KEY;
    let group = groups.get(key);
    if (!group) {
      group = { key, moduleId, tasks: [], title: (moduleId && modulesById.get(moduleId)?.name) || noDirectionTitle };
      groups.set(key, group);
    }
    group.tasks.push(item);
  }
  const ordered = [...groups.values()];
  for (const group of ordered) {
    // oxlint-disable-next-line unicorn/no-array-sort -- group.tasks is built here (lib ES2022: no toSorted).
    group.tasks.sort((left, right) => left.sequence_id - right.sequence_id);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ordered is a fresh array (lib ES2022: no toSorted).
  return ordered.sort((left, right) => {
    if (left.moduleId === null || right.moduleId === null) {
      if (left.moduleId === right.moduleId) return 0;
      return left.moduleId === null ? 1 : -1;
    }
    return (
      left.title.localeCompare(right.title, "ru", { sensitivity: "base" }) ||
      left.moduleId.localeCompare(right.moduleId)
    );
  });
}

// ─────────────── Строки с числами (ru: один / несколько / много; en: один / много) ───────────────

export function pluralKey<TKey extends TPpmTranslationKey>(
  count: number,
  locale: string,
  keys: { few: TKey; many: TKey; one: TKey }
): TKey {
  const category = new Intl.PluralRules(resolvePpmLocale(locale)).select(count);
  if (category === "one") return keys.one;
  return category === "few" ? keys.few : keys.many;
}

// ─────────────── Группы карты на доске (узел group с полем map) ───────────────

export type TMapShapeRef = { id: string; node: string | null; parentId: string };
export type TMapGroup = {
  createdAt: string;
  descendants: readonly string[];
  id: string;
  map: TPpmCanvasMap;
  /** Родитель фигуры группы: лист («page:…») — группа верхнего уровня (M-7). */
  parentId: string;
};
export type TSprintFrame = TMapGroup & { map: TPpmCanvasSprintMap };

/** Строка узла PPM из фигуры tldraw; иначе null. */
export function shapeNodeJson(shape: { props: unknown; type: string }): string | null {
  if (shape.type !== "ppm-canvas-node") return null;
  const node = (shape.props as { node?: unknown }).node;
  return typeof node === "string" ? node : null;
}

// Разбор узла дорогой, а строка узла группы при перетаскивании не меняется — кэш по строке (не больше 256).
const roleCache = new Map<string, { createdAt: string; map: TPpmCanvasMap } | null>();

/** Роль группы карты (`map` рамки спринта или секции) и дата создания узла; не карта — null. */
export function readMapRole(node: string | null | undefined): { createdAt: string; map: TPpmCanvasMap } | null {
  if (!node || !node.includes('"map"')) return null;
  const cached = roleCache.get(node);
  if (cached !== undefined) return cached;
  const parsed = parseSerializedPpmCanvasNode(node);
  const map = parsed.status === "valid" || parsed.status === "migrated" ? getPpmCanvasMap(parsed.node) : undefined;
  const role =
    map && (parsed.status === "valid" || parsed.status === "migrated")
      ? { createdAt: parsed.node.created_at, map }
      : null;
  if (roleCache.size >= 256) roleCache.clear();
  roleCache.set(node, role);
  return role;
}

/** Группы карты в порядке фигур (рамка — первая по порядку отрисовки) с потомками (секции, карточки) в ширину. */
export function mapGroupsOf(shapes: readonly TMapShapeRef[]): TMapGroup[] {
  const children = new Map<string, string[]>();
  for (const shape of shapes) {
    const list = children.get(shape.parentId) ?? [];
    list.push(shape.id);
    children.set(shape.parentId, list);
  }
  const groups: TMapGroup[] = [];
  for (const shape of shapes) {
    const role = readMapRole(shape.node);
    if (!role) continue;
    const descendants: string[] = [];
    const queue = [...(children.get(shape.id) ?? [])];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      descendants.push(id);
      queue.push(...(children.get(id) ?? []));
    }
    groups.push({ createdAt: role.createdAt, descendants, id: shape.id, map: role.map, parentId: shape.parentId });
  }
  return groups;
}

/** Фигура верхнего уровня — прямой ребёнок листа tldraw (TLPageId — «page:…»). */
export function isPageLevelShape(parentId: string): boolean {
  return parentId.startsWith("page:");
}

/**
 * Итоговое ревью M-7 — одно правило выбора рамки спринта для C и M: первая рамка спринта ВЕРХНЕГО уровня (ребёнок
 * листа) в порядке страницы. Копия ⌘C/⌘V чужой карты лежит после оригинала; рамка, вложенная в другую группу, картой
 * доски не считается. Им пользуются шапка, лоток и опрос карты (sprintFrameOf) и «с начала спринта» ленты
 * (changes-model.ts findSprintCycleId). Сервер (S2) берёт в ленту задачи всех рамок доски (до 10) — задокументировано.
 */
export function firstSprintFrame<TGroup extends { map: TPpmCanvasMap; parentId: string }>(
  groups: Iterable<TGroup>
): (TGroup & { map: TPpmCanvasSprintMap }) | null {
  for (const group of groups)
    if (group.map.role === "sprint" && isPageLevelShape(group.parentId))
      return group as TGroup & { map: TPpmCanvasSprintMap };
  return null;
}

/** Рамка спринта карты (M): firstSprintFrame по группам карты в порядке страницы. */
export function sprintFrameOf(groups: readonly TMapGroup[]): TSprintFrame | null {
  return firstSprintFrame(groups);
}

/** Подпись состава групп — строка для useValue: перерисовка только при смене ролей и детей, не при перетаскивании. */
export function encodeMapGroups(groups: readonly TMapGroup[]): string {
  return groups
    .map((group) =>
      [
        group.id,
        group.map.role,
        group.map.role === "sprint" ? group.map.cycle_id : (group.map.module_id ?? ""),
        group.createdAt,
        group.descendants.join(","),
        group.parentId,
      ].join("\t")
    )
    .join("\n");
}

export function decodeMapGroups(signature: string): TMapGroup[] {
  if (!signature) return [];
  return signature.split("\n").map((line) => {
    const [id, role, ref, createdAt, descendants, parentId] = line.split("\t");
    const map: TPpmCanvasMap =
      role === "sprint" ? { cycle_id: ref, role: "sprint" } : { module_id: ref || null, role: "section" };
    return { createdAt, descendants: descendants ? descendants.split(",") : [], id, map, parentId: parentId ?? "" };
  });
}

/** Ручное изменение размера: рамка и секции карты растут с сеткой карточек (предел группы), прочее — 1600 × 1200. */
export function ppmCanvasResizeLimits(node: string): {
  maxHeight: number;
  maxWidth: number;
  minHeight: number;
  minWidth: number;
} {
  const map = readMapRole(node) !== null;
  return {
    maxHeight: map ? PPM_CANVAS_GROUP_MAX_SIZE : 1200,
    maxWidth: map ? PPM_CANVAS_GROUP_MAX_SIZE : 1600,
    minHeight: 96,
    minWidth: 160,
  };
}

/**
 * «Дублировать» карточки (RM-e, решение контроллера): фигура копии группы — размером узла копии. Копия рамки спринта
 * или секции карты — обычная секция (F1 снимает map и обрезает её до 1600 × 1200); фигура размера исходной рамки не
 * совпала бы со своим узлом. Прочие карточки — размер исходной фигуры, как было.
 */
export function duplicateShapeSize(
  duplicate: TPpmCanvasNode,
  props: { h: number; w: number }
): { h: number; w: number } {
  return duplicate.kind === "group"
    ? { h: duplicate.visual.height, w: duplicate.visual.width }
    : { h: props.h, w: props.w };
}

// ─────────────── RM15 · страж: живые карточки не теряются при удалении группы (RM-a: любой группы PPM) ───────────────

export type TMapGuardShape = { id: string; node: string | null; parentId: string };

/** Живая карточка — узел PPM с привязкой (тот же признак, что у защиты AF2.1 в editor.tsx). */
export function isLiveCardNode(node: string | null): boolean {
  if (!node || !node.includes('"binding"')) return false;
  const parsed = parseSerializedPpmCanvasNode(node);
  return (
    (parsed.status === "valid" || parsed.status === "migrated") &&
    "binding" in parsed.node &&
    Boolean(parsed.node.binding)
  );
}

/** Группа или рамка PPM — узел, у которого бывают дети (canReceiveNewChildrenOfType в shape.tsx); карта — тоже. */
export function isPpmGroupNode(node: string | null): boolean {
  // Без разбора: строка узла группы или рамки (JSON.stringify) всегда содержит "group" или "frame".
  if (!node || (!node.includes('"group"') && !node.includes('"frame"'))) return false;
  const parsed = parseSerializedPpmCanvasNode(node);
  return (
    (parsed.status === "valid" || parsed.status === "migrated") &&
    (parsed.node.kind === "group" || parsed.node.kind === "frame")
  );
}

/**
 * Удаляется группа или рамка PPM (рамка спринта, секция карты, обычная секция или рамка — RM-a, решение контроллера):
 * какие живые карточки внутри неё перенести на страницу. tldraw удаляет группу с потомками, а живые карточки AF2.1 не
 * удаляются — без переноса они остались бы без родителя (вне страницы, невидимы; баг AF2.1). Внутрь живой карточки не
 * заходим; не группа — пусто.
 */
export function mapGroupRescueIds(
  groupNode: string | null,
  groupId: string,
  childrenOf: (id: string) => readonly TMapGuardShape[]
): string[] {
  if (!isPpmGroupNode(groupNode)) return [];
  const rescue: string[] = [];
  const queue = [...childrenOf(groupId)];
  for (let shape = queue.shift(); shape !== undefined; shape = queue.shift()) {
    if (isLiveCardNode(shape.node)) rescue.push(shape.id);
    else queue.push(...childrenOf(shape.id));
  }
  return rescue;
}

// ─────────────── Типы полей линии M (living-map-types.ts ссылается на них import-типами) ───────────────

/** Живая карточка доски: фигура есть в редакторе, её привязка — задача или PR. */
export type TLivingMapCard = { binding: TPpmCanvasBinding; shapeId: string };

export type TTaskLinkKind = "blocks" | "depends_on" | "implements" | "relates_to";
export type TTaskRelationEdge = {
  fromLabel: string;
  fromShapeId: string;
  id: string;
  kind: TTaskLinkKind;
  toLabel: string;
  toShapeId: string;
};

export type TLivingMapSprint = {
  cycleId: string;
  done: number;
  endDate: string | null;
  /** Спринт удалён, в архиве или недоступен: шапка показывает заголовок узла и «спринт недоступен». */
  missing: boolean;
  name: string;
  startDate: string | null;
  total: number;
};

export type TNotOnMapItem =
  | {
      assignees: string;
      identifier: string;
      key: string;
      kind: "task";
      moduleId: string | null;
      /** null — «Без направления» (подпись — на языке интерфейса у вида). */
      moduleName: string | null;
      stateGroup: string | null;
      stateName: string | null;
      title: string;
      workItemId: string;
    }
  | {
      entityId: string;
      /** M4 · RM-c: ручная ссылка без объекта Git — в лотке видна, но на доску не кладётся. */
      hasGitObject: boolean;
      key: string;
      kind: "pull_request";
      moduleId: string | null;
      moduleName: string | null;
      ref: string | null;
      repositoryName: string;
      title: string;
      workItemId: string;
      workItemIdentifier: string;
    };

export type TLivingMapTray = { builtAt: string | null; enabled: boolean; items: readonly TNotOnMapItem[] };
export const EMPTY_LIVING_MAP_TRAY: TLivingMapTray = { builtAt: null, enabled: false, items: [] };

export type TMapPlacementRequest = {
  entityId: string;
  entityType: "pull_request" | "work_item";
  key: string;
  moduleId: string | null;
  sectionTitle: string;
  size: { h: number; w: number };
};

export type TPlaceOnMapResult = {
  cardIds: string[];
  failed: number;
  /** M4 (ревью M1): рамка спринта стала бы выше предела группы — ничего не привязано и не положено. */
  noRoom?: boolean;
  placed: number;
  /** M4 · RM-d: сколько отобранных пунктов это нажатие не взяло (предел S1 и одного сохранения) — «нажмите ещё раз». */
  remaining?: number;
};
