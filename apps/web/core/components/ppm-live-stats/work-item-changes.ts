/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line S: which edits of the tab's work-item map touch a watched sprint/module.
 *
 * Every change this tab makes to a work item ends up in one place — `rootStore.issue.issues.issuesMap` (status,
 * assignees, labels, priority, estimate, sprint, modules, archive; a deleted item leaves the map). Comparing two
 * snapshots of the watched sprints/modules gives the "what changed" without touching the many call sites:
 *  - a member whose counted fields changed, a member that left (moved, deleted), and an item the tab already knew that
 *    joined (its sprint/module set) are changes;
 *  - rows a list merely loads (the tab did not know them before) and re-reads with the same values are not — opening a
 *    list must not re-read the charts;
 *  - new sprint/module dates are a change (the burndown range moves).
 */
import { sortBy } from "lodash-es";
import type { TLiveStatsSubject } from "./refresh-scheduler";

/** The fields of a work item that the sprint/module numbers are counted from. */
export type TLiveStatsIssue = {
  id?: string;
  cycle_id?: string | null;
  module_ids?: readonly string[] | null;
  state_id?: string | null;
  priority?: string | null;
  estimate_point?: string | null;
  assignee_ids?: readonly string[] | null;
  label_ids?: readonly string[] | null;
  archived_at?: string | null;
};

export type TLiveStatsWatch = { cycles: ReadonlySet<string>; modules: ReadonlySet<string> };

export const EMPTY_LIVE_STATS_WATCH: TLiveStatsWatch = { cycles: new Set(), modules: new Set() };

export type TLiveStatsSnapshot = {
  /** ids of every work item in the map */
  known: ReadonlySet<string>;
  /** watched subject key → member id → fingerprint of the counted fields */
  members: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** watched subject key → its dates */
  ranges: ReadonlyMap<string, string>;
};

export const liveStatsSubjectKey = (subject: TLiveStatsSubject) => `${subject.type}:${subject.id}`;

const subjectFromKey = (key: string): TLiveStatsSubject => {
  const separator = key.indexOf(":");
  return { type: key.slice(0, separator) as TLiveStatsSubject["type"], id: key.slice(separator + 1) };
};

// `sortBy` returns a sorted copy: the stored arrays are MobX observables and must never be reordered in place.
const sortedList = (values: readonly string[] | null | undefined) => (values ? sortBy(values).join(",") : "");

const fingerprint = (issue: TLiveStatsIssue) =>
  [
    issue.state_id ?? "",
    issue.priority ?? "",
    issue.estimate_point ?? "",
    sortedList(issue.assignee_ids),
    sortedList(issue.label_ids),
    issue.archived_at ? "archived" : "",
  ].join("|");

/**
 * Reads the map (inside a MobX reaction this also subscribes to exactly these fields): every item's sprint/modules,
 * and the counted fields of the watched members only.
 */
export function collectLiveStatsSnapshot(
  issues: Readonly<Record<string, TLiveStatsIssue | undefined>> | undefined,
  watched: TLiveStatsWatch,
  rangeOf?: (subject: TLiveStatsSubject) => string | undefined
): TLiveStatsSnapshot {
  const known = new Set<string>();
  const members = new Map<string, Map<string, string>>();
  const ranges = new Map<string, string>();
  const watchedSubjects: TLiveStatsSubject[] = [
    ...[...watched.cycles].map((id) => ({ type: "cycle" as const, id })),
    ...[...watched.modules].map((id) => ({ type: "module" as const, id })),
  ];
  for (const subject of watchedSubjects) {
    const key = liveStatsSubjectKey(subject);
    members.set(key, new Map());
    ranges.set(key, rangeOf?.(subject) ?? "");
  }
  const withModules = watched.modules.size > 0;

  for (const issueId of Object.keys(issues ?? {})) {
    const issue = issues?.[issueId];
    if (!issue) continue;
    known.add(issueId);
    const targets: Map<string, string>[] = [];
    const cycleId = issue.cycle_id;
    if (cycleId && watched.cycles.has(cycleId)) targets.push(members.get(`cycle:${cycleId}`)!);
    if (withModules && issue.module_ids) {
      for (const moduleId of issue.module_ids) {
        if (watched.modules.has(moduleId)) targets.push(members.get(`module:${moduleId}`)!);
      }
    }
    if (targets.length === 0) continue;
    const value = fingerprint(issue);
    for (const target of targets) target.set(issueId, value);
  }

  return { known, members, ranges };
}

const membersChanged = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  knownBefore: ReadonlySet<string>
) => {
  for (const [issueId, value] of before) {
    if (after.get(issueId) !== value) return true;
  }
  for (const issueId of after.keys()) {
    if (!before.has(issueId) && knownBefore.has(issueId)) return true;
  }
  return false;
};

/** Subjects watched in both snapshots whose numbers may have changed (a newly watched subject is a baseline). */
export function diffLiveStatsSnapshots(before: TLiveStatsSnapshot, after: TLiveStatsSnapshot): TLiveStatsSubject[] {
  const changed: TLiveStatsSubject[] = [];
  for (const [key, afterMembers] of after.members) {
    const beforeMembers = before.members.get(key);
    if (!beforeMembers) continue;
    if (before.ranges.get(key) !== after.ranges.get(key) || membersChanged(beforeMembers, afterMembers, before.known)) {
      changed.push(subjectFromKey(key));
    }
  }
  return changed;
}
