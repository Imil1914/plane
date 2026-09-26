// AF2.1 line R: pure data and geometry of the canvas toolkit (rail groups, shortcuts, geo shapes, PPM palette for
// tldraw, quick-connect placement, object counter). No runtime tldraw import — covered by node-env vitest.
import type { TPpmTranslationKey } from "@ppm/brand";
import type { TPpmCanvasColor } from "@ppm/canvas";
import type { TLDefaultColorTheme, TLDefaultColorThemeColor } from "tldraw";
import type { TPpmCanvasCommand } from "./commands";
import type { TPpmCanvasShape } from "./shape";

// ─────────────── Shortcuts (e.code — the owner types on a Russian layout) ───────────────

export type TPpmRailShortcut = {
  code: "KeyV" | "KeyH" | "KeyS" | "KeyT" | "KeyP";
  latin: string;
  cyrillic: string;
  command: TPpmCanvasCommand;
};

/** Real single-key tools of the v2 rail (K1): Выбор V, Рука H, Стикер S, Текст T, Перо P. */
export const PPM_RAIL_SHORTCUTS: readonly TPpmRailShortcut[] = [
  { code: "KeyV", latin: "V", cyrillic: "М", command: "select" },
  { code: "KeyH", latin: "H", cyrillic: "Р", command: "select-hand" },
  { code: "KeyS", latin: "S", cyrillic: "Ы", command: "add-sticky" },
  { code: "KeyT", latin: "T", cyrillic: "Е", command: "draw-text" },
  { code: "KeyP", latin: "P", cyrillic: "З", command: "draw-pen" },
];

/** «V / М»: the key on both layouts, as in the K1 tooltips. */
export function railShortcutLabel(command: TPpmCanvasCommand): string | undefined {
  const shortcut = PPM_RAIL_SHORTCUTS.find((item) => item.command === command);
  return shortcut ? `${shortcut.latin} / ${shortcut.cyrillic}` : undefined;
}

export function railShortcutKey(command: TPpmCanvasCommand): string | undefined {
  return PPM_RAIL_SHORTCUTS.find((item) => item.command === command)?.latin;
}

/** Only a bare key press is a tool shortcut: Shift/Ctrl/Alt/Meta combinations belong to other commands. */
export function railShortcutCommand(event: {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): TPpmCanvasCommand | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  return PPM_RAIL_SHORTCUTS.find((item) => item.code === event.code)?.command;
}

// ─────────────── tldraw geo shapes (3.15.6 set) ───────────────

export const PPM_GEO_SHAPES = [
  { geo: "rectangle", labelKey: "canvas.shape.rectangle" },
  // tldraw «oval» is a capsule — the rounded box of flowcharts.
  { geo: "oval", labelKey: "canvas.shape.rounded" },
  { geo: "ellipse", labelKey: "canvas.shape.ellipse" },
  { geo: "diamond", labelKey: "canvas.shape.diamond" },
  // tldraw «rhombus» is the slanted parallelogram (input/output block).
  { geo: "rhombus", labelKey: "canvas.shape.parallelogram" },
  { geo: "trapezoid", labelKey: "canvas.shape.trapezoid" },
  { geo: "triangle", labelKey: "canvas.shape.triangle" },
  { geo: "hexagon", labelKey: "canvas.shape.hexagon" },
  { geo: "cloud", labelKey: "canvas.shape.cloud" },
  { geo: "arrow-right", labelKey: "canvas.shape.arrow" },
] as const satisfies readonly { geo: string; labelKey: TPpmTranslationKey }[];

export type TPpmGeo = (typeof PPM_GEO_SHAPES)[number]["geo"];

/** K2 «Продолжить»: прямоугольник · ромб · овал · параллелограмм · ещё. */
export const PPM_QUICK_CONNECT_SHAPES: readonly TPpmGeo[] = ["rectangle", "diamond", "ellipse", "rhombus"];

export function isPpmGeo(value: unknown): value is TPpmGeo {
  return PPM_GEO_SHAPES.some((shape) => shape.geo === value);
}

export function geoLabelKey(geo: string): TPpmTranslationKey | undefined {
  return PPM_GEO_SHAPES.find((shape) => shape.geo === geo)?.labelKey;
}

// ─────────────── Rail groups (K1) ───────────────

export type TPpmRailMenuItem = {
  command: TPpmCanvasCommand;
  geo?: TPpmGeo;
  labelKey: TPpmTranslationKey;
  hintKey?: TPpmTranslationKey;
  sourceKey?: TPpmTranslationKey;
  /** Reachable for a read-only viewer (the command is in READ_ONLY_COMMANDS_V2). */
  readOnly?: boolean;
};

export type TPpmRailMenuId = "shapes" | "docs" | "project" | "more";

export type TPpmRailMenu = {
  id: TPpmRailMenuId;
  labelKey: TPpmTranslationKey;
  captionKey: TPpmTranslationKey;
  layout: "grid" | "list";
  items: readonly TPpmRailMenuItem[];
};

export const PPM_RAIL_MENUS: Readonly<Record<TPpmRailMenuId, TPpmRailMenu>> = {
  shapes: {
    id: "shapes",
    labelKey: "canvas.rail.shapes",
    captionKey: "canvas.rail.shapes_caption",
    layout: "grid",
    items: PPM_GEO_SHAPES.map(({ geo, labelKey }) => ({ command: "draw-geo" as const, geo, labelKey })),
  },
  docs: {
    id: "docs",
    labelKey: "canvas.rail.docs",
    captionKey: "canvas.rail.docs_caption",
    layout: "list",
    items: [
      { command: "add-note", labelKey: "canvas.rail.note", hintKey: "canvas.rail.note_hint" },
      { command: "add-document-page", labelKey: "canvas.rail.document", hintKey: "canvas.rail.document_hint" },
      { command: "add-list", labelKey: "canvas.rail.list", hintKey: "canvas.rail.list_hint" },
      { command: "add-table", labelKey: "canvas.rail.table", hintKey: "canvas.rail.table_hint" },
      { command: "add-code", labelKey: "canvas.rail.code", hintKey: "canvas.rail.code_hint" },
      { command: "open-shapes", labelKey: "canvas.rail.diagram", hintKey: "canvas.rail.diagram_hint" },
    ],
  },
  project: {
    id: "project",
    labelKey: "canvas.rail.project",
    captionKey: "canvas.rail.project_caption",
    layout: "list",
    items: [
      { command: "add-work-item", labelKey: "canvas.rail.work_item", sourceKey: "canvas.rail.source_tasks" },
      {
        command: "add-work-items-view",
        labelKey: "canvas.rail.work_items_view",
        sourceKey: "canvas.rail.source_tasks",
      },
      { command: "add-file", labelKey: "canvas.rail.file", sourceKey: "canvas.rail.source_vault" },
      // AF2.1 B (финальная волна): «Git-объект» открывает страницу кода проекта — подсказка говорит, что будет дальше.
      {
        command: "add-git",
        labelKey: "canvas.rail.git",
        hintKey: "canvas.rail.git_hint",
        sourceKey: "canvas.rail.source_code",
      },
      { command: "add-page-ref", labelKey: "canvas.rail.page", sourceKey: "canvas.rail.source_pages" },
      // AF2.2 F: «Карта спринта» — новая доска-карта из спринта; диалог и сборка — линия M (блок M в editor.tsx).
      {
        command: "build-sprint-map",
        labelKey: "canvas.af22.sprint_map",
        hintKey: "canvas.af22.sprint_map_hint",
        sourceKey: "canvas.af22.source_sprints",
      },
    ],
  },
  more: {
    id: "more",
    labelKey: "canvas.rail.more",
    captionKey: "canvas.rail.more_caption",
    layout: "list",
    items: [
      { command: "open-find", labelKey: "canvas.rail.find", readOnly: true },
      { command: "open-tasks", labelKey: "canvas.tasks_panel", readOnly: true },
      { command: "add-board-link", labelKey: "canvas.rail.board_link" },
      { command: "open-board-panel", labelKey: "canvas.rail.board_panel", readOnly: true },
    ],
  },
};

/** Items a viewer may use: everything for an editor, only `readOnly` items for a read-only viewer. */
export function visibleRailMenuItems(menu: TPpmRailMenu, editReady: boolean): readonly TPpmRailMenuItem[] {
  return editReady ? menu.items : menu.items.filter((item) => item.readOnly);
}

/**
 * Whether the rail's open flyout should close because focus really left its root — final-fix round 2, C-1. WebKit
 * does not focus a button on a mouse click, so pressing any menu item first blurs whatever had focus (the menu's own
 * first item, `useEffect(() => firstItemRef.current?.focus(), [menu])`) with `relatedTarget === null`; closing on
 * that null drops the item's own click before it ever fires. Only a real move of focus to a node outside `root`
 * counts as leaving — the same read of `relatedTarget` canvas-quick-connect.tsx's `onFocusOut` already makes.
 */
export function isRailFocusLeavingRoot(relatedTarget: Node | null, root: Node | null): boolean {
  return relatedTarget !== null && !root?.contains(relatedTarget);
}

// ─────────────── PPM palette → tldraw colours (K2/K3) ───────────────

export type TTldrawColorName =
  | "black"
  | "grey"
  | "light-violet"
  | "violet"
  | "blue"
  | "light-blue"
  | "yellow"
  | "orange"
  | "green"
  | "light-green"
  | "light-red"
  | "red"
  | "white";

/** For stickers, tldraw's default colour ("black") reads as the default yellow sticker; "white" is the neutral one. */
export type TPpmStyledKind = "note" | "shape";

const PPM_TO_TLDRAW: Record<Exclude<TPpmCanvasColor, "neutral">, TTldrawColorName> = {
  yellow: "yellow",
  orange: "orange",
  terracotta: "red",
  pink: "light-red",
  violet: "violet",
  blue: "blue",
  cyan: "light-blue",
  green: "green",
};

export function tldrawColorForPpm(color: TPpmCanvasColor, kind: TPpmStyledKind): TTldrawColorName {
  if (color === "neutral") return kind === "note" ? "white" : "black";
  return PPM_TO_TLDRAW[color];
}

export function ppmColorForTldraw(color: string, kind: TPpmStyledKind): TPpmCanvasColor {
  if (color === "black") return kind === "note" ? "yellow" : "neutral";
  if (color === "grey" || color === "white") return "neutral";
  if (color === "light-violet") return "violet";
  if (color === "light-green") return "green";
  const match = (Object.entries(PPM_TO_TLDRAW) as [TPpmCanvasColor, TTldrawColorName][]).find(
    ([, name]) => name === color
  );
  return match ? match[0] : "neutral";
}

type TPaletteSwatch = { fill: string; stroke: string };

/** Light values — the K2 colour panel; dark values keep the hue order at equal lightness on the graphite board. */
export const PPM_PALETTE_HEX: Record<"light" | "dark", Record<TPpmCanvasColor, TPaletteSwatch>> = {
  light: {
    neutral: { fill: "#ffffff", stroke: "#847f7a" },
    yellow: { fill: "#fbebb2", stroke: "#847020" },
    orange: { fill: "#fddfbe", stroke: "#9d671c" },
    terracotta: { fill: "#ffdacd", stroke: "#a7593d" },
    pink: { fill: "#fbdae8", stroke: "#a0557b" },
    violet: { fill: "#e8dffc", stroke: "#7c61a8" },
    blue: { fill: "#d7e8fe", stroke: "#4773ab" },
    cyan: { fill: "#c9efee", stroke: "#2a8080" },
    green: { fill: "#d0f0d5", stroke: "#428252" },
  },
  dark: {
    neutral: { fill: "#24221f", stroke: "#a39e98" },
    yellow: { fill: "#3d3520", stroke: "#d6b958" },
    orange: { fill: "#40301f", stroke: "#e0a45c" },
    terracotta: { fill: "#42281f", stroke: "#e5886a" },
    pink: { fill: "#3f2530", stroke: "#e08ab2" },
    violet: { fill: "#2f2a42", stroke: "#b7a3eb" },
    blue: { fill: "#23304a", stroke: "#8fb3ea" },
    cyan: { fill: "#1f3a3a", stroke: "#6cc7c5" },
    green: { fill: "#243a29", stroke: "#86c796" },
  },
};

export const PPM_PALETTE_INK = {
  light: { text: "#1d1a17", muted: "#736e69", paper: "#ffffff" },
  dark: { text: "#ece8e3", muted: "#a39e98", paper: "#24221f" },
} as const;

function swatchEntry(
  base: TLDefaultColorThemeColor,
  fill: string,
  stroke: string,
  text: string,
  noteFill = fill
): TLDefaultColorThemeColor {
  return {
    ...base,
    solid: stroke,
    fill: stroke,
    semi: fill,
    pattern: stroke,
    frame: { headingStroke: stroke, headingFill: fill, stroke, fill, text },
    note: { fill: noteFill, text },
  };
}

/**
 * The PPM version of one tldraw theme, built from tldraw's original (never from an already painted one, so the call
 * is idempotent). tldraw paints stickers with `note.fill`, shape strokes with `solid`, the «solid» fill with `semi`.
 */
export function paintPpmColorTheme(original: TLDefaultColorTheme, mode: "light" | "dark"): TLDefaultColorTheme {
  const hex = PPM_PALETTE_HEX[mode];
  const ink = PPM_PALETTE_INK[mode];
  const painted = { ...original, text: ink.text, solid: ink.paper } as TLDefaultColorTheme;
  for (const [color, name] of Object.entries(PPM_TO_TLDRAW) as [
    Exclude<TPpmCanvasColor, "neutral">,
    TTldrawColorName,
  ][])
    painted[name] = swatchEntry(original[name], hex[color].fill, hex[color].stroke, ink.text);
  painted["light-violet"] = swatchEntry(original["light-violet"], hex.violet.fill, hex.violet.stroke, ink.text);
  painted["light-green"] = swatchEntry(original["light-green"], hex.green.fill, hex.green.stroke, ink.text);
  painted.white = swatchEntry(original.white, hex.neutral.fill, hex.neutral.stroke, ink.text);
  // Default colour: ink strokes on a white fill for shapes, the yellow sticker for notes.
  painted.black = swatchEntry(original.black, hex.neutral.fill, ink.text, ink.text, hex.yellow.fill);
  painted.grey = swatchEntry(original.grey, hex.neutral.fill, ink.muted, ink.text, hex.neutral.fill);
  return painted;
}

// ─────────────── Quick connect «+» (K2) ───────────────

export type TPpmBox = { x: number; y: number; w: number; h: number };
export type TPpmDirection = "up" | "right" | "down" | "left";

export const PPM_QUICK_CONNECT_GAP = 80;

function overlaps(a: TPpmBox, b: TPpmBox, margin: number): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

/**
 * Where the continued shape goes: `gap` away from `source` in `direction`, centred on the source's axis. If that
 * spot is taken, it walks further along the direction (one shape + gap per step), then sideways (alternating), so the
 * new shape never overlaps another object — the same «без наложений» rule as findFreeNodePosition.
 */
export function placeQuickConnectShape(
  source: TPpmBox,
  direction: TPpmDirection,
  size: { w: number; h: number },
  occupied: readonly TPpmBox[],
  gap = PPM_QUICK_CONNECT_GAP
): TPpmBox {
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  const base: TPpmBox = horizontal
    ? {
        x: sign > 0 ? source.x + source.w + gap : source.x - gap - size.w,
        y: source.y + (source.h - size.h) / 2,
        ...size,
      }
    : {
        x: source.x + (source.w - size.w) / 2,
        y: sign > 0 ? source.y + source.h + gap : source.y - gap - size.h,
        ...size,
      };
  const along = (horizontal ? size.w : size.h) + gap;
  const across = (horizontal ? size.h : size.w) + gap / 2;
  for (let step = 0; step < 12; step++) {
    for (const side of [0, 1, -1, 2, -2]) {
      const candidate: TPpmBox = horizontal
        ? { ...base, x: base.x + sign * step * along, y: base.y + side * across }
        : { ...base, x: base.x + side * across, y: base.y + sign * step * along };
      if (!occupied.some((box) => overlaps(candidate, box, gap / 4))) return candidate;
    }
  }
  return {
    ...base,
    x: horizontal ? base.x + sign * 12 * along : base.x,
    y: horizontal ? base.y : base.y + sign * 12 * along,
  };
}

/** Anchor of the arrow on the source and target (tldraw normalized anchors): the facing sides' midpoints. */
export function quickConnectAnchors(direction: TPpmDirection): {
  start: { x: number; y: number };
  end: { x: number; y: number };
} {
  switch (direction) {
    case "up":
      return { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } };
    case "right":
      return { start: { x: 1, y: 0.5 }, end: { x: 0, y: 0.5 } };
    case "down":
      return { start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } };
    case "left":
      return { start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } };
  }
}

/** Screen position of each «+»: the middle of each side of the selection, `offset` px outside it. */
export function quickConnectHandlePoints(
  bounds: TPpmBox,
  offset = 24
): Record<TPpmDirection, { x: number; y: number }> {
  return {
    up: { x: bounds.x + bounds.w / 2, y: bounds.y - offset },
    right: { x: bounds.x + bounds.w + offset, y: bounds.y + bounds.h / 2 },
    down: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h + offset },
    left: { x: bounds.x - offset, y: bounds.y + bounds.h / 2 },
  };
}

/** Shapes that get the four «+» (K2): tldraw geo shapes and PPM cards. Stickers keep tldraw's clone «+» (ruling R1). */
export const PPM_QUICK_CONNECT_TYPES: ReadonlySet<string> = new Set<string>([
  "geo",
  "ppm-canvas-node" satisfies TPpmCanvasShape["type"],
]);

/** Screen px from a side of the selection to the centre of its «+» (a 20px circle, 24px while its menu is open). */
export const PPM_QUICK_CONNECT_HANDLE_OFFSET = 20;

/** The «Продолжить» menu sits `side` px beside its «+», `lift` px back towards the shape, `margin` px inside the view. */
export const PPM_QUICK_CONNECT_MENU = { side: 28, lift: 16, margin: 8 } as const;

/** Top-left (viewport px) of the «Продолжить» menu: next to its «+», away from the shape, kept inside the viewport. */
export function quickConnectMenuOrigin(
  direction: TPpmDirection,
  handle: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number }
): { x: number; y: number } {
  const { lift, margin, side } = PPM_QUICK_CONNECT_MENU;
  const x = direction === "left" ? handle.x - side - size.w : handle.x + side;
  const y = direction === "up" ? handle.y + lift - size.h : handle.y - lift;
  const clamp = (value: number, room: number) => Math.min(Math.max(value, margin), Math.max(margin, room - margin));
  return { x: clamp(x, viewport.w - size.w), y: clamp(y, viewport.h - size.h) };
}

/** Where a dragged «+» arrow enters a shape: the middle of the side that faces `from` (a tldraw normalized anchor). */
export function quickConnectFacingAnchor(target: TPpmBox, from: { x: number; y: number }): { x: number; y: number } {
  const dx = (from.x - (target.x + target.w / 2)) / Math.max(target.w, 1);
  const dy = (from.y - (target.y + target.h / 2)) / Math.max(target.h, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? { x: 0, y: 0.5 } : { x: 1, y: 0.5 };
  return dy < 0 ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
}

/**
 * The four sides of a frame as zero-thickness obstacles for placeQuickConnectShape. tldraw parents a new shape to the
 * frame its top-left corner lands in and masks what sticks out, so a continued shape must land fully inside the frame
 * of its source or fully outside it — never across an edge.
 */
export function quickConnectWalls(frame: TPpmBox): TPpmBox[] {
  return [
    { x: frame.x, y: frame.y, w: frame.w, h: 0 },
    { x: frame.x, y: frame.y + frame.h, w: frame.w, h: 0 },
    { x: frame.x, y: frame.y, w: 0, h: frame.h },
    { x: frame.x + frame.w, y: frame.y, w: 0, h: frame.h },
  ];
}

/**
 * Keyboard of the «Продолжить» menu (WAI-ARIA menu, `e.code` as everywhere in AF2.1): the item to focus next among
 * `count` items from `index` (−1 when none has the focus), or undefined when the key does not move the focus.
 */
export function quickConnectMenuFocus(code: string, index: number, count: number): number | undefined {
  if (count === 0) return undefined;
  if (code === "Home") return 0;
  if (code === "End") return count - 1;
  const step = code === "ArrowRight" || code === "ArrowDown" ? 1 : code === "ArrowLeft" || code === "ArrowUp" ? -1 : 0;
  if (step === 0) return undefined;
  if (index < 0) return step > 0 ? 0 : count - 1;
  return (index + step + count) % count;
}

/** A free box of `size` centred on `center`; if something is there, the nearest free spot to the right of it. */
export function freeSpotNear(
  center: { x: number; y: number },
  size: { w: number; h: number },
  occupied: readonly TPpmBox[]
): TPpmBox {
  const box: TPpmBox = { x: center.x - size.w / 2, y: center.y - size.h / 2, ...size };
  const blocker = occupied.find((other) => overlaps(box, other, 16));
  return blocker ? placeQuickConnectShape(blocker, "right", size, occupied, 24) : box;
}

// ─────────────── Object counter (one rule for the «Доска · Объектов: N» pill and the «Объекты» list) ───────────────

const UNCOUNTED_SHAPE_TYPES = new Set(["arrow", "line", "draw", "highlight"]);

/** Objects are cards, stickers, shapes, text, frames, images; connections and pen strokes are not (K1, K2, K4). */
export function isCountedCanvasShape(shape: { type: string }): boolean {
  return !UNCOUNTED_SHAPE_TYPES.has(shape.type);
}

// ─────────────── Bold on a whole sticker (TipTap JSON of tldraw richText; mark name "bold" — StarterKit) ───────────────

// tldraw types richText as `{ type: string; content: unknown[] }` (TLRichText), so children are checked at runtime.
type TRichTextNode = { type: string; text?: string; marks?: { type: string }[]; content?: readonly unknown[] };

function isRichTextNode(value: unknown): value is TRichTextNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function textNodes(node: TRichTextNode): TRichTextNode[] {
  if (node.type === "text") return [node];
  return (node.content ?? []).filter(isRichTextNode).flatMap(textNodes);
}

export function isRichTextBold(doc: TRichTextNode): boolean {
  const texts = textNodes(doc);
  return texts.length > 0 && texts.every((node) => node.marks?.some((mark) => mark.type === "bold"));
}

/** «Ж» of several stickers: on when every sticker with text is bold. Empty ones don't count, or «Ж» could never go off. */
export function areRichTextsBold(docs: readonly TRichTextNode[]): boolean {
  const withText = docs.filter((doc) => textNodes(doc).length > 0);
  return withText.length > 0 && withText.every(isRichTextBold);
}

export function setRichTextBold<TDoc extends TRichTextNode>(doc: TDoc, bold: boolean): TDoc {
  const visit = (node: unknown): unknown => {
    if (!isRichTextNode(node)) return node;
    if (node.type === "text") {
      const marks = (node.marks ?? []).filter((mark) => mark.type !== "bold");
      const next = bold ? [...marks, { type: "bold" }] : marks;
      const { marks: _marks, ...rest } = node;
      return next.length > 0 ? { ...rest, marks: next } : rest;
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  return visit(doc) as TDoc;
}

// ─────────────── Style toolbar above the selection (R3, K2/K3) ───────────────

/** Screen px the style toolbar rises over a single shape or card to clear its top «+» (R4: a 24px circle 20px out). */
export const PPM_STYLE_TOOLBAR_LIFT = PPM_QUICK_CONNECT_HANDLE_OFFSET + 16;

/** tldraw hides a contextual toolbar whose anchor is closer than this to the viewport edge (its SCREEN_MARGIN). */
const CONTEXTUAL_TOOLBAR_MARGIN = 16;

/**
 * How far the style toolbar's anchor rises: over the top «+» of a single shape or card (PPM_QUICK_CONNECT_TYPES), but
 * only while the raised anchor stays on screen — near the top edge tldraw would hide a raised toolbar altogether.
 */
export function styleToolbarLift(onlyType: string | undefined, topInViewport: number): number {
  if (!onlyType || !PPM_QUICK_CONNECT_TYPES.has(onlyType)) return 0;
  return topInViewport - PPM_STYLE_TOOLBAR_LIFT >= CONTEXTUAL_TOOLBAR_MARGIN ? PPM_STYLE_TOOLBAR_LIFT : 0;
}

/** The style toolbar's row (R3): 28px buttons, 4px padding and a 1px border above and below. */
const STYLE_TOOLBAR_ROW_HEIGHT = 38;
/** Half of the top «+» while its menu is open (a 24px circle). */
const QUICK_CONNECT_HANDLE_OPEN_RADIUS = 12;

/**
 * Whether the style toolbar lies over the top «+» (R4) of a single shape or card: close to the top of the view tldraw
 * pins the toolbar to its screen margin, and its row then covers the circle — that «+» hides, the other three stay.
 */
export function isTopQuickConnectHandleCovered(topInViewport: number): boolean {
  const handleTop = topInViewport - PPM_QUICK_CONNECT_HANDLE_OFFSET - QUICK_CONNECT_HANDLE_OPEN_RADIUS;
  return handleTop < CONTEXTUAL_TOOLBAR_MARGIN + STYLE_TOOLBAR_ROW_HEIGHT;
}
