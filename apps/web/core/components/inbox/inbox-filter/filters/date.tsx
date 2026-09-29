/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { concat, uniq } from "lodash-es";
import { observer } from "mobx-react";
import { PAST_DURATION_FILTER_OPTIONS } from "@plane/constants";
import type { TInboxIssueFilterDateKeys } from "@plane/types";
// components
import { DateFilterModal } from "@/components/core/filters/date-filter-modal";
import { FilterHeader, FilterOption } from "@/components/issues/issue-layouts/filters";
// constants
// hooks
import { useProjectInbox } from "@/hooks/store/use-project-inbox";
import { usePpmText } from "@/hooks/use-ppm-text";
// local imports
import { useIntakeDatePresetName } from "../ppm-date-presets";

type Props = {
  filterKey: TInboxIssueFilterDateKeys;
  label?: string;
  searchQuery: string;
};

const isDate = (date: string) => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  return datePattern.test(date);
};

export const FilterDate = observer(function FilterDate(props: Props) {
  const { filterKey, label, searchQuery } = props;
  // hooks
  const { inboxFilters, handleInboxIssueFilters } = useProjectInbox();
  const ppmText = usePpmText();
  const intakeDatePresetName = useIntakeDatePresetName();
  // state
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [isDateFilterModalOpen, setIsDateFilterModalOpen] = useState(false);
  // derived values
  const filterValue: string[] = inboxFilters?.[filterKey] || [];
  const appliedFiltersCount = filterValue?.length ?? 0;
  // Search by the shown name too («сегодня»), as the other date filters do.
  const filteredOptions = PAST_DURATION_FILTER_OPTIONS.filter((d) =>
    `${d.name} ${intakeDatePresetName(d.value, d.name)}`.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleFilterValue = (value: string): string[] => (filterValue?.includes(value) ? [] : uniq(concat(value)));

  const isCustomDateSelected = () => {
    const isValidDateSelected = filterValue?.filter((f) => isDate(f.split(";")[0])) || [];
    return isValidDateSelected.length > 0 ? true : false;
  };

  const handleCustomDate = () => {
    if (isCustomDateSelected()) {
      const updateAppliedFilters = filterValue?.filter((f) => !isDate(f.split(";")[0])) || [];
      handleInboxIssueFilters(filterKey, updateAppliedFilters);
    } else {
      setIsDateFilterModalOpen(true);
    }
  };

  return (
    <>
      {isDateFilterModalOpen && (
        <DateFilterModal
          handleClose={() => setIsDateFilterModalOpen(false)}
          isOpen={isDateFilterModalOpen}
          onSelect={(val) => handleInboxIssueFilters(filterKey, val)}
          title={ppmText("ui.filter.created_date", "Created date")}
        />
      )}
      <FilterHeader
        title={`${label || ppmText("ui.filter.created_date", "Created date")}${appliedFiltersCount > 0 ? ` (${appliedFiltersCount})` : ""}`}
        isPreviewEnabled={previewEnabled}
        handleIsPreviewEnabled={() => setPreviewEnabled(!previewEnabled)}
      />
      {previewEnabled && (
        <div>
          {filteredOptions.length > 0 ? (
            <>
              {filteredOptions.map((option) => (
                <FilterOption
                  key={option.value}
                  isChecked={filterValue?.includes(option.value) ? true : false}
                  onClick={() => handleInboxIssueFilters(filterKey, handleFilterValue(option.value))}
                  title={intakeDatePresetName(option.value, option.name)}
                  multiple={false}
                />
              ))}
              <FilterOption
                isChecked={isCustomDateSelected()}
                onClick={handleCustomDate}
                title={ppmText("ui.common.custom_dates", "Custom")}
                multiple={false}
              />
            </>
          ) : (
            <p className="text-11 text-placeholder italic">{ppmText("ui.common.no_matches", "No matches found")}</p>
          )}
        </div>
      )}
    </>
  );
});
