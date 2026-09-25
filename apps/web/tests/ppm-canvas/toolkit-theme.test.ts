// AF2.1 R2: PPM palette for native shapes (v2 only, v1 gets tldraw's palette back), sticker placement, card colours.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freeSpotNear, type TPpmBox } from "@/components/ppm-canvas/canvas-toolkit-model";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const overlap = (a: TPpmBox, b: TPpmBox) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
// Formatting-proof source checks: oxfmt may wrap calls/objects and add trailing commas.
const norm = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

describe("AF2.1 R2 theme", () => {
  it("paints the palette only under v2 and restores tldraw's original otherwise", () => {
    const theme = read("canvas-tldraw-theme.ts");
    has(theme, "structuredClone(DefaultColorThemePalette.lightMode)");
    has(theme, "const source = grammarV2 ? PPM_PALETTE : ORIGINAL_PALETTE;");
    has(theme, 'NoteShapeUtil.configure({ resizeMode: "scale" })');
    has(theme, "FrameShapeUtil.configure({ showColors: true })");
    has(theme, "grammarV2 ? [PpmCanvasNodeShapeUtil, PpmNoteShapeUtil, PpmFrameShapeUtil] : [PpmCanvasNodeShapeUtil]");
  });

  it("creates a sticker you type into right away (S / rail)", () => {
    const actions = read("canvas-toolkit-actions.ts");
    has(actions, 'editor.setCurrentTool("select.editing_shape", { shape, target: "shape" })');
    expect(read("editor.tsx")).toMatch(/case "add-sticky":\s*if \(canEdit\) createPpmSticky\(editor\);/);
  });

  it("places a new sticker at the centre, or next to whatever is there, never on top", () => {
    const size = { w: 200, h: 200 };
    expect(freeSpotNear({ x: 500, y: 300 }, size, [])).toEqual({ x: 400, y: 200, w: 200, h: 200 });
    const occupied: TPpmBox[] = [{ x: 380, y: 180, w: 240, h: 240 }];
    for (let index = 0; index < 5; index++) {
      const spot = freeSpotNear({ x: 500, y: 300 }, size, occupied);
      for (const box of occupied) expect(overlap(spot, box)).toBe(false);
      occupied.push(spot);
    }
  });

  it("colours PPM cards from the palette only under the v2 grammar", () => {
    const css = read("canvas-toolkit.css");
    for (const color of ["neutral", "yellow", "orange", "terracotta", "pink", "violet", "blue", "cyan", "green"])
      expect(css, color).toContain(`[data-ppm-canvas-grammar="v2"] .ppm-canvas-node--${color}`);
    expect(css).toContain("--ppm-palette-pink-fill: #fbdae8;");
  });
});
