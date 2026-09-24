/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Link } from "react-router";
import { PinOff } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { ContextMenu } from "@plane/propel/context-menu";
import { SetAsDefaultIcon } from "@plane/propel/icons";
import { TabNavigationItem } from "@plane/propel/tab-navigation";
import { getPpmTranslation } from "@ppm/brand";
// local imports
import type { TNavigationItem } from "./tab-navigation-root";
import type { TTabPreferences } from "./tab-navigation-utils";

export type TTabNavigationVisibleItemProps = {
  item: TNavigationItem;
  isActive: boolean;
  tabPreferences: TTabPreferences;
  onToggleDefault: (tabKey: string) => void;
  onHide: (tabKey: string) => void;
  itemRef?: (el: HTMLDivElement | null) => void;
};

/**
 * Individual visible tab navigation item with context menu
 * Handles right-click actions for setting default and hiding tabs
 */
export function TabNavigationVisibleItem({
  item,
  isActive,
  tabPreferences,
  onToggleDefault,
  onHide,
  itemRef,
}: TTabNavigationVisibleItemProps) {
  const { currentLocale, t } = useTranslation();
  const isDefault = item.key === tabPreferences.defaultTab;
  const label = item.ppmLabelKey ? getPpmTranslation(currentLocale, item.ppmLabelKey) : t(item.i18n_key);

  return (
    <div className="relative flex h-full items-center transition-all duration-300">
      {isActive && (
        <span className="absolute bottom-0 left-1/2 h-0.5 w-[80%] -translate-x-1/2 rounded-t-md bg-(--text-color-icon-primary) transition-all duration-300" />
      )}
      <div key={`${item.key}-measure`} ref={itemRef}>
        <ContextMenu>
          <ContextMenu.Trigger>
            <Link
              key={`${item.key}-${isActive ? "active" : "inactive"}`}
              to={item.href}
              aria-current={isActive ? "page" : undefined}
              className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
            >
              <TabNavigationItem isActive={isActive}>
                <span>{label}</span>
              </TabNavigationItem>
            </Link>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content positionerClassName="z-30">
              <ContextMenu.Item
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleDefault(item.key);
                }}
                className="flex cursor-pointer items-center gap-2 text-secondary transition-colors"
              >
                <SetAsDefaultIcon className="size-3 shrink-0" />
                <span className="text-11">
                  {getPpmTranslation(currentLocale, isDefault ? "actions.clear_default" : "actions.set_default")}
                </span>
              </ContextMenu.Item>
              <ContextMenu.Item
                onClick={(e) => {
                  e.stopPropagation();
                  onHide(item.key);
                }}
                className="flex cursor-pointer items-center gap-2 text-secondary transition-colors"
              >
                <PinOff className="size-3 shrink-0" />
                <span className="text-11">{getPpmTranslation(currentLocale, "actions.hide")}</span>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu>
      </div>
    </div>
  );
}
