/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmTranslationKey } from "@ppm/brand";
import type { TLivingMapCard, TMapIssue, TTaskLinkKind, TTaskRelationEdge } from "./map-model";

// AF2.2 M2: связи Plane «из Задач» между живыми карточками. Производные: считаются из данных Plane при открытии доски и
// обновлении, в снимок доски и в ppm_semantic_edges не пишутся; правятся только в «Задачах».
// Строка IssueRelation (issue = A, related_issue = B, T) читается «A T B» (app/views/issue/relation.py:42-105):
// blocked_by — B блокирует A; start_before / finish_before — A раньше B, значит B зависит от A; implemented_by — B
// реализует A. Линия идёт от B к A; relates_to — без направления (одна линия на пару); duplicate — не рисуется.
// В expand=issue_relation приходят только прямые стороны — обратные (blocking, start_after…) не нужны.
export const PLANE_RELATION_LINKS: Readonly<Record<string, TTaskLinkKind>> = {
  blocked_by: "blocks",
  finish_before: "depends_on",
  implemented_by: "implements",
  relates_to: "relates_to",
  start_before: "depends_on",
};

export const TASK_LINK_LABEL_KEYS = {
  blocks: "canvas.map.relation_blocks",
  depends_on: "canvas.map.relation_depends_on",
  implements: "canvas.map.relation_implements",
  relates_to: "canvas.map.relation_relates_to",
} as const satisfies Record<TTaskLinkKind, TPpmTranslationKey>;

/** html-слой фигур tldraw (DefaultCanvas): камера двигает его сама, дочерние элементы — в координатах страницы. */
export const TLDRAW_SHAPES_LAYER_SELECTOR = ".tl-html-layer.tl-shapes";

export function planeRelationLink(relationType: string): TTaskLinkKind | null {
  return Object.hasOwn(PLANE_RELATION_LINKS, relationType) ? PLANE_RELATION_LINKS[relationType] : null;
}

export type TBoardTaskCard = { identifier: string | null; shapeId: string; workItemId: string };

export function taskCards(cards: readonly TLivingMapCard[]): TBoardTaskCard[] {
  return cards.flatMap((card) =>
    card.binding.entity_type === "work_item"
      ? [
          {
            identifier: card.binding.source.identity.identifier,
            shapeId: card.shapeId,
            workItemId: card.binding.entity_id,
          },
        ]
      : []
  );
}

/** Линии между задачами, которые обе лежат на доске; задача на доске дважды — через карточку с меньшим id. */
export function collectTaskRelations(
  issues: Iterable<TMapIssue>,
  cards: readonly TBoardTaskCard[]
): TTaskRelationEdge[] {
  const byWorkItem = new Map<string, TBoardTaskCard>();
  for (const item of cards) {
    const known = byWorkItem.get(item.workItemId);
    if (!known || item.shapeId < known.shapeId) byWorkItem.set(item.workItemId, item);
  }
  const edges = new Map<string, TTaskRelationEdge>();
  for (const item of issues) {
    const owner = byWorkItem.get(item.id);
    if (!owner) continue;
    for (const row of item.issue_relation) {
      const kind = planeRelationLink(row.relation_type);
      const related = kind ? byWorkItem.get(row.id) : undefined;
      if (!kind || !related || related.shapeId === owner.shapeId) continue;
      const [from, to] =
        kind === "relates_to" && owner.workItemId < related.workItemId ? [owner, related] : [related, owner];
      const id = `${kind}:${from.workItemId}:${to.workItemId}`;
      if (!edges.has(id))
        edges.set(id, {
          fromLabel: from.identifier ?? "",
          fromShapeId: from.shapeId,
          id,
          kind,
          toLabel: to.identifier ?? "",
          toShapeId: to.shapeId,
        });
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- a fresh array from the map (lib ES2022: no toSorted).
  return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
}
