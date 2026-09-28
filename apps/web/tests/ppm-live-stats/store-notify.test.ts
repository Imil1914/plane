/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S, fix round 1 (review): writes the work-item map cannot show. «Добавить существующие задачи» loads tasks this tab
// never had — they arrive already in the sprint, so comparing snapshots sees "a list loaded rows" and the panel stayed
// stale. The task store now tells the open panels itself once the server has saved the change (sprint/module add and
// remove, and property edits — an optimistic edit is re-read again after a slow save). The real BaseIssuesStore
// methods run against fake services and a MobX map that behaves like IssueStore.
import { set, update } from "lodash-es";
import { observable, runInAction } from "mobx";
import { describe, expect, it, vi } from "vitest";
import type { TIssue } from "@plane/types";
import { LIVE_STATS_TIMINGS } from "@/components/ppm-live-stats/refresh-scheduler";
import type { TLiveStatsSubject } from "@/components/ppm-live-stats/refresh-scheduler";
import { getLiveStatsRuntime, notifyLiveStats } from "@/components/ppm-live-stats/runtime";
import { BaseIssuesStore } from "@/store/issue/helpers/base-issues.store";
import type { IBaseIssueFilterStore } from "@/store/issue/helpers/issue-filter-helper.store";
import type { IIssueRootStore } from "@/store/issue/root.store";
import { createFakeLiveStatsEnv } from "./fake-env";

// base-issues-utils imports the app-wide store; the methods under test never touch it
vi.mock("@/lib/store-context", () => ({ store: {}, rootStore: {} }));

const SPRINT = "sprint-1";
const MODULE = "module-1";

const row = (id: string, patch: Partial<TIssue> = {}) =>
  ({
    id,
    project_id: "project-1",
    cycle_id: null,
    module_ids: [],
    state_id: "todo",
    priority: "none",
    estimate_point: null,
    assignee_ids: [],
    label_ids: [],
    archived_at: null,
    ...patch,
  }) as unknown as TIssue;

type TDeferred = { promise: Promise<object>; resolve: () => void };
const deferred = (): TDeferred => {
  let settle: ((value: object) => void) | undefined;
  const promise = new Promise<object>((res) => {
    settle = res;
  });
  return { promise, resolve: () => settle?.({}) };
};

class TestIssues extends BaseIssuesStore {
  fetchParentStats = () => undefined;
  updateParentStats = () => undefined;
}

function setup(known: TIssue[] = [], server: Record<string, TIssue> = {}) {
  const issuesMap = observable({} as Record<string, TIssue>);
  runInAction(() => {
    for (const issue of known) set(issuesMap, issue.id, issue);
  });
  // what IssueStore does
  const issues = {
    issuesMap,
    getIssueById: (id: string) => issuesMap[id],
    getIssues: vi.fn(async (_ws: string, _project: string, ids: string[]) => {
      const rows = ids.map((id) => server[id]).filter(Boolean);
      runInAction(() => {
        for (const issue of rows) if (!issuesMap[issue.id]) set(issuesMap, issue.id, issue);
      });
      return rows;
    }),
    addIssue: (rows: TIssue[]) =>
      runInAction(() => {
        for (const issue of rows) {
          if (!issuesMap[issue.id]) set(issuesMap, issue.id, issue);
          else update(issuesMap, issue.id, (previous) => ({ ...previous, ...issue }));
        }
      }),
    updateIssue: (id: string, data: Partial<TIssue>) => {
      if (!issuesMap[id]) return;
      runInAction(() => {
        set(issuesMap, [id, "updated_at"], new Date().toISOString());
        for (const key of Object.keys(data)) set(issuesMap, [id, key], data[key as keyof TIssue]);
      });
    },
    removeIssue: (id: string) =>
      runInAction(() => {
        delete issuesMap[id];
      }),
  };
  const rootStore = {
    issue: { issues },
    cycle: observable({ cycleMap: { [SPRINT]: { start_date: "2026-09-22", end_date: "2026-10-05" } } }),
    module: observable({ moduleMap: { [MODULE]: { start_date: "2026-09-01", target_date: "2026-12-01" } } }),
  };
  const rootIssueStore = { rootStore, issues, cycleId: undefined, moduleId: undefined };
  const store = new TestIssues(
    rootIssueStore as unknown as IIssueRootStore,
    { issueFilters: undefined } as unknown as IBaseIssueFilterStore
  );
  // list bookkeeping is not what these tests are about
  store.updateIssueList = vi.fn();
  const issueService = {
    addIssueToCycle: vi.fn(async () => ({})),
    removeIssueFromCycle: vi.fn(async () => ({})),
    patchIssue: vi.fn(async () => ({})),
  };
  const moduleService = {
    addIssuesToModule: vi.fn(async () => ({})),
    removeIssuesFromModuleBulk: vi.fn(async () => ({})),
    addModulesToIssue: vi.fn(async () => ({})),
  };
  store.issueService = issueService as unknown as TestIssues["issueService"];
  store.moduleService = moduleService as unknown as TestIssues["moduleService"];

  const fake = createFakeLiveStatsEnv();
  const runtime = getLiveStatsRuntime(rootStore, () => fake.env);
  const sprintRefreshes: number[] = [];
  const moduleRefreshes: number[] = [];
  runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, () => {
    sprintRefreshes.push(fake.now());
  });
  runtime.watch("module-stats:module-1", { type: "module", id: MODULE }, () => {
    moduleRefreshes.push(fake.now());
  });
  const settle = () => fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
  return {
    store,
    issues,
    issueService,
    moduleService,
    fake,
    runtime,
    sprintRefreshes,
    moduleRefreshes,
    settle,
    rootStore,
  };
}

describe("line S (fix round 1): «Добавить существующие задачи» and other writes the map cannot show", () => {
  it("tasks this tab never loaded, added to the watched sprint, refresh the sprint once", async () => {
    const { store, issues, sprintRefreshes, settle } = setup([], {
      x: row("x", { cycle_id: SPRINT }),
      y: row("y", { cycle_id: SPRINT, assignee_ids: ["owner"] as unknown as TIssue["assignee_ids"] }),
    });

    await store.addIssueToCycle("ws", "project-1", SPRINT, ["x", "y"]);
    await settle();

    expect(issues.getIssues).toHaveBeenCalledTimes(1);
    expect(sprintRefreshes).toHaveLength(1);
  });

  it("a task this tab never loaded, taken out of the watched sprint, refreshes the sprint", async () => {
    const { store, issueService, sprintRefreshes, settle } = setup();

    await store.removeIssueFromCycle("ws", "project-1", SPRINT, "z");
    await settle();

    expect(issueService.removeIssueFromCycle).toHaveBeenCalledWith("ws", "project-1", SPRINT, "z");
    expect(sprintRefreshes).toHaveLength(1);
  });

  it("the same for modules: unknown tasks added to or removed from the watched module", async () => {
    const { store, moduleRefreshes, settle, fake } = setup([], { x: row("x", { module_ids: [MODULE] }) });

    await store.addIssuesToModule("ws", "project-1", MODULE, ["x"]);
    await settle();
    expect(moduleRefreshes).toHaveLength(1);

    await fake.advance(1000);
    await store.removeIssuesFromModule("ws", "project-1", MODULE, ["z"]);
    await settle();
    expect(moduleRefreshes).toHaveLength(2);
  });

  it("a task created with its modules (addModulesToIssue) refreshes the module", async () => {
    const { store, moduleRefreshes, settle } = setup([row("n")]);

    await store.addModulesToIssue("ws", "project-1", "n", [MODULE]);
    await settle();

    expect(moduleRefreshes).toHaveLength(1);
  });

  it("an edit on a slow server is re-read again after the server saved it", async () => {
    const { store, issueService, sprintRefreshes, settle, fake } = setup([row("a", { cycle_id: SPRINT })]);
    const save = deferred();
    issueService.patchIssue.mockReturnValueOnce(save.promise);

    const pending = store.issueUpdate("ws", "project-1", "a", { state_id: "done" });
    await fake.advance(2000);
    const savedAt = fake.now();
    save.resolve();
    await pending;
    await settle();

    expect(sprintRefreshes.some((at) => at >= savedAt)).toBe(true);
  });

  it("moving a known task into the sprint on a slow server is re-read after the save as well", async () => {
    const { store, issueService, sprintRefreshes, settle, fake } = setup([row("a")]);
    const save = deferred();
    issueService.addIssueToCycle.mockReturnValueOnce(save.promise);

    const pending = store.addCycleToIssue("ws", "project-1", SPRINT, "a");
    await fake.advance(2000);
    const savedAt = fake.now();
    save.resolve();
    await pending;
    await settle();

    expect(sprintRefreshes.some((at) => at >= savedAt)).toBe(true);
  });

  it("with no panel open the store's notice does nothing (and creates nothing)", () => {
    expect(() => notifyLiveStats({}, { cycleIds: [SPRINT, null, undefined], moduleIds: [MODULE] })).not.toThrow();
  });

  // Round 2 (review): the same after-save notice on the other two optimistic single-task paths.
  it("taking a known task out of the sprint on a slow server is re-read after the save as well", async () => {
    const { store, issueService, sprintRefreshes, settle, fake } = setup([row("a", { cycle_id: SPRINT })]);
    const save = deferred();
    issueService.removeIssueFromCycle.mockReturnValueOnce(save.promise);

    const pending = store.removeCycleFromIssue("ws", "project-1", "a");
    await fake.advance(2000);
    const savedAt = fake.now();
    save.resolve();
    await pending;
    await settle();

    expect(issueService.removeIssueFromCycle).toHaveBeenCalledWith("ws", "project-1", SPRINT, "a");
    expect(sprintRefreshes.some((at) => at >= savedAt)).toBe(true);
  });

  it("changing a known task's modules on a slow server is re-read after the save as well", async () => {
    const { store, moduleService, moduleRefreshes, settle, fake } = setup([row("a")]);
    const save = deferred();
    moduleService.addModulesToIssue.mockReturnValueOnce(save.promise);

    const pending = store.changeModulesInIssue("ws", "project-1", "a", [MODULE], []);
    await fake.advance(2000);
    const savedAt = fake.now();
    save.resolve();
    await pending;
    await settle();

    expect(moduleRefreshes.some((at) => at >= savedAt)).toBe(true);
  });

  // Round 2 (review): the bulk add, like the single one, tells both ends.
  it("the bulk add tells the target sprint and, once each, the sprints the tasks left", async () => {
    const OLD_SPRINT = "sprint-0";
    const { store, runtime } = setup([row("k1", { cycle_id: OLD_SPRINT }), row("k2", { cycle_id: OLD_SPRINT })], {
      u: row("u", { cycle_id: SPRINT }),
    });
    const notices: TLiveStatsSubject[][] = [];
    runtime.notify = (subjects) => {
      notices.push([...subjects]);
    };

    await store.addIssueToCycle("ws", "project-1", SPRINT, ["k1", "k2", "u"]);

    expect(notices).toEqual([
      [
        { type: "cycle", id: SPRINT },
        { type: "cycle", id: OLD_SPRINT },
      ],
    ]);
  });

  // Round 2 (review): a notice is sent from inside try blocks that roll the optimistic change back on error.
  it("a notice that throws never rolls back a change the server has already saved", async () => {
    const { store, issues, runtime } = setup([row("a", { cycle_id: SPRINT })]);
    runtime.notify = () => {
      throw new Error("broken notice");
    };

    await expect(store.issueUpdate("ws", "project-1", "a", { state_id: "done" })).resolves.toBeUndefined();
    expect(issues.issuesMap.a.state_id).toBe("done");

    await expect(store.removeCycleFromIssue("ws", "project-1", "a")).resolves.toBeUndefined();
    expect(issues.issuesMap.a.cycle_id).toBeNull();

    await expect(store.addCycleToIssue("ws", "project-1", SPRINT, "a")).resolves.toBeUndefined();
    expect(issues.issuesMap.a.cycle_id).toBe(SPRINT);

    await expect(store.changeModulesInIssue("ws", "project-1", "a", [MODULE], [])).resolves.toBeUndefined();
    expect([...(issues.issuesMap.a.module_ids ?? [])]).toEqual([MODULE]);
  });
});
