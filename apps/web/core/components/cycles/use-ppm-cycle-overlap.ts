/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { formatDateRange, getDate, renderFormattedDate } from "@plane/utils";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import { useCycle } from "@/hooks/store/use-cycle";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { findPpmCycleOverlaps } from "./ppm-date-overlap";

export type TPpmCycleOverlapRange = {
  start: string | null | undefined;
  end: string | null | undefined;
  cycleId?: string | null;
};

/**
 * Explains a sprint date conflict with the project's sprints from the store: «Даты пересекаются со спринтом
 * «Спринт 1» (20 сент. – 4 окт. 2026). Выберите даты после 4 окт. 2026 или создайте спринт без дат — это будет
 * черновик.» Returns null when no loaded sprint conflicts (the caller then uses the general text).
 */
export function usePpmCycleOverlapMessage(): (projectId: string, range: TPpmCycleOverlapRange) => string | null {
  const { getProjectCycleDetails } = useCycle();
  const ppmT = usePpmTranslation();

  return useCallback(
    (projectId, range) => {
      // Days in the project's time zone, as the server compares them (see toPpmCycleDateKey).
      const overlaps = findPpmCycleOverlaps(getProjectCycleDetails(projectId) ?? [], range);
      const latest = overlaps.at(-1);
      if (!latest) return null;
      return formatPpmTemplate(ppmT("ui.cycle.overlap_message"), {
        name: latest.cycle.name,
        range: formatDateRange(getDate(latest.start), getDate(latest.end)),
        after: renderFormattedDate(latest.end) ?? latest.end,
      });
    },
    [getProjectCycleDetails, ppmT]
  );
}
