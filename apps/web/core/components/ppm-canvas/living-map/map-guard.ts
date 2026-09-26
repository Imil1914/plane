/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import type { Editor, TLShapeId } from "tldraw";
import { mapGroupRescueIds, shapeNodeJson } from "./map-model";

// AF2.2 M · RM15 + RM-a (решения контроллера, ревью M1): страж целостности доски — в любом облике (v1, v2,
// минимальный режим). tldraw удаляет группу вместе с потомками, а живые карточки AF2.1 не удаляются (beforeDelete в
// editor.tsx): без переноса они остались бы без родителя — вне страницы и невидимы, но в снимке. Перед удалением
// группы или рамки PPM (рамка спринта, секция карты, обычная секция или рамка) её живые карточки переносятся на
// страницу на тех же местах. Во время «Отменить» история на паузе — перенос не записывается; «Повторить» возвращает
// карточки в секции. Только свои изменения (source "user"): чужие уже перенесены у того, кто удалял.

export type TPpmGroupGuardEditor = Pick<
  Editor,
  | "getAncestorPageId"
  | "getCurrentPageId"
  | "getShape"
  | "getSortedChildIdsForParent"
  | "reparentShapes"
  | "sideEffects"
>;

/** Регистрирует страж у редактора доски; возвращает отмену регистрации. */
export function registerPpmGroupDeleteGuard(editor: TPpmGroupGuardEditor): () => void {
  return editor.sideEffects.registerBeforeDeleteHandler("shape", (shape, source) => {
    if (source !== "user" || shape.type !== "ppm-canvas-node") return;
    const rescue = mapGroupRescueIds(shapeNodeJson(shape), shape.id, (id) =>
      editor.getSortedChildIdsForParent(id as TLShapeId).flatMap((childId) => {
        const child = editor.getShape(childId);
        return child ? [{ id: child.id, node: shapeNodeJson(child), parentId: child.parentId }] : [];
      })
    );
    const page = editor.getAncestorPageId(shape) ?? editor.getCurrentPageId();
    if (rescue.length > 0) editor.reparentShapes(rescue as TLShapeId[], page);
  });
}

/** Блок M editor.tsx: страж — у каждой доски, пока её можно править (effectiveCanEdit); облик не важен. */
export function usePpmGroupDeleteGuard(editor: Editor | undefined, canEdit: boolean): void {
  useEffect(() => {
    if (!editor || !canEdit) return;
    return registerPpmGroupDeleteGuard(editor);
  }, [canEdit, editor]);
}
