// AF2.1 R4: quick connect «+» — what the four «+» offer and what they do, run against a fake editor (the actions); the
// geometry (pure); and the wiring of the overlay that only a browser runs (source checks). Stickers keep tldraw's clone «+».
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Editor } from "tldraw";
import { createPpmCanvasNode, serializePpmCanvasNode } from "@ppm/canvas";
import {
  connectToPoint,
  continueWithShape,
  quickConnectTargetAt,
  readQuickConnectTarget,
} from "@/components/ppm-canvas/canvas-toolkit-actions";
import {
  PPM_QUICK_CONNECT_HANDLE_OFFSET,
  PPM_QUICK_CONNECT_MENU,
  PPM_QUICK_CONNECT_TYPES,
  PPM_STYLE_TOOLBAR_LIFT,
  isTopQuickConnectHandleCovered,
  placeQuickConnectShape,
  quickConnectFacingAnchor,
  quickConnectMenuFocus,
  quickConnectMenuOrigin,
  quickConnectWalls,
  type TPpmBox,
  type TPpmDirection,
} from "@/components/ppm-canvas/canvas-toolkit-model";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const overlay = readFileSync(new URL("canvas-quick-connect.tsx", dir), "utf8");
const actionsSource = readFileSync(new URL("canvas-toolkit-actions.ts", dir), "utf8");
const modelSource = readFileSync(new URL("canvas-toolkit-model.ts", dir), "utf8");
// Formatting-proof source checks: oxfmt may wrap calls/objects and add trailing commas.
const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

const DIRECTIONS: readonly TPpmDirection[] = ["up", "right", "down", "left"];
const NOW = "2026-09-25T12:00:00.000Z";
const overlap = (a: TPpmBox, b: TPpmBox) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// ─────────────── A fake tldraw editor: just what quick connect reads and writes ───────────────

type TFakeShape = TPpmBox & {
  id: string;
  type: string;
  parentId?: string;
  isLocked?: boolean;
  props: Record<string, unknown>;
};
type TCall = [string, ...unknown[]];
type TCreated = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };

const GEO_STYLE = {
  align: "start",
  color: "blue",
  dash: "dashed",
  fill: "semi",
  font: "sans",
  labelColor: "red",
  scale: 2,
  size: "l",
  verticalAlign: "end",
};
const geo = (id: string, box: TPpmBox, extra: Partial<TFakeShape> = {}): TFakeShape => ({
  id,
  type: "geo",
  ...box,
  props: { ...GEO_STYLE, geo: "rectangle", growY: 0, w: box.w, h: box.h },
  ...extra,
});
const other = (id: string, type: string, box: TPpmBox, extra: Partial<TFakeShape> = {}): TFakeShape => ({
  id,
  type,
  ...box,
  props: {},
  ...extra,
});
const card = (id: string, box: TPpmBox, extra: Partial<TFakeShape> = {}): TFakeShape => ({
  id,
  type: "ppm-canvas-node",
  ...box,
  props: {
    w: box.w,
    h: box.h,
    node: serializePpmCanvasNode(
      createPpmCanvasNode({ authorId: "u1", color: "violet", kind: "note", now: NOW, title: "Карточка" })
    ),
  },
  ...extra,
});

function fakeCanvas(
  shapes: TFakeShape[],
  {
    changingStyle = false,
    editing,
    path = "select.idle",
    readonly = false,
    selected = [],
  }: { changingStyle?: boolean; editing?: string; path?: string; readonly?: boolean; selected?: string[] } = {}
) {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const calls: TCall[] = [];
  const find = (ref: string | TFakeShape) => byId.get(typeof ref === "string" ? ref : ref.id);
  const bounds = (ref: string | TFakeShape) => {
    const shape = find(ref);
    if (!shape) return undefined;
    const { x, y, w, h } = shape;
    return {
      x,
      y,
      w,
      h,
      containsPoint: (point: { x: number; y: number }) =>
        point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h,
    };
  };
  const ancestors = (ref: string | TFakeShape): TFakeShape[] => {
    const parentId = find(ref)?.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    return parent ? [...ancestors(parent), parent] : [];
  };
  const fake = {
    getInstanceState: () => ({ isChangingStyle: changingStyle, isReadonly: readonly }),
    getEditingShapeId: () => editing ?? null,
    isInAny: (...paths: string[]) => paths.some((candidate) => path === candidate || path.startsWith(`${candidate}.`)),
    getOnlySelectedShape: () => (selected.length === 1 ? (byId.get(selected[0]) ?? null) : null),
    isShapeOrAncestorLocked: (shape: TFakeShape) => [shape, ...ancestors(shape)].some((each) => each.isLocked),
    getShape: (id: string) => byId.get(id),
    getShapePageBounds: bounds,
    getShapeAncestors: ancestors,
    getCurrentPageShapes: () => [...byId.values()],
    // tldraw's hit test reduced to boxes: the top-most shape under the point that passes the filter.
    getShapeAtPoint: (point: { x: number; y: number }, options?: { filter?: (shape: TFakeShape) => boolean }) => {
      const all = [...byId.values()];
      for (let index = all.length - 1; index >= 0; index--)
        if (bounds(all[index])?.containsPoint(point) && (options?.filter?.(all[index]) ?? true)) return all[index];
      return undefined;
    },
    canBindShapes: ({ toShape }: { toShape: TFakeShape }) => toShape.type !== "arrow",
    markHistoryStoppingPoint: (name: string) => calls.push(["markHistoryStoppingPoint", name]),
    run: (fn: () => void) => {
      calls.push(["run"]);
      fn();
      calls.push(["run end"]);
    },
    createShape: (partial: TCreated) => {
      calls.push(["createShape", partial]);
      const { w = 0, h = 0 } = partial.props as { w?: number; h?: number };
      byId.set(partial.id, {
        id: partial.id,
        type: partial.type,
        x: partial.x,
        y: partial.y,
        w,
        h,
        props: partial.props,
      });
    },
    createBindings: (bindings: unknown[]) => calls.push(["createBindings", bindings]),
    select: (id: string) => calls.push(["select", id]),
    setEditingShape: (id: string) => calls.push(["setEditingShape", id]),
    setCurrentTool: (id: string) => calls.push(["setCurrentTool", id]),
  };
  return { editor: fake as unknown as Editor, calls };
}

const names = (calls: TCall[]) => calls.map(([name]) => name);
const created = (calls: TCall[]) =>
  calls.filter(([name]) => name === "createShape").map(([, partial]) => partial as TCreated);
const bindings = (calls: TCall[]) =>
  calls.filter(([name]) => name === "createBindings").flatMap(([, list]) => list as Record<string, unknown>[]);
const bound = (
  terminal: "start" | "end",
  fromId: string,
  toId: string,
  normalizedAnchor: { x: number; y: number }
) => ({
  fromId,
  toId,
  type: "arrow",
  props: { isExact: false, isPrecise: true, normalizedAnchor, terminal },
});

// ─────────────── Who gets the «+» ───────────────

describe("AF2.1 R4 quick connect — who gets the «+»", () => {
  const rect = geo("r1", { x: 0, y: 0, w: 100, h: 60 });
  const target = (shapes: TFakeShape[], options: Parameters<typeof fakeCanvas>[1] = {}, canEdit = true) =>
    readQuickConnectTarget(fakeCanvas(shapes, { selected: [shapes[0].id], ...options }).editor, canEdit)?.id;

  it("offers «+» for one geo shape or PPM card (stickers keep tldraw's clone «+»), never to readers", () => {
    expect([...PPM_QUICK_CONNECT_TYPES]).toEqual(["geo", "ppm-canvas-node"]);
    expect(target([rect])).toBe("r1");
    expect(target([card("c1", { x: 0, y: 0, w: 320, h: 220 })])).toBe("c1");
    for (const type of ["note", "frame", "text", "arrow", "group", "image", "draw"])
      expect(target([other("s1", type, { x: 0, y: 0, w: 50, h: 50 })]), type).toBeUndefined();
    expect(target([rect, geo("r2", { x: 200, y: 0, w: 100, h: 60 })], { selected: ["r1", "r2"] })).toBeUndefined();
    expect(target([rect], {}, false)).toBeUndefined();
    expect(target([rect], { readonly: true })).toBeUndefined();
  });

  it("hides them on a locked shape (or inside a locked frame), while typing, restyling and outside the select tool at rest", () => {
    expect(target([geo("r1", { x: 0, y: 0, w: 100, h: 60 }, { isLocked: true })])).toBeUndefined();
    const frame = other("f1", "frame", { x: 0, y: 0, w: 400, h: 300 }, { isLocked: true });
    expect(target([geo("r1", { x: 10, y: 10, w: 100, h: 60 }, { parentId: "f1" }), frame])).toBeUndefined();
    expect(target([rect], { editing: "r1" })).toBeUndefined();
    expect(target([rect], { changingStyle: true })).toBeUndefined();
    for (const path of ["select.idle", "select.pointing_shape", "select.pointing_selection"])
      expect(target([rect], { path }), path).toBe("r1");
    for (const path of [
      "select.translating",
      "select.resizing",
      "select.rotating",
      "select.brushing",
      "select.editing_shape",
      "hand.idle",
      "geo.idle",
    ])
      expect(target([rect], { path }), path).toBeUndefined();
  });
});

// ─────────────── «Продолжить» ───────────────

describe("AF2.1 R4 quick connect — «Продолжить»", () => {
  it("adds the shape beside the source, binds the arrow to both, and types into it — one undo step", () => {
    // A 100×60 rectangle grown to 100 px by its long label (growY): the page box is 100×100.
    const source = geo(
      "r1",
      { x: 0, y: 0, w: 100, h: 100 },
      {
        props: { ...GEO_STYLE, geo: "rectangle", growY: 40, w: 100, h: 60 },
      }
    );
    const { editor, calls } = fakeCanvas([source]);
    continueWithShape(editor, "r1" as never, "right", "diamond");
    // The stopping point comes before `run`, and everything created is inside that one `run`.
    expect(names(calls)).toEqual([
      "markHistoryStoppingPoint",
      "run",
      "createShape",
      "createShape",
      "createBindings",
      "run end",
      "select",
      "setEditingShape",
      "setCurrentTool",
    ]);
    expect(calls[0]).toEqual(["markHistoryStoppingPoint", "ppm quick connect"]);
    const [shape, arrow] = created(calls);
    // The source's look (not its text); its own size, without the growY of its label; centred on its axis.
    expect(shape).toMatchObject({ type: "geo", x: 180, y: 20, props: { ...GEO_STYLE, geo: "diamond", w: 100, h: 60 } });
    expect(new Set(Object.keys(shape.props))).toEqual(new Set([...Object.keys(GEO_STYLE), "geo", "h", "w"]));
    expect(arrow).toMatchObject({
      type: "arrow",
      x: 100,
      y: 50,
      props: { start: { x: 0, y: 0 }, end: { x: 80, y: 0 } },
    });
    expect(bindings(calls)).toEqual([
      bound("start", arrow.id, "r1", { x: 1, y: 0.5 }),
      bound("end", arrow.id, shape.id, { x: 0, y: 0.5 }),
    ]);
    expect(calls.slice(-3)).toEqual([
      ["select", shape.id],
      ["setEditingShape", shape.id],
      ["setCurrentTool", "select.editing_shape"],
    ]);
  });

  it("takes only the colour from a PPM card — never its node or binding", () => {
    const { editor, calls } = fakeCanvas([card("c1", { x: 0, y: 0, w: 320, h: 220 })]);
    continueWithShape(editor, "c1" as never, "down", "rectangle");
    const [shape] = created(calls);
    expect(shape.props).toEqual({ color: "violet", geo: "rectangle", w: 200, h: 120 });
    expect(shape).toMatchObject({ x: 60, y: 300 });
  });

  it("lets one shape have many connections, the new shapes never overlapping", () => {
    const { editor, calls } = fakeCanvas([geo("r1", { x: 0, y: 0, w: 100, h: 60 })]);
    for (const direction of ["right", "right", "down", "left", "up", "right"] as const)
      continueWithShape(editor, "r1" as never, direction, "rectangle");
    const shapes = created(calls).filter((shape) => shape.type === "geo");
    const boxes = [{ x: 0, y: 0, w: 100, h: 60 }, ...shapes.map(({ x, y }) => ({ x, y, w: 100, h: 60 }))];
    boxes.forEach((a, i) =>
      boxes.slice(i + 1).forEach((b) => expect(overlap(a, b), JSON.stringify([a, b])).toBe(false))
    );
    expect(bindings(calls).filter((binding) => binding.toId === "r1")).toHaveLength(6);
  });

  it("puts the new shape fully inside the source's frame or fully outside it — never across its edge", () => {
    const frame = other("f1", "frame", { x: 0, y: 0, w: 600, h: 400 });
    const { editor, calls } = fakeCanvas([frame, geo("r1", { x: 400, y: 150, w: 100, h: 100 }, { parentId: "f1" })]);
    continueWithShape(editor, "r1" as never, "right", "rectangle");
    const [shape] = created(calls);
    const box = { x: shape.x, y: shape.y, w: 100, h: 100 };
    const outside = box.x >= 600 || box.x + box.w <= 0 || box.y >= 400 || box.y + box.h <= 0;
    const inside = box.x >= 0 && box.y >= 0 && box.x + box.w <= 600 && box.y + box.h <= 400;
    expect(inside || outside, JSON.stringify(box)).toBe(true);
    // Inside a frame, away from its edges, the frame itself is no obstacle: the shape stays next to the source.
    const roomy = fakeCanvas([frame, geo("r1", { x: 100, y: 150, w: 100, h: 100 }, { parentId: "f1" })]);
    continueWithShape(roomy.editor, "r1" as never, "right", "rectangle");
    expect(created(roomy.calls)[0]).toMatchObject({ x: 280, y: 150 });
  });

  it("does not treat a group as a wall — a group grows around a new child", () => {
    const group = other("g1", "group", { x: 0, y: 0, w: 500, h: 300 });
    const { editor, calls } = fakeCanvas([group, geo("r1", { x: 300, y: 100, w: 100, h: 100 }, { parentId: "g1" })]);
    continueWithShape(editor, "r1" as never, "right", "rectangle");
    expect(created(calls)[0]).toMatchObject({ x: 480, y: 100 });
  });
});

// ─────────────── Dragging a «+» ───────────────

describe("AF2.1 R4 quick connect — dragging a «+»", () => {
  it("binds both ends to a shape under the pointer, entering through its side that faces the arrow", () => {
    const { editor, calls } = fakeCanvas([
      geo("r1", { x: 0, y: 0, w: 100, h: 60 }),
      geo("t1", { x: -300, y: 0, w: 100, h: 60 }),
    ]);
    connectToPoint(editor, "r1" as never, "right", { x: -250, y: 30 });
    expect(names(calls)).toEqual([
      "markHistoryStoppingPoint",
      "run",
      "createShape",
      "createBindings",
      "select",
      "run end",
    ]);
    const [arrow] = created(calls);
    expect(bindings(calls)).toEqual([
      bound("start", arrow.id, "r1", { x: 1, y: 0.5 }),
      bound("end", arrow.id, "t1", { x: 1, y: 0.5 }),
    ]);
    expect(calls).toContainEqual(["select", arrow.id]);
  });

  it("leaves a free end in empty space — the arrow still starts bound to its «+» side", () => {
    const { editor, calls } = fakeCanvas([geo("r1", { x: 0, y: 0, w: 100, h: 60 })]);
    connectToPoint(editor, "r1" as never, "down", { x: 50, y: 300 });
    const [arrow] = created(calls);
    expect(arrow).toMatchObject({
      type: "arrow",
      x: 50,
      y: 60,
      props: { start: { x: 0, y: 0 }, end: { x: 0, y: 240 } },
    });
    expect(bindings(calls)).toEqual([bound("start", arrow.id, "r1", { x: 0.5, y: 1 })]);
    expect(names(calls).indexOf("markHistoryStoppingPoint")).toBeLessThan(names(calls).indexOf("run"));
  });

  it("makes nothing — not even an undo step — when released back over the source", () => {
    const { editor, calls } = fakeCanvas([geo("r1", { x: 0, y: 0, w: 100, h: 60 })]);
    connectToPoint(editor, "r1" as never, "right", { x: 50, y: 30 });
    expect(calls).toEqual([]);
  });

  it("never targets the source, what the source sits in, or an arrow", () => {
    const shapes = [
      other("f1", "frame", { x: 0, y: 0, w: 600, h: 400 }),
      card("s1", { x: 20, y: 20, w: 500, h: 300 }, { parentId: "f1" }),
      geo("r1", { x: 50, y: 50, w: 100, h: 60 }, { parentId: "s1" }),
      geo("r2", { x: 300, y: 50, w: 100, h: 60 }, { parentId: "s1" }),
      other("a1", "arrow", { x: 200, y: 180, w: 60, h: 60 }),
    ];
    const { editor, calls } = fakeCanvas(shapes);
    expect(quickConnectTargetAt(editor, "r1" as never, { x: 250, y: 200 })).toBeUndefined();
    expect(quickConnectTargetAt(editor, "r1" as never, { x: 100, y: 80 })).toBeUndefined();
    expect(quickConnectTargetAt(editor, "r1" as never, { x: 350, y: 80 })?.id).toBe("r2");
    // Released on the empty part of its own section: a free end, not an arrow bound to the section.
    connectToPoint(editor, "r1" as never, "right", { x: 250, y: 200 });
    expect(bindings(calls).map((binding) => binding.toId)).toEqual(["r1"]);
  });
});

// ─────────────── Geometry (pure) ───────────────

describe("AF2.1 R4 quick connect — geometry", () => {
  it("never places a continued shape across a frame's edge: its sides are walls", () => {
    const frame: TPpmBox = { x: 0, y: 0, w: 600, h: 400 };
    const size = { w: 100, h: 100 };
    const inside = (box: TPpmBox) =>
      box.x >= frame.x && box.y >= frame.y && box.x + box.w <= frame.x + frame.w && box.y + box.h <= frame.y + frame.h;
    const outside = (box: TPpmBox) =>
      box.x >= frame.x + frame.w || box.x + box.w <= frame.x || box.y >= frame.y + frame.h || box.y + box.h <= frame.y;
    // Without the walls a source near the right edge continues across it.
    const nearEdge: TPpmBox = { x: 400, y: 150, w: 100, h: 100 };
    const across = placeQuickConnectShape(nearEdge, "right", size, [nearEdge]);
    expect(inside(across) || outside(across)).toBe(false);
    for (const x of [20, 150, 250, 400, 480])
      for (const y of [20, 150, 280])
        for (const direction of DIRECTIONS) {
          const source: TPpmBox = { x, y, w: 100, h: 100 };
          const placed = placeQuickConnectShape(source, direction, size, [source, ...quickConnectWalls(frame)]);
          expect(inside(placed) || outside(placed), `${direction} from ${x},${y}`).toBe(true);
        }
  });

  it("hides the top «+» exactly where tldraw pins the style toolbar's row over it", () => {
    // The pinned row covers 16…54 px of the view; the open top «+» spans top − 20 − 12 … top − 20 + 12.
    expect(isTopQuickConnectHandleCovered(86)).toBe(false);
    expect(isTopQuickConnectHandleCovered(85)).toBe(true);
    expect(isTopQuickConnectHandleCovered(0)).toBe(true);
    expect(isTopQuickConnectHandleCovered(400)).toBe(false);
    // Where the toolbar is lifted over the «+» (R3), the circle, even open, stays under the lift.
    expect(PPM_QUICK_CONNECT_HANDLE_OFFSET + 24 / 2).toBeLessThanOrEqual(PPM_STYLE_TOOLBAR_LIFT);
  });

  it("opens «Продолжить» beside its «+», away from the shape, inside the viewport", () => {
    const { lift, margin, side } = PPM_QUICK_CONNECT_MENU;
    const size = { w: 240, h: 100 };
    const viewport = { w: 1200, h: 800 };
    const handle = { x: 500, y: 300 };
    expect(quickConnectMenuOrigin("right", handle, size, viewport)).toEqual({ x: 500 + side, y: 300 - lift });
    expect(quickConnectMenuOrigin("down", handle, size, viewport)).toEqual({ x: 500 + side, y: 300 - lift });
    expect(quickConnectMenuOrigin("left", handle, size, viewport)).toEqual({ x: 500 - side - 240, y: 300 - lift });
    expect(quickConnectMenuOrigin("up", handle, size, viewport)).toEqual({ x: 500 + side, y: 300 + lift - 100 });
    expect(quickConnectMenuOrigin("right", { x: 1150, y: 790 }, size, viewport)).toEqual({
      x: 1200 - 240 - margin,
      y: 800 - 100 - margin,
    });
    expect(quickConnectMenuOrigin("up", { x: 10, y: 20 }, size, viewport)).toEqual({ x: 10 + side, y: margin });
    expect(quickConnectMenuOrigin("left", handle, size, { w: 200, h: 80 })).toEqual({ x: margin, y: margin });
  });

  it("enters a target through the middle of the side that faces the arrow's start", () => {
    const target = { x: 0, y: 0, w: 100, h: 50 };
    expect(quickConnectFacingAnchor(target, { x: 300, y: 25 })).toEqual({ x: 1, y: 0.5 });
    expect(quickConnectFacingAnchor(target, { x: -200, y: 25 })).toEqual({ x: 0, y: 0.5 });
    expect(quickConnectFacingAnchor(target, { x: 50, y: -100 })).toEqual({ x: 0.5, y: 0 });
    expect(quickConnectFacingAnchor(target, { x: 50, y: 200 })).toEqual({ x: 0.5, y: 1 });
    // Measured in the target's own proportions: a wide box is entered from below by a point below-right of it.
    expect(quickConnectFacingAnchor(target, { x: 160, y: 100 })).toEqual({ x: 0.5, y: 1 });
  });

  it("moves the menu focus by e.code: arrows wrap around, Home and End jump, other keys do nothing", () => {
    expect(quickConnectMenuFocus("ArrowRight", 0, 5)).toBe(1);
    expect(quickConnectMenuFocus("ArrowDown", 2, 5)).toBe(3);
    expect(quickConnectMenuFocus("ArrowRight", 4, 5)).toBe(0);
    expect(quickConnectMenuFocus("ArrowLeft", 0, 5)).toBe(4);
    expect(quickConnectMenuFocus("ArrowUp", 2, 5)).toBe(1);
    expect(quickConnectMenuFocus("Home", 3, 5)).toBe(0);
    expect(quickConnectMenuFocus("End", 0, 5)).toBe(4);
    expect(quickConnectMenuFocus("ArrowRight", -1, 5)).toBe(0);
    expect(quickConnectMenuFocus("ArrowLeft", -1, 5)).toBe(4);
    expect(quickConnectMenuFocus("KeyL", 0, 5)).toBeUndefined();
    expect(quickConnectMenuFocus("Escape", 0, 5)).toBeUndefined();
    expect(quickConnectMenuFocus("ArrowRight", -1, 0)).toBeUndefined();
  });
});

// ─────────────── The overlay's wiring (React in a browser — source checks) ───────────────

describe("AF2.1 R4 quick connect — overlay wiring", () => {
  it("renders four «+» and a «Продолжить» menu for the target the actions choose", () => {
    has(overlay, "readQuickConnectTarget(editor, canEdit)");
    has(overlay, 'role="menu"');
    for (const direction of DIRECTIONS) expect(overlay).toContain(`"${direction}"`);
  });

  it("turns a drag of «+» into a connection to a point or to the shape under the pointer", () => {
    has(overlay, "connectToPoint(editor, target.id, drag.direction, editor.screenToPage(");
    has(overlay, "quickConnectTargetAt(editor, target.id, pagePoint)");
  });

  it("follows the camera through tldraw's reactive `react` and keeps a «+» drag away from the canvas", () => {
    has(overlay, 'react("ppm quick connect handles"');
    has(overlay, 'react("ppm quick connect menu"');
    has(overlay, "event.currentTarget.setPointerCapture(event.pointerId)");
    // The position is written into the DOM; nothing camera-dependent is React state.
    expect(overlay).not.toMatch(/useState[^;]*(box|zoom|camera)/i);
  });

  it("hides the top «+» under the pinned style toolbar and takes it out of the Tab order", () => {
    has(overlay, "isTopQuickConnectHandleCovered(points.up.y + PPM_QUICK_CONNECT_HANDLE_OFFSET)");
    has(overlay, 'handle.style.visibility = hidden ? "hidden" : "";');
    has(overlay, "handle.tabIndex = hidden ? -1 : 0;");
  });

  it("listens for Escape (e.code), outside presses and focus leaving only while the menu is open", () => {
    const menu = overlay.slice(overlay.indexOf("function QuickConnectMenu("));
    expect(overlay.indexOf("function QuickConnectMenu(")).toBeGreaterThan(0);
    has(overlay, "{picker && (");
    for (const listener of [
      'window.addEventListener("keydown"',
      'window.addEventListener("pointerdown"',
      'root?.addEventListener("focusout"',
    ]) {
      expect(overlay.split(listener), listener).toHaveLength(2);
      expect(menu, listener).toContain(listener);
    }
    has(menu, 'if (event.code !== "Escape") return;');
    has(overlay, "quickConnectMenuFocus(event.code,");
    expect(overlay).not.toMatch(/\bevent\.key\b/);
  });

  it("keeps the card components out of the node tests: shape.tsx is imported for types only", () => {
    for (const [name, source] of [
      ["canvas-toolkit-actions.ts", actionsSource],
      ["canvas-toolkit-model.ts", modelSource],
    ]) {
      expect(source, name).not.toMatch(/^import (?!type )[^;]*from "\.\/shape";/m);
      expect(source, name).toContain('"ppm-canvas-node" satisfies TPpmCanvasShape["type"]');
    }
  });
});
