/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S: a deterministic stand-in for the browser (timers, clock, tab visibility, "the user came back" events) so the
// live-stats scheduling rules can be checked step by step, including "no timer and no listener is left behind".
import type { TLiveStatsEnv } from "@/components/ppm-live-stats/refresh-scheduler";

/** Lets every pending promise callback run (one real macrotask). */
export const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs `step` `times` times, one after another. */
export const repeat = async (
  times: number,
  step: (index: number) => Promise<void> | void,
  index = 0
): Promise<void> => {
  if (index >= times) return;
  await step(index);
  return repeat(times, step, index + 1);
};

export function createFakeLiveStatsEnv(initiallyVisible = true) {
  let now = 0;
  let visible = initiallyVisible;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Set<() => void>();

  const env: TLiveStatsEnv = {
    setTimer: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
    isVisible: () => visible,
    subscribeReturn: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const nextDue = (until: number) => {
    let due: { id: number; at: number; callback: () => void } | undefined;
    for (const [id, timer] of timers) {
      if (timer.at <= until && (!due || timer.at < due.at)) due = { id, ...timer };
    }
    return due;
  };

  /** Moves the clock forward, firing due timers in order and letting promise callbacks settle after each one. */
  async function advance(ms: number) {
    const target = now + ms;
    const fireNext = async (): Promise<void> => {
      const due = nextDue(target);
      if (!due) return;
      timers.delete(due.id);
      now = due.at;
      due.callback();
      await flushPromises();
      return fireNext();
    };
    await fireNext();
    now = target;
    await flushPromises();
  }

  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };

  /** The tab becomes hidden/visible: the browser fires `visibilitychange`. */
  async function setVisible(value: boolean) {
    visible = value;
    notifyListeners();
    await flushPromises();
  }

  /** The window gets focus back while the tab stays visible (another app was in front). */
  async function focusWindow() {
    notifyListeners();
    await flushPromises();
  }

  return {
    env,
    advance,
    setVisible,
    focusWindow,
    timerCount: () => timers.size,
    listenerCount: () => listeners.size,
    now: () => now,
  };
}
