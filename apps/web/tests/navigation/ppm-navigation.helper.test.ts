import { describe, expect, it } from "vitest";
import { shouldShowTopNavSidebarToggle as show } from "@/helpers/ppm-navigation.helper";

const base = { isPpmShell: true, sidebarCollapsed: true, workspaceSlug: "228" };

describe("shouldShowTopNavSidebarToggle", () => {
  it("offers the sidebar toggle on PPM pages without an app header", () => {
    for (const p of [
      "/228/notifications/",
      "/228/projects/x/overview/",
      "/228/projects/x/brain/",
      "/228/projects/x/knowledge/",
      "/228/projects/x/code/",
    ])
      expect(show({ ...base, pathname: p })).toBe(true);
    expect(show({ ...base, pathname: "/228/projects/x/issues/" })).toBe(false);
    expect(show({ ...base, sidebarCollapsed: false, pathname: "/228/projects/x/code/" })).toBe(false);
    expect(show({ ...base, isPpmShell: false, pathname: "/228/projects/x/code/" })).toBe(false);
  });
});
