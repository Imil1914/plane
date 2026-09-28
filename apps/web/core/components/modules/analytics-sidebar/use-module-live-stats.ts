/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import type { IModule } from "@plane/types";
// components
import { isModuleStatsLive, LIVE_STATS_KEYS } from "@/components/ppm-live-stats/live-subjects";
import { useLiveStats } from "@/components/ppm-live-stats/use-live-stats";
// hooks
import { useModule } from "@/hooks/store/use-module";

type TModuleLiveStatsProps = {
  workspaceSlug: string;
  projectId: string;
  module: IModule | null | undefined;
  /** the sidebar was opened from the archive */
  isArchived?: boolean;
};

/**
 * PPM line S: while a module sidebar is on screen the module's progress, burndown, assignees and labels (and with them
 * its progress in the module list) re-read themselves — after changes of the module's work items made in this tab,
 * when the user comes back to the tab/window, and every 30 s on a visible tab. An archived module is not re-read.
 */
export function useModuleLiveStats({ workspaceSlug, projectId, module, isArchived = false }: TModuleLiveStatsProps) {
  const { refreshModuleStats } = useModule();
  const moduleId = module?.id;

  useLiveStats({
    enabled: Boolean(workspaceSlug && projectId) && isModuleStatsLive(module, isArchived),
    key: LIVE_STATS_KEYS.moduleStats(moduleId ?? ""),
    subjectType: "module",
    subjectId: moduleId,
    refresh: () => moduleId && refreshModuleStats(workspaceSlug, projectId, moduleId),
  });
}
