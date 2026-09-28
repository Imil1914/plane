/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S3: on «Выгорание задач» the «Фактически» line used to fall to 0 on every future day although nothing was
// closed — the API sends `null` for days after today and the chart turned it into 0. «Фактически» now stops at today
// (future days: no point, no line), «План» still spans the whole sprint, a completed sprint is drawn as before.
import { describe, expect, it } from "vitest";
import { buildBurndownChartData, toLocalDateKey } from "@/components/ppm-live-stats/burndown-chart-data";

const SPRINT = {
  "2026-09-26": 4,
  "2026-09-27": 4,
  "2026-09-28": 3,
  "2026-09-29": null,
  "2026-09-30": null,
};

describe("line S3: burndown points", () => {
  it("«Фактически» ends at today inclusive; future days carry no value (a gap, not a zero)", () => {
    const points = buildBurndownChartData(SPRINT, 4, { today: "2026-09-28" });

    expect(points.map((point) => point.current)).toEqual([4, 4, 3, null, null]);
    expect(points.map((point) => point.date)).toEqual(Object.keys(SPRINT));
  });

  it("even a value the server already sent for a day after the viewer's today is not drawn yet", () => {
    const points = buildBurndownChartData({ ...SPRINT, "2026-09-29": 3 }, 4, { today: "2026-09-28" });
    expect(points[3].current).toBeNull();
  });

  it("a day the server has no value for yet (its clock is behind) is a gap, never an invented 0", () => {
    const points = buildBurndownChartData({ ...SPRINT, "2026-09-28": null }, 4, { today: "2026-09-28" });
    expect(points.map((point) => point.current)).toEqual([4, 4, null, null, null]);
  });

  it("«План» spans the whole sprint: from the total on the first day to 0 on the last", () => {
    const points = buildBurndownChartData(SPRINT, 4, { today: "2026-09-28" });
    expect(points.map((point) => point.ideal)).toEqual([4, 3, 2, 1, 0]);
  });

  it("a completed sprint is drawn exactly as before (every day, a missing value as 0)", () => {
    const completed = { "2026-09-01": 5, "2026-09-02": null, "2026-09-03": 1 };
    const upstream = Object.keys(completed).map((key, index) => ({
      current: completed[key as keyof typeof completed] ?? 0,
      ideal: 5 * (1 - index / (Object.keys(completed).length - 1)),
    }));

    const points = buildBurndownChartData(completed, 5, { today: "2026-09-28", isCompleted: true });

    expect(points.map(({ current, ideal }) => ({ current, ideal }))).toEqual(upstream);
  });

  it("a past sprint that is not marked completed keeps all its (past) values", () => {
    const past = { "2026-09-01": 5, "2026-09-02": 2 };
    expect(buildBurndownChartData(past, 5, { today: "2026-09-28" }).map((point) => point.current)).toEqual([5, 2]);
  });

  it("labels the x axis with the given date formatter (the Russian one in the Russian interface)", () => {
    const points = buildBurndownChartData(SPRINT, 4, {
      today: "2026-09-28",
      formatLabel: (date) => `label:${date}`,
    });
    expect(points[0].name).toBe("label:2026-09-26");
  });

  it("date keys with a time part are compared by their calendar day", () => {
    const points = buildBurndownChartData({ "2026-09-28T00:00:00": 2, "2026-09-29T00:00:00": null }, 2, {
      today: "2026-09-28",
    });
    expect(points.map((point) => point.current)).toEqual([2, null]);
  });

  it("an empty or one-day distribution does not produce NaN", () => {
    expect(buildBurndownChartData(undefined, 3, { today: "2026-09-28" })).toEqual([]);
    const [only] = buildBurndownChartData({ "2026-09-28": 3 }, 3, { today: "2026-09-28" });
    expect(Number.isNaN(only.ideal)).toBe(false);
    expect(only.current).toBe(3);
  });

  it("today is the viewer's local calendar day", () => {
    expect(toLocalDateKey(new Date(2026, 8, 28, 23, 59))).toBe("2026-09-28");
    expect(toLocalDateKey(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });
});
