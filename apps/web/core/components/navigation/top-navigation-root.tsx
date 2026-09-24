/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// components
import { observer } from "mobx-react";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@plane/utils";
import { isPpmShellEnabled } from "@ppm/brand";
import { TopNavPowerK } from "@/components/navigation";
import { AppSidebarToggleButton } from "@/components/sidebar/sidebar-toggle-button";
import { HelpMenuRoot } from "@/components/workspace/sidebar/help-section/root";
import { UserMenuRoot } from "@/components/workspace/sidebar/user-menu-root";
import { WorkspaceMenuRoot } from "@/components/workspace/sidebar/workspace-menu-root";
import { shouldShowTopNavSidebarToggle } from "@/helpers/ppm-navigation.helper";
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { usePowerK } from "@/hooks/store/use-power-k";
import { useAppRailPreferences } from "@/hooks/use-navigation-preferences";
import { Tooltip } from "@plane/propel/tooltip";
import { IconButton } from "@plane/propel/icon-button";
import { AppSidebarItem } from "@/components/sidebar/sidebar-item";
import { InboxIcon, SearchIcon } from "@plane/propel/icons";
import useSWR from "swr";
import { useWorkspaceNotifications } from "@/hooks/store/notifications";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
export const TopNavigationRoot = observer(function TopNavigationRoot() {
  // router
  const { workspaceSlug } = useParams();
  const pathname = usePathname();

  // store hooks
  const { unreadNotificationsCount, getUnreadNotificationsCount } = useWorkspaceNotifications();
  const { preferences } = useAppRailPreferences();
  const { sidebarCollapsed } = useAppTheme();
  const { togglePowerKModal } = usePowerK();
  const ppmT = usePpmTranslation();

  const showLabel = preferences.displayMode === "icon_with_label";
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

  // Fetch notification count
  useSWR(
    workspaceSlug ? "WORKSPACE_UNREAD_NOTIFICATION_COUNT" : null,
    workspaceSlug ? () => getUnreadNotificationsCount(workspaceSlug.toString()) : null
  );

  // Calculate notification count
  const isMentionsEnabled = unreadNotificationsCount.mention_unread_notifications_count > 0;
  const totalNotifications = isMentionsEnabled
    ? unreadNotificationsCount.mention_unread_notifications_count
    : unreadNotificationsCount.total_unread_notifications_count;

  return (
    <div
      className={cn("z-[27] flex min-h-10 w-full items-center bg-canvas px-3.5 transition-all duration-300", {
        "min-w-0 gap-1": isPpmShell,
        "px-2": !showLabel,
      })}
    >
      {/* Sidebar toggle (PPM: headerless project pages, collapsed sidebar) */}
      {shouldShowTopNavSidebarToggle({
        isPpmShell,
        sidebarCollapsed,
        pathname,
        workspaceSlug: workspaceSlug?.toString(),
      }) && (
        <div className="shrink-0">
          <AppSidebarToggleButton />
        </div>
      )}
      {/* Workspace Menu (PPM: may shrink on narrow screens) */}
      <div className={isPpmShell ? "min-w-0 flex-1" : "flex-1 shrink-0"}>
        <WorkspaceMenuRoot variant="top-navigation" />
      </div>
      {/* Power K Search (PPM: below sm replaced by the search icon button) */}
      <div className={isPpmShell ? "hidden shrink-0 sm:block" : "shrink-0"}>
        <TopNavPowerK />
      </div>
      {/* Additional Actions */}
      <div className="flex flex-1 shrink-0 items-center justify-end gap-1">
        {isPpmShell && (
          <IconButton
            className="sm:hidden"
            variant="ghost"
            size="xl"
            icon={SearchIcon}
            aria-label={ppmT("navigation.open_command_search")}
            onClick={() => togglePowerKModal(true)}
          />
        )}
        <Tooltip tooltipContent={ppmT("global.inbox")} position="bottom">
          <span className="inline-flex">
            <AppSidebarItem
              variant="link"
              item={{
                href: `/${workspaceSlug?.toString()}/notifications/`,
                icon: (
                  <div className="relative">
                    <InboxIcon className="size-5" />
                    {totalNotifications > 0 && (
                      <span
                        aria-hidden="true"
                        className="absolute top-0 right-0 size-2 rounded-full bg-danger-primary"
                      />
                    )}
                  </div>
                ),
                isActive: pathname?.includes("/notifications/"),
                ariaLabel: totalNotifications > 0 ? ppmT("global.inbox_unread") : ppmT("global.inbox"),
              }}
            />
          </span>
        </Tooltip>
        <HelpMenuRoot />
        <div className="flex size-8 items-center justify-center rounded-md hover:bg-layer-1-hover">
          <UserMenuRoot />
        </div>
      </div>
    </div>
  );
});
