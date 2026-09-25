/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { ISSUE_LAYOUTS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import { EIssueLayoutTypes } from "@plane/types";
import { cn } from "@plane/utils";
// components
import { IssueLayoutIcon } from "@/components/issues/issue-layouts/layout-icon";
// hooks
import { usePlatformOS } from "@/hooks/use-platform-os";
import { usePpmDesignV2 } from "@/lib/ppm-design";

type Props = {
  layouts: EIssueLayoutTypes[];
  onChange: (layout: EIssueLayoutTypes) => void;
  selectedLayout: EIssueLayoutTypes | undefined;
};

export function LayoutSelection(props: Props) {
  const { layouts, onChange, selectedLayout } = props;
  const { isMobile } = usePlatformOS();
  const { t } = useTranslation();
  const isDesignV2 = usePpmDesignV2();
  const handleOnChange = (layoutKey: EIssueLayoutTypes) => {
    if (selectedLayout !== layoutKey) {
      onChange(layoutKey);
    }
  };

  if (isDesignV2)
    return (
      <div className="ppm-layout-switch">
        {ISSUE_LAYOUTS.filter((l) => layouts.includes(l.key)).map((layout) => (
          <Tooltip key={layout.key} tooltipContent={t(layout.i18n_title)} isMobile={isMobile}>
            <button
              type="button"
              className="ppm-layout-switch__item"
              onClick={() => handleOnChange(layout.key)}
              aria-label={t(layout.i18n_title)}
              aria-pressed={selectedLayout === layout.key}
            >
              <IssueLayoutIcon layout={layout.key} size={14} strokeWidth={1.5} className="size-3.5" />
              {(layout.key === EIssueLayoutTypes.LIST || layout.key === EIssueLayoutTypes.KANBAN) && (
                <span>{t(layout.i18n_title)}</span>
              )}
            </button>
          </Tooltip>
        ))}
      </div>
    );

  return (
    <div className="flex items-center gap-1 rounded-md bg-layer-3 p-1">
      {ISSUE_LAYOUTS.filter((l) => layouts.includes(l.key)).map((layout) => (
        <Tooltip key={layout.key} tooltipContent={t(layout.i18n_title)} isMobile={isMobile}>
          <button
            type="button"
            className={cn(
              "group grid h-5.5 w-7 place-items-center overflow-hidden rounded-sm transition-all hover:bg-layer-transparent-hover",
              {
                "bg-layer-transparent-active hover:bg-layer-transparent-active": selectedLayout === layout.key,
              }
            )}
            onClick={() => handleOnChange(layout.key)}
            aria-label={t(layout.i18n_title)}
            aria-pressed={selectedLayout === layout.key}
          >
            <IssueLayoutIcon
              layout={layout.key}
              size={14}
              strokeWidth={2}
              className={`size-3.5 ${selectedLayout == layout.key ? "text-primary" : "text-secondary"}`}
            />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
