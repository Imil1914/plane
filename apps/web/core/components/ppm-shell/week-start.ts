/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EStartOfTheWeek } from "@plane/types";

/**
 * Set once the user picks a first day of the week themselves (profile preferences or the command palette) and the
 * profile saved it. Per user: `ppm_week_start_explicit:<user id>`, so another account on the same browser starts with
 * the default again.
 */
export const PPM_WEEK_START_EXPLICIT_KEY = "ppm_week_start_explicit";

const weekStartStorageKey = (userId: string) => `${PPM_WEEK_START_EXPLICIT_KEY}:${userId}`;

/**
 * The first day of the week the calendars use. Plane stores Sunday by default for every profile; in the Russian PPM
 * interface the week starts on Monday unless the user chose a day explicitly (then their choice, Sunday included,
 * wins). The English interface and PPM_SHELL_ENABLED=0 keep the stored value as is.
 */
export function resolvePpmStartOfWeek(
  stored: EStartOfTheWeek | undefined,
  options: { shellEnabled: boolean; language: string | undefined; explicit: boolean }
): EStartOfTheWeek {
  const value = stored ?? EStartOfTheWeek.SUNDAY;
  if (!options.shellEnabled || !options.language?.toLowerCase().startsWith("ru") || options.explicit) return value;
  return value === EStartOfTheWeek.SUNDAY ? EStartOfTheWeek.MONDAY : value;
}

export function readPpmWeekStartExplicit(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(weekStartStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function markPpmWeekStartExplicit(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(weekStartStorageKey(userId), "1");
  } catch {
    // Private mode or blocked storage: the choice still applies to this session through the store.
  }
}

/** «Понедельник»… for the week-start preference in the Russian UI (EStartOfTheWeek: 0 = Sunday … 6 = Saturday). */
export function getPpmWeekdayName(day: EStartOfTheWeek, language: string | undefined): string | undefined {
  if (!language?.toLowerCase().startsWith("ru")) return undefined;
  // 2023-01-01 was a Sunday, so the day of January equals the enum value + 1.
  const name = new Intl.DateTimeFormat("ru", { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + day));
  return name.charAt(0).toUpperCase() + name.slice(1);
}
