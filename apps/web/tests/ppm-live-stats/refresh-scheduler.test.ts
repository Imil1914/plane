/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S (owner decision 2026-09-28): the numbers and charts of a sprint/module on screen re-read themselves —
// (a) shortly after a change made in this tab (one coalesced request, not an avalanche), (b) when the user comes back
// to the tab/window, (c) every 30 s while the tab is visible (a hidden tab is never polled). Leaving the page leaves
// no timer and no listener behind.
import { describe, expect, it, vi } from "vitest";
import {
  bindRefreshToKey,
  createBrowserLiveStatsEnv,
  createLiveStatsScheduler,
  LIVE_STATS_TIMINGS,
} from "@/components/ppm-live-stats/refresh-scheduler";
import type { TLiveStatsReason } from "@/components/ppm-live-stats/refresh-scheduler";
import { createFakeLiveStatsEnv, flushPromises, repeat } from "./fake-env";

const SPRINT = { type: "cycle", id: "sprint-1" } as const;
const OTHER_SPRINT = { type: "cycle", id: "sprint-2" } as const;
const MODULE = { type: "module", id: "module-1" } as const;

function setup(visible = true) {
  const fake = createFakeLiveStatsEnv(visible);
  const scheduler = createLiveStatsScheduler(fake.env);
  const calls: TLiveStatsReason[] = [];
  const refresh = vi.fn(async (reason: TLiveStatsReason) => {
    calls.push(reason);
  });
  return { fake, scheduler, calls, refresh };
}

describe("line S: timings follow the owner's decision", () => {
  it("coalesces changes for 300–800 ms, polls every 30 s", () => {
    expect(LIVE_STATS_TIMINGS.changeDebounceMs).toBeGreaterThanOrEqual(300);
    expect(LIVE_STATS_TIMINGS.changeDebounceMs).toBeLessThanOrEqual(800);
    expect(LIVE_STATS_TIMINGS.pollMs).toBe(30_000);
  });
});

describe("line S (a): a change that touches the sprint → one coalesced request", () => {
  it("five quick changes to the watched sprint end in exactly one refresh, after the pause", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await repeat(5, async () => {
      scheduler.notify([SPRINT]);
      await fake.advance(100);
    });
    expect(refresh).not.toHaveBeenCalled();

    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs - 100 - 1);
    expect(refresh).not.toHaveBeenCalled();
    await fake.advance(1);
    expect(calls).toEqual(["change"]);

    await fake.advance(5000);
    expect(calls).toEqual(["change"]);
  });

  it("changes of another sprint or a module do not refresh this sprint", async () => {
    const { fake, scheduler, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    scheduler.notify([OTHER_SPRINT, MODULE]);
    await fake.advance(5000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("one change refreshes every panel of that sprint once (stats and priority list), a module only its own", async () => {
    const { fake, scheduler } = setup();
    const stats = vi.fn(async () => undefined);
    const priority = vi.fn(async () => undefined);
    const moduleStats = vi.fn(async () => undefined);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, stats);
    scheduler.watch("cycle-priority:sprint-1", SPRINT, priority);
    scheduler.watch("module-stats:module-1", MODULE, moduleStats);

    scheduler.notify([SPRINT, SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);

    expect(stats).toHaveBeenCalledTimes(1);
    expect(priority).toHaveBeenCalledTimes(1);
    expect(moduleStats).not.toHaveBeenCalled();
  });

  it("a stream of changes still refreshes at least every few seconds (no starvation)", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await repeat(Math.ceil(LIVE_STATS_TIMINGS.changeMaxWaitMs / 400), async () => {
      scheduler.notify([SPRINT]);
      await fake.advance(400);
    });

    expect(calls).toEqual(["change"]);
  });

  it("a change during a running refresh leads to exactly one more refresh once it finishes", async () => {
    const { fake, scheduler } = setup();
    let release: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    expect(refresh).toHaveBeenCalledTimes(1);

    release?.();
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith("change");

    release?.();
    await fake.advance(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a failing refresh does not stop later refreshes", async () => {
    const { fake, scheduler } = setup();
    const refresh = vi.fn(async () => {
      throw new Error("network");
    });
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    await fake.advance(LIVE_STATS_TIMINGS.pollMs);

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("line S (c): every 30 s while the tab is visible, never while it is hidden", () => {
  it("polls every 30 s on a visible tab", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.advance(LIVE_STATS_TIMINGS.pollMs - 1);
    expect(refresh).not.toHaveBeenCalled();
    await fake.advance(1);
    await fake.advance(2 * LIVE_STATS_TIMINGS.pollMs);

    expect(calls).toEqual(["poll", "poll", "poll"]);
  });

  it("a hidden tab is not polled and keeps no timer", async () => {
    const { fake, scheduler, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.setVisible(false);
    expect(fake.timerCount()).toBe(0);
    await fake.advance(10 * LIVE_STATS_TIMINGS.pollMs);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("a page opened in a background tab starts polling only after the tab is shown", async () => {
    const { fake, scheduler, calls, refresh } = setup(false);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);
    expect(fake.timerCount()).toBe(0);

    await fake.advance(3 * LIVE_STATS_TIMINGS.pollMs);
    expect(refresh).not.toHaveBeenCalled();

    await fake.setVisible(true);
    await fake.advance(LIVE_STATS_TIMINGS.pollMs);
    expect(calls).toEqual(["return", "poll"]);
  });
});

describe("line S (b): coming back to the tab or window refreshes at once", () => {
  it("showing the tab again refreshes immediately and restarts the 30 s clock", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.advance(10_000);
    await fake.setVisible(false);
    await fake.advance(5 * 60_000);
    await fake.setVisible(true);
    expect(calls).toEqual(["return"]);

    await fake.advance(LIVE_STATS_TIMINGS.pollMs - 1);
    expect(calls).toEqual(["return"]);
    await fake.advance(1);
    expect(calls).toEqual(["return", "poll"]);
  });

  it("focusing the window again (another app was in front) also refreshes", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.advance(20_000);
    await fake.focusWindow();

    expect(calls).toEqual(["return"]);
  });

  it("the visibilitychange and focus of one return give a single refresh", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.advance(20_000);
    await fake.setVisible(false);
    await fake.setVisible(true);
    await fake.advance(LIVE_STATS_TIMINGS.returnPairMs - 100);
    await fake.focusWindow();

    expect(calls).toEqual(["return"]);
  });

  // Fix round 1 (review): a return 3 s after a poll used to be skipped — the tasks edited in another tab meanwhile
  // stayed invisible for another 30 s.
  it("every return refreshes, even right after a poll; the 30 s clock restarts from the return", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.advance(LIVE_STATS_TIMINGS.pollMs);
    await fake.advance(1000);
    await fake.setVisible(false);
    await fake.advance(3000);
    await fake.setVisible(true);
    expect(calls).toEqual(["poll", "return"]);

    await fake.advance(LIVE_STATS_TIMINGS.pollMs - 1);
    expect(calls).toEqual(["poll", "return"]);
    await fake.advance(1);
    expect(calls).toEqual(["poll", "return", "poll"]);
  });

  it("a second return a moment later is a new return and refreshes again", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    await fake.advance(20_000);
    await fake.focusWindow();
    await fake.advance(LIVE_STATS_TIMINGS.returnPairMs + 500);
    await fake.setVisible(false);
    await fake.setVisible(true);

    expect(calls).toEqual(["return", "return"]);
  });
});

describe("line S (fix round 1): every panel keeps its own refresh", () => {
  // Review: «Подробнее» on the active sprint A, then on sprint B — the same sidebar re-registers for B, but the shared
  // key of A kept the sidebar's function, so polling re-read B twice and A never.
  it("a panel that moves to another sprint no longer refreshes the first one through the shared key", async () => {
    const { fake, scheduler } = setup();
    const panelA = vi.fn(async () => undefined);
    const sidebarA = vi.fn(async () => undefined);
    const sidebarB = vi.fn(async () => undefined);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, panelA);
    const unwatchSidebarA = scheduler.watch("cycle-stats:sprint-1", SPRINT, sidebarA);
    unwatchSidebarA();
    scheduler.watch("cycle-stats:sprint-2", OTHER_SPRINT, sidebarB);

    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    expect(panelA).toHaveBeenCalledTimes(1);
    expect(sidebarA).not.toHaveBeenCalled();
    expect(sidebarB).not.toHaveBeenCalled();

    await fake.advance(LIVE_STATS_TIMINGS.pollMs);
    expect(panelA).toHaveBeenCalledTimes(2);
    expect(sidebarA).not.toHaveBeenCalled();
    expect(sidebarB).toHaveBeenCalledTimes(1);
  });

  it("while two panels share a key a trigger still runs one refresh; the last one to leave takes nothing along", async () => {
    const { fake, scheduler } = setup();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const unwatchFirst = scheduler.watch("cycle-stats:sprint-1", SPRINT, first);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, second);

    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);

    unwatchFirst();
    await fake.advance(LIVE_STATS_TIMINGS.pollMs);
    expect(first.mock.calls.length + second.mock.calls.length).toBe(2);
    expect(second.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("a panel's registration keeps refreshing the sprint it registered, even if the panel already shows another one", async () => {
    const registered = vi.fn();
    const next = vi.fn();
    const latest = { current: { key: "cycle-stats:sprint-1", refresh: registered } };
    const bound = bindRefreshToKey("cycle-stats:sprint-1", registered, latest);

    await bound("poll");
    latest.current = { key: "cycle-stats:sprint-2", refresh: next };
    await bound("change");

    expect(registered).toHaveBeenCalledTimes(2);
    expect(registered).toHaveBeenLastCalledWith("change");
    expect(next).not.toHaveBeenCalled();
  });

  it("a panel's registration uses the latest refresh of the same key (fresh closures without re-registering)", async () => {
    const registered = vi.fn();
    const newer = vi.fn();
    const latest = { current: { key: "cycle-stats:sprint-1", refresh: registered } };
    const bound = bindRefreshToKey("cycle-stats:sprint-1", registered, latest);

    latest.current = { key: "cycle-stats:sprint-1", refresh: newer };
    await bound("poll");

    expect(newer).toHaveBeenCalledWith("poll");
    expect(registered).not.toHaveBeenCalled();
  });
});

describe("line S: a panel that opens over numbers already in the tab re-reads them at once", () => {
  // The owner's case: the task was added and assigned in the task list; the sprint panel opened afterwards showed the
  // numbers cached from the previous visit (its first load is skipped when data is cached) until a reload.
  it("opening over cached numbers refreshes immediately; opening without them leaves the first load to the panel", async () => {
    const { scheduler, calls, refresh } = setup();
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh, { refreshNow: true });
    await flushPromises();
    expect(calls).toEqual(["return"]);

    const fresh = vi.fn(async () => undefined);
    scheduler.watch("module-stats:module-1", MODULE, fresh);
    await flushPromises();
    expect(fresh).not.toHaveBeenCalled();
  });

  it("two panels of the same sprint opening together, or a panel re-mounted at once, refresh once", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    const unwatchPanel = scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh, { refreshNow: true });
    const unwatchSidebar = scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh, { refreshNow: true });
    await flushPromises();
    // React StrictMode in development, or a quick collapse/expand of the panel
    unwatchPanel();
    unwatchSidebar();
    await fake.advance(300);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh, { refreshNow: true });
    await flushPromises();

    expect(calls).toEqual(["return"]);
  });

  it("a panel opened again later re-reads again", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    const unwatch = scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh, { refreshNow: true });
    await flushPromises();
    unwatch();
    await fake.advance(LIVE_STATS_TIMINGS.watchDedupMs);
    scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh, { refreshNow: true });
    await flushPromises();

    expect(calls).toEqual(["return", "return"]);
  });
});

describe("line S: leaving the page leaves nothing behind", () => {
  it("the last unwatch clears every timer and listener; a pending change refresh never fires", async () => {
    const { fake, scheduler, refresh } = setup();
    const unwatch = scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);
    expect(fake.listenerCount()).toBe(1);
    expect(fake.timerCount()).toBe(1);

    scheduler.notify([SPRINT]);
    expect(fake.timerCount()).toBe(2);
    unwatch();

    expect(fake.timerCount()).toBe(0);
    expect(fake.listenerCount()).toBe(0);
    expect(scheduler.isIdle()).toBe(true);
    await fake.advance(10 * LIVE_STATS_TIMINGS.pollMs);
    await fake.setVisible(false);
    await fake.setVisible(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("two panels of the same sprint share one refresh, which stays until the last of them is gone", async () => {
    const { fake, scheduler, calls, refresh } = setup();
    const unwatchPanel = scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);
    const unwatchSidebar = scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);

    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    expect(calls).toEqual(["change"]);

    unwatchPanel();
    unwatchPanel();
    await fake.advance(LIVE_STATS_TIMINGS.pollMs);
    expect(calls).toEqual(["change", "poll"]);

    unwatchSidebar();
    expect(fake.timerCount()).toBe(0);
    expect(fake.listenerCount()).toBe(0);
  });

  it("a refresh that finishes after the page was left does not schedule anything", async () => {
    const { fake, scheduler } = setup();
    let release: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const unwatch = scheduler.watch("cycle-stats:sprint-1", SPRINT, refresh);
    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    scheduler.notify([SPRINT]);
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);

    unwatch();
    release?.();
    await flushPromises();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fake.timerCount()).toBe(0);
  });
});

describe("line S: the browser wiring", () => {
  function fakeTarget() {
    const listeners = new Map<string, Set<() => void>>();
    return {
      listeners,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      }),
    };
  }

  it("listens to visibilitychange on the document and focus on the window, and removes both", () => {
    const documentTarget = { ...fakeTarget(), visibilityState: "visible" };
    const windowTarget = fakeTarget();
    const env = createBrowserLiveStatsEnv({ document: documentTarget, window: windowTarget });
    const listener = vi.fn();

    const unsubscribe = env.subscribeReturn(listener);
    expect(documentTarget.listeners.get("visibilitychange")?.size).toBe(1);
    expect(windowTarget.listeners.get("focus")?.size).toBe(1);
    expect(env.isVisible()).toBe(true);
    documentTarget.visibilityState = "hidden";
    expect(env.isVisible()).toBe(false);

    unsubscribe();
    expect(documentTarget.listeners.get("visibilitychange")?.size).toBe(0);
    expect(windowTarget.listeners.get("focus")?.size).toBe(0);
  });
});
