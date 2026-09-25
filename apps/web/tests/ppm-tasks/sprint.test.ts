import { describe, expect, it } from "vitest";
import { computePpmSprintScale, formatPpmSprintRange, selectPpmPluralKey } from "@/components/ppm-tasks/sprint";

const today = (y: number, m: number, d: number) => new Date(y, m - 1, d, 13, 30);

describe("sprint scale", () => {
  it("matches the mockup: 16–29 Sep, today the 23rd", () => {
    const scale = computePpmSprintScale("2026-09-16", "2026-09-29", today(2026, 9, 23));
    expect(scale).not.toBeNull();
    expect(scale?.totalDays).toBe(14);
    expect(scale?.dayIndex).toBe(8);
    expect(scale?.daysLeft).toBe(6);
    expect(scale?.todayPosition).toBeCloseTo(7 / 13);
    expect(scale?.ticks.filter((t) => t.isMajor).map((t) => t.label)).toEqual(["16", "21", "28", "29"]);
    expect(scale?.ticks.every((t) => t.showLabel)).toBe(true);
    expect(scale?.ticks.find((t) => t.isToday)?.label).toBe("23");
  });

  it("reads project-timezone strings by their calendar date", () => {
    const scale = computePpmSprintScale("2026-09-16T00:00:00+03:00", "2026-09-29T23:59:59+03:00", today(2026, 9, 16));
    expect(scale?.dayIndex).toBe(1);
    expect(scale?.daysLeft).toBe(13);
    expect(scale?.todayPosition).toBe(0);
  });

  it("clamps before start and on the last day", () => {
    expect(computePpmSprintScale("2026-09-16", "2026-09-29", today(2026, 9, 14))?.dayIndex).toBe(1);
    const last = computePpmSprintScale("2026-09-16", "2026-09-29", today(2026, 9, 29));
    expect(last?.dayIndex).toBe(14);
    expect(last?.daysLeft).toBe(0);
    expect(last?.todayPosition).toBe(1);
  });

  it("handles a one-day sprint and hides minor labels on long sprints", () => {
    expect(computePpmSprintScale("2026-09-16", "2026-09-16", today(2026, 9, 16))?.ticks[0].position).toBe(0.5);
    const long = computePpmSprintScale("2026-09-01", "2026-09-28", today(2026, 9, 10));
    expect(long?.ticks.filter((t) => t.showLabel).length).toBeLessThan(28);
  });

  it("returns null for missing or inverted dates", () => {
    expect(computePpmSprintScale(null, "2026-09-29", today(2026, 9, 20))).toBeNull();
    expect(computePpmSprintScale("2026-09-29", "2026-09-16", today(2026, 9, 20))).toBeNull();
  });

  it("formats the range like the mockup", () => {
    expect(formatPpmSprintRange("2026-09-16", "2026-09-29", "ru")).toBe("16–29 сент.");
    expect(formatPpmSprintRange("2026-09-28", "2026-10-11", "ru")).toBe("28 сент. – 11 окт.");
    expect(formatPpmSprintRange("2026-09-16", "2026-09-29", "en")).toBe("Sep 16–29");
  });

  it("selects Russian and English plural forms", () => {
    expect([1, 2, 5, 21].map((n) => selectPpmPluralKey(n, "ru"))).toEqual(["one", "few", "many", "one"]);
    expect([1, 6].map((n) => selectPpmPluralKey(n, "en"))).toEqual(["one", "other"]);
  });
});
