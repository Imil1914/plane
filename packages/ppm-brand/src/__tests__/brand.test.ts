import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPpmBrandEnabled, PLANE_SOURCE_ATTRIBUTION, PPM_BRAND } from "../index";

const tokenSource = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

describe("PPM brand feature flag", () => {
  it("enables PPM branding by default", () => {
    expect(isPpmBrandEnabled(undefined)).toBe(true);
    expect(isPpmBrandEnabled("")).toBe(true);
    expect(isPpmBrandEnabled("1")).toBe(true);
  });

  it.each(["0", "false", "FALSE", "off", "no", "disabled"])("treats %s as disabled", (value) => {
    expect(isPpmBrandEnabled(value)).toBe(false);
  });
});

describe("PPM token bridge", () => {
  it("keeps cyan as the single primary accent", () => {
    expect(PPM_BRAND.accentColor).toBe("#22D3EE");
    expect(tokenSource).toContain("--ppm-color-accent: #22d3ee");
    expect(tokenSource).toContain("--bg-accent-primary: var(--ppm-color-accent)");
  });

  it("is gated and provides Graphite and Light semantic surfaces", () => {
    expect(tokenSource).toContain('[data-ppm-brand="enabled"]');
    expect(tokenSource).toContain("--ppm-color-canvas: #0e0f12");
    expect(tokenSource).toContain("--ppm-color-canvas: #eef0f3");
    expect(tokenSource).toContain("--border-accent-strong: var(--ppm-color-focus)");
  });

  it("keeps representative text and focus combinations above WCAG AA", () => {
    expect(contrastRatio("#1A1D23", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#E7EAF0", "#15171C")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#062B32", "#22D3EE")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#0891B2", "#FFFFFF")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#67E8F9", "#0E0F12")).toBeGreaterThanOrEqual(3);
  });
});

describe("Plane source attribution", () => {
  it("points to the pinned, licensed baseline", () => {
    expect(PLANE_SOURCE_ATTRIBUTION.releaseTag).toBe("v1.4.2");
    expect(PLANE_SOURCE_ATTRIBUTION.baselineCommit).toHaveLength(40);
    expect(PLANE_SOURCE_ATTRIBUTION.license).toBe("AGPL-3.0-only");
  });
});

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((value) => Number.parseInt(value, 16) / 255);

  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);

  const [red, green, blue] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
