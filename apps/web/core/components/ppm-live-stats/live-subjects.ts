/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** PPM line S: which sprints/modules on screen are kept fresh, and the refresh keys of their panels. */

type TCycleLike = { id?: string; status?: string | null; archived_at?: string | null };
type TModuleLike = { id?: string; archived_at?: string | null };

/** Items per page of the active sprint's «Приоритетные задачи» list. */
export const ACTIVE_CYCLE_PRIORITY_PAGE_SIZE = 30;

// the API refuses a larger `per_page` (plane/utils/paginator.py)
const MAX_PRIORITY_PAGE_SIZE = 1000;

/** A refresh of «Приоритетные задачи» re-reads as many rows as the user has already scrolled in, at least a page. */
export const priorityIssuesPageSize = (loadedCount: number): number =>
  Math.min(MAX_PRIORITY_PAGE_SIZE, Math.max(ACTIVE_CYCLE_PRIORITY_PAGE_SIZE, loadedCount));

/** The active-sprint panel's tab choice (local storage, shared by every component that reads it). */
export const ACTIVE_CYCLE_TAB_STORAGE_KEY = "activeCycleTab";
export const ACTIVE_CYCLE_DEFAULT_TAB = "Assignees";

/** The panel shows «Приоритетные задачи» for any stored tab other than «Ответственные» and «Метки». */
export const isActiveCyclePriorityTab = (tab: string | null | undefined): boolean =>
  tab !== "Assignees" && tab !== "Labels";

/** A completed sprint shows its frozen snapshot and an archived one does not change: neither is re-read. */
export const isCycleStatsLive = (cycle: TCycleLike | null | undefined): boolean =>
  !!cycle?.id && !cycle.archived_at && cycle.status?.toLowerCase() !== "completed";

/** An archived module (or a module opened from the archive) does not change. */
export const isModuleStatsLive = (module: TModuleLike | null | undefined, openedFromArchive = false): boolean =>
  !!module?.id && !module.archived_at && !openedFromArchive;

export const LIVE_STATS_KEYS = {
  /** progress, burndown, assignees, labels of a sprint — shared by the active-sprint panel and the sprint sidebar */
  cycleStats: (cycleId: string) => `cycle-stats:${cycleId}`,
  /** the active-sprint panel's «Приоритетные задачи» list */
  cyclePriorityIssues: (cycleId: string) => `cycle-priority:${cycleId}`,
  /** progress, burndown, assignees, labels of a module */
  moduleStats: (moduleId: string) => `module-stats:${moduleId}`,
};
