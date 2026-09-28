/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S: the quiet refresh of a sprint's / module's numbers in the stores. Nothing is cleared first (the panels keep
// the previous numbers until the new ones arrive), an answer older than a later refresh of the same sprint/module is
// ignored (fast switching), a failed part does not wipe the rest, and a sprint deleted meanwhile is not brought back.
import { runInAction } from "mobx";
import { describe, expect, it, vi } from "vitest";
import type { ICycle, IModule } from "@plane/types";
import { CycleStore } from "@/store/cycle.store";
import { ModulesStore } from "@/store/module.store";
import type { CoreRootStore } from "@/store/root.store";

type TDeferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
const deferred = <T>(): TDeferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const SPRINT = "sprint-1";
const OLD_DISTRIBUTION = { assignees: [], labels: [], completion_chart: { "2026-09-28": 1 } };

const DATES = { start_date: "2026-09-22", end_date: "2026-10-05" };

function createCycleStore(estimatesEnabled = false, dates: Partial<ICycle> = DATES) {
  const root = {
    router: { projectId: "project-1" },
    projectEstimate: { areEstimateEnabledByProjectId: () => estimatesEnabled },
  } as unknown as CoreRootStore;
  const store = new CycleStore(root);
  runInAction(() => {
    store.cycleMap[SPRINT] = {
      id: SPRINT,
      name: "Спринт 1",
      total_issues: 1,
      completed_issues: 0,
      distribution: OLD_DISTRIBUTION,
      ...dates,
    } as unknown as ICycle;
  });
  const service = {
    workspaceActiveCyclesProgress: vi.fn(),
    workspaceActiveCyclesAnalytics: vi.fn(),
    getCycleDetails: vi.fn(),
  };
  store.cycleService = service as unknown as CycleStore["cycleService"];
  return { store, service };
}

describe("line S: CycleStore.refreshCycleStats", () => {
  it("re-reads progress and the work-item distribution without clearing anything first", async () => {
    const { store, service } = createCycleStore();
    const progress = deferred<object>();
    const analytics = deferred<object>();
    service.workspaceActiveCyclesProgress.mockReturnValue(progress.promise);
    service.workspaceActiveCyclesAnalytics.mockReturnValue(analytics.promise);

    const pending = store.refreshCycleStats("ws", "project-1", SPRINT);
    expect(store.getCycleById(SPRINT)?.distribution).toEqual(OLD_DISTRIBUTION);

    const assignees = [{ assignee_id: "owner", display_name: "Владелец", completed_issues: 0, total_issues: 1 }];
    progress.resolve({ total_issues: 2, completed_issues: 1, started_issues: 1 });
    analytics.resolve({ assignees, labels: [], completion_chart: { "2026-09-28": 1 } });
    await pending;

    const cycle = store.getCycleById(SPRINT)!;
    expect(cycle.total_issues).toBe(2);
    expect(cycle.completed_issues).toBe(1);
    expect(cycle.distribution?.assignees).toEqual(assignees);
    expect(cycle.name).toBe("Спринт 1");
    expect(service.workspaceActiveCyclesAnalytics).toHaveBeenCalledTimes(1);
    expect(service.workspaceActiveCyclesAnalytics).toHaveBeenCalledWith("ws", "project-1", SPRINT, "issues");
    expect(service.getCycleDetails).not.toHaveBeenCalled();
  });

  it("with estimates on, also re-reads the points distribution; after a change, also the sprint details", async () => {
    const { store, service } = createCycleStore(true);
    service.workspaceActiveCyclesProgress.mockResolvedValue({ total_issues: 1 });
    service.workspaceActiveCyclesAnalytics.mockImplementation(async (_ws, _project, _id, type: string) => ({
      assignees: [],
      labels: [],
      completion_chart: {},
      type,
    }));
    service.getCycleDetails.mockResolvedValue({ id: SPRINT, assignee_ids: ["owner"] });

    await store.refreshCycleStats("ws", "project-1", SPRINT, { withDetails: true });

    const cycle = store.getCycleById(SPRINT) as ICycle & { distribution: { type: string } };
    expect(cycle.distribution.type).toBe("issues");
    expect((cycle.estimate_distribution as unknown as { type: string }).type).toBe("points");
    expect(cycle.assignee_ids).toEqual(["owner"]);
  });

  it("an answer that arrives after a newer refresh of the same sprint is ignored", async () => {
    const { store, service } = createCycleStore();
    const firstProgress = deferred<object>();
    const firstAnalytics = deferred<object>();
    service.workspaceActiveCyclesProgress
      .mockReturnValueOnce(firstProgress.promise)
      .mockResolvedValueOnce({ total_issues: 5 });
    service.workspaceActiveCyclesAnalytics
      .mockReturnValueOnce(firstAnalytics.promise)
      .mockResolvedValueOnce({ assignees: [], labels: [], completion_chart: { new: 1 } });

    const first = store.refreshCycleStats("ws", "project-1", SPRINT);
    await store.refreshCycleStats("ws", "project-1", SPRINT);
    firstProgress.resolve({ total_issues: 3 });
    firstAnalytics.resolve({ assignees: [], labels: [], completion_chart: { old: 1 } });
    await first;

    expect(store.getCycleById(SPRINT)?.total_issues).toBe(5);
    expect(store.getCycleById(SPRINT)?.distribution?.completion_chart).toEqual({ new: 1 });
  });

  it("a failed part keeps the previous value of that part and applies the rest", async () => {
    const { store, service } = createCycleStore();
    service.workspaceActiveCyclesProgress.mockResolvedValue({ total_issues: 4 });
    service.workspaceActiveCyclesAnalytics.mockRejectedValue(new Error("network"));

    await store.refreshCycleStats("ws", "project-1", SPRINT);

    expect(store.getCycleById(SPRINT)?.total_issues).toBe(4);
    expect(store.getCycleById(SPRINT)?.distribution).toEqual(OLD_DISTRIBUTION);
  });

  // Fix round 1 (review): the analytics endpoint answers 400 for a sprint without dates (a draft) — every 30 s.
  it("a draft sprint without dates re-reads only its progress (and details after a change), never the analytics", async () => {
    const { store, service } = createCycleStore(true, { start_date: null, end_date: null });
    service.workspaceActiveCyclesProgress.mockResolvedValue({ total_issues: 2 });
    service.getCycleDetails.mockResolvedValue({ id: SPRINT, assignee_ids: ["owner"] });

    await store.refreshCycleStats("ws", "project-1", SPRINT, { withDetails: true });
    const half = createCycleStore(false, { start_date: "2026-09-22", end_date: null });
    half.service.workspaceActiveCyclesProgress.mockResolvedValue({ total_issues: 1 });
    await half.store.refreshCycleStats("ws", "project-1", SPRINT);

    expect(service.workspaceActiveCyclesAnalytics).not.toHaveBeenCalled();
    expect(half.service.workspaceActiveCyclesAnalytics).not.toHaveBeenCalled();
    expect(store.getCycleById(SPRINT)?.total_issues).toBe(2);
    expect(store.getCycleById(SPRINT)?.assignee_ids).toEqual(["owner"]);
    expect(store.getCycleById(SPRINT)?.distribution).toEqual(OLD_DISTRIBUTION);
  });

  it("a sprint deleted while its numbers were being read is not brought back", async () => {
    const { store, service } = createCycleStore();
    const progress = deferred<object>();
    service.workspaceActiveCyclesProgress.mockReturnValue(progress.promise);
    service.workspaceActiveCyclesAnalytics.mockResolvedValue({ assignees: [], labels: [], completion_chart: {} });

    const pending = store.refreshCycleStats("ws", "project-1", SPRINT);
    runInAction(() => {
      delete store.cycleMap[SPRINT];
    });
    progress.resolve({ total_issues: 9 });
    await pending;
    await flush();

    expect(store.getCycleById(SPRINT)).toBeNull();
  });
});

const MODULE = "module-1";

function createModuleStore() {
  const root = { router: { projectId: "project-1" } } as unknown as CoreRootStore;
  const store = new ModulesStore(root);
  runInAction(() => {
    store.moduleMap[MODULE] = { id: MODULE, name: "Направление", total_issues: 1 } as unknown as IModule;
  });
  const service = { getModuleDetails: vi.fn() };
  store.moduleService = service as unknown as ModulesStore["moduleService"];
  return { store, service };
}

describe("line S: ModulesStore.refreshModuleStats", () => {
  it("re-reads the module details (its numbers and distribution) like the detail page does", async () => {
    const { store, service } = createModuleStore();
    service.getModuleDetails.mockResolvedValue({ id: MODULE, name: "Направление", total_issues: 3 });

    await store.refreshModuleStats("ws", "project-1", MODULE);

    expect(store.getModuleById(MODULE)?.total_issues).toBe(3);
    expect(service.getModuleDetails).toHaveBeenCalledWith("ws", "project-1", MODULE);
  });

  it("ignores an older answer and does not bring back a deleted module", async () => {
    const { store, service } = createModuleStore();
    const older = deferred<object>();
    service.getModuleDetails.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ id: MODULE, total_issues: 7 });

    const first = store.refreshModuleStats("ws", "project-1", MODULE);
    await store.refreshModuleStats("ws", "project-1", MODULE);
    older.resolve({ id: MODULE, total_issues: 2 });
    await first;
    expect(store.getModuleById(MODULE)?.total_issues).toBe(7);

    const again = deferred<object>();
    service.getModuleDetails.mockReturnValueOnce(again.promise);
    const pending = store.refreshModuleStats("ws", "project-1", MODULE);
    runInAction(() => {
      delete store.moduleMap[MODULE];
    });
    again.resolve({ id: MODULE, total_issues: 1 });
    await pending;
    expect(store.getModuleById(MODULE)).toBeNull();
  });
});
