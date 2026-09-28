/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { capitalizeFirstLetter, renderFormattedDate } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

// Preset values of the date filters (@plane/constants DATE_*_FILTER_OPTIONS, PROJECT_CREATED_AT_FILTER_OPTIONS).
const DATE_FILTER_KEYS: Record<string, TPpmTranslationKey> = {
  "1_weeks;after;fromnow": "ui.date_filter.1_week_from_now",
  "2_weeks;after;fromnow": "ui.date_filter.2_weeks_from_now",
  "1_months;after;fromnow": "ui.date_filter.1_month_from_now",
  "2_months;after;fromnow": "ui.date_filter.2_months_from_now",
  "1_weeks;before;fromnow": "ui.date_filter.1_week_ago",
  "2_weeks;before;fromnow": "ui.date_filter.2_weeks_ago",
  "1_months;before;fromnow": "ui.date_filter.1_month_ago",
  "today;custom;custom": "ui.date_filter.today",
  "yesterday;custom;custom": "ui.date_filter.yesterday",
  "last_7_days;custom;custom": "ui.date_filter.last_7_days",
  "last_30_days;custom;custom": "ui.date_filter.last_30_days",
};

/**
 * Names of the date filter presets and of a custom «after/before <date>» value in the PPM interface language;
 * the upstream English name without the PPM shell.
 */
export function usePpmDateFilterName(): {
  presetName: (value: string, upstream: string) => string;
  customName: (value: string) => string;
} {
  const isPpmRu = usePpmRu();
  const ppmT = usePpmTranslation();

  const presetName = useCallback(
    (value: string, upstream: string) =>
      isPpmRu && DATE_FILTER_KEYS[value] ? ppmT(DATE_FILTER_KEYS[value]) : upstream,
    [ppmT, isPpmRu]
  );
  // «date;after» / «date;before» — the upstream label is `${Capitalized direction} ${date}`.
  const customName = useCallback(
    (value: string) => {
      const [date, direction] = value.split(";");
      if (!isPpmRu || (direction !== "after" && direction !== "before"))
        return `${capitalizeFirstLetter(direction ?? "")} ${renderFormattedDate(date)}`;
      return formatPpmTemplate(ppmT(direction === "after" ? "ui.date_filter.after" : "ui.date_filter.before"), {
        date: renderFormattedDate(date) ?? date,
      });
    },
    [ppmT, isPpmRu]
  );

  return { presetName, customName };
}
