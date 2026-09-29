// Line U-Web (UX2.1 U6, U8): one client per tab+workspace, and its status wired straight into line S's own poll
// interval (U8, revised in review round 2: slowed while online, not fully suspended — the channel is best-effort) —
// reusing the very same env object for both, so there is exactly one set of real timers/visibility listeners behind
// them, not two.
import { describe, expect, it, vi } from "vitest";
import {
  PPM_REALTIME_FALLBACK_POLL_MS,
  createPpmRealtimeRuntime,
  getPpmRealtimeRuntime,
} from "@/components/ppm-realtime/runtime";
import type { TPpmRealtimeStore } from "@/components/ppm-realtime/store-bridge";
import { LIVE_STATS_TIMINGS } from "@/components/ppm-live-stats/refresh-scheduler";
import { getLiveStatsRuntime } from "@/components/ppm-live-stats/runtime";
import { createFakePpmRealtimeEnv } from "./fake-env";

function fakeStore(): TPpmRealtimeStore {
  return {
    issue: {
      issues: { issuesMap: {}, getIssueById: () => undefined },
      issueDetail: { issue: { fetchIssue: vi.fn().mockResolvedValue(undefined) } },
      projectIssues: {
        paginationOptions: undefined,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
      profileIssues: {
        paginationOptions: undefined,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
      cycleIssues: {
        paginationOptions: undefined,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
      moduleIssues: {
        paginationOptions: undefined,
        fetchIssuesWithExistingPagination: vi.fn().mockResolvedValue(undefined),
      },
    },
    cycle: { cycleMap: {} },
    module: { moduleMap: {} },
    projectRoot: { project: { fetchProjectDetails: vi.fn().mockResolvedValue(undefined), joinedProjectIds: [] } },
  };
}

describe("createPpmRealtimeRuntime: U8 wiring to line S's poll interval (review round 2)", () => {
  it("slows line S's poll to the rare fallback while the channel is online, restores 30s once it degrades", async () => {
    const fake = createFakePpmRealtimeEnv();
    const store = fakeStore();
    const runtime = createPpmRealtimeRuntime(
      store,
      fake.env,
      () => "wss://api.ppm.test/ws/ppm/v1/workspaces/acme/events/"
    );

    const refresh = vi.fn(async () => undefined);
    // Line S's own runtime, sharing the very same fake env/clock as the realtime client.
    getLiveStatsRuntime(store, () => fake.env).watch(
      "cycle-stats:sprint-1",
      { type: "cycle", id: "sprint-1" },
      refresh
    );

    runtime.client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    socket.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });

    // online: the 30s cadence no longer fires...
    await fake.advance(LIVE_STATS_TIMINGS.pollMs * 2);
    expect(refresh).not.toHaveBeenCalled();
    // ...but the channel is best-effort (bulk/admin/API writes can skip publish), so a rare fallback still does.
    await fake.advance(PPM_REALTIME_FALLBACK_POLL_MS - LIVE_STATS_TIMINGS.pollMs * 2);
    expect(refresh).toHaveBeenCalledWith("poll");

    refresh.mockClear();
    socket.serverClose(1006); // degraded: line S's normal 30s poll is the fallback again
    await fake.advance(LIVE_STATS_TIMINGS.pollMs);
    expect(refresh).toHaveBeenCalledWith("poll");

    runtime.dispose();
  });
});

describe("getPpmRealtimeRuntime: one client per tab+workspace", () => {
  it("returns the same runtime for repeat calls with the same workspace", () => {
    const fake = createFakePpmRealtimeEnv();
    const store = fakeStore();
    const first = getPpmRealtimeRuntime(
      store,
      "acme",
      () => fake.env,
      (slug) => `wss://api.ppm.test/ws/.../${slug}/events/`
    );
    const second = getPpmRealtimeRuntime(
      store,
      "acme",
      () => fake.env,
      (slug) => `wss://api.ppm.test/ws/.../${slug}/events/`
    );
    expect(second).toBe(first);
  });

  it("tears the old socket down and opens a fresh one when the workspace changes", () => {
    const fake = createFakePpmRealtimeEnv();
    const store = fakeStore();
    const runtimeA = getPpmRealtimeRuntime(
      store,
      "acme",
      () => fake.env,
      (slug) => `wss://api.ppm.test/${slug}/events/`
    );
    runtimeA.client.subscribeProject("project-1");
    const socketA = fake.lastSocket()!;
    socketA.open();
    expect(socketA.readyState).toBe(1);

    const runtimeB = getPpmRealtimeRuntime(
      store,
      "other-workspace",
      () => fake.env,
      (slug) => `wss://api.ppm.test/${slug}/events/`
    );
    expect(runtimeB).not.toBe(runtimeA);
    expect(socketA.readyState).toBe(3); // closed by the dispose that switching workspaces triggers

    runtimeB.client.subscribeProject("project-1");
    expect(fake.lastSocket()!.url).toBe("wss://api.ppm.test/other-workspace/events/");
  });
});
