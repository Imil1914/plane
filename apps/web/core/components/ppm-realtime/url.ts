/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** PPM line U-Web: the workspace events socket URL, built the same way `buildPpmCanvasPresenceUrl` builds its own. */
export function buildPpmRealtimeEventsUrl({
  apiBaseUrl,
  pageOrigin,
  workspaceSlug,
}: {
  apiBaseUrl: string;
  pageOrigin: string;
  workspaceSlug: string;
}): string {
  const url = new URL(apiBaseUrl || pageOrigin, pageOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/ppm/v1/workspaces/${encodeURIComponent(workspaceSlug)}/events/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
