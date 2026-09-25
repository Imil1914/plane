// AF2.1 R5: regressions of the second agent that belong to the toolkit (other-agent-analysis «Регрессии»).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const editor = read("../../core/components/ppm-canvas/editor.tsx");
const toolkitCss = read("../../core/components/ppm-canvas/canvas-toolkit.css");
const legacyRail = read("../../core/components/ppm-canvas/canvas-rail-legacy.tsx");
const collaboration = read("../../e2e/ppm-canvas-collaboration.spec.ts");
const demo = read("../../e2e/ppm-demo.spec.ts");
// Formatting-proof source checks: oxfmt may wrap calls/objects and add trailing commas.
const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

describe("AF2.1 R5 regressions", () => {
  it("#2: v1 keeps zoom buttons in the rail", () => {
    for (const command of ["fit-view", "zoom-in", "zoom-out"])
      expect(legacyRail).toContain(`onRunCommand("${command}")`);
  });

  it("#3: the tasks panel never covers the inspector or the «Доска» pill", () => {
    expect(editor).toMatch(/const inspectorHidden =\s*tasksPanelOpen \|\|/);
    expect(toolkitCss).toContain('[data-ppm-canvas-grammar="v2"] .ppm-work-item-picker--panel');
    expect(toolkitCss).toContain("top: calc(var(--ppm-canvas-overlay-inset, 1rem) + 2.75rem);");
  });

  it("#6: one rule counts objects for the pill and the «Объекты» list in v2", () => {
    has(editor, "const objectCount = grammarV2 ? countedShapes.length + nodes.length : nodes.length;");
    has(editor, 'ppmT("canvas.board_info_objects").replace("{count}", String(objectCount))');
    has(editor, '{ppmT("canvas.objects")} · {objectCount}');
    // shapeCount stays only for the empty state (plan-F F-D5), never for the pill.
    expect(norm(editor)).not.toContain(norm("String(shapeCount))"));
  });

  it("#8: e2e drives the grouped rail of v2", () => {
    expect(collaboration).not.toContain("Добавить заметку ⇧N");
    expect(collaboration).toContain("async function addCanvasNote(page: Page)");
    expect(demo).not.toContain('name: "Добавить задачу", exact: true }).click()');
    expect(demo).toContain('getByRole("menuitem", { name: /^Задача/ })');
  });

  it("M-4: the rail menu caps its width so it stays inside a 375px viewport", () => {
    has(toolkitCss, "width: 20rem;");
    has(toolkitCss, "max-width: calc(100vw - (var(--ppm-canvas-overlay-inset, 1rem) * 2) - 3.375rem);");
    // 3.375rem covers the rail's own ~2.875rem (0.25rem padding + 2.25rem tool + border) plus the 0.5rem gap before
    // the menu; with a matching 1rem inset on the right, the whole row must fit the 375px (23.4375rem) K1 target.
    const remPx = 16;
    const viewportRem = 375 / remPx;
    const insetRem = 1;
    const railAndGapRem = 3.375;
    const maxWidthRem = viewportRem - insetRem * 2 - railAndGapRem;
    expect(insetRem + railAndGapRem + maxWidthRem + insetRem).toBeLessThanOrEqual(viewportRem + 1e-9);
    // Still a usable K1 list menu (well above its item icons + padding), not squeezed to nothing.
    expect(maxWidthRem).toBeGreaterThan(15);
  });
});
