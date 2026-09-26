// AF2.2 F1: «Живая карта» в схеме узлов — необязательное поле `map` у группы (рамка спринта и секции направлений),
// фабрики рамки и секции, предел размера группы. Всё обратно совместимо: версия схемы — 2, группы без `map` и старые
// доски читаются как раньше, неизвестные поля (и внутри `map`) сохраняются.
import { describe, expect, it } from "vitest";
import {
  PPM_CANVAS_GROUP_MAX_SIZE,
  PPM_CANVAS_MAP_ROLES,
  PPM_CANVAS_NODE_REGISTRY,
  PPM_CANVAS_SCHEMA_VERSION,
  createPpmCanvasNode,
  createPpmMapSectionNode,
  createPpmSprintFrameNode,
  duplicatePpmCanvasNode,
  getPpmCanvasMap,
  parseAndMigratePpmCanvasNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  updatePpmCanvasNode,
} from "../index";

const NOW = "2026-09-26T09:00:00.000Z";
const CYCLE_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a61";
const MODULE_ID = "8d4e2f1a-6c3b-4a5d-8e9f-0a1b2c3d4e72";

function storedGroup(extra: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    kind: "group",
    title: "Механика",
    body: "",
    author_id: "user-1",
    created_at: NOW,
    updated_at: NOW,
    visual: { color: "cyan", width: 560, height: 360 },
    ...extra,
  };
}

describe("AF2.2 living map schema", () => {
  it("keeps the board schema version the server accepts and names the two map roles", () => {
    expect(PPM_CANVAS_SCHEMA_VERSION).toBe(2);
    expect(PPM_CANVAS_MAP_ROLES).toEqual(["sprint", "section"]);
  });

  it("reads a pre-AF2.2 group unchanged: no map is added, unknown fields survive", () => {
    const result = parseAndMigratePpmCanvasNode(storedGroup({ future_hint: { keep: true } }));
    expect(result.status).toBe("valid");
    if (result.status !== "valid" || result.node.kind !== "group") throw new Error("Expected a valid group.");
    expect(result.node).not.toHaveProperty("map");
    expect(getPpmCanvasMap(result.node)).toBeUndefined();
    expect(result.node).toMatchObject({ title: "Механика", future_hint: { keep: true }, visual: { color: "cyan" } });
  });

  it("migrates v1 and legacy v0 groups exactly as before — still without a map", () => {
    const v1 = parseAndMigratePpmCanvasNode({ ...storedGroup(), schema_version: 1 });
    expect(v1).toMatchObject({ status: "migrated", node: { schema_version: 2, kind: "group", title: "Механика" } });
    if (v1.status !== "migrated") throw new Error("Expected a migrated group.");
    expect(v1.node).not.toHaveProperty("map");
    const legacy = parseAndMigratePpmCanvasNode({
      kind: "group",
      title: "Старая секция",
      color: "green",
      width: 700,
      height: 500,
    });
    expect(legacy).toMatchObject({
      status: "migrated",
      node: { kind: "group", title: "Старая секция", body: "", visual: { color: "green", width: 700, height: 500 } },
    });
    if (legacy.status !== "migrated") throw new Error("Expected a migrated legacy group.");
    expect(legacy.node).not.toHaveProperty("map");
  });

  it("creates the sprint frame: a neutral section of the default size that carries the cycle", () => {
    const frame = createPpmSprintFrameNode({
      authorId: "user-1",
      cycleId: CYCLE_ID,
      now: NOW,
      title: "Спринт 3 · 16–29 сент.",
    });
    expect(frame).toMatchObject({
      schema_version: 2,
      kind: "group",
      title: "Спринт 3 · 16–29 сент.",
      body: "",
      map: { role: "sprint", cycle_id: CYCLE_ID },
      author_id: "user-1",
      created_at: NOW,
      updated_at: NOW,
      visual: {
        color: "neutral",
        width: PPM_CANVAS_NODE_REGISTRY.group.defaultWidth,
        height: PPM_CANVAS_NODE_REGISTRY.group.defaultHeight,
      },
    });
    expect(parseAndMigratePpmCanvasNode(frame).status).toBe("valid");
    expect(getPpmCanvasMap(frame)).toEqual({ role: "sprint", cycle_id: CYCLE_ID });
  });

  it("creates module sections, «Без направления» included, sized by the caller", () => {
    const section = createPpmMapSectionNode({
      authorId: "user-1",
      height: 620,
      moduleId: MODULE_ID,
      now: NOW,
      title: "Механика",
      width: 1560,
    });
    const unassigned = createPpmMapSectionNode({
      authorId: "user-1",
      moduleId: null,
      now: NOW,
      title: "Без направления",
    });
    expect(section).toMatchObject({
      map: { role: "section", module_id: MODULE_ID },
      visual: { color: "neutral", width: 1560, height: 620 },
    });
    expect(unassigned.map).toEqual({ role: "section", module_id: null });
    for (const node of [section, unassigned])
      expect(parseSerializedPpmCanvasNode(serializePpmCanvasNode(node))).toMatchObject({
        status: "valid",
        node: { kind: "group", map: node.map },
      });
  });

  it("lets a map group grow past the card limit up to the group limit; a plain group keeps 1600 × 1200", () => {
    expect(PPM_CANVAS_GROUP_MAX_SIZE).toBe(20_000);
    const tall = createPpmSprintFrameNode({
      authorId: "user-1",
      cycleId: CYCLE_ID,
      height: 4200,
      now: NOW,
      title: "Спринт",
      width: 3400,
    });
    expect(tall.visual).toMatchObject({ width: 3400, height: 4200 });
    // Only a map group (sprint frame or section) may use the wider PPM_CANVAS_GROUP_MAX_SIZE ceiling.
    expect(
      parseAndMigratePpmCanvasNode(
        storedGroup({
          map: { role: "section", module_id: null },
          visual: { color: "neutral", width: 20_000, height: 20_000 },
        })
      ).status
    ).toBe("valid");
    // A plain group — no `map` — keeps the pre-AF2.2 ceiling, the same 1600 × 1200 every other kind has.
    expect(
      parseAndMigratePpmCanvasNode(storedGroup({ visual: { color: "neutral", width: 1600, height: 1200 } })).status
    ).toBe("valid");
    expect(
      parseAndMigratePpmCanvasNode(storedGroup({ visual: { color: "neutral", width: 1601, height: 800 } })).status
    ).toBe("corrupt");
    // Width and height alone are within the base ceiling, but a collapsed plain group's remembered full height
    // (expanded_height) must fit it too.
    expect(
      parseAndMigratePpmCanvasNode(
        storedGroup({ visual: { color: "neutral", width: 1200, height: 800, expanded_height: 5000 } })
      ).status
    ).toBe("corrupt");
    expect(
      parseAndMigratePpmCanvasNode(storedGroup({ visual: { color: "neutral", width: 20_000, height: 20_000 } })).status
    ).toBe("corrupt");
    expect(
      parseAndMigratePpmCanvasNode(storedGroup({ visual: { color: "neutral", width: 20_001, height: 400 } })).status
    ).toBe("corrupt");
    const note = createPpmCanvasNode({ authorId: "user-1", kind: "note", now: NOW, title: "Заметка" });
    expect(parseAndMigratePpmCanvasNode({ ...note, visual: { ...note.visual, width: 1601 } }).status).toBe("corrupt");
    // A collapsed tall section remembers its full height (shape.tsx toggleCollapsed writes expanded_height).
    const collapsed = updatePpmCanvasNode(
      tall,
      { visual: { ...tall.visual, collapsed: true, expanded_height: 4200, height: 104 } },
      NOW
    );
    expect(collapsed.visual).toMatchObject({ collapsed: true, expanded_height: 4200, height: 104 });
  });

  it("keeps unknown fields inside map and rejects a malformed map", () => {
    expect(
      parseAndMigratePpmCanvasNode(storedGroup({ map: { role: "section", module_id: MODULE_ID, order: 2 } }))
    ).toMatchObject({ status: "valid", node: { map: { role: "section", module_id: MODULE_ID, order: 2 } } });
    for (const map of [
      { role: "sprint" },
      { role: "sprint", cycle_id: "not-a-uuid" },
      { role: "section", module_id: "not-a-uuid" },
      { role: "timeline", cycle_id: CYCLE_ID },
    ])
      expect(parseAndMigratePpmCanvasNode(storedGroup({ map })).status, JSON.stringify(map)).toBe("corrupt");
    expect(() => createPpmSprintFrameNode({ authorId: "user-1", cycleId: "abc", now: NOW, title: "Спринт" })).toThrow();
  });

  it("clips a long Plane name to the title limit without splitting a character", () => {
    const long = `${"Направление ".repeat(20)}🚀`;
    const section = createPpmMapSectionNode({ authorId: "user-1", moduleId: MODULE_ID, now: NOW, title: long });
    expect(section.title.length).toBeLessThanOrEqual(160);
    expect(long.startsWith(section.title)).toBe(true);
    // The rocket's high surrogate would be unit 160: the title stops before it.
    const edge = `${"a".repeat(159)}🚀`;
    expect(createPpmMapSectionNode({ authorId: "user-1", moduleId: null, now: NOW, title: edge }).title).toBe(
      "a".repeat(159)
    );
  });

  it("updates a map group without losing its role and copies it as an ordinary section", () => {
    const section = createPpmMapSectionNode({ authorId: "user-1", moduleId: MODULE_ID, now: NOW, title: "Софт" });
    const renamed = updatePpmCanvasNode(section, { title: "Софт и прошивка" }, NOW);
    expect(renamed.map).toEqual({ role: "section", module_id: MODULE_ID });
    const copy = duplicatePpmCanvasNode(section, "user-2", NOW);
    expect(copy).not.toHaveProperty("map");
    expect(copy).toMatchObject({ kind: "group", title: "Софт", author_id: "user-2" });
    expect(parseAndMigratePpmCanvasNode(copy).status).toBe("valid");
  });

  it("clamps an oversized sprint frame or section to the plain-group ceiling when the copy drops its map", () => {
    const frame = createPpmSprintFrameNode({
      authorId: "user-1",
      cycleId: CYCLE_ID,
      height: 4200,
      now: NOW,
      title: "Спринт",
      width: 3400,
    });
    const frameCopy = duplicatePpmCanvasNode(frame, "user-2", NOW);
    expect(frameCopy).not.toHaveProperty("map");
    expect(frameCopy.visual.width).toBeLessThanOrEqual(1600);
    expect(frameCopy.visual.height).toBeLessThanOrEqual(1200);
    expect(parseAndMigratePpmCanvasNode(frameCopy).status).toBe("valid");

    const wideSection = createPpmMapSectionNode({
      authorId: "user-1",
      height: 3000,
      moduleId: MODULE_ID,
      now: NOW,
      title: "Механика",
      width: 5000,
    });
    const sectionCopy = duplicatePpmCanvasNode(wideSection, "user-2", NOW);
    expect(sectionCopy).not.toHaveProperty("map");
    expect(sectionCopy.visual.width).toBeLessThanOrEqual(1600);
    expect(sectionCopy.visual.height).toBeLessThanOrEqual(1200);
    expect(parseAndMigratePpmCanvasNode(sectionCopy).status).toBe("valid");
  });

  it("finds the map role only on groups that carry one", () => {
    const note = createPpmCanvasNode({ authorId: "user-1", kind: "note", now: NOW, title: "Заметка" });
    const group = createPpmCanvasNode({ authorId: "user-1", kind: "group", now: NOW, title: "Секция" });
    expect(getPpmCanvasMap(note)).toBeUndefined();
    expect(getPpmCanvasMap(group)).toBeUndefined();
  });
});
