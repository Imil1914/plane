// Line U-Web (UX2.1 U7): turns one coalesced event batch from the client into the existing store calls research
// ux21-facts.md §3 already names — `issueDetail.fetchIssue` merges into the shared `IssueStore` map (updates the card,
// every list/board reading the same map), `fetchIssuesWithExistingPagination` re-reads "the current view" with its
// last filters, and cycle/module events feed straight into line S's own `refresh-scheduler.notify()`. Every store call
// here is substituted (spies on fakes), per the brief.
import { describe, expect, it, vi } from "vitest";
import {
  PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD,
  applyPpmRealtimeEventsToCycleOrModule,
  applyPpmRealtimeEventsToProfile,
  applyPpmRealtimeEventsToProject,
  applyPpmRealtimeResyncToCycleOrModule,
  applyPpmRealtimeResyncToProfile,
  applyPpmRealtimeResyncToProject,
} from "@/components/ppm-realtime/store-bridge";
import type { TPpmRealtimeStore } from "@/components/ppm-realtime/store-bridge";
import { getLiveStatsRuntime } from "@/components/ppm-live-stats/runtime";
import { createFakeLiveStatsEnv } from "../ppm-live-stats/fake-env";
import { LIVE_STATS_TIMINGS } from "@/components/ppm-live-stats/refresh-scheduler";

function fakeStore(
  overrides: Partial<{
    loadedIssueIds: string[];
    projectPagination: unknown;
    profilePagination: unknown;
    cyclePagination: unknown;
    modulePagination: unknown;
  }> = {}
) {
  const loaded = new Set(overrides.loadedIssueIds ?? []);
  const projectPagination = "projectPagination" in overrides ? overrides.projectPagination : { perPageCount: 100 };
  const profilePagination = "profilePagination" in overrides ? overrides.profilePagination : { perPageCount: 100 };
  const cyclePagination = "cyclePagination" in overrides ? overrides.cyclePagination : { perPageCount: 100 };
  const modulePagination = "modulePagination" in overrides ? overrides.modulePagination : { perPageCount: 100 };
  const store: TPpmRealtimeStore & {
    issue: TPpmRealtimeStore["issue"] & {
      issueDetail: { issue: { fetchIssue: ReturnType<typeof vi.fn> } };
      projectIssues: { paginationOptions: unknown; fetchIssuesWithExistingPagination: ReturnType<typeof vi.fn> };
      profileIssues: { paginationOptions: unknown; fetchIssuesWithExistingPagination: ReturnType<typeof vi.fn> };
      cycleIssues: { paginationOptions: unknown; fetchIssuesWithExistingPagination: ReturnType<typeof vi.fn> };
      moduleIssues: { paginationOptions: unknown; fetchIssuesWithExistingPagination: ReturnType<typeof vi.fn> };
    };
    projectRoot: { project: { fetchProjectDetails: ReturnType<typeof vi.fn>; joinedProjectIds: string[] } };
  } = {
    issue: {
      issues: { issuesMap: {}, getIssueById: (id: string) => (loaded.has(id) ? { id } : undefined) },
      issueDetail: { issue: { fetchIssue: vi.fn().mockResolvedValue(undefined) } },
      projectIssues: {
        paginationOptions: projectPagination,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
      profileIssues: {
        paginationOptions: profilePagination,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
      cycleIssues: {
        paginationOptions: cyclePagination,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
      moduleIssues: {
        paginationOptions: modulePagination,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
    },
    cycle: { cycleMap: {} },
    module: { moduleMap: {} },
    projectRoot: { project: { fetchProjectDetails: vi.fn().mockResolvedValue(undefined), joinedProjectIds: [] } },
  };
  return store;
}

const emptyBatch = () => ({ issueUpdated: [], issueListChanged: [], cycleModuleChanged: [], projectChanged: [] });

const idsRange = (count: number, prefix = "issue") => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

describe("applyPpmRealtimeEventsToProject", () => {
  it("refetches an issue only when it is loaded, ignoring other projects' updates", () => {
    const store = fakeStore({ loadedIssueIds: ["issue-1"] });
    applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
      ...emptyBatch(),
      issueUpdated: [
        { projectId: "project-1", issueIds: ["issue-1", "issue-not-loaded"] },
        { projectId: "project-other", issueIds: ["issue-1"] },
      ],
    });
    expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledTimes(1);
    expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledWith("acme", "project-1", "issue-1");
  });

  it("re-reads the project's issue list once when it changed and the list was ever loaded", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToProject(store, "acme", "project-1", { ...emptyBatch(), issueListChanged: ["project-1"] });
    expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
      "acme",
      "project-1",
      "mutation"
    );
  });

  it("does not re-read the project's issue list for a different project, or one never loaded", () => {
    const neverLoaded = fakeStore({ projectPagination: undefined });
    applyPpmRealtimeEventsToProject(neverLoaded, "acme", "project-1", {
      ...emptyBatch(),
      issueListChanged: ["project-1"],
    });
    expect(neverLoaded.issue.projectIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();

    const otherProject = fakeStore();
    applyPpmRealtimeEventsToProject(otherProject, "acme", "project-1", {
      ...emptyBatch(),
      issueListChanged: ["project-2"],
    });
    expect(otherProject.issue.projectIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });

  it("refetches the project's own details when it changed", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToProject(store, "acme", "project-1", { ...emptyBatch(), projectChanged: ["project-1"] });
    expect(store.projectRoot.project.fetchProjectDetails).toHaveBeenCalledWith("acme", "project-1");
  });

  it("feeds cycle/module changes straight into the real line-S scheduler's notify()", async () => {
    const fake = createFakeLiveStatsEnv();
    const store = fakeStore();
    // Pre-seed the singleton runtime for this store object with the fake (deterministic) env, matching how the app
    // wires a real store to the real browser env — getLiveStatsRuntime only builds the env on the first call.
    const runtime = getLiveStatsRuntime(store, () => fake.env);
    const refresh = vi.fn(async () => undefined);
    runtime.watch("cycle-stats:cycle-1", { type: "cycle", id: "cycle-1" }, refresh);

    applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
      ...emptyBatch(),
      cycleModuleChanged: [{ type: "cycle", id: "cycle-1" }],
    });
    await fake.advance(LIVE_STATS_TIMINGS.changeDebounceMs);
    expect(refresh).toHaveBeenCalledWith("change");
  });

  it("never throws when a substituted store call rejects", () => {
    const store = fakeStore({ loadedIssueIds: ["issue-1"] });
    store.issue.issueDetail.issue.fetchIssue.mockRejectedValue(new Error("network down"));
    expect(() =>
      applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
        ...emptyBatch(),
        issueUpdated: [{ projectId: "project-1", issueIds: ["issue-1"] }],
      })
    ).not.toThrow();
  });

  describe("review round 1: a threshold caps individual fetchIssue calls (avoids a request avalanche)", () => {
    it("still does one fetchIssue per loaded id at exactly the threshold", () => {
      const ids = idsRange(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD);
      const store = fakeStore({ loadedIssueIds: ids });
      applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
        ...emptyBatch(),
        issueUpdated: [{ projectId: "project-1", issueIds: ids }],
      });
      expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledTimes(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD);
      expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
    });

    it("switches to one list refresh instead of N fetchIssue calls above the threshold", () => {
      const ids = idsRange(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD + 1);
      const store = fakeStore({ loadedIssueIds: ids });
      applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
        ...emptyBatch(),
        issueUpdated: [{ projectId: "project-1", issueIds: ids }],
      });
      expect(store.issue.issueDetail.issue.fetchIssue).not.toHaveBeenCalled();
      expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledTimes(1);
      expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
        "acme",
        "project-1",
        "mutation"
      );
    });

    it("counts only loaded ids toward the threshold — unloaded ones in the same batch don't tip it over", () => {
      const loaded = idsRange(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD, "loaded");
      const unloaded = idsRange(20, "unloaded");
      const store = fakeStore({ loadedIssueIds: loaded });
      applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
        ...emptyBatch(),
        issueUpdated: [{ projectId: "project-1", issueIds: [...loaded, ...unloaded] }],
      });
      expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledTimes(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD);
      expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
    });

    it("still only one list refresh when both issueListChanged and an over-threshold update fire together", () => {
      const ids = idsRange(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD + 5);
      const store = fakeStore({ loadedIssueIds: ids });
      applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
        ...emptyBatch(),
        issueListChanged: ["project-1"],
        issueUpdated: [{ projectId: "project-1", issueIds: ids }],
      });
      expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledTimes(1);
    });

    it("an over-threshold update with the list never loaded does nothing (no avalanche, no crash)", () => {
      const ids = idsRange(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD + 1);
      const store = fakeStore({ loadedIssueIds: ids, projectPagination: undefined });
      applyPpmRealtimeEventsToProject(store, "acme", "project-1", {
        ...emptyBatch(),
        issueUpdated: [{ projectId: "project-1", issueIds: ids }],
      });
      expect(store.issue.issueDetail.issue.fetchIssue).not.toHaveBeenCalled();
      expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
    });
  });
});

describe("applyPpmRealtimeResyncToProject", () => {
  it("re-reads the project's issue list (if loaded) and always its own details", () => {
    const store = fakeStore();
    applyPpmRealtimeResyncToProject(store, "acme", "project-1");
    expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
      "acme",
      "project-1",
      "mutation"
    );
    expect(store.projectRoot.project.fetchProjectDetails).toHaveBeenCalledWith("acme", "project-1");
  });

  it("skips the issue list when it was never loaded this session", () => {
    const store = fakeStore({ projectPagination: undefined });
    applyPpmRealtimeResyncToProject(store, "acme", "project-1");
    expect(store.issue.projectIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });
});

describe("applyPpmRealtimeEventsToProfile ('Мои задачи' spans several projects)", () => {
  const subscribed = new Set(["project-1", "project-2"]);

  it("refetches a loaded issue using its own project id, only from a subscribed project", () => {
    const store = fakeStore({ loadedIssueIds: ["issue-1", "issue-2"] });
    applyPpmRealtimeEventsToProfile(store, "acme", "user-1", subscribed, {
      ...emptyBatch(),
      issueUpdated: [
        { projectId: "project-2", issueIds: ["issue-1"] },
        { projectId: "project-not-subscribed", issueIds: ["issue-2"] },
      ],
    });
    expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledTimes(1);
    expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledWith("acme", "project-2", "issue-1");
  });

  it("re-reads 'Мои задачи' once even when several subscribed projects' lists changed", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToProfile(store, "acme", "user-1", subscribed, {
      ...emptyBatch(),
      issueListChanged: ["project-1", "project-2"],
    });
    expect(store.issue.profileIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledTimes(1);
    expect(store.issue.profileIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
      "acme",
      "user-1",
      "mutation"
    );
  });

  it("ignores list changes of a project the profile view is not subscribed to", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToProfile(store, "acme", "user-1", subscribed, {
      ...emptyBatch(),
      issueListChanged: ["project-not-subscribed"],
    });
    expect(store.issue.profileIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });

  describe("review round 1: the same per-project threshold applies across the aggregated list", () => {
    it("switches that one project's updates to a list refresh above the threshold, leaving other projects' fetchIssue alone", () => {
      const smallProjectIds = ["issue-small-1"];
      const bigProjectIds = idsRange(PPM_REALTIME_FETCH_ISSUE_BATCH_THRESHOLD + 1, "big");
      const store = fakeStore({ loadedIssueIds: [...smallProjectIds, ...bigProjectIds] });
      applyPpmRealtimeEventsToProfile(store, "acme", "user-1", subscribed, {
        ...emptyBatch(),
        issueUpdated: [
          { projectId: "project-1", issueIds: smallProjectIds },
          { projectId: "project-2", issueIds: bigProjectIds },
        ],
      });
      expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledTimes(1);
      expect(store.issue.issueDetail.issue.fetchIssue).toHaveBeenCalledWith("acme", "project-1", "issue-small-1");
      expect(store.issue.profileIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledTimes(1);
    });
  });
});

describe("applyPpmRealtimeResyncToProfile", () => {
  it("re-reads 'Мои задачи' when it has subscribed projects and was loaded before", () => {
    const store = fakeStore();
    applyPpmRealtimeResyncToProfile(store, "acme", "user-1", new Set(["project-1"]));
    expect(store.issue.profileIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
      "acme",
      "user-1",
      "mutation"
    );
  });

  it("does nothing with no subscribed projects", () => {
    const store = fakeStore();
    applyPpmRealtimeResyncToProfile(store, "acme", "user-1", new Set());
    expect(store.issue.profileIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });
});

// Review round 1 (spec gap, U7): a sprint's/module's own Kanban/list did not re-read itself when a colleague added,
// removed or moved an issue in the project, or changed the sprint/module directly. Ownership expanded to the cycle
// and module detail page roots (`cycles/(detail)/layout.tsx`, `modules/(detail)/layout.tsx`), which reuse the project
// layout's own subscription — these two functions are the point-refetch decision, conservative by design: any
// project-level issue list change is treated as possibly affecting this sprint/module (the event carries no cycle id
// for a plain create/delete, so it can't be narrowed further without guessing).
describe("applyPpmRealtimeEventsToCycleOrModule (review round 1, U7 spec gap; round 2 narrowed to exact id match)", () => {
  it("refetches the cycle's own issues on an exact {type, id} match", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToCycleOrModule(
      store,
      "acme",
      "project-1",
      { type: "cycle", id: "cycle-1" },
      {
        ...emptyBatch(),
        cycleModuleChanged: [{ type: "cycle", id: "cycle-1" }],
      }
    );
    expect(store.issue.cycleIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
      "acme",
      "project-1",
      "mutation",
      "cycle-1"
    );
    expect(store.issue.moduleIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });

  it("review round 2: a project-level issue list change alone no longer triggers a refresh", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToCycleOrModule(
      store,
      "acme",
      "project-1",
      { type: "cycle", id: "cycle-1" },
      {
        ...emptyBatch(),
        issueListChanged: ["project-1"],
      }
    );
    expect(store.issue.cycleIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });

  it("refetches the module's own issues when a matching module event arrives, even without an issue-list change", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToCycleOrModule(
      store,
      "acme",
      "project-1",
      { type: "module", id: "module-1" },
      {
        ...emptyBatch(),
        cycleModuleChanged: [{ type: "module", id: "module-1" }],
      }
    );
    expect(store.issue.moduleIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
      "acme",
      "project-1",
      "mutation",
      "module-1"
    );
  });

  it("ignores a cycle/module event for a different id, or the other entity type", () => {
    const store = fakeStore();
    applyPpmRealtimeEventsToCycleOrModule(
      store,
      "acme",
      "project-1",
      { type: "cycle", id: "cycle-1" },
      {
        ...emptyBatch(),
        cycleModuleChanged: [
          { type: "cycle", id: "cycle-other" },
          { type: "module", id: "cycle-1" }, // same id, wrong entity — must not match either
        ],
      }
    );
    expect(store.issue.cycleIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });

  it("does nothing when this sprint's board was never loaded this session, even on an exact match", () => {
    const store = fakeStore({ cyclePagination: undefined });
    applyPpmRealtimeEventsToCycleOrModule(
      store,
      "acme",
      "project-1",
      { type: "cycle", id: "cycle-1" },
      {
        ...emptyBatch(),
        cycleModuleChanged: [{ type: "cycle", id: "cycle-1" }],
      }
    );
    expect(store.issue.cycleIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });

  it("never throws when the substituted store call rejects", () => {
    const store = fakeStore();
    store.issue.cycleIssues.fetchIssuesWithExistingPagination.mockRejectedValue(new Error("network down"));
    expect(() =>
      applyPpmRealtimeEventsToCycleOrModule(
        store,
        "acme",
        "project-1",
        { type: "cycle", id: "cycle-1" },
        {
          ...emptyBatch(),
          cycleModuleChanged: [{ type: "cycle", id: "cycle-1" }],
        }
      )
    ).not.toThrow();
  });
});

describe("applyPpmRealtimeResyncToCycleOrModule (review round 1)", () => {
  it("re-reads the sprint's own board once, if it was ever loaded", () => {
    const store = fakeStore();
    applyPpmRealtimeResyncToCycleOrModule(store, "acme", "project-1", { type: "cycle", id: "cycle-1" });
    expect(store.issue.cycleIssues.fetchIssuesWithExistingPagination).toHaveBeenCalledWith(
      "acme",
      "project-1",
      "mutation",
      "cycle-1"
    );
  });

  it("does nothing for a module board that was never loaded this session", () => {
    const store = fakeStore({ modulePagination: undefined });
    applyPpmRealtimeResyncToCycleOrModule(store, "acme", "project-1", { type: "module", id: "module-1" });
    expect(store.issue.moduleIssues.fetchIssuesWithExistingPagination).not.toHaveBeenCalled();
  });
});
