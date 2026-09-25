// AF2.1 R3: the style toolbar — what the selection offers and every change, run against a fake editor; bold on the
// whole sticker text; the toolbar stays a leaf of <Tldraw> that never steals focus from the text being typed.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "tldraw";
import {
  createPpmCanvasNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasColor,
} from "@ppm/canvas";
import {
  applyPpmFill,
  applyPpmFont,
  applyPpmStyleColor,
  isSameStyleSelection,
  readStyleSelection,
  setPpmCardColor,
  styleSelectionStep,
  togglePpmStickerBold,
  type TPpmStyleSelection,
} from "@/components/ppm-canvas/canvas-toolkit-actions";
import {
  PPM_QUICK_CONNECT_HANDLE_OFFSET,
  PPM_STYLE_TOOLBAR_LIFT,
  areRichTextsBold,
  isRichTextBold,
  setRichTextBold,
  styleToolbarLift,
} from "@/components/ppm-canvas/canvas-toolkit-model";
import type { TPpmCanvasShape } from "@/components/ppm-canvas/shape";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const toolbar = readFileSync(new URL("canvas-style-toolbar.tsx", dir), "utf8");
const css = readFileSync(new URL("canvas-toolkit.css", dir), "utf8");
// Formatting-proof source checks: oxfmt may wrap calls/objects and add trailing commas.
const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

// ─────────────── A fake tldraw editor: just what the style toolbar reads and writes ───────────────

type TFakeShape = {
  id: string;
  type: string;
  isLocked: boolean;
  props: Record<string, unknown>;
  children?: TFakeShape[];
};
type TRichText = { type: string; content: unknown[] };

const NOW = "2026-09-25T12:00:00.000Z";
const STYLE_KEYS: Record<string, string> = {
  "tldraw:color": "color",
  "tldraw:size": "size",
  "tldraw:geo": "geo",
  "tldraw:fill": "fill",
  "tldraw:font": "font",
};

const words = (text: string, bold = false) => ({ type: "text", text, ...(bold ? { marks: [{ type: "bold" }] } : {}) });
const richText = (...texts: object[]): TRichText => ({
  type: "doc",
  content: [texts.length > 0 ? { type: "paragraph", content: texts } : { type: "paragraph" }],
});
const card = (id: string, kind: "note" | "code", color?: TPpmCanvasColor): TFakeShape => ({
  id,
  type: "ppm-canvas-node",
  isLocked: false,
  props: {
    w: 320,
    h: 220,
    node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: "u1", color, kind, now: NOW, title: "Карточка" })),
  },
});
const brokenCard = (id: string): TFakeShape => ({ id, type: "ppm-canvas-node", isLocked: false, props: { node: "{" } });
const note = (id: string, color = "black", doc = richText(words("Порог ΔE"))): TFakeShape => ({
  id,
  type: "note",
  isLocked: false,
  props: { color, size: "m", font: "draw", richText: doc },
});
const geo = (id: string, color = "black", props: Record<string, unknown> = {}): TFakeShape => ({
  id,
  type: "geo",
  isLocked: false,
  props: { color, size: "m", fill: "none", font: "draw", geo: "rectangle", ...props },
});
const image = (id: string): TFakeShape => ({ id, type: "image", isLocked: false, props: { w: 100, h: 100 } });
/** The shapes whose styles tldraw reads for a selection: a group stands for its children. */
const leaves = (shape: TFakeShape): TFakeShape[] =>
  shape.type === "group" ? (shape.children ?? []).flatMap(leaves) : [shape];

function fakeEditor(
  selected: TFakeShape[],
  {
    path = "select.idle",
    readonly = false,
    typing = false,
  }: { path?: string; readonly?: boolean; typing?: boolean } = {}
) {
  const byId = new Map<string, TFakeShape>();
  const index = (shape: TFakeShape) => {
    byId.set(shape.id, shape);
    shape.children?.forEach(index);
  };
  selected.forEach(index);
  const styleOf = (shape: TFakeShape, styleId: string) => shape.props[STYLE_KEYS[styleId] ?? ""] as string | undefined;
  const inPath = (candidate: string) => path === candidate || path.startsWith(`${candidate}.`);
  const calls: [string, ...unknown[]][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const bold = { run: vi.fn() };
  const chain = { focus: () => chain, toggleBold: () => bold };
  const fake = {
    getIsReadonly: () => readonly,
    isIn: inPath,
    isInAny: (...paths: string[]) => paths.some(inPath),
    getSelectedShapes: vi.fn(() => selected),
    getShape: (id: string) => byId.get(id),
    isShapeOrAncestorLocked: (shape: TFakeShape) => shape.isLocked,
    isShapeOfType: (shape: TFakeShape, type: string) => shape.type === type,
    getSortedChildIdsForParent: (id: string) => (byId.get(id)?.children ?? []).map((child) => child.id),
    getShapeStyleIfExists: (shape: TFakeShape, style: { id: string }) => styleOf(shape, style.id),
    getSharedStyles: () => ({
      get: (style: { id: string }) => {
        const values = selected
          .flatMap(leaves)
          .map((shape) => styleOf(shape, style.id))
          .filter((value) => value !== undefined);
        if (values.length === 0) return undefined;
        return values.every((value) => value === values[0]) ? { type: "shared", value: values[0] } : { type: "mixed" };
      },
    }),
    getEditingShapeId: () => (typing ? selected[0]?.id : null),
    getRichTextEditor: () => (typing ? { chain: () => chain } : null),
    markHistoryStoppingPoint: record("markHistoryStoppingPoint"),
    run: (fn: () => void) => fn(),
    setStyleForSelectedShapes: (style: { id: string }, value: unknown) =>
      calls.push(["setStyleForSelectedShapes", style.id, value]),
    setStyleForNextShapes: (style: { id: string }, value: unknown) =>
      calls.push(["setStyleForNextShapes", style.id, value]),
    updateShapes: record("updateShapes"),
    updateShape: record("updateShape"),
  };
  return { editor: fake as unknown as Editor, calls, fake, bold };
}

const read = (...args: Parameters<typeof fakeEditor>) => readStyleSelection(fakeEditor(...args).editor);
const names = (calls: [string, ...unknown[]][]) => calls.map(([name]) => name);

// ─────────────── Pure helpers (canvas-toolkit-model.ts) ───────────────

describe("AF2.1 R3 style toolbar — bold and placement", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Порог ΔE — " },
          { type: "text", text: "12?", marks: [{ type: "italic" }] },
        ],
      },
      { type: "paragraph" },
    ],
  };

  it("makes the whole sticker text bold and back, keeping other marks", () => {
    expect(isRichTextBold(doc)).toBe(false);
    const bold = setRichTextBold(doc, true);
    expect(isRichTextBold(bold)).toBe(true);
    expect(JSON.stringify(bold)).toContain('"marks":[{"type":"italic"},{"type":"bold"}]');
    expect(setRichTextBold(bold, false)).toEqual(doc);
    expect(isRichTextBold({ type: "doc", content: [{ type: "paragraph" }] })).toBe(false);
  });

  it("reads tldraw's richText as stored (content: unknown[]) and leaves non-nodes alone", () => {
    const stored = { type: "doc", content: [null, "stray", richText(words("Да")).content[0]] as unknown[] };
    expect(isRichTextBold(stored)).toBe(false);
    const bold = setRichTextBold(stored, true);
    expect(isRichTextBold(bold)).toBe(true);
    expect(bold.content.slice(0, 2)).toEqual([null, "stray"]);
  });

  it("«Ж» of several stickers counts only the ones with text", () => {
    expect(areRichTextsBold([richText(words("a", true)), richText()])).toBe(true);
    expect(areRichTextsBold([richText(words("a", true)), richText(words("b"))])).toBe(false);
    expect(areRichTextsBold([richText()])).toBe(false);
  });

  it("rises over the top «+» of a single shape or card only when there is room above it", () => {
    // The raised toolbar (tldraw adds an 8px gap) clears the «+» even while its menu is open (a 24px circle).
    expect(PPM_STYLE_TOOLBAR_LIFT + 8).toBeGreaterThan(PPM_QUICK_CONNECT_HANDLE_OFFSET + 12);
    expect(styleToolbarLift("geo", 200)).toBe(PPM_STYLE_TOOLBAR_LIFT);
    expect(styleToolbarLift("ppm-canvas-node", 16 + PPM_STYLE_TOOLBAR_LIFT)).toBe(PPM_STYLE_TOOLBAR_LIFT);
    expect(styleToolbarLift("geo", 15 + PPM_STYLE_TOOLBAR_LIFT)).toBe(0);
    expect(styleToolbarLift("note", 200)).toBe(0);
    expect(styleToolbarLift(undefined, 200)).toBe(0);
  });
});

// ─────────────── What the selection offers (readStyleSelection) ───────────────

describe("AF2.1 R3 style toolbar — the selection", () => {
  it("stays away from a code block (line B has its own toolbar), readers and tools other than «Выбор»", () => {
    expect(read([note("shape:n"), card("shape:c", "code")])).toBeUndefined();
    expect(read([note("shape:n")], { readonly: true })).toBeUndefined();
    expect(read([note("shape:n")], { path: "hand.idle" })).toBeUndefined();
    expect(read([])).toBeUndefined();
  });

  it("offers nothing when nothing takes a colour: images, unreadable cards, locked shapes", () => {
    expect(read([image("shape:i")])).toBeUndefined();
    expect(read([brokenCard("shape:x")])).toBeUndefined();
    expect(read([{ ...geo("shape:g"), isLocked: true }])).toBeUndefined();
  });

  it("reads one palette colour across cards, stickers and shapes; «mixed» only for real differences", () => {
    // An image has no colour: next to a card it neither mixes the colour nor becomes a target.
    expect(read([card("shape:c", "note", "blue"), image("shape:i")])).toMatchObject({
      cardIds: ["shape:c"],
      noteIds: [],
      shapeIds: [],
      color: "blue",
    });
    // Neutral is white paper for a sticker and ink for a shape — the same palette colour.
    expect(read([note("shape:n", "white"), geo("shape:g", "black")])?.color).toBe("neutral");
    // tldraw's default sticker colour is the yellow sticker.
    expect(read([note("shape:n", "black")])?.color).toBe("yellow");
    expect(read([geo("shape:a", "red"), geo("shape:b", "blue")])?.color).toBeUndefined();
    const group: TFakeShape = {
      id: "shape:group",
      type: "group",
      isLocked: false,
      props: {},
      children: [geo("shape:ga", "green"), geo("shape:gb", "green")],
    };
    expect(read([group])).toMatchObject({ shapeIds: ["shape:group"], color: "green" });
  });

  it("shows the controls of the object type: sticker (K3), shape (K2), card", () => {
    expect(read([note("shape:n")])).toMatchObject({
      labelKey: "canvas.style.sticky_toolbar",
      showSize: true,
      showBold: true,
      showGeo: false,
      showMore: true,
    });
    expect(read([geo("shape:g", "black", { geo: "diamond", fill: "semi", font: "sans", size: "l" })])).toMatchObject({
      labelKey: "canvas.style.shape_toolbar",
      showSize: true,
      showBold: false,
      showGeo: true,
      showMore: true,
      geo: "diamond",
      fill: "semi",
      font: "sans",
      size: "l",
    });
    expect(read([card("shape:c", "note")])).toMatchObject({
      labelKey: "canvas.style.card_toolbar",
      showSize: false,
      showBold: false,
      showGeo: false,
      showMore: false,
    });
  });

  it("keeps «Ж» on when an empty sticker is selected with bold ones", () => {
    expect(
      read([note("shape:b", "black", richText(words("Порог", true))), note("shape:e", "black", richText())])?.bold
    ).toBe(true);
  });

  it("does no work while the selection is moved, and equal selections compare equal", () => {
    const previous = read([geo("shape:g")]);
    const moving = fakeEditor([geo("shape:g")], { path: "select.translating" });
    expect(styleSelectionStep(moving.editor, previous)).toBe(previous);
    expect(moving.fake.getSelectedShapes).not.toHaveBeenCalled();
    expect(isSameStyleSelection(previous, read([geo("shape:g")]))).toBe(true);
    expect(isSameStyleSelection(previous, read([geo("shape:g", "red")]))).toBe(false);
    expect(isSameStyleSelection(previous, read([geo("shape:g"), geo("shape:h")]))).toBe(false);
    expect(isSameStyleSelection(undefined, undefined)).toBe(true);
  });
});

// ─────────────── Changes: one undo step each, through the node schema for cards ───────────────

describe("AF2.1 R3 style toolbar — changes", () => {
  it("recolours PPM cards through the node schema: one update per readable card, unreadable ones skipped", () => {
    const { editor, calls } = fakeEditor([]);
    const cards = [card("shape:a", "note", "yellow"), brokenCard("shape:x"), card("shape:b", "code")];
    setPpmCardColor(editor, cards as unknown as TPpmCanvasShape[], "blue");
    expect(calls.map(([, partial]) => (partial as { id: string }).id)).toEqual(["shape:a", "shape:b"]);
    for (const [, partial] of calls) {
      const parsed = parseSerializedPpmCanvasNode((partial as { props: { node: string } }).props.node);
      if (parsed.status !== "valid") throw new Error(`unexpected ${parsed.status}`);
      expect(parsed.node).toMatchObject({ title: "Карточка", visual: { color: "blue" } });
      expect(parsed.node.updated_at).not.toBe(NOW);
    }
  });

  it("recolours only the card next to an image — the next shapes keep their colour", () => {
    const { editor, calls } = fakeEditor([card("shape:c", "note", "yellow"), image("shape:i")]);
    applyPpmStyleColor(editor, readStyleSelection(editor) as TPpmStyleSelection, "green");
    expect(names(calls)).toEqual(["markHistoryStoppingPoint", "updateShape"]);
  });

  it("paints stickers white for neutral; only shapes set the colour of the next shapes", () => {
    const stickers = fakeEditor([note("shape:n", "yellow")]);
    applyPpmStyleColor(stickers.editor, readStyleSelection(stickers.editor) as TPpmStyleSelection, "neutral");
    expect(stickers.calls).toEqual([
      ["markHistoryStoppingPoint", "ppm style colour"],
      ["setStyleForSelectedShapes", "tldraw:color", "black"],
      ["updateShapes", [{ id: "shape:n", type: "note", props: { color: "white" } }]],
    ]);
    const shapes = fakeEditor([geo("shape:g")]);
    applyPpmStyleColor(shapes.editor, readStyleSelection(shapes.editor) as TPpmStyleSelection, "cyan");
    expect(shapes.calls.slice(1)).toEqual([
      ["setStyleForSelectedShapes", "tldraw:color", "light-blue"],
      ["setStyleForNextShapes", "tldraw:color", "light-blue"],
    ]);
  });

  it("makes every fill and font change its own undo step", () => {
    const { editor, calls } = fakeEditor([geo("shape:g")]);
    applyPpmFill(editor, "solid");
    applyPpmFont(editor, "mono");
    expect(calls).toEqual([
      ["markHistoryStoppingPoint", "ppm style fill"],
      ["setStyleForSelectedShapes", "tldraw:fill", "solid"],
      ["markHistoryStoppingPoint", "ppm style font"],
      ["setStyleForSelectedShapes", "tldraw:font", "mono"],
    ]);
  });

  it("«Ж»: the whole text of the selected stickers, or the selected text while typing", () => {
    const idle = fakeEditor([note("shape:n")]);
    togglePpmStickerBold(idle.editor, readStyleSelection(idle.editor) as TPpmStyleSelection);
    expect(idle.calls[0]).toEqual(["markHistoryStoppingPoint", "ppm style bold"]);
    const updates = idle.calls.find(([name]) => name === "updateShapes")?.[1] as
      | { props: { richText: TRichText } }[]
      | undefined;
    expect(updates).toHaveLength(1);
    expect(isRichTextBold(updates?.[0]?.props.richText ?? richText())).toBe(true);
    const typing = fakeEditor([note("shape:n")], { typing: true });
    togglePpmStickerBold(typing.editor, readStyleSelection(typing.editor) as TPpmStyleSelection);
    expect(typing.bold.run).toHaveBeenCalledTimes(1);
    expect(typing.calls).toEqual([]);
  });
});

// ─────────────── The component (DOM-free checks: it is a tldraw contextual toolbar inside <Tldraw>) ───────────────

describe("AF2.1 R3 style toolbar — the component", () => {
  it("is a tldraw contextual toolbar fed by one structurally stable computed", () => {
    has(toolbar, "<TldrawUiContextualToolbar");
    has(toolbar, "{ isEqual: isSameStyleSelection }");
    has(toolbar, "styleSelectionStep(editor, isUninitialized(previous) ? undefined : previous)");
    has(
      toolbar,
      "styleToolbarLift(editor.getOnlySelectedShape()?.type, bounds.y - editor.getViewportScreenBounds().y)"
    );
  });

  it("never steals focus from the text being typed, and is reachable from the keyboard in reading order", () => {
    has(toolbar, "const GROUP_PROPS = { onKeyDown: moveFocusWithArrows, onPointerDown: preventDefault };");
    has(toolbar, 'const step = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;');
    // The row precedes the panels in the DOM; CSS still draws the open panel above it (K2).
    expect(toolbar.indexOf('"ppm-canvas-style-toolbar__row"')).toBeLessThan(
      toolbar.indexOf('"ppm-canvas-style-toolbar__panel"')
    );
    has(css, "flex-direction: column-reverse;");
  });

  it("shows «Ж» (K3), resets panels per selection, marks the current fill/font, keeps pressed ≠ hover", () => {
    has(toolbar, 'ppmT("canvas.style.bold_short")');
    has(toolbar, "useEffect(() => setPanel(undefined), [selectedIds]);");
    has(toolbar, "aria-pressed={selection.fill === fill.value}");
    has(toolbar, "aria-pressed={selection.font === font.value}");
    has(css, ".ppm-canvas-style-toolbar button.ppm-canvas-style-toolbar__swatch {");
    has(css, ".ppm-canvas-style-toolbar__segmented {");
    has(css, "border: 1px solid var(--ppm-color-border-control, var(--border-subtle-1));");
    has(css, "font-weight: 600;");
  });
});
