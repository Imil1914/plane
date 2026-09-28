/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
// plane imports
import type { TWorkItemFilterCondition } from "@plane/shared-state";
import { EIssuesStoreType } from "@plane/types";
// constants
import { CYCLE_ISSUES_WITH_PARAMS } from "@plane/constants";
// components
import { ACTIVE_CYCLE_PRIORITY_PAGE_SIZE } from "@/components/ppm-live-stats/live-subjects";
// hooks
import { useCycle } from "@/hooks/store/use-cycle";
import { useIssues } from "@/hooks/store/use-issues";
import { useWorkItemFilters } from "@/hooks/store/work-item-filters/use-work-item-filters";
// store
import type { ActiveCycleIssueDetails } from "@/store/issue/cycle";

interface IActiveCycleDetails {
  workspaceSlug: string;
  projectId: string;
  cycleId: string | null | undefined;
}

const useCyclesDetails = (props: IActiveCycleDetails) => {
  // props
  const { workspaceSlug, projectId, cycleId } = props;
  // router
  const router = useRouter();
  // store hooks
  const {
    issuesFilter: { updateFilterExpression },
    issues: { getActiveCycleById: getActiveCycleByIdFromIssue, fetchActiveCycleIssues },
  } = useIssues(EIssuesStoreType.CYCLE);
  const { updateFilterExpressionFromConditions } = useWorkItemFilters();

  const { fetchActiveCycleProgress, getCycleById, fetchActiveCycleAnalytics } = useCycle();
  // derived values
  const cycle = cycleId ? getCycleById(cycleId) : null;
  // PPM line S: the analytics endpoint answers 400 for a sprint without dates (a draft), and SWR would keep retrying
  const hasDates = Boolean(cycle?.start_date && cycle?.end_date);

  // fetch cycle details
  useSWR(
    workspaceSlug && projectId && cycle?.id ? `PROJECT_ACTIVE_CYCLE_${projectId}_PROGRESS_${cycle.id}` : null,
    workspaceSlug && projectId && cycle?.id ? () => fetchActiveCycleProgress(workspaceSlug, projectId, cycle.id) : null,
    { revalidateIfStale: false, revalidateOnFocus: false }
  );
  useSWR(
    workspaceSlug && projectId && cycle?.id && hasDates && !cycle?.distribution
      ? `PROJECT_ACTIVE_CYCLE_${projectId}_DURATION_${cycle.id}`
      : null,
    workspaceSlug && projectId && cycle?.id && hasDates && !cycle?.distribution
      ? () => fetchActiveCycleAnalytics(workspaceSlug, projectId, cycle.id, "issues")
      : null
  );
  useSWR(
    workspaceSlug && projectId && cycle?.id && hasDates && !cycle?.estimate_distribution
      ? `PROJECT_ACTIVE_CYCLE_${projectId}_ESTIMATE_DURATION_${cycle.id}`
      : null,
    workspaceSlug && projectId && cycle?.id && hasDates && !cycle?.estimate_distribution
      ? () => fetchActiveCycleAnalytics(workspaceSlug, projectId, cycle.id, "points")
      : null
  );
  useSWR(
    workspaceSlug && projectId && cycle?.id ? CYCLE_ISSUES_WITH_PARAMS(cycle?.id, { priority: "urgent,high" }) : null,
    workspaceSlug && projectId && cycle?.id
      ? () => fetchActiveCycleIssues(workspaceSlug, projectId, ACTIVE_CYCLE_PRIORITY_PAGE_SIZE, cycle?.id)
      : null,
    { revalidateIfStale: false, revalidateOnFocus: false }
  );

  const storedCycleIssueDetails = cycle?.id ? getActiveCycleByIdFromIssue(cycle.id) : undefined;
  // PPM line S: while the priority list is re-read in the background (use-cycle-live-stats) the store briefly holds
  // nothing for the sprint; keep showing the previous list of the same sprint instead of flashing loaders.
  const [shownCycleIssues, setShownCycleIssues] = useState<{ cycleId: string; details: ActiveCycleIssueDetails }>();
  useEffect(() => {
    if (cycle?.id && storedCycleIssueDetails)
      setShownCycleIssues({ cycleId: cycle.id, details: storedCycleIssueDetails });
  }, [cycle?.id, storedCycleIssueDetails]);
  const cycleIssueDetails = cycle?.id
    ? (storedCycleIssueDetails ?? (shownCycleIssues?.cycleId === cycle.id ? shownCycleIssues.details : undefined))
    : { nextPageResults: false };

  const handleFiltersUpdate = useCallback(
    async (conditions: TWorkItemFilterCondition[]) => {
      if (!workspaceSlug || !projectId || !cycleId) return;

      await updateFilterExpressionFromConditions(
        EIssuesStoreType.CYCLE,
        cycleId,
        conditions,
        updateFilterExpression.bind(updateFilterExpression, workspaceSlug, projectId, cycleId)
      );

      router.push(`/${workspaceSlug}/projects/${projectId}/cycles/${cycleId}`);
    },
    [workspaceSlug, projectId, cycleId, updateFilterExpressionFromConditions, updateFilterExpression, router]
  );
  return {
    cycle,
    cycleId,
    router,
    handleFiltersUpdate,
    cycleIssueDetails,
  };
};
export default useCyclesDetails;
