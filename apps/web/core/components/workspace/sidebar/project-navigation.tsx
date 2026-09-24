/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useCallback, useMemo } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useSearchParams } from "react-router";
import { EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { isPpmShellEnabled } from "@ppm/brand";
import { isPpmCanvasEnabled } from "@ppm/canvas";
// plane ui
// components
import { SidebarNavItem } from "@/components/sidebar/sidebar-navigation";
// hooks
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { getPpmAdminModeNavigationHref } from "@/helpers/ppm-admin-mode.helper";
import {
  buildProjectNavigationItems,
  type TProjectNavigationItem,
} from "@/components/navigation/project-navigation-items";

export type TNavigationItem = TProjectNavigationItem;

type TProjectItemsProps = {
  workspaceSlug: string;
  projectId: string;
  additionalNavigationItems?: (workspaceSlug: string, projectId: string) => TNavigationItem[];
};

export const ProjectNavigation = observer(function ProjectNavigation(props: TProjectItemsProps) {
  const { workspaceSlug, projectId, additionalNavigationItems } = props;
  const { workItem: workItemIdentifierFromRoute } = useParams();
  // store hooks
  const { t } = useTranslation();
  const ppmT = usePpmTranslation();
  const { isExtendedProjectSidebarOpened, toggleExtendedProjectSidebar, toggleSidebar } = useAppTheme();
  const { getPartialProjectById } = useProject();
  const { allowPermissions } = useUserPermissions();
  const { isGlobalAdmin } = usePpmAdminAccess();
  const [searchParams] = useSearchParams();
  const {
    issue: { getIssueIdByIdentifier, getIssueById },
  } = useIssueDetail();
  // pathname
  const pathname = usePathname();
  // derived values
  const workItemId = workItemIdentifierFromRoute
    ? getIssueIdByIdentifier(workItemIdentifierFromRoute?.toString())
    : undefined;
  const workItem = workItemId ? getIssueById(workItemId) : undefined;
  const project = getPartialProjectById(projectId);
  // handlers
  const handleProjectClick = () => {
    if (window.innerWidth < 768) {
      toggleSidebar();
    }
    // close the extended sidebar if it is open
    if (isExtendedProjectSidebarOpened) {
      toggleExtendedProjectSidebar(false);
    }
  };

  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const isPpmCanvas = isPpmCanvasEnabled(process.env.PPM_CANVAS_ENABLED, isPpmShell);

  // memoized navigation items and adding additional navigation items
  const navigationItemsMemo = useMemo(() => {
    const navigationItems = buildProjectNavigationItems({
      workspaceSlug,
      projectId,
      project,
      isPpmShellEnabled: isPpmShell,
      isPpmCanvasEnabled: isPpmCanvas,
    });

    if (additionalNavigationItems) {
      navigationItems.push(...additionalNavigationItems(workspaceSlug, projectId));
    }

    // sort navigation items by sortOrder
    // oxlint-disable-next-line unicorn/no-array-sort -- the TypeScript target predates Array#toSorted
    const sortedNavigationItems = [...navigationItems].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    return sortedNavigationItems;
  }, [workspaceSlug, projectId, project, isPpmShell, isPpmCanvas, additionalNavigationItems]);

  const isActive = useCallback(
    (item: TNavigationItem) => {
      // work item condition
      const workItemCondition = workItemId && workItem && !workItem?.is_epic && workItem?.project_id === projectId;
      // epic condition
      const epicCondition = workItemId && workItem && workItem?.is_epic && workItem?.project_id === projectId;
      // is active
      const isWorkItemActive = item.key === "work_items" && workItemCondition;
      const isEpicActive = item.key === "epics" && epicCondition;
      // pathname condition
      const isPathnameActive = pathname.includes(item.href);
      // return
      return isWorkItemActive || isEpicActive || isPathnameActive;
    },
    [pathname, workItem, workItemId, projectId]
  );

  if (!project) return null;

  return (
    <nav aria-label={isPpmShell ? ppmT("navigation.project") : t("project")} className="flex flex-col gap-0.5">
      {navigationItemsMemo.map((item) => {
        if (!item.shouldRender) return;

        const hasAccess = allowPermissions(item.access, EUserPermissionsLevel.PROJECT, workspaceSlug, project.id);
        if (!hasAccess) return null;

        const shouldShowCount = item.key === "intake" && (project.intake_count ?? 0) > 0;
        const itemIsActive = !!isActive(item);

        return (
          <Link
            key={item.key}
            href={getPpmAdminModeNavigationHref(item.href, isGlobalAdmin, searchParams.get("ppm_admin_mode"))}
            aria-current={itemIsActive ? "page" : undefined}
            className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
            onClick={handleProjectClick}
          >
            <SidebarNavItem isActive={itemIsActive}>
              <div className="flex w-full items-center justify-between gap-1.5 py-[1px]">
                <div className="flex items-center gap-1.5">
                  <item.icon
                    className={`size-4 flex-shrink-0 ${item.name === "Intake" ? "stroke-1" : "stroke-[1.5]"}`}
                  />
                  <span className="text-11 font-medium">
                    {item.ppmLabelKey ? ppmT(item.ppmLabelKey) : t(item.i18n_key)}
                  </span>
                </div>
                {shouldShowCount && <span className="text-11 font-medium text-tertiary">{project.intake_count}</span>}
              </div>
            </SidebarNavItem>
          </Link>
        );
      })}
    </nav>
  );
});
