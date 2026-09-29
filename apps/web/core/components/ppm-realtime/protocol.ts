/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line U-Web (UX2.1 U6-U8): wire protocol and timings of the workspace events socket
 * (`/ws/ppm/v1/workspaces/<slug>/events/`), fixed by the plan (`docs/superpowers/plans/2026-09-29-ux21-realtime/plan.md`)
 * and shared with line U-API. The server publishes short, data-free events after its own transaction commits; this
 * client keeps one socket per tab, subscribes the projects that are on screen, coalesces incoming events for ~300 ms
 * and turns them into point store refetches (see `store-bridge.ts`) — never a full-page reload.
 */

export type TPpmRealtimeEntity = "issue" | "cycle" | "module" | "project";
export type TPpmRealtimeAction = "created" | "updated" | "deleted" | "moved";

export type TPpmRealtimeClientMessage =
  | { type: "subscribe"; project_ids: string[] }
  | { type: "unsubscribe"; project_ids: string[] }
  | { type: "ping" };

export type TPpmRealtimeServerMessage =
  | { type: "subscribed"; project_ids: string[]; denied: string[] }
  | {
      type: "event";
      project_id: string;
      entity: TPpmRealtimeEntity;
      action: TPpmRealtimeAction;
      ids: string[];
      seq?: number;
      at?: string;
    }
  | { type: "access_revoked"; project_id: string }
  | { type: "pong" };

/**
 * Close codes the server uses — the same family as the Canvas presence socket (`board-presence.tsx`), plus the ones
 * review round 2 (U-API's own review) added: `channelDisabled` (4404, `PPM_REALTIME_EVENTS_ENABLED` off server-side)
 * and the standard WebSocket 1009 (the server's ASGI layer rejects an over-size frame the same way).
 */
export const PPM_REALTIME_CLOSE_CODE = {
  notAuthenticated: 4401,
  accessDenied: 4403,
  channelDisabled: 4404,
  tooManySubscriptions: 4429,
  /** Standard WebSocket code (not one of the server's own 44xx codes) — messageTooBig, used the same terminal way. */
  messageTooBig: 1009,
} as const;

/** After these codes the client stops reconnecting on its own; line S polling remains the fallback. */
export const PPM_REALTIME_TERMINAL_CLOSE_CODES: readonly number[] = [
  PPM_REALTIME_CLOSE_CODE.notAuthenticated,
  PPM_REALTIME_CLOSE_CODE.accessDenied,
  PPM_REALTIME_CLOSE_CODE.channelDisabled,
  PPM_REALTIME_CLOSE_CODE.messageTooBig,
];

export const PPM_REALTIME_TIMINGS = {
  /** U6: keeps the connection's group membership warm between the server's own periodic re-checks. */
  pingMs: 25_000,
  /** U6: exponential backoff base/ceiling; a random spread is added on top of each pause. */
  reconnectBaseMs: 1000,
  reconnectMaxMs: 10_000,
  /**
   * Review round 2: once the server has ever closed with `tooManySubscriptions` (4429), the backoff ceiling for the
   * rest of the tab session is this much higher, and the attempt counter no longer resets on a `subscribed` ack — a
   * fast retry loop after 4429 only asks the server for the same rejected thing more often.
   */
  reconnectMaxMsAfterTooMany: 60_000,
  /** U7: incoming events are coalesced for ~300 ms; a steady stream still flushes at least this often. */
  eventDebounceMs: 300,
  eventMaxWaitMs: 1000,
  /** Same-tick subscribe/unsubscribe calls from several mounting screens are sent as one batched message. */
  subscribeBatchMs: 0,
} as const;

/** U1: the server refuses more than 50 project subscriptions per connection; the client mirrors the limit. */
export const PPM_REALTIME_MAX_SUBSCRIPTIONS = 50;
