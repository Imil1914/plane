/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { IGroupByColumn, TIssueGroupByOptions } from "@plane/types";
import type { TPpmTranslationKey } from "@ppm/brand";

export const PPM_CANCELLED_EXPANDED_PREFIX = "ppm_tasks_cancelled_expanded:";

export function getPpmCancelledStorageKey(projectId: string): string {
  return `${PPM_CANCELLED_EXPANDED_PREFIX}${projectId}`;
}

export function parsePpmExpandedGroups(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function togglePpmExpandedGroup(ids: readonly string[], groupId: string): string[] {
  return ids.includes(groupId) ? ids.filter((id) => id !== groupId) : [...ids, groupId];
}

export function isPpmCancelledGroup(
  groupBy: TIssueGroupByOptions | null | undefined,
  groupId: string,
  getStateGroup: (stateId: string) => string | undefined
): boolean {
  if (groupBy === "state") return getStateGroup(groupId) === "cancelled";
  if (groupBy === "state_detail.group") return groupId === "cancelled";
  return false;
}

const NONE_GROUP_KEYS: Record<string, TPpmTranslationKey> = {
  cycle: "tasks.group.no_cycle",
  module: "tasks.group.no_module",
  labels: "tasks.group.no_label",
  assignees: "tasks.group.no_assignee",
};
const STATE_GROUP_KEYS: Record<string, TPpmTranslationKey> = {
  backlog: "tasks.group.state_backlog",
  unstarted: "tasks.group.state_unstarted",
  started: "tasks.group.state_started",
  completed: "tasks.group.state_completed",
  cancelled: "tasks.group.state_cancelled",
};
const PRIORITY_KEYS: Record<string, TPpmTranslationKey> = {
  urgent: "tasks.group.priority_urgent",
  high: "tasks.group.priority_high",
  medium: "tasks.group.priority_medium",
  low: "tasks.group.priority_low",
  none: "tasks.group.priority_none",
};

export type TPpmGroupLocalizeOptions = {
  groupBy: TIssueGroupByOptions | null | undefined;
  isEpic?: boolean;
  translate: (key: TPpmTranslationKey) => string;
  getStateName: (stateId: string) => string | undefined;
};

/** Только отображение: id, payload и порядок групп не меняются (R10, R11). */
export function localizePpmGroupColumns(groups: IGroupByColumn[], options: TPpmGroupLocalizeOptions): IGroupByColumn[] {
  const { groupBy, isEpic = false, translate, getStateName } = options;
  return groups.map((group) => {
    let name = group.name;
    const noneKey = groupBy ? NONE_GROUP_KEYS[groupBy] : undefined;
    if (!groupBy && group.id === "All Issues") name = translate(isEpic ? "tasks.group.all_epics" : "tasks.group.all");
    else if (group.id === "None" && noneKey) name = translate(noneKey);
    else if (groupBy === "state") name = getStateName(group.id) ?? group.name;
    else if (groupBy === "state_detail.group" && STATE_GROUP_KEYS[group.id])
      name = translate(STATE_GROUP_KEYS[group.id]);
    else if (groupBy === "priority" && PRIORITY_KEYS[group.id]) name = translate(PRIORITY_KEYS[group.id]);
    return name === group.name ? group : { ...group, name };
  });
}
