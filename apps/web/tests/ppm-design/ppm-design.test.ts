// UX1.1 F1: web helper for the design switch and the device-local density.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPpmDensity, isPpmDesignV2, PPM_DENSITY_CHANGE_EVENT, setPpmDensity } from "@/lib/ppm-design";

function stubDom(dataset: Record<string, string>, storage: { setItem: (key: string, value: string) => void }) {
  const events = new EventTarget();
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("window", events);
  vi.stubGlobal("localStorage", storage);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ppm-design helper (UX1.1)", () => {
  it("reads the look from <html data-ppm-design>, whatever the build flag says", () => {
    vi.stubEnv("PPM_DESIGN_V2", "0");
    stubDom({ ppmDesign: "v2" }, { setItem: () => {} });
    expect(isPpmDesignV2()).toBe(true);
    stubDom({ ppmDesign: "v1" }, { setItem: () => {} });
    vi.stubEnv("PPM_DESIGN_V2", "1");
    expect(isPpmDesignV2()).toBe(false);
  });

  it("falls back to the build flags without a document (prerender, unit tests)", () => {
    vi.stubGlobal("document", undefined);
    vi.stubEnv("PPM_BRAND_ENABLED", "1");
    vi.stubEnv("PPM_DESIGN_V2", "1");
    expect(isPpmDesignV2()).toBe(true);
    vi.stubEnv("PPM_DESIGN_V2", "preview");
    expect(isPpmDesignV2()).toBe(false);
    vi.stubEnv("PPM_DESIGN_V2", "1");
    vi.stubEnv("PPM_BRAND_ENABLED", "0");
    expect(isPpmDesignV2()).toBe(false);
  });

  it("density defaults to «Удобная» and follows <html data-ppm-density>", () => {
    stubDom({}, { setItem: () => {} });
    expect(getPpmDensity()).toBe("comfortable");
    stubDom({ ppmDensity: "compact" }, { setItem: () => {} });
    expect(getPpmDensity()).toBe("compact");
  });

  it("setPpmDensity switches the attribute, remembers the choice in this browser and notifies", () => {
    const dataset: Record<string, string> = { ppmDensity: "comfortable" };
    const setItem = vi.fn();
    const events = stubDom(dataset, { setItem });
    const listener = vi.fn();
    events.addEventListener(PPM_DENSITY_CHANGE_EVENT, listener);
    setPpmDensity("compact");
    expect(dataset.ppmDensity).toBe("compact");
    expect(setItem).toHaveBeenCalledWith("ppm_density", "compact");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPpmDensity()).toBe("compact");
  });

  it("setPpmDensity still applies when storage is blocked", () => {
    const dataset: Record<string, string> = {};
    stubDom(dataset, {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => setPpmDensity("compact")).not.toThrow();
    expect(dataset.ppmDensity).toBe("compact");
  });

  it("never writes density to the server (R3)", () => {
    const source = readFileSync(new URL("../../core/lib/ppm-design.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@\/hooks\/store|@\/services|updateUserTheme|updateUserProfile|fetch\(/);
  });
});
