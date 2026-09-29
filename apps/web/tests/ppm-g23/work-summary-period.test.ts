// G2.3 (G-Web, G4): calendar math for the «Что сделано за период» presets — fixed "today" values, Monday-start
// weeks, and the client-side 92-day / from<=to pre-check (the API enforces the same rule; see task-GAPI-brief.md).
import { describe, expect, it } from "vitest";
import {
  formatDateISO,
  getWorkSummaryPresetRange,
  mondayOfWeek,
  parseIsoDate,
  validateWorkSummaryRange,
  WORK_SUMMARY_MAX_DAYS,
} from "@/components/ppm-git/insert/work-summary-period";

// Built with the local-time constructor (year, monthIndex, day, hour) rather than a UTC ISO string: the code reads
// the *local* calendar date (deliberately — "today" is whatever day the browser's clock shows), so a fixed instant
// near midnight UTC would land on a different calendar day depending on the machine's timezone (this repo's tests
// run in whatever TZ the runner has, e.g. Europe/Moscow, UTC+3) and silently break the assertions below.
// A Tuesday (2026-09-29, matching "today's date" for this task).
const TUESDAY = new Date(2026, 8, 29, 15, 0, 0);
// A Monday, to check the boundary does not shift the week back by one.
const MONDAY = new Date(2026, 8, 28, 5, 0, 0);
// A Sunday, the last day of its own week.
const SUNDAY = new Date(2026, 9, 4, 23, 0, 0);

describe("mondayOfWeek / formatDateISO", () => {
  it("finds Monday of the current week from any weekday", () => {
    expect(formatDateISO(mondayOfWeek(TUESDAY))).toBe("2026-09-28");
    expect(formatDateISO(mondayOfWeek(MONDAY))).toBe("2026-09-28");
    expect(formatDateISO(mondayOfWeek(SUNDAY))).toBe("2026-09-28");
  });
});

describe("getWorkSummaryPresetRange", () => {
  it("this_week: Monday of the current week through today, never into the future", () => {
    expect(getWorkSummaryPresetRange("this_week", TUESDAY)).toEqual({ from: "2026-09-28", to: "2026-09-29" });
  });

  it("last_week: the previous full Monday-to-Sunday week", () => {
    expect(getWorkSummaryPresetRange("last_week", TUESDAY)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
  });

  it("two_weeks: last week in full, plus this week to date", () => {
    expect(getWorkSummaryPresetRange("two_weeks", TUESDAY)).toEqual({ from: "2026-09-21", to: "2026-09-29" });
  });

  it("month: the 1st of the current month through today", () => {
    expect(getWorkSummaryPresetRange("month", TUESDAY)).toEqual({ from: "2026-09-01", to: "2026-09-29" });
  });

  it("is stable when today is itself a Monday or a Sunday", () => {
    expect(getWorkSummaryPresetRange("this_week", MONDAY)).toEqual({ from: "2026-09-28", to: "2026-09-28" });
    expect(getWorkSummaryPresetRange("this_week", SUNDAY)).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  });
});

describe("parseIsoDate", () => {
  it("parses a valid calendar date at UTC midnight", () => {
    expect(parseIsoDate("2026-09-29")?.toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });

  it("rejects malformed and overflowed dates instead of silently normalizing them", () => {
    expect(parseIsoDate("2026-02-30")).toBeUndefined(); // February has no 30th
    expect(parseIsoDate("29-09-2026")).toBeUndefined();
    expect(parseIsoDate("not-a-date")).toBeUndefined();
  });
});

describe("validateWorkSummaryRange", () => {
  it("accepts a same-day range", () => {
    expect(validateWorkSummaryRange("2026-09-29", "2026-09-29")).toBeUndefined();
  });

  it("accepts exactly the 92-day limit", () => {
    expect(validateWorkSummaryRange("2026-01-01", "2026-04-02")).toBeUndefined(); // 92 days inclusive
  });

  it("rejects one day past the 92-day limit", () => {
    expect(validateWorkSummaryRange("2026-01-01", "2026-04-03")).toBe(
      `Период длиннее ${WORK_SUMMARY_MAX_DAYS} дней. Сократите диапазон.`
    );
  });

  it("rejects from after to", () => {
    expect(validateWorkSummaryRange("2026-09-29", "2026-09-01")).toBe("Дата начала позже даты окончания.");
  });

  it("rejects an unparseable date", () => {
    expect(validateWorkSummaryRange("", "2026-09-29")).toBe("Укажите обе даты в формате ГГГГ-ММ-ДД.");
  });
});
