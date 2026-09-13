/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { Link } from "react-router";
import { MoreHorizontal, Pin } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { SetAsDefaultIcon } from "@plane/propel/icons";
import { Menu } from "@plane/propel/menu";
import { Tooltip } from "@plane/propel/tooltip";
import { cn } from "@plane/utils";
import { getPpmTranslation } from "@ppm/brand";
// local imports
import type { TNavigationItem } from "./tab-navigation-root";
import type { TTabPreferences } from "./tab-navigation-utils";

type Props = {
  overflowItems: TNavigationItem[];
  isActive: (item: TNavigationItem) => boolean;
  tabPreferences: TTabPreferences;
  onToggleDefault: (tabKey: string) => void;
  onShow: (tabKey: string) => void;
};

/**
 * Overflow menu for tab navigation items
 * Displays items that don't fit in the visible area, with action icons
 * Shows "Eye" icon for user-hidden items, "Set as default" icon for all items
 */
export function TabNavigationOverflowMenu({ overflowItems, isActive, tabPreferences, onToggleDefault, onShow }: Props) {
  const { currentLocale, t } = useTranslation();

  return (
    <Menu
      ellipsis
      ariaLabel={getPpmTranslation(currentLocale, "navigation.more_project_sections")}
      customButtonClassName="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
      optionsClassName="min-w-[200px] space-y-1"
      customButton={
        <div className="flex items-center justify-center rounded-md p-1 transition-colors hover:bg-layer-1">
          <MoreHorizontal className="h-4 w-4 text-secondary" />
        </div>
      }
    >
      {overflowItems.map((item) => {
        const itemIsActive = isActive(item);
        // isHidden = true only for user-hidden items (not space-constrained overflow)
        const isHidden = tabPreferences.hiddenTabs.includes(item.key);
        const isDefault = item.key === tabPreferences.defaultTab;
        const label = item.ppmLabelKey ? getPpmTranslation(currentLocale, item.ppmLabelKey) : t(item.i18n_key);
        const showLabel = `${getPpmTranslation(currentLocale, "actions.show")}: ${label}`;
        const defaultLabel = `${getPpmTranslation(
          currentLocale,
          isDefault ? "actions.clear_default" : "actions.set_default"
        )}: ${label}`;

        return (
          <Menu.MenuItem key={`${item.key}-overflow-${itemIsActive ? "active" : "inactive"}`} className="w-full p-0">
            <div className="group/menu-item flex w-full items-center justify-between">
              <Link
                to={item.href}
                aria-current={itemIsActive ? "page" : undefined}
                className="focus-visible:outline-accent-primary w-full min-w-0 flex-1 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-offset-1"
              >
                <span className="text-11">{label}</span>
              </Link>
              <div className="flex items-center">
                {/* Show Eye icon ONLY for user-hidden items */}
                {isHidden && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onShow(item.key);
                    }}
                    className="focus-visible:outline-accent-primary invisible rounded-sm p-1 text-tertiary transition-colors group-focus-within/menu-item:visible group-hover/menu-item:visible hover:text-primary focus-visible:visible focus-visible:outline-2"
                    title={showLabel}
                    aria-label={showLabel}
                  >
                    <Pin className="size-3" />
                  </button>
                )}
                <Tooltip
                  tooltipContent={getPpmTranslation(
                    currentLocale,
                    isDefault ? "actions.clear_default" : "actions.set_default"
                  )}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onToggleDefault(item.key);
                    }}
                    className={cn(
                      "focus-visible:outline-accent-primary invisible rounded-sm p-1 text-tertiary transition-colors group-focus-within/menu-item:visible group-hover/menu-item:visible hover:text-primary focus-visible:visible focus-visible:outline-2",
                      {
                        visible: isDefault,
                      }
                    )}
                    title={defaultLabel}
                    aria-label={defaultLabel}
                  >
                    <SetAsDefaultIcon className="size-3" />
                  </button>
                </Tooltip>
              </div>
            </div>
          </Menu.MenuItem>
        );
      })}
    </Menu>
  );
}
