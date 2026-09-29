// Line U-Web (U8, revised in review round 2): "при открытом канале — не 30-секундный опрос, а редкий страховочный"
// (the channel is best-effort, not a guaranteed-complete stream — bulk/admin/public-API writes can bypass the
// server's instrumented publish points). Minimal, additive change to line S's own scheduler/runtime
// (ppm-live-stats/refresh-scheduler.ts, runtime.ts) — the poll's interval can be overridden from the outside, without
// touching the change/return refresh paths lane S already owns. Own test file (not lane S's), per this line's file
// ownership.
import { describe, expect, it, vi } from "vitest";
import { createLiveStatsScheduler, LIVE_STATS_TIMINGS } from "@/components/ppm-live-stats/refresh-scheduler";
import { getLiveStatsRuntime, setLiveStatsPollInterval } from "@/components/ppm-live-stats/runtime";
import type { TLiveStatsStore } from "@/components/ppm-live-stats/runtime";
import { createFakeLiveStatsEnv } from "../ppm-live-stats/fake-env";

const SPRINT = { type: "cycle", id: "sprint-1" } as const;
const FALLBACK_POLL_MS = 120_000; // stand-in for U-Web's own PPM_REALTIME_FALLBACK_POLL_MS; lane S's API is generic

describe("TLiveStatsScheduler.setPollIntervalOverride (U8, review round 2)", () => {
  it("slows the poll down (not off) while leaving notify()-driven refreshes working", async () => {
    const fake = createFakeLiveStatsEnv();
    const scheduler = createLiveStatsScheduler(fake.env);
    const refresh = vi.fn(async () => undefined);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);
    scheduler.setPollIntervalOverride(FALLBACK_POLL_MS);

    // the normal 30s cadence must not fire any more...
    await fake.advance(LIVE_STATS_TIMINGS.pollMs * 2);
    expect(refresh).not.toHaveBeenCalled();
    // ...but the slower fallback still does, eventually.
    await fake.advance(FALLBACK_POLL_MS - LIVE_STATS_TIMINGS.pollMs * 2);
    expect(refresh).toHaveBeenCalledWith("poll");

    refresh.mockClear();
    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    expect(refresh).toHaveBeenCalledWith("change");
  });

  it("restores the normal 30s cadence once the override is cleared", async () => {
    const fake = createFakeLiveStatsEnv();
    const scheduler = createLiveStatsScheduler(fake.env);
    const refresh = vi.fn(async () => undefined);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);
    scheduler.setPollIntervalOverride(FALLBACK_POLL_MS);
    scheduler.setPollIntervalOverride(undefined);

    await fake.advance(LIVE_STATS_TIMINGS.pollMs);
    expect(refresh).toHaveBeenCalledWith("poll");
  });

  it("changing the override mid-flight re-arms the timer at the new interval", async () => {
    const fake = createFakeLiveStatsEnv();
    const scheduler = createLiveStatsScheduler(fake.env);
    const refresh = vi.fn(async () => undefined);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.advance(LIVE_STATS_TIMINGS.pollMs - 100);
    scheduler.setPollIntervalOverride(FALLBACK_POLL_MS);
    // the pending 30s-cadence firing (due in 100ms) must not have survived the re-arm
    await fake.advance(200);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an overridden-before-any-panel scheduler still starts up idle (no timer, no listener)", () => {
    const fake = createFakeLiveStatsEnv();
    const scheduler = createLiveStatsScheduler(fake.env);
    scheduler.setPollIntervalOverride(FALLBACK_POLL_MS);
    expect(scheduler.isIdle()).toBe(true);
    expect(fake.timerCount()).toBe(0);
  });
});

describe("setLiveStatsPollInterval (runtime helper, U8, review round 2)", () => {
  function fakeRootStore(): TLiveStatsStore {
    return {
      issue: { issues: { issuesMap: {} } },
      cycle: { cycleMap: {} },
      module: { moduleMap: {} },
    } as TLiveStatsStore;
  }

  it("overrides the interval of panels watched after the call, on the same store", async () => {
    const fake = createFakeLiveStatsEnv();
    const store = fakeRootStore();
    setLiveStatsPollInterval(store, FALLBACK_POLL_MS, () => fake.env);

    const refresh = vi.fn(async () => undefined);
    getLiveStatsRuntime(store, () => fake.env).watch("cycle-stats:sprint-1", SPRINT, refresh);
    await fake.advance(LIVE_STATS_TIMINGS.pollMs * 2);
    expect(refresh).not.toHaveBeenCalled();
    await fake.advance(FALLBACK_POLL_MS - LIVE_STATS_TIMINGS.pollMs * 2);
    expect(refresh).toHaveBeenCalledWith("poll");
  });

  it("never throws for a store with no runtime yet and no panels", () => {
    const fake = createFakeLiveStatsEnv();
    const store = fakeRootStore();
    expect(() => setLiveStatsPollInterval(store, FALLBACK_POLL_MS, () => fake.env)).not.toThrow();
    expect(() => setLiveStatsPollInterval(store, undefined, () => fake.env)).not.toThrow();
  });
});
