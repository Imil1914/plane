/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmTranslationKey } from "@ppm/brand";
import { fillCanvasTemplate } from "./canvas-grammar";

// canvas-checklist.ts — AF2.1 B6: «Сделать задачами» для отмеченных пунктов, пункт помнит свою задачу.
// Повтор после частичного сбоя не создаёт дублей: задача, созданная для пункта, запоминается (пункт → id задачи),
// и при повторе её только привязывают и кладут на холст; упавшее создание повторяется с теми же client_operation_id
// и shape_id — сервер узнаёт операцию и возвращает уже созданную задачу (idempotent_replay).
export type TChecklistItem = { checked: boolean; id: string; text: string; work_item_id?: string | null };
export type TChecklistItemRef = { id: string; text: string };

/** Не больше задач за одно нажатие (как файлов за одну вставку); остальные — следующим нажатием. */
export const CHECKLIST_CONVERT_MAX = 20;
const TASK_NAME_MAX = 255;
const NOTICE_NAMES_MAX = 3;
const NOTICE_NAME_LENGTH = 40;

export function checklistItemsToConvert<T extends TChecklistItem>(items: readonly T[]): T[] {
  return items.filter((item) => item.checked && item.text.trim() !== "" && !item.work_item_id);
}

/** Ставит пунктам ссылку на задачу; ссылку, которую успел поставить другой редактор, не перезаписывает. */
export function markConvertedItems<T extends TChecklistItem>(
  items: readonly T[],
  converted: Readonly<Record<string, string>>
): T[] {
  return items.map((item) =>
    converted[item.id] && !item.work_item_id ? { ...item, work_item_id: converted[item.id] } : item
  );
}

/** Имя задачи Plane: текст пункта без крайних пробелов, не длиннее 255 символов (эмодзи не разрезается). */
export function checklistTaskName(text: string): string {
  return Array.from(text.trim()).slice(0, TASK_NAME_MAX).join("");
}

type TChecklistTaskAttempt = { name: string; operationId: string; shapeId: string; workItemId?: string };

/** Память попыток на время жизни редактора доски: ключ — `${id фигуры чек-листа}:${id пункта}`. */
export type TChecklistTaskMemory = {
  attempts: Map<string, TChecklistTaskAttempt>;
  inFlight: Set<string>;
};

export function createChecklistTaskMemory(): TChecklistTaskMemory {
  return { attempts: new Map(), inFlight: new Set() };
}

export type TChecklistConversionDeps<TBinding extends { entity_id: string }> = {
  /** Новая привязка уже созданной задачи (новая фигура). */
  bind: (workItemId: string) => Promise<TBinding>;
  /** false — редактор недоступен для правки или чек-лист удалён: дальше не идём. */
  canContinue: () => boolean;
  /** Задача Plane + pending-привязка; те же operationId/shapeId при повторе дают ответ сервера без второй задачи. */
  create: (request: { name: string; operationId: string; shapeId: string }) => Promise<TBinding>;
  /** Ошибка привязки значит «задачи больше нет» (удалена в Plane): забыть её, следующий раз создать заново. */
  isGone: (error: unknown) => boolean;
  /** Карточка этой задачи уже лежит на доске: пункт только связывается, вторая карточка не нужна. */
  isPlaced: (workItemId: string) => boolean;
  newIds: () => { operationId: string; shapeId: string };
  /** Пункт стал задачей и его карточка на холсте: отметить сразу (одним сохранением с карточкой). */
  onConverted: (itemId: string, workItemId: string) => void;
  /** Живая карточка на холсте; при ошибке сама снимает pending-привязку и бросает. */
  place: (binding: TBinding) => Promise<void>;
};

export type TChecklistConversionOutcome = {
  /** id пункта → id задачи: задача есть и её карточка на холсте. */
  converted: Record<string, string>;
  /** Задача не создана. */
  failed: TChecklistItemRef[];
  /** Не дошли: лимит нажатия, пункт уже в работе или редактор стал недоступен. */
  notAttempted: number;
  /** Задача создана, но карточка не легла на холст: повтор только привяжет её. */
  unplaced: TChecklistItemRef[];
};

export async function convertChecklistItemsToTasks<TBinding extends { entity_id: string }>(
  scope: string,
  items: readonly TChecklistItemRef[],
  memory: TChecklistTaskMemory,
  deps: TChecklistConversionDeps<TBinding>
): Promise<TChecklistConversionOutcome> {
  const outcome: TChecklistConversionOutcome = { converted: {}, failed: [], notAttempted: 0, unplaced: [] };
  for (const [index, item] of items.entries()) {
    if (index >= CHECKLIST_CONVERT_MAX || !deps.canContinue()) {
      outcome.notAttempted += items.length - index;
      break;
    }
    const key = `${scope}:${item.id}`;
    const name = checklistTaskName(item.text);
    if (memory.inFlight.has(key) || !name) {
      outcome.notAttempted += 1;
      continue;
    }
    memory.inFlight.add(key);
    try {
      // Последовательно: следующая карточка встаёт под предыдущей (место ищется по уже занятым), а сбой одного
      // пункта не должен оставлять параллельные запросы, результат которых уже некому показать.
      // oxlint-disable-next-line no-await-in-loop -- намеренно последовательно, см. комментарий выше
      const result = await convertItem(key, name, memory, deps);
      if (result.status !== "converted") {
        outcome[result.status].push(item);
        continue;
      }
      outcome.converted[item.id] = result.workItemId;
      try {
        deps.onConverted(item.id, result.workItemId);
      } catch {
        // Отметка пункта — удобство; задача и карточка уже на месте.
      }
    } finally {
      memory.inFlight.delete(key);
    }
  }
  return outcome;
}

type TItemResult = { status: "converted"; workItemId: string } | { status: "failed" | "unplaced" };

async function convertItem<TBinding extends { entity_id: string }>(
  key: string,
  name: string,
  memory: TChecklistTaskMemory,
  deps: TChecklistConversionDeps<TBinding>
): Promise<TItemResult> {
  const attempt = memory.attempts.get(key);
  if (attempt?.workItemId) {
    const workItemId = attempt.workItemId;
    if (deps.isPlaced(workItemId)) return { status: "converted", workItemId };
    try {
      await deps.place(await deps.bind(workItemId));
      return { status: "converted", workItemId };
    } catch (error) {
      if (!deps.isGone(error)) return { status: "unplaced" };
      memory.attempts.delete(key);
      return { status: "failed" };
    }
  }
  // Та же операция при повторе (сервер ответит уже созданной задачей), если текст пункта не менялся.
  const ids = attempt && attempt.name === name ? attempt : { ...deps.newIds(), name };
  memory.attempts.set(key, { name, operationId: ids.operationId, shapeId: ids.shapeId });
  let binding: TBinding;
  try {
    binding = await deps.create({ name, operationId: ids.operationId, shapeId: ids.shapeId });
  } catch {
    return { status: "failed" };
  }
  memory.attempts.set(key, { name, operationId: ids.operationId, shapeId: ids.shapeId, workItemId: binding.entity_id });
  try {
    await deps.place(binding);
    return { status: "converted", workItemId: binding.entity_id };
  } catch {
    return { status: "unplaced" };
  }
}

/** Имена пунктов для уведомления: кавычки языка интерфейса («…» / “…”), до трёх имён по 40 символов. */
function quotedItemNames(items: readonly TChecklistItemRef[], t: (key: TPpmTranslationKey) => string): string {
  const names = items.slice(0, NOTICE_NAMES_MAX).map((item) => {
    const characters = Array.from(item.text.trim());
    const name =
      characters.length > NOTICE_NAME_LENGTH
        ? `${characters.slice(0, NOTICE_NAME_LENGTH).join("").trimEnd()}…`
        : characters.join("");
    return fillCanvasTemplate(t("canvas.checklist_item_quoted"), { name });
  });
  return items.length > NOTICE_NAMES_MAX ? `${names.join(", ")}, …` : names.join(", ");
}

/** Итог нажатия: сколько пунктов стали задачами, какие — нет и почему; повтор дублей не создаёт. */
export function describeChecklistConversion(
  outcome: TChecklistConversionOutcome,
  total: number,
  t: (key: TPpmTranslationKey) => string
): string {
  const count = Object.keys(outcome.converted).length;
  if (count === total && outcome.failed.length === 0 && outcome.unplaced.length === 0)
    return fillCanvasTemplate(t("canvas.checklist_converted"), { count });
  return [
    fillCanvasTemplate(t("canvas.checklist_converted_partial"), { count, total }),
    outcome.unplaced.length > 0
      ? fillCanvasTemplate(t("canvas.checklist_not_placed"), { names: quotedItemNames(outcome.unplaced, t) })
      : null,
    outcome.failed.length > 0
      ? fillCanvasTemplate(t("canvas.checklist_not_created"), { names: quotedItemNames(outcome.failed, t) })
      : null,
    t("canvas.checklist_retry"),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
