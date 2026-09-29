/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmText } from "@/hooks/use-ppm-text";

// PAST_DURATION_FILTER_OPTIONS (@plane/constants intake) → the same PPM keys as the other date filters (line R).
const INTAKE_DATE_PRESET_KEYS: Record<string, TPpmTranslationKey> = {
  today: "ui.date_filter.today",
  yesterday: "ui.date_filter.yesterday",
  last_7_days: "ui.date_filter.last_7_days",
  last_30_days: "ui.date_filter.last_30_days",
};

/** Line R2-2: the name of an intake date preset in the Russian PPM interface, the upstream name otherwise. */
export function useIntakeDatePresetName(): (value: string, upstream: string) => string {
  const ppmText = usePpmText();

  return useCallback(
    (value: string, upstream: string) => {
      const key = INTAKE_DATE_PRESET_KEYS[value];
      return key ? ppmText(key, upstream) : upstream;
    },
    [ppmText]
  );
}
