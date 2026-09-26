/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { PPM_CANVAS_GROUP_MAX_SIZE, PPM_CANVAS_NODE_REGISTRY } from "@ppm/canvas";
import { rectsOverlap } from "../canvas-placement";
import { NO_DIRECTION_KEY, type TMapPlacementRequest } from "./map-model";

// AF2.2 M: раскладка карты спринта — рамка → секции направлений в столбец → карточки сеткой до 4 колонок, без
// наложений и одинаково при одинаковых данных. Секции — в координатах рамки, карточки — в координатах секции
// (дети в tldraw живут в системе координат родителя).
export const MAP_LAYOUT = {
  card: {
    h: PPM_CANVAS_NODE_REGISTRY.work_item_ref.defaultHeight,
    w: PPM_CANVAS_NODE_REGISTRY.work_item_ref.defaultWidth,
  },
  columns: 4,
  frameHeader: 64,
  framePadding: 24,
  gap: 16,
  sectionGap: 24,
  sectionHeader: 48,
  sectionPadding: 16,
} as const;

export const MAP_SECTION_WIDTH =
  MAP_LAYOUT.sectionPadding * 2 + MAP_LAYOUT.columns * MAP_LAYOUT.card.w + (MAP_LAYOUT.columns - 1) * MAP_LAYOUT.gap;
export const MAP_FRAME_WIDTH = MAP_SECTION_WIDTH + MAP_LAYOUT.framePadding * 2;

export type TMapPoint = { x: number; y: number };
export type TMapBox = TMapPoint & { h: number; w: number };
export type TSprintMapLayout = { frame: { h: number; w: number }; sections: (TMapBox & { cells: TMapPoint[] })[] };

export function sectionRows(cardCount: number, columns: number = MAP_LAYOUT.columns): number {
  return Math.max(1, Math.ceil(cardCount / columns));
}

export function sectionHeight(rows: number): number {
  return MAP_LAYOUT.sectionHeader + rows * MAP_LAYOUT.card.h + (rows - 1) * MAP_LAYOUT.gap + MAP_LAYOUT.sectionPadding;
}

export function cellOrigin(index: number, columns: number = MAP_LAYOUT.columns): TMapPoint {
  return {
    x: MAP_LAYOUT.sectionPadding + (index % columns) * (MAP_LAYOUT.card.w + MAP_LAYOUT.gap),
    y: MAP_LAYOUT.sectionHeader + Math.floor(index / columns) * (MAP_LAYOUT.card.h + MAP_LAYOUT.gap),
  };
}

export function layoutSprintMap(cardCounts: readonly number[]): TSprintMapLayout {
  let top: number = MAP_LAYOUT.frameHeader;
  const sections = cardCounts.map((count) => {
    const box = {
      cells: Array.from({ length: count }, (_, index) => cellOrigin(index)),
      h: sectionHeight(sectionRows(count)),
      w: MAP_SECTION_WIDTH,
      x: MAP_LAYOUT.framePadding,
      y: top,
    };
    top += box.h + MAP_LAYOUT.sectionGap;
    return box;
  });
  const bottom = sections.length > 0 ? top - MAP_LAYOUT.sectionGap : MAP_LAYOUT.frameHeader + MAP_LAYOUT.card.h;
  return { frame: { h: bottom + MAP_LAYOUT.framePadding, w: MAP_FRAME_WIDTH }, sections };
}

/** Рамка спринта — узел группы F: выше PPM_CANVAS_GROUP_MAX_SIZE её узел не пройдёт схему (сборка упала бы). */
export const MAP_FRAME_MAX_HEIGHT = PPM_CANVAS_GROUP_MAX_SIZE;

/**
 * Сколько первых секций (по числу карточек в каждой) вмещает рамка не выше MAP_FRAME_MAX_HEIGHT — высота та же, что
 * у layoutSprintMap. Секции столбцом: 60 секций по одной карточке — уже 20 224 (ревью M1, раунд 1).
 */
export function sectionsThatFit(cardCounts: readonly number[]): number {
  let bottom: number = MAP_LAYOUT.frameHeader - MAP_LAYOUT.sectionGap;
  for (const [index, count] of cardCounts.entries()) {
    bottom += MAP_LAYOUT.sectionGap + sectionHeight(sectionRows(count));
    if (bottom + MAP_LAYOUT.framePadding > MAP_FRAME_MAX_HEIGHT) return index;
  }
  return cardCounts.length;
}

// ─────────────── M4 · «Не на карте»: свободная ячейка в секции направления, рост секции, сдвиг ниже ───────────────

export type TMapChildRect = TMapBox & { id: string; type: string };
export type TMapSectionState = TMapChildRect & { children: TMapBox[]; moduleId: string | null; node: string };
/** Карта на доске: секции и прочие дети рамки — в координатах рамки, дети секции — в координатах секции. */
export type TMapState = {
  frame: { h: number; id: string; node: string; w: number };
  others: TMapChildRect[];
  sections: TMapSectionState[];
};
export type TMapPlacementPlan = {
  cards: {
    key: string;
    parent: { id: string; kind: "section" } | { key: string; kind: "new" };
    x: number;
    y: number;
  }[];
  frameHeight: number | null;
  moves: { id: string; type: string; y: number }[];
  newSections: (TMapBox & { key: string; moduleId: string | null; title: string })[];
  sectionHeights: { h: number; id: string; node: string }[];
};

const CELL_LIMIT = 4096;

/** Сколько колонок ячеек вмещает секция (её могли сузить руками), от 1 до 4. */
export function sectionColumns(width: number): number {
  const fit = Math.floor(
    (width - 2 * MAP_LAYOUT.sectionPadding + MAP_LAYOUT.gap) / (MAP_LAYOUT.card.w + MAP_LAYOUT.gap)
  );
  return Math.max(1, Math.min(MAP_LAYOUT.columns, fit));
}

function firstFreeCell(occupied: readonly TMapBox[], columns: number): TMapPoint {
  for (let index = 0; index < CELL_LIMIT; index += 1) {
    const origin = cellOrigin(index, columns);
    const cell = { ...origin, h: MAP_LAYOUT.card.h, w: MAP_LAYOUT.card.w };
    if (!occupied.some((rect) => rectsOverlap(cell, rect, 0))) return origin;
  }
  const bottom = Math.max(MAP_LAYOUT.sectionHeader, ...occupied.map((rect) => rect.y + rect.h + MAP_LAYOUT.gap));
  return { x: MAP_LAYOUT.sectionPadding, y: bottom };
}

export function planMapPlacement(state: TMapState, requests: readonly TMapPlacementRequest[]): TMapPlacementPlan {
  const cards: TMapPlacementPlan["cards"] = [];
  const sectionHeights: TMapPlacementPlan["sectionHeights"] = [];
  const growth = new Map<string, number>();
  const bySection = new Map<string, TMapPlacementRequest[]>();
  const missing = new Map<string, TMapPlacementRequest[]>();
  for (const item of requests) {
    const target = state.sections.find((candidate) => candidate.moduleId === item.moduleId);
    const bucket = target ? bySection : missing;
    const key = target ? target.id : (item.moduleId ?? NO_DIRECTION_KEY);
    const list = bucket.get(key) ?? [];
    list.push(item);
    bucket.set(key, list);
  }
  for (const target of state.sections) {
    const list = bySection.get(target.id);
    if (!list) continue;
    const occupied: TMapBox[] = [...target.children];
    const columns = sectionColumns(target.w);
    let needed = target.h;
    for (const item of list) {
      const origin = firstFreeCell(occupied, columns);
      occupied.push({ ...origin, h: MAP_LAYOUT.card.h, w: MAP_LAYOUT.card.w });
      cards.push({ key: item.key, parent: { id: target.id, kind: "section" }, x: origin.x, y: origin.y });
      needed = Math.max(needed, origin.y + MAP_LAYOUT.card.h + MAP_LAYOUT.sectionPadding);
    }
    if (needed > target.h) {
      growth.set(target.id, needed - target.h);
      sectionHeights.push({ h: needed, id: target.id, node: target.node });
    }
  }
  // Всё, что в рамке ниже выросшей секции, едет вниз на её прирост — наложений нет.
  const moves: TMapPlacementPlan["moves"] = [];
  let bottom: number = MAP_LAYOUT.frameHeader - MAP_LAYOUT.sectionGap;
  for (const child of [...state.sections, ...state.others]) {
    let shift = 0;
    for (const target of state.sections)
      if (target.id !== child.id && target.y + target.h <= child.y) shift += growth.get(target.id) ?? 0;
    if (shift > 0) moves.push({ id: child.id, type: child.type, y: child.y + shift });
    bottom = Math.max(bottom, child.y + shift + child.h + (growth.get(child.id) ?? 0));
  }
  // Нет секции направления — новая внизу рамки, во всю её нынешнюю ширину без полей (рамку могли сузить или расширить
  // руками — ревью M4), но не уже одной карточки с полями секции; колонок — сколько вмещает эта ширина.
  const newWidth = Math.max(
    MAP_LAYOUT.card.w + 2 * MAP_LAYOUT.sectionPadding,
    state.frame.w - 2 * MAP_LAYOUT.framePadding
  );
  const newColumns = sectionColumns(newWidth);
  const newSections: TMapPlacementPlan["newSections"] = [];
  for (const [key, list] of missing) {
    const y = bottom + MAP_LAYOUT.sectionGap;
    const h = sectionHeight(sectionRows(list.length, newColumns));
    newSections.push({
      h,
      key,
      moduleId: list[0].moduleId,
      title: list[0].sectionTitle,
      w: newWidth,
      x: MAP_LAYOUT.framePadding,
      y,
    });
    list.forEach((item, index) => {
      const origin = cellOrigin(index, newColumns);
      cards.push({ key: item.key, parent: { key, kind: "new" }, x: origin.x, y: origin.y });
    });
    bottom = y + h;
  }
  const neededFrame = bottom + MAP_LAYOUT.framePadding;
  return { cards, frameHeight: neededFrame > state.frame.h ? neededFrame : null, moves, newSections, sectionHeights };
}

/**
 * Рамка и секции после раскладки из лотка не выше предела группы F (ревью M1): выше их узлы не прошли бы схему, а
 * фигура разошлась бы с узлом. Не помещается — лоток ничего не кладёт («На карте нет места»).
 */
export function mapPlacementFits(plan: TMapPlacementPlan): boolean {
  return [
    plan.frameHeight ?? 0,
    ...plan.sectionHeights.map((item) => item.h),
    ...plan.newSections.map((item) => item.h),
  ].every((height) => height <= MAP_FRAME_MAX_HEIGHT);
}
