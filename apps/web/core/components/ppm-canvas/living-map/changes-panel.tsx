/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo, useEffect, useId, useMemo, useRef } from "react";
import {
  CalendarClock,
  Check,
  CircleDot,
  FileText,
  Flag,
  GitMerge,
  GitPullRequest,
  History,
  Link2,
  PenLine,
  SquarePen,
  SquarePlus,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEditor, useValue, type TLShapeId } from "tldraw";
import { useTranslation } from "@plane/i18n";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import type { TPpmBoardChange } from "@/services/ppm-canvas-changes.service";
import { fillCanvasTemplate, usePpmCanvasGrammarV2 } from "../canvas-grammar";
import {
  describeBoardChange,
  formatChangesCount,
  formatChangesSince,
  nodeKindKeyForShapes,
  nodeTitleForShapes,
  type TChangeIcon,
} from "./changes-format";
import {
  changesDateBounds,
  clampChangesDate,
  focusChangeShapes,
  presentShapeKey,
  type TChangesMode,
} from "./changes-model";
import { usePpmLivingMap } from "./living-map-context";

const CHANGE_ICONS: Record<TChangeIcon, LucideIcon> = {
  added: SquarePlus,
  assignee: UserRound,
  changed: SquarePen,
  due: CalendarClock,
  file: FileText,
  name: PenLine,
  pr_merged: GitMerge,
  pr_opened: GitPullRequest,
  priority: Flag,
  relation: Link2,
  state: CircleDot,
};

const NO_ENTRIES: readonly TPpmBoardChange[] = [];

// AF2.2 C1 · панель «Что изменилось с {дата} · N» (K5) под кнопками правой колонки: период, лента (значок, текст, кто,
// когда), щелчок — выделить карточку и подвести камеру (масштаб прежний; карточка на другом листе — сначала лист), внизу
// «Отметить просмотренным» (S3 PUT — только по нажатию). memo: CanvasControls перерисовывается на каждое изменение
// фигур, а до 200 строк ленты не должны пересобираться на каждый кадр перетаскивания.
export const PpmChangesPanel = memo(function PpmChangesPanel() {
  const grammarV2 = usePpmCanvasGrammarV2();
  const { args, changes } = usePpmLivingMap();
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panel = changes.panel;
  const open = Boolean(grammarV2 && panel?.open && panel.status !== "unavailable");
  const setOpen = panel?.setOpen;
  const entries = panel?.entries ?? NO_ENTRIES;
  // Какие карточки ленты есть на доске (на любом листе) — одной строкой: перетаскивание панель не перерисовывает.
  const presentKey = useValue(
    "ppm changes present shapes",
    () => (open ? presentShapeKey(entries, (shapeId) => Boolean(editor.getShape(shapeId as TLShapeId))) : ""),
    [editor, entries, open]
  );
  const present = useMemo(() => new Set(presentKey ? presentKey.split("\n") : []), [presentKey]);
  useEffect(() => {
    if (open && panel?.consumeFocus("panel")) closeRef.current?.focus();
  }, [open, panel]);
  // Escape — родным слушателем на самой панели: tldraw слушает keydown на .tl-container (предок панели), а React
  // получает событие только в корне, уже после tldraw — и Esc ещё снимал бы выделение (editor.cancel) и «залипал» бы
  // в editor.inputs.keys. Здесь событие до контейнера не доходит.
  useEffect(() => {
    const section = sectionRef.current;
    if (!open || !section || !setOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
    };
    section.addEventListener("keydown", onKeyDown);
    return () => section.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);
  if (!open || !panel) return null;

  const now = Date.now();
  const bounds = changesDateBounds(now);
  const loading = panel.status === "idle" || panel.status === "loading";
  const failed = panel.status === "error";
  const close = () => panel.setOpen(false);
  const errorLine = (
    <p className="ppm-changes-panel__state" data-error="">
      {ppmT("canvas.changes.error")}
      <button type="button" onClick={panel.retry}>
        {ppmT("canvas.changes.retry")}
      </button>
    </p>
  );

  return (
    <section ref={sectionRef} className="ppm-living-map-panel ppm-changes-panel" aria-labelledby={titleId}>
      <header className="ppm-changes-panel__header">
        <History aria-hidden="true" />
        <h2 id={titleId} className="ppm-changes-panel__title">
          {panel.since
            ? fillCanvasTemplate(ppmT("canvas.changes.title"), {
                date: formatChangesSince(panel.since, currentLocale, now),
              })
            : ppmT("canvas.changes.button")}
        </h2>
        {!loading && !failed && (
          <span className="ppm-changes-panel__count">· {formatChangesCount(entries.length, panel.truncated)}</span>
        )}
        <button ref={closeRef} type="button" aria-label={ppmT("canvas.close")} onClick={close}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="ppm-changes-panel__period">
        <select
          aria-label={ppmT("canvas.changes.period")}
          value={panel.mode}
          onChange={(event) => panel.setMode(event.currentTarget.value as TChangesMode)}
        >
          <option value="last_seen">{ppmT("canvas.changes.mode_last_seen")}</option>
          {panel.sprintAvailable && <option value="sprint">{ppmT("canvas.changes.mode_sprint")}</option>}
          <option value="date">{ppmT("canvas.changes.mode_date")}</option>
        </select>
        {panel.mode === "date" && (
          <input
            type="date"
            aria-label={ppmT("canvas.changes.date")}
            max={bounds.max}
            min={bounds.min}
            value={panel.customDate}
            // min/max ввод не ограничивают: в ленту дата уходит прижатой к окну, а поле показывает её, когда из него уйти.
            onBlur={(event) => panel.setCustomDate(clampChangesDate(event.currentTarget.value, Date.now()))}
            onChange={(event) => panel.setCustomDate(event.currentTarget.value)}
          />
        )}
      </div>
      {loading ? (
        <p className="ppm-changes-panel__state" role="status">
          {ppmT("canvas.changes.loading")}
        </p>
      ) : failed && entries.length === 0 ? (
        errorLine
      ) : entries.length === 0 ? (
        <p className="ppm-changes-panel__state">{ppmT("canvas.changes.empty")}</p>
      ) : (
        <ul className="ppm-changes-panel__list">
          {entries.map((entry) => {
            const view = describeBoardChange(entry, {
              currentUserId: panel.currentUserId,
              locale: currentLocale,
              nodeKindKey: (shapeIds) => nodeKindKeyForShapes(editor, shapeIds),
              // L-1: живые карточки — по привязкам доски (задача «228-4 · название», файл — имя).
              nodeTitle: (shapeIds) => nodeTitleForShapes(args.bindingsByShapeId, shapeIds),
              now,
              t: ppmT,
            });
            const Icon = CHANGE_ICONS[view.icon];
            const body = (
              <>
                <Icon aria-hidden="true" className="ppm-changes-panel__icon" />
                <span className="ppm-changes-panel__text">{view.text}</span>
                <span className="ppm-changes-panel__meta">{view.detail}</span>
              </>
            );
            return (
              <li key={entry.id}>
                {entry.shape_ids.some((shapeId) => present.has(shapeId)) ? (
                  <button
                    type="button"
                    className="ppm-changes-panel__item"
                    data-kind={view.icon}
                    title={ppmT("canvas.changes.show_on_board")}
                    onClick={() => focusChangeShapes(editor, entry.shape_ids)}
                  >
                    {body}
                  </button>
                ) : (
                  <div
                    className="ppm-changes-panel__item"
                    data-kind={view.icon}
                    data-static=""
                    title={ppmT("canvas.changes.not_on_board")}
                  >
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {failed && entries.length > 0 && errorLine}
      {panel.truncated && !loading && <p className="ppm-changes-panel__note">{ppmT("canvas.changes.truncated")}</p>}
      <footer className="ppm-changes-panel__footer">
        <button type="button" className="ppm-changes-panel__seen" disabled={panel.marking} onClick={panel.markSeen}>
          <Check aria-hidden="true" />
          {ppmT(panel.marking ? "canvas.changes.mark_seen_busy" : "canvas.changes.mark_seen")}
        </button>
        {panel.markError && <p role="alert">{ppmT("canvas.changes.mark_seen_error")}</p>}
      </footer>
    </section>
  );
});
