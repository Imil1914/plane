/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import type { TIssuePriorities } from "@plane/types";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

/** The PPM names of the priorities — the same keys as the list/board group headers and the canvas. */
export const PPM_PRIORITY_TITLE_KEYS: Record<TIssuePriorities, TPpmTranslationKey> = {
  urgent: "tasks.group.priority_urgent",
  high: "tasks.group.priority_high",
  medium: "tasks.group.priority_medium",
  low: "tasks.group.priority_low",
  none: "tasks.group.priority_none",
};

/**
 * Priority title for chips, dropdowns and filters: «Срочный / Высокий / Средний / Низкий / Без приоритета» under the
 * PPM shell (in the interface language), the upstream English title otherwise.
 */
export function usePpmPriorityTitle(): (priority: TIssuePriorities | null | undefined, upstream: string) => string {
  const isPpmRu = usePpmRu();
  const ppmT = usePpmTranslation();

  return useCallback(
    (priority, upstream) => {
      const key = priority ? PPM_PRIORITY_TITLE_KEYS[priority] : undefined;
      return isPpmRu && key ? ppmT(key) : upstream;
    },
    [ppmT, isPpmRu]
  );
}
