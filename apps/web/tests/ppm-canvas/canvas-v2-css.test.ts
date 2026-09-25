import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const V2 = ':where(html[data-ppm-design="v2"])';
const G = `${V2} [data-ppm-canvas-grammar="v2"]`;
// oxfmt breaks long selectors and gradients over several lines: strip comments and collapse whitespace first.
const css = readFileSync(new URL("../../core/components/ppm-canvas/canvas-v2.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s+/g, " ");
const editorSource = readFileSync(new URL("../../core/components/ppm-canvas/editor.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(
  new URL("../../core/components/ppm-canvas/workspace.tsx", import.meta.url),
  "utf8"
);

// WCAG contrast of a line drawn at `opacity` over the board (the browser composites in sRGB).
type TRgb = [number, number, number];
const hex = (value: string): TRgb => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16)) as TRgb;
const luminance = (rgb: TRgb) => {
  const [r, g, b] = rgb.map((channel) => {
    const x = channel / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const lineContrast = (line: string, board: string, opacity: number) => {
  const back = hex(board);
  const blended = hex(line).map((channel, index) => opacity * channel + (1 - opacity) * back[index]) as TRgb;
  const [a, b] = [luminance(back), luminance(blended)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

function selectors(): string[] {
  return [...css.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((prelude) => !prelude.startsWith("@"))
    .flatMap((prelude) => prelude.split(",").map((selector) => selector.trim()));
}

// Body of the first rule whose selector list contains `selector` exactly (works inside @media and comma lists).
function ruleBody(selector: string): string {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, prelude]) =>
    prelude
      .split(",")
      .map((item) => item.trim())
      .includes(selector)
  );
  expect(rule, selector).toBeDefined();
  return rule![2];
}

describe("canvas-v2.css (UX1.1)", () => {
  it("is imported right after canvas.css", () => {
    const base = editorSource.indexOf('import "./canvas.css";');
    expect(base).toBeGreaterThan(0);
    expect(editorSource.indexOf('import "./canvas-v2.css";')).toBeGreaterThan(base);
  });

  it("scopes every selector to the v2 design", () => {
    const list = selectors();
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter((selector) => !selector.startsWith(V2))).toEqual([]);
  });

  it("keeps text at or above 11px", () => {
    const small = [...css.matchAll(/font-size:\s*([\d.]+)(rem|px)/g)].filter(([, value, unit]) =>
      unit === "px" ? Number(value) < 11 : Number(value) < 0.6875
    );
    expect(small.map((match) => match[0])).toEqual([]);
  });

  it("gives every PPM token a fallback and puts no shadow on canvas nodes", () => {
    expect(css.match(/var\(--ppm-[\w-]+\)/g) ?? []).toEqual([]);
    // `\s*(?!none)` lets `\s*` back off to zero width right before the space in "box-shadow: none", so the
    // lookahead then sees a space (not "n") and wrongly reports a match — flagging an explicit, intentional reset
    // as if it were a real shadow (UX1.1 C3 hit this on
    // `.ppm-canvas-node:not(.ppm-canvas-node--fallback) { … box-shadow: none; }`). Anchoring the lookahead on the
    // value itself (`(?!\s*none\b)`) keeps every other case identical and only stops flagging `none`.
    expect(css).not.toMatch(/\.ppm-canvas-node[^{]*\{[^}]*(box-shadow:(?!\s*none\b)|(?<!backdrop-)filter:)/);
  });

  it("sizes the workspace chrome from density tokens and paints the board", () => {
    expect(ruleBody(`${V2} .ppm-canvas-workspace`)).toContain("var(--ppm-canvas-status-height, 2rem)");
    expect(ruleBody(`${G} .tl-container`)).toContain(
      "--color-background: var(--ppm-color-board, var(--bg-surface-1));"
    );
  });

  it("draws edges under cards, with pointer events only on chips", () => {
    expect(ruleBody(`${G} .ppm-semantic-layer`)).toContain("pointer-events: none;");
    expect(ruleBody(`${G} .ppm-semantic-chip`)).toContain("pointer-events: all;");
    expect(ruleBody(`${G} .ppm-semantic-edge[data-dashed] .ppm-semantic-edge__line`)).toContain(
      "stroke-dasharray: var(--ppm-link-dash, 4 3);"
    );
    expect(ruleBody(`${G} .ppm-semantic-edge[data-tone="danger"]`)).toContain("--ppm-color-danger-line");
  });

  it("mutes a proposed link but keeps its type's stroke and ending, and the chip text at full contrast", () => {
    const opacity = Number(
      /opacity: ([\d.]+);/.exec(ruleBody(`${G} .ppm-semantic-edge[data-confirmation="proposed"]`))?.[1]
    );
    // 0.55 gave ~2.4:1 (neutral) and ~2.3:1 (red) on the light board — below the 3:1 of a meaningful graphic.
    expect(opacity).toBeGreaterThanOrEqual(0.75);
    // Light theme (tokens-v2.css, TOKENS §11): board #faf6f1, link #615d58, danger line #c44037; dark: board
    // #11100e, link #aba7a3, danger line #dd766f.
    expect(lineContrast("#615d58", "#faf6f1", opacity)).toBeGreaterThanOrEqual(3);
    expect(lineContrast("#c44037", "#faf6f1", opacity)).toBeGreaterThanOrEqual(3);
    expect(lineContrast("#aba7a3", "#11100e", opacity)).toBeGreaterThanOrEqual(3);
    expect(lineContrast("#dd766f", "#11100e", opacity)).toBeGreaterThanOrEqual(3);
    // A proposed link must not borrow the dashes of «Противоречит».
    expect(css).not.toMatch(/\[data-confirmation="proposed"\] \.ppm-semantic-edge__line/);
    expect(ruleBody(`${G} .ppm-semantic-chip[data-confirmation="proposed"]`)).not.toContain("opacity");
  });

  it("paints live cards as surface cards with an accent live glyph", () => {
    expect(
      ruleBody(
        `${G} .ppm-canvas-node:not(.ppm-canvas-node--fallback):not(.ppm-canvas-node--group):not(.ppm-canvas-node--frame)`
      )
    ).toContain("border-radius: var(--ppm-radius-md, 0.5rem);");
    expect(ruleBody(`${G} .ppm-live-glyph`)).toContain("var(--ppm-color-accent, var(--txt-accent-primary))");
  });

  it("keeps sections square: the card-radius rule excludes group/frame, matching nodeIndicatorRadius(true, …) = 0", () => {
    // Without the :not(--group):not(--frame) exclusion this selector's specificity (0,3,0) beats the C4 section
    // rule's (0,2,0) and its border-radius wins the cascade, leaving sections rounded while the selection outline
    // (nodeIndicatorRadius, canvas-grammar.ts) is drawn square — a visible mismatch.
    expect(selectors()).not.toContain(`${G} .ppm-canvas-node:not(.ppm-canvas-node--fallback)`);
    expect(selectors()).toContain(
      `${G} .ppm-canvas-node:not(.ppm-canvas-node--fallback):not(.ppm-canvas-node--group):not(.ppm-canvas-node--frame)`
    );
    expect(ruleBody(`${G} .ppm-canvas-node--group`)).toContain("border-radius: 0;");
    expect(ruleBody(`${G} .ppm-canvas-node--frame`)).toContain("border-radius: 0;");
  });

  it("floats the inspector under the board pill and hides it on narrow canvases", () => {
    const inspector = ruleBody(`${G} .ppm-canvas-inspector`);
    expect(inspector).toContain("right: var(--ppm-canvas-overlay-inset, 1rem);");
    expect(inspector).toContain("width: min(var(--ppm-inspector-width, 19rem), calc(100% - 2rem));");
    expect(css).toMatch(/@media \(max-width: 979px\)\s*\{[^}]*\.ppm-canvas-inspector\s*\{\s*display: none;/);
  });

  it("draws transparent sections with corner ticks", () => {
    const section = ruleBody(`${G} .ppm-canvas-node--group`);
    expect(section).toContain("background: transparent;");
    expect(section).toContain("border-radius: 0;");
    expect(ruleBody(`${G} .ppm-canvas-node--group::before`)).toContain("--ppm-color-section-tick");
  });

  it("frames found-by-search cards with a dashed border of at least 3:1", () => {
    expect(ruleBody(`${G} .ppm-canvas-node--search`)).toContain(
      "border: 1px dashed var(--ppm-color-card-found-border, var(--border-subtle-1));"
    );
  });

  it("gives the board pill a visible focus ring despite its box-shadow reset", () => {
    // The pill rule sets `box-shadow: none` (no elevation in v2); unlayered, it also beats the shared layered ring.
    expect(ruleBody(`${G} .ppm-canvas-board-info__toggle`)).toContain("box-shadow: none;");
    expect(ruleBody(`${G} .ppm-canvas-board-info__toggle:focus-visible`)).toContain(
      "box-shadow: var(--ppm-focus-ring, 0 0 0 2px var(--border-accent-strong));"
    );
  });

  it("keeps the separator between the sync status and the role on narrow status lines", () => {
    const narrow = /@media \(max-width: 680px\) \{(.*?)\{ display: none; \} \}/.exec(css)?.[1] ?? "";
    const hidden = narrow.split(",").map((selector) => selector.trim());
    expect(hidden).toEqual([
      `${V2} .ppm-canvas-statusline__sheet`,
      `${V2} .ppm-canvas-statusline__time`,
      `${V2} .ppm-canvas-statusline__sep--sheet`,
      `${V2} .ppm-canvas-statusline__sep--time`,
    ]);
    // Only the sheet's and the time's own separators carry a modifier; the role keeps a plain one.
    const separators = workspaceSource.match(/className="ppm-canvas-statusline__sep[^"]*"/g) ?? [];
    expect(separators).toEqual([
      'className="ppm-canvas-statusline__sep ppm-canvas-statusline__sep--sheet"',
      'className="ppm-canvas-statusline__sep ppm-canvas-statusline__sep--time"',
      'className="ppm-canvas-statusline__sep"',
    ]);
  });
});
