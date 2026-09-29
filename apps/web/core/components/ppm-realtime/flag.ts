/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line U-Web (UX2.1 U5, web mirror of the server's `PPM_REALTIME_EVENTS_ENABLED`). The two flags are independent
 * (the web build cannot read Django settings), but review round 2 (U-API's own review) asked the *parsing rule* to
 * match exactly, not merely the default: the server only ever treats the literal `"1"` as enabled and anything else
 * (set) as disabled — unlike the blocklist-style `isPpmCanvasEnabled` and friends (`packages/ppm-canvas/src/index.ts`)
 * that treat any non-blocklisted value as enabled. This is a narrow allowlist (`"1"`/`"true"`, case-insensitively) so
 * an unrecognised value fails closed the same way the server's own `str == "1"` check does, not open. Unset/blank
 * still defaults to enabled, matching the server's own default. When off, the client never connects and screens
 * behave exactly as they do today (line S polling only).
 */
const ENABLED_FLAG_VALUES = new Set(["1", "true"]);

export function isPpmRealtimeEventsEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return ENABLED_FLAG_VALUES.has(value.trim().toLowerCase());
}
