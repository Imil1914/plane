/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import type { EUserProjectRoles, IPartialProject } from "@plane/types";
import { isPpmShellEnabled } from "@ppm/brand";
import { isPpmCanvasEnabled } from "@ppm/canvas";
import type { TNavigationItem } from "@/components/navigation/tab-navigation-root";
import { buildProjectNavigationItems } from "./project-navigation-items";

type UseNavigationItemsProps = {
  workspaceSlug: string;
  projectId: string;
  project?: IPartialProject;
  allowPermissions: (
    access: EUserPermissions[] | EUserProjectRoles[],
    level: EUserPermissionsLevel,
    workspaceSlug: string,
    projectId: string
  ) => boolean;
};

export const useNavigationItems = ({
  workspaceSlug,
  projectId,
  project,
  allowPermissions,
}: UseNavigationItemsProps): TNavigationItem[] => {
  // Combine, filter, and sort navigation items
  const navigationItems = useMemo(() => {
    const ppmShellEnabled = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
    const navItems = buildProjectNavigationItems({
      workspaceSlug,
      projectId,
      project,
      isPpmShellEnabled: ppmShellEnabled,
      isPpmCanvasEnabled: isPpmCanvasEnabled(process.env.PPM_CANVAS_ENABLED, ppmShellEnabled),
    });

    // Filter by permissions and shouldRender
    const filteredItems = navItems.filter((item) => {
      if (!item.shouldRender) return false;
      const hasAccess = allowPermissions(item.access, EUserPermissionsLevel.PROJECT, workspaceSlug, project?.id ?? "");
      return hasAccess;
    });

    // Sort by sortOrder
    // oxlint-disable-next-line unicorn/no-array-sort
    return filteredItems.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }, [workspaceSlug, projectId, project, allowPermissions]);

  return navigationItems;
};
