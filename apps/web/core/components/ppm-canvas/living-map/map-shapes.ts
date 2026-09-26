/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Box, type Editor, type TLParentId, type TLShapeId, type TLShapePartial } from "tldraw";
import {
  createPpmGitRefNode,
  createPpmMapSectionNode,
  createPpmSprintFrameNode,
  createPpmWorkItemRefNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasBinding,
  type TPpmCanvasNode,
} from "@ppm/canvas";
import { rectInside } from "../canvas-placement";
import { isCountedCanvasShape } from "../canvas-toolkit-model";
import type { TPpmCanvasShape } from "../shape";
import { layoutSprintMap, type TMapPlacementPlan, type TMapPoint, type TMapState } from "./map-layout";
import { readMapRole, shapeNodeJson } from "./map-model";

// AF2.2 M: фигуры «Живой карты» и одно изменение доски. shape.tsx's PPM_CANVAS_SHAPE_TYPE — проверенным литералом
// (как canvas-toolkit-actions.ts): импорт shape.tsx потянул бы в тесты node все карточки.
const PPM_CANVAS_SHAPE_TYPE = "ppm-canvas-node" satisfies TPpmCanvasShape["type"];

/** Новые фигуры (родители раньше детей), новые размеры карточек PPM и сдвиги любых фигур — одним шагом истории. */
export type TMapShapeChange = {
  create: TLShapePartial<TPpmCanvasShape>[];
  moves: TLShapePartial[];
  update: TLShapePartial<TPpmCanvasShape>[];
};

export function mapCardShape(
  id: string,
  node: TPpmCanvasNode,
  position: TMapPoint,
  parentId?: string
): TLShapePartial<TPpmCanvasShape> {
  return {
    id: id as TLShapeId,
    ...(parentId ? { parentId: parentId as TLParentId } : {}),
    props: { h: node.visual.height, node: serializePpmCanvasNode(node), w: node.visual.width },
    type: PPM_CANVAS_SHAPE_TYPE,
    x: position.x,
    y: position.y,
  };
}

/** Живая карточка привязки: задача — work_item_ref, PR — git_ref; PR без https-ссылки — null (схема узла). */
export function liveCardNode(binding: TPpmCanvasBinding, authorId: string, now: string): TPpmCanvasNode | null {
  if (binding.entity_type === "work_item") {
    return createPpmWorkItemRefNode({
      authorId,
      binding: {
        binding_id: binding.binding_id,
        entity_id: binding.entity_id,
        entity_type: "work_item",
        source_version: binding.source_version,
      },
      now,
    });
  }
  if (binding.entity_type !== "pull_request") return null;
  const { display, identity } = binding.source;
  if (!identity.source_url) return null;
  try {
    return createPpmGitRefNode({
      authorId,
      binding: {
        binding_id: binding.binding_id,
        entity_id: binding.entity_id,
        entity_type: binding.entity_type,
        source_version: binding.source_version,
      },
      canonicalUrl: identity.source_url,
      now,
      objectType: display.object_type,
      provider: display.provider,
      repositoryName: display.repository_name,
      sourceId: binding.entity_id,
      title: display.title,
      workItemKey: display.work_items[0]?.identifier ?? null,
    });
  } catch {
    return null;
  }
}

export type TSprintMapSectionShapes = {
  cards: readonly { binding: TPpmCanvasBinding; shapeId: string }[];
  id: string;
  moduleId: string | null;
  title: string;
};

/** Рамка спринта в (0, 0) новой доски, секции — её дети, карточки — дети секций; привязки — только нарисованных. */
export function buildSprintMapChange(input: {
  authorId: string;
  cycleId: string;
  frameId: string;
  frameTitle: string;
  now: string;
  sections: readonly TSprintMapSectionShapes[];
}): { bindings: TPpmCanvasBinding[]; change: TMapShapeChange } {
  const layout = layoutSprintMap(input.sections.map((section) => section.cards.length));
  const frame = createPpmSprintFrameNode({
    authorId: input.authorId,
    cycleId: input.cycleId,
    height: layout.frame.h,
    now: input.now,
    title: input.frameTitle,
    width: layout.frame.w,
  });
  const create: TLShapePartial<TPpmCanvasShape>[] = [mapCardShape(input.frameId, frame, { x: 0, y: 0 })];
  const bindings: TPpmCanvasBinding[] = [];
  input.sections.forEach((section, index) => {
    const box = layout.sections[index];
    const node = createPpmMapSectionNode({
      authorId: input.authorId,
      height: box.h,
      moduleId: section.moduleId,
      now: input.now,
      title: section.title,
      width: box.w,
    });
    create.push(mapCardShape(section.id, node, box, input.frameId));
    section.cards.forEach((card, cardIndex) => {
      const cardNode = liveCardNode(card.binding, input.authorId, input.now);
      if (!cardNode) return;
      create.push(mapCardShape(card.shapeId, cardNode, box.cells[cardIndex], section.id));
      bindings.push(card.binding);
    });
  });
  return { bindings, change: { create, moves: [], update: [] } };
}

/**
 * Одно изменение доски одним шагом истории (спецификация A). Доска только для чтения или закреплённые (locked) рамка и
 * секции — ничего не меняем: tldraw молча пропустил бы правки закреплённых фигур, а карточки легли бы поверх соседей.
 * Исключение внутри run откатывает tldraw (transact); редактор ничего не создал — шаг откатывается к метке. «Отменить»
 * этот шаг снимает рамку и секции, живые карточки остаются на своих местах (защита AF2.1 и страж RM15). Привязки
 * регистрирует вызывающий.
 */
export function applyMapChange(editor: Editor, change: TMapShapeChange): boolean {
  if (editor.getIsReadonly()) return false;
  const touched = [...change.update, ...change.moves].map((shape) => shape.id as string);
  const parents = change.create.flatMap((shape) => (shape.parentId ? [shape.parentId as string] : []));
  for (const id of [...touched, ...parents]) {
    const shape = editor.getShape(id as TLShapeId);
    if (shape && editor.isShapeOrAncestorLocked(shape)) return false;
  }
  const mark = editor.markHistoryStoppingPoint("ppm living map");
  try {
    editor.run(() => {
      if (change.update.length > 0) editor.updateShapes(change.update);
      if (change.moves.length > 0) editor.updateShapes(change.moves);
      if (change.create.length > 0) editor.createShapes(change.create);
    });
  } catch {
    editor.bailToMark(mark);
    return false;
  }
  if (change.create.every((shape) => editor.getShape(shape.id))) return true;
  editor.bailToMark(mark);
  return false;
}

/** Новая карта: камера по ширине рамки, её верх (спринт и первые секции) — в кадре. */
export function revealSprintMap(editor: Editor, frameId: string): void {
  const bounds = editor.getShapePageBounds(frameId as TLShapeId);
  if (!bounds) return;
  editor.zoomToBounds(new Box(bounds.x, bounds.y, bounds.w, Math.min(bounds.h, Math.round(bounds.w * 0.75))), {
    immediate: true,
    inset: 48,
  });
}

// ─────────────── M4 · «Не на карте»: карта с доски и изменение для лотка ───────────────

export type TMapShapeRecord = {
  h: number;
  id: string;
  node: string | null;
  parentId: string;
  type: string;
  w: number;
  x: number;
  y: number;
};

/** Фигуры страницы, которые занимают место (связи и штрихи — нет): позиция — в системе координат родителя. */
export function readMapRecords(editor: Editor): TMapShapeRecord[] {
  return editor
    .getCurrentPageShapes()
    .filter((shape) => isCountedCanvasShape(shape))
    .map((shape) => {
      const bounds = editor.getShapeGeometry(shape).bounds;
      return {
        h: bounds.h,
        id: shape.id,
        node: shapeNodeJson(shape),
        parentId: shape.parentId,
        type: shape.type,
        w: bounds.w,
        x: shape.x + bounds.x,
        y: shape.y + bounds.y,
      };
    });
}

export function mapStateFromRecords(records: readonly TMapShapeRecord[], frameId: string): TMapState | null {
  const frame = records.find((record) => record.id === frameId);
  if (!frame?.node) return null;
  const byParent = new Map<string, TMapShapeRecord[]>();
  for (const record of records) {
    const list = byParent.get(record.parentId) ?? [];
    list.push(record);
    byParent.set(record.parentId, list);
  }
  const state: TMapState = {
    frame: { h: frame.h, id: frame.id, node: frame.node, w: frame.w },
    others: [],
    sections: [],
  };
  for (const child of byParent.get(frameId) ?? []) {
    const rect = { h: child.h, id: child.id, type: child.type, w: child.w, x: child.x, y: child.y };
    const role = readMapRole(child.node);
    if (role?.map.role === "section" && child.node)
      state.sections.push({
        ...rect,
        children: (byParent.get(child.id) ?? []).map(({ h, w, x, y }) => ({ h, w, x, y })),
        moduleId: role.map.module_id,
        node: child.node,
      });
    else state.others.push(rect);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- state.sections is built here (lib ES2022: no toSorted).
  state.sections.sort((left, right) => left.y - right.y || left.id.localeCompare(right.id));
  return state;
}

/** Новая высота рамки/секции и в узле (visual.height), как onResize; updated_at не трогаем — рост не правка. */
export function withNodeHeight(node: string, height: number): string | null {
  const parsed = parseSerializedPpmCanvasNode(node);
  if (parsed.status !== "valid" && parsed.status !== "migrated") return null;
  return serializePpmCanvasNode({ ...parsed.node, visual: { ...parsed.node.visual, height } });
}

/** План лотка → изменение доски: рост секций и рамки, сдвиги, новые секции, карточки. Без узла карточки — не кладём. */
export function buildPlacementChange(input: {
  authorId: string;
  bindings: ReadonlyMap<string, TPpmCanvasBinding>;
  frameId: string;
  frameNode: string;
  newSectionId: () => string;
  now: string;
  plan: TMapPlacementPlan;
  shapeIds: ReadonlyMap<string, string>;
}): { bindings: TPpmCanvasBinding[]; cardIds: string[]; change: TMapShapeChange } {
  const update: TLShapePartial<TPpmCanvasShape>[] = [];
  for (const grown of input.plan.sectionHeights) {
    const node = withNodeHeight(grown.node, grown.h);
    if (node) update.push({ id: grown.id as TLShapeId, props: { h: grown.h, node }, type: PPM_CANVAS_SHAPE_TYPE });
  }
  if (input.plan.frameHeight !== null) {
    const node = withNodeHeight(input.frameNode, input.plan.frameHeight);
    if (node)
      update.push({
        id: input.frameId as TLShapeId,
        props: { h: input.plan.frameHeight, node },
        type: PPM_CANVAS_SHAPE_TYPE,
      });
  }
  const moves: TLShapePartial[] = input.plan.moves.map((move) => ({
    id: move.id as TLShapeId,
    type: move.type,
    y: move.y,
  }));
  const create: TLShapePartial<TPpmCanvasShape>[] = [];
  const sectionIds = new Map<string, string>();
  for (const created of input.plan.newSections) {
    const id = input.newSectionId();
    sectionIds.set(created.key, id);
    const node = createPpmMapSectionNode({
      authorId: input.authorId,
      height: created.h,
      moduleId: created.moduleId,
      now: input.now,
      title: created.title,
      width: created.w,
    });
    create.push(mapCardShape(id, node, created, input.frameId));
  }
  const bindings: TPpmCanvasBinding[] = [];
  const cardIds: string[] = [];
  for (const placed of input.plan.cards) {
    const binding = input.bindings.get(placed.key);
    const shapeId = input.shapeIds.get(placed.key);
    const parentId = placed.parent.kind === "section" ? placed.parent.id : sectionIds.get(placed.parent.key);
    const node = binding ? liveCardNode(binding, input.authorId, input.now) : null;
    if (!binding || !shapeId || !parentId || !node) continue;
    create.push(mapCardShape(shapeId, node, placed, parentId));
    bindings.push(binding);
    cardIds.push(shapeId);
  }
  return { bindings, cardIds, change: { create, moves, update } };
}

/** После «+ Добавить»: камера плавно подводится к первой новой карточке, если её не видно. Выделения нет (RM11). */
export function revealMapCards(editor: Editor, ids: readonly string[]): void {
  const first = ids[0];
  const bounds = first ? editor.getShapePageBounds(first as TLShapeId) : undefined;
  if (!bounds) return;
  if (!rectInside({ h: bounds.h, w: bounds.w, x: bounds.x, y: bounds.y }, editor.getViewportPageBounds()))
    editor.centerOnPoint(bounds.center, { animation: { duration: 220 } });
}
