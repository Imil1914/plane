import { createContext, memo, useContext, type PointerEvent } from "react";
import { SVGContainer, stopEventPropagation, useEditor, useValue, type TLShape, type TLShapeId } from "tldraw";
import type { TPpmCanvasSemanticEdge, TPpmCanvasSemanticRelationType } from "@ppm/canvas";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import type { TPpmArrowMeaningTarget } from "./canvas-arrow-meaning";
import { buildSemanticEdgeEnd, buildSemanticEdgeGeometry } from "./semantic-edge-geometry";
import {
  SEMANTIC_EDGE_CHIP_MIN_ZOOM,
  SEMANTIC_EDGE_STYLE,
  SEMANTIC_RELATION_LABELS,
  isChipPressForEdge,
  shouldShowEdgeChip,
  visibleSemanticEdges,
} from "./semantic-edge-style";

// ── UXR: раздел «Смысловые связи · N» панели «Доска» (облик v2) ──
/**
 * The section's state lives in the editor, not in the overlay: CanvasControls is rebuilt on autosave and when «Доска»
 * opens, and the section must stay expanded, keep its form open and take the focus once when a command opens it.
 */
export type TPpmSemanticSectionState = {
  open: boolean;
  /** «Связать без стрелки…» is expanded. */
  formOpen: boolean;
  /** Raised by a command, the inspector or a chip; the mounted section focuses its heading once and lowers it. */
  focusRef: { current: boolean };
  /** Changes with every focus request, so a section that is already mounted sees it too. */
  focusTick: number;
  setOpen: (open: boolean) => void;
  setFormOpen: (open: boolean) => void;
  /** The board saved first (the server takes a link only between saved cards); `onWait` — once, if it has to wait. */
  settleSave: (onWait?: () => void) => Promise<boolean>;
};
// ── /UXR ──

export type TPpmSemanticLayerValue = {
  edges: readonly TPpmCanvasSemanticEdge[];
  enabled: boolean;
  onOpenEdge: (edgeId: string) => void;
  // ── UXR: «Смысл» у стрелки (панель над выделением) и раздел панели «Доска» — только облик v2 ──
  /**
   * «Смысл» of the arrow: a type turns it into a semantic link, `undefined` («Просто стрелка») drops the link it became
   * earlier; no handler (v1) — no choice (a reader has no style toolbar at all).
   */
  onSetArrowMeaning?: (target: TPpmArrowMeaningTarget, relation: TPpmCanvasSemanticRelationType | undefined) => void;
  /** This session: arrow id → the link it became (⌘Z brings the arrow back, the link stays; see arrowMeaningLink). */
  arrowLinks?: ReadonlyMap<string, string>;
  section?: TPpmSemanticSectionState;
  // ── /UXR ──
};

export const PpmSemanticEdgesContext = createContext<TPpmSemanticLayerValue>({
  edges: [],
  enabled: false,
  onOpenEdge: () => undefined,
});

// The edge whose chip was clicked. A context of its own: a chip click re-renders only the links list, so the
// overlay (InFrontOfTheCanvas) is not remounted and an open panel keeps its form input and focus.
export const PpmSemanticEdgeFocusContext = createContext<string | undefined>(undefined);

// tldraw `OnTheCanvas` slot: already inside the camera-transformed html layer, so everything is drawn in page
// coordinates and pan/zoom never re-renders React. A module-level component keeps a stable reference, so the
// editor's components memo does not remount it (unlike InFrontOfTheCanvas).
export function PpmSemanticEdgesLayer() {
  const { edges, enabled, onOpenEdge } = useContext(PpmSemanticEdgesContext);
  const editor = useEditor();
  const showChips = useValue("ppm semantic edge chips", () => editor.getZoomLevel() >= SEMANTIC_EDGE_CHIP_MIN_ZOOM, [
    editor,
  ]);
  const selectedIds = useValue("ppm semantic edge selection", () => editor.getSelectedShapeIds(), [editor]);
  if (!enabled) return null;
  const visible = visibleSemanticEdges(edges);
  if (visible.length === 0) return null;
  const selected = new Set<string>(selectedIds);
  return (
    <div className="ppm-semantic-layer" aria-hidden="true">
      {visible.map((edge) => (
        <SemanticEdge
          edge={edge}
          emphasized={selected.has(edge.from_shape_id) || selected.has(edge.to_shape_id)}
          key={edge.edge_id}
          showChip={showChips}
          onOpenEdge={onOpenEdge}
        />
      ))}
    </div>
  );
}

const SemanticEdge = memo(function SemanticEdge({
  edge,
  emphasized,
  onOpenEdge,
  showChip,
}: {
  edge: TPpmCanvasSemanticEdge;
  emphasized: boolean;
  onOpenEdge: (edgeId: string) => void;
  showChip: boolean;
}) {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  // Subscribes only to the page bounds of the two cards: dragging a card recomputes its own edges, nothing else.
  const geometry = useValue(
    `ppm semantic edge ${edge.edge_id}`,
    () => {
      const from = editor.getShapePageBounds(edge.from_shape_id as TLShapeId);
      const to = editor.getShapePageBounds(edge.to_shape_id as TLShapeId);
      return from && to
        ? buildSemanticEdgeGeometry(
            { x: from.x, y: from.y, w: from.w, h: from.h },
            { x: to.x, y: to.y, w: to.w, h: to.h }
          )
        : null;
    },
    [editor, edge.from_shape_id, edge.to_shape_id]
  );
  // Orphaned edge (a card was deleted) or overlapping cards: nothing to draw.
  if (!geometry) return null;
  const style = SEMANTIC_EDGE_STYLE[edge.relation_type];
  const relation = ppmT(SEMANTIC_RELATION_LABELS[edge.relation_type]);
  const chipText =
    edge.confirmation_status === "proposed" ? `${relation} · ${ppmT("canvas.edge_proposed_short")}` : relation;
  const endPath = buildSemanticEdgeEnd(geometry.end, geometry.endDirection, style.end);
  const onChipPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    // A card drawn over the chip owns the press (tldraw selects it); sections are containers and see-through.
    const isSection = (shape: TLShape) => editor.getShapeUtil(shape).canReceiveNewChildrenOfType(shape, shape.type);
    if (!isChipPressForEdge(editor, event, isSection)) return;
    // Otherwise tldraw starts a brush selection under the chip.
    stopEventPropagation(event);
    onOpenEdge(edge.edge_id);
  };
  return (
    <>
      <SVGContainer
        className="ppm-semantic-edge"
        data-confirmation={edge.confirmation_status}
        data-dashed={style.dashed || undefined}
        data-emphasized={emphasized || undefined}
        data-relation={edge.relation_type}
        data-tone={style.tone}
      >
        <path className="ppm-semantic-edge__line" d={geometry.path} />
        {endPath && <path className="ppm-semantic-edge__end" d={endPath} />}
        <circle className="ppm-semantic-edge__port" cx={geometry.start.x} cy={geometry.start.y} r={2.5} />
      </SVGContainer>
      {showChip && shouldShowEdgeChip(geometry.labelSegmentLength, chipText) && (
        <span
          className="ppm-semantic-chip"
          data-confirmation={edge.confirmation_status}
          data-emphasized={emphasized || undefined}
          data-tone={style.tone}
          style={{ left: geometry.label.x, top: geometry.label.y }}
          title={edge.label ? `${chipText}: ${edge.label}` : chipText}
          onPointerDown={onChipPointerDown}
        >
          {chipText}
        </span>
      )}
    </>
  );
});
