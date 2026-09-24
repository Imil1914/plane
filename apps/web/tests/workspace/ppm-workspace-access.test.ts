import { describe, expect, it } from "vitest";
import { canAccessPpmWorkspaceAdministration } from "@/helpers/ppm-workspace-access.helper";

describe("PPM workspace administration boundary", () => {
  it("allows the non-delegable global administrator", () => {
    expect(
      canAccessPpmWorkspaceAdministration({
        isGlobalAdmin: true,
        isPpmShell: true,
      })
    ).toBe(true);
  });

  it.each(["participant", "project lead", "workspace owner"])(
    "hides organization administration from a %s without the protected role",
    () => {
      expect(
        canAccessPpmWorkspaceAdministration({
          isGlobalAdmin: false,
          isPpmShell: true,
        })
      ).toBe(false);
    }
  );

  it("preserves the upstream workspace behavior when the PPM shell is disabled", () => {
    expect(
      canAccessPpmWorkspaceAdministration({
        isGlobalAdmin: false,
        isPpmShell: false,
      })
    ).toBe(true);
  });
});
