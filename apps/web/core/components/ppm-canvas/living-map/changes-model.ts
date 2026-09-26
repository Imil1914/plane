/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// AF2.2 C1/C2 · «Что изменилось»: чистая модель без React и DOM (node-env vitest). Период ленты («с последнего
// просмотра» · «с начала спринта» · «с даты…»), правило по умолчанию (R5), загрузка двух лент (непросмотренное — для
// меток и счётчика, выбранный период — для панели), свёртка, индекс меток, переход к карточке.
import { parseSerializedPpmCanvasNode, type TPpmCanvasMap } from "@ppm/canvas";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import type { TPpmBoardChange, TPpmBoardChangesResponse, TPpmBoardSeen } from "@/services/ppm-canvas-changes.service";
import type { TBoardChangeMark } from "./living-map-types";
import { firstSprintFrame, readMapRole, shapeNodeJson } from "./map-model";

const DAY_MS = 86_400_000;
/** R8: пока панель открыта — раз в 60 с. */
export const PPM_CHANGES_POLL_MS = 60_000;
/** R5: без отметки — с создания доски, но не раньше 7 дней назад. */
export const PPM_CHANGES_DEFAULT_DAYS = 7;
/** S2 отдаёт не больше 30 дней: поле «с даты…» раньше не предлагает. */
export const PPM_CHANGES_MAX_DAYS = 30;
/** focus и visibilitychange при возврате в окно приходят парой — один запрос. */
export const PPM_CHANGES_RETURN_GAP_MS = 2_000;
/** Поле «с даты…» шлёт значение на каждую цифру года: лента грузится через 400 мс после последней правки. */
export const PPM_CHANGES_DATE_DEBOUNCE_MS = 400;

export type TChangesMode = "last_seen" | "sprint" | "date";
export type TBoardChangesStatus = "idle" | "loading" | "ready" | "error" | "unavailable";
export type TChangesFeed = { items: readonly TPpmBoardChange[]; since: string; truncated: boolean };
export type TChangesPeriodFeed = TChangesFeed & { key: string };

export type TBoardChangesState = {
  status: TBoardChangesStatus;
  seenAt: string | null;
  /** С личной отметки: метки на карточках и число на кнопке. */
  unseen: TChangesFeed | null;
  /** Период панели, если он не «с последнего просмотра» (key — какой именно). */
  period: TChangesPeriodFeed | null;
};

export const INITIAL_BOARD_CHANGES_STATE: TBoardChangesState = {
  period: null,
  seenAt: null,
  status: "idle",
  unseen: null,
};

/** Состояние панели в контексте живой карты (поле `changes.panel`, наполняет useBoardChanges). */
export type TBoardChangesPanel = {
  /** Фокус переходит в панель или на кнопку один раз — после действия пользователя, не при перемонтировании. */
  consumeFocus: (target: "panel" | "button") => boolean;
  currentUserId: string;
  /** Набранное в поле «с даты…»; в ленту уходит через 400 мс и в пределах окна (clampChangesDate). */
  customDate: string;
  entries: readonly TPpmBoardChange[];
  markError: boolean;
  markSeen: () => void;
  marking: boolean;
  mode: TChangesMode;
  open: boolean;
  retry: () => void;
  setCustomDate: (value: string) => void;
  setMode: (mode: TChangesMode) => void;
  setOpen: (open: boolean) => void;
  since: string | null;
  sprintAvailable: boolean;
  status: TBoardChangesStatus;
  truncated: boolean;
  unseenTruncated: boolean;
};

// ─────────────── Период ───────────────

/** R5: с личной отметки; без неё — с создания доски, но не раньше 7 дней назад. */
export function defaultChangesSince(seenAt: string | null, boardCreatedAt: string | null, now: number): string {
  if (seenAt && Number.isFinite(Date.parse(seenAt))) return seenAt;
  const floor = now - PPM_CHANGES_DEFAULT_DAYS * DAY_MS;
  const created = boardCreatedAt ? Date.parse(boardCreatedAt) : Number.NaN;
  return new Date(Number.isFinite(created) ? Math.max(created, floor) : floor).toISOString();
}

/** Календарная дата «YYYY-MM-DD…» (начало спринта, поле «с даты…») → местная полночь в ISO; иначе null. */
export function localDayStartIso(date: string | null | undefined): string | null {
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const value = new Date(year, month, day);
  return value.getMonth() === month && value.getDate() === day ? value.toISOString() : null;
}

/** Значение `<input type="date">` для местной даты момента. */
export function localDateValue(value: string | number): string {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Границы поля «с даты…»: не раньше 30 дней (S2) и не позже сегодня. */
export function changesDateBounds(now: number): { max: string; min: string } {
  return { max: localDateValue(now), min: localDateValue(now - PPM_CHANGES_MAX_DAYS * DAY_MS) };
}

/** Дата «с даты…» для ленты: min/max поля ввод не ограничивают — прижать к окну; пустое или битое значение → "". */
export function clampChangesDate(value: string, now: number): string {
  if (!localDayStartIso(value)) return "";
  const { max, min } = changesDateBounds(now);
  const day = value.slice(0, 10);
  return day < min ? min : day > max ? max : day;
}

export function changesPeriodKey(mode: TChangesMode, customDate: string, sprintStart: string | null): string {
  if (mode === "sprint") return `sprint:${sprintStart ?? ""}`;
  return mode === "date" ? `date:${customDate}` : "last_seen";
}

export function changesSinceForMode(input: {
  boardCreatedAt: string | null;
  customDate: string;
  mode: TChangesMode;
  now: number;
  seenAt: string | null;
  sprintStart: string | null;
}): string {
  const chosen =
    input.mode === "sprint"
      ? localDayStartIso(input.sprintStart)
      : input.mode === "date"
        ? localDayStartIso(input.customDate)
        : null;
  return chosen ?? defaultChangesSince(input.seenAt, input.boardCreatedAt, input.now);
}

// ─────────────── Загрузка ───────────────

export type TBoardChangesApi = {
  getChanges: (since: string) => Promise<TPpmBoardChangesResponse>;
  getSeen: () => Promise<TPpmBoardSeen>;
};

export type TBoardChangesLoadInput = {
  boardCreatedAt: string | null;
  customDate: string;
  mode: TChangesMode;
  now: number;
  panelOpen: boolean;
  sprintStart: string | null;
};

export type TBoardChangesLoad = { period: TChangesPeriodFeed | null; seenAt: string | null; unseen: TChangesFeed };

/** Отметка (S3) → лента непросмотренного (S2); если открытая панель показывает другой период — вторая лента. */
export async function loadBoardChanges(
  api: TBoardChangesApi,
  input: TBoardChangesLoadInput
): Promise<TBoardChangesLoad> {
  const { seen_at: seenAt } = await api.getSeen();
  const unseenSince = defaultChangesSince(seenAt, input.boardCreatedAt, input.now);
  const periodSince = input.panelOpen && input.mode !== "last_seen" ? changesSinceForMode({ ...input, seenAt }) : null;
  const [unseen, period] = await Promise.all([
    api.getChanges(unseenSince),
    periodSince !== null && periodSince !== unseenSince ? api.getChanges(periodSince) : Promise.resolve(null),
  ]);
  const unseenFeed = toFeed(unseen);
  const key = changesPeriodKey(input.mode, input.customDate, input.sprintStart);
  return {
    period: periodSince === null ? null : { ...(period ? toFeed(period) : unseenFeed), key },
    seenAt,
    unseen: unseenFeed,
  };
}

function toFeed(response: TPpmBoardChangesResponse): TChangesFeed {
  return { items: response.items, since: response.since, truncated: response.truncated };
}

/** Та же лента: те же события и те же карточки у них (задачу положили на доску — строка кликабельна, метка есть). */
export function sameChangeItems(a: readonly TPpmBoardChange[], b: readonly TPpmBoardChange[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.id === b[index].id &&
        item.occurred_at === b[index].occurred_at &&
        item.shape_ids.join("\n") === b[index].shape_ids.join("\n")
    )
  );
}

/** «Загружаем…» — только до первого ответа; «недоступно» не мигает при повторных попытках. */
export function beginChangesLoad(current: TBoardChangesState): TBoardChangesState {
  return current.unseen || current.status === "unavailable" ? current : { ...current, status: "loading" };
}

/** Тот же массив событий, если ничего не изменилось: метки на карточках не перерисовываются от опроса. */
export function mergeLoadedChanges(current: TBoardChangesState, loaded: TBoardChangesLoad): TBoardChangesState {
  const unseen =
    current.unseen && sameChangeItems(current.unseen.items, loaded.unseen.items)
      ? { ...loaded.unseen, items: current.unseen.items }
      : loaded.unseen;
  return { period: loaded.period, seenAt: loaded.seenAt, status: "ready", unseen };
}

/** 403/404 — ленты нет (сервер без S2/S3 или нет доступа): кнопка и метки скрыты; прочее — «повторить». */
export function changesLoadStatus(error: unknown): "error" | "unavailable" {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return status === 403 || status === 404 ? "unavailable" : "error";
}

export function failChangesLoad(current: TBoardChangesState, error: unknown): TBoardChangesState {
  const status = changesLoadStatus(error);
  return status === "unavailable" ? { ...INITIAL_BOARD_CHANGES_STATE, status } : { ...current, status };
}

/** «Отметить просмотренным» — непросмотренного больше нет: метки исчезают сразу, до новой загрузки. */
export function applySeen(current: TBoardChangesState, seenAt: string | null): TBoardChangesState {
  return { ...current, seenAt, unseen: { items: [], since: seenAt ?? current.unseen?.since ?? "", truncated: false } };
}

export function shouldRefreshOnReturn(lastLoadAt: number, now: number): boolean {
  return now - lastLoadAt >= PPM_CHANGES_RETURN_GAP_MS;
}

// ─────────────── Свёртка и метки ───────────────

// Поле, у которого важно последнее значение: показываем одно — самое новое.
const LATEST_ONLY_KINDS: ReadonlySet<string> = new Set([
  "work_item.state",
  "work_item.due",
  "work_item.priority",
  "work_item.name",
  "vault.version",
  "board.node.changed",
]);

/** Значение old/new из S2: строка (обрезанная) или число; пустое и прочее — null. */
export function changeText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Новые первыми; у полей «последнего значения» (статус, срок, приоритет, название, версия файла, правка карточки) —
 * одна строка, самая новая; «добавлено» поглощает «изменено» той же карточки. Связь S2 уже склеил из двух строк Plane.
 */
export function groupBoardChanges(items: readonly TPpmBoardChange[]): TPpmBoardChange[] {
  const addedNodes = new Set(items.filter((item) => item.kind === "board.node.added").map((item) => item.entity.id));
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy (lib ES2022: no toSorted).
  const newestFirst = [...items].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  const taken = new Set<string>();
  const entries: TPpmBoardChange[] = [];
  for (const item of newestFirst) {
    if (item.kind === "board.node.changed" && addedNodes.has(item.entity.id)) continue;
    if (LATEST_ONLY_KINDS.has(item.kind)) {
      const key = `${item.kind}:${item.entity.type}:${item.entity.id}`;
      if (taken.has(key)) continue;
      taken.add(key);
    }
    entries.push(item);
  }
  return entries;
}

/**
 * R9 (решение контроллера): свои действия — не новость. «С последнего просмотра» (число на кнопке, метки на карточках,
 * список) — свёрнутая лента без событий текущего пользователя; «с начала спринта» и «с даты…» показывают всё, свои —
 * с подписью «Вы». Чужое не скрывается никогда, поэтому свои события доски убираются ДО свёртки: иначе своё «добавлено»
 * поглотило бы чужую правку той же карточки и исчезло вместе с ней. С S2a у правок фигур есть автор (автор версии
 * доски) и они фильтруются как свои/чужие; без автора остаются лишь версии до S2a и авторы вне рабочего пространства:
 * такая правка карточки, которую пользователь сам добавил в этом окне, — почти наверняка его же, правка без автора прочих
 * карточек остаётся. Поля задач и версии файлов — «последнее значение»: свёртка, потом фильтр (последнее значение
 * поставил сам — более старое чужое уже не новость).
 */
export function unseenChangeEntries(items: readonly TPpmBoardChange[], currentUserId: string): TPpmBoardChange[] {
  if (!currentUserId) return groupBoardChanges(items);
  const mine = (item: TPpmBoardChange) => item.actor?.id === currentUserId;
  const myNewNodes = new Set(
    items.filter((item) => item.kind === "board.node.added" && mine(item)).map((item) => item.entity.id)
  );
  const others = items.filter((item) => {
    if (item.kind === "board.node.added") return !mine(item);
    if (item.kind !== "board.node.changed") return true;
    return !mine(item) && !(item.actor === null && myNewNodes.has(item.entity.id));
  });
  return groupBoardChanges(others).filter((item) => !mine(item));
}

/** Индекс меток: карточки из shape_ids; задачи — ещё и по id (карточку могли положить после загрузки ленты). */
export function buildBoardChangeIndex(items: readonly TPpmBoardChange[]): {
  byShapeId: Map<string, TBoardChangeMark>;
  byWorkItemId: Map<string, TBoardChangeMark>;
} {
  const byShapeId = new Map<string, TBoardChangeMark>();
  const byWorkItemId = new Map<string, TBoardChangeMark>();
  for (const item of items) {
    const mark: TBoardChangeMark = item.kind === "board.node.added" ? "added" : "changed";
    for (const shapeId of item.shape_ids) if (byShapeId.get(shapeId) !== "added") byShapeId.set(shapeId, mark);
    if (item.entity.type === "work_item") byWorkItemId.set(item.entity.id, "changed");
  }
  return { byShapeId, byWorkItemId };
}

/** id задачи живой карточки (узел work_item_ref) — для метки по задаче; прочие карточки → null. */
export function workItemIdOfNode(serializedNode: string): string | null {
  if (!serializedNode.includes('"work_item_ref"')) return null;
  const parsed = parseSerializedPpmCanvasNode(serializedNode);
  return (parsed.status === "valid" || parsed.status === "migrated") && parsed.node.kind === "work_item_ref"
    ? parsed.node.binding.entity_id
    : null;
}

export function changeMarkForShape(
  index: { byShapeId: ReadonlyMap<string, TBoardChangeMark>; byWorkItemId?: ReadonlyMap<string, TBoardChangeMark> },
  shapeId: string,
  workItemId: string | null
): TBoardChangeMark | undefined {
  return index.byShapeId.get(shapeId) ?? (workItemId ? index.byWorkItemId?.get(workItemId) : undefined);
}

// ─────────────── Доска ───────────────

type TBoardShapeLike = { parentId: string; props: unknown; type: string };

/** Группы карты среди фигур — по одной, пока их спрашивают (разбор узла — дешёвый отсев и кэш readMapRole). */
function* sprintMapGroups(
  shapes: Iterable<TBoardShapeLike | undefined>
): Generator<{ map: TPpmCanvasMap; parentId: string }> {
  for (const shape of shapes) {
    // Дешёвый отсев до разбора JSON: у рамки спринта в строке узла есть "sprint".
    const node = shape ? shapeNodeJson(shape) : null;
    if (!shape || !node?.includes('"sprint"')) continue;
    const role = readMapRole(node);
    if (role) yield { map: role.map, parentId: shape.parentId };
  }
}

/**
 * Рамка спринта карты — узел group с `map.role = "sprint"` (схема F); без неё «с начала спринта» не предлагается.
 * Правило выбора — общее с линией M (итоговое ревью M-7, firstSprintFrame): первая рамка верхнего уровня в порядке
 * страницы, как у шапки и лотка карты.
 */
export function findSprintCycleId(shapes: Iterable<TBoardShapeLike | undefined>): string | null {
  return firstSprintFrame(sprintMapGroups(shapes))?.map.cycle_id ?? null;
}

/** Фигуры верхнего уровня на всех листах доски, в порядке страницы (рамка спринта — верхнего уровня, M-7). */
export function boardTopLevelShapes(
  editor: Pick<Editor, "getPages" | "getShape" | "getSortedChildIdsForParent">
): (TLShape | undefined)[] {
  return editor
    .getPages()
    .flatMap((page) => editor.getSortedChildIdsForParent(page.id).map((id) => editor.getShape(id)));
}

/** Какие карточки ленты есть на доске: строка-ключ, чтобы перетаскивание не перерисовывало панель. */
export function presentShapeKey(entries: readonly TPpmBoardChange[], exists: (shapeId: string) => boolean): string {
  const present = new Set<string>();
  for (const entry of entries)
    for (const shapeId of entry.shape_ids) if (!present.has(shapeId) && exists(shapeId)) present.add(shapeId);
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy (lib ES2022: no toSorted).
  return [...present].sort().join("\n");
}

export type TChangeFocusEditor = Pick<
  Editor,
  | "centerOnPoint"
  | "getAncestorPageId"
  | "getCurrentPageId"
  | "getSelectionPageBounds"
  | "getShape"
  | "select"
  | "setCurrentPage"
>;

/** Щелчок по событию: лист первой найденной карточки, выделить её карточки на нём, центр камеры — масштаб не меняется. */
export function focusChangeShapes(editor: TChangeFocusEditor, shapeIds: readonly string[]): boolean {
  const shapes = shapeIds
    .map((shapeId) => editor.getShape(shapeId as TLShapeId))
    .filter((shape): shape is TLShape => Boolean(shape));
  const pageId = shapes[0] ? editor.getAncestorPageId(shapes[0]) : undefined;
  if (!pageId) return false;
  if (pageId !== editor.getCurrentPageId()) editor.setCurrentPage(pageId);
  editor.select(...shapes.filter((shape) => editor.getAncestorPageId(shape) === pageId).map((shape) => shape.id));
  const bounds = editor.getSelectionPageBounds();
  if (bounds) editor.centerOnPoint(bounds.center, { animation: { duration: 220 } });
  return true;
}
