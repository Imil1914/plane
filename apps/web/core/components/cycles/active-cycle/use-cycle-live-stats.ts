/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import type { ICycle } from "@plane/types";
import { EIssuesStoreType } from "@plane/types";
// components
import {
  ACTIVE_CYCLE_DEFAULT_TAB,
  ACTIVE_CYCLE_TAB_STORAGE_KEY,
  isActiveCyclePriorityTab,
  isCycleStatsLive,
  LIVE_STATS_KEYS,
  priorityIssuesPageSize,
} from "@/components/ppm-live-stats/live-subjects";
import { useLiveStats } from "@/components/ppm-live-stats/use-live-stats";
// hooks
import { useCycle } from "@/hooks/store/use-cycle";
import { useIssues } from "@/hooks/store/use-issues";
import useLocalStorage from "@/hooks/use-local-storage";

type TCycleLiveStatsProps = {
  workspaceSlug: string;
  projectId: string;
  cycle: ICycle | null | undefined;
  /** the active-sprint panel also shows «Приоритетные задачи» */
  withPriorityIssues?: boolean;
};

/**
 * PPM line S: while a sprint panel is on screen its progress, burndown, assignees, labels (and, in the active-sprint
 * panel, the priority list) re-read themselves — after changes of the sprint's work items made in this tab, when the
 * user comes back to the tab/window, and every 30 s on a visible tab. A completed or archived sprint is not re-read.
 * The priority list is re-read only while its tab is open (opening the tab re-reads it at once) and keeps the rows the
 * user has already scrolled in.
 */
export function useCycleLiveStats({
  workspaceSlug,
  projectId,
  cycle,
  withPriorityIssues = false,
}: TCycleLiveStatsProps) {
  const { refreshCycleStats } = useCycle();
  const {
    issues: { fetchActiveCycleIssues, getActiveCycleById },
  } = useIssues(EIssuesStoreType.CYCLE);
  // the same stored tab as the panel's tabs (cycle-stats.tsx); a tab switch there updates it here
  const { storedValue: activeTab } = useLocalStorage(ACTIVE_CYCLE_TAB_STORAGE_KEY, ACTIVE_CYCLE_DEFAULT_TAB);
  const cycleId = cycle?.id;
  const enabled = Boolean(workspaceSlug && projectId) && isCycleStatsLive(cycle);

  useLiveStats({
    enabled,
    key: LIVE_STATS_KEYS.cycleStats(cycleId ?? ""),
    subjectType: "cycle",
    subjectId: cycleId,
    // a change may also have changed the sprint members; the periodic refresh leaves the details out
    refresh: (reason) =>
      cycleId && refreshCycleStats(workspaceSlug, projectId, cycleId, { withDetails: reason === "change" }),
    // the panel's first load (use-cycles-details) is skipped when the numbers are cached from an earlier visit
    refreshOnWatch: Boolean(cycle?.distribution),
  });

  useLiveStats({
    enabled: enabled && withPriorityIssues && isActiveCyclePriorityTab(activeTab),
    key: LIVE_STATS_KEYS.cyclePriorityIssues(cycleId ?? ""),
    subjectType: "cycle",
    subjectId: cycleId,
    // re-read as many rows as are loaded, so a list scrolled to its third page does not collapse to the first
    refresh: () =>
      cycleId &&
      fetchActiveCycleIssues(
        workspaceSlug,
        projectId,
        priorityIssuesPageSize(getActiveCycleById(cycleId)?.issueIds.length ?? 0),
        cycleId
      ),
    refreshOnWatch: Boolean(cycleId && getActiveCycleById(cycleId)),
  });
}
