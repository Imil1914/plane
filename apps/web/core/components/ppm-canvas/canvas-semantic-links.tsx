// UXR (поток параллельно релизу, 2026-09-26): список смысловых связей переехал из панели-оверлея в панель «Доска»
// (облик v2) — раздел «Смысловые связи · N»: те же строки, удаление, подтверждение и отклонение предложенных; внизу —
// «Связать без стрелки…», раскрывающий нынешнюю форму (путь без мыши). Смысл обычно задают у стрелки (панель над
// выделением, canvas-arrow-meaning.ts). Состояние раздела (развёрнут, форма, запрос фокуса) живёт в редакторе
// (TPpmSemanticSectionState): оверлей CanvasControls пересобирается при автосохранении и открытии «Доски».
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Trash2, X } from "lucide-react";
import type {
  TPpmCanvasBinding,
  TPpmCanvasOwnedNodeKind,
  TPpmCanvasParseResult,
  TPpmCanvasSemanticEdge,
  TPpmCanvasSemanticRelationType,
} from "@ppm/canvas";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { canvasNodeTitle, OWN_NODE_KIND_KEYS } from "./canvas-grammar";
import { SEMANTIC_RELATION_LABELS } from "./semantic-edge-style";
import { PpmSemanticEdgeFocusContext, type TPpmSemanticSectionState } from "./semantic-edges-layer";

type TSemanticCardNode = { parsed: TPpmCanvasParseResult; shape: { id: string } };

export type TPpmSemanticLinksSectionProps = {
  bindingsByShapeId: ReadonlyMap<string, TPpmCanvasBinding>;
  canEdit: boolean;
  edges: readonly TPpmCanvasSemanticEdge[];
  /** Every PPM card of the page — the objects the form offers (the same rule as before). */
  nodes: readonly TSemanticCardNode[];
  onCreate: (
    fromShapeId: string,
    toShapeId: string,
    relationType: TPpmCanvasSemanticRelationType,
    label: string
  ) => Promise<unknown>;
  onDelete: (edgeId: string) => Promise<void>;
  onReview: (edgeId: string, confirmationStatus: "confirmed" | "rejected") => Promise<void>;
  section: TPpmSemanticSectionState;
  selectedShapeIds: readonly string[];
};

type TTranslate = (key: TPpmTranslationKey) => string;

/**
 * A card's name in the list and in the form: a live card by its source («ROBOT-12 · Замер»), an own card by its title
 * or, without one, by its kind («Заметка») — never the tldraw id.
 */
export function semanticCardTitle(
  parsed: TPpmCanvasParseResult,
  binding: TPpmCanvasBinding | undefined,
  ppmT: TTranslate
): string {
  const untitled = ppmT("canvas.untitled");
  if (binding?.entity_type === "work_item")
    return canvasNodeTitle([binding.source.identity.identifier, binding.source.display.title], untitled);
  if (binding) return canvasNodeTitle([binding.source.display.title], untitled);
  if (parsed.status === "unknown") return ppmT("canvas.unknown_node");
  if (parsed.status === "corrupt") return ppmT("canvas.corrupt_node");
  const title = "title" in parsed.node && typeof parsed.node.title === "string" ? parsed.node.title.trim() : "";
  if (title) return title;
  const kind = parsed.node.kind as TPpmCanvasOwnedNodeKind;
  return Object.hasOwn(OWN_NODE_KIND_KEYS, kind) ? ppmT(OWN_NODE_KIND_KEYS[kind]) : untitled;
}

/** Focus fell to the page after the focused button left the DOM (a deleted row, a reviewed proposal). */
function focusWasLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

export function PpmSemanticLinksSection({
  bindingsByShapeId,
  canEdit,
  edges,
  nodes,
  onCreate,
  onDelete,
  onReview,
  section,
  selectedShapeIds,
}: TPpmSemanticLinksSectionProps) {
  const ppmT = usePpmTranslation();
  const formId = useId();
  const rootRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [pending, setPending] = useState(false);
  // The problem to tell: a refused request, or (the form) a board that could not be saved first.
  const [error, setError] = useState<TPpmTranslationKey>();
  const [savingBoard, setSavingBoard] = useState(false);
  const cards = useMemo(
    () =>
      nodes.map(({ parsed, shape }) => ({
        id: shape.id,
        title: semanticCardTitle(parsed, bindingsByShapeId.get(shape.id), ppmT),
      })),
    [bindingsByShapeId, nodes, ppmT]
  );
  const titleOf = (shapeId: string) =>
    cards.find((item) => item.id === shapeId)?.title ?? ppmT("canvas.uxr.card_missing");

  // A chip click highlights its link and scrolls to it (the context — no overlay rebuild, as before).
  const focusedEdgeId = useContext(PpmSemanticEdgeFocusContext);
  const focusedRowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focusedEdgeId && section.open) focusedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusedEdgeId, section.open]);

  // Opened by the palette, the inspector or a chip: the heading takes the focus once — on the next frame, since the
  // command palette first returns the focus to its own trigger. The view goes to the chip's link, if any, else the
  // section itself.
  useEffect(() => {
    if (!section.focusRef.current) return;
    section.focusRef.current = false;
    requestAnimationFrame(() => {
      summaryRef.current?.focus({ preventScroll: true });
      (focusedRowRef.current ?? rootRef.current)?.scrollIntoView({ block: "nearest" });
    });
  }, [section.focusRef, section.focusTick]);

  // The form of the overlay panel, unchanged: two selected cards fill «откуда» and «куда».
  const [relationType, setRelationType] = useState<TPpmCanvasSemanticRelationType>("relates_to");
  const [label, setLabel] = useState("");
  const [fromShapeId, setFromShapeId] = useState("");
  const [toShapeId, setToShapeId] = useState("");
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  useEffect(() => {
    if (selectedShapeIds.length !== 2) return;
    if (!selectedShapeIds.every((id) => cardsRef.current.some((item) => item.id === id))) return;
    setFromShapeId(selectedShapeIds[0]);
    setToShapeId(selectedShapeIds[1]);
  }, [selectedShapeIds]);
  const pair = fromShapeId && toShapeId && fromShapeId !== toShapeId ? [fromShapeId, toShapeId] : [];

  // `action` may name a problem of its own instead of throwing (the board was not saved).
  const run = async (action: () => Promise<TPpmTranslationKey | void>, after?: () => void) => {
    setPending(true);
    setError(undefined);
    try {
      const problem = await action();
      if (problem) setError(problem);
      else after?.();
    } catch {
      setError("canvas.semantic_edges_error");
    } finally {
      setPending(false);
      setSavingBoard(false);
    }
  };
  // The focused button may leave with its row (delete) or with the proposal (review): keep the keyboard in the section.
  const keepFocus = (edgeId?: string) =>
    requestAnimationFrame(() => {
      if (!focusWasLost()) return;
      const row = edgeId
        ? rootRef.current?.querySelector<HTMLElement>(`[data-edge-id="${edgeId}"] .ppm-semantic-links__remove`)
        : undefined;
      (row ?? summaryRef.current)?.focus({ preventScroll: true });
    });
  // Round 1 (I1): the server takes a link only between cards of the saved board — new cards are saved first
  // («Сохраняем доску…» on the button while it waits), as for «Смысл» of an arrow.
  const create = () => {
    const [from, to] = pair;
    if (!from || !to) return;
    void run(
      async () => {
        if (!(await section.settleSave(() => setSavingBoard(true)))) return "canvas.uxr.links_unsaved";
        await onCreate(from, to, relationType, label);
      },
      () => setLabel("")
    );
  };

  return (
    <details
      ref={rootRef}
      className="ppm-semantic-links"
      open={section.open}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        if (open !== section.open) section.setOpen(open);
      }}
    >
      <summary ref={summaryRef}>
        {ppmT("canvas.semantic_edges")} · {edges.length}
      </summary>
      {edges.length === 0 ? (
        <p>{ppmT("canvas.semantic_edges_empty")}</p>
      ) : (
        <ul className="ppm-semantic-links__list">
          {edges.map((edge) => (
            <li
              key={edge.edge_id}
              data-confirmation={edge.confirmation_status}
              data-edge-id={edge.edge_id}
              data-focused={edge.edge_id === focusedEdgeId || undefined}
              ref={edge.edge_id === focusedEdgeId ? focusedRowRef : undefined}
            >
              <span className="ppm-semantic-links__text">
                <strong>{titleOf(edge.from_shape_id)}</strong>
                <small>{ppmT(SEMANTIC_RELATION_LABELS[edge.relation_type])}</small>
                <strong>{titleOf(edge.to_shape_id)}</strong>
                {edge.label && <small>{edge.label}</small>}
                {edge.confirmation_status === "proposed" && <small>{ppmT("canvas.edge_proposed")}</small>}
              </span>
              {canEdit && (
                <div className="ppm-semantic-links__actions">
                  {edge.confirmation_status === "proposed" && (
                    <>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void run(
                            () => onReview(edge.edge_id, "confirmed"),
                            () => keepFocus(edge.edge_id)
                          )
                        }
                      >
                        <Check aria-hidden="true" />
                        {ppmT("canvas.semantic_edges_confirm")}
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void run(
                            () => onReview(edge.edge_id, "rejected"),
                            () => keepFocus(edge.edge_id)
                          )
                        }
                      >
                        <X aria-hidden="true" />
                        {ppmT("canvas.semantic_edges_reject")}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="ppm-semantic-links__remove"
                    disabled={pending}
                    onClick={() =>
                      void run(
                        () => onDelete(edge.edge_id),
                        () => keepFocus()
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    {ppmT("canvas.semantic_edges_remove")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <>
          <p className="ppm-semantic-links__hint">{ppmT("canvas.uxr.links_hint")}</p>
          <button
            type="button"
            className="ppm-semantic-links__toggle"
            aria-controls={section.formOpen ? formId : undefined}
            aria-expanded={section.formOpen}
            onClick={() => section.setFormOpen(!section.formOpen)}
          >
            <ChevronRight aria-hidden="true" />
            {ppmT("canvas.uxr.link_without_arrow")}
          </button>
          {section.formOpen && (
            <div id={formId} className="ppm-semantic-edges__create ppm-semantic-links__form">
              <p>{ppmT("canvas.semantic_edges_select_two")}</p>
              <div className="ppm-semantic-edges__pair">
                <label>
                  <span>{ppmT("canvas.semantic_edges_from")}</span>
                  <select value={fromShapeId} onChange={(event) => setFromShapeId(event.currentTarget.value)}>
                    <option value="">{ppmT("canvas.semantic_edges_choose_object")}</option>
                    {cards.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!fromShapeId && !toShapeId}
                  onClick={() => {
                    setFromShapeId(toShapeId);
                    setToShapeId(fromShapeId);
                  }}
                >
                  {ppmT("canvas.semantic_edges_swap")}
                </button>
                <label>
                  <span>{ppmT("canvas.semantic_edges_to")}</span>
                  <select value={toShapeId} onChange={(event) => setToShapeId(event.currentTarget.value)}>
                    <option value="">{ppmT("canvas.semantic_edges_choose_object")}</option>
                    {cards.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                <span>{ppmT("canvas.semantic_edges_relation")}</span>
                <select
                  value={relationType}
                  onChange={(event) => setRelationType(event.currentTarget.value as TPpmCanvasSemanticRelationType)}
                >
                  {Object.entries(SEMANTIC_RELATION_LABELS).map(([value, translationKey]) => (
                    <option key={value} value={value}>
                      {ppmT(translationKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{ppmT("canvas.semantic_edges_label")}</span>
                <input
                  maxLength={255}
                  placeholder={ppmT("canvas.semantic_edges_label_placeholder")}
                  value={label}
                  onChange={(event) => setLabel(event.currentTarget.value)}
                />
              </label>
              <button type="button" disabled={pair.length !== 2 || pending} onClick={create}>
                {ppmT(savingBoard ? "canvas.uxr.meaning_saving" : "canvas.semantic_edges_create")}
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="ppm-semantic-links__error" role="alert">
          {ppmT(error)}
        </p>
      )}
    </details>
  );
}
