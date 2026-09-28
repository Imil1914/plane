/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
// plane imports
import { AreaChart } from "@plane/propel/charts/area-chart";
import type { TChartData, TModuleCompletionChartDistribution } from "@plane/types";
import { renderFormattedDateWithoutYear } from "@plane/utils";
// PPM line S3
import { buildBurndownChartData, toLocalDateKey } from "@/components/ppm-live-stats/burndown-chart-data";

type Props = {
  distribution: TModuleCompletionChartDistribution;
  totalIssues: number;
  className?: string;
  plotTitle?: string;
  // PPM line S3: a completed sprint keeps the original drawing (every day, a missing value as 0); otherwise the
  // actual line stops at today instead of falling to 0 on the days that have not happened yet.
  isCompleted?: boolean;
  // PPM shell: pre-translated overrides for the legend/axis copy below. Undefined keeps the
  // upstream English default (`Current ${plotTitle}` / "Date" / "Completion") unchanged for any
  // caller that does not opt in, per the "no revert of upstream behavior" constraint.
  currentLabel?: string;
  idealLabel?: string;
  dateAxisLabel?: string;
  completionAxisLabel?: string;
};

function ProgressChart({
  distribution,
  totalIssues,
  className = "",
  plotTitle = "work items",
  isCompleted = false,
  currentLabel,
  idealLabel,
  dateAxisLabel,
  completionAxisLabel,
}: Props) {
  // `current` is null on the days after today: the chart draws no point and no line there, the tooltip skips it
  const chartData: TChartData<"name", "current" | "ideal">[] = buildBurndownChartData(distribution, totalIssues, {
    today: toLocalDateKey(new Date()),
    isCompleted,
    formatLabel: renderFormattedDateWithoutYear,
  });

  return (
    <div className={`flex w-full items-center justify-center ${className}`}>
      <AreaChart
        data={chartData}
        areas={[
          {
            key: "current",
            label: currentLabel ?? `Current ${plotTitle}`,
            strokeColor: "#3F76FF",
            fill: "#3F76FF33",
            fillOpacity: 1,
            showDot: true,
            smoothCurves: true,
            strokeOpacity: 1,
            stackId: "bar-one",
          },
          {
            key: "ideal",
            label: idealLabel ?? `Ideal ${plotTitle}`,
            strokeColor: "#A9BBD0",
            fill: "#A9BBD0",
            fillOpacity: 0,
            showDot: true,
            smoothCurves: true,
            strokeOpacity: 1,
            stackId: "bar-two",
            style: {
              strokeDasharray: "6, 3",
              strokeWidth: 1,
            },
          },
        ]}
        xAxis={{ key: "name", label: dateAxisLabel ?? "Date" }}
        yAxis={{ key: "current", label: completionAxisLabel ?? "Completion" }}
        margin={{ bottom: 30 }}
        className="h-[370px] w-full"
        legend={{
          align: "center",
          verticalAlign: "bottom",
          layout: "horizontal",
          wrapperStyles: {
            marginTop: 20,
          },
        }}
      />
    </div>
  );
}

export default ProgressChart;
