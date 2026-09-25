import type { TPpmCanvasSemanticEdge, TPpmCanvasSemanticRelationType } from "@ppm/canvas";
import type { TPpmTranslationKey } from "@ppm/brand";
import type { TPpmEdgeEnd, TPpmPoint } from "./semantic-edge-geometry";

export type TPpmEdgeStyle = { end: TPpmEdgeEnd; dashed: boolean; tone: "neutral" | "danger" };

// Тип читается по концу линии (TOKENS §9 п.5, §11; RC3). Порт — в начале каждой смысловой связи (рисует слой).
export const SEMANTIC_EDGE_STYLE = {
  relates_to: { end: "none", dashed: false, tone: "neutral" },
  depends_on: { end: "arrow", dashed: false, tone: "neutral" },
  blocks: { end: "bar", dashed: false, tone: "danger" },
  explains: { end: "arrow", dashed: false, tone: "neutral" },
  implements: { end: "arrow", dashed: false, tone: "neutral" },
  evidence_for: { end: "arrow", dashed: false, tone: "neutral" },
  contradicts: { end: "arrow", dashed: true, tone: "danger" },
  derived_from: { end: "arrow", dashed: false, tone: "neutral" },
  result_of: { end: "arrow", dashed: false, tone: "neutral" },
} as const satisfies Record<TPpmCanvasSemanticRelationType, TPpmEdgeStyle>;

// R16: existing relation labels are kept; the panel and the canvas share one map.
export const SEMANTIC_RELATION_LABELS = {
  relates_to: "canvas.semantic_relation_relates_to",
  depends_on: "canvas.semantic_relation_depends_on",
  blocks: "canvas.semantic_relation_blocks",
  explains: "canvas.semantic_relation_explains",
  implements: "canvas.semantic_relation_implements",
  evidence_for: "canvas.semantic_relation_evidence_for",
  contradicts: "canvas.semantic_relation_contradicts",
  derived_from: "canvas.semantic_relation_derived_from",
  result_of: "canvas.semantic_relation_result_of",
} as const satisfies Record<TPpmCanvasSemanticRelationType, TPpmTranslationKey>;

// Chips scale with the camera like cards: below 50 % they are illegible, the line ending still tells the type.
export const SEMANTIC_EDGE_CHIP_MIN_ZOOM = 0.5;

export function shouldShowEdgeChip(segmentLength: number, text: string): boolean {
  return segmentLength >= Math.ceil(text.length * 6.2) + 14 + 16;
}

export type TPpmChipHitTest<TShape> = {
  screenToPage: (point: TPpmPoint) => TPpmPoint;
  getShapesAtPoint: (point: TPpmPoint, options: { hitInside: boolean }) => readonly TShape[];
};

// Chips lie under the cards, and cards have `pointer-events: none` (tldraw hit-tests them), so a chip would catch
// the press meant for a card drawn over it. A chip opens its link only on a primary press that no card covers;
// sections (group/frame containers) are see-through and do not count. Other buttons stay with tldraw.
export function isChipPressForEdge<TShape>(
  editor: TPpmChipHitTest<TShape>,
  event: { button: number; clientX: number; clientY: number },
  isSection: (shape: TShape) => boolean
): boolean {
  if (event.button !== 0) return false;
  const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
  return editor.getShapesAtPoint(point, { hitInside: true }).every((shape) => isSection(shape));
}

export function visibleSemanticEdges(edges: readonly TPpmCanvasSemanticEdge[]): TPpmCanvasSemanticEdge[] {
  return edges.filter((edge) => edge.confirmation_status !== "rejected");
}

export type TPpmSemanticLink = { edge: TPpmCanvasSemanticEdge; direction: "out" | "in"; otherShapeId: string };

export function semanticLinksForShape(edges: readonly TPpmCanvasSemanticEdge[], shapeId: string): TPpmSemanticLink[] {
  return visibleSemanticEdges(edges).flatMap((edge): TPpmSemanticLink[] => {
    if (edge.from_shape_id === shapeId) return [{ edge, direction: "out", otherShapeId: edge.to_shape_id }];
    if (edge.to_shape_id === shapeId) return [{ edge, direction: "in", otherShapeId: edge.from_shape_id }];
    return [];
  });
}

export function sameSemanticEdges(a: readonly TPpmCanvasSemanticEdge[], b: readonly TPpmCanvasSemanticEdge[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (edge, index) =>
        edge.edge_id === b[index].edge_id &&
        edge.updated_at === b[index].updated_at &&
        edge.confirmation_status === b[index].confirmation_status
    )
  );
}
