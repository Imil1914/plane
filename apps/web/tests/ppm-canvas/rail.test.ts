import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANVAS_RAIL_COLLAPSE_QUERY } from "@/components/ppm-canvas/board-workspace-state";

describe("canvas rail", () => {
  it("uses the 1280px breakpoint for the expanded rail overlay", () => {
    expect(CANVAS_RAIL_COLLAPSE_QUERY).toBe("(max-width: 1279px)");
  });

  it("keeps rail, board-panel and footer captions at or above the readable font-size floor", () => {
    const css = readFileSync(new URL("../../core/components/ppm-canvas/canvas.css", import.meta.url), "utf8");
    for (const sel of [
      ".ppm-canvas-rail__label",
      ".ppm-canvas-board-panel__list > small",
      ".ppm-canvas-workspace__status",
    ]) {
      const block = css.slice(css.indexOf(sel + " {"), css.indexOf("}", css.indexOf(sel + " {")));
      const size = Number(/font-size:\s*([\d.]+)rem/.exec(block)?.[1] ?? "1");
      expect(size, sel).toBeGreaterThanOrEqual(0.6875);
    }
  });
});
