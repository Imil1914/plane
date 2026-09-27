// UXR (поток параллельно релизу, 2026-09-26): «Смысл» у обычной стрелки. Выделена ровно одна стрелка tldraw, оба её
// конца привязаны к двум разным карточкам PPM — то же правило, что у списка объектов формы «Смысловые связи» (любая
// карточка страницы, две разные). В панели над выделением — выбор «Смысл»: «Просто стрелка» или тип смысловой связи.
// Выбор типа создаёт связь существующим путём (onCreateSemanticEdge: источник — карточка начала, цель — конца) и после
// успеха убирает стрелку одним шагом истории — дальше линию рисует слой смысловых связей. «Отменить» удаляет связь и
// возвращает стрелку. Без runtime-импорта tldraw: проверяется в node с поддельным редактором (uxr-canvas-panel.test.ts).
// Раунд 1 рецензии: сначала сохраняется доска (сервер принимает связь только между сохранёнными карточками); после ⌘Z
// стрелка помнит свою связь — выбор показывает её тип, другой тип заменяет её, «Просто стрелка» удаляет; подпись длиннее
// предела уточнения и потерянные права оставляют стрелку на месте с честным уведомлением.
import type { Editor, TLArrowBinding, TLArrowShape, TLShape, TLShapeId } from "tldraw";
import type { TPpmCanvasSemanticEdge, TPpmCanvasSemanticRelationType } from "@ppm/canvas";
import type { TPpmTranslationKey } from "@ppm/brand";
import { fillCanvasTemplate } from "./canvas-grammar";
import { SEMANTIC_RELATION_LABELS } from "./semantic-edge-style";
import type { TPpmCanvasShape } from "./shape";

// shape.tsx's PPM_CANVAS_SHAPE_TYPE as a checked literal: a runtime import would pull every card component into node.
const PPM_CANVAS_SHAPE_TYPE = "ppm-canvas-node" satisfies TPpmCanvasShape["type"];

/** The arrow and the two cards it joins: start → source, end → target. */
export type TPpmArrowMeaningTarget = { arrowId: TLShapeId; fromShapeId: TLShapeId; toShapeId: TLShapeId };

/** The frequent meanings first (brief UXR §1): «Связано с», «Зависит от», «Блокирует», «Противоречит». */
export const ARROW_MEANING_FREQUENT = [
  "relates_to",
  "depends_on",
  "blocks",
  "contradicts",
] as const satisfies readonly TPpmCanvasSemanticRelationType[];

const FREQUENT: ReadonlySet<TPpmCanvasSemanticRelationType> = new Set(ARROW_MEANING_FREQUENT);

/** Every relation type once: the frequent ones, then the rest in the order of SEMANTIC_RELATION_LABELS. */
export const ARROW_MEANING_ORDER: readonly TPpmCanvasSemanticRelationType[] = [
  ...ARROW_MEANING_FREQUENT,
  ...(Object.keys(SEMANTIC_RELATION_LABELS) as TPpmCanvasSemanticRelationType[]).filter((type) => !FREQUENT.has(type)),
];

/** Which cards an arrow joins, or undefined unless both ends are bound to two different PPM cards of the board. */
export function readArrowMeaningTarget(editor: Editor, shape: TLShape): TPpmArrowMeaningTarget | undefined {
  if (shape.type !== "arrow") return undefined;
  const bindings = editor.getBindingsFromShape<TLArrowBinding>(shape, "arrow");
  const fromShapeId = bindings.find((binding) => binding.props.terminal === "start")?.toId;
  const toShapeId = bindings.find((binding) => binding.props.terminal === "end")?.toId;
  if (!fromShapeId || !toShapeId || fromShapeId === toShapeId) return undefined;
  const isCard = (id: TLShapeId) => editor.getShape(id)?.type === PPM_CANVAS_SHAPE_TYPE;
  return isCard(fromShapeId) && isCard(toShapeId) ? { arrowId: shape.id, fromShapeId, toShapeId } : undefined;
}

export function isSameArrowMeaningTarget(
  a: TPpmArrowMeaningTarget | undefined,
  b: TPpmArrowMeaningTarget | undefined
): boolean {
  if (!a || !b) return a === b;
  return a.arrowId === b.arrowId && a.fromShapeId === b.fromShapeId && a.toShapeId === b.toShapeId;
}

/** The server keeps a link's clarification up to this many characters (the edge's `label`, max_length 255). */
export const ARROW_LABEL_MAX = 255;

/** Characters as the server counts them (code points: an emoji is one, not two UTF-16 units). */
function labelLength(text: string): number {
  return [...text].length;
}

/** The arrow's own label (tldraw 3.15: `props.text`) on one line — it becomes the link's clarification as it is. */
export function arrowLabelText(arrow: { props: { text?: unknown } }): string {
  const text = typeof arrow.props.text === "string" ? arrow.props.text : "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The link this arrow became earlier in the session (arrow id → link id): after ⌘Z the arrow is back and the link
 * stayed. Only while that link still joins the same cards in the same direction and was not rejected.
 */
export function arrowMeaningLink(
  target: TPpmArrowMeaningTarget,
  edges: readonly TPpmCanvasSemanticEdge[],
  links: ReadonlyMap<string, string>
): TPpmCanvasSemanticEdge | undefined {
  const edgeId = links.get(target.arrowId);
  const edge = edgeId ? edges.find((item) => item.edge_id === edgeId) : undefined;
  if (!edge || edge.confirmation_status === "rejected") return undefined;
  return edge.from_shape_id === target.fromShapeId && edge.to_shape_id === target.toShapeId ? edge : undefined;
}

/** What «Отменить» needs to put the arrow back as it was: the record and its bindings (ids kept). */
export type TPpmArrowMeaningSnapshot = { arrow: TLArrowShape; bindings: TLArrowBinding[] };

export type TPpmArrowMeaningSaved = {
  status: "saved";
  arrowId: TLShapeId;
  edge: TPpmCanvasSemanticEdge;
  /** The arrow taken off the board; undefined when it changed while the link was being saved (then it stays). */
  removed?: TPpmArrowMeaningSnapshot;
  /** The arrow's previous link (after ⌘Z) that this one replaced — deleted before the new one was created. */
  replaced?: string;
};

export type TPpmArrowMeaningOutcome =
  | TPpmArrowMeaningSaved
  /** «Просто стрелка» over the arrow's link: the link is gone, the arrow stays. */
  | { status: "cleared"; edgeId: string }
  /** The choice is what the arrow already means: nothing to do. */
  | { status: "unchanged" }
  /** The arrow's text is longer than a clarification may be: nothing changes, the arrow stays. */
  | { status: "label_too_long" }
  /** The board could not be saved first (the server takes a link only between saved cards): the arrow stays. */
  | { status: "unsaved" }
  /** Editing rights are gone — before the request nothing is created; after it the link is saved and the arrow stays. */
  | { status: "readonly"; edge?: TPpmCanvasSemanticEdge }
  /** The server refused; `previousRemoved` — the arrow's previous link had already been deleted. */
  | { status: "error"; previousRemoved?: boolean };

export type TPpmCreateSemanticEdge = (
  fromShapeId: string,
  toShapeId: string,
  relationType: TPpmCanvasSemanticRelationType,
  label: string
) => Promise<TPpmCanvasSemanticEdge>;

export type TPpmArrowMeaningDeps = {
  /** May the user edit the board right now (read again after every wait). */
  canEdit: () => boolean;
  create: TPpmCreateSemanticEdge;
  remove: (edgeId: string) => Promise<void>;
  /** The editor's settleCanvasSave: true — every change of the board is on the server. */
  settleSave: () => Promise<boolean>;
};

/**
 * «Смысл» → a choice. A type: the board is saved first (the server takes a link only between saved cards), the
 * arrow's previous link (after ⌘Z) is deleted, the new link is created — nothing on the board changes before the
 * server answers — and then the arrow goes in one history step. «Просто стрелка» over the arrow's link deletes the link
 * and keeps the arrow. Every other outcome leaves the arrow where it is.
 */
export async function applyArrowMeaning(
  editor: Editor,
  target: TPpmArrowMeaningTarget,
  relation: TPpmCanvasSemanticRelationType | undefined,
  current: TPpmCanvasSemanticEdge | undefined,
  deps: TPpmArrowMeaningDeps
): Promise<TPpmArrowMeaningOutcome> {
  if (relation === current?.relation_type) return { status: "unchanged" };
  if (!relation) {
    if (!current) return { status: "unchanged" };
    if (!deps.canEdit()) return { status: "readonly" };
    try {
      await deps.remove(current.edge_id);
    } catch {
      return { status: "error" };
    }
    return { status: "cleared", edgeId: current.edge_id };
  }
  const arrow = editor.getShape<TLArrowShape>(target.arrowId);
  const label = arrow ? arrowLabelText(arrow) : "";
  if (labelLength(label) > ARROW_LABEL_MAX) return { status: "label_too_long" };
  if (!(await deps.settleSave())) return { status: "unsaved" };
  if (!deps.canEdit()) return { status: "readonly" };
  if (current) {
    try {
      await deps.remove(current.edge_id);
    } catch {
      return { status: "error" };
    }
  }
  let edge: TPpmCanvasSemanticEdge;
  try {
    edge = await deps.create(target.fromShapeId, target.toShapeId, relation, label);
  } catch {
    return { status: "error", previousRemoved: Boolean(current) };
  }
  // The board may have become read-only while the server answered (a conflict, lost rights): the arrow stays.
  if (!deps.canEdit()) return { status: "readonly", edge };
  return {
    status: "saved",
    arrowId: target.arrowId,
    edge,
    removed: removeArrowForMeaning(editor, target),
    replaced: current?.edge_id,
  };
}

export type TPpmArrowMeaningNotice = { saved?: TPpmArrowMeaningSaved; text: string };

/** What the notice says after a choice of «Смысл» (nothing when the choice changed nothing); `saved` offers «Отменить». */
export function arrowMeaningNotice(
  outcome: TPpmArrowMeaningOutcome,
  relationName: string,
  t: (key: TPpmTranslationKey) => string
): TPpmArrowMeaningNotice | undefined {
  switch (outcome.status) {
    case "saved":
      return { saved: outcome, text: fillCanvasTemplate(t("canvas.uxr.meaning_saved"), { relation: relationName }) };
    case "cleared":
      return { text: t("canvas.uxr.meaning_cleared") };
    case "unchanged":
      return undefined;
    case "label_too_long":
      return { text: fillCanvasTemplate(t("canvas.uxr.meaning_label_too_long"), { limit: ARROW_LABEL_MAX }) };
    case "unsaved":
      return { text: t("canvas.uxr.meaning_unsaved") };
    case "readonly":
      return {
        text: outcome.edge
          ? fillCanvasTemplate(t("canvas.uxr.meaning_readonly_saved"), { relation: relationName })
          : t("canvas.uxr.meaning_readonly"),
      };
    case "error":
      return { text: t(outcome.previousRemoved ? "canvas.uxr.meaning_replace_error" : "canvas.uxr.meaning_error") };
  }
}

/**
 * Takes the arrow off the board as one undo step — only while it is still the same arrow between the same cards and
 * the board may be edited: one deleted, re-bound or locked during the request, or a board that became read-only (tldraw
 * would silently skip the delete), keeps the arrow as the user left it.
 */
export function removeArrowForMeaning(
  editor: Editor,
  target: TPpmArrowMeaningTarget
): TPpmArrowMeaningSnapshot | undefined {
  const arrow = editor.getShape<TLArrowShape>(target.arrowId);
  if (!arrow || editor.getIsReadonly() || editor.isShapeOrAncestorLocked(arrow)) return undefined;
  const now = readArrowMeaningTarget(editor, arrow);
  if (!now || now.fromShapeId !== target.fromShapeId || now.toShapeId !== target.toShapeId) return undefined;
  const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrow, "arrow");
  editor.markHistoryStoppingPoint("ppm arrow meaning");
  editor.deleteShapes([arrow.id]);
  return { arrow, bindings };
}

/** «Отменить»: the link goes first; only then the arrow comes back (a link that stays keeps the board as it is). */
export async function undoArrowMeaning(
  editor: Editor,
  saved: TPpmArrowMeaningSaved,
  remove: (edgeId: string) => Promise<void>
): Promise<boolean> {
  try {
    await remove(saved.edge.edge_id);
  } catch {
    return false;
  }
  if (saved.removed) restoreArrowAfterMeaning(editor, saved.removed);
  return true;
}

/**
 * The arrow back with its id and both bindings (to the cards still on the board), as one undo step, and selected — so
 * it can get another meaning. Nothing when tldraw's own undo (⌘Z) has already brought it back.
 */
export function restoreArrowAfterMeaning(editor: Editor, snapshot: TPpmArrowMeaningSnapshot): boolean {
  if (editor.getShape(snapshot.arrow.id)) return false;
  editor.markHistoryStoppingPoint("ppm arrow meaning undo");
  editor.run(() => {
    editor.createShape<TLArrowShape>(snapshot.arrow);
    const bindings = snapshot.bindings.filter((binding) => Boolean(editor.getShape(binding.toId)));
    if (bindings.length > 0) editor.createBindings(bindings);
  });
  editor.select(snapshot.arrow.id);
  return true;
}
