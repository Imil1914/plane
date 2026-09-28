/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S: which edits of the work-item map touch a sprint/module whose numbers are on screen. Everything the tab changes
// lands in one map (status, assignees, labels, priority, estimate, sprint, modules, archive, delete); rows that a list
// merely loads are not "changes" — otherwise opening a list would re-read the charts.
import { describe, expect, it } from "vitest";
import {
  collectLiveStatsSnapshot,
  diffLiveStatsSnapshots,
  EMPTY_LIVE_STATS_WATCH,
} from "@/components/ppm-live-stats/work-item-changes";
import type { TLiveStatsIssue, TLiveStatsWatch } from "@/components/ppm-live-stats/work-item-changes";

const SPRINT = "sprint-1";
const NEXT_SPRINT = "sprint-2";
const MODULE = "module-1";

const task = (id: string, patch: Partial<TLiveStatsIssue> = {}): TLiveStatsIssue => ({
  id,
  cycle_id: SPRINT,
  module_ids: [],
  state_id: "todo",
  priority: "none",
  estimate_point: null,
  assignee_ids: [],
  label_ids: [],
  archived_at: null,
  ...patch,
});

const watch = (cycles: string[] = [SPRINT], modules: string[] = []): TLiveStatsWatch => ({
  cycles: new Set(cycles),
  modules: new Set(modules),
});

const changedSubjects = (
  before: Record<string, TLiveStatsIssue>,
  after: Record<string, TLiveStatsIssue>,
  watched: TLiveStatsWatch = watch(),
  ranges: { before?: Record<string, string>; after?: Record<string, string> } = {}
) =>
  diffLiveStatsSnapshots(
    collectLiveStatsSnapshot(before, watched, (subject) => ranges.before?.[subject.id]),
    collectLiveStatsSnapshot(after, watched, (subject) => ranges.after?.[subject.id])
  );

describe("line S: edits of a sprint's work items are changes of that sprint", () => {
  const base = { a: task("a"), b: task("b", { assignee_ids: ["u1"] }) };

  it.each([
    ["status", { state_id: "done" }],
    ["assignee added (the owner's case: «Ответственные» stayed empty)", { assignee_ids: ["u2"] }],
    ["labels", { label_ids: ["bug"] }],
    ["priority", { priority: "urgent" }],
    ["estimate", { estimate_point: "p3" }],
    ["archived", { archived_at: "2026-09-28T10:00:00Z" }],
  ] as Array<[string, Partial<TLiveStatsIssue>]>)("%s", (_name, patch) => {
    expect(changedSubjects(base, { ...base, a: task("a", patch) })).toEqual([{ type: "cycle", id: SPRINT }]);
  });

  it("the order of assignees/labels alone is not a change", () => {
    const before = { a: task("a", { assignee_ids: ["u1", "u2"], label_ids: ["x", "y"] }) };
    const after = { a: task("a", { assignee_ids: ["u2", "u1"], label_ids: ["y", "x"] }) };
    expect(changedSubjects(before, after)).toEqual([]);
  });

  it("a known task added to the sprint (its sprint set to this one) is a change", () => {
    const before = { ...base, c: task("c", { cycle_id: null }) };
    const after = { ...base, c: task("c", { cycle_id: SPRINT }) };
    expect(changedSubjects(before, after)).toEqual([{ type: "cycle", id: SPRINT }]);
  });

  it("a task taken out of the sprint or deleted is a change", () => {
    expect(changedSubjects(base, { ...base, a: task("a", { cycle_id: null }) })).toEqual([
      { type: "cycle", id: SPRINT },
    ]);
    expect(changedSubjects(base, { b: base.b })).toEqual([{ type: "cycle", id: SPRINT }]);
  });

  it("moving a task between two watched sprints changes both", () => {
    const watched = watch([SPRINT, NEXT_SPRINT]);
    const after = { ...base, a: task("a", { cycle_id: NEXT_SPRINT }) };
    expect(changedSubjects(base, after, watched)).toEqual([
      { type: "cycle", id: SPRINT },
      { type: "cycle", id: NEXT_SPRINT },
    ]);
  });

  it("new sprint dates are a change (the burndown range moves)", () => {
    expect(
      changedSubjects(base, base, watch(), {
        before: { [SPRINT]: "2026-09-22|2026-10-05" },
        after: { [SPRINT]: "2026-09-22|2026-10-12" },
      })
    ).toEqual([{ type: "cycle", id: SPRINT }]);
  });
});

describe("line S: what is not a change", () => {
  const base = { a: task("a"), b: task("b") };

  it("rows a list merely loads (unknown to the tab before) do not re-read the charts", () => {
    const after = { ...base, c: task("c"), d: task("d", { priority: "urgent" }) };
    expect(changedSubjects(base, after)).toEqual([]);
  });

  it("the same task re-read from the server with the same values is not a change", () => {
    expect(changedSubjects(base, { a: { ...task("a") }, b: { ...task("b") } })).toEqual([]);
  });

  it("edits of tasks of a sprint nobody looks at are ignored", () => {
    const before = { ...base, x: task("x", { cycle_id: "sprint-9" }) };
    const after = { ...base, x: task("x", { cycle_id: "sprint-9", state_id: "done" }) };
    expect(changedSubjects(before, after)).toEqual([]);
  });

  it("a sprint that just became watched starts from a baseline", () => {
    const before = collectLiveStatsSnapshot(base, EMPTY_LIVE_STATS_WATCH);
    const after = collectLiveStatsSnapshot({ ...base, a: task("a", { state_id: "done" }) }, watch());
    expect(diffLiveStatsSnapshots(before, after)).toEqual([]);
  });

  it("a missing map entry is skipped", () => {
    expect(changedSubjects(base, { ...base, ghost: undefined as unknown as TLiveStatsIssue })).toEqual([]);
  });
});

describe("line S: modules (направления) follow the same rules", () => {
  const moduleWatch = watch([], [MODULE]);
  const base = { a: task("a", { cycle_id: null, module_ids: [MODULE] }), b: task("b", { cycle_id: null }) };

  it("a status change of a module task is a change of the module", () => {
    expect(
      changedSubjects(
        base,
        { ...base, a: task("a", { cycle_id: null, module_ids: [MODULE], state_id: "done" }) },
        moduleWatch
      )
    ).toEqual([{ type: "module", id: MODULE }]);
  });

  it("adding a known task to the module or removing it is a change", () => {
    const added = { ...base, b: task("b", { cycle_id: null, module_ids: [MODULE] }) };
    const removed = { ...base, a: task("a", { cycle_id: null, module_ids: [] }) };
    expect(changedSubjects(base, added, moduleWatch)).toEqual([{ type: "module", id: MODULE }]);
    expect(changedSubjects(base, removed, moduleWatch)).toEqual([{ type: "module", id: MODULE }]);
  });

  it("a task in both a watched sprint and a watched module changes both", () => {
    const both = watch([SPRINT], [MODULE]);
    const before = { a: task("a", { module_ids: [MODULE] }) };
    const after = { a: task("a", { module_ids: [MODULE], priority: "high" }) };
    expect(changedSubjects(before, after, both)).toEqual([
      { type: "cycle", id: SPRINT },
      { type: "module", id: MODULE },
    ]);
  });
});
