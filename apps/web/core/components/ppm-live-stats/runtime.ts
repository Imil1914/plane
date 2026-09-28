/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM line S: ties the refresh scheduler to the tab's MobX stores.
 *
 * While at least one sprint/module panel is on screen, a MobX reaction reads the work-item map (only the sprint and
 * module of every item, plus the counted fields of the watched members) and the watched subjects' dates; after every
 * store action it compares with the previous snapshot and tells the scheduler which subjects changed. A reaction never
 * throws into the store action that caused it (MobX reports reaction errors separately), and it is disposed together
 * with the last panel.
 *
 * Some writes do not show in the map — e.g. «Добавить существующие задачи» loads tasks this tab never had, and they
 * arrive already in the sprint. The task store reports those itself, once the server has saved them
 * (`notifyLiveStats`); an optimistic edit reported again after the save is re-read after a slow save too.
 */
import { observable, reaction, runInAction } from "mobx";
import { createBrowserLiveStatsEnv, createLiveStatsScheduler } from "./refresh-scheduler";
import type { TLiveStatsEnv, TLiveStatsRefresh, TLiveStatsSubject } from "./refresh-scheduler";
import { collectLiveStatsSnapshot, diffLiveStatsSnapshots, liveStatsSubjectKey } from "./work-item-changes";
import type { TLiveStatsIssue } from "./work-item-changes";

type TDates = { start_date?: string | null; end_date?: string | null; target_date?: string | null };

/** The part of the root store the runtime reads. */
export type TLiveStatsStore = {
  issue: { issues: { issuesMap: Readonly<Record<string, TLiveStatsIssue | undefined>> } };
  cycle: { cycleMap: Readonly<Record<string, TDates | undefined>> };
  module: { moduleMap: Readonly<Record<string, TDates | undefined>> };
};

export type TLiveStatsRuntime = {
  watch: (
    key: string,
    subject: TLiveStatsSubject,
    refresh: TLiveStatsRefresh,
    options?: { refreshNow?: boolean }
  ) => () => void;
  /** Work items of these subjects were changed in this tab (only watched subjects are refreshed). */
  notify: (subjects: readonly TLiveStatsSubject[]) => void;
  isIdle: () => boolean;
};

const rangeOf = (store: TLiveStatsStore, subject: TLiveStatsSubject) => {
  const dates = subject.type === "cycle" ? store.cycle?.cycleMap?.[subject.id] : store.module?.moduleMap?.[subject.id];
  if (!dates) return "";
  return `${dates.start_date ?? ""}|${subject.type === "cycle" ? (dates.end_date ?? "") : (dates.target_date ?? "")}`;
};

export function createLiveStatsRuntime(store: TLiveStatsStore, env: TLiveStatsEnv): TLiveStatsRuntime {
  const scheduler = createLiveStatsScheduler(env);
  // subject key → number of panels showing it; observable, so the reaction follows panels opening and closing
  const watched = observable.map<string, number>({}, { deep: false });
  let disposeReaction: (() => void) | undefined;

  const startReaction = () => {
    disposeReaction = reaction(
      () => {
        const cycles = new Set<string>();
        const modules = new Set<string>();
        for (const key of watched.keys()) {
          const separator = key.indexOf(":");
          (key.slice(0, separator) === "cycle" ? cycles : modules).add(key.slice(separator + 1));
        }
        // optional chaining: a store being replaced (sign-out) must not make the reaction throw
        return collectLiveStatsSnapshot(store.issue?.issues?.issuesMap, { cycles, modules }, (subject) =>
          rangeOf(store, subject)
        );
      },
      (after, before) => {
        const changed = diffLiveStatsSnapshots(before, after);
        if (changed.length > 0) scheduler.notify(changed);
      }
    );
  };

  const watch: TLiveStatsRuntime["watch"] = (key, subject, refresh, options) => {
    const subjectKey = liveStatsSubjectKey(subject);
    const unwatchScheduler = scheduler.watch(key, subject, refresh, options);
    runInAction(() => {
      watched.set(subjectKey, (watched.get(subjectKey) ?? 0) + 1);
    });
    if (!disposeReaction) startReaction();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unwatchScheduler();
      runInAction(() => {
        const left = (watched.get(subjectKey) ?? 1) - 1;
        if (left > 0) watched.set(subjectKey, left);
        else watched.delete(subjectKey);
      });
      if (watched.size === 0 && disposeReaction) {
        disposeReaction();
        disposeReaction = undefined;
      }
    };
  };

  return {
    watch,
    notify: (subjects) => scheduler.notify(subjects),
    isIdle: () => scheduler.isIdle() && !disposeReaction,
  };
}

const runtimes = new WeakMap<object, TLiveStatsRuntime>();

/** One runtime per root store object (the browser by default; tests pass their own clock and visibility). */
export function getLiveStatsRuntime(
  store: TLiveStatsStore,
  createEnv: () => TLiveStatsEnv = createBrowserLiveStatsEnv
): TLiveStatsRuntime {
  let runtime = runtimes.get(store);
  if (!runtime) {
    runtime = createLiveStatsRuntime(store, createEnv());
    runtimes.set(store, runtime);
  }
  return runtime;
}

/**
 * Called by the task store after the server saved a change of these sprints'/modules' work items. Does nothing (and
 * creates nothing) while no panel of this root store is open; empty ids are skipped. Never throws: the store calls it
 * inside blocks that roll an optimistic change back on error, and a failed notice must not undo what the server saved.
 */
export function notifyLiveStats(
  rootStore: object,
  {
    cycleIds = [],
    moduleIds = [],
  }: { cycleIds?: readonly (string | null | undefined)[]; moduleIds?: readonly (string | null | undefined)[] }
): void {
  try {
    const runtime = runtimes.get(rootStore);
    if (!runtime) return;
    const subjects: TLiveStatsSubject[] = [
      ...cycleIds.filter((id): id is string => !!id).map((id) => ({ type: "cycle" as const, id })),
      ...moduleIds.filter((id): id is string => !!id).map((id) => ({ type: "module" as const, id })),
    ];
    if (subjects.length > 0) runtime.notify(subjects);
  } catch {
    // the panels catch up on the next 30 s poll or when the user comes back to the tab
  }
}
