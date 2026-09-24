import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../core/components/ppm-canvas/canvas.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("canvas.css", () => {
  it("defines the spinner keyframes used by loading states", () => {
    expect(css).toContain("@keyframes ppm-canvas-spin");
    expect(css).toMatch(/@keyframes ppm-canvas-spin\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\);?\s*\}/);
  });

  it("paints the canvas shell with a valid background", () => {
    expect(css).not.toContain("--color-accent-primary-rgb");
    expect(ruleBody(".ppm-canvas-shell")).toMatch(/background:\s*var\(--bg-surface-1\);/);
  });

  it("uses the PPM brand fonts instead of hard-coded families", () => {
    expect(css).not.toMatch(/font-family:\s*Inter/);
    expect(css).not.toContain('"SFMono-Regular", Consolas, monospace');
    expect(ruleBody(".ppm-canvas-shell .tl-container")).toContain(
      "font-family: var(--ppm-font-sans, var(--font-body, ui-sans-serif, system-ui, sans-serif));"
    );
    for (const selector of [".ppm-canvas-diagram > textarea", ".ppm-canvas-code__body"]) {
      expect(ruleBody(selector)).toContain(
        "font-family: var(--ppm-font-mono, var(--font-code, ui-monospace, monospace));"
      );
    }
  });

  it("draws tldraw selection and primary colour from the PPM accent", () => {
    const tldraw = ruleBody(".ppm-canvas-shell .tl-container");
    for (const variable of ["--color-primary", "--color-selected", "--color-selection-stroke"]) {
      expect(tldraw).toContain(`${variable}: var(--border-accent-strong);`);
    }
    expect(tldraw).toContain(
      "--color-selection-fill: color-mix(in srgb, var(--border-accent-strong) 16%, transparent);"
    );
  });

  it("keeps canvas layers in their own stacking context below Plane modals", () => {
    expect(css).toMatch(/\.ppm-canvas-workspace\s*\{[^}]*isolation:\s*isolate/);
  });

  it("has no styles left for the removed bottom toolbar", () => {
    expect(css).not.toContain(".ppm-canvas-topbar");
    expect(css).not.toContain(".ppm-canvas-toolbar-button");
  });
});
