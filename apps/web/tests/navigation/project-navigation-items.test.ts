import { EUserPermissions } from "@plane/constants";
import type { IPartialProject } from "@plane/types";
import { describe, expect, it } from "vitest";
import {
  buildProjectNavigationItems,
  type TProjectNavigationItem,
} from "@/components/navigation/project-navigation-items";

const ENABLED_PROJECT_FEATURES = {
  id: "project-1",
  cycle_view: true,
  inbox_view: true,
  issue_views_view: true,
  module_view: true,
  page_view: true,
} as IPartialProject;

const DISABLED_PROJECT_FEATURES = {
  ...ENABLED_PROJECT_FEATURES,
  cycle_view: false,
  inbox_view: false,
  issue_views_view: false,
  module_view: false,
  page_view: false,
} as IPartialProject;

function visibleKeys({
  isPpmCanvasEnabled = true,
  isPpmShellEnabled,
  project = ENABLED_PROJECT_FEATURES,
  role,
}: {
  isPpmCanvasEnabled?: boolean;
  isPpmShellEnabled: boolean;
  project?: IPartialProject;
  role: EUserPermissions;
}): string[] {
  return buildProjectNavigationItems({
    isPpmCanvasEnabled,
    isPpmShellEnabled,
    project,
    projectId: project.id,
    workspaceSlug: "demo",
  })
    .filter((item) => item.shouldRender && canRoleOpenItem(item, role))
    .map(({ key }) => key);
}

function canRoleOpenItem(item: TProjectNavigationItem, role: EUserPermissions): boolean {
  return (item.access as EUserPermissions[]).includes(role);
}

describe("PPM project navigation capabilities", () => {
  it("keeps read-oriented sections visible for a guest/viewer", () => {
    expect(visibleKeys({ isPpmShellEnabled: true, role: EUserPermissions.GUEST })).toEqual([
      "overview",
      "brain",
      "work_items",
      "views",
      "intake",
      "knowledge",
      "pages",
      "code",
    ]);
  });

  it("keeps a participant out of project settings", () => {
    expect(visibleKeys({ isPpmShellEnabled: true, role: EUserPermissions.MEMBER })).toEqual([
      "overview",
      "brain",
      "work_items",
      "views",
      "cycles",
      "modules",
      "intake",
      "knowledge",
      "pages",
      "code",
    ]);
  });

  it("lets the project lead configure their project", () => {
    expect(visibleKeys({ isPpmShellEnabled: true, role: EUserPermissions.ADMIN })).toEqual([
      "overview",
      "brain",
      "work_items",
      "views",
      "cycles",
      "modules",
      "intake",
      "knowledge",
      "pages",
      "code",
      "settings",
    ]);
  });

  it("honors project feature switches for every role", () => {
    expect(
      visibleKeys({
        isPpmShellEnabled: true,
        project: DISABLED_PROJECT_FEATURES,
        role: EUserPermissions.GUEST,
      })
    ).toEqual(["overview", "brain", "work_items", "knowledge", "code"]);
    expect(
      visibleKeys({
        isPpmShellEnabled: true,
        project: DISABLED_PROJECT_FEATURES,
        role: EUserPermissions.ADMIN,
      })
    ).toEqual(["overview", "brain", "work_items", "knowledge", "code", "settings"]);
  });

  it("hides the Canvas route when its rollback flag is disabled", () => {
    expect(
      visibleKeys({ isPpmCanvasEnabled: false, isPpmShellEnabled: true, role: EUserPermissions.ADMIN })
    ).not.toContain("brain");
  });

  it("preserves the upstream role boundary when the PPM shell is rolled back", () => {
    expect(visibleKeys({ isPpmShellEnabled: false, role: EUserPermissions.GUEST })).toEqual([
      "work_items",
      "views",
      "pages",
      "intake",
    ]);
    expect(visibleKeys({ isPpmShellEnabled: false, role: EUserPermissions.MEMBER })).toEqual([
      "work_items",
      "cycles",
      "modules",
      "views",
      "pages",
      "intake",
    ]);
  });
});
