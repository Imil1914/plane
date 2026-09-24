/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useTheme } from "next-themes";
// plane imports
import { PROGRESS_STATE_GROUPS_DETAILS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TWorkItemFilterCondition } from "@plane/shared-state";
import type { ICycle } from "@plane/types";
import { LinearProgressIndicator, Loader } from "@plane/ui";
import { isPpmShellEnabled } from "@ppm/brand";
// assets
import darkProgressAsset from "@/app/assets/empty-state/active-cycle/progress-dark.webp?url";
import lightProgressAsset from "@/app/assets/empty-state/active-cycle/progress-light.webp?url";
// components
import { SimpleEmptyState } from "@/components/empty-state/simple-empty-state-root";
// hooks
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export type ActiveCycleProgressProps = {
  cycle: ICycle | null;
  workspaceSlug: string;
  projectId: string;
  handleFiltersUpdate: (conditions: TWorkItemFilterCondition[]) => void;
};

export const ActiveCycleProgress = observer(function ActiveCycleProgress(props: ActiveCycleProgressProps) {
  const { handleFiltersUpdate, cycle } = props;
  // theme hook
  const { resolvedTheme } = useTheme();
  // plane hooks
  const { t } = useTranslation();
  const ppmT = usePpmTranslation();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  // derived values
  const progressIndicatorData = PROGRESS_STATE_GROUPS_DETAILS.map((group, index) => ({
    id: index,
    name: group.title,
    value: cycle && cycle.total_issues > 0 ? (cycle[group.key as keyof ICycle] as number) : 0,
    color: group.color,
  }));
  const groupedIssues: any = cycle
    ? {
        completed: cycle?.completed_issues,
        started: cycle?.started_issues,
        unstarted: cycle?.unstarted_issues,
        backlog: cycle?.backlog_issues,
      }
    : {};
  const resolvedPath = resolvedTheme === "light" ? lightProgressAsset : darkProgressAsset;

  return cycle && cycle.hasOwnProperty("started_issues") ? (
    <div className="flex min-h-[17rem] flex-col gap-5 rounded-lg border border-subtle bg-surface-1 px-3.5 py-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-14 font-semibold text-tertiary">{t("project_cycles.active_cycle.progress")}</h3>
          {cycle.total_issues > 0 && (
            <span className="flex gap-1 rounded-xs px-3 py-1 text-13 font-medium whitespace-nowrap text-placeholder">
              {(() => {
                const closedCount = cycle.completed_issues + cycle.cancelled_issues;
                const totalCount = cycle.total_issues - cycle.cancelled_issues;
                return isPpmShell
                  ? ppmT("cycle.work_items_closed")
                      .replace("{done}", String(closedCount))
                      .replace("{total}", String(totalCount))
                  : `${closedCount}/${totalCount} ${closedCount > 1 ? "Work items" : "Work item"} closed`;
              })()}
            </span>
          )}
        </div>
        {cycle.total_issues > 0 && <LinearProgressIndicator size="lg" data={progressIndicatorData} />}
      </div>

      {cycle.total_issues > 0 ? (
        <div className="flex flex-col gap-5">
          {Object.keys(groupedIssues).map((group, index) => (
            <>
              {groupedIssues[group] > 0 && (
                <div key={index}>
                  <div
                    className="flex cursor-pointer items-center justify-between gap-2 text-13"
                    onClick={() => {
                      handleFiltersUpdate([{ property: "state_group", operator: "in", value: [group] }]);
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="block h-3 w-3 rounded-full"
                        style={{
                          backgroundColor: PROGRESS_STATE_GROUPS_DETAILS[index].color,
                        }}
                      />
                      {/* CSS `capitalize` title-cases every word, which is correct for the raw
                          English state key (e.g. "unstarted" -> "Unstarted") but wrongly
                          title-cases the already-correctly-cased multi-word RU translation
                          (e.g. "В процессе" -> "В Процессе"), so it only applies to the fallback. */}
                      <span className={`w-16 font-medium text-tertiary ${isPpmShell ? "" : "capitalize"}`}>
                        {isPpmShell ? t(`workspace_projects.state.${group}`) : group}
                      </span>
                    </div>
                    <span className="text-tertiary">
                      {isPpmShell
                        ? ppmT("cycle.work_items_count").replace("{count}", String(groupedIssues[group]))
                        : `${groupedIssues[group]} ${groupedIssues[group] > 1 ? "Work items" : "Work item"}`}
                    </span>
                  </div>
                </div>
              )}
            </>
          ))}
          {cycle.cancelled_issues > 0 && (
            <span className="flex items-center gap-2 text-13 text-tertiary">
              <span>
                {isPpmShell
                  ? ppmT("cycle.work_items_excluded").replace("{count}", String(cycle.cancelled_issues))
                  : `${cycle.cancelled_issues} cancelled ${
                      cycle.cancelled_issues > 1 ? "work items are" : "work item is"
                    } excluded from this report.`}{" "}
              </span>
            </span>
          )}
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <SimpleEmptyState title={t("active_cycle.empty_state.progress.title")} assetPath={resolvedPath} />
        </div>
      )}
    </div>
  ) : (
    <Loader className="flex min-h-[17rem] flex-col gap-5 rounded-lg border border-subtle bg-surface-1">
      <Loader.Item width="100%" height="100%" />
    </Loader>
  );
});
