// AF2.1 line R: rail groups and shortcuts (R1), PPM palette for tldraw (R2/R3), quick connect placement (R4),
// object counter (R5). Pure data — no tldraw runtime.
import { describe, expect, it } from "vitest";
import type { TLDefaultColorTheme } from "tldraw";
import {
  PPM_GEO_SHAPES,
  PPM_PALETTE_HEX,
  PPM_QUICK_CONNECT_GAP,
  PPM_QUICK_CONNECT_SHAPES,
  PPM_RAIL_MENUS,
  isCountedCanvasShape,
  isRailFocusLeavingRoot,
  paintPpmColorTheme,
  placeQuickConnectShape,
  ppmColorForTldraw,
  quickConnectAnchors,
  quickConnectHandlePoints,
  railShortcutCommand,
  railShortcutLabel,
  tldrawColorForPpm,
  visibleRailMenuItems,
  type TPpmBox,
} from "@/components/ppm-canvas/canvas-toolkit-model";

// Minimal Node stand-ins: the helper only reads Node.contains, so no DOM is needed (mirrors shortcut.test.ts's
// element()/container() for the same reason).
function fakeNode(): Node {
  return {} as Node;
}
function fakeRoot(...contained: Node[]): Node {
  return { contains: (node: Node | null) => contained.includes(node as Node) } as Node;
}

const PALETTE = ["neutral", "yellow", "orange", "terracotta", "pink", "violet", "blue", "cyan", "green"] as const;
const TL_NAMES = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;
const key = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

// Module scope (not inside fakeTheme): oxlint unicorn/consistent-function-scoping.
const fakeThemeEntry = (name: string) => ({
  solid: `solid-${name}`,
  semi: `semi-${name}`,
  pattern: `pattern-${name}`,
  fill: `fill-${name}`,
  frame: { headingStroke: "h", headingFill: "h", stroke: "s", fill: "f", text: "t" },
  note: { fill: `note-${name}`, text: "t" },
  highlight: { srgb: `hl-${name}`, p3: `p3-${name}` },
});

function fakeTheme(): TLDefaultColorTheme {
  return {
    id: "light",
    text: "#000000",
    background: "#f9fafb",
    solid: "#fcfffe",
    ...Object.fromEntries(TL_NAMES.map((name) => [name, fakeThemeEntry(name)])),
  } as TLDefaultColorTheme;
}

const overlap = (a: TPpmBox, b: TPpmBox) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("rail (R1)", () => {
  it("maps bare V/H/S/T/P by e.code (Russian layout too) and ignores modified presses", () => {
    expect(railShortcutCommand({ ...key, code: "KeyV" })).toBe("select");
    expect(railShortcutCommand({ ...key, code: "KeyH" })).toBe("select-hand");
    expect(railShortcutCommand({ ...key, code: "KeyS" })).toBe("add-sticky");
    expect(railShortcutCommand({ ...key, code: "KeyT" })).toBe("draw-text");
    expect(railShortcutCommand({ ...key, code: "KeyP" })).toBe("draw-pen");
    expect(railShortcutCommand({ ...key, code: "KeyS", shiftKey: true })).toBeUndefined();
    expect(railShortcutCommand({ ...key, code: "KeyV", metaKey: true })).toBeUndefined();
    expect(railShortcutCommand({ ...key, code: "KeyN" })).toBeUndefined();
    expect(railShortcutLabel("select")).toBe("V / М");
    expect(railShortcutLabel("add-sticky")).toBe("S / Ы");
    expect(railShortcutLabel("add-note")).toBeUndefined();
  });

  it("groups the menus as in K1", () => {
    expect(PPM_RAIL_MENUS.docs.items.map((item) => item.command)).toEqual([
      "add-note",
      "add-document-page",
      "add-list",
      "add-table",
      "add-code",
      "open-shapes",
    ]);
    expect(PPM_RAIL_MENUS.project.items.map((item) => item.command)).toEqual([
      "add-work-item",
      "add-work-items-view",
      "add-file",
      "add-git",
      "add-page-ref",
      // AF2.2 F: «Карта спринта» — последний пункт «Из проекта».
      "build-sprint-map",
    ]);
    expect(PPM_RAIL_MENUS.shapes.items).toHaveLength(PPM_GEO_SHAPES.length);
    for (const item of PPM_RAIL_MENUS.docs.items) expect(item.hintKey, item.command).toBeDefined();
    for (const item of PPM_RAIL_MENUS.project.items) expect(item.sourceKey, item.command).toBeDefined();
  });

  it("offers a read-only viewer only the read-only items", () => {
    expect(visibleRailMenuItems(PPM_RAIL_MENUS.docs, false)).toEqual([]);
    expect(visibleRailMenuItems(PPM_RAIL_MENUS.more, false).map((item) => item.command)).toEqual([
      "open-find",
      "open-tasks",
      "open-board-panel",
    ]);
    expect(visibleRailMenuItems(PPM_RAIL_MENUS.more, true)).toHaveLength(4);
  });

  it("uses only tldraw 3.15.6 geo types and continues with the K2 shapes", () => {
    const tldrawGeo = new Set([
      "cloud",
      "rectangle",
      "ellipse",
      "triangle",
      "diamond",
      "pentagon",
      "hexagon",
      "octagon",
      "star",
      "rhombus",
      "rhombus-2",
      "oval",
      "trapezoid",
      "arrow-right",
      "arrow-left",
      "arrow-up",
      "arrow-down",
      "x-box",
      "check-box",
      "heart",
    ]);
    for (const shape of PPM_GEO_SHAPES) expect(tldrawGeo.has(shape.geo), shape.geo).toBe(true);
    expect(PPM_QUICK_CONNECT_SHAPES).toEqual(["rectangle", "diamond", "ellipse", "rhombus"]);
  });
});

describe("palette (R2/R3)", () => {
  it("round-trips every PPM colour through tldraw for shapes and stickers", () => {
    for (const color of PALETTE)
      for (const kind of ["note", "shape"] as const)
        expect(ppmColorForTldraw(tldrawColorForPpm(color, kind), kind), `${kind}:${color}`).toBe(color);
  });

  it("reads tldraw's default colour as the yellow sticker and the neutral shape", () => {
    expect(ppmColorForTldraw("black", "note")).toBe("yellow");
    expect(ppmColorForTldraw("black", "shape")).toBe("neutral");
    expect(ppmColorForTldraw("light-green", "shape")).toBe("green");
  });

  it("paints stickers, strokes and fills with the K2 values and keeps the original untouched", () => {
    const original = fakeTheme();
    const painted = paintPpmColorTheme(original, "light");
    expect(painted.yellow.note.fill).toBe(PPM_PALETTE_HEX.light.yellow.fill);
    expect(painted.orange.solid).toBe(PPM_PALETTE_HEX.light.orange.stroke);
    expect(painted.orange.semi).toBe(PPM_PALETTE_HEX.light.orange.fill);
    expect(painted["light-red"].note.fill).toBe(PPM_PALETTE_HEX.light.pink.fill);
    expect(painted.black.note.fill).toBe(PPM_PALETTE_HEX.light.yellow.fill);
    expect(painted.black.solid).toBe("#1d1a17");
    expect(painted.white.note.fill).toBe("#ffffff");
    expect(painted.yellow.highlight.srgb).toBe("hl-yellow");
    expect(original.yellow.note.fill).toBe("note-yellow");
    expect(paintPpmColorTheme(original, "light")).toEqual(painted);
  });

  it("gives every colour its own sticker fill in both themes", () => {
    for (const mode of ["light", "dark"] as const) {
      const fills = PALETTE.map((color) => PPM_PALETTE_HEX[mode][color].fill);
      expect(new Set(fills).size, mode).toBe(PALETTE.length);
    }
  });
});

describe("quick connect (R4)", () => {
  const source: TPpmBox = { x: 0, y: 0, w: 200, h: 100 };
  const size = { w: 200, h: 100 };

  it("puts the new shape one gap away, centred on the source axis", () => {
    expect(placeQuickConnectShape(source, "right", size, [source])).toEqual({
      x: 200 + PPM_QUICK_CONNECT_GAP,
      y: 0,
      w: 200,
      h: 100,
    });
    expect(placeQuickConnectShape(source, "down", size, [source])).toEqual({
      x: 0,
      y: 100 + PPM_QUICK_CONNECT_GAP,
      w: 200,
      h: 100,
    });
    expect(placeQuickConnectShape(source, "left", { w: 100, h: 60 }, [source])).toEqual({
      x: -PPM_QUICK_CONNECT_GAP - 100,
      y: 20,
      w: 100,
      h: 60,
    });
    expect(placeQuickConnectShape(source, "up", size, [source]).y).toBe(-PPM_QUICK_CONNECT_GAP - 100);
  });

  it("never overlaps an existing object and supports many links from one shape", () => {
    const occupied: TPpmBox[] = [source];
    for (let index = 0; index < 6; index++) {
      const placed = placeQuickConnectShape(source, "right", size, occupied);
      for (const box of occupied) expect(overlap(placed, box), `${index}`).toBe(false);
      occupied.push(placed);
    }
    expect(occupied).toHaveLength(7);
  });

  it("anchors the arrow on the facing sides and puts the «+» outside each side", () => {
    expect(quickConnectAnchors("right")).toEqual({ start: { x: 1, y: 0.5 }, end: { x: 0, y: 0.5 } });
    expect(quickConnectAnchors("up")).toEqual({ start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } });
    expect(quickConnectHandlePoints({ x: 10, y: 20, w: 100, h: 50 }, 24)).toEqual({
      up: { x: 60, y: -4 },
      right: { x: 134, y: 45 },
      down: { x: 60, y: 94 },
      left: { x: -14, y: 45 },
    });
  });
});

describe("object counter (R5)", () => {
  it("counts cards, stickers, shapes, text and frames, not connections or pen strokes", () => {
    for (const type of ["ppm-canvas-node", "note", "geo", "text", "frame", "image"])
      expect(isCountedCanvasShape({ type })).toBe(true);
    for (const type of ["arrow", "line", "draw", "highlight"]) expect(isCountedCanvasShape({ type })).toBe(false);
  });
});

describe("rail flyout blur (final-fix round 2, C-1)", () => {
  it("does not close when focus goes nowhere — WebKit blurs the focused menu item to null on mousedown", () => {
    expect(isRailFocusLeavingRoot(null, fakeRoot())).toBe(false);
  });

  it("does not close when focus moves to another node inside the root", () => {
    const item = fakeNode();
    expect(isRailFocusLeavingRoot(item, fakeRoot(item))).toBe(false);
  });

  it("closes when focus moves to a real node outside the root", () => {
    const outside = fakeNode();
    expect(isRailFocusLeavingRoot(outside, fakeRoot())).toBe(true);
  });
});
