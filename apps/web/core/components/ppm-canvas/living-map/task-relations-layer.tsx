/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SquareCheck } from "lucide-react";
import { SVGContainer, useEditor, useValue, type TLShapeId } from "tldraw";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate } from "../canvas-grammar";
import { buildSemanticEdgeEnd, buildSemanticEdgeGeometry } from "../semantic-edge-geometry";
import { SEMANTIC_EDGE_CHIP_MIN_ZOOM, SEMANTIC_EDGE_STYLE, shouldShowEdgeChip } from "../semantic-edge-style";
import { usePpmLivingMap } from "./living-map-context";
import type { TTaskRelationEdge } from "./map-model";
import { TASK_LINK_LABEL_KEYS, TLDRAW_SHAPES_LAYER_SELECTOR } from "./task-relations";

// AF2.2 M2: связи «из Задач». Лист <Tldraw> (точка F) рисует порталом в html-слой фигур tldraw (RM1): там координаты
// страницы и трансформация камеры — пан/зум не перерисовывают React; z-index фигур выше — линии под карточками, как
// смысловые связи. Только чтение: ни доски, ни ppm_semantic_edges не трогает; правка — в «Задачах» (подсказка чипа).
const NO_EDGES: readonly TTaskRelationEdge[] = [];

export function PpmTaskRelationsLayer() {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const { args, relationEdges } = usePpmLivingMap();
  const edges = args.enabled ? (relationEdges ?? NO_EDGES) : NO_EDGES;
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(editor.getContainer().querySelector<HTMLElement>(TLDRAW_SHAPES_LAYER_SELECTOR));
  }, [editor]);
  const showChips = useValue("ppm task relation chips", () => editor.getZoomLevel() >= SEMANTIC_EDGE_CHIP_MIN_ZOOM, [
    editor,
  ]);
  const selectedIds = useValue("ppm task relation selection", () => editor.getSelectedShapeIds(), [editor]);
  if (edges.length === 0) return null;
  const selected = new Set<string>(selectedIds);
  return (
    <>
      <ul aria-label={ppmT("canvas.map.relation_list")} className="ppm-visually-hidden">
        {edges.map((edge) => (
          <li key={edge.id}>
            {fillCanvasTemplate(ppmT("canvas.map.relation_item"), {
              from: edge.fromLabel,
              to: edge.toLabel,
              type: ppmT(TASK_LINK_LABEL_KEYS[edge.kind]),
            })}
          </li>
        ))}
      </ul>
      {host &&
        createPortal(
          <div aria-hidden="true" className="ppm-task-relations-layer">
            {edges.map((edge) => (
              <TaskRelationEdge
                edge={edge}
                emphasized={selected.has(edge.fromShapeId) || selected.has(edge.toShapeId)}
                key={edge.id}
                showChip={showChips}
              />
            ))}
          </div>,
          host
        )}
    </>
  );
}

const TaskRelationEdge = memo(function TaskRelationEdge({
  edge,
  emphasized,
  showChip,
}: {
  edge: TTaskRelationEdge;
  emphasized: boolean;
  showChip: boolean;
}) {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  // Подписка только на границы двух карточек: перетаскивание пересчитывает свои связи, остальное — нет.
  const geometry = useValue(
    `ppm task relation ${edge.id}`,
    () => {
      const from = editor.getShapePageBounds(edge.fromShapeId as TLShapeId);
      const to = editor.getShapePageBounds(edge.toShapeId as TLShapeId);
      return from && to
        ? buildSemanticEdgeGeometry(
            { h: from.h, w: from.w, x: from.x, y: from.y },
            { h: to.h, w: to.w, x: to.x, y: to.y }
          )
        : null;
    },
    [editor, edge.fromShapeId, edge.toShapeId]
  );
  if (!geometry) return null;
  const style = SEMANTIC_EDGE_STYLE[edge.kind];
  const label = ppmT(TASK_LINK_LABEL_KEYS[edge.kind]);
  const source = ppmT("canvas.map.relation_source");
  const endPath = buildSemanticEdgeEnd(geometry.end, geometry.endDirection, style.end);
  return (
    <>
      <SVGContainer
        className="ppm-semantic-edge ppm-task-relation"
        data-emphasized={emphasized || undefined}
        data-origin="tasks"
        data-relation={edge.kind}
        data-tone={style.tone}
      >
        <path className="ppm-semantic-edge__line" d={geometry.path} />
        {endPath && <path className="ppm-semantic-edge__end" d={endPath} />}
        <circle className="ppm-semantic-edge__port" cx={geometry.start.x} cy={geometry.start.y} r={2.5} />
      </SVGContainer>
      {showChip && shouldShowEdgeChip(geometry.labelSegmentLength, `${label} · ${source}`) && (
        <span
          className="ppm-task-relation-chip"
          data-emphasized={emphasized || undefined}
          data-tone={style.tone}
          style={{ left: geometry.label.x, top: geometry.label.y }}
          title={ppmT("canvas.map.relation_hint")}
        >
          {label}
          <span aria-hidden="true" className="ppm-task-relation-chip__divider" />
          <span className="ppm-task-relation-chip__source">
            <SquareCheck aria-hidden="true" />
            {source}
          </span>
        </span>
      )}
    </>
  );
});
