/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { usePathname } from "next/navigation";
import { Outlet } from "react-router";
// components
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { getWorkspaceActivePath, pathnameToAccessKey } from "@/components/settings/helper";
import { SettingsMobileNav } from "@/components/settings/mobile/nav";
// plane imports
import { WORKSPACE_SETTINGS_ACCESS } from "@plane/constants";
import type { EUserWorkspaceRoles } from "@plane/types";
import { isPpmShellEnabled } from "@ppm/brand";
// components
import { WorkspaceSettingsSidebarRoot } from "@/components/settings/workspace/sidebar";
// hooks
import { useUserPermissions } from "@/hooks/store/user";
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";
import { canAccessPpmWorkspaceAdministration } from "@/helpers/ppm-workspace-access.helper";

import type { Route } from "./+types/layout";

const WorkspaceSettingLayout = observer(function WorkspaceSettingLayout({ params }: Route.ComponentProps) {
  // router
  const { workspaceSlug } = params;
  // store hooks
  const { workspaceUserInfo, getWorkspaceRoleByWorkspaceSlug } = useUserPermissions();
  const { isGlobalAdmin } = usePpmAdminAccess();
  // next hooks
  const pathname = usePathname();
  // derived values
  const { accessKey } = pathnameToAccessKey(pathname);
  const userWorkspaceRole = getWorkspaceRoleByWorkspaceSlug(workspaceSlug);
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const canAccessWorkspaceAdministration = canAccessPpmWorkspaceAdministration({
    isGlobalAdmin,
    isPpmShell,
  });

  let isAuthorized: boolean | string = false;
  if (pathname && workspaceSlug && userWorkspaceRole) {
    isAuthorized =
      canAccessWorkspaceAdministration &&
      WORKSPACE_SETTINGS_ACCESS[accessKey]?.includes(userWorkspaceRole as EUserWorkspaceRoles);
  }

  return (
    <>
      <SettingsMobileNav
        hamburgerContent={WorkspaceSettingsSidebarRoot}
        activePath={getWorkspaceActivePath(pathname) || ""}
      />
      <div className="inset-y-0 flex h-full w-full flex-row">
        {workspaceUserInfo && !isAuthorized ? (
          <NotAuthorizedView section="settings" className="h-auto" />
        ) : (
          <div className="relative flex size-full">
            <div className="hidden h-full md:block">
              <WorkspaceSettingsSidebarRoot />
            </div>
            <Outlet />
          </div>
        )}
      </div>
    </>
  );
});

export default WorkspaceSettingLayout;
