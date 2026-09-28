/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (массовые действия): чистые помощники выделения для use-multiple-select — без React и сторов, чтобы их
// проверяли тесты в среде node.
import type { TEntityDetails } from "./use-multiple-select";

/** Строка списка скрыта (её группа свёрнута) — диапазон и стрелки её пропускают. */
export type TPpmIsEntityHidden = (entity: TEntityDetails) => boolean;

const notHidden: TPpmIsEntityHidden = () => false;

const isSameRow = (a: TEntityDetails, b: TEntityDetails) => a.entityID === b.entityID && a.groupID === b.groupID;

/**
 * Позиция строки по паре «задача + группа»: при группировке по исполнителю, метке или направлению одна задача стоит в
 * нескольких группах, и поиск только по задаче находил бы её первое вхождение.
 */
export function findPpmEntityIndex(entities: readonly TEntityDetails[], entity: TEntityDetails): number {
  return entities.findIndex((candidate) => isSameRow(candidate, entity));
}

/**
 * Shift-клик: строки от опорной (последней выделенной, не включая) до нажатой (включая) — по паре «задача + группа»;
 * строки свёрнутых групп пропускаются. Опорной строки в списке нет (другая страница, перезагрузка) — одна нажатая.
 */
export function getPpmShiftRange(
  entities: readonly TEntityDetails[],
  anchor: TEntityDetails,
  target: TEntityDetails,
  isHidden: TPpmIsEntityHidden = notHidden
): TEntityDetails[] {
  const targetIndex = findPpmEntityIndex(entities, target);
  if (targetIndex === -1) return [];
  const anchorIndex = findPpmEntityIndex(entities, anchor);
  if (anchorIndex === -1 || anchorIndex === targetIndex) return [entities[targetIndex]];
  const range =
    anchorIndex < targetIndex
      ? entities.slice(anchorIndex + 1, targetIndex + 1)
      : entities.slice(targetIndex, anchorIndex);
  return range.filter((entity) => isSameRow(entity, target) || !isHidden(entity));
}

/** Что добавить в выделение: каждая задача один раз (она бывает в нескольких группах) и без уже выделенных. */
export function getPpmEntitiesToAdd(
  entities: readonly TEntityDetails[],
  isSelected: (entityId: string) => boolean
): TEntityDetails[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    if (seen.has(entity.entityID) || isSelected(entity.entityID)) return false;
    seen.add(entity.entityID);
    return true;
  });
}

/** Соседние видимые строки для стрелок: позиция — по паре «задача + группа», свёрнутые группы пропускаются. */
export function getPpmNeighbourEntities(
  entities: readonly TEntityDetails[],
  current: TEntityDetails,
  isHidden: TPpmIsEntityHidden = notHidden
): { previousEntity: TEntityDetails | null; nextEntity: TEntityDetails | null } {
  const index = findPpmEntityIndex(entities, current);
  if (index === -1) return { previousEntity: null, nextEntity: null };
  const nextEntity = entities.slice(index + 1).find((entity) => !isHidden(entity)) ?? null;
  // Веб собирается под ES2022 (без toReversed/findLast) — назад идём циклом.
  let previousEntity: TEntityDetails | null = null;
  for (let position = index - 1; position >= 0 && !previousEntity; position -= 1)
    if (!isHidden(entities[position])) previousEntity = entities[position];
  return { previousEntity, nextEntity };
}

/**
 * Группы списка только с теми задачами, у которых есть флажок (пользователь может их менять): «выбрать всё» в группе и
 * Shift-диапазон не выделяют задачи чужих проектов в «Моих задачах» и видах пространства.
 */
export function getPpmSelectableEntities(
  groups: Readonly<Record<string, readonly string[]>>,
  isSelectable: (entityId: string) => boolean
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(groups).map(([groupId, ids]) => [groupId, ids.filter(isSelectable)]));
}

/** Выделенные задачи, которых больше нет в списке (удалены, отфильтрованы, список перезагружен) — «призраки». */
export function getPpmMissingSelection(selectedIds: readonly string[], entities: readonly TEntityDetails[]): string[] {
  const present = new Set(entities.map((entity) => entity.entityID));
  return selectedIds.filter((id) => !present.has(id));
}

type TKeyTarget = { closest?: (selector: string) => unknown; isContentEditable?: boolean } | null | undefined;

// Поля ввода текста — да; флажки строк и кнопки — нет (с флажка в фокусе Esc снимает выделение, Shift+↓ расширяет).
const PPM_SELECTION_KEY_IGNORED = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="textbox"]',
].join(", ");

/**
 * Клавиши списка (стрелки, Shift+стрелки, Esc) не трогают выделение, когда фокус в поле ввода, редакторе, диалоге или
 * открытом меню: иначе Shift+↓ при выделении текста в описании задачи выделял бы задачи в списке за панелью.
 */
export function isPpmSelectionKeyTargetIgnored(target: unknown): boolean {
  const element = target as TKeyTarget;
  if (!element || typeof element.closest !== "function") return false;
  if (element.isContentEditable) return true;
  return !!element.closest(PPM_SELECTION_KEY_IGNORED);
}
