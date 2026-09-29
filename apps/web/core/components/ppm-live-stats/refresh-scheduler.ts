/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line S (owner decision 2026-09-28): the numbers and charts of the sprints and modules that are on screen re-read
 * themselves —
 *  (a) shortly after this tab changed one of their work items: changes are coalesced for a moment, so a burst of edits
 *      becomes one request, not an avalanche;
 *  (b) when the user comes back to the tab or window;
 *  (c) every 30 s while the tab is visible — a hidden tab is never polled.
 * One refresh per panel runs at a time; a trigger that arrives meanwhile runs once more afterwards. When the last
 * panel goes away every timer and listener is removed. Full real-time for all members is a separate task.
 * Panels showing the same data share a key (one refresh per trigger), but each keeps its own refresh function: a panel
 * that switches to another sprint takes its function along and never refreshes the wrong sprint through the old key.
 *
 * The browser (timers, clock, visibility, focus) is injected so the rules can be checked step by step in tests.
 */

export type TLiveStatsSubjectType = "cycle" | "module";

/** A sprint (cycle) or module (направление) whose numbers are on screen. */
export type TLiveStatsSubject = { type: TLiveStatsSubjectType; id: string };

/** Why a refresh runs: a change made in this tab, the 30 s poll, or the user coming back to the tab/window. */
export type TLiveStatsReason = "change" | "poll" | "return";

export type TLiveStatsRefresh = (reason: TLiveStatsReason) => unknown;

export type TLiveStatsEnv = {
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
  isVisible: () => boolean;
  /** Calls `listener` when the tab's visibility or the window's focus may have changed; returns the unsubscribe. */
  subscribeReturn: (listener: () => void) => () => void;
};

export const LIVE_STATS_TIMINGS = {
  /** (a) quiet period after the last change before the numbers are re-read */
  changeDebounceMs: 700,
  /** (a) a steady stream of changes still refreshes at least this often */
  changeMaxWaitMs: 3000,
  /** (c) polling period of a visible tab */
  pollMs: 30_000,
  /** (b) one return fires `visibilitychange` and `focus` together: the second event within this window is the same
   *  return; any later return refreshes, even right after a poll */
  returnPairMs: 1000,
  /** a panel that opens over cached numbers re-reads them, unless its data was re-read this recently */
  watchDedupMs: 1000,
} as const;

export type TLiveStatsTimings = { [K in keyof typeof LIVE_STATS_TIMINGS]: number };

export type TLiveStatsScheduler = {
  /**
   * Registers a panel; returns its unwatch (idempotent). Panels with the same key share one refresh. `refreshNow`: the
   * panel opens over numbers already in the tab (its own first load is skipped then), so they are re-read at once.
   */
  watch: (
    key: string,
    subject: TLiveStatsSubject,
    refresh: TLiveStatsRefresh,
    options?: { refreshNow?: boolean }
  ) => () => void;
  /** Work items of these subjects were changed in this tab. */
  notify: (subjects: readonly TLiveStatsSubject[]) => void;
  /** No panel is watched: no timer, no listener. */
  isIdle: () => boolean;
  /**
   * PPM line U-Web (UX2.1 U8, revised in review round 2): while a realtime events channel is live, this overrides the
   * 30 s poll interval with a much slower one (the channel is best-effort, not a guaranteed-complete stream — bulk,
   * admin, or public-API writes can bypass the instrumented publish points, per U-API's own review — so the poll
   * never fully stops, only slows down). `intervalMs` replaces `timings.pollMs` for scheduling; `undefined` restores
   * the normal cadence. Re-arms the poll timer immediately with the new interval. Does not affect `notify()` or the
   * tab-return refresh, which keep their normal timings regardless of this override.
   */
  setPollIntervalOverride: (intervalMs: number | undefined) => void;
};

type TEntry = {
  subject: TLiveStatsSubject;
  /** each panel's own refresh, in registration order; a trigger runs the latest one */
  subscribers: Map<number, TLiveStatsRefresh>;
  running: boolean;
  queued: TLiveStatsReason | undefined;
};

const latestSubscriber = (entry: TEntry): TLiveStatsRefresh | undefined => {
  let latest: TLiveStatsRefresh | undefined;
  for (const refresh of entry.subscribers.values()) latest = refresh;
  return latest;
};

/**
 * The function a panel registers under `key`: it calls the panel's latest refresh (fresh closures without
 * re-registering) while the panel still shows that key, and the refresh it registered with otherwise — so a panel that
 * already switched to another sprint can never refresh that one through its old registration.
 */
export function bindRefreshToKey(
  key: string,
  registered: TLiveStatsRefresh,
  latest: { current: { key: string; refresh: TLiveStatsRefresh } }
): TLiveStatsRefresh {
  return (reason) => (latest.current.key === key ? latest.current.refresh : registered)(reason);
}

// A change refresh may re-read more than a poll (e.g. sprint members), so it wins when triggers are merged.
const REASON_WEIGHT: Record<TLiveStatsReason, number> = { poll: 0, return: 1, change: 2 };
const strongest = (a: TLiveStatsReason | undefined, b: TLiveStatsReason): TLiveStatsReason =>
  a && REASON_WEIGHT[a] >= REASON_WEIGHT[b] ? a : b;

const sameSubject = (a: TLiveStatsSubject, b: TLiveStatsSubject) => a.type === b.type && a.id === b.id;

export function createLiveStatsScheduler(
  env: TLiveStatsEnv,
  timings: TLiveStatsTimings = LIVE_STATS_TIMINGS
): TLiveStatsScheduler {
  const entries = new Map<string, TEntry>();
  const dirty = new Set<string>();
  let changeTimer: unknown;
  let firstChangeAt: number | undefined;
  let pollTimer: unknown;
  // PPM line U-Web (U8, review round 2): overrides `timings.pollMs` while a realtime channel is live; see
  // `setPollIntervalOverride`. `undefined` means "use the normal 30s cadence".
  let pollIntervalOverrideMs: number | undefined;
  let lastReturnAt = Number.NEGATIVE_INFINITY;
  let unsubscribeReturn: (() => void) | undefined;
  let nextSubscriberId = 1;
  // when each key was last re-read; outlives its panels so a re-mounted panel does not re-read twice in a row
  const lastStartedAt = new Map<string, number>();

  const clearChangeTimer = () => {
    if (changeTimer !== undefined) env.clearTimer(changeTimer);
    changeTimer = undefined;
    firstChangeAt = undefined;
  };

  const clearPollTimer = () => {
    if (pollTimer !== undefined) env.clearTimer(pollTimer);
    pollTimer = undefined;
  };

  const run = (key: string, reason: TLiveStatsReason) => {
    const entry = entries.get(key);
    const refresh = entry && latestSubscriber(entry);
    if (!entry || !refresh) return;
    if (entry.running) {
      entry.queued = strongest(entry.queued, reason);
      return;
    }
    entry.running = true;
    lastStartedAt.set(key, env.now());
    const settle = async () => {
      try {
        await refresh(reason);
      } catch {
        // a failed refresh keeps the previous numbers; the next trigger tries again
      }
      entry.running = false;
      // the panel was closed meanwhile: nothing more for it
      if (entries.get(key) !== entry) return;
      const queued = entry.queued;
      entry.queued = undefined;
      if (queued) run(key, queued);
    };
    void settle();
  };

  const flushChanges = () => {
    changeTimer = undefined;
    firstChangeAt = undefined;
    const keys = [...dirty];
    dirty.clear();
    for (const key of keys) run(key, "change");
  };

  const refreshAll = (reason: TLiveStatsReason) => {
    // a pending change refresh is folded into this one, keeping its stronger reason
    for (const key of entries.keys()) run(key, dirty.has(key) ? "change" : reason);
    dirty.clear();
    clearChangeTimer();
  };

  const schedulePoll = () => {
    clearPollTimer();
    if (entries.size === 0 || !env.isVisible()) return;
    const interval = pollIntervalOverrideMs ?? timings.pollMs;
    pollTimer = env.setTimer(() => {
      pollTimer = undefined;
      if (entries.size > 0 && env.isVisible()) refreshAll("poll");
      schedulePoll();
    }, interval);
  };

  const handleReturn = () => {
    if (entries.size === 0) return;
    if (!env.isVisible()) {
      clearPollTimer();
      return;
    }
    const now = env.now();
    if (now - lastReturnAt >= timings.returnPairMs) {
      lastReturnAt = now;
      refreshAll("return");
    }
    schedulePoll();
  };

  const start = () => {
    unsubscribeReturn = env.subscribeReturn(handleReturn);
    schedulePoll();
  };

  const stop = () => {
    clearChangeTimer();
    clearPollTimer();
    dirty.clear();
    unsubscribeReturn?.();
    unsubscribeReturn = undefined;
    lastReturnAt = Number.NEGATIVE_INFINITY;
  };

  const watch: TLiveStatsScheduler["watch"] = (key, subject, refresh, options = {}) => {
    const subscriberId = nextSubscriberId;
    nextSubscriberId += 1;
    let entry = entries.get(key);
    if (entry) {
      entry.subscribers.set(subscriberId, refresh);
    } else {
      entry = { subject, subscribers: new Map([[subscriberId, refresh]]), running: false, queued: undefined };
      entries.set(key, entry);
      if (entries.size === 1) start();
    }
    const registeredEntry = entry;
    const recentlyRead = env.now() - (lastStartedAt.get(key) ?? Number.NEGATIVE_INFINITY) < timings.watchDedupMs;
    if (options.refreshNow && !entry.running && !recentlyRead) run(key, "return");
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      // only this panel's own function leaves; the others of the key keep theirs
      registeredEntry.subscribers.delete(subscriberId);
      if (registeredEntry.subscribers.size > 0 || entries.get(key) !== registeredEntry) return;
      entries.delete(key);
      dirty.delete(key);
      if (dirty.size === 0) clearChangeTimer();
      if (entries.size === 0) stop();
    };
  };

  const notify: TLiveStatsScheduler["notify"] = (subjects) => {
    let marked = false;
    for (const [key, entry] of entries) {
      if (subjects.some((subject) => sameSubject(subject, entry.subject))) {
        dirty.add(key);
        marked = true;
      }
    }
    if (!marked) return;
    const now = env.now();
    if (firstChangeAt === undefined) firstChangeAt = now;
    const wait = Math.max(0, Math.min(timings.changeDebounceMs, firstChangeAt + timings.changeMaxWaitMs - now));
    if (changeTimer !== undefined) env.clearTimer(changeTimer);
    changeTimer = env.setTimer(flushChanges, wait);
  };

  const setPollIntervalOverride: TLiveStatsScheduler["setPollIntervalOverride"] = (intervalMs) => {
    if (pollIntervalOverrideMs === intervalMs) return;
    pollIntervalOverrideMs = intervalMs;
    // Re-arms with the new interval; safe with no panels or a hidden tab (`schedulePoll` no-ops then).
    schedulePoll();
  };

  return { watch, notify, isIdle: () => entries.size === 0, setPollIntervalOverride };
}

type TLiveStatsEventTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

/** The real browser: `document.visibilityState` + `visibilitychange`, the window's `focus`, `setTimeout`. */
export function createBrowserLiveStatsEnv(
  targets: {
    document?: TLiveStatsEventTarget & { visibilityState?: string };
    window?: TLiveStatsEventTarget;
  } = {
    document: typeof document === "undefined" ? undefined : document,
    window: typeof window === "undefined" ? undefined : window,
  }
): TLiveStatsEnv {
  const documentTarget = targets.document;
  const windowTarget = targets.window;
  return {
    setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    isVisible: () => documentTarget?.visibilityState !== "hidden",
    subscribeReturn: (listener) => {
      documentTarget?.addEventListener("visibilitychange", listener);
      windowTarget?.addEventListener("focus", listener);
      return () => {
        documentTarget?.removeEventListener("visibilitychange", listener);
        windowTarget?.removeEventListener("focus", listener);
      };
    },
  };
}
