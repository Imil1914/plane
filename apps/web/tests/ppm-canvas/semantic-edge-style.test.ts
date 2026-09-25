import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TPpmCanvasSemanticEdge, TPpmCanvasSemanticRelationType } from "@ppm/canvas";
import { getPpmTranslation } from "@ppm/brand";
import { isCanvasCommandAllowedReadOnly } from "@/components/ppm-canvas/board-workspace-state";
import {
  SEMANTIC_EDGE_STYLE,
  SEMANTIC_RELATION_LABELS,
  isChipPressForEdge,
  sameSemanticEdges,
  semanticLinksForShape,
  shouldShowEdgeChip,
  visibleSemanticEdges,
} from "@/components/ppm-canvas/semantic-edge-style";

const TYPES = [
  "relates_to",
  "depends_on",
  "blocks",
  "explains",
  "implements",
  "evidence_for",
  "contradicts",
  "derived_from",
  "result_of",
];

const edge = (
  id: string,
  from: string,
  to: string,
  relation: TPpmCanvasSemanticRelationType,
  status: TPpmCanvasSemanticEdge["confirmation_status"] = "confirmed"
): TPpmCanvasSemanticEdge => ({
  edge_id: id,
  board_id: "board",
  from_shape_id: from,
  to_shape_id: to,
  relation_type: relation,
  label: null,
  confidence: null,
  origin: "user",
  confirmation_status: status,
  confirmed_by: null,
  confirmed_at: null,
  created_by: "user",
  created_at: "2026-09-24T10:00:00Z",
  updated_at: "2026-09-24T10:00:00Z",
});

type TFakeShape = { id: string; section: boolean };
const isFakeSection = (shape: TFakeShape) => shape.section;

describe("semantic edge style (UX1.1 C2)", () => {
  it("covers all nine relation types with a line ending and a label", () => {
    // oxlint-disable-next-line unicorn/no-array-sort -- Object.keys and the spread return fresh arrays.
    expect(Object.keys(SEMANTIC_EDGE_STYLE).sort()).toEqual([...TYPES].sort());
    // oxlint-disable-next-line unicorn/no-array-sort -- Object.keys and the spread return fresh arrays.
    expect(Object.keys(SEMANTIC_RELATION_LABELS).sort()).toEqual([...TYPES].sort());
  });

  it("reads the type without colour: bar blocks, dashed contradicts, arrows elsewhere", () => {
    const byEnd = (end: string) =>
      TYPES.filter((type) => SEMANTIC_EDGE_STYLE[type as TPpmCanvasSemanticRelationType].end === end);
    expect(byEnd("bar")).toEqual(["blocks"]);
    expect(byEnd("none")).toEqual(["relates_to"]);
    expect(TYPES.filter((type) => SEMANTIC_EDGE_STYLE[type as TPpmCanvasSemanticRelationType].dashed)).toEqual([
      "contradicts",
    ]);
    expect(
      TYPES.filter((type) => SEMANTIC_EDGE_STYLE[type as TPpmCanvasSemanticRelationType].tone === "danger")
    ).toEqual(["blocks", "contradicts"]);
  });

  it("keeps the existing relation labels and drops «ИИ» from the proposed state (R16)", () => {
    const ru = (type: TPpmCanvasSemanticRelationType) => getPpmTranslation("ru", SEMANTIC_RELATION_LABELS[type]);
    expect([ru("blocks"), ru("depends_on"), ru("implements"), ru("evidence_for"), ru("contradicts")]).toEqual([
      "Блокирует",
      "Зависит от",
      "Реализует",
      "Подтверждает",
      "Противоречит",
    ]);
    expect(getPpmTranslation("ru", "canvas.edge_proposed")).toBe("Предложено — требуется подтверждение");
    expect(getPpmTranslation("ru", "canvas.edge_proposed_short")).toBe("Предложено");
    expect(getPpmTranslation("ru", "canvas.edge_proposed")).not.toContain("ИИ");
  });

  it("hides chips on segments shorter than the chip", () => {
    expect(shouldShowEdgeChip(40, "Блокирует")).toBe(false);
    expect(shouldShowEdgeChip(200, "Блокирует")).toBe(true);
  });

  it("skips rejected edges and lists a card's links with direction", () => {
    const edges = [
      edge("1", "shape:a", "shape:b", "blocks"),
      edge("2", "shape:c", "shape:a", "implements"),
      edge("3", "shape:a", "shape:d", "depends_on", "rejected"),
    ];
    expect(visibleSemanticEdges(edges).map((item) => item.edge_id)).toEqual(["1", "2"]);
    expect(
      semanticLinksForShape(edges, "shape:a").map((link) => [link.edge.edge_id, link.direction, link.otherShapeId])
    ).toEqual([
      ["1", "out", "shape:b"],
      ["2", "in", "shape:c"],
    ]);
    expect(sameSemanticEdges(edges, [...edges])).toBe(true);
    expect(sameSemanticEdges(edges, [edges[0], { ...edges[1], confirmation_status: "rejected" }, edges[2]])).toBe(
      false
    );
  });

  it("opens the read-only link list for viewers only in v2 (R12)", () => {
    expect(isCanvasCommandAllowedReadOnly("semantic-edges", true)).toBe(true);
    expect(isCanvasCommandAllowedReadOnly("semantic-edges", false)).toBe(false);
  });

  it("lets a chip open its link only on a primary press that no card covers (sections are see-through)", () => {
    const calls: unknown[] = [];
    const editor = (shapes: TFakeShape[]) => ({
      screenToPage: (point: { x: number; y: number }) => {
        calls.push(["screenToPage", point]);
        return { x: point.x - 10, y: point.y - 20 };
      },
      getShapesAtPoint: (point: { x: number; y: number }, options: { hitInside: boolean }) => {
        calls.push(["getShapesAtPoint", point, options]);
        return shapes;
      },
    });
    const press = { button: 0, clientX: 110, clientY: 220 };
    expect(isChipPressForEdge(editor([]), press, isFakeSection)).toBe(true);
    expect(calls).toEqual([
      ["screenToPage", { x: 110, y: 220 }],
      ["getShapesAtPoint", { x: 100, y: 200 }, { hitInside: true }],
    ]);
    const section = { id: "shape:section", section: true };
    const card = { id: "shape:card", section: false };
    expect(isChipPressForEdge(editor([section]), press, isFakeSection)).toBe(true);
    // A card drawn over the chip owns the press: tldraw selects the card.
    expect(isChipPressForEdge(editor([section, card]), press, isFakeSection)).toBe(false);
    // Right and middle buttons stay with tldraw (menu, panning) without a hit test.
    calls.length = 0;
    expect(isChipPressForEdge(editor([]), { ...press, button: 2 }, isFakeSection)).toBe(false);
    expect(isChipPressForEdge(editor([]), { ...press, button: 1 }, isFakeSection)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not refresh links on window focus while «Смысловые связи» is open (a half-filled form survives)", () => {
    const editor = readFileSync(new URL("../../core/components/ppm-canvas/editor.tsx", import.meta.url), "utf8");
    const start = editor.indexOf("Semantic edges have no realtime channel");
    const refresh = editor.slice(start, editor.indexOf('window.addEventListener("focus", onFocus);', start));
    // The guard is the handler's first statement (comments aside).
    expect(refresh).toMatch(
      /const onFocus = \(\) => \{\s*(?:\/\/[^\n]*\s*)*if \(semanticPanelOpenRef\.current\) return;/
    );
    expect(refresh.indexOf("semanticPanelOpenRef.current")).toBeLessThan(refresh.indexOf("getSemanticEdges"));
  });
});
