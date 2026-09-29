/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line U-Web (UX2.1 U7): turns one coalesced `TPpmRealtimeEventBatch` from `client.ts` into the point store calls
 * `research/ux21-facts.md` §3 already names — no new fetching machinery, only wiring:
 *  - entity "issue", action "updated" → `issueDetail.issue.fetchIssue` merges into the shared `IssueStore` map, so the
 *    card, and every list/board reading the same map, pick it up — but only when the issue is actually loaded
 *    (`getIssueById` truthy); an issue nobody has open is not worth a request. A visible update also re-reads the
 *    current list/board once (review round 3, RT-1): `fetchIssue` alone refreshes the issue's own fields but not a
 *    grouped view's `groupedIssueIds`, so a status change would not visibly move it between groups/columns without
 *    this. Above `PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD` loaded ids in one project's entry (review round 1, medium:
 *    a bulk change must not fire one request per issue), the individual fetches are skipped and the one list re-read
 *    covers all of them. "Мои задачи" (`applyPpmRealtimeEventsToProfile`) treats *every* update in a subscribed
 *    project as list-affecting, loaded or not (review round 3, RT-2): a new assignment arrives as an "updated" issue
 *    that may not be loaded anywhere in this tab yet, so "is it loaded" cannot gate the refresh there.
 *  - entity "issue", action created/deleted/moved → the membership of a list may have changed, so the affected list's
 *    own `fetchIssuesWithExistingPagination` re-runs with whatever filters it already had — but only if that list was
 *    ever loaded this session (`paginationOptions` set); otherwise there is nothing on screen to refresh.
 *  - entity "cycle"/"module" → fed straight into line S's own `refresh-scheduler.notify()` (`getLiveStatsRuntime`),
 *    which already knows which stats panels are actually watched (their numbers/charts, not their issue list).
 *  - entity "project" → `projectRoot.project.fetchProjectDetails` (read by the project overview page).
 * Either bucket above sets one flag per function call, so however many issues/projects triggered it, at most one
 * `fetchIssuesWithExistingPagination` runs per flush — the point fetches and the list re-read are complementary, not
 * a choice between them.
 *
 * Four call sites now, matching where U6 subscribes projects and reuses that subscription: the open project's layout
 * (one project — issue list/board/card, project overview) and the full work-item page outside it (review round 3,
 * RT-3, `browse/[workItem]/page.tsx` — same function, its own project), "Мои задачи" (several projects at once,
 * aggregated in `profileIssues`), and — added in review round 1 to close a U7 spec gap — the cycle/module detail page
 * roots, which reuse the project layout's own subscription rather than opening one of their own
 * (`applyPpmRealtimeEventsToCycleOrModule`). A failed point refetch is swallowed — the next event, or line S's own
 * fallback poll, tries again; it must never surface as an unhandled rejection.
 */
import { getLiveStatsRuntime } from "@/components/ppm-live-stats/runtime";
import type { TLiveStatsSubject } from "@/components/ppm-live-stats/refresh-scheduler";
import type { TLiveStatsStore } from "@/components/ppm-live-stats/runtime";
import type { TPpmRealtimeEventBatch } from "./client";

/**
 * The slice of the root MobX store this bridge reads and calls — narrow on purpose so tests substitute plain fakes.
 * Intersected with `TLiveStatsStore` (rather than merely structurally similar to it) so the very same store object
 * can be passed to `getLiveStatsRuntime` too, with no cast: `issue.issues.issuesMap`/`cycle.cycleMap`/
 * `module.moduleMap` are line S's own types, not re-declared here.
 */
export type TPpmRealtimeStore = TLiveStatsStore & {
  issue: TLiveStatsStore["issue"] & {
    issues: TLiveStatsStore["issue"]["issues"] & { getIssueById: (issueId: string) => unknown };
    issueDetail: {
      issue: { fetchIssue: (workspaceSlug: string, projectId: string, issueId: string) => Promise<unknown> };
    };
    // `paginationOptions` is a concrete-class observable, not part of the public `IProjectIssues`/`IProfileIssues`
    // interface (`apps/web/core/store/issue/helpers/base-issues.store.ts`); every store that reaches this bridge is
    // cast once, at the React-hook boundary (`use-ppm-realtime.ts`), specifically to read this field.
    projectIssues: {
      paginationOptions: unknown;
      fetchIssuesWithExistingPagination: (
        workspaceSlug: string,
        projectId: string,
        loadType: "mutation"
      ) => Promise<unknown>;
    };
    profileIssues: {
      paginationOptions: unknown;
      fetchIssuesWithExistingPagination: (
        workspaceSlug: string,
        userId: string,
        loadType: "mutation"
      ) => Promise<unknown>;
    };
    // Review round 1 (U7 spec gap): the sprint's/module's own issue list, keyed by cycleId/moduleId (4th argument),
    // same shape as `IProjectIssues.fetchIssuesWithExistingPagination` otherwise (`store/issue/{cycle,module}/issue.store.ts`).
    cycleIssues: {
      paginationOptions: unknown;
      fetchIssuesWithExistingPagination: (
        workspaceSlug: string,
        projectId: string,
        loadType: "mutation",
        cycleId: string
      ) => Promise<unknown>;
    };
    moduleIssues: {
      paginationOptions: unknown;
      fetchIssuesWithExistingPagination: (
        workspaceSlug: string,
        projectId: string,
        loadType: "mutation",
        moduleId: string
      ) => Promise<unknown>;
    };
  };
  projectRoot: {
    project: {
      fetchProjectDetails: (workspaceSlug: string, projectId: string) => Promise<unknown>;
      /** U6: "Мои задачи" subscribes the user's own projects in the workspace — however many the store already has. */
      joinedProjectIds: readonly string[];
    };
  };
};

/**
 * Review round 1 (medium): above this many loaded ids in one project's `issueUpdated` entry within one coalescing
 * window, N `fetchIssue` calls become one `fetchIssuesWithExistingPagination` of the current view instead — a bulk
 * change (e.g. 200 issues) must not turn into a request avalanche.
 */
export const PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD = 15;

/** A failed point refetch keeps the previous numbers; the next event or line S's fallback poll tries again. */
const ignoreFailure = () => undefined;

const notifyLiveStatsSubjects = (store: TPpmRealtimeStore, subjects: readonly TLiveStatsSubject[]) => {
  if (subjects.length === 0) return;
  try {
    getLiveStatsRuntime(store).notify(subjects);
  } catch {
    // best effort: no live-stats panel is open in this tab session, or the store is mid-teardown (sign-out)
  }
};

/** U6/U7: the open project's layout — one project, its issue list/board, its cycles/modules, its overview. */
export function applyPpmRealtimeEventsToProject(
  store: TPpmRealtimeStore,
  workspaceSlug: string,
  projectId: string,
  batch: TPpmRealtimeEventBatch
): void {
  let needsListRefresh = batch.issueListChanged.includes(projectId);
  for (const entry of batch.issueUpdated) {
    if (entry.projectId !== projectId) continue;
    const loadedIds = entry.issueIds.filter((issueId) => store.issue.issues.getIssueById(issueId));
    if (loadedIds.length === 0) continue;
    // Review round 3 (RT-1): a field update (e.g. status) can move a visible issue into another group of a grouped
    // list/board — `fetchIssue` alone refreshes the issue's own data but not `groupedIssueIds`, so a visible update
    // also asks for one coalesced re-read of the current view, in addition to (not instead of) the point fetch below.
    needsListRefresh = true;
    if (loadedIds.length > PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD) continue;
    for (const issueId of loadedIds) {
      void store.issue.issueDetail.issue.fetchIssue(workspaceSlug, projectId, issueId).catch(ignoreFailure);
    }
  }
  if (needsListRefresh && store.issue.projectIssues.paginationOptions) {
    void store.issue.projectIssues
      .fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation")
      .catch(ignoreFailure);
  }
  notifyLiveStatsSubjects(
    store,
    batch.cycleModuleChanged.map((entry) => ({ type: entry.type, id: entry.id }))
  );
  if (batch.projectChanged.includes(projectId)) {
    void store.projectRoot.project.fetchProjectDetails(workspaceSlug, projectId).catch(ignoreFailure);
  }
}

/** U6: one resync refetch of the open project's own subscribed data, after a reconnect. */
export function applyPpmRealtimeResyncToProject(
  store: TPpmRealtimeStore,
  workspaceSlug: string,
  projectId: string
): void {
  if (store.issue.projectIssues.paginationOptions) {
    void store.issue.projectIssues
      .fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation")
      .catch(ignoreFailure);
  }
  void store.projectRoot.project.fetchProjectDetails(workspaceSlug, projectId).catch(ignoreFailure);
}

/** U6/U7: "Мои задачи" — one issue list aggregating every project the user belongs to (up to 50, see `use-ppm-realtime.ts`). */
export function applyPpmRealtimeEventsToProfile(
  store: TPpmRealtimeStore,
  workspaceSlug: string,
  userId: string,
  subscribedProjectIds: ReadonlySet<string>,
  batch: TPpmRealtimeEventBatch
): void {
  let needsListRefresh = batch.issueListChanged.some((projectId) => subscribedProjectIds.has(projectId));
  for (const entry of batch.issueUpdated) {
    if (!subscribedProjectIds.has(entry.projectId)) continue;
    // Review round 3 (RT-2): a new assignment arrives as an "updated" issue event (the issue itself was not
    // created/deleted/moved), and the assigned issue may not be loaded anywhere in this tab yet — unlike the project
    // view (RT-1), "loaded" is not a usable signal here, so any update in a subscribed project refreshes the
    // aggregated list; the per-id fetch below still only runs for ids already loaded, unaffected.
    needsListRefresh = true;
    const loadedIds = entry.issueIds.filter((issueId) => store.issue.issues.getIssueById(issueId));
    if (loadedIds.length === 0 || loadedIds.length > PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD) continue;
    for (const issueId of loadedIds) {
      void store.issue.issueDetail.issue.fetchIssue(workspaceSlug, entry.projectId, issueId).catch(ignoreFailure);
    }
  }
  if (needsListRefresh && store.issue.profileIssues.paginationOptions) {
    void store.issue.profileIssues
      .fetchIssuesWithExistingPagination(workspaceSlug, userId, "mutation")
      .catch(ignoreFailure);
  }
}

/** U6: one resync refetch of "Мои задачи", after a reconnect. */
export function applyPpmRealtimeResyncToProfile(
  store: TPpmRealtimeStore,
  workspaceSlug: string,
  userId: string,
  subscribedProjectIds: ReadonlySet<string>
): void {
  if (subscribedProjectIds.size === 0 || !store.issue.profileIssues.paginationOptions) return;
  void store.issue.profileIssues
    .fetchIssuesWithExistingPagination(workspaceSlug, userId, "mutation")
    .catch(ignoreFailure);
}

/** A sprint or a module's own issue list — `subject.type`/`.id` pick `cycleIssues`/`moduleIssues`. */
const issueListStoreFor = (store: TPpmRealtimeStore, subjectType: "cycle" | "module") =>
  subjectType === "cycle" ? store.issue.cycleIssues : store.issue.moduleIssues;

/**
 * Review round 1 (spec gap, U7): the sprint's/module's own Kanban/list did not re-read itself when a colleague added,
 * removed or moved an issue in the project. Called from the cycle/module detail page roots, which reuse the project
 * layout's own subscription (no `subscribeProject` of their own) — see `use-ppm-realtime.ts`.
 *
 * Review round 2 (point 6, by U-API's own confirmation): the API now publishes a `cycle`/`module` event carrying the
 * exact id on every issue transfer, not only on a direct edit of the sprint/module itself — so an exact `{type, id}`
 * match is sufficient and precise; round 1's conservative fallback (any change to the project's issue list, since a
 * plain issue create/delete/move event alone carries no cycle/module id) is no longer needed and would have refreshed
 * *every* sprint/module in the project on an unrelated issue's create/delete, not just this one's.
 */
export function applyPpmRealtimeEventsToCycleOrModule(
  store: TPpmRealtimeStore,
  workspaceSlug: string,
  projectId: string,
  subject: { type: "cycle" | "module"; id: string },
  batch: TPpmRealtimeEventBatch
): void {
  const subjectChanged = batch.cycleModuleChanged.some(
    (entry) => entry.type === subject.type && entry.id === subject.id
  );
  if (!subjectChanged) return;
  const listStore = issueListStoreFor(store, subject.type);
  if (!listStore.paginationOptions) return;
  void listStore
    .fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation", subject.id)
    .catch(ignoreFailure);
}

/** Review round 1: one resync refetch of this sprint's/module's own board, after a reconnect. */
export function applyPpmRealtimeResyncToCycleOrModule(
  store: TPpmRealtimeStore,
  workspaceSlug: string,
  projectId: string,
  subject: { type: "cycle" | "module"; id: string }
): void {
  const listStore = issueListStoreFor(store, subject.type);
  if (!listStore.paginationOptions) return;
  void listStore
    .fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation", subject.id)
    .catch(ignoreFailure);
}
