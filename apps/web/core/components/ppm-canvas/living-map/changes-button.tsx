/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo, useEffect, useRef } from "react";
import { History } from "lucide-react";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate, usePpmCanvasGrammarV2 } from "../canvas-grammar";
import { formatChangesCount } from "./changes-format";
import { usePpmLivingMap } from "./living-map-context";

// AF2.2 C1 · кнопка «Что изменилось · N» в правой колонке (.ppm-living-map-aside__bar, F). Видна под v2, пока панель
// закрыта и сервер отдаёт ленту; N — непросмотренное с личной отметки. Читателю — так же (отметка личная, S3).
// memo: CanvasControls перерисовывается на каждое изменение фигур (перетаскивание), кнопке это не нужно.
export const PpmChangesButton = memo(function PpmChangesButton() {
  const grammarV2 = usePpmCanvasGrammarV2();
  const { changes } = usePpmLivingMap();
  const ppmT = usePpmTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panel = changes.panel;
  const visible = Boolean(grammarV2 && panel && !panel.open && panel.status !== "unavailable");
  useEffect(() => {
    if (visible && panel?.consumeFocus("button")) buttonRef.current?.focus();
  }, [panel, visible]);
  if (!visible || !panel) return null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className="ppm-living-map-pill ppm-changes-button"
      data-unseen={changes.count > 0 || undefined}
      onClick={() => panel.setOpen(true)}
    >
      <History aria-hidden="true" />
      <span>
        {changes.count > 0
          ? fillCanvasTemplate(ppmT("canvas.changes.button_count"), {
              count: formatChangesCount(changes.count, panel.unseenTruncated),
            })
          : ppmT("canvas.changes.button")}
      </span>
    </button>
  );
});
