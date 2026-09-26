/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmWorkItemEditOptions } from "@ppm/canvas";
import { formatPpmIssueIdentifier, isPpmActiveStateGroup } from "@/components/ppm-tasks/evidence";
import type { TTrafficState, TWorkItemFacts, TWorkItemRef } from "./living-map-types";
import { dateOnly, localDateKey, type TLivingMapCard, type TMapIssue } from "./map-model";

// AF2.2 M3: «Светофор» (спецификация, раздел C; RM10). Готова (группа completed) — приглушена, важнее всего; отменена —
// без выделения; есть незавершённая блокирующая задача — «заблокирована {ID}», важнее «просрочено»; срок раньше
// сегодняшней местной даты — «просрочено · дата». Блокирующая задача другого проекта (её статус неизвестен) —
// незавершённая, как в «Задачах» (ppm-tasks/evidence.ts isPpmActiveStateGroup).

export type TTrafficBlocker = TWorkItemRef & { stateGroup: string | null };

export function trafficOf(
  input: { blockers: readonly TTrafficBlocker[]; dueDate: string | null; stateGroup: string | null },
  todayKey: string
): { blockedBy: TWorkItemRef[]; dueDate: string | null; traffic: TTrafficState } {
  const dueDate = dateOnly(input.dueDate);
  const blockedBy = input.blockers
    .filter((item) => isPpmActiveStateGroup(item.stateGroup ?? undefined))
    .map(({ id, identifier }) => ({ id, identifier }));
  let traffic: TTrafficState = "none";
  if (input.stateGroup === "completed") traffic = "done";
  else if (input.stateGroup === "cancelled") traffic = "none";
  else if (blockedBy.length > 0) traffic = "blocked";
  else if (dueDate !== null && dueDate < todayKey) traffic = "overdue";
  return { blockedBy, dueDate, traffic };
}

/**
 * Факты задач на доске: статус и срок — с живой карточки (свежее списка), блокирующие — из связей Plane. Связи «из
 * Задач» сюда не входят (итоговое ревью M-8): линии слоя связей строит collectTaskRelations (relationEdges).
 */
export function computeWorkItemFacts(input: {
  cards: readonly TLivingMapCard[];
  issues: ReadonlyMap<string, TMapIssue>;
  projectId: string;
  projectIdentifier: string | null;
  states: TPpmWorkItemEditOptions["states"];
  today: Date;
}): Map<string, TWorkItemFacts> {
  const stateGroups = new Map(input.states.map((state) => [state.id, state.group]));
  const live = new Map<string, { dueDate: string | null; stateGroup: string | null }>();
  for (const item of input.cards) {
    if (item.binding.entity_type !== "work_item") continue;
    const { display } = item.binding.source;
    live.set(item.binding.entity_id, { dueDate: display.due_date, stateGroup: display.state?.group ?? null });
  }
  const todayKey = localDateKey(input.today);
  const facts = new Map<string, TWorkItemFacts>();
  for (const [workItemId, card] of live) {
    const rows = input.issues.get(workItemId)?.issue_relation ?? [];
    const blockers = rows
      .filter((row) => row.relation_type === "blocked_by")
      .map(
        (row): TTrafficBlocker => ({
          id: row.id,
          identifier: formatPpmIssueIdentifier(
            row.project_id === input.projectId ? input.projectIdentifier : null,
            row.sequence_id
          ),
          stateGroup: live.get(row.id)?.stateGroup ?? (row.state_id ? (stateGroups.get(row.state_id) ?? null) : null),
        })
      );
    const traffic = trafficOf({ blockers, dueDate: card.dueDate, stateGroup: card.stateGroup }, todayKey);
    facts.set(workItemId, { ...traffic, workItemId });
  }
  return facts;
}
