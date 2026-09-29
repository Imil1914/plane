// Line U-Web (UX2.1 U6, U9 web): the two screens that subscribe to the events socket, and the flag that gates the
// whole client — checked in the source, the same way tests/ppm-git/route-wiring.test.ts and
// tests/ppm-design/flag-wiring.test.ts check theirs (these files are React Router route modules; rendering them needs
// the app's full provider tree, which is out of scope for this plain-node suite).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("PPM_REALTIME_EVENTS_ENABLED wiring (U5 web mirror)", () => {
  it("vite exposes the flag with the default 1", () => {
    expect(read("../../vite.config.ts")).toContain(
      'viteEnv.PPM_REALTIME_EVENTS_ENABLED = process.env.PPM_REALTIME_EVENTS_ENABLED ?? "1";'
    );
  });

  it("turbo forwards it to builds and cache keys", () => {
    expect(JSON.parse(read("../../../../turbo.json")).globalEnv).toContain("PPM_REALTIME_EVENTS_ENABLED");
  });

  it(".env.example documents it", () => {
    expect(read("../../.env.example")).toMatch(/^PPM_REALTIME_EVENTS_ENABLED="1"$/m);
  });
});

describe("project layout subscribes the open project (U6)", () => {
  const source = read("../../app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/layout.tsx");

  it("imports the hook", () => {
    expect(source).toContain('import { usePpmRealtimeProjectSync } from "@/components/ppm-realtime/use-ppm-realtime";');
  });

  it("calls it with the route's own workspaceSlug/projectId, before the render", () => {
    expect(source).toContain("usePpmRealtimeProjectSync(workspaceSlug, projectId);");
    const hookCall = source.indexOf("usePpmRealtimeProjectSync(workspaceSlug, projectId);");
    const returnStatement = source.indexOf("return (");
    expect(hookCall).toBeGreaterThan(-1);
    expect(hookCall).toBeLessThan(returnStatement);
  });
});

describe("'Мои задачи' (profile layout) subscribes the user's own projects (U6)", () => {
  const source = read("../../app/(all)/[workspaceSlug]/(projects)/profile/[userId]/layout.tsx");

  it("imports the hook", () => {
    expect(source).toContain('import { usePpmRealtimeProfileSync } from "@/components/ppm-realtime/use-ppm-realtime";');
  });

  it("calls it with the route's own workspaceSlug/userId", () => {
    expect(source).toContain("usePpmRealtimeProfileSync(workspaceSlug, userId);");
  });
});

// Review round 1 (spec gap, U7): the cycle/module detail page roots reuse the project layout's own subscription —
// they call a different hook (no `subscribeProject` of their own), which the source check below confirms too.
describe("sprint detail page reuses the project's subscription for its own issue list (U7, review round 1)", () => {
  const source = read(
    "../../app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/cycles/(detail)/layout.tsx"
  );

  it("imports the hook and reads cycleId from the route", () => {
    expect(source).toContain(
      'import { usePpmRealtimeCycleOrModuleIssuesSync } from "@/components/ppm-realtime/use-ppm-realtime";'
    );
    expect(source).toContain("const { workspaceSlug, projectId, cycleId } = useParams();");
  });

  it("calls it with entity type 'cycle' and the route's own ids", () => {
    expect(source).toContain('usePpmRealtimeCycleOrModuleIssuesSync(workspaceSlug, projectId, "cycle", cycleId);');
  });
});

describe("module (направление) detail page reuses the project's subscription for its own issue list (U7, review round 1)", () => {
  const source = read(
    "../../app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/modules/(detail)/layout.tsx"
  );

  it("imports the hook and reads moduleId from the route", () => {
    expect(source).toContain(
      'import { usePpmRealtimeCycleOrModuleIssuesSync } from "@/components/ppm-realtime/use-ppm-realtime";'
    );
    expect(source).toContain("const { workspaceSlug, projectId, moduleId } = useParams();");
  });

  it("calls it with entity type 'module' and the route's own ids", () => {
    expect(source).toContain('usePpmRealtimeCycleOrModuleIssuesSync(workspaceSlug, projectId, "module", moduleId);');
  });
});

describe("every realtime hook no-ops before anything else when the flag is off (U5/U6)", () => {
  const source = read("../../core/components/ppm-realtime/use-ppm-realtime.ts");

  it("realtimeReady() reads the flag and gates the very first line of every effect", () => {
    expect(source).toContain("isPpmRealtimeEventsEnabled(process.env.PPM_REALTIME_EVENTS_ENABLED)");
    const guards = [...source.matchAll(/useEffect\(\(\) => \{\s*if \([^)]*!realtimeReady\(\)\) return undefined;/g)];
    // usePpmRealtimeProjectSync, usePpmRealtimeProfileSync, usePpmRealtimeCycleOrModuleIssuesSync
    expect(guards).toHaveLength(3);
  });

  it("the profile sync keeps its subscriptions reactive to joinedProjectIds via a MobX reaction (review round 1, low)", () => {
    expect(source).toContain('import { reaction } from "mobx";');
    expect(source).toContain("reaction(() => store.projectRoot.project.joinedProjectIds, applyJoinedProjectIds)");
  });
});
