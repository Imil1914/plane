// AF2.1 R1: the grouped floating rail is v2-only, runs real e.code tools and keeps semantic links for readers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCanvasCommandAllowedReadOnly } from "@/components/ppm-canvas/board-workspace-state";
import { PPM_CANVAS_COMMANDS } from "@/components/ppm-canvas/commands";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const rail = read("canvas-rail.tsx");
const workspace = read("workspace.tsx");
const editor = read("editor.tsx");
// Formatting-proof source checks: oxfmt may wrap calls/objects and add trailing commas.
const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

describe("AF2.1 R1 rail", () => {
  it("declares the rail commands and lets readers open search, tasks, board panel and semantic links", () => {
    for (const command of ["draw-geo", "open-find", "open-board-panel"]) expect(PPM_CANVAS_COMMANDS).toContain(command);
    for (const command of ["open-find", "open-board-panel", "open-semantic-edges", "select-hand"]) {
      expect(isCanvasCommandAllowedReadOnly(command, true), command).toBe(true);
      expect(isCanvasCommandAllowedReadOnly(command, false), command).toBe(false);
    }
  });

  it("renders four menus with titled flyouts and one-line hints", () => {
    has(rail, 'aria-haspopup="menu"');
    has(rail, 'role="menuitem"');
    for (const menu of ['trigger("shapes"', 'trigger("docs"', 'trigger("project"', 'trigger("more")']) has(rail, menu);
    has(rail, "visibleRailMenuItems(definition, editReady)");
    // UXR (2026-09-26): the hover/focus tooltip (name + real keys) replaced the native title «{label} — {keys}», and
    // «Смысловые связи» left the rail — the list is a section of «Доска» (uxr-canvas-panel.test.ts).
    has(rail, "hint={{ text: tipKey ? ppmT(tipKey) : label, keys: railKeysLabel(command, apple) }}");
    expect(rail).not.toContain('tool("open-semantic-edges"');
  });

  it("takes V/H/S/T/P by e.code only under v2, outside inputs", () => {
    has(workspace, "const toolCommand = designV2 ? railShortcutCommand(event) : undefined;");
    expect(workspace.indexOf("railShortcutCommand(event)")).toBeGreaterThan(workspace.indexOf("if (typing ||"));
    expect(workspace).toMatch(/<PpmCanvasRail\s+\{\.\.\.railProps\}\s+onDrawGeo=/);
  });

  it("closes the flyout when focus leaves its root, and routes «Найти» through the shared gateway", () => {
    has(rail, "onBlur={onRootBlur}");
    has(rail, "if (!openMenu) return;");
    // Final-fix round 2, C-1: the WebKit-safe decision (null relatedTarget is not "left") is the pure, unit-tested
    // isRailFocusLeavingRoot (toolkit-model.test.ts), not inlined here — canvas-rail.tsx only narrows the DOM type.
    has(rail, "isRailFocusLeavingRoot(next instanceof Node ? next : null, rootRef.current)");
    // "open-find" no longer bypasses onRunCommand with a separate onFind prop — it falls through like every other
    // item, and workspace.tsx's runCanvasCommand (the one gateway rail/palette/shortcuts all call) now handles it.
    expect(rail).not.toContain("onFind");
    expect(rail).not.toContain('item.command === "open-find"');
    has(workspace, 'if (command === "open-find") {');
    has(workspace, "setBrainPanelOpen(true);");
    // m-4: open-find is not board-bound — its check must run before the activeBoardId gate, not after.
    expect(workspace.indexOf('command === "open-find"')).toBeLessThan(workspace.indexOf("if (!activeBoardId) return;"));
  });

  it("M-2: the v2 command palette offers the rail's creation commands and a single «Добавить документ»", () => {
    // New v2-only creation commands (sticker, list, PPM document, Vault file) — additive, alongside the always-shown
    // note/table/code that the palette already offered under both designs.
    for (const command of [
      '"add-sticky" as const',
      '"add-list" as const',
      '"add-page-ref" as const',
      '"add-file" as const',
    ])
      has(workspace, `command: ${command}`);
    // Under v2 the one visible "Добавить документ" item now creates a page in «Документы» (add-document-page, same
    // object as the rail's «Документ»), not the board's own Markdown `document` node; v1 still creates that node.
    has(workspace, 'designV2 ? { command: "add-document-page" as const');
    has(workspace, ': { command: "add-document" as const');
    // Coordinator follow-up: add-checklist and add-list both create the identical checklist node — only one of the
    // two is ever offered per design (a ternary, not an unconditional item plus a v2-only addition), so v2 shows
    // just "Список" and v1 shows just "Добавить чек-лист", never both at once.
    has(workspace, 'designV2 ? { command: "add-list" as const');
    has(workspace, ': { command: "add-checklist" as const');
  });

  it("handles the rail commands inside the R block of the editor", () => {
    const block = editor.slice(
      editor.indexOf("// ── AF2.1 R: tool commands"),
      editor.indexOf("// ── /AF2.1 R ──", editor.indexOf("// ── AF2.1 R: tool commands"))
    );
    for (const needle of [
      'case "select-hand":',
      'editor.setCurrentTool("hand")',
      'case "draw-geo":',
      "GeoShapeGeoStyle, detail.geo",
      'case "open-board-panel":',
    ])
      has(block, needle);
  });
});
