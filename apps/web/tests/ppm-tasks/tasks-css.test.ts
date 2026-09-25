// UX1.1 T: every Tasks v2 rule is scoped to the v2 design, every --ppm var has a wave-0 fallback,
// and a list row and its virtualization placeholder take their height from the same token.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../styles/ppm-v2/tasks.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const body = (selector: string) =>
  rules.find((rule) => rule.selector.split(",").some((part) => part.trim().endsWith(selector)))?.body ?? "";
const NARROW = "@media (max-width: 40rem)";
/** Rules inside every `@media (max-width: 40rem)` block (≤640 px), in source order. */
const narrowRules = (() => {
  const found: Array<{ selector: string; body: string }> = [];
  for (let at = css.indexOf(NARROW); at >= 0; at = css.indexOf(NARROW, at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 1;
    let end = open + 1;
    for (; depth > 0; end++) depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0;
    for (const m of css.slice(open + 1, end - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g))
      found.push({ selector: m[1].trim(), body: m[2] });
  }
  return found;
})();
const narrow = (selector: string) =>
  narrowRules
    .filter((rule) => rule.selector.split(",").some((part) => part.trim().endsWith(selector)))
    .map((rule) => rule.body)
    .join("\n");

describe("tasks.css", () => {
  it("has rules", () => {
    expect(rules.length).toBeGreaterThan(0);
  });
  it("scopes every selector under the v2 design", () => {
    const unscoped = rules
      .flatMap((rule) => rule.selector.split(",").map((part) => part.trim()))
      .filter((part) => !part.startsWith(':where(html[data-ppm-design="v2"]'));
    expect(unscoped).toEqual([]);
  });
  it("gives every --ppm variable a fallback", () => {
    expect(css.match(/var\(--ppm-[\w-]+\)/g) ?? []).toEqual([]);
  });
  it("uses one token for the row and the virtualization placeholder", () => {
    expect(body(".ppm-task-row")).toMatch(/min-height:\s*var\(--ppm-row-height,/);
    expect(body(".ppm-task-row-placeholder")).toMatch(/height:\s*var\(--ppm-row-height,/);
    expect(body(".ppm-task-group-row")).toMatch(/min-height:\s*var\(--ppm-group-row-height,/);
  });
  it("marks the peeked row by background and a 2px left mark, not by focus", () => {
    const peeked = body('.ppm-task-row[data-ppm-peeked="true"]');
    expect(peeked).toMatch(/background-color:\s*var\(--ppm-color-selection-bg,/);
    expect(peeked).toMatch(/box-shadow:\s*inset 2px 0 0 var\(--ppm-color-selection,/);
  });
  // T2: the key caps of «Новая задача · N I» come from PpmKbdHint (ppm-shell/kbd-hint.tsx), so no local .ppm-kbd.
  it("styles the T2 header from its tokens and leaves the key caps to PpmKbdHint", () => {
    expect(body(".ppm-layout-switch")).toMatch(/height:\s*var\(--ppm-control-height-sm,/);
    expect(body('.ppm-layout-switch__item[aria-pressed="true"]')).toMatch(
      /background-color:\s*var\(--ppm-color-layer-1-selected,/
    );
    expect(body(".ppm-sprint")).toMatch(/height:\s*var\(--ppm-sprint-strip-height,/);
    expect(body(".ppm-sprint")).toMatch(/margin:[^;]*var\(--ppm-page-padding-x,/);
    expect(css).not.toMatch(/\.ppm-kbd\b/);
  });
  // Final fix A5: at 375 px the strip clipped «День 3 из…». ≤640 px: no day track, the name and the summary wrap.
  it("sprint strip ≤640 px: hides the day track and wraps the name and «День N из M · осталось K дней» unclipped", () => {
    expect(narrow(".ppm-sprint__track")).toMatch(/display:\s*none/);
    expect(narrow(".ppm-sprint")).toMatch(/height:\s*auto/);
    expect(narrow(".ppm-sprint")).toMatch(/min-height:\s*var\(--ppm-sprint-strip-height,/);
    for (const part of [".ppm-sprint__name", ".ppm-sprint__summary"])
      expect(narrow(part), part).toMatch(/min-width:\s*0/);
    for (const text of [".ppm-sprint__title", ".ppm-sprint__range", ".ppm-sprint__day", ".ppm-sprint__left"]) {
      expect(narrow(text), text).toMatch(/white-space:\s*normal/);
      expect(narrow(text), text).toMatch(/overflow-wrap:\s*anywhere/);
    }
    expect(narrowRules.map((rule) => rule.body).join("\n")).not.toMatch(/text-overflow|overflow:\s*hidden/);
    // Last in the file: also beats the «Компактная» padding of the strip.
    expect(css.lastIndexOf(NARROW)).toBeGreaterThan(
      css.lastIndexOf(':where(html[data-ppm-design="v2"][data-ppm-density="compact"]) .ppm-sprint')
    );
  });
  // Lane T's own min-font-size guard (tests/ppm-a11y/min-font-size.test.ts leaves tasks.css to the lane).
  it("keeps every font size at 11px or larger", () => {
    const tooSmall = [...css.matchAll(/font-size:\s*(?:var\([^,()]+,\s*)?([\d.]+)(rem|px)/g)]
      .filter(([, value, unit]) => (unit === "px" ? Number(value) < 11 : Number(value) < 0.6875))
      .map((match) => match[0]);
    expect(tooSmall).toEqual([]);
  });
});
