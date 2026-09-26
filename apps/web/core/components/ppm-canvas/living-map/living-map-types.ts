// AF2.2 «Живая карта проекта» — общие типы линий M (карта спринта, «Светофор», «Не на карте», связи «из Задач») и C
// («Что изменилось»). Владелец — F. Линии M и C добавляют ТОЛЬКО необязательные поля и ТОЛЬКО в свои размеченные
// блоки ниже (CONTRACTS §2); обязательные поля и пустые значения — контракт F.
import type { TPpmCanvasBinding, TPpmCanvasBoard, TPpmCanvasMapRole } from "@ppm/canvas";
import type { Editor } from "tldraw";
// ── AF2.2 C: тип панели «Что изменилось» (changes-model.ts линии C) ──
import type { TBoardChangesPanel } from "./changes-model";
// ── /AF2.2 C ──

/** «Светофор» of a live task card (spec C): blocked beats overdue; done is muted; none — nothing to show. */
export type TTrafficState = "blocked" | "overdue" | "done" | "none";

/** Another Plane task as a card names it («заблокирована ROBOT-12»). */
export type TWorkItemRef = { id: string; identifier: string | null };

/** Live facts of one task on this board (line M, useLivingMapFacts), keyed by its work item id. */
export type TWorkItemFacts = {
  /** Plane work item id — the card's `binding.entity_id`. */
  workItemId: string;
  traffic: TTrafficState;
  /** Unfinished tasks that block this one, in Plane's order (the first one is named on the card). */
  blockedBy: readonly TWorkItemRef[];
  // Final review M-8: no `relations` here — the «из Задач» lines come from relationEdges (task-relations.ts).
  // ── AF2.2 M: необязательные поля линии M ──
  /** Срок задачи YYYY-MM-DD — строка «просрочено · 20 сент.» на карточке (traffic === "overdue"). */
  dueDate?: string | null;
  // ── /AF2.2 M ──
};

/** Header facts of a sprint frame or a map section on this board, keyed by the group's tldraw shape id. */
export type TMapSectionSummary = {
  role: TPpmCanvasMapRole;
  /** Live task cards inside the frame or the section. */
  total: number;
  done: number;
  overdue: number;
  blocked: number;
  // ── AF2.2 M: необязательные поля линии M ──
  // ── /AF2.2 M ──
};

/** What line M's useLivingMapFacts returns — spread into the living-map context. */
export type TLivingMapFacts = {
  facts: ReadonlyMap<string, TWorkItemFacts>;
  mapSections: ReadonlyMap<string, TMapSectionSummary>;
  // ── AF2.2 M: необязательные поля линии M ──
  /** Направления проекта по id — живые названия секций карты и пунктов лотка. */
  modules?: ReadonlyMap<string, import("./map-model").TMapModule>;
  /** «+ Добавить» / «Разложить всё» лотка: только редактор активной вкладки; итог — для уведомления вида. */
  placeFromTray?: (
    keys: readonly string[],
    noDirectionTitle: string
  ) => Promise<import("./map-model").TPlaceOnMapResult | null>;
  /** Идёт раскладка из лотка — кнопки лотка недоступны. */
  placing?: boolean;
  /** Связи «из Задач» между живыми карточками этой доски (task-relations-layer.tsx). */
  relationEdges?: readonly import("./map-model").TTaskRelationEdge[];
  /** Спринт рамки карты: название, даты, прогресс Plane (шапка рамки; C — «с начала спринта»); null — нет рамки. */
  sprint?: import("./map-model").TLivingMapSprint | null;
  /** Лоток «Не на карте» (только доска с рамкой спринта). */
  tray?: import("./map-model").TLivingMapTray;
  // ── /AF2.2 M ──
};

/** «добавлено» / «изменено» on a card while its user has unseen changes (spec E). */
export type TBoardChangeMark = "added" | "changed";

/** What line C's useBoardChanges returns — the context's `changes`. */
export type TBoardChangeIndex = {
  /** Unseen events of this board («Что изменилось · N»). */
  count: number;
  /** The mark of every card with unseen events, by tldraw shape id. */
  byShapeId: ReadonlyMap<string, TBoardChangeMark>;
  // ── AF2.2 C: необязательные поля линии C ──
  /** Tasks with unseen events by Plane work item id: a card put on the board after the feed loaded is marked too. */
  byWorkItemId?: ReadonlyMap<string, TBoardChangeMark>;
  /** The «Что изменилось» panel — period, feed, status, actions (kept in useBoardChanges, outside CanvasControls). */
  panel?: TBoardChangesPanel;
  // ── /AF2.2 C ──
};

/**
 * The board's editor as the living map sees it. editor.tsx builds it in one useMemo (livingMapArgs) and hands it to
 * useLivingMapFacts, useBoardChanges and every view through the context (`args`).
 */
export type TLivingMapArgs = {
  authorId: string;
  /** Live bindings of this board by tldraw shape id (the editor's bindingsByShapeId; refreshed every 30 s). */
  bindingsByShapeId: ReadonlyMap<string, TPpmCanvasBinding>;
  boardId: string;
  /** Every board of the project Canvas (names for «Карта · …», links). */
  boards: readonly TPpmCanvasBoard[];
  /** The board is loaded, editable and not blocked (effectiveCanEdit). Write to it only then. */
  canEdit: boolean;
  /** This board's tldraw editor, once mounted. */
  editor: Editor | undefined;
  /** The v2 canvas grammar. false (v1, minimal mode): return the empty value, fetch and listen to nothing. */
  enabled: boolean;
  /** AF2.1 R19: only the active tab polls, listens to window/document and writes to its board. */
  isActive: boolean;
  /** The board's snapshot has loaded (the editor finished initializing). */
  loaded: boolean;
  /** A board created from this editor (the sprint map) joins the workspace's list and opens as the active tab. */
  onBoardCreated: (board: TPpmCanvasBoard) => void;
  onOpenBoard: (boardId: string) => void;
  projectId: string;
  /**
   * Cards the caller has just put on the board with fresh (pending) bindings: they activate with the next save, show
   * their projections at once and schedule an autosave — the path «Задача» from the rail takes.
   */
  registerBindings: (bindings: readonly TPpmCanvasBinding[]) => void;
  workspaceId: string;
  workspaceSlug: string;
  // ── AF2.2 M: необязательные поля линии M (значения — livingMapArgsM, блок M в editor.tsx) ──
  /** Есть ли свободная вкладка для новой доски (карта спринта; предел вкладок workspace.tsx). Нет поля — есть. */
  canOpenBoard?: () => boolean;
  /** Уведомление холста (setContentNotice блока AF2.1 B1): итог сборки карты и раскладки из лотка. */
  notify?: (message: string) => void;
  /** Идентификатор проекта Plane («ROBOT») — номера задач в лотке и у блокирующих задач. */
  projectIdentifier?: string | null;
  /** Статусы и участники проекта (work_item_options доски): группы статусов блокирующих, имена в лотке. */
  workItemOptions?: import("@ppm/canvas").TPpmWorkItemEditOptions;
  // ── /AF2.2 M ──
  // ── AF2.2 C: необязательные поля линии C (значения — livingMapArgsC, блок C в editor.tsx) ──
  // ── /AF2.2 C ──
};

export const EMPTY_LIVING_MAP_FACTS: TLivingMapFacts = { facts: new Map(), mapSections: new Map() };

export const EMPTY_BOARD_CHANGE_INDEX: TBoardChangeIndex = { byShapeId: new Map(), count: 0 };

/** The editor environment outside a provider: nothing enabled, nothing to write to. */
export const EMPTY_LIVING_MAP_ARGS: TLivingMapArgs = {
  authorId: "",
  bindingsByShapeId: new Map(),
  boardId: "",
  boards: [],
  canEdit: false,
  editor: undefined,
  enabled: false,
  isActive: false,
  loaded: false,
  onBoardCreated: () => undefined,
  onOpenBoard: () => undefined,
  projectId: "",
  registerBindings: () => undefined,
  workspaceId: "",
  workspaceSlug: "",
};
