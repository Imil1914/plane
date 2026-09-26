/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmCanvasGrammarV2 } from "../canvas-grammar";
import type { TPpmCanvasShape } from "../shape";
import { changeMarkForShape, workItemIdOfNode } from "./changes-model";
import { usePpmLivingMap } from "./living-map-context";

// AF2.2 C2 · метка «изменено» / «добавлено» над верхней рамкой карточки (K5), пока у пользователя есть непросмотренные
// изменения с личной отметки; после «Отметить просмотренным» индекс пуст — меток нет. Рисуется рядом с HTMLContainer
// карточки, а не внутри (у карточки overflow: hidden). Читает только контекст живой карты — без useValue/useEditor,
// поэтому камера её не перерисовывает; узел разбирается один раз на изменение props.node.
export function PpmChangeChip({ shape }: { shape: TPpmCanvasShape }) {
  const grammarV2 = usePpmCanvasGrammarV2();
  const { changes } = usePpmLivingMap();
  const ppmT = usePpmTranslation();
  const workItemId = useMemo(() => workItemIdOfNode(shape.props.node), [shape.props.node]);
  const mark = grammarV2 ? changeMarkForShape(changes, shape.id, workItemId) : undefined;
  if (!mark) return null;
  return (
    <span className="ppm-change-chip" data-mark={mark}>
      <span aria-hidden="true" className="ppm-change-chip__dot" />
      {ppmT(mark === "added" ? "canvas.changes.chip_added" : "canvas.changes.chip_changed")}
    </span>
  );
}
