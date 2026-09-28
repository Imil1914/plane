/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useContext, useEffect, useRef } from "react";
import { StoreContext } from "@/lib/store-context";
import { bindRefreshToKey } from "./refresh-scheduler";
import type { TLiveStatsReason, TLiveStatsSubjectType } from "./refresh-scheduler";
import { getLiveStatsRuntime } from "./runtime";

type TUseLiveStatsOptions = {
  enabled: boolean;
  /** one refresh per key: two panels that show the same data share it */
  key: string;
  subjectType: TLiveStatsSubjectType;
  subjectId: string | undefined;
  refresh: (reason: TLiveStatsReason) => unknown;
  /**
   * The panel's numbers are already in the tab when it opens (its own first load is skipped then, so they may be
   * old — e.g. the tasks were edited in the list meanwhile): re-read them at once. Read when the panel registers.
   */
  refreshOnWatch?: boolean;
};

/**
 * PPM line S: keeps a panel's numbers fresh while it is mounted — after changes of its sprint/module made in this tab,
 * when the user comes back to the tab/window, and every 30 s on a visible tab (see refresh-scheduler). Unmounting the
 * panel stops everything it started.
 */
export function useLiveStats({
  enabled,
  key,
  subjectType,
  subjectId,
  refresh,
  refreshOnWatch = false,
}: TUseLiveStatsOptions) {
  const store = useContext(StoreContext);
  // the latest values without re-registering the panel on every render (runs before the registration below)
  const latestRef = useRef({ key, refresh, refreshOnWatch });
  useEffect(() => {
    latestRef.current = { key, refresh, refreshOnWatch };
  });

  useEffect(() => {
    if (!enabled || !subjectId) return undefined;
    const registered = latestRef.current;
    // bound to this key: if the panel switches to another sprint, this registration still refreshes its own one
    return getLiveStatsRuntime(store).watch(
      key,
      { type: subjectType, id: subjectId },
      bindRefreshToKey(key, registered.refresh, latestRef),
      { refreshNow: registered.refreshOnWatch }
    );
  }, [store, enabled, key, subjectType, subjectId]);
}
