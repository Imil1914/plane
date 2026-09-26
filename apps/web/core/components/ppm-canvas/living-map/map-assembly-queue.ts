/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TSprintMapPlan } from "./map-assembly";

// AF2.2 M1: план карты от диалога (редактор прежней доски) — редактору новой доски, в пределах страницы. Забирается
// один раз, когда новая доска загружена, доступна для правки и активна (map-assembly-dialog.tsx). Перезагрузка
// страницы до этого — пустая доска «Карта · …» (её можно удалить или собрать карту заново).
const queued = new Map<string, TSprintMapPlan>();

export function queueSprintMapAssembly(boardId: string, plan: TSprintMapPlan): void {
  queued.set(boardId, plan);
}

export function hasSprintMapAssembly(boardId: string): boolean {
  return queued.has(boardId);
}

export function takeSprintMapAssembly(boardId: string): TSprintMapPlan | undefined {
  const plan = queued.get(boardId);
  queued.delete(boardId);
  return plan;
}
