// AF2.1 line R: editor actions of the toolkit (sticker, edit mode, PPM card colour, quick connect «+»). Runtime tldraw —
// source checks in tests/ppm-canvas; the style toolbar block also runs in node against a fake editor (toolkit-style);
// geometry lives in canvas-toolkit-model.ts.
import {
  DefaultColorStyle,
  DefaultFillStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  GeoShapeGeoStyle,
  createShapeId,
  type Editor,
  type StyleProp,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDefaultFillStyle,
  type TLDefaultFontStyle,
  type TLDefaultSizeStyle,
  type TLGeoShape,
  type TLGroupShape,
  type TLNoteShape,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import {
  parseSerializedPpmCanvasNode,
  ppmCanvasNodeSchema,
  serializePpmCanvasNode,
  type TPpmCanvasColor,
} from "@ppm/canvas";
import {
  areRichTextsBold,
  freeSpotNear,
  isCountedCanvasShape,
  PPM_QUICK_CONNECT_TYPES,
  placeQuickConnectShape,
  ppmColorForTldraw,
  quickConnectAnchors,
  quickConnectFacingAnchor,
  quickConnectWalls,
  setRichTextBold,
  tldrawColorForPpm,
  type TPpmBox,
  type TPpmDirection,
  type TPpmGeo,
} from "./canvas-toolkit-model";
import type { TPpmCanvasShape } from "./shape";

// shape.tsx's PPM_CANVAS_SHAPE_TYPE as a checked literal: a runtime import would pull every card component (and all
// they import) into the node tests of this module.
const PPM_CANVAS_SHAPE_TYPE = "ppm-canvas-node" satisfies TPpmCanvasShape["type"];
const STICKER_SIZE = { w: 200, h: 200 };

/** Page boxes of every counted object — the obstacles for new shapes («без наложений»); `except` ids are left out. */
export function occupiedBoxes(editor: Editor, except: ReadonlySet<TLShapeId> = new Set()): TPpmBox[] {
  return editor
    .getCurrentPageShapes()
    .filter((shape) => isCountedCanvasShape(shape) && !except.has(shape.id))
    .map((shape) => editor.getShapePageBounds(shape))
    .filter((bounds): bounds is NonNullable<typeof bounds> => Boolean(bounds))
    .map((bounds) => ({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }));
}

/** Select the shape and put its label into edit mode (tldraw's startEditingShapeWithLabel, not exported in 3.15). */
export function startEditingShape(editor: Editor, id: TLShapeId): void {
  const shape = editor.getShape(id);
  if (!shape) return;
  editor.select(id);
  editor.setEditingShape(id);
  editor.setCurrentTool("select.editing_shape", { shape, target: "shape" });
}

/** «Стикер» (rail, S): a yellow sticker in the free middle of the view, ready for typing. One undo step. */
export function createPpmSticky(editor: Editor): TLShapeId {
  const id = createShapeId();
  const spot = freeSpotNear(editor.getViewportPageBounds().center, STICKER_SIZE, occupiedBoxes(editor));
  editor.markHistoryStoppingPoint("ppm add sticker");
  editor.createShape<TLNoteShape>({ id, type: "note", x: spot.x, y: spot.y, props: { color: "yellow" } });
  startEditingShape(editor, id);
  return id;
}

/** The node kind of a PPM card ("note", "code", "work_item_ref", …), or undefined for an unreadable card. */
export function ppmCardKind(shape: TPpmCanvasShape): string | undefined {
  const parsed = parseSerializedPpmCanvasNode(shape.props.node);
  return parsed.status === "valid" || parsed.status === "migrated" ? parsed.node.kind : undefined;
}

/** The palette colour of a PPM card, or undefined for an unreadable card. */
export function ppmCardColor(shape: TPpmCanvasShape): TPpmCanvasColor | undefined {
  const parsed = parseSerializedPpmCanvasNode(shape.props.node);
  return parsed.status === "valid" || parsed.status === "migrated" ? parsed.node.visual.color : undefined;
}

/** «Цвет» for PPM cards: visual.color of the node (F1 palette) — the same shape-props path as every card edit. */
export function setPpmCardColor(editor: Editor, cards: readonly TPpmCanvasShape[], color: TPpmCanvasColor): void {
  const now = new Date().toISOString();
  for (const shape of cards) {
    const parsed = parseSerializedPpmCanvasNode(shape.props.node);
    if (parsed.status !== "valid" && parsed.status !== "migrated") continue;
    const node = ppmCanvasNodeSchema.parse({
      ...parsed.node,
      visual: { ...parsed.node.visual, color },
      updated_at: now,
    });
    editor.updateShape<TPpmCanvasShape>({
      id: shape.id,
      type: shape.type,
      props: { node: serializePpmCanvasNode(node) },
    });
  }
}

// ─────────────── Style toolbar (R3, K2/K3): what the selection offers; every change is one undo step ───────────────
// Covered in node with a fake editor (tests/ppm-canvas/toolkit-style.test.ts).

/** While the selection is moved, resized, rotated or brushed the toolbar hides — and is not recomputed. */
export const PPM_STYLE_BUSY_STATES = [
  "select.translating",
  "select.resizing",
  "select.rotating",
  "select.brushing",
  "select.dragging_handle",
] as const;

/** What the style toolbar shows: plain data (ids and values), so an unchanged selection does not re-render it. */
export type TPpmStyleSelection = {
  /** Readable, unlocked PPM cards: their `visual.color` changes. */
  cardIds: TLShapeId[];
  /** Unlocked stickers. */
  noteIds: TLShapeId[];
  /** Other unlocked tldraw shapes that have a colour (a group counts when one of its children has one). */
  shapeIds: TLShapeId[];
  labelKey: "canvas.style.sticky_toolbar" | "canvas.style.card_toolbar" | "canvas.style.shape_toolbar";
  /** The palette colour of everything selected, or undefined when it is mixed. */
  color: TPpmCanvasColor | undefined;
  size: string | undefined;
  geo: string | undefined;
  fill: string | undefined;
  font: string | undefined;
  bold: boolean;
  showSize: boolean;
  showGeo: boolean;
  showBold: boolean;
  showMore: boolean;
};

const TEXT_SHAPE_TYPES = new Set(["note", "geo", "text", "arrow"]);
const FONT_SHAPE_TYPES = new Set(["note", "geo", "text"]);

/** Kind and colour of a PPM card in one parse, or undefined for an unreadable card. */
function readPpmCard(shape: TPpmCanvasShape): { kind: string; color: TPpmCanvasColor } | undefined {
  const parsed = parseSerializedPpmCanvasNode(shape.props.node);
  return parsed.status === "valid" || parsed.status === "migrated"
    ? { kind: parsed.node.kind, color: parsed.node.visual.color }
    : undefined;
}

/** Adds the palette colours of a tldraw shape (of a group — of its children); false when it has no colour at all. */
function addShapeColors(editor: Editor, shape: TLShape, colors: Set<TPpmCanvasColor>): boolean {
  if (editor.isShapeOfType<TLGroupShape>(shape, "group")) {
    let found = false;
    for (const id of editor.getSortedChildIdsForParent(shape.id)) {
      const child = editor.getShape(id);
      if (child && addShapeColors(editor, child, colors)) found = true;
    }
    return found;
  }
  const value = editor.getShapeStyleIfExists(shape, DefaultColorStyle);
  if (value === undefined) return false;
  colors.add(ppmColorForTldraw(value, shape.type === "note" ? "note" : "shape"));
  return true;
}

function sharedStyleValue<T>(editor: Editor, style: StyleProp<T>): T | undefined {
  const shared = editor.getSharedStyles().get(style);
  return shared?.type === "shared" ? shared.value : undefined;
}

/**
 * The style toolbar's view of the selection (K2/K3), or undefined when there is nothing to show: a reader, a tool other
 * than «Выбор», a code block in the selection (it has its own toolbar — line B), or nothing that takes a colour (images,
 * bookmarks, embeds, unreadable or locked cards and shapes).
 */
export function readStyleSelection(editor: Editor): TPpmStyleSelection | undefined {
  if (editor.getIsReadonly() || !editor.isIn("select")) return undefined;
  const shapes = editor.getSelectedShapes();
  if (shapes.length === 0) return undefined;
  const cardIds: TLShapeId[] = [];
  const noteIds: TLShapeId[] = [];
  const shapeIds: TLShapeId[] = [];
  const notes: TLNoteShape[] = [];
  const types = new Set<string>();
  const colors = new Set<TPpmCanvasColor>();
  let cards = 0;
  for (const shape of shapes) {
    if (shape.type === PPM_CANVAS_SHAPE_TYPE) {
      cards += 1;
      const card = readPpmCard(shape as TPpmCanvasShape);
      if (card?.kind === "code") return undefined;
      if (!card || editor.isShapeOrAncestorLocked(shape)) continue;
      cardIds.push(shape.id);
      colors.add(card.color);
      continue;
    }
    if (editor.isShapeOrAncestorLocked(shape) || !addShapeColors(editor, shape, colors)) continue;
    types.add(shape.type);
    if (editor.isShapeOfType<TLNoteShape>(shape, "note")) {
      noteIds.push(shape.id);
      notes.push(shape);
    } else shapeIds.push(shape.id);
  }
  if (cardIds.length + noteIds.length + shapeIds.length === 0) return undefined;
  const onlyNotes = noteIds.length === shapes.length;
  return {
    cardIds,
    noteIds,
    shapeIds,
    labelKey: onlyNotes
      ? "canvas.style.sticky_toolbar"
      : cards === shapes.length
        ? "canvas.style.card_toolbar"
        : "canvas.style.shape_toolbar",
    color: colors.size === 1 ? [...colors][0] : undefined,
    size: sharedStyleValue(editor, DefaultSizeStyle),
    geo: sharedStyleValue(editor, GeoShapeGeoStyle),
    fill: sharedStyleValue(editor, DefaultFillStyle),
    font: sharedStyleValue(editor, DefaultFontStyle),
    bold: onlyNotes && areRichTextsBold(notes.map((note) => note.props.richText)),
    showSize: cards === 0 && [...types].some((type) => TEXT_SHAPE_TYPES.has(type)),
    showGeo: shapeIds.length === shapes.length && shapes.every((shape) => shape.type === "geo"),
    showBold: onlyNotes,
    showMore: cards === 0 && [...types].some((type) => FONT_SHAPE_TYPES.has(type)),
  };
}

/** One step of the toolbar's computed: while the selection is being moved it keeps the previous value (no work). */
export function styleSelectionStep(
  editor: Editor,
  previous: TPpmStyleSelection | undefined
): TPpmStyleSelection | undefined {
  return editor.isInAny(...PPM_STYLE_BUSY_STATES) ? previous : readStyleSelection(editor);
}

/** Structural equality for the toolbar's computed: the same ids and values keep React still (drags, typing). */
export function isSameStyleSelection(a: TPpmStyleSelection | undefined, b: TPpmStyleSelection | undefined): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof TPpmStyleSelection)[]).every((key) => {
    const left = a[key];
    const right = b[key];
    return Array.isArray(left) && Array.isArray(right)
      ? left.length === right.length && left.every((id, index) => id === right[index])
      : left === right;
  });
}

/** «Цвет»: stickers, shapes and frames through the tldraw style (PPM palette), cards through `visual.color`. */
export function applyPpmStyleColor(editor: Editor, selection: TPpmStyleSelection, color: TPpmCanvasColor): void {
  editor.markHistoryStoppingPoint("ppm style colour");
  editor.run(() => {
    if (selection.noteIds.length + selection.shapeIds.length > 0) {
      editor.setStyleForSelectedShapes(DefaultColorStyle, tldrawColorForPpm(color, "shape"));
      // Stickers read neutral as white paper, not as tldraw's default colour; the next shapes follow shapes only.
      if (selection.noteIds.length > 0)
        editor.updateShapes(
          selection.noteIds.map((id) => ({
            id,
            type: "note" as const,
            props: { color: tldrawColorForPpm(color, "note") },
          }))
        );
      else editor.setStyleForNextShapes(DefaultColorStyle, tldrawColorForPpm(color, "shape"));
    }
    const cards = selection.cardIds
      .map((id) => editor.getShape<TPpmCanvasShape>(id))
      .filter((shape): shape is TPpmCanvasShape => Boolean(shape));
    if (cards.length > 0) setPpmCardColor(editor, cards, color);
  });
}

/** «Текст S/M/L»: the selection and the next shapes. */
export function applyPpmTextSize(editor: Editor, size: TLDefaultSizeStyle): void {
  editor.markHistoryStoppingPoint("ppm style size");
  editor.run(() => {
    editor.setStyleForSelectedShapes(DefaultSizeStyle, size);
    editor.setStyleForNextShapes(DefaultSizeStyle, size);
  });
}

/** «Форма ▾». */
export function applyPpmGeo(editor: Editor, geo: TPpmGeo): void {
  editor.markHistoryStoppingPoint("ppm style shape");
  editor.setStyleForSelectedShapes(GeoShapeGeoStyle, geo);
}

/** «…» → «Заливка» (without a stopping point it would merge into the previous change). */
export function applyPpmFill(editor: Editor, fill: TLDefaultFillStyle): void {
  editor.markHistoryStoppingPoint("ppm style fill");
  editor.setStyleForSelectedShapes(DefaultFillStyle, fill);
}

/** «…» → «Шрифт». */
export function applyPpmFont(editor: Editor, font: TLDefaultFontStyle): void {
  editor.markHistoryStoppingPoint("ppm style font");
  editor.setStyleForSelectedShapes(DefaultFontStyle, font);
}

/** «Ж»: while typing — the selected text (TipTap); otherwise the whole text of each selected sticker, read fresh. */
export function togglePpmStickerBold(editor: Editor, selection: TPpmStyleSelection): void {
  const richTextEditor = editor.getRichTextEditor();
  if (editor.getEditingShapeId() && richTextEditor) {
    richTextEditor.chain().focus().toggleBold().run();
    return;
  }
  const notes = selection.noteIds
    .map((id) => editor.getShape<TLNoteShape>(id))
    .filter((note): note is TLNoteShape => Boolean(note));
  editor.markHistoryStoppingPoint("ppm style bold");
  editor.updateShapes(
    notes.map((note) => ({
      id: note.id,
      type: "note" as const,
      props: { richText: setRichTextBold(note.props.richText, !selection.bold) },
    }))
  );
}

// ─────────────── Quick connect «+» (R4, K2): native tldraw arrows, `binding:*` records on both ends ───────────────

/** A PPM card continues as a flowchart box of this size; a geo shape continues at its own size. */
const CONTINUED_CARD_SIZE = { w: 200, h: 120 };
// The select tool at rest: where tldraw shows its own selection handles (TldrawSelectionForeground).
const QUICK_CONNECT_AT_REST = ["select.idle", "select.pointing_selection", "select.pointing_shape"];

/** The shape that gets the four «+»: exactly one selected, unlocked geo shape or PPM card, for an editor, at rest. */
export function readQuickConnectTarget(editor: Editor, canEdit: boolean): TLShape | undefined {
  if (!canEdit || editor.getInstanceState().isReadonly) return undefined;
  // Never while typing, dragging, resizing, rotating or restyling.
  if (editor.getEditingShapeId() || editor.getInstanceState().isChangingStyle) return undefined;
  if (!editor.isInAny(...QUICK_CONNECT_AT_REST)) return undefined;
  const shape = editor.getOnlySelectedShape();
  if (!shape || !PPM_QUICK_CONNECT_TYPES.has(shape.type) || editor.isShapeOrAncestorLocked(shape)) return undefined;
  return shape;
}

function anchorPoint(editor: Editor, id: TLShapeId, anchor: { x: number; y: number }) {
  const bounds = editor.getShapePageBounds(id);
  return bounds ? { x: bounds.x + bounds.w * anchor.x, y: bounds.y + bounds.h * anchor.y } : undefined;
}

/** The look a continued shape takes from its source: a geo shape's tldraw styles, a PPM card's palette colour. */
function continuedStyle(source: TLShape): Partial<TLGeoShape["props"]> {
  if (source.type === "geo") {
    const { props } = source as TLGeoShape;
    return {
      align: props.align,
      color: props.color,
      dash: props.dash,
      fill: props.fill,
      font: props.font,
      labelColor: props.labelColor,
      scale: props.scale,
      size: props.size,
      verticalAlign: props.verticalAlign,
    };
  }
  // Only the colour of a card — never its node: a copied `binding` would be an orphan projection (tech-notes).
  const color = source.type === PPM_CANVAS_SHAPE_TYPE ? ppmCardColor(source as TPpmCanvasShape) : undefined;
  return color ? { color: tldrawColorForPpm(color, "shape") } : {};
}

/**
 * An arrow bound at both ends (start → `fromId`, end → `toId`). It leaves the source from the side of `direction` and
 * enters the target at `endAnchor` — by default the side facing back, as for a continued shape.
 */
export function connectShapes(
  editor: Editor,
  fromId: TLShapeId,
  toId: TLShapeId,
  direction: TPpmDirection,
  endAnchor = quickConnectAnchors(direction).end
): TLShapeId | undefined {
  const anchors = { start: quickConnectAnchors(direction).start, end: endAnchor };
  const start = anchorPoint(editor, fromId, anchors.start);
  const end = anchorPoint(editor, toId, anchors.end);
  if (!start || !end) return undefined;
  const arrowId = createShapeId();
  editor.createShape<TLArrowShape>({
    id: arrowId,
    type: "arrow",
    x: start.x,
    y: start.y,
    props: { start: { x: 0, y: 0 }, end: { x: end.x - start.x, y: end.y - start.y } },
  });
  editor.createBindings<TLArrowBinding>([
    {
      fromId: arrowId,
      toId: fromId,
      type: "arrow",
      props: { isExact: false, isPrecise: true, normalizedAnchor: anchors.start, terminal: "start" },
    },
    {
      fromId: arrowId,
      toId,
      type: "arrow",
      props: { isExact: false, isPrecise: true, normalizedAnchor: anchors.end, terminal: "end" },
    },
  ]);
  return arrowId;
}

/** K2 «Продолжить»: a new geo shape next to the source without overlap, connected, in edit mode. One undo step. */
export function continueWithShape(editor: Editor, sourceId: TLShapeId, direction: TPpmDirection, geo: TPpmGeo): void {
  const source = editor.getShape(sourceId);
  const bounds = source ? editor.getShapePageBounds(source) : undefined;
  if (!source || !bounds) return;
  const size =
    source.type === "geo"
      ? { w: (source as TLGeoShape).props.w, h: (source as TLGeoShape).props.h }
      : CONTINUED_CARD_SIZE;
  // The frame, group or section the source sits in is its context, not an obstacle — but the edges of a frame or a
  // section are: tldraw parents the new shape by its top-left corner and a frame masks what sticks out, so the shape
  // lands fully inside or fully outside. A group only grows around its children, it has no edge to respect.
  const ancestors = editor.getShapeAncestors(source);
  const containers = new Set(ancestors.map((shape) => shape.id));
  const walls = ancestors
    .filter((shape) => shape.type !== "group")
    .flatMap((shape) => {
      const frame = editor.getShapePageBounds(shape);
      return frame ? quickConnectWalls({ x: frame.x, y: frame.y, w: frame.w, h: frame.h }) : [];
    });
  const box = placeQuickConnectShape({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }, direction, size, [
    ...occupiedBoxes(editor, containers),
    ...walls,
  ]);
  const shapeId = createShapeId();
  editor.markHistoryStoppingPoint("ppm quick connect");
  editor.run(() => {
    editor.createShape<TLGeoShape>({
      id: shapeId,
      type: "geo",
      x: box.x,
      y: box.y,
      props: { ...continuedStyle(source), geo, h: box.h, w: box.w },
    });
    connectShapes(editor, sourceId, shapeId, direction);
  });
  startEditingShape(editor, shapeId);
}

/** The shape a dragged «+» lands on: any shape an arrow can bind to, except the source and what the source sits in. */
export function quickConnectTargetAt(
  editor: Editor,
  sourceId: TLShapeId,
  pagePoint: { x: number; y: number }
): TLShape | undefined {
  const containers = new Set(editor.getShapeAncestors(sourceId).map((shape) => shape.id));
  return editor.getShapeAtPoint(pagePoint, {
    hitInside: true,
    margin: 8,
    filter: (shape) =>
      shape.id !== sourceId &&
      !containers.has(shape.id) &&
      editor.canBindShapes({ fromShape: "arrow", toShape: shape, binding: "arrow" }),
  });
}

/** Drag of «+»: an arrow from the source to the shape under the pointer (bound at both ends) or to the point. */
export function connectToPoint(
  editor: Editor,
  sourceId: TLShapeId,
  direction: TPpmDirection,
  pagePoint: { x: number; y: number }
): void {
  const anchors = quickConnectAnchors(direction);
  const start = anchorPoint(editor, sourceId, anchors.start);
  const sourceBounds = editor.getShapePageBounds(sourceId);
  if (!start || !sourceBounds) return;
  const hit = quickConnectTargetAt(editor, sourceId, pagePoint);
  const hitBounds = hit ? editor.getShapePageBounds(hit) : undefined;
  // Released back over the source: a cancelled drag, not an arrow into itself.
  if (!hit && sourceBounds.containsPoint(pagePoint)) return;
  editor.markHistoryStoppingPoint("ppm quick connect");
  editor.run(() => {
    if (hit && hitBounds) {
      const arrowId = connectShapes(editor, sourceId, hit.id, direction, quickConnectFacingAnchor(hitBounds, start));
      if (arrowId) editor.select(arrowId);
      return;
    }
    const arrowId = createShapeId();
    editor.createShape<TLArrowShape>({
      id: arrowId,
      type: "arrow",
      x: start.x,
      y: start.y,
      props: { start: { x: 0, y: 0 }, end: { x: pagePoint.x - start.x, y: pagePoint.y - start.y } },
    });
    editor.createBindings<TLArrowBinding>([
      {
        fromId: arrowId,
        toId: sourceId,
        type: "arrow",
        props: { isExact: false, isPrecise: true, normalizedAnchor: anchors.start, terminal: "start" },
      },
    ]);
    editor.select(arrowId);
  });
}
