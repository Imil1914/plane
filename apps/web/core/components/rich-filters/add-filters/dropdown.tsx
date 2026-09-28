/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
// plane imports
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { IFilterInstance } from "@plane/shared-state";
import type { TExternalFilter, TFilterProperty, TSupportedOperators } from "@plane/types";
import { CustomSearchSelect } from "@plane/ui";
import { getOperatorForPayload } from "@plane/utils";
// local imports
import { usePpmText } from "@/hooks/use-ppm-text";
import { usePpmRichFilterText } from "../ppm-labels";

export type TAddFilterDropdownProps<P extends TFilterProperty, E extends TExternalFilter> = {
  customButton: React.ReactNode;
  buttonConfig?: {
    className?: string;
    defaultOpen?: boolean;
    isDisabled?: boolean;
  };
  filter: IFilterInstance<P, E>;
  handleFilterSelect: (property: P, operator: TSupportedOperators, isNegation: boolean) => void;
};

export const AddFilterDropdown = observer(function AddFilterDropdown<
  P extends TFilterProperty,
  E extends TExternalFilter,
>(props: TAddFilterDropdownProps<P, E>) {
  const { filter, customButton, buttonConfig } = props;
  const { className, defaultOpen = false, isDisabled = false } = buttonConfig || {};
  const ppmText = usePpmText();
  const { filterLabel } = usePpmRichFilterText();

  // Transform available filter configs to CustomSearchSelect options format
  const filterOptions = filter.configManager.allAvailableConfigs.map((config) => ({
    value: config.id,
    content: (
      <div className="flex items-center justify-between gap-2 text-secondary transition-all duration-200 ease-in-out">
        <div className="flex items-center gap-2">
          {config.icon && (
            <config.icon className="size-4 text-tertiary transition-transform duration-200 ease-in-out" />
          )}
          <span>{filterLabel(config.label)}</span>
        </div>
        {config.rightContent}
      </div>
    ),
    query: filterLabel(config.label).toLowerCase(),
  }));

  // If all filters are applied, show disabled options
  const allFiltersApplied = filterOptions.length === 0;
  const displayOptions = allFiltersApplied
    ? [
        {
          value: "all_filters_applied",
          content: (
            <div className="text-placeholder italic">{ppmText("ui.filter.all_applied", "All filters applied")}</div>
          ),
          query: "all filters applied",
          disabled: true,
        },
      ]
    : filterOptions;

  const handleFilterSelect = (property: P) => {
    const config = filter.configManager.getConfigByProperty(property);
    if (config?.firstOperator) {
      const { operator, isNegation } = getOperatorForPayload(config.firstOperator);
      props.handleFilterSelect(property, operator, isNegation);
    } else {
      setToast({
        title: ppmText("ui.filter.config_error_title", "Filter configuration error"),
        message: ppmText(
          "ui.filter.config_error_message",
          "This filter is not properly configured and cannot be applied"
        ),
        type: TOAST_TYPE.ERROR,
      });
    }
  };

  return (
    <div className="relative transition-all duration-200 ease-in-out">
      <CustomSearchSelect
        defaultOpen={defaultOpen}
        value={""}
        onChange={handleFilterSelect}
        options={displayOptions}
        optionsClassName="w-56"
        maxHeight="2xl"
        placement="bottom-start"
        disabled={isDisabled}
        customButtonClassName={className}
        customButton={customButton}
      />
    </div>
  );
});
