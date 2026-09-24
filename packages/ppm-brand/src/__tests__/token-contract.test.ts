// UX0.2 §A token contract: parses tokens.css, converts OKLCH -> sRGB, checks WCAG 2.x ratios per role.
// Self-contained: reads the token source directly, so it needs no build step or running app.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokenSource = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

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
const rules = parseRules(tokenSource);
const findRule = (predicate: (s: string) => boolean) => {
  const rule = rules.find((r) => predicate(r.selector));
  if (!rule) throw new Error("rule not found");
  return rule;
};
const lightRoles = findRule((s) => s.includes('[data-theme*="light"]') && !s.includes(":is("));
const darkRoles = findRule((s) => s.includes('[data-theme*="dark"]') && !s.includes(":is("));
const bridge = findRule((s) => s.includes(':is([data-theme*="light"], [data-theme*="dark"])'));
const borders = findRule((s) => s.includes(':not([data-theme$="-contrast"])'));
const constants = findRule((s) => s === '[data-ppm-brand="enabled"]');

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
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16) / 255) as [number, number, number];
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

// Plane fills that PPM does not override (tailwind-config/variables.css: red-700/800/900 light, red-300/400/500 dark).
const DANGER = { light: ["#e7000b", "#c10007", "#9f0712"], dark: ["#9f0712", "#c10007", "#e7000b"] };
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
];
const TEXT = ["text", "text-secondary", "text-muted", "text-placeholder", "accent-text"];
const sortedKeys = (r: Rule) => [...r.decls.keys()].toSorted();

describe("PPM token contract (UX0.2)", () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    const role = (r: string) => resolve(theme, `--ppm-color-${r}`);

    it(`${name}: every text role is >= 4.5:1 on every surface and state`, () => {
      for (const t of TEXT)
        for (const s of SURFACES) expect(ratio(role(t), role(s)), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: accent fills carry dark ink, danger fills keep a light label`, () => {
      const ink = resolve(theme, "--txt-on-accent");
      for (const f of ["accent", "accent-hover", "accent-active"])
        expect(ratio(ink, role(f)), f).toBeGreaterThanOrEqual(4.5);
      const onColorRef = theme.decls.get("--txt-on-color");
      expect(onColorRef).not.toBe("#062b32");
      const onColor = resolve(theme, "--txt-on-color");
      for (const d of DANGER[name as keyof typeof DANGER]) expect(ratio(onColor, d), d).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: control borders are >= 3:1 and states are distinguishable`, () => {
      for (const b of ["border-control", "border-strong", "border-emphasis"])
        for (const s of ["canvas", "surface-1", "surface-2", "layer-1", "layer-2"])
          expect(ratio(role(b), role(s)), `${b} vs ${s}`).toBeGreaterThanOrEqual(3);
      expect(ratio(role("layer-1"), role("surface-2"))).toBeGreaterThanOrEqual(1.07);
      expect(ratio(role("layer-1-hover"), role("layer-1"))).toBeGreaterThanOrEqual(1.1);
      expect(ratio(role("layer-1-selected"), role("surface-2"))).toBeGreaterThanOrEqual(1.25);
      expect(ratio(role("layer-2-selected"), role("layer-2"))).toBeGreaterThanOrEqual(1.25);
    });

    it(`${name}: focus ring is >= 3:1 and differs from the selection border`, () => {
      for (const s of ["canvas", "surface-1", "surface-2", "layer-1", "layer-1-selected", "layer-2"])
        expect(ratio(role("focus"), role(s)), s).toBeGreaterThanOrEqual(3);
      expect(role("focus")).not.toBe(role("selection"));
    });
  }

  it("dark elevation: layer-2 is never darker than layer-1", () => {
    const r = (x: string) => resolve(darkRoles, `--ppm-color-${x}`);
    expect(luminance(r("layer-2"))).toBeGreaterThanOrEqual(luminance(r("layer-1")));
    expect(luminance(r("layer-3"))).toBeGreaterThanOrEqual(luminance(r("layer-2")));
  });

  it("both themes declare the same role set", () => {
    expect(sortedKeys(lightRoles)).toEqual(sortedKeys(darkRoles));
  });

  it("leaves Plane high-contrast borders alone and never out-specifies Plane themes", () => {
    for (const r of [lightRoles, darkRoles, bridge])
      for (const k of r.decls.keys()) expect(k.startsWith("--border-"), `${k} in ${r.selector}`).toBe(false);
    expect(borders.selector).toContain(':not([data-theme$="-contrast"])');
    expect(tokenSource).not.toMatch(/html\[data-ppm-brand="enabled"\]\[data-theme/);
  });

  it("keeps the focus ring in the utilities layer", () => {
    const utilities = tokenSource.slice(tokenSource.indexOf("@layer utilities"));
    expect(utilities).toMatch(/:focus-visible\s*\{\s*--tw-ring-offset-shadow/);
  });

  it('brand disabled means upstream: every --bg-/--txt-/--border-/--neutral- block is gated by [data-ppm-brand="enabled"]', () => {
    const gatedPrefixes = ["--bg-", "--txt-", "--border-", "--neutral-"];
    const offenders: string[] = [];
    for (const rule of rules) {
      const hasGatedDecl = [...rule.decls.keys()].some((k) => gatedPrefixes.some((p) => k.startsWith(p)));
      if (hasGatedDecl && !rule.selector.includes('data-ppm-brand="enabled"')) offenders.push(rule.selector);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the editor font override outside every @layer, so it wins over @layer base", () => {
    const marker = 'html[data-ppm-brand="enabled"] .editor-container';
    const idx = tokenSource.indexOf(marker);
    expect(idx, "editor-container rule not found").toBeGreaterThan(-1);

    // A position sits outside every @layer block exactly when the brace count up to that
    // point is balanced: every block opened before it (layer or rule) has already closed.
    const before = tokenSource.slice(0, idx).replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    for (const ch of before) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    expect(depth, "editor-container rule must sit outside every @layer block").toBe(0);

    expect(tokenSource).toContain(".editor-container.sans-serif");
    expect(tokenSource).toContain("--font-style: var(--ppm-font-sans)");
    expect(tokenSource).toContain(".ProseMirror pre");
    expect(tokenSource).toContain("font-family: var(--ppm-font-mono)");
  });
});
