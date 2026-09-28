/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
import type { TCycleEstimateType } from "@plane/types";
import { EEstimateSystem } from "@plane/types";
import { CustomSelect } from "@plane/ui";
import { useProjectEstimates } from "@/hooks/store/estimates";
import { useCycle } from "@/hooks/store/use-cycle";
// local imports
import { cycleEstimateOptions } from "../analytics-sidebar/issue-progress";
import { usePpmText } from "@/hooks/use-ppm-text";

// PPM names of the burndown basis (the options live in the analytics sidebar, owned by lane S).
const PPM_ESTIMATE_TYPE_KEYS = {
  issues: "ui.cycle.estimate_type_tasks",
  points: "ui.cycle.estimate_type_points",
} as const;

type TProps = {
  value: TCycleEstimateType;
  onChange: (value: TCycleEstimateType) => Promise<void>;
  showDefault?: boolean;
  projectId: string;
  cycleId: string;
};

export const EstimateTypeDropdown = observer(function EstimateTypeDropdown(props: TProps) {
  const { value, onChange, projectId, cycleId, showDefault = false } = props;
  const { getIsPointsDataAvailable } = useCycle();
  const ppmText = usePpmText();
  const optionLabel = (option: { value: string; label: string } | undefined) =>
    option && option.value in PPM_ESTIMATE_TYPE_KEYS
      ? ppmText(PPM_ESTIMATE_TYPE_KEYS[option.value as keyof typeof PPM_ESTIMATE_TYPE_KEYS], option.label)
      : option?.label;
  const { areEstimateEnabledByProjectId, currentProjectEstimateType } = useProjectEstimates();
  const isCurrentProjectEstimateEnabled = projectId && areEstimateEnabledByProjectId(projectId) ? true : false;
  return (getIsPointsDataAvailable(cycleId) || isCurrentProjectEstimateEnabled) &&
    currentProjectEstimateType !== EEstimateSystem.CATEGORIES ? (
    <div className="relative flex items-center gap-2">
      <CustomSelect
        value={value}
        label={
          <span>
            {optionLabel(cycleEstimateOptions.find((v) => v.value === value)) ?? ppmText("ui.common.none", "None")}
          </span>
        }
        onChange={onChange}
        maxHeight="lg"
        buttonClassName="bg-surface-2 border-none rounded-sm text-13 font-medium "
      >
        {cycleEstimateOptions.map((item) => (
          <CustomSelect.Option key={item.value} value={item.value}>
            {optionLabel(item)}
          </CustomSelect.Option>
        ))}
      </CustomSelect>
    </div>
  ) : showDefault ? (
    <span className="capitalize">{optionLabel(cycleEstimateOptions.find((v) => v.value === value)) ?? value}</span>
  ) : null;
});
