/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { sortBy } from "lodash-es";

/** The part of a sprint (cycle) the overlap check needs. Dates as the API sends them (ISO date or date-time). */
export type TPpmCycleDates = {
  id: string;
  name: string;
  start_date?: string | null;
  end_date?: string | null;
};

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Calendar day (YYYY-MM-DD) of a sprint boundary in the project's time zone — the one the server decides in. The API
 * already sends sprint dates converted to the project time zone (`user_timezone_converter(…, project_timezone)` in
 * `apps/api/plane/app/views/cycle/base.py`), e.g. «2026-09-20T00:00:01+03:00», so the day is the date prefix; the
 * viewer's own time zone must not shift it. A plain date from the form is taken as is.
 */
export function toPpmCycleDateKey(value: string | null | undefined): string | null {
  return (value && DATE_PREFIX.exec(value)?.[1]) || null;
}

export type TPpmCycleOverlap = {
  cycle: TPpmCycleDates;
  /** The conflicting sprint's own boundaries as calendar days. */
  start: string;
  end: string;
};

/**
 * Sprints of the project whose dates intersect the chosen range — the rule of the API check
 * (`CycleDateCheckEndpoint`): both ends inclusive, whole days, so a sprint that ends on the day the new one starts
 * already overlaps. The sprint being edited and sprints without both dates (drafts) never conflict.
 * Sorted by end date, the latest last: «choose dates after …» uses the last one.
 */
export function findPpmCycleOverlaps(
  cycles: readonly TPpmCycleDates[],
  range: { start: string | null | undefined; end: string | null | undefined; cycleId?: string | null }
): TPpmCycleOverlap[] {
  const start = toPpmCycleDateKey(range.start);
  const end = toPpmCycleDateKey(range.end);
  if (!start || !end) return [];

  const overlaps: TPpmCycleOverlap[] = [];
  for (const cycle of cycles) {
    if (range.cycleId && cycle.id === range.cycleId) continue;
    const cycleStart = toPpmCycleDateKey(cycle.start_date);
    const cycleEnd = toPpmCycleDateKey(cycle.end_date);
    if (!cycleStart || !cycleEnd) continue;
    if (start <= cycleEnd && cycleStart <= end) overlaps.push({ cycle, start: cycleStart, end: cycleEnd });
  }
  return sortBy(overlaps, [(overlap) => overlap.end, (overlap) => overlap.start]);
}
