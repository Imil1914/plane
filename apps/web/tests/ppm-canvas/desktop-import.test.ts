import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSerializedPpmCanvasNode, serializePpmCanvasNode } from "@ppm/canvas";
import { createDesktopImportReport, prepareDesktopFlowImport } from "@/components/ppm-canvas/desktop-import";

const AUTHOR = "8e3389db-299c-4861-89d3-1003d8e36105";

function flowShape(id: string, kind: string, body: string, extra = "{}") {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type: "flow-node",
    x: 120,
    y: -40,
    rotation: 0,
    props: { kind, title: `${kind} title`, body, extra, w: 320, h: 220 },
  };
}

function snapshot(...records: object[]): string {
  return JSON.stringify({
    document: {
      schema: { schemaVersion: 2, sequences: {} },
      store: Object.fromEntries(records.map((record) => [(record as { id: string }).id, record])),
    },
    session: { currentPageId: "page:page" },
  });
}

describe("desktop AntyFlow board import preparation", () => {
  it("reads a .flow.json fixture and preserves its bound arrow as a connection", () => {
    const raw = readFileSync(new URL("./fixtures/desktop-basic.flow.json", import.meta.url), "utf8");
    const result = prepareDesktopFlowImport(raw, AUTHOR);
    expect(result.convertedCount).toBe(3);
    expect(result.placeholderCount).toBe(0);
    expect(result.unsupportedKinds).toEqual([]);
    expect(result.shapes.map((shape) => shape.sourceId)).toEqual(["shape:desktop-note", "shape:desktop-document"]);
    expect(result.connections).toEqual([
      {
        sourceId: "shape:desktop-arrow",
        sourceKind: "arrow",
        fromSourceId: "shape:desktop-note",
        toSourceId: "shape:desktop-document",
        fromBinding: {
          normalizedAnchor: { x: 1, y: 0.5 },
          isExact: false,
          isPrecise: true,
          snap: "none",
        },
        toBinding: {
          normalizedAnchor: { x: 0, y: 0.5 },
          isExact: false,
          isPrecise: true,
          snap: "none",
        },
        style: {
          kind: "arc",
          color: "black",
          labelColor: "black",
          fill: "none",
          dash: "draw",
          size: "m",
          arrowheadStart: "none",
          arrowheadEnd: "arrow",
          font: "draw",
          bend: 0,
          text: "",
          labelPosition: 0.5,
          scale: 1,
          elbowMidPoint: 0.5,
        },
        status: "converted",
      },
    ]);
    expect(createDesktopImportReport(result, "desktop-basic.flow.json").items).toEqual([
      { source_id: "shape:desktop-note", source_kind: "note", status: "converted" },
      { source_id: "shape:desktop-document", source_kind: "doc", status: "converted" },
      { source_id: "shape:desktop-arrow", source_kind: "arrow", status: "converted" },
    ]);
  });

  it("keeps incomplete, duplicate and non-node arrow bindings as inert placeholders", () => {
    const arrow = {
      id: "shape:arrow",
      typeName: "shape",
      type: "arrow",
      x: 420,
      y: 80,
      props: { start: { x: 0, y: 0 }, end: { x: 80, y: 0 } },
    };
    const binding = (id: string, terminal: "start" | "end", toId: string) => ({
      id: `binding:${id}`,
      typeName: "binding",
      type: "arrow",
      fromId: arrow.id,
      toId,
      props: { terminal },
    });
    const note = flowShape("note", "note", "Note");
    const doc = flowShape("doc", "doc", "Doc");
    for (const bindings of [
      [binding("start", "start", note.id)],
      [binding("start", "start", note.id), binding("duplicate", "start", doc.id), binding("end", "end", doc.id)],
      [binding("start", "start", note.id), binding("end", "end", "shape:missing")],
      [binding("start", "start", note.id), binding("end", "end", note.id)],
    ]) {
      const result = prepareDesktopFlowImport(snapshot(note, doc, arrow, ...bindings), AUTHOR);
      expect(result.connections).toEqual([]);
      expect(result.shapes.at(-1)?.sourceKind).toBe("arrow");
      expect(result.shapes.at(-1)?.status).toBe("placeholder");
      expect(result.unsupportedKinds).toEqual(["arrow"]);
    }
  });

  it("preserves a bound arrow endpoint on an imported frame and rejects malformed anchors", () => {
    const arrow = {
      id: "shape:frame-arrow",
      typeName: "shape",
      type: "arrow",
      x: 200,
      y: 150,
      props: {
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        color: "light-blue",
        dash: "dashed",
        arrowheadStart: "dot",
        text: "Переход",
        font: "sans",
        bend: 20,
      },
    };
    const frame = {
      id: "shape:frame-target",
      typeName: "shape",
      type: "frame",
      x: 350,
      y: 100,
      props: { name: "Рамка", w: 400, h: 300 },
    };
    const note = flowShape("bound-note", "note", "Текст");
    const start = {
      id: "binding:frame-start",
      typeName: "binding",
      type: "arrow",
      fromId: arrow.id,
      toId: note.id,
      props: { terminal: "start", normalizedAnchor: { x: 1, y: 0.25 }, isExact: true, isPrecise: true },
    };
    const end = {
      id: "binding:frame-end",
      typeName: "binding",
      type: "arrow",
      fromId: arrow.id,
      toId: frame.id,
      props: { terminal: "end", normalizedAnchor: { x: 0, y: 0.75 }, snap: "edge" },
    };
    const result = prepareDesktopFlowImport(snapshot(note, frame, arrow, start, end), AUTHOR);
    expect(result).toMatchObject({ convertedCount: 3, placeholderCount: 0 });
    expect(result.connections[0]).toMatchObject({
      fromSourceId: note.id,
      toSourceId: frame.id,
      fromBinding: { normalizedAnchor: { x: 1, y: 0.25 }, isExact: true, isPrecise: true },
      toBinding: { normalizedAnchor: { x: 0, y: 0.75 }, isExact: false, isPrecise: true, snap: "edge" },
      style: {
        color: "light-blue",
        dash: "dashed",
        arrowheadStart: "dot",
        text: "Переход",
        font: "sans",
        bend: 20,
      },
    });
    expect(JSON.stringify(createDesktopImportReport(result, "arrows.flow.json"))).not.toContain("Переход");

    const invalid = { ...end, props: { ...end.props, normalizedAnchor: { x: 4, y: 0.75 } } };
    const rejected = prepareDesktopFlowImport(snapshot(note, frame, arrow, start, invalid), AUTHOR);
    expect(rejected.connections).toEqual([]);
    expect(rejected.shapes.find((shape) => shape.sourceId === arrow.id)?.status).toBe("placeholder");

    const invalidStyle = { ...arrow, props: { ...arrow.props, color: "not-a-tldraw-color" } };
    const styleRejected = prepareDesktopFlowImport(snapshot(note, frame, invalidStyle, start, end), AUTHOR);
    expect(styleRejected.connections).toEqual([]);
    expect(styleRejected.shapes.find((shape) => shape.sourceId === arrow.id)?.status).toBe("placeholder");
  });

  it("preserves a free arrow's local endpoints, page transform, style and label", () => {
    const frame = {
      id: "shape:free-arrow-frame",
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
      x: 100,
      y: 200,
      rotation: Math.PI / 2,
      props: { name: "Рамка", w: 500, h: 400 },
    };
    const arrow = {
      id: "shape:free-arrow",
      typeName: "shape",
      type: "arrow",
      parentId: frame.id,
      x: 10,
      y: 20,
      rotation: Math.PI / 4,
      props: {
        start: { x: 0, y: 0 },
        end: { x: 120, y: 30 },
        color: "light-blue",
        dash: "dashed",
        text: "Примечание",
      },
    };
    const result = prepareDesktopFlowImport(snapshot({ id: "page:page", typeName: "page" }, frame, arrow), AUTHOR);
    expect(result).toMatchObject({ convertedCount: 2, placeholderCount: 0, hasFlattenedHierarchy: false });
    expect(result.connections).toEqual([]);
    expect(result.freeArrows).toHaveLength(1);
    expect(result.freeArrows[0]).toMatchObject({
      parentSourceId: frame.id,
      sourceId: arrow.id,
      start: { x: 0, y: 0 },
      end: { x: 120, y: 30 },
      style: { color: "light-blue", dash: "dashed", text: "Примечание" },
    });
    expect(result.freeArrows[0].x).toBeCloseTo(80);
    expect(result.freeArrows[0].y).toBeCloseTo(210);
    expect(result.freeArrows[0].rotation).toBeCloseTo((3 * Math.PI) / 4);
    expect(createDesktopImportReport(result, "free-arrows.flow.json")).toMatchObject({
      schema_version: 3,
      free_arrow_count: 1,
      converted_count: 2,
    });
    expect(JSON.stringify(createDesktopImportReport(result, "free-arrows.flow.json"))).not.toContain("Примечание");
  });

  it("prepares the synthetic browser-smoke fixture without placeholders", () => {
    const raw = readFileSync(new URL("./fixtures/desktop-free-arrow.flow.json", import.meta.url), "utf8");
    const result = prepareDesktopFlowImport(raw, AUTHOR);
    expect(result).toMatchObject({ convertedCount: 3, placeholderCount: 0, hasFlattenedHierarchy: false });
    expect(result.shapes).toHaveLength(2);
    expect(result.freeArrows).toMatchObject([
      {
        sourceId: "shape:free-arrow",
        x: 150,
        y: 180,
        start: { x: 0, y: 0 },
        end: { x: 180, y: 60 },
        style: { text: "Свободная стрелка AF1.2" },
      },
    ]);
  });

  it("keeps malformed, zero-length or ambiguously bound free arrows as placeholders", () => {
    const arrow = {
      id: "shape:invalid-free-arrow",
      typeName: "shape",
      type: "arrow",
      x: 10,
      y: 20,
      props: { start: { x: 0, y: 0 }, end: { x: 120, y: 30 } },
    };
    const variants = [
      { ...arrow, props: { ...arrow.props, end: { x: 0, y: 0 } } },
      { ...arrow, props: { ...arrow.props, end: { x: "120", y: 30 } } },
      { ...arrow, props: { ...arrow.props, end: { x: 120, y: 30, terminal: "end" } } },
      {
        ...arrow,
        props: { ...arrow.props, start: { x: -Number.MAX_VALUE, y: 0 }, end: { x: Number.MAX_VALUE, y: 0 } },
      },
      { ...arrow, props: { ...arrow.props, color: "not-a-tldraw-color" } },
    ];
    for (const invalidArrow of variants) {
      const result = prepareDesktopFlowImport(snapshot(invalidArrow), AUTHOR);
      expect(result).toMatchObject({ convertedCount: 0, placeholderCount: 1, freeArrows: [] });
      expect(result.shapes[0].node).toMatchObject({ kind: "note", title: "arrow", body: "" });
    }
    const unexpectedBinding = {
      id: "binding:unknown",
      typeName: "binding",
      type: "unknown",
      fromId: arrow.id,
      toId: "shape:anything",
      props: {},
    };
    const bound = prepareDesktopFlowImport(snapshot(arrow, unexpectedBinding), AUTHOR);
    expect(bound).toMatchObject({ convertedCount: 0, placeholderCount: 1, freeArrows: [] });
  });

  it("converts basic nodes while retaining source ids and positions for migration reporting", () => {
    const result = prepareDesktopFlowImport(
      snapshot(
        flowShape("note", "note", "Текст"),
        flowShape("doc", "doc", "# Документ"),
        flowShape("code", "code", "print(1)")
      ),
      AUTHOR
    );
    expect(result.convertedCount).toBe(3);
    expect(result.placeholderCount).toBe(0);
    expect(result.shapes.map(({ node }) => node.kind)).toEqual(["note", "document", "code"]);
    expect(result.shapes[0]).toMatchObject({ sourceId: "shape:note", x: 120, y: -40 });
    expect(parseSerializedPpmCanvasNode(serializePpmCanvasNode(result.shapes[0].node))).toMatchObject({
      status: "valid",
      node: { body: "Текст", legacy_desktop: { source_id: "shape:note" } },
    });
  });

  it("preserves a nested frame relationship and page rotation for import", () => {
    const frame = {
      id: "shape:frame",
      typeName: "shape",
      type: "frame",
      parentId: "page:page",
      x: 100,
      y: 200,
      rotation: Math.PI / 2,
      props: { name: "Этап исследования", w: 500, h: 400 },
    };
    const nested = {
      ...flowShape("nested", "note", "Внутри рамки"),
      parentId: frame.id,
      x: 10,
      y: 20,
      rotation: Math.PI / 4,
    };
    const result = prepareDesktopFlowImport(snapshot({ id: "page:page", typeName: "page" }, frame, nested), AUTHOR);
    const imported = result.shapes.find((shape) => shape.sourceId === nested.id);
    expect(result).toMatchObject({ hasFlattenedHierarchy: false, hasRotations: true });
    expect(imported?.parentSourceId).toBe(frame.id);
    expect(imported?.x).toBeCloseTo(80);
    expect(imported?.y).toBeCloseTo(210);
    expect(imported?.rotation).toBeCloseTo((3 * Math.PI) / 4);
    expect(result.shapes.find((shape) => shape.sourceId === frame.id)?.node).toMatchObject({
      kind: "frame",
      title: "Этап исследования",
      visual: { width: 500, height: 400 },
    });
    expect(result).toMatchObject({ convertedCount: 2, placeholderCount: 0 });
    expect(createDesktopImportReport(result, "nested.flow.json").has_flattened_hierarchy).toBe(false);
  });

  it("preserves nested native and AntyFlow group relationships without copying group props", () => {
    const nativeGroup = {
      id: "shape:native-group",
      typeName: "shape",
      type: "group",
      parentId: "page:page",
      x: 100,
      y: 200,
      rotation: 0,
      props: {},
    };
    const flowGroup = { ...flowShape("flow-group", "group", "Группа"), parentId: nativeGroup.id, x: 20, y: 30 };
    const nested = { ...flowShape("nested-note", "note", "Внутри"), parentId: flowGroup.id, x: 10, y: 15 };
    const sibling = { ...flowShape("sibling-note", "note", "Рядом"), parentId: nativeGroup.id, x: 70, y: 80 };
    const result = prepareDesktopFlowImport(
      snapshot({ id: "page:page", typeName: "page" }, nativeGroup, flowGroup, nested, sibling),
      AUTHOR
    );
    expect(result).toMatchObject({ convertedCount: 4, placeholderCount: 0, hasFlattenedHierarchy: false });
    expect(result.groups).toEqual([
      { sourceId: nativeGroup.id, parentSourceId: undefined, x: 100, y: 200, rotation: 0 },
    ]);
    expect(result.shapes.find((shape) => shape.sourceId === flowGroup.id)).toMatchObject({
      parentSourceId: nativeGroup.id,
      node: { kind: "group", body: "Группа" },
    });
    expect(result.shapes.find((shape) => shape.sourceId === nested.id)).toMatchObject({
      parentSourceId: flowGroup.id,
      x: 130,
      y: 245,
    });
    expect(result.shapes.find((shape) => shape.sourceId === sibling.id)).toMatchObject({
      parentSourceId: nativeGroup.id,
      x: 170,
      y: 280,
    });
    expect(result.items).toMatchObject([
      { sourceId: nativeGroup.id, status: "converted" },
      { sourceId: flowGroup.id, status: "converted" },
      { sourceId: nested.id, status: "converted" },
      { sourceId: sibling.id, status: "converted" },
    ]);
  });

  it("keeps a singleton native group as an explicit placeholder", () => {
    const nativeGroup = {
      id: "shape:singleton-group",
      typeName: "shape",
      type: "group",
      parentId: "page:page",
      props: {},
    };
    const child = { ...flowShape("singleton-child", "note", "Внутри"), parentId: nativeGroup.id };
    const result = prepareDesktopFlowImport(
      snapshot({ id: "page:page", typeName: "page" }, nativeGroup, child),
      AUTHOR
    );
    expect(result).toMatchObject({ convertedCount: 1, placeholderCount: 1, hasFlattenedHierarchy: true });
    expect(result.groups).toEqual([]);
    expect(result.shapes[0]).toMatchObject({ sourceId: nativeGroup.id, status: "placeholder", node: { kind: "note" } });
  });

  it("reports hierarchy flattening when a parent cannot receive children", () => {
    const parent = flowShape("plain-note-parent", "note", "Not a group");
    const child = { ...flowShape("child", "note", "Nested"), parentId: parent.id };
    const result = prepareDesktopFlowImport(snapshot(parent, child), AUTHOR);
    expect(result.hasFlattenedHierarchy).toBe(true);
    expect(result.shapes[1].parentSourceId).toBe(parent.id);
  });

  it("keeps unsupported frame dimensions as placeholders rather than clipping a visible frame", () => {
    const oversized = {
      id: "shape:oversized-frame",
      typeName: "shape",
      type: "frame",
      x: 40,
      y: 60,
      props: { name: "Большая рамка", w: 2400, h: 400 },
    };
    const result = prepareDesktopFlowImport(snapshot(oversized), AUTHOR);
    expect(result).toMatchObject({ convertedCount: 0, placeholderCount: 1, unsupportedKinds: ["frame"] });
    expect(result.shapes[0].node).toMatchObject({ kind: "note", title: "frame", body: "" });
  });

  it("rejects a missing parent, hierarchy cycle or unknown page before changing the board", () => {
    const missingParent = { ...flowShape("missing", "note", "x"), parentId: "shape:unknown" };
    const first = { ...flowShape("first", "note", "x"), parentId: "shape:second" };
    const second = { ...flowShape("second", "note", "x"), parentId: "shape:first" };
    const unknownPage = { ...flowShape("unknown-page", "note", "x"), parentId: "page:other" };
    expect(() => prepareDesktopFlowImport(snapshot(missingParent), AUTHOR)).toThrow(/hierarchy/);
    expect(() => prepareDesktopFlowImport(snapshot(first, second), AUTHOR)).toThrow(/hierarchy/);
    expect(() =>
      prepareDesktopFlowImport(snapshot({ id: "page:page", typeName: "page" }, unknownPage), AUTHOR)
    ).toThrow(/unknown page/);
  });

  it("converts a literal-cell desktop sheet without silently dropping dimensions or cell text", () => {
    const sheet = flowShape(
      "sheet",
      "sheet",
      "",
      JSON.stringify({ sheet: { rows: 2, cols: 3, cells: { "0:0": "Имя", "0:1": "Статус", "1:0": "PPM" } } })
    );
    const result = prepareDesktopFlowImport(snapshot(sheet), AUTHOR);
    expect(result).toMatchObject({ convertedCount: 1, placeholderCount: 0, hasLegacyExtras: false });
    expect(result.shapes[0].node).toMatchObject({
      kind: "table",
      columns: [{ label: "A" }, { label: "B" }, { label: "C" }],
      rows: [
        { cells: { "column-0": "Имя", "column-1": "Статус", "column-2": "" } },
        { cells: { "column-0": "PPM", "column-1": "", "column-2": "" } },
      ],
    });
    expect(parseSerializedPpmCanvasNode(serializePpmCanvasNode(result.shapes[0].node)).status).toBe("valid");
  });

  it("keeps formula, resized, oversize and unknown sheet data as placeholders", () => {
    const variants = [
      { rows: 2, cols: 2, cells: { "0:0": "=1+1" } },
      { rows: 2, cols: 2, cells: {}, colW: { "0": 200 } },
      { rows: 501, cols: 2, cells: {} },
      { rows: 2, cols: 2, cells: { "3:0": "outside" } },
      { rows: 2, cols: 2, cells: { "00:0": "not canonical" } },
      { rows: 2, cols: 2, cells: {}, future: "keep in source file" },
      null,
    ];
    for (const sheet of variants) {
      const result = prepareDesktopFlowImport(
        snapshot(flowShape("sheet", "sheet", "", JSON.stringify({ sheet }))),
        AUTHOR
      );
      expect(result).toMatchObject({ convertedCount: 0, placeholderCount: 1, hasLegacyExtras: true });
      expect(result.shapes[0].node).toMatchObject({ kind: "note", body: "" });
      expect(result.unsupportedKinds).toEqual(["sheet"]);
    }
  });

  it("uses inert placeholders for deferred AI and unknown nodes without importing private run content", () => {
    const aiShape = flowShape("ai", "ai", "private prompt", '{"model":"secret"}');
    aiShape.props.title = "private prompt in title";
    const result = prepareDesktopFlowImport(snapshot(aiShape, flowShape("other", "future-kind", "User text")), AUTHOR);
    expect(result.placeholderCount).toBe(2);
    expect(result.unsupportedKinds).toEqual(["ai", "future-kind"]);
    expect(result.hasLegacyExtras).toBe(true);
    expect(result.shapes[0].node).toMatchObject({ kind: "note", body: "" });
    expect(result.shapes[1].node).toMatchObject({ kind: "note", title: "future-kind", body: "" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private prompt");
  });

  it("rejects unrelated, multi-page and oversize snapshots before any editor mutation", () => {
    expect(() => prepareDesktopFlowImport('{"format":"ppm-canvas-recovery"}', AUTHOR)).toThrow();
    expect(() => prepareDesktopFlowImport("not json", AUTHOR)).toThrow();
    expect(() =>
      prepareDesktopFlowImport(
        snapshot(
          { id: "page:one", typeName: "page" },
          { id: "page:two", typeName: "page" },
          flowShape("one", "note", "x")
        ),
        AUTHOR
      )
    ).toThrow();
    expect(() => prepareDesktopFlowImport(snapshot(flowShape("long", "note", "x".repeat(50_001))), AUTHOR)).toThrow();
  });

  it("prepares a 350-shape desktop board without dropping elements", () => {
    const shapes = Array.from({ length: 350 }, (_, index) => flowShape(String(index), "note", String(index)));
    const result = prepareDesktopFlowImport(snapshot(...shapes), AUTHOR);
    expect(result.shapes).toHaveLength(350);
    expect(result.convertedCount).toBe(350);
  });

  it("creates a content-free migration report with every source shape", () => {
    const result = prepareDesktopFlowImport(
      snapshot(flowShape("one", "note", "private note"), flowShape("two", "ai", "secret prompt")),
      AUTHOR
    );
    const report = createDesktopImportReport(result, "example.flow.json");
    expect(report).toMatchObject({
      format: "ppm-desktop-import-report",
      schema_version: 3,
      converted_count: 1,
      free_arrow_count: 0,
      placeholder_count: 1,
      items: [
        { source_id: "shape:one", status: "converted" },
        { source_id: "shape:two", status: "placeholder" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("private note");
    expect(JSON.stringify(report)).not.toContain("secret prompt");
  });
});
