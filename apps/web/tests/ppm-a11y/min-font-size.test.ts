// UX0.2 Task 14: guard against sub-11px text creeping back into PPM screens. text-9/text-10
// (9px/10px) and inline text-[Npx] below 11px are banned in ppm-* components; canvas.css font-size
// must stay >= 0.6875rem (11px) so canvas node/chrome text stays legible.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../core/components/", import.meta.url).pathname;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe("min font size", () => {
  it("has no text smaller than 11px in PPM screens", () => {
    const tsx = ["ppm-git", "ppm-vault", "ppm-admin", "ppm-shell", "ppm-canvas"]
      .flatMap((d) => files(join(ROOT, d)))
      .filter((f) => f.endsWith(".tsx"));
    const bad = tsx
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((l, i) => [f, i + 1, l] as const)
      )
      .filter(([, , l]) => /\btext-(9|10)\b|text-\[(?:[0-9]|10)px\]/.test(l));
    expect(bad.map(([f, n]) => `${f}:${n}`)).toEqual([]);

    const css = readFileSync(join(ROOT, "ppm-canvas/canvas.css"), "utf8");
    const small = [...css.matchAll(/font-size:\s*([\d.]+)rem/g)].filter((m) => Number(m[1]) < 0.6875);
    expect(small.map((m) => m[0])).toEqual([]);
  });
});
