/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line S3 — points of the «Выгорание задач» (burndown) chart.
 *
 * The API sends a value per day of the sprint/module and `null` for the days after today (by the server clock); the
 * chart used to draw those as 0, so «Фактически» fell to zero on every future day although nothing was closed.
 * Now «Фактически» is drawn up to today inclusive — a later day, or a day without a value yet, gets `null`, which the
 * chart shows as no point and no line (and the tooltip leaves out). «План» still spans the whole period. A completed
 * sprint is drawn exactly as before. The API data is not changed.
 */

export type TBurndownDistribution = Readonly<Record<string, number | null | undefined>>;

export type TBurndownChartPoint = {
  /** the API day key, e.g. "2026-09-28" */
  date: string;
  /** x-axis label */
  name: string;
  /** «Фактически»: remaining work, or null for a day that has not happened yet */
  current: number | null;
  /** «План»: a straight line from the total on the first day to 0 on the last */
  ideal: number;
};

export type TBurndownOptions = {
  /** the viewer's today, "yyyy-MM-dd" (see toLocalDateKey) */
  today: string;
  /** a completed sprint keeps the original drawing: every day, a missing value as 0 */
  isCompleted?: boolean;
  formatLabel?: (date: string) => string;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** "yyyy-MM-dd" of the viewer's local calendar day. */
export const toLocalDateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function buildBurndownChartData(
  distribution: TBurndownDistribution | null | undefined,
  total: number,
  { today, isCompleted = false, formatLabel = (date) => date }: TBurndownOptions
): TBurndownChartPoint[] {
  const dates = Object.keys(distribution ?? {});
  const lastIndex = dates.length - 1;
  return dates.map((date, index) => {
    const value = distribution?.[date];
    const current = isCompleted ? (value ?? 0) : date.slice(0, 10) <= today && isNumber(value) ? value : null;
    return {
      date,
      name: formatLabel(date),
      current,
      ideal: lastIndex > 0 ? total * (1 - index / lastIndex) : total,
    };
  });
}
