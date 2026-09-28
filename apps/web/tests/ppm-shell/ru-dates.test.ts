/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R (owner request 2026-09-28): dates in the Russian interface — the work item rows showed «Sep 22 - Oct 01, 2026».
// The @plane/utils helpers follow setDateFormatLanguage (set by PpmDateLanguage in ppm-shell/locale-bootstrap);
// without it (English, other apps, PPM_SHELL_ENABLED=0) they keep the upstream output byte for byte.
import { afterEach, describe, expect, it } from "vitest";
import {
  calculateTimeAgo,
  calculateTimeAgoShort,
  convertMinutesToHoursMinutesString,
  formatDateRange,
  getDate,
  getDateFormatLanguage,
  getPageName,
  renderFormattedDate,
  renderFormattedDateWithoutYear,
  setDateFormatLanguage,
} from "@plane/utils";

const day = (value: string) => getDate(value);

afterEach(() => setDateFormatLanguage("en"));

describe("interface-language dates (line R)", () => {
  it("keeps the upstream English output by default", () => {
    expect(getDateFormatLanguage()).toBe("en");
    expect(formatDateRange(day("2026-09-22"), day("2026-10-01"))).toBe("Sep 22 - Oct 01, 2026");
    expect(renderFormattedDate("2026-09-28")).toBe("Sep 28, 2026");
    expect(renderFormattedDateWithoutYear("2026-09-28")).toBe("Sep 28");
    expect(convertMinutesToHoursMinutesString(130)).toBe("2h 10m ");
    expect(getPageName("")).toBe("Untitled");
  });

  it("renders the owner's row «Sep 22 - Oct 01, 2026» in Russian the way the v2 sprint scale does", () => {
    setDateFormatLanguage("ru");
    expect(formatDateRange(day("2026-09-22"), day("2026-10-01"))).toBe("22 сент. – 1 окт. 2026");
    expect(formatDateRange(day("2026-05-01"), day("2026-05-05"))).toBe("1–5 мая 2026");
    expect(formatDateRange(day("2025-12-28"), day("2026-01-04"))).toBe("28 дек. 2025 – 4 янв. 2026");
    expect(formatDateRange(day("2026-09-22"), day("2026-09-22"))).toBe("22 сент. 2026");
    expect(formatDateRange(day("2026-09-22"), undefined)).toBe("22 сент. 2026");
    expect(formatDateRange(undefined, undefined)).toBe("");
  });

  it("switches the single-date helpers, the chart tokens and the short units", () => {
    setDateFormatLanguage("ru-RU");
    expect(getDateFormatLanguage()).toBe("ru");
    expect(renderFormattedDate("2026-09-28")).toBe("28 сент. 2026");
    expect(renderFormattedDateWithoutYear("2026-09-28")).toBe("28 сент.");
    expect(renderFormattedDate("2026-09-28", "MMM")).toBe("сент.");
    expect(renderFormattedDate("2026-09-28", "MMM, yyyy")).toBe("сент. 2026");
    expect(renderFormattedDate("2026-09-28", "MMMM d, yyyy")).toBe("28 сентября 2026");
    expect(convertMinutesToHoursMinutesString(130)).toBe("2 ч 10 мин ");
    expect(calculateTimeAgo(new Date(Date.now() - 2 * 86_400_000))).toBe("2 дня назад");
    expect(calculateTimeAgoShort(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 мин");
    expect(getPageName(" ")).toBe("Без названия");
    expect(renderFormattedDate("2026-09-28")).not.toMatch(/[A-Za-z]/);
  });

  it("goes back to English for any other language", () => {
    setDateFormatLanguage("ru");
    setDateFormatLanguage("de");
    expect(renderFormattedDate("2026-09-28")).toBe("Sep 28, 2026");
  });
});
