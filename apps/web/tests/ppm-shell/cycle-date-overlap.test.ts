/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R: the sprint dialog warns about overlapping dates before the server does. The rule mirrors
// apps/api/plane/app/views/cycle/base.py CycleDateCheckEndpoint: start at 00:00:01 and end at 23:59 project time,
// compared with lte/gte — whole days, both ends inclusive.
import { describe, expect, it } from "vitest";
import { findPpmCycleOverlaps, toPpmCycleDateKey } from "@/components/cycles/ppm-date-overlap";

const sprint1 = { id: "c1", name: "Спринт 1", start_date: "2026-09-20", end_date: "2026-10-04" };
const draft = { id: "c2", name: "Черновик", start_date: null, end_date: null };
const names = (overlaps: ReturnType<typeof findPpmCycleOverlaps>) => overlaps.map((overlap) => overlap.cycle.name);

// The API sends sprint dates already converted to the project's time zone
// (`user_timezone_converter(…, project_timezone)` in apps/api/plane/app/views/cycle/base.py), and the server decides
// in that zone. The viewer's own time zone — the browser's, modelled here by process.env.TZ — must not move a sprint
// boundary to another day.
const withViewerTimeZone = (timeZone: string, run: () => void) => {
  const saved = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
};

describe("sprint date overlap (line R)", () => {
  it("counts a sprint that ends on the day the new one starts as overlapping (inclusive boundaries)", () => {
    expect(names(findPpmCycleOverlaps([sprint1], { start: "2026-10-04", end: "2026-10-10" }))).toEqual(["Спринт 1"]);
    expect(names(findPpmCycleOverlaps([sprint1], { start: "2026-09-10", end: "2026-09-20" }))).toEqual(["Спринт 1"]);
  });

  it("lets the next sprint start the day after the previous one ends", () => {
    expect(findPpmCycleOverlaps([sprint1], { start: "2026-10-05", end: "2026-10-12" })).toEqual([]);
    expect(findPpmCycleOverlaps([sprint1], { start: "2026-09-01", end: "2026-09-19" })).toEqual([]);
  });

  it("finds a range inside another sprint and a range that covers it", () => {
    expect(names(findPpmCycleOverlaps([sprint1], { start: "2026-09-25", end: "2026-09-26" }))).toEqual(["Спринт 1"]);
    expect(names(findPpmCycleOverlaps([sprint1], { start: "2026-09-01", end: "2026-10-31" }))).toEqual(["Спринт 1"]);
  });

  it("ignores drafts: a range without both dates and sprints without dates never conflict", () => {
    expect(findPpmCycleOverlaps([sprint1], { start: "2026-09-28", end: null })).toEqual([]);
    expect(findPpmCycleOverlaps([sprint1], { start: null, end: null })).toEqual([]);
    expect(findPpmCycleOverlaps([draft], { start: "2026-09-28", end: "2026-10-05" })).toEqual([]);
  });

  it("never reports the sprint being edited", () => {
    expect(findPpmCycleOverlaps([sprint1], { start: "2026-09-21", end: "2026-10-05", cycleId: "c1" })).toEqual([]);
  });

  it("orders several conflicts by end date so the advice uses the latest one", () => {
    const sprint2 = { id: "c3", name: "Спринт 2", start_date: "2026-10-05", end_date: "2026-10-18" };
    const overlaps = findPpmCycleOverlaps([sprint2, sprint1, draft], { start: "2026-09-28", end: "2026-10-06" });
    expect(names(overlaps)).toEqual(["Спринт 1", "Спринт 2"]);
    expect(overlaps.at(-1)?.end).toBe("2026-10-18");
  });

  it("takes the day of a +03:00 project sprint as the project sees it, whatever the viewer's time zone", () => {
    const moscowSprint = {
      id: "c4",
      name: "Спринт МСК",
      start_date: "2026-09-20T00:00:01+03:00",
      end_date: "2026-10-04T23:59:00+03:00",
    };
    for (const viewer of ["Europe/Moscow", "UTC", "America/Los_Angeles", "Asia/Tokyo"])
      withViewerTimeZone(viewer, () => {
        expect(toPpmCycleDateKey(moscowSprint.start_date), viewer).toBe("2026-09-20");
        expect(toPpmCycleDateKey(moscowSprint.end_date), viewer).toBe("2026-10-04");
        expect(names(findPpmCycleOverlaps([moscowSprint], { start: "2026-10-04", end: "2026-10-10" })), viewer).toEqual(
          ["Спринт МСК"]
        );
        expect(findPpmCycleOverlaps([moscowSprint], { start: "2026-10-05", end: "2026-10-10" }), viewer).toEqual([]);
        expect(findPpmCycleOverlaps([moscowSprint], { start: "2026-09-01", end: "2026-09-19" }), viewer).toEqual([]);
      });
  });

  it("does not shift a +00:00 project sprint for a viewer in Moscow (23:59 UTC is already the next day there)", () => {
    const utcSprint = {
      id: "c5",
      name: "Спринт UTC",
      start_date: "2026-09-20T00:00:01+00:00",
      end_date: "2026-10-04T23:59:00+00:00",
    };
    withViewerTimeZone("Europe/Moscow", () => {
      expect(toPpmCycleDateKey(utcSprint.end_date)).toBe("2026-10-04");
      expect(findPpmCycleOverlaps([utcSprint], { start: "2026-10-05", end: "2026-10-12" })).toEqual([]);
      expect(names(findPpmCycleOverlaps([utcSprint], { start: "2026-10-04", end: "2026-10-12" }))).toEqual([
        "Спринт UTC",
      ]);
    });
  });

  it("reads plain dates from the form as they are and rejects anything else", () => {
    expect(toPpmCycleDateKey("2026-10-04")).toBe("2026-10-04");
    expect(toPpmCycleDateKey("not a date")).toBeNull();
    expect(toPpmCycleDateKey(null)).toBeNull();
  });
});
