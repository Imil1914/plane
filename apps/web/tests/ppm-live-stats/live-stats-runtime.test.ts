/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S: the runtime watches the tab's work-item map (MobX) while a sprint/module panel is on screen. The store edits
// below copy what `IssueStore.updateIssue/addIssue/removeIssue` do (lodash `set`/`update`/`delete` inside an action).
import { get, pull, set, update } from "lodash-es";
import { observable, runInAction } from "mobx";
import { describe, expect, it, vi } from "vitest";
import { LIVE_STATS_TIMINGS } from "@/components/ppm-live-stats/refresh-scheduler";
import { createLiveStatsRuntime } from "@/components/ppm-live-stats/runtime";
import type { TLiveStatsIssue } from "@/components/ppm-live-stats/work-item-changes";
import { createFakeLiveStatsEnv } from "./fake-env";

const SPRINT = "sprint-1";
const MODULE = "module-1";

const task = (id: string, patch: Partial<TLiveStatsIssue> = {}): TLiveStatsIssue => ({
  id,
  cycle_id: SPRINT,
  module_ids: [MODULE],
  state_id: "todo",
  priority: "none",
  estimate_point: null,
  assignee_ids: [],
  label_ids: [],
  archived_at: null,
  ...patch,
});

function setup() {
  const issues = observable({ issuesMap: { a: task("a"), b: task("b") } as Record<string, TLiveStatsIssue> });
  const cycles = observable({
    cycleMap: { [SPRINT]: { start_date: "2026-09-22", end_date: "2026-10-05" } } as Record<
      string,
      { start_date?: string | null; end_date?: string | null }
    >,
  });
  const modules = observable({
    moduleMap: { [MODULE]: { start_date: "2026-09-01", target_date: "2026-12-01" } } as Record<
      string,
      { start_date?: string | null; target_date?: string | null }
    >,
  });
  const store = { issue: { issues }, cycle: cycles, module: modules };
  const fake = createFakeLiveStatsEnv();
  const runtime = createLiveStatsRuntime(store, fake.env);
  const map = issues.issuesMap;
  // what IssueStore does
  const updateIssue = (id: string, patch: Partial<TLiveStatsIssue>) =>
    runInAction(() => {
      set(map, [id, "updated_at"], new Date().toISOString());
      for (const key of Object.keys(patch)) set(map, [id, key], patch[key as keyof TLiveStatsIssue]);
    });
  const addIssues = (rows: TLiveStatsIssue[]) =>
    runInAction(() => {
      for (const row of rows) {
        if (!map[row.id!]) set(map, row.id!, row);
        else update(map, row.id!, (previous) => ({ ...previous, ...row }));
      }
    });
  const removeIssue = (id: string) =>
    runInAction(() => {
      delete map[id];
    });
  const settle = () => fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
  return { store, fake, runtime, map, updateIssue, addIssues, removeIssue, settle, cycles };
}

describe("line S: the runtime turns edits of the tab's work items into one refresh", () => {
  it("assigning someone to a sprint task refreshes the sprint panel once", async () => {
    const { runtime, updateIssue, settle } = setup();
    const refresh = vi.fn(async () => undefined);
    runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, refresh);

    updateIssue("a", { assignee_ids: ["owner"] });
    updateIssue("b", { state_id: "done" });
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("change");
  });

  it("creating a task in the sprint (created, then its sprint set) and deleting one are changes", async () => {
    const { runtime, addIssues, updateIssue, removeIssue, settle } = setup();
    const refresh = vi.fn(async () => undefined);
    runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, refresh);

    addIssues([task("c", { cycle_id: null, module_ids: [] })]);
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    updateIssue("c", { cycle_id: SPRINT });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    removeIssue("a");
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a list that loads more rows or re-reads the same rows does not refresh", async () => {
    const { runtime, addIssues, settle } = setup();
    const refresh = vi.fn(async () => undefined);
    runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, refresh);

    addIssues([task("c"), task("d", { priority: "urgent" })]);
    addIssues([task("a"), task("b")]);
    await settle();

    expect(refresh).not.toHaveBeenCalled();
  });

  it("new sprint dates refresh the sprint (the burndown range changed)", async () => {
    const { runtime, cycles, settle } = setup();
    const refresh = vi.fn(async () => undefined);
    runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, refresh);

    runInAction(() => set(cycles.cycleMap, [SPRINT, "end_date"], "2026-10-12"));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("removing a task from a module in place (lodash pull on the stored array) refreshes the module", async () => {
    const { runtime, map, updateIssue, settle } = setup();
    const refresh = vi.fn(async () => undefined);
    runtime.watch("module-stats:module-1", { type: "module", id: MODULE }, refresh);

    const moduleIds = get(map, ["a", "module_ids"]) as string[];
    runInAction(() => pull(moduleIds, MODULE));
    updateIssue("a", { module_ids: moduleIds });
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never breaks a store action, even when two tasks share one stored array", () => {
    const { runtime, map } = setup();
    runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, async () => undefined);

    expect(() => runInAction(() => set(map, ["b", "label_ids"], map.a.label_ids))).not.toThrow();
  });

  it("after the last panel is gone, edits trigger nothing and no timer or listener is left", async () => {
    const { runtime, fake, updateIssue, settle } = setup();
    const refresh = vi.fn(async () => undefined);
    const unwatch = runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, refresh);

    unwatch();
    updateIssue("a", { state_id: "done" });
    await settle();
    await fake.advance(LIVE_STATS_TIMINGS.pollMs * 2);

    expect(refresh).not.toHaveBeenCalled();
    expect(runtime.isIdle()).toBe(true);
    expect(fake.timerCount()).toBe(0);
    expect(fake.listenerCount()).toBe(0);
  });

  it("switching sprints: the old one is no longer refreshed, the new one starts from a baseline", async () => {
    const { runtime, updateIssue, settle } = setup();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const unwatchFirst = runtime.watch("cycle-stats:sprint-1", { type: "cycle", id: SPRINT }, first);

    updateIssue("a", { priority: "high" });
    unwatchFirst();
    runtime.watch("cycle-stats:sprint-2", { type: "cycle", id: "sprint-2" }, second);
    await settle();
    updateIssue("b", { cycle_id: "sprint-2" });
    await settle();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
