// UX1.1 F1: PPM_DESIGN_V2 (0 | preview | 1) + per-browser override, density, and the pre-paint script.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getPpmAppearanceBootstrapScript,
  PPM_BRAND,
  PPM_DENSITY_STORAGE_KEY,
  PPM_DESIGN_STORAGE_KEY,
  PPM_THEME_COLOR_V2,
  resolvePpmDensity,
  resolvePpmDesign,
} from "../index";

const OFF = ["0", "false", "FALSE", "off", "no", "disabled", " 0 "];
const ON = [undefined, "", "1", "true", "yes", " 1 "];
const PREVIEW = ["preview", "PREVIEW", " preview "];
const BRANDS = [undefined, "1", "0"];
const STORED = [null, "v1", "v2", "garbage"];

type TMeta = { attributes: Record<string, string>; setAttribute: (name: string, value: string) => void };
const meta = (attributes: Record<string, string>): TMeta => {
  const own = { ...attributes };
  return { attributes: own, setAttribute: (name, value) => void (own[name] = value) };
};
// What root.tsx prerenders into <head> for the build default (wave 0: one tag; v2: one tag per colour scheme).
const V1_HEAD = () => [meta({ name: "theme-color", content: PPM_BRAND.themeColor })];
const V2_HEAD = () => [
  meta({ name: "theme-color", media: "(prefers-color-scheme: light)", content: PPM_THEME_COLOR_V2.light }),
  meta({ name: "theme-color", media: "(prefers-color-scheme: dark)", content: PPM_THEME_COLOR_V2.dark }),
];

/** Runs the pre-paint script against a fake <html>/<head>, matchMedia and MutationObserver. */
function runPage(
  script: string,
  storage: Record<string, string> | "blocked",
  env: { dark?: boolean; metas?: TMeta[] } = {}
) {
  const attributes: Record<string, string> = {};
  const style: Record<string, string> = {};
  const metas = env.metas ?? [];
  const observers: Array<{ active: boolean; pending: boolean; filter: string[]; callback: () => void }> = [];
  const root = {
    style,
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
      for (const observer of observers) if (observer.active && observer.filter.includes(name)) observer.pending = true;
    },
  };
  class FakeMutationObserver {
    private readonly entry: (typeof observers)[number];
    constructor(callback: () => void) {
      this.entry = { active: false, pending: false, filter: [], callback };
      observers.push(this.entry);
    }
    observe(target: unknown, init: { attributes?: boolean; attributeFilter?: string[] }) {
      expect(target).toBe(root);
      expect(init.attributes).toBe(true);
      this.entry.active = true;
      this.entry.filter = init.attributeFilter ?? [];
    }
    disconnect() {
      this.entry.active = false;
    }
  }
  const localStorage = {
    getItem: (key: string) => {
      if (storage === "blocked") throw new Error("SecurityError");
      return storage[key] ?? null;
    },
  };
  const document = {
    documentElement: root,
    querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? metas : []),
  };
  const matchMedia = (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" && !!env.dark });
  new Function("localStorage", "document", "matchMedia", "MutationObserver", script)(
    localStorage,
    document,
    matchMedia,
    FakeMutationObserver
  );
  return {
    attributes,
    style,
    metas,
    observing: () => observers.some((observer) => observer.active),
    /** next-themes' own inline script (in <body>, after ours) applies its prerendered default; observers then run
     *  at the microtask checkpoint that follows that script, i.e. still before first paint. */
    nextThemesApplies: (theme: string) => {
      root.setAttribute("data-theme", theme);
      style.colorScheme = theme;
      for (const observer of observers)
        if (observer.active && observer.pending) {
          observer.pending = false;
          observer.callback();
        }
    },
  };
}
const runScript = (script: string, storage: Record<string, string> | "blocked") => runPage(script, storage).attributes;

describe("PPM design flag (UX1.1)", () => {
  it("is always wave 0 when the brand is off", () => {
    for (const flag of [...OFF, ...ON, ...PREVIEW])
      for (const stored of STORED) expect(resolvePpmDesign(flag, "0", stored), `${flag}/${stored}`).toBe("v1");
  });

  it("PPM_DESIGN_V2=0 and its aliases ignore the per-browser choice", () => {
    for (const flag of OFF) for (const stored of STORED) expect(resolvePpmDesign(flag, "1", stored)).toBe("v1");
  });

  it("preview is wave 0 unless this browser opted in with ppm_design=v2", () => {
    for (const flag of PREVIEW) {
      expect(resolvePpmDesign(flag, undefined, "v2")).toBe("v2");
      for (const stored of [null, "v1", "garbage"]) expect(resolvePpmDesign(flag, undefined, stored)).toBe("v1");
    }
  });

  it("1 or unset is v2 unless this browser opted out with ppm_design=v1", () => {
    for (const flag of ON) {
      expect(resolvePpmDesign(flag, undefined, "v1"), String(flag)).toBe("v1");
      for (const stored of [null, "v2", "garbage"]) expect(resolvePpmDesign(flag, undefined, stored)).toBe("v2");
    }
  });

  it("the pre-paint script applies exactly the resolvePpmDesign table", () => {
    for (const flag of [...OFF, ...ON, ...PREVIEW])
      for (const brand of BRANDS)
        for (const stored of STORED) {
          const storage = stored === null ? {} : { [PPM_DESIGN_STORAGE_KEY]: stored };
          const attributes = runScript(getPpmAppearanceBootstrapScript(flag, brand), storage);
          expect(attributes["data-ppm-design"], `${flag}/${brand}/${stored}`).toBe(
            resolvePpmDesign(flag, brand, stored)
          );
        }
  });

  it("the pre-paint script falls back to the build default when storage is blocked", () => {
    expect(runScript(getPpmAppearanceBootstrapScript("1", "1"), "blocked")).toEqual({
      "data-ppm-design": "v2",
      "data-ppm-density": "comfortable",
    });
    expect(runScript(getPpmAppearanceBootstrapScript("preview", "1"), "blocked")["data-ppm-design"]).toBe("v1");
  });

  it("density is compact only on the exact stored value", () => {
    expect(resolvePpmDensity("compact")).toBe("compact");
    for (const stored of [null, "", "COMPACT", "comfortable", "dense"])
      expect(resolvePpmDensity(stored)).toBe("comfortable");
  });

  it("the pre-paint script reads density from this browser only", () => {
    const script = getPpmAppearanceBootstrapScript("1", "1");
    expect(runScript(script, { [PPM_DENSITY_STORAGE_KEY]: "compact" })["data-ppm-density"]).toBe("compact");
    expect(runScript(script, { [PPM_DENSITY_STORAGE_KEY]: "dense" })["data-ppm-density"]).toBe("comfortable");
    expect(runScript(script, {})["data-ppm-density"]).toBe("comfortable");
  });

  it("leaves the prerendered head and theme alone when this browser agrees with the build (wave 0 byte-identical)", () => {
    for (const flag of [...OFF, ...ON, ...PREVIEW])
      for (const stored of STORED) {
        const build = resolvePpmDesign(flag, "1", null);
        if (resolvePpmDesign(flag, "1", stored) !== build) continue;
        const head = build === "v2" ? V2_HEAD : V1_HEAD;
        const storage = stored === null ? {} : { [PPM_DESIGN_STORAGE_KEY]: stored };
        const page = runPage(getPpmAppearanceBootstrapScript(flag, "1"), storage, { metas: head() });
        expect(
          page.metas.map((tag) => tag.attributes),
          `${flag}/${stored}`
        ).toEqual(head().map((tag) => tag.attributes));
        expect(page.observing(), `${flag}/${stored}`).toBe(false);
        page.nextThemesApplies("light");
        expect(page.attributes["data-theme"]).toBe("light");
      }
  });

  it("a personal v1 under a v2 build paints the browser chrome with the wave-0 colour (both tags)", () => {
    const page = runPage(
      getPpmAppearanceBootstrapScript("1", "1"),
      { [PPM_DESIGN_STORAGE_KEY]: "v1" },
      { metas: V2_HEAD() }
    );
    expect(page.metas.map((tag) => tag.attributes)).toEqual([
      { name: "theme-color", media: "(prefers-color-scheme: light)", content: PPM_BRAND.themeColor },
      { name: "theme-color", media: "(prefers-color-scheme: dark)", content: PPM_BRAND.themeColor },
    ]);
  });

  it("a personal v2 under preview paints the single wave-0 tag with the v2 colour of the current scheme", () => {
    for (const dark of [false, true]) {
      const page = runPage(
        getPpmAppearanceBootstrapScript("preview", "1"),
        { [PPM_DESIGN_STORAGE_KEY]: "v2" },
        { dark, metas: V1_HEAD() }
      );
      expect(page.metas.map((tag) => tag.attributes)).toEqual([
        { name: "theme-color", content: dark ? PPM_THEME_COLOR_V2.dark : PPM_THEME_COLOR_V2.light },
      ]);
    }
  });

  it("without a stored theme, corrects next-themes' prerendered default to this browser's design before paint", () => {
    // v2 build ("system") + personal v1 → wave-0 dark default.
    const rollback = runPage(getPpmAppearanceBootstrapScript("1", "1"), { [PPM_DESIGN_STORAGE_KEY]: "v1" }, {});
    expect(rollback.observing()).toBe(true);
    rollback.nextThemesApplies("light");
    expect(rollback.attributes["data-theme"]).toBe("dark");
    expect(rollback.style.colorScheme).toBe("dark");
    expect(rollback.observing()).toBe(false);
    // preview build ("dark") + personal v2 → follows the system scheme.
    for (const dark of [false, true]) {
      const optIn = runPage(
        getPpmAppearanceBootstrapScript("preview", "1"),
        { [PPM_DESIGN_STORAGE_KEY]: "v2" },
        { dark }
      );
      optIn.nextThemesApplies("dark");
      expect(optIn.attributes["data-theme"]).toBe(dark ? "dark" : "light");
      expect(optIn.style.colorScheme).toBe(dark ? "dark" : "light");
      expect(optIn.observing()).toBe(false);
    }
  });

  it("a theme stored by next-themes (the user's choice) always wins", () => {
    const page = runPage(getPpmAppearanceBootstrapScript("1", "1"), { [PPM_DESIGN_STORAGE_KEY]: "v1", theme: "light" });
    expect(page.observing()).toBe(false);
    page.nextThemesApplies("light");
    expect(page.attributes["data-theme"]).toBe("light");
  });

  it("publishes the storage keys shared with the web helper", () => {
    expect(PPM_DESIGN_STORAGE_KEY).toBe("ppm_design");
    expect(PPM_DENSITY_STORAGE_KEY).toBe("ppm_density");
  });

  it("exports the v2 token stylesheet, also after a tsdown rebuild rewrites package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./tokens-v2.css"]).toBe("./src/tokens-v2.css");
    expect(readFileSync(new URL("../../tsdown.config.ts", import.meta.url), "utf8")).toContain(
      '"./tokens-v2.css": "./src/tokens-v2.css",'
    );
  });
});
