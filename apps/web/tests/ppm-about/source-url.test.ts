// RC review I7: the «Исходный код» link on /about/open-source must open the exact revision the images were built
// from. Builds come from a commit of the Plane fork (plane-fork), not of the PPM root repository.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLANE_SOURCE_ATTRIBUTION, PPM_SOURCE_ATTRIBUTION } from "@ppm/brand";
import { getPpmSourceCodeUrl } from "@/helpers/ppm-source-url.helper";

const REVISION = "2c9fa788a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("getPpmSourceCodeUrl", () => {
  it("links an exact revision to that commit in the Plane fork repository", () => {
    expect(PLANE_SOURCE_ATTRIBUTION.forkRepository).toBe("https://github.com/Imil1914/plane");
    expect(getPpmSourceCodeUrl(REVISION)).toBe(`https://github.com/Imil1914/plane/tree/${REVISION}`);
    expect(getPpmSourceCodeUrl(REVISION)).not.toContain(PPM_SOURCE_ATTRIBUTION.repository);
  });

  it("normalises the revision and the repository URL", () => {
    expect(getPpmSourceCodeUrl(` ${REVISION.toUpperCase()} `, "https://git.example.org/ppm/plane/")).toBe(
      `https://git.example.org/ppm/plane/tree/${REVISION}`
    );
  });

  it("falls back to the repository when the build has no exact revision", () => {
    for (const revision of [undefined, "", "локальная сборка", "2c9fa788", `${REVISION}0`]) {
      expect(getPpmSourceCodeUrl(revision)).toBe("https://github.com/Imil1914/plane");
    }
  });

  it("is what the open-source page renders", () => {
    const page = readFileSync(new URL("../../app/(home)/about/open-source/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("getPpmSourceCodeUrl(");
    expect(page).not.toMatch(/PPM_SOURCE_ATTRIBUTION\.repository\}\/tree/);
  });
});
