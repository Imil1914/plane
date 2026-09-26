/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo, useId, useState } from "react";
import { ChevronDown, ChevronUp, GitPullRequest, Inbox, LayoutGrid, Plus, SquareCheck } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate, formatDueDate } from "../canvas-grammar";
import { usePpmLivingMap } from "./living-map-context";
import { dateOnly, type TNotOnMapItem, type TPlaceOnMapResult } from "./map-model";
import {
  isPlaceableTrayItem,
  readTrayExpanded,
  trayPlacementNotice,
  trayStorageKey,
  writeTrayExpanded,
} from "./not-on-map";

// AF2.2 M4: лоток «Не на карте · N» (K5) под кнопками правой колонки, только на доске с рамкой спринта. Сам ничего не
// добавляет: «+ Добавить» и «Разложить всё» — у редактора (args.canEdit); читатель видит список без кнопок. Лоток живёт в
// CanvasControls (оверлей пересоздаётся при смене memo) — «развёрнут» помним по доске вне компонента (not-on-map.ts).
// Пока список развёрнут, инспектор скрыт (RM-b, правило в living-map.css); ручной PR без объекта Git виден, но не
// кладётся (RM-c). Ревью M4, раунд 1: лоток открывается свёрнутым — на карте по умолчанию виден инспектор.
// memo (итоговое ревью, M-2): CanvasControls перерисовывается на каждое изменение фигур (кадр перетаскивания), а у лотка
// нет пропсов — развёрнутый список перерисовывается только от контекста карты, как кнопка и панель C.
function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const PpmNotOnMapTray = memo(function PpmNotOnMapTray() {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const { args, placeFromTray, placing = false, tray } = usePpmLivingMap();
  const storageKey = trayStorageKey(args.authorId, args.boardId);
  const [expanded, setExpanded] = useState(() => readTrayExpanded(browserStorage(), storageKey));
  const placeAllHintId = useId();
  if (!args.enabled || !tray?.enabled || tray.items.length === 0) return null;
  const count = tray.items.length;
  const canPlace = args.canEdit && Boolean(placeFromTray);
  const placeable = tray.items.filter(isPlaceableTrayItem).length;
  const built = dateOnly(tray.builtAt);
  const notice = (result: TPlaceOnMapResult) => {
    const { key, values } = trayPlacementNotice(result);
    return fillCanvasTemplate(ppmT(key), values);
  };
  const place = async (keys: readonly string[]) => {
    if (!placeFromTray) return;
    try {
      const result = await placeFromTray(keys, ppmT("canvas.map.section_no_direction"));
      if (result) args.notify?.(notice(result));
    } catch {
      args.notify?.(ppmT("canvas.tray.place_error"));
    }
  };
  const toggle = () => {
    writeTrayExpanded(browserStorage(), storageKey, !expanded);
    setExpanded(!expanded);
  };
  return (
    <section
      aria-label={fillCanvasTemplate(ppmT("canvas.tray.label"), { count })}
      className="ppm-living-map-panel ppm-not-on-map"
    >
      <header className="ppm-not-on-map__header">
        <Inbox aria-hidden="true" />
        <h2 className="ppm-not-on-map__title">
          {ppmT("canvas.tray.title")}
          <span className="ppm-not-on-map__count">· {count}</span>
        </h2>
        {canPlace && (
          <button
            type="button"
            className="ppm-not-on-map__all"
            aria-busy={placing || undefined}
            // Класть нечего (остались ручные ссылки RM-c): кнопка в порядке Tab, объяснение — строкой под шапкой.
            aria-describedby={placeable === 0 ? placeAllHintId : undefined}
            aria-disabled={placeable === 0 || undefined}
            disabled={placing}
            title={placeable === 0 ? ppmT("canvas.tray.place_all_unavailable") : undefined}
            onClick={placeable === 0 ? undefined : () => void place(tray.items.map((item) => item.key))}
          >
            <LayoutGrid aria-hidden="true" />
            {ppmT("canvas.tray.place_all")}
          </button>
        )}
        <button
          type="button"
          className="ppm-not-on-map__toggle"
          aria-expanded={expanded}
          aria-label={ppmT(expanded ? "canvas.tray.collapse" : "canvas.tray.expand")}
          title={ppmT(expanded ? "canvas.tray.collapse" : "canvas.tray.expand")}
          onClick={toggle}
        >
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      </header>
      {canPlace && placeable === 0 && (
        <p className="ppm-not-on-map__subtitle" id={placeAllHintId}>
          {ppmT("canvas.tray.place_all_unavailable")}
        </p>
      )}
      {expanded && built && (
        <p className="ppm-not-on-map__subtitle">
          {fillCanvasTemplate(ppmT("canvas.tray.built"), { date: formatDueDate(built, currentLocale) })}
        </p>
      )}
      {expanded && !args.canEdit && <p className="ppm-not-on-map__subtitle">{ppmT("canvas.tray.readonly")}</p>}
      {expanded && (
        <ul className="ppm-not-on-map__list">
          {tray.items.map((item) => (
            <TrayItem
              canPlace={canPlace}
              item={item}
              key={item.key}
              placing={placing}
              onPlace={() => void place([item.key])}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

function TrayItem({
  canPlace,
  item,
  onPlace,
  placing,
}: {
  canPlace: boolean;
  item: TNotOnMapItem;
  onPlace: () => void;
  placing: boolean;
}) {
  const ppmT = usePpmTranslation();
  const hintId = useId();
  // RM-c: ручная ссылка на PR без объекта Git — «+ Добавить» недоступно, подсказка объясняет почему.
  const hint = isPlaceableTrayItem(item) ? null : ppmT("canvas.tray.pr_no_git_object");
  const direction = item.moduleName ?? ppmT("canvas.map.section_no_direction");
  const label =
    item.kind === "task"
      ? item.identifier
      : item.ref
        ? fillCanvasTemplate(ppmT("canvas.tray.pr"), { ref: item.ref })
        : ppmT("canvas.tray.pr_no_ref");
  const context =
    item.kind === "task" ? direction : fillCanvasTemplate(ppmT("canvas.tray.pr_for"), { id: item.workItemIdentifier });
  const meta =
    item.kind === "task"
      ? `${item.stateName ?? ppmT("canvas.tray.no_state")} · ${item.assignees || ppmT("canvas.unassigned")}`
      : `${item.repositoryName} · ${direction}`;
  return (
    <li className="ppm-not-on-map__item">
      <div className="ppm-not-on-map__row">
        {item.kind === "task" ? <SquareCheck aria-hidden="true" /> : <GitPullRequest aria-hidden="true" />}
        <span className="ppm-not-on-map__id">{label}</span>
        <span aria-hidden="true">·</span>
        <span className="ppm-not-on-map__module">{context}</span>
        {canPlace && (
          <button
            type="button"
            className="ppm-not-on-map__add"
            aria-label={fillCanvasTemplate(ppmT("canvas.tray.place_label"), { name: label })}
            aria-describedby={hint ? hintId : undefined}
            // RM-c (ревью M4): не native disabled — кнопка в порядке Tab с подсказкой, щелчок ничего не делает.
            aria-disabled={hint ? true : undefined}
            disabled={placing}
            title={hint ?? undefined}
            onClick={hint ? undefined : onPlace}
          >
            <Plus aria-hidden="true" />
            {ppmT("canvas.tray.place")}
          </button>
        )}
      </div>
      <div className="ppm-not-on-map__item-title">{item.title}</div>
      <div className="ppm-not-on-map__meta">{meta}</div>
      {canPlace && hint && (
        <div className="ppm-not-on-map__hint" id={hintId}>
          {hint}
        </div>
      )}
    </li>
  );
}
