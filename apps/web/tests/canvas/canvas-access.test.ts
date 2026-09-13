import { EUserPermissions } from "@plane/constants";
import { describe, expect, it } from "vitest";
import { resolvePpmCanvasAccess } from "@/components/ppm-canvas/access";

describe("PPM Canvas access boundary", () => {
  it.each([EUserPermissions.ADMIN, EUserPermissions.MEMBER])("allows role %s to edit", (role) => {
    expect(resolvePpmCanvasAccess(role)).toBe("edit");
  });

  it("keeps guests in read-only mode", () => {
    expect(resolvePpmCanvasAccess(EUserPermissions.GUEST)).toBe("read");
  });

  it("denies missing or unknown membership", () => {
    expect(resolvePpmCanvasAccess(undefined)).toBe("deny");
    expect(resolvePpmCanvasAccess(0 as EUserPermissions)).toBe("deny");
  });
});
