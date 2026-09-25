// UX1.1 F1: PPM_DESIGN_V2 is wired like the other PPM flags, and root.tsx applies it before first paint.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const root = read("../../app/root.tsx");

describe("PPM_DESIGN_V2 wiring (UX1.1)", () => {
  it("vite exposes PPM_DESIGN_V2 with the default 1 (R1)", () => {
    expect(read("../../vite.config.ts")).toContain('viteEnv.PPM_DESIGN_V2 = process.env.PPM_DESIGN_V2 ?? "1";');
  });

  it("turbo forwards PPM_DESIGN_V2 to builds and cache keys", () => {
    expect(JSON.parse(read("../../../../turbo.json")).globalEnv).toContain("PPM_DESIGN_V2");
  });

  it(".env.example documents the flag", () => {
    expect(read("../../.env.example")).toMatch(/^PPM_DESIGN_V2="1"$/m);
  });

  it("root.tsx renders both attributes and the brand-gated pre-paint script", () => {
    expect(root).toContain("data-ppm-design={PPM_DESIGN_DEFAULT}");
    expect(root).toContain('data-ppm-density="comfortable"');
    expect(root).toMatch(
      /getPpmAppearanceBootstrapScript\(\s*process\.env\.PPM_DESIGN_V2,\s*process\.env\.PPM_BRAND_ENABLED\s*\)/
    );
    expect(root).toContain(
      "{IS_PPM_BRAND_ENABLED && <script dangerouslySetInnerHTML={{ __html: PPM_APPEARANCE_BOOTSTRAP }} />}"
    );
  });

  it("defaults to the system theme under v2 and to the wave-0 dark theme under v1 — per browser (R2)", () => {
    // Read on the client from <html data-ppm-design> (set before paint), so a personal ppm_design rollback also
    // restores the wave-0 default; the prerender falls back to the build flags (usePpmDesignV2).
    expect(root).toContain("const isDesignV2 = usePpmDesignV2();");
    expect(root).toContain('defaultTheme={IS_PPM_BRAND_ENABLED && !isDesignV2 ? "dark" : "system"}');
    expect(root).not.toContain('PPM_DESIGN_DEFAULT === "v1" ? "dark"');
  });

  it("paints the browser chrome from the v2 canvas tokens under v2 (R20)", () => {
    const flat = root.replace(/\s+/g, " ");
    expect(flat).toContain('media="(prefers-color-scheme: light)" content={PPM_THEME_COLOR_V2.light}');
    expect(flat).toContain('media="(prefers-color-scheme: dark)" content={PPM_THEME_COLOR_V2.dark}');
    expect(flat).toContain('content={IS_PPM_BRAND_ENABLED ? PPM_BRAND.themeColor : "#fff"}');
  });

  it("lets the pre-paint script re-colour the prerendered theme-color tags without a hydration warning", () => {
    // The script runs after the tags it adjusts (attributes only — the element count never changes).
    const tags = [...root.matchAll(/<meta\s+name="theme-color"[^>]*\/>/g)];
    expect(tags).toHaveLength(3);
    for (const [tag] of tags) expect(tag).toContain("suppressHydrationWarning");
    const script = root.indexOf("<script dangerouslySetInnerHTML={{ __html: PPM_APPEARANCE_BOOTSTRAP }} />");
    expect(script).toBeGreaterThan(Math.max(...tags.map((match) => match.index ?? -1)));
  });
});
