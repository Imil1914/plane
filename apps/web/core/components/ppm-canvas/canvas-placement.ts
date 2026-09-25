/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// canvas-placement.ts — AF2.1 B: «рядом с карточкой без наложения» (заметка → задача/документ, чек-лист → задачи).
export type TPlacementRect = { h: number; w: number; x: number; y: number };

export function rectsOverlap(a: TPlacementRect, b: TPlacementRect, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** Справа (шагами вниз), под, слева, над; если всё занято — в столбце справа, ниже его нижней карточки. */
export function findSpotBeside(
  anchor: TPlacementRect,
  size: { h: number; w: number },
  occupied: readonly TPlacementRect[],
  gap = 24
): { x: number; y: number } {
  const candidates: { x: number; y: number }[] = [];
  for (let step = 0; step < 6; step += 1)
    candidates.push({ x: anchor.x + anchor.w + gap, y: anchor.y + step * (size.h + gap) });
  candidates.push({ x: anchor.x, y: anchor.y + anchor.h + gap });
  candidates.push({ x: anchor.x - size.w - gap, y: anchor.y });
  candidates.push({ x: anchor.x, y: anchor.y - size.h - gap });
  const free = candidates.find((point) => !occupied.some((rect) => rectsOverlap({ ...point, ...size }, rect, gap)));
  if (free) return free;
  // Только столбец справа от якоря (то же условие, что и в rectsOverlap по оси x), а не вся доска: иначе
  // карточка уезжает под самую нижнюю фигуру доски, далеко от заметки.
  const x = anchor.x + anchor.w + gap;
  const column = occupied.filter((rect) => x < rect.x + rect.w + gap && x + size.w + gap > rect.x);
  const bottom = Math.max(anchor.y + anchor.h, ...column.map((rect) => rect.y + rect.h));
  return { x, y: bottom + gap };
}

/** Карточка целиком в прямоугольнике (видимой области холста): иначе камеру подводят к ней. */
export function rectInside(inner: TPlacementRect, outer: TPlacementRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Прокрутится ли содержимое по одной оси на delta: колесо над прокручиваемой заметкой листает её, а не холст. */
export function canScrollBy(position: number, visible: number, total: number, delta: number): boolean {
  if (delta < 0) return position > 0;
  if (delta > 0) return position + visible < total - 1;
  return false;
}

// «Сделать задачей/документом»: источник, созданный прошлой попыткой, но не положенный на холст (привязка или фигура
// не удались), помнится до конца сессии по фигуре заметки — повтор только привязывает его, второй раз не создаёт.
export type TNoteSourceKind = "document" | "task";
export type TUnplacedNoteSource = { entityId: string; label: string };

export function unplacedSourceKey(anchorId: string, kind: TNoteSourceKind): string {
  return `${kind}:${anchorId}`;
}

export function noteSourceStep(
  unplaced: ReadonlyMap<string, TUnplacedNoteSource>,
  anchorId: string,
  kind: TNoteSourceKind
): { step: "create" } | ({ step: "bind" } & TUnplacedNoteSource) {
  const source = unplaced.get(unplacedSourceKey(anchorId, kind));
  return source ? { step: "bind", ...source } : { step: "create" };
}

// ── B5: «Доска задач» (канбан волны 1) ──

/** Свой тип перетаскивания карточки задачи между колонками: колонки берут только его, файлы идут на холст мимо. */
export const PPM_WORK_ITEM_DRAG_TYPE = "application/x-ppm-work-item";

export function isWorkItemDrag(types: readonly string[]): boolean {
  return types.includes(PPM_WORK_ITEM_DRAG_TYPE);
}

/** Доска, которую прежний эффект ужал до 360×160 (≤ 420×220): канбан не помещается, «Развернуть доску» — первой в шапке. */
export function isShrunkWorkItemsView(size: { h: number; w: number }): boolean {
  return size.w <= 420 && size.h <= 220;
}
