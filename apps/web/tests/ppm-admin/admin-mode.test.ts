import { describe, expect, it } from "vitest";
import { getPpmAdminModeNavigationHref, isPpmAdminMode } from "@/helpers/ppm-admin-mode.helper";

describe("PPM protected administrator mode", () => {
  it("is shown only for the protected global administrator with an explicit marker", () => {
    expect(isPpmAdminMode(true, "1")).toBe(true);
    expect(isPpmAdminMode(true, null)).toBe(false);
    expect(isPpmAdminMode(false, "1")).toBe(false);
    expect(isPpmAdminMode(false, "true")).toBe(false);
  });

  it("keeps the explicit administrator marker during project navigation only for that role", () => {
    const canvasHref = "/example/projects/project-id/brain/";
    expect(getPpmAdminModeNavigationHref(canvasHref, true, "1")).toBe(`${canvasHref}?ppm_admin_mode=1`);
    expect(getPpmAdminModeNavigationHref(`${canvasHref}?tab=main`, true, "1")).toBe(
      `${canvasHref}?tab=main&ppm_admin_mode=1`
    );
    expect(getPpmAdminModeNavigationHref(canvasHref, false, "1")).toBe(canvasHref);
    expect(getPpmAdminModeNavigationHref(canvasHref, true, null)).toBe(canvasHref);
  });
});
