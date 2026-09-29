/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line U-Web (UX2.1 U6, U8): one events client per tab *and* workspace — ties `client.ts`'s framework-agnostic
 * connection manager to a specific MobX root store, and wires its connection status straight into line S's own poll
 * cadence (`ppm-live-stats/runtime.ts`'s `setLiveStatsPollInterval`) so a live channel slows the 30 s poll down
 * without line S needing to know realtime events exist at all.
 *
 * Review round 2 (U-API's own review): the channel is best-effort, not a guaranteed-complete event stream — bulk,
 * admin, or public-API writes can bypass the server's instrumented publish points — so the poll is never fully
 * suspended while online, only slowed to `PPM_REALTIME_FALLBACK_POLL_MS` (~120 s) as a safety net.
 *
 * The app is expected to switch workspaces without a full page reload (the route is `[workspaceSlug]/...` inside one
 * SPA), so the singleton below is keyed by the root store *and* remembers which workspace it last connected to: a
 * workspace switch tears the old socket down before opening a fresh one, keeping the "one socket per tab" invariant
 * true across the switch, not just within one workspace's lifetime.
 */
import { setLiveStatsPollInterval } from "@/components/ppm-live-stats/runtime";
import { createPpmRealtimeClient } from "./client";
import type { TPpmRealtimeClient, TPpmRealtimeEnv } from "./client";
import type { TPpmRealtimeStore } from "./store-bridge";

/** Review round 2: a rare fallback poll while the channel is live, in case it missed a publish. */
export const PPM_REALTIME_FALLBACK_POLL_MS = 120_000;

export type TPpmRealtimeRuntime = {
  client: TPpmRealtimeClient;
  dispose: () => void;
};

/** Testable factory: env and the URL builder are both injected (see `apps/web/tests/ppm-realtime/runtime.test.ts`). */
export function createPpmRealtimeRuntime(
  store: TPpmRealtimeStore,
  env: TPpmRealtimeEnv,
  buildUrl: () => string
): TPpmRealtimeRuntime {
  const client = createPpmRealtimeClient(env, buildUrl);
  // Reuses this very env for line S too: one set of real timers/visibility listeners behind both, not two.
  const disposeStatus = client.onStatusChange((status) => {
    setLiveStatsPollInterval(store, status === "online" ? PPM_REALTIME_FALLBACK_POLL_MS : undefined, () => env);
  });
  return {
    client,
    dispose: () => {
      disposeStatus();
      client.dispose();
    },
  };
}

type TSingletonEntry = { workspaceSlug: string; runtime: TPpmRealtimeRuntime };
const singletons = new WeakMap<object, TSingletonEntry>();

/**
 * One runtime per (root store, workspace) pair. Switching workspaces disposes the previous one first — its socket is
 * for the old workspace's events and would otherwise leak for the rest of the tab's life.
 */
export function getPpmRealtimeRuntime(
  store: TPpmRealtimeStore,
  workspaceSlug: string,
  createEnv: () => TPpmRealtimeEnv,
  buildUrl: (workspaceSlug: string) => string
): TPpmRealtimeRuntime {
  const existing = singletons.get(store);
  if (existing && existing.workspaceSlug === workspaceSlug) return existing.runtime;
  existing?.runtime.dispose();
  const runtime = createPpmRealtimeRuntime(store, createEnv(), () => buildUrl(workspaceSlug));
  singletons.set(store, { workspaceSlug, runtime });
  return runtime;
}
