// UX1.1 F3: guards for the v2 stylesheets (apps/web/styles/ppm-v2/*.css) and the font wiring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const STYLES = "../../styles/";
// tasks.css (lane T) and canvas-v2.css (lane C) have their own guards (plan-T tasks-css.test.ts, plan-C).
const V2_FILES = ["ppm-v2/system.css", "ppm-v2/shell.css"];
const GATE = ':where(html[data-ppm-design="v2"]';
const ROLES = ["display", "title-1", "title-2", "title-3", "body", "ui", "meta", "mono", "mono-sm"];

/** Selectors of ordinary style rules (at-rule preludes such as @layer/@utility/@media are skipped). */
function ruleSelectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  let prelude = "";
  const stack: boolean[] = [];
  for (const ch of clean) {
    if (ch === "{") {
      const head = prelude.trim().replace(/\s+/g, " ");
      const insideUtility = stack.includes(true);
      const isAtRule = head.startsWith("@");
      if (!isAtRule && !insideUtility && !head.startsWith("&")) selectors.push(head);
      stack.push(isAtRule && head.startsWith("@utility"));
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else if (ch === ";") prelude = "";
    else prelude += ch;
  }
  return selectors;
}
/** Splits a selector list on top-level commas. */
const splitList = (selector: string) => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
};

describe("v2 stylesheets (UX1.1)", () => {
  it("globals.css imports the v2 layers after tokens.css, in order", () => {
    const globals = read(`${STYLES}globals.css`);
    const order = [
      '@import "@ppm/brand/tokens.css";',
      '@import "@ppm/brand/tokens-v2.css";',
      '@import "./ppm-v2/system.css";',
      '@import "./ppm-v2/shell.css";',
      '@import "./ppm-v2/tasks.css";',
    ].map((line) => globals.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order.every((index, position) => position === 0 || index >= order[position - 1])).toBe(true);
  });

  it("defines the ppm-v2 and ppm-compact variants exactly as CONTRACTS §2", () => {
    const system = read(`${STYLES}ppm-v2/system.css`);
    expect(system).toContain('@custom-variant ppm-v2 (&:where([data-ppm-design="v2"], [data-ppm-design="v2"] *));');
    expect(system).toContain(
      '@custom-variant ppm-compact (&:where([data-ppm-design="v2"][data-ppm-density="compact"], [data-ppm-design="v2"][data-ppm-density="compact"] *));'
    );
  });

  it("publishes the nine ppm-text-* roles with fallbacks and no text-* utility of its own", () => {
    const system = read(`${STYLES}ppm-v2/system.css`);
    for (const role of ROLES) {
      const body = system.slice(
        system.indexOf(`@utility ppm-text-${role} {`),
        system.indexOf("}", system.indexOf(`@utility ppm-text-${role} {`))
      );
      expect(body, role).toContain(`font-size: var(--ppm-text-${role}-size, `);
      expect(body, role).toContain(`line-height: var(--ppm-text-${role}-leading, `);
    }
    expect(system).not.toMatch(/@utility text-/);
  });

  it("gates every rule on the v2 design attribute and never uses !important", () => {
    for (const file of V2_FILES) {
      const css = code(read(`${STYLES}${file}`));
      for (const selector of ruleSelectors(css))
        for (const part of splitList(selector)) expect(part.startsWith(GATE), `${file}: ${part}`).toBe(true);
      expect(css, file).not.toContain("!important");
    }
  });

  it("gives every var(--ppm-*) a fallback (IACVT)", () => {
    for (const file of V2_FILES) {
      const bare = code(read(`${STYLES}${file}`)).match(/var\(--ppm-[\w-]+\)/g) ?? [];
      expect(bare, file).toEqual([]);
    }
  });

  // Spec C: lucide icons «тоньше, визуально 1,5 px» at every size. A unitless width on svg.lucide is in 24-unit grid
  // units (thicker on big icons) and beat explicit thinner strokes; non-scaling-stroke on the drawn elements gives
  // an even 1.5 CSS px and leaves icons with an explicit hairline (stroke-1 / strokeWidth={1}) alone.
  it("draws lucide icons with an even 1.5px stroke and keeps explicit hairlines", () => {
    const css = code(read(`${STYLES}ppm-v2/system.css`));
    const bodyOf = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
    };
    const icons = ':where(html[data-ppm-design="v2"]) svg.lucide:not(.stroke-1, [stroke-width="1"]) *';
    expect(bodyOf(icons)).toMatch(/stroke-width:\s*1\.5px;/);
    expect(bodyOf(icons)).toMatch(/vector-effect:\s*non-scaling-stroke;/);
    // No grid-unit width on the <svg> itself any more (it overrode stroke-[1.5]/stroke-1 and grew with the icon).
    expect(css).not.toMatch(/svg\.lucide\s*\{[^}]*stroke-width/);
  });

  it("does not remap Plane's global type scale (no --text-13 lever)", () => {
    for (const file of V2_FILES) expect(code(read(`${STYLES}${file}`)), file).not.toMatch(/--text-\d+\s*:/);
  });

  it("loads IBM Plex Sans with the wdth axis and Plex Mono 400/500, preloading Plex under the brand", () => {
    const root = read("../../app/root.tsx");
    expect(root).toContain('import "@fontsource-variable/ibm-plex-sans/wdth.css";');
    expect(root).not.toMatch(/import "@fontsource-variable\/ibm-plex-sans";/);
    expect(root).toContain('import "@fontsource/ibm-plex-mono";');
    expect(root).toContain('import "@fontsource/ibm-plex-mono/500.css";');
    expect(root).toContain('import "@fontsource-variable/jetbrains-mono";');
    expect(root).toMatch(
      /IS_PPM_BRAND_ENABLED \? \[plexSansCyrillicWoff2, plexSansLatinWoff2\] : \[interVariableWoff2\]/
    );
  });
});
