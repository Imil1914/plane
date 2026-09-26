// UX1.1 F2: contract for the v2 token layer («гибрид A+B»). Parses tokens-v2.css, converts OKLCH -> sRGB and checks
// WCAG 2.x ratios per role in both themes. Spec acceptance #1: text >= 4.5:1, meaningful borders/icons >= 3:1.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PPM_THEME_COLOR_V2 } from "../index";

const source = readFileSync(new URL("../tokens-v2.css", import.meta.url), "utf8");

type Rule = { selector: string; decls: Map<string, string> };
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: number[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") {
      stack.push(start);
      start = i + 1;
    } else if (ch === "}") {
      const body = clean.slice(start, i);
      const open = clean.lastIndexOf("{", start - 1);
      const selStart = Math.max(clean.lastIndexOf("}", open - 1), clean.lastIndexOf("{", open - 1)) + 1;
      const selector = clean.slice(selStart, open).trim().replace(/\s+/g, " ");
      if (!body.includes("{")) {
        const decls = new Map<string, string>();
        for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(m[1], m[2].trim());
        rules.push({ selector, decls });
      }
      start = stack.pop() ?? 0;
    }
  }
  return rules;
}
const rules = parseRules(source);
const HTML_V2 = ':where(html[data-ppm-design="v2"])[data-ppm-brand="enabled"]';
const LOCAL_V2 = ':where([data-ppm-brand="enabled"][data-ppm-design="v2"])';
const findRule = (selector: string) => {
  const rule = rules.find((r) => r.selector === selector);
  if (!rule) throw new Error(`rule not found: ${selector}`);
  return rule;
};
const constants = findRule(HTML_V2);
const compact = findRule(`${HTML_V2}[data-ppm-density="compact"]`);
const lightRoles = findRule(`${HTML_V2}, ${LOCAL_V2} [data-theme*="light"]`);
const darkRoles = findRule(`${HTML_V2}:where([data-theme*="dark"]), ${LOCAL_V2} [data-theme*="dark"]`);
const bridge = findRule(`${HTML_V2}, ${LOCAL_V2} :is([data-theme*="light"], [data-theme*="dark"])`);
const borders = findRule(
  `${HTML_V2}:not([data-theme$="-contrast"]), ${LOCAL_V2} :is([data-theme="light"], [data-theme="dark"])`
);

function resolve(theme: Rule, name: string, depth = 0): string {
  const raw = theme.decls.get(name) ?? bridge.decls.get(name) ?? borders.decls.get(name) ?? constants.decls.get(name);
  if (raw === undefined) throw new Error(`unresolved ${name}`);
  if (depth > 10) throw new Error(`cycle at ${name}`);
  const ref = raw.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(theme, ref[1], depth + 1) : raw;
}
function toLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function srgb(color: string): [number, number, number] {
  const ok = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!ok) throw new Error(`unsupported colour ${color}`);
  const [L, C, H] = ok.slice(1).map(Number);
  const a = C * Math.cos((H * Math.PI) / 180),
    b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  }) as [number, number, number];
}
function luminance(color: string) {
  const [r, g, b] = srgb(color).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg: string, bg: string) {
  const [x, y] = [luminance(fg), luminance(bg)].toSorted((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const hex = (color: string) =>
  "#" +
  srgb(color)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("");

const THEMES = { light: lightRoles, dark: darkRoles } as const;
const SURFACES = [
  "canvas",
  "surface-1",
  "surface-2",
  "layer-1",
  "layer-1-hover",
  "layer-1-selected",
  "layer-2",
  "layer-2-hover",
  "layer-2-selected",
  "layer-3",
  "layer-3-hover",
  "layer-3-selected",
  "selection-bg",
];
const TEXT = ["text", "text-secondary", "text-muted", "text-placeholder", "accent-text", "danger-text"];
// Meaningful non-text marks: control borders, focus/selection, quiet icons, status glyphs, type icons, canvas lines.
const MARKS = [
  "--ppm-color-border-control",
  "--ppm-color-border-strong",
  "--ppm-color-border-emphasis",
  "--ppm-color-focus",
  "--ppm-color-selection",
  "--ppm-color-icon-subtle",
  "--ppm-color-danger-line",
  "--ppm-status-backlog",
  "--ppm-status-todo",
  "--ppm-status-progress",
  "--ppm-status-review",
  "--ppm-status-done",
  "--ppm-status-cancelled",
  "--ppm-type-task",
  "--ppm-type-doc",
  "--ppm-type-file",
  "--ppm-type-code",
  "--ppm-type-decision",
  "--ppm-color-link",
  "--ppm-color-section-tick",
  "--ppm-color-card-found-border",
  // AF2.2 final-pass M3/F: the «Светофор» overdue frame of a live card and the badge border.
  "--ppm-color-warning",
];
// AF2.2 final-pass M3/F: warning is text only on the live card and the map badges (surface-1): «просрочено · 20 сент.»,
// «2 просрочено». It is not in TEXT: on the canvas and on hover/selected layers the light warning is below 4.5:1
// (3.79–4.41), so any text on those surfaces needs another token.
const WARNING_TEXT_SURFACES = ["card-live", "surface-1"];
const MARK_SURFACES = ["canvas", "surface-1", "surface-2", "layer-1", "layer-2", "board"];

describe("PPM token contract v2 (UX1.1, гибрид A+B)", () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    const role = (r: string) => resolve(theme, `--ppm-color-${r}`);

    it(`${name}: every text role is >= 4.5:1 on every surface, state and the selection fill`, () => {
      for (const t of TEXT)
        for (const s of SURFACES) expect(ratio(role(t), role(s)), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: the living map's warning text («просрочено») is >= 4.5:1 where it is drawn`, () => {
      for (const s of WARNING_TEXT_SURFACES)
        expect(ratio(role("warning"), role(s)), `warning on ${s}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: labels on accent and danger fills are >= 4.5:1`, () => {
      for (const f of ["accent", "accent-hover", "accent-active"])
        expect(ratio(resolve(theme, "--txt-on-accent"), role(f)), f).toBeGreaterThanOrEqual(4.5);
      for (const f of ["danger", "danger-hover", "danger-active"])
        expect(ratio(resolve(theme, "--txt-on-color"), role(f)), f).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: meaningful borders, icons, glyphs and canvas lines are >= 3:1`, () => {
      for (const mark of MARKS)
        for (const s of MARK_SURFACES)
          expect(ratio(resolve(theme, mark), role(s)), `${mark} on ${s}`).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: focus differs from selection and states differ from their base`, () => {
      expect(role("focus")).not.toBe(role("selection"));
      expect(ratio(role("layer-1-hover"), role("layer-1"))).toBeGreaterThan(1.03);
      expect(ratio(role("layer-1-selected"), role("layer-1-hover"))).toBeGreaterThan(1.03);
      expect(ratio(role("selection-bg"), role("surface-1"))).toBeGreaterThan(1.03);
    });
  }

  it("both themes declare the same role set", () => {
    const keys = (r: Rule) => [...r.decls.keys()].toSorted();
    expect(keys(lightRoles)).toEqual(keys(darkRoles));
  });

  it("uses the owner-approved accent (R22) and the canvas colour behind meta theme-color (R20)", () => {
    expect(darkRoles.decls.get("--ppm-color-accent")).toBe("oklch(0.8 0.1 212)");
    expect(lightRoles.decls.get("--ppm-color-accent")).toBe("oklch(0.49 0.09 228)");
    expect(hex(resolve(darkRoles, "--ppm-color-canvas"))).toBe(PPM_THEME_COLOR_V2.dark);
    expect(hex(resolve(lightRoles, "--ppm-color-canvas"))).toBe(PPM_THEME_COLOR_V2.light);
  });

  it("gates every rule twice: brand enabled and design v2", () => {
    for (const r of rules) {
      expect(r.selector, r.selector).toContain('data-ppm-brand="enabled"');
      expect(r.selector, r.selector).toContain('data-ppm-design="v2"');
    }
  });

  it("keeps the flattened specificity and leaves Plane high-contrast borders alone", () => {
    for (const r of [lightRoles, darkRoles, bridge, constants, compact])
      for (const k of r.decls.keys()) expect(k.startsWith("--border-"), `${k} in ${r.selector}`).toBe(false);
    expect(source).not.toMatch(/html\[data-ppm-brand="enabled"\]\[data-theme/);
    expect(source).not.toContain("!important");
  });

  it("compact density only tightens: every compact value <= comfortable, text never below 11px", () => {
    const rem = (v: string) => Number(v.replace("rem", ""));
    for (const [k, v] of compact.decls) {
      expect(constants.decls.has(k), `${k} has a comfortable value`).toBe(true);
      expect(rem(v), k).toBeLessThanOrEqual(rem(constants.decls.get(k)!));
    }
    for (const r of [constants, compact])
      for (const [k, v] of r.decls)
        if (/^--ppm-text-.*-size$/.test(k)) expect(rem(v), k).toBeGreaterThanOrEqual(0.6875);
  });

  it("publishes the density scale of TOKENS §5 (comfortable / compact, px)", () => {
    const px = (r: Rule, k: string) => Math.round(Number(r.decls.get(k)!.replace("rem", "")) * 16);
    const table: Array<[string, number, number]> = [
      ["--ppm-row-height", 36, 32],
      ["--ppm-group-row-height", 36, 32],
      ["--ppm-table-head-height", 32, 28],
      ["--ppm-sidebar-item-height", 32, 28],
      ["--ppm-topbar-height", 48, 44],
      ["--ppm-page-header-height", 52, 44],
      ["--ppm-sprint-strip-height", 60, 52],
      ["--ppm-toolbar-height", 44, 40],
      ["--ppm-control-height", 32, 28],
      ["--ppm-control-height-sm", 28, 24],
      ["--ppm-page-padding-x", 24, 16],
      ["--ppm-cell-gap", 12, 8],
      ["--ppm-panel-padding", 20, 16],
      ["--ppm-avatar-size", 20, 18],
      ["--ppm-text-body-size", 14, 13],
      ["--ppm-text-mono-size", 12, 11],
    ];
    for (const [k, comfortable, dense] of table) {
      expect(px(constants, k), k).toBe(comfortable);
      expect(px(compact, k), k).toBe(dense);
    }
  });

  it("switches the monospace family to IBM Plex Mono and exposes the wdth narrowing token", () => {
    expect(constants.decls.get("--ppm-font-mono")).toMatch(/^"IBM Plex Mono",/);
    expect(constants.decls.get("--ppm-font-stretch-narrow")).toBe("85%");
    expect(source).not.toMatch(/jetbrains/i);
  });
});
