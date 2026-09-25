// AF2.1 F2: облик v1 возвращён к концу UX1.1 (снимок 201ab5f4) + исправление кликов; точки монтирования линий R и B.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCanvasCommandAllowedReadOnly } from "@/components/ppm-canvas/board-workspace-state";
import { PPM_CANVAS_COMMANDS } from "@/components/ppm-canvas/commands";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const editor = read("editor.tsx");
const workspace = read("workspace.tsx");
const shape = read("shape.tsx");
const legacyRail = read("canvas-rail-legacy.tsx");
const css = read("canvas.css");

// Bodies of the rules whose selector list contains `selector` exactly (works inside @media and comma lists).
function ruleBodies(source: string, selector: string): string[] {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, prelude]) =>
      prelude
        .split(",")
        .map((item) => item.trim())
        .includes(selector)
    )
    .map((match) => match[2]);
}

const ruleBody = (source: string, selector: string): string | undefined => ruleBodies(source, selector)[0];

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("AF2.1 F2: v1 as at the end of UX1.1", () => {
  it("restores the UX1.1 commands and declares every AF2.1 command once", () => {
    for (const command of [
      "add-code",
      "add-group",
      "add-frame",
      "add-board-link",
      "add-work-item",
      "add-work-items-view",
      "add-diagram",
      "add-deck",
      "open-tasks",
      "draw-pen",
      "add-sticky",
      "select-hand",
      "open-shapes",
      "open-semantic-edges",
      "add-document-page",
      "add-page-ref",
      "add-list",
      "add-file",
      "add-git",
    ])
      expect(PPM_CANVAS_COMMANDS, command).toContain(command);
    expect(new Set(PPM_CANVAS_COMMANDS).size).toBe(PPM_CANVAS_COMMANDS.length);
  });

  it("keeps the UX1.1 read-only set in v1; the tasks panel and semantic links are v2 tools", () => {
    for (const command of ["select", "fit-view", "zoom-in", "zoom-out"])
      expect(isCanvasCommandAllowedReadOnly(command, false), command).toBe(true);
    for (const command of ["open-tasks", "open-semantic-edges", "semantic-edges", "zoom-reset", "select-hand"]) {
      expect(isCanvasCommandAllowedReadOnly(command, false), command).toBe(false);
      expect(isCanvasCommandAllowedReadOnly(command, true), command).toBe(true);
    }
    expect(isCanvasCommandAllowedReadOnly("add-sticky", true)).toBe(false);
  });

  it("renders the UX1.1 rail in v1 and line R's slot in v2", () => {
    // Line R (R1) adds its own props to <PpmCanvasRail …/>; the v1 branch stays exactly the legacy rail.
    // Parentheses are optional: oxfmt keeps the F2 slot on one line and wraps it once R1 adds props.
    expect(workspace).toMatch(
      /\{designV2 \? \(?\s*<PpmCanvasRail\s+\{\.\.\.railProps\}[\s\S]*?\/>\s*\)? : \(?\s*<PpmCanvasLegacyRail \{\.\.\.railProps\} \/>\s*\)?\}/
    );
    expect(workspace).toContain("window.matchMedia(CANVAS_RAIL_COLLAPSE_QUERY)");
    expect(workspace).not.toContain("ppm-canvas-rail-expanded");
    expect(workspace).not.toContain("ppm-canvas-shape-menu");
    expect(workspace).not.toContain("railTooltip");
    expect(workspace).not.toMatch(/^function RailButton\(/m);
  });

  it("keeps the rail exactly as UX1.1 drew it: brand, labels with shortcuts, links, zoom and alignment", () => {
    expect(legacyRail).toContain("PPM_BRAND.assets.mark");
    expect(legacyRail).toContain("title={label}");
    expect(legacyRail).not.toContain("aria-label={label}");
    for (const shortcut of ['shortcut="⇧N"', 'shortcut="⇧G"', 'shortcut="⇧T"']) expect(legacyRail).toContain(shortcut);
    for (const command of ["add-board-link", "semantic-edges", "fit-view", "zoom-in", "zoom-out", "align-left", "undo"])
      expect(legacyRail, command).toContain(`onRunCommand("${command}")`);
  });

  it("brings back ⇧G for sections and ⇧T «Добавить задачу» in v1 (the tasks panel in v2)", () => {
    expect(workspace).toMatch(/event\.shiftKey && event\.code === "KeyG"[\s\S]{0,160}runCanvasCommand\("add-group"\)/);
    expect(workspace).toContain('runCanvasCommand(designV2 ? "open-tasks" : "add-work-item")');
  });

  it("shows «copy board link» and «copy task link» only under v2", () => {
    expect(workspace).toMatch(/\{designV2 && \(\s*<button\s+type="button"\s+className="ppm-canvas-board-copy"/);
    expect(shape).toContain("{grammarV2 && identity.source_url && (");
  });

  it("restores the UX1.1 task and board pickers next to the v2 tasks panel", () => {
    expect(editor).toMatch(/export default function PpmCanvasEditor\(\{\s*authorId,\s*boardId,\s*boards,/);
    expect(editor).toContain("function BoardLinkPicker(");
    expect(editor).toContain("if (canEdit) setBoardPickerOpen(true);");
    expect(editor).toContain("if (canEdit) setPickerOpen(true);");
    for (const command of ["add-code", "add-group", "add-frame", "add-work-items-view", "add-diagram", "add-deck"])
      expect(editor, command).toContain(`case "${command}":`);
    expect(editor).toMatch(/<WorkItemPicker\s+variant="panel"/);
    expect(editor).toMatch(
      /variant === "panel"\s*\?\s*"ppm-work-item-picker ppm-work-item-picker--panel"\s*:\s*"ppm-work-item-picker"/
    );
  });
});

describe("AF2.1 F2: mount points for lines R and B", () => {
  it("mounts the overlays as leaf children of <Tldraw>, never inside the components memo", () => {
    // AF2.1 T2: "<Tldraw" alone also matches the "<Tldraw onMount> seam" comment above the real element — anchor on
    // the newline that follows the real opening tag (its props start on the next line) so the slice starts there.
    const tldraw = editor.slice(editor.indexOf("<Tldraw\n"), editor.indexOf("</Tldraw>"));
    expect(tldraw).toContain("shapeUtils={shapeUtils}");
    expect(tldraw).toContain("onMount={handleTldrawMount}");
    expect(tldraw).toContain("{grammarV2 && <PpmCanvasStyleToolbar canEdit={effectiveCanEdit} />}");
    expect(tldraw).toContain("{grammarV2 && <PpmCanvasQuickConnect authorId={authorId} canEdit={effectiveCanEdit} />}");
    const memo = editor.slice(
      editor.indexOf("const components = useMemo<TLComponents>("),
      editor.indexOf("const projectionContext = useMemo(")
    );
    expect(memo).not.toContain("PpmCanvasStyleToolbar");
    expect(memo).not.toContain("PpmCanvasQuickConnect");
    expect(editor).toContain("const shapeUtils = useMemo(() => getPpmCanvasShapeUtils(grammarV2), [grammarV2]);");
    // The onMount seam belongs to line B (plan-B B4 fills it with the paste/drop/⌘U registration).
    expect(editor).toMatch(/const handleTldrawMount = useCallback\(/);
  });

  it("marks balanced R and B blocks in editor.tsx", () => {
    for (const [lane, minimum] of [
      ["R", 4],
      ["B", 3],
    ] as const) {
      const opened = editor.split(`── AF2.1 ${lane}:`).length - 1;
      const closed = editor.split(`── /AF2.1 ${lane} ──`).length - 1;
      expect(opened, lane).toBeGreaterThanOrEqual(minimum);
      expect(closed, lane).toBe(opened);
    }
  });

  it("imports the lines' stylesheets after canvas-v2.css", () => {
    const order = [
      'import "./canvas.css";',
      'import "./canvas-v2.css";',
      'import "./canvas-toolkit.css";',
      'import "./canvas-content.css";',
    ].map((line) => editor.indexOf(line));
    expect(order[0]).toBeGreaterThan(0);
    for (let index = 1; index < order.length; index++) expect(order[index]).toBeGreaterThan(order[index - 1]);
  });

  it("keeps the lines' stylesheets v2-only", () => {
    for (const name of ["canvas-toolkit.css", "canvas-content.css"]) {
      const flat = read(name)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ");
      const selectors = [...flat.matchAll(/([^{}]+)\{/g)]
        .map((match) => match[1].trim())
        .filter((prelude) => !prelude.startsWith("@"))
        .flatMap((prelude) => prelude.split(",").map((selector) => selector.trim()));
      for (const selector of selectors)
        expect(selector, `${name}: ${selector}`).toMatch(/^:where\(html\[data-ppm-design="v2"\]\)/);
    }
  });

  it("uses the UX1.1 checklist and table in v1 (the checklist toggle is the clicks fix)", () => {
    expect(shape).toMatch(/grammarV2 \? \(\s*<ChecklistEditor [^>]*\/>\s*\) : \(\s*<ChecklistEditorV1 /);
    expect(shape).toMatch(/grammarV2 \? \(\s*<TableEditor [^>]*\/>\s*\) : \(\s*<TableEditorV1 /);
    const checklist = functionSource(shape, "ChecklistEditorV1");
    expect(checklist).toContain("<label key={item.id}>");
    expect(checklist).toContain('role="checkbox"');
    expect(checklist).toContain("runCanvasPointerAction(");
    const table = functionSource(shape, "TableEditorV1");
    expect(table).not.toContain("canvas.table_remove_row");
    expect(table).not.toContain("onTableCellKeyDown");
  });

  it("returns canvas.css to UX1.1 for v1 and keeps the clicks fix", () => {
    expect(ruleBody(css, ".ppm-canvas-node")).toContain("pointer-events: auto;");
    expect(ruleBody(css, ".ppm-canvas-workspace[data-rail-expanded]")).toContain("--ppm-canvas-rail-width: 13.375rem;");
    const brand = ruleBody(css, ".ppm-canvas-rail__brand") ?? "";
    expect(brand).toContain("padding: 0 0.25rem;");
    expect(brand).not.toContain("position: sticky");
    const picker = ruleBody(css, ".ppm-work-item-picker") ?? "";
    for (const declaration of ["bottom: 4.25rem;", "left: 50%;", "transform: translateX(-50%);"])
      expect(picker).toContain(declaration);
    expect(picker).not.toContain("right: 0.75rem");
    expect(ruleBody(css, ".ppm-work-item-picker--panel")).toContain("right: 0.75rem;");
    expect(css).toContain("@media (max-width: 980px)");
    expect(css).not.toContain("@media (max-width: 1279px)");
    expect(css).not.toContain(".ppm-canvas-shape-menu");
    expect(css).not.toContain(".ppm-canvas-rail-tooltip");
    expect(ruleBody(css, ".ppm-canvas-checklist > label")).toBeDefined();
    // The UX1.1 table rules stay; the second agent's table rules apply only under the v2 grammar.
    for (const body of ruleBodies(css, ".ppm-canvas-table th")) expect(body).not.toContain("white-space: nowrap");
    expect(ruleBody(css, '[data-ppm-canvas-grammar="v2"] .ppm-canvas-table th')).toContain("white-space: nowrap;");
  });
});
