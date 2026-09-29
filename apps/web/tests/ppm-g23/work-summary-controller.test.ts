// G2.3 (G-Web, G4): the fetch lifecycle behind the «Что сделано за период» dialog — preset clicks fetch
// immediately (no debounce; they are not typing), an invalid custom range blocks the request client-side, and a
// stale answer is dropped exactly like the search picker's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TPpmGitWorkSummary } from "@/services/ppm-git.service";
import { createWorkSummaryController } from "@/components/ppm-git/insert/work-summary-controller";

function summary(overrides: Partial<TPpmGitWorkSummary> = {}): TPpmGitWorkSummary {
  return {
    from: "2026-09-22",
    to: "2026-09-28",
    totals: { done: 1, in_progress: 0, other: 0, commits: 2, pull_requests: 1 },
    items: [],
    markdown: "# Что сделано",
    html: "<h3>Что сделано</h3>",
    ...overrides,
  };
}

const TODAY = new Date("2026-09-29T12:00:00Z"); // Tuesday

function setup(getSummary = vi.fn().mockResolvedValue(summary())) {
  const controller = createWorkSummaryController({ getSummary, today: () => TODAY });
  return { controller, getSummary };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkSummaryController", () => {
  it("fetches the default 'this_week' range on start", async () => {
    const { controller, getSummary } = setup();
    controller.start();
    expect(controller.getState()).toMatchObject({ preset: "this_week", loading: true });
    await vi.runAllTimersAsync();

    expect(getSummary).toHaveBeenCalledExactlyOnceWith({ from: "2026-09-28", to: "2026-09-29" });
    expect(controller.getState()).toMatchObject({ loading: false, from: "2026-09-28", to: "2026-09-29" });
    expect(controller.getState().summary).toBeDefined();
  });

  it("switching to a computed preset fetches immediately, no debounce", async () => {
    const { controller, getSummary } = setup();
    controller.start();
    await vi.runAllTimersAsync();
    getSummary.mockClear();

    controller.setPreset("last_week");
    await vi.advanceTimersByTimeAsync(0);
    expect(getSummary).toHaveBeenCalledExactlyOnceWith({ from: "2026-09-21", to: "2026-09-27" });
    expect(controller.getState().preset).toBe("last_week");
  });

  it("switching to 'custom' does not fetch until a valid range is set", async () => {
    const { controller, getSummary } = setup();
    controller.start();
    await vi.runAllTimersAsync();
    getSummary.mockClear();

    controller.setPreset("custom");
    expect(getSummary).not.toHaveBeenCalled();
    expect(controller.getState().preset).toBe("custom");
  });

  it("blocks a custom range longer than 92 days client-side, without calling the API", async () => {
    const { controller, getSummary } = setup();
    controller.start();
    await vi.runAllTimersAsync();
    getSummary.mockClear();

    controller.setCustomRange("2026-01-01", "2026-06-01");
    expect(getSummary).not.toHaveBeenCalled();
    expect(controller.getState().rangeError).toMatch(/92/);
    expect(controller.getState().summary).toBeUndefined();
  });

  it("fetches a valid custom range and clears any earlier range error", async () => {
    const { controller, getSummary } = setup();
    controller.start();
    await vi.runAllTimersAsync();

    controller.setCustomRange("2026-01-01", "2026-06-01");
    controller.setCustomRange("2026-09-01", "2026-09-10");
    await vi.runAllTimersAsync();

    expect(getSummary).toHaveBeenLastCalledWith({ from: "2026-09-01", to: "2026-09-10" });
    expect(controller.getState().rangeError).toBeUndefined();
    expect(controller.getState().summary).toBeDefined();
  });

  it("drops a stale answer when a newer preset was already requested", async () => {
    let resolveFirst!: (value: TPpmGitWorkSummary) => void;
    const getSummary = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(summary({ from: "2026-09-21", to: "2026-09-27" }));
    const { controller } = setup(getSummary);

    controller.start();
    controller.setPreset("last_week");
    await vi.runAllTimersAsync();
    resolveFirst(summary({ from: "STALE", to: "STALE" }));
    await Promise.resolve();

    expect(controller.getState().summary?.from).toBe("2026-09-21");
  });

  it("shows a plain-Russian error and clears any previous summary on an API failure", async () => {
    const getSummary = vi.fn().mockRejectedValue(new Error("Не удалось собрать сводку за период."));
    const { controller } = setup(getSummary);
    controller.start();
    await vi.runAllTimersAsync();

    expect(controller.getState()).toMatchObject({
      loading: false,
      summary: undefined,
      error: "Не удалось собрать сводку за период.",
    });
  });
});
