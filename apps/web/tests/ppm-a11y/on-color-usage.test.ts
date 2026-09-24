// UX0.2 Task 2: dark ink (--txt-on-color) belongs only on accent fills; everywhere else on-color
// consumers must use --txt-on-accent (accent/success/warning fills) so the restored light
// --txt-on-color still reads on danger fills and dark overlays.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("on-color usage", () => {
  it("keeps dark ink only on accent fills in canvas.css", () => {
    const css = read("../../core/components/ppm-canvas/canvas.css");
    const offenders = css
      .split("}")
      .filter(
        (rule) => /background[^;]*var\(--bg-accent-primary/.test(rule) && /color:\s*var\(--txt-on-color\)/.test(rule)
      );
    expect(offenders).toEqual([]);
  });

  it("uses on-accent for primary and on-color for danger buttons", () => {
    // cva keys and their class-string values sit on separate lines here, so \s* (not [^\n]*)
    // bridges the key:value gap while still scoping the match to one variant's string.
    const helper = read("../../../../packages/propel/src/button/helper.tsx");
    expect(helper).toMatch(/\bprimary:\s*"[^"]*text-on-accent/);
    expect(helper).toMatch(/"error-fill":\s*"[^"]*text-on-color/);
  });
});
