/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line U-Web (UX2.1 U6-U8): one events-socket connection per tab and workspace.
 *
 * Framework-agnostic on purpose (no MobX, no React, no `window`/`document`): every effect the outside world can have —
 * opening a socket, a clock, a timer, whether the tab is visible, a random number for jitter — is injected through
 * `TPpmRealtimeEnv`, the same shape `ppm-live-stats/refresh-scheduler.ts` uses for its own scheduler. That is what lets
 * this file be checked step by step with a fake socket and a fake clock in `apps/web/tests/ppm-realtime/**`, in the
 * plain `node` vitest environment (no jsdom, no real timers).
 *
 * Screens (project layout, "My work") ref-count their interest in a project with `subscribeProject`: several screens
 * open on the same project share one `subscribe` message, and the project leaves the socket's subscription only once
 * the last screen unmounts. Incoming `event` messages are coalesced for ~300 ms (a steady stream still flushes at
 * least every `eventMaxWaitMs`) into one batch per flush, so a burst of changes becomes one point refetch per
 * resource, not an avalanche. A hidden tab is never flushed: events keep accumulating and are delivered once, the
 * moment the tab is shown again. A dropped connection reconnects with a growing, jittered pause; `4401`/`4403`/`4404`
 * (channel disabled server-side)/`1009` are terminal (the caller's own line-S polling stays as the fallback) —
 * everything else retries, though `4429` (too many subscriptions/messages) permanently raises the backoff ceiling for
 * the rest of the session instead of ever resetting to a fast retry (review round 2). After a connection that needed
 * a retry re-establishes its subscriptions, `onResync` fires once so the caller can catch up on whatever it missed
 * while the socket was down.
 */
import {
  PPM_REALTIME_CLOSE_CODE,
  PPM_REALTIME_MAX_SUBSCRIPTIONS,
  PPM_REALTIME_TERMINAL_CLOSE_CODES,
  PPM_REALTIME_TIMINGS,
} from "./protocol";
import type { TPpmRealtimeEntity, TPpmRealtimeServerMessage } from "./protocol";

export type TPpmRealtimeStatus = "connecting" | "online" | "degraded" | "denied";

export type TPpmRealtimeSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (
    type: "open" | "message" | "close" | "error",
    listener: (event: { code?: number; data?: unknown }) => void
  ) => void;
};

export const PPM_REALTIME_SOCKET_OPEN = 1;

export type TPpmRealtimeEnv = {
  createSocket: (url: string) => TPpmRealtimeSocketLike;
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  isVisible: () => boolean;
  /** Calls `listener` when the tab's visibility or the window's focus may have changed; returns the unsubscribe. */
  subscribeReturn: (listener: () => void) => () => void;
  /** In (0, 1); injected so reconnect jitter is deterministic in tests. */
  random: () => number;
};

export type TPpmRealtimeIssueListEntry = { projectId: string; issueIds: string[] };
export type TPpmRealtimeCycleModuleEntry = { type: "cycle" | "module"; id: string };

/** One coalesced flush: every project-scoped bucket a listener may care about, already de-duplicated. */
export type TPpmRealtimeEventBatch = {
  /** entity "issue", action "updated" — the issue's own data changed; refetch it where it is loaded. */
  issueUpdated: TPpmRealtimeIssueListEntry[];
  /** entity "issue", action "created" | "deleted" | "moved" — a list's membership may have changed. */
  issueListChanged: string[];
  /** entity "cycle" | "module" — fed straight into line S's `notify()`. */
  cycleModuleChanged: TPpmRealtimeCycleModuleEntry[];
  /** entity "project" — the project's own fields (name, state, members) changed. */
  projectChanged: string[];
};

export type TPpmRealtimeClient = {
  /** Ref-counted: several screens on the same project share one `subscribe`. Returns the screen's own unsubscribe. */
  subscribeProject: (projectId: string) => () => void;
  getStatus: () => TPpmRealtimeStatus;
  onStatusChange: (listener: (status: TPpmRealtimeStatus) => void) => () => void;
  /** A coalesced batch of events for the projects currently subscribed (by any screen). */
  onEvents: (listener: (batch: TPpmRealtimeEventBatch) => void) => () => void;
  /** Fires once after a connection that needed a reconnect finishes re-subscribing; args: the projects now live. */
  onResync: (listener: (projectIds: string[]) => void) => () => void;
  /** The project was denied at subscribe time, or revoked mid-connection; the caller should stop expecting events. */
  onAccessRevoked: (listener: (projectId: string) => void) => () => void;
  /** Tears the socket and every timer/listener down; the client is unusable afterwards. */
  dispose: () => void;
};

const emptyBatch = (): TPpmRealtimeEventBatch => ({
  issueUpdated: [],
  issueListChanged: [],
  cycleModuleChanged: [],
  projectChanged: [],
});

type TPendingBuffer = {
  issueUpdated: Map<string, Set<string>>;
  issueListChanged: Set<string>;
  cycleModuleChanged: Map<string, TPpmRealtimeCycleModuleEntry>;
  projectChanged: Set<string>;
};

const newBuffer = (): TPendingBuffer => ({
  issueUpdated: new Map(),
  issueListChanged: new Set(),
  cycleModuleChanged: new Map(),
  projectChanged: new Set(),
});

const bufferIsEmpty = (buffer: TPendingBuffer) =>
  buffer.issueUpdated.size === 0 &&
  buffer.issueListChanged.size === 0 &&
  buffer.cycleModuleChanged.size === 0 &&
  buffer.projectChanged.size === 0;

const materialize = (buffer: TPendingBuffer): TPpmRealtimeEventBatch => ({
  issueUpdated: [...buffer.issueUpdated].map(([projectId, issueIds]) => ({ projectId, issueIds: [...issueIds] })),
  issueListChanged: [...buffer.issueListChanged],
  cycleModuleChanged: [...buffer.cycleModuleChanged.values()],
  projectChanged: [...buffer.projectChanged],
});

/** Registers `listener` in `set`, returning its own idempotent-enough removal (module scope: nothing to capture). */
const on = <T>(set: Set<T>, listener: T): (() => void) => {
  set.add(listener);
  return () => set.delete(listener);
};

export function createPpmRealtimeClient(env: TPpmRealtimeEnv, buildUrl: () => string): TPpmRealtimeClient {
  let disposed = false;
  let terminal = false;
  let socket: TPpmRealtimeSocketLike | undefined;
  let status: TPpmRealtimeStatus = "connecting";
  let reconnectAttempt = 0;
  // Review round 2: once true (the server has closed with 4429 at least once this tab session), the reconnect
  // backoff uses the higher `reconnectMaxMsAfterTooMany` ceiling and the attempt counter never resets on a
  // `subscribed` ack again — permanent for the session, on purpose (see `PPM_REALTIME_TIMINGS.reconnectMaxMsAfterTooMany`).
  let tooManyStreak = false;
  let reconnectTimer: unknown;
  let pingTimer: unknown;
  let needsResync = false;

  // Desired truth: every project a mounted screen still cares about, ref-counted.
  const refCounts = new Map<string, number>();
  // What the *current* connection has actually asked the server to subscribe to (reset to empty on every reconnect).
  const confirmed = new Set<string>();
  // Review round 2: ids denied or revoked *this connection* — excluded from `toAdd` so a screen that keeps its
  // subscription open does not make the server re-check the same already-rejected id on every reconcile (each check
  // is a SQL query). Cleared on every fresh `connect()`, so a reconnect gives the server a chance to re-evaluate.
  const revokedThisConnection = new Set<string>();
  let subscribeBatchTimer: unknown;

  const statusListeners = new Set<(status: TPpmRealtimeStatus) => void>();
  const eventListeners = new Set<(batch: TPpmRealtimeEventBatch) => void>();
  const resyncListeners = new Set<(projectIds: string[]) => void>();
  const accessRevokedListeners = new Set<(projectId: string) => void>();

  let buffer = newBuffer();
  let flushTimer: unknown;
  let firstEventAt: number | undefined;

  const setStatus = (next: TPpmRealtimeStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(status);
  };

  const send = (message: unknown) => {
    if (socket?.readyState !== PPM_REALTIME_SOCKET_OPEN) return;
    socket.send(JSON.stringify(message));
  };

  const activeProjectIds = () => [...refCounts.keys()].filter((id) => (refCounts.get(id) ?? 0) > 0);

  const reconcileSubscriptions = () => {
    subscribeBatchTimer = undefined;
    if (socket?.readyState !== PPM_REALTIME_SOCKET_OPEN) return;
    const desired = activeProjectIds();
    const capacity = Math.max(0, PPM_REALTIME_MAX_SUBSCRIPTIONS - confirmed.size);
    const toAdd = desired.filter((id) => !confirmed.has(id) && !revokedThisConnection.has(id)).slice(0, capacity);
    const toRemove = [...confirmed].filter((id) => !refCounts.has(id) || (refCounts.get(id) ?? 0) <= 0);
    if (toAdd.length > 0) {
      send({ type: "subscribe", project_ids: toAdd });
      for (const id of toAdd) confirmed.add(id);
    }
    if (toRemove.length > 0) {
      send({ type: "unsubscribe", project_ids: toRemove });
      for (const id of toRemove) confirmed.delete(id);
    }
  };

  const scheduleReconcile = () => {
    if (subscribeBatchTimer !== undefined) return;
    subscribeBatchTimer = env.setTimer(reconcileSubscriptions, PPM_REALTIME_TIMINGS.subscribeBatchMs);
  };

  const clearFlushTimer = () => {
    if (flushTimer !== undefined) env.clearTimer(flushTimer);
    flushTimer = undefined;
    firstEventAt = undefined;
  };

  const flush = () => {
    clearFlushTimer();
    if (!env.isVisible() || bufferIsEmpty(buffer)) return;
    const batch = materialize(buffer);
    buffer = newBuffer();
    for (const listener of eventListeners) listener(batch);
  };

  const scheduleFlush = () => {
    const now = env.now();
    if (firstEventAt === undefined) firstEventAt = now;
    const wait = Math.max(
      0,
      Math.min(PPM_REALTIME_TIMINGS.eventDebounceMs, firstEventAt + PPM_REALTIME_TIMINGS.eventMaxWaitMs - now)
    );
    if (flushTimer !== undefined) env.clearTimer(flushTimer);
    flushTimer = env.setTimer(flush, wait);
  };

  const bufferEvent = (message: Extract<TPpmRealtimeServerMessage, { type: "event" }>) => {
    if (message.entity === "issue") {
      if (message.action === "updated") {
        let ids = buffer.issueUpdated.get(message.project_id);
        if (!ids) {
          ids = new Set();
          buffer.issueUpdated.set(message.project_id, ids);
        }
        for (const id of message.ids) ids.add(id);
      } else {
        buffer.issueListChanged.add(message.project_id);
      }
    } else if (message.entity === "cycle" || message.entity === "module") {
      const entity: TPpmRealtimeEntity = message.entity;
      for (const id of message.ids) buffer.cycleModuleChanged.set(`${entity}:${id}`, { type: entity, id });
    } else if (message.entity === "project") {
      buffer.projectChanged.add(message.project_id);
    }
    // A hidden tab keeps accumulating silently; `subscribeReturn` below delivers one combined flush on return.
    if (env.isVisible()) scheduleFlush();
  };

  const stopPing = () => {
    if (pingTimer !== undefined) env.clearTimer(pingTimer);
    pingTimer = undefined;
  };

  const schedulePing = () => {
    stopPing();
    pingTimer = env.setTimer(() => {
      send({ type: "ping" });
      schedulePing();
    }, PPM_REALTIME_TIMINGS.pingMs);
  };

  const revokeProject = (projectId: string) => {
    confirmed.delete(projectId);
    revokedThisConnection.add(projectId);
    for (const listener of accessRevokedListeners) listener(projectId);
  };

  const handleMessage = (raw: unknown) => {
    if (typeof raw !== "string") return;
    let message: TPpmRealtimeServerMessage;
    try {
      message = JSON.parse(raw) as TPpmRealtimeServerMessage;
    } catch {
      return; // a malformed frame is ignored; the connection itself is unaffected
    }
    if (message.type === "subscribed") {
      // Review round 2: a session that has ever hit 4429 keeps its elevated backoff — a `subscribed` ack does not
      // mean the underlying "too many subscriptions/messages" condition is gone, only that this particular reconnect
      // got in before the next rejection.
      if (!tooManyStreak) reconnectAttempt = 0;
      setStatus("online");
      for (const id of message.project_ids) confirmed.add(id);
      for (const id of message.denied) revokeProject(id);
      if (needsResync) {
        needsResync = false;
        for (const listener of resyncListeners) listener([...confirmed]);
      }
    } else if (message.type === "event") {
      bufferEvent(message);
    } else if (message.type === "access_revoked") {
      revokeProject(message.project_id);
    }
    // "pong" needs no handling: the ping is a keep-alive, not an RPC.
  };

  const connect = () => {
    reconnectTimer = undefined;
    if (disposed || terminal) return;
    setStatus("connecting");
    confirmed.clear();
    revokedThisConnection.clear();
    const nextSocket = env.createSocket(buildUrl());
    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket) return;
      schedulePing();
      reconcileSubscriptions();
    });
    nextSocket.addEventListener("message", (event) => {
      if (socket !== nextSocket) return;
      handleMessage(event.data);
    });
    nextSocket.addEventListener("error", () => {
      if (socket === nextSocket) setStatus("degraded");
    });
    nextSocket.addEventListener("close", (event) => {
      if (socket !== nextSocket) return;
      socket = undefined;
      stopPing();
      if (disposed) return;
      if (event.code !== undefined && PPM_REALTIME_TERMINAL_CLOSE_CODES.includes(event.code)) {
        terminal = true;
        setStatus("denied");
        return;
      }
      // Review round 2: 4429 escalates permanently to the higher ceiling (see `tooManyStreak`); 1006/1011/1012 and
      // everything else keep the normal ceiling and reset-on-`subscribed` behaviour.
      if (event.code === PPM_REALTIME_CLOSE_CODE.tooManySubscriptions) tooManyStreak = true;
      needsResync = true;
      setStatus("degraded");
      const ceiling = tooManyStreak
        ? PPM_REALTIME_TIMINGS.reconnectMaxMsAfterTooMany
        : PPM_REALTIME_TIMINGS.reconnectMaxMs;
      const base = Math.min(ceiling, PPM_REALTIME_TIMINGS.reconnectBaseMs * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      // Growing pause (base) + a random spread on top of half of it, so many tabs reconnecting after the same API
      // restart do not all retry in lockstep.
      const delay = base / 2 + env.random() * (base / 2);
      reconnectTimer = env.setTimer(connect, delay);
    });
  };

  const ensureConnected = () => {
    if (socket || reconnectTimer !== undefined || terminal || disposed) return;
    connect();
  };

  env.subscribeReturn(() => {
    if (env.isVisible() && !bufferIsEmpty(buffer)) flush();
  });

  const subscribeProject: TPpmRealtimeClient["subscribeProject"] = (projectId) => {
    if (disposed) return () => {};
    refCounts.set(projectId, (refCounts.get(projectId) ?? 0) + 1);
    ensureConnected();
    scheduleReconcile();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const next = (refCounts.get(projectId) ?? 1) - 1;
      if (next > 0) refCounts.set(projectId, next);
      else refCounts.delete(projectId);
      scheduleReconcile();
    };
  };

  return {
    subscribeProject,
    getStatus: () => status,
    onStatusChange: (listener) => on(statusListeners, listener),
    onEvents: (listener) => on(eventListeners, listener),
    onResync: (listener) => on(resyncListeners, listener),
    onAccessRevoked: (listener) => on(accessRevokedListeners, listener),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopPing();
      clearFlushTimer();
      if (reconnectTimer !== undefined) env.clearTimer(reconnectTimer);
      if (subscribeBatchTimer !== undefined) env.clearTimer(subscribeBatchTimer);
      socket?.close(1000, "ppm_realtime_dispose");
      socket = undefined;
      statusListeners.clear();
      eventListeners.clear();
      resyncListeners.clear();
      accessRevokedListeners.clear();
    },
  };
}

export { emptyBatch as createEmptyPpmRealtimeEventBatch };

/**
 * Review round 1 (U6, "Мои задачи" point 3): reconciles a live map of per-project unsubscribe functions against a
 * fresh desired id list — used to make the profile screen's subscriptions follow `joinedProjectIds` reactively (a
 * MobX `reaction`) instead of a one-off read at mount, without duplicating the ref-count/diff logic that already
 * lives in `subscribeProject` above. Pure and framework-agnostic on purpose, so it is testable without React/MobX.
 */
export function syncPpmRealtimeSubscriptions(
  active: Map<string, () => void>,
  nextIds: readonly string[],
  subscribe: (projectId: string) => () => void
): void {
  const next = new Set(nextIds);
  for (const id of next) {
    if (!active.has(id)) active.set(id, subscribe(id));
  }
  for (const [id, dispose] of active) {
    if (!next.has(id)) {
      dispose();
      active.delete(id);
    }
  }
}

/** The real browser: a real `WebSocket`, `setTimeout`, `document.visibilityState` + `visibilitychange`, `Math.random`. */
export function createBrowserPpmRealtimeEnv(): TPpmRealtimeEnv {
  const documentTarget = typeof document === "undefined" ? undefined : document;
  const windowTarget = typeof window === "undefined" ? undefined : window;
  return {
    createSocket: (url) => new WebSocket(url) as unknown as TPpmRealtimeSocketLike,
    now: () => Date.now(),
    setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    isVisible: () => documentTarget?.visibilityState !== "hidden",
    subscribeReturn: (listener) => {
      documentTarget?.addEventListener("visibilitychange", listener);
      windowTarget?.addEventListener("focus", listener);
      return () => {
        documentTarget?.removeEventListener("visibilitychange", listener);
        windowTarget?.removeEventListener("focus", listener);
      };
    },
    random: () => Math.random(),
  };
}
