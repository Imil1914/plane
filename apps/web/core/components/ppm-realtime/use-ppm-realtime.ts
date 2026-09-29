/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line U-Web (UX2.1 U6-U8): the screens that subscribe to the events socket, per the plan and the task card
 * (раздел B) — the open project's layout (one project: its issue list/board/card, its cycles/modules, its overview),
 * "Мои задачи" (the user's own projects in the workspace, up to `PPM_REALTIME_MAX_SUBSCRIPTIONS`), and — added in
 * review round 1 to close a U7 spec gap — the cycle/module detail page roots, which reuse the project layout's own
 * subscription instead of opening one of their own. All hooks are effect-only (nothing runs at render time, so SSR is
 * untouched) and no-op outright when the flag is off or the screen has no workspace/project/user yet — behaviour is
 * then exactly what it is today (line S's own polling).
 */
import { useContext, useEffect } from "react";
import { reaction } from "mobx";
import { API_BASE_URL } from "@plane/constants";
import { StoreContext } from "@/lib/store-context";
import { createBrowserPpmRealtimeEnv, syncPpmRealtimeSubscriptions } from "./client";
import { isPpmRealtimeEventsEnabled } from "./flag";
import { PPM_REALTIME_MAX_SUBSCRIPTIONS } from "./protocol";
import { getPpmRealtimeRuntime } from "./runtime";
import {
  applyPpmRealtimeEventsToCycleOrModule,
  applyPpmRealtimeEventsToProfile,
  applyPpmRealtimeEventsToProject,
  applyPpmRealtimeResyncToCycleOrModule,
  applyPpmRealtimeResyncToProfile,
  applyPpmRealtimeResyncToProject,
} from "./store-bridge";
import type { TPpmRealtimeStore } from "./store-bridge";
import { buildPpmRealtimeEventsUrl } from "./url";

/**
 * `paginationOptions` (see `store-bridge.ts`) is a concrete-class observable that `IProjectIssues`/`IProfileIssues`
 * do not expose on their public interface, so the real root store needs one explicit, documented cast to the
 * narrower shape this module actually reads and calls — done once, here, rather than at every call site below.
 */
const asPpmRealtimeStore = (store: unknown) => store as TPpmRealtimeStore;

const buildUrlForWorkspace = (workspaceSlug: string) =>
  buildPpmRealtimeEventsUrl({
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL || API_BASE_URL,
    pageOrigin: window.location.origin,
    workspaceSlug,
  });

const realtimeReady = () =>
  typeof window !== "undefined" &&
  typeof WebSocket !== "undefined" &&
  isPpmRealtimeEventsEnabled(process.env.PPM_REALTIME_EVENTS_ENABLED);

/** U6/U7: the open project's layout subscribes its own project and reacts to its issue/cycle/module/project events. */
export function usePpmRealtimeProjectSync(workspaceSlug: string | undefined, projectId: string | undefined): void {
  const store = useContext(StoreContext);
  useEffect(() => {
    if (!workspaceSlug || !projectId || !realtimeReady()) return undefined;

    const realtimeStore = asPpmRealtimeStore(store);
    const runtime = getPpmRealtimeRuntime(
      realtimeStore,
      workspaceSlug,
      createBrowserPpmRealtimeEnv,
      buildUrlForWorkspace
    );
    const disposeSubscribe = runtime.client.subscribeProject(projectId);
    const disposeEvents = runtime.client.onEvents((batch) =>
      applyPpmRealtimeEventsToProject(realtimeStore, workspaceSlug, projectId, batch)
    );
    const disposeResync = runtime.client.onResync((liveProjectIds) => {
      if (liveProjectIds.includes(projectId)) applyPpmRealtimeResyncToProject(realtimeStore, workspaceSlug, projectId);
    });
    return () => {
      disposeSubscribe();
      disposeEvents();
      disposeResync();
    };
  }, [store, workspaceSlug, projectId]);
}

/**
 * U6/U7: "Мои задачи" subscribes every project the user belongs to in the workspace (as many as the store has, up to
 * the protocol's limit) and re-reads the aggregated list when any of them gains/loses/moves an issue.
 *
 * Review round 1 (low): `joinedProjectIds` is a MobX `computed`, so the subscription set is kept reactive with a
 * `reaction()` instead of a one-off read at mount — joining or leaving a project while "Мои задачи" stays open
 * re-subscribes without needing a remount. `syncPpmRealtimeSubscriptions` (in `client.ts`) does the actual diffing —
 * kept there and pure so it is unit-tested without React/MobX.
 */
export function usePpmRealtimeProfileSync(workspaceSlug: string | undefined, userId: string | undefined): void {
  const store = useContext(StoreContext);
  useEffect(() => {
    if (!workspaceSlug || !userId || !realtimeReady()) return undefined;

    const realtimeStore = asPpmRealtimeStore(store);
    const runtime = getPpmRealtimeRuntime(
      realtimeStore,
      workspaceSlug,
      createBrowserPpmRealtimeEnv,
      buildUrlForWorkspace
    );
    const activeSubscriptions = new Map<string, () => void>();
    let subscribedProjectIds: ReadonlySet<string> = new Set();

    const applyJoinedProjectIds = (projectIds: readonly string[]) => {
      const capped = projectIds.slice(0, PPM_REALTIME_MAX_SUBSCRIPTIONS);
      syncPpmRealtimeSubscriptions(activeSubscriptions, capped, runtime.client.subscribeProject);
      subscribedProjectIds = new Set(capped);
    };

    applyJoinedProjectIds(store.projectRoot.project.joinedProjectIds);
    const disposeReaction = reaction(() => store.projectRoot.project.joinedProjectIds, applyJoinedProjectIds);

    const disposeEvents = runtime.client.onEvents((batch) =>
      applyPpmRealtimeEventsToProfile(realtimeStore, workspaceSlug, userId, subscribedProjectIds, batch)
    );
    const disposeResync = runtime.client.onResync((liveProjectIds) => {
      if (liveProjectIds.some((id) => subscribedProjectIds.has(id))) {
        applyPpmRealtimeResyncToProfile(realtimeStore, workspaceSlug, userId, subscribedProjectIds);
      }
    });
    return () => {
      disposeReaction();
      for (const dispose of activeSubscriptions.values()) dispose();
      disposeEvents();
      disposeResync();
    };
  }, [store, workspaceSlug, userId]);
}

/**
 * Review round 1 (spec gap, U7): the sprint's/module's own Kanban/list did not re-read itself when a colleague added,
 * removed or moved an issue in the project. Mounted from the cycle/module detail page roots
 * (`cycles/(detail)/layout.tsx`, `modules/(detail)/layout.tsx`), nested under the project layout: the project is
 * already subscribed there, so this hook only listens — it does not call `subscribeProject` of its own.
 */
export function usePpmRealtimeCycleOrModuleIssuesSync(
  workspaceSlug: string | undefined,
  projectId: string | undefined,
  subjectType: "cycle" | "module",
  subjectId: string | undefined
): void {
  const store = useContext(StoreContext);
  useEffect(() => {
    if (!workspaceSlug || !projectId || !subjectId || !realtimeReady()) return undefined;

    const realtimeStore = asPpmRealtimeStore(store);
    const runtime = getPpmRealtimeRuntime(
      realtimeStore,
      workspaceSlug,
      createBrowserPpmRealtimeEnv,
      buildUrlForWorkspace
    );
    const subject = { type: subjectType, id: subjectId };
    const disposeEvents = runtime.client.onEvents((batch) =>
      applyPpmRealtimeEventsToCycleOrModule(realtimeStore, workspaceSlug, projectId, subject, batch)
    );
    const disposeResync = runtime.client.onResync((liveProjectIds) => {
      if (liveProjectIds.includes(projectId)) {
        applyPpmRealtimeResyncToCycleOrModule(realtimeStore, workspaceSlug, projectId, subject);
      }
    });
    return () => {
      disposeEvents();
      disposeResync();
    };
  }, [store, workspaceSlug, projectId, subjectType, subjectId]);
}
