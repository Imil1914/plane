// UX0.2 Task 14 + UX1.1 F3: guard against sub-11px text creeping back into PPM screens. text-9/text-10 (9px/10px)
// and inline text-[Npx] below 11px are banned in ppm-* components; every font-size in canvas.css and in the F-owned
// v2 stylesheets (apps/web/styles/ppm-v2/system.css, shell.css) — rem, px or a var() fallback — must be >= 11px.
// tasks.css (lane T) and canvas-v2.css (lane C) are covered by the lanes' own guards.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../core/components/", import.meta.url).pathname;
const STYLES = new URL("../../styles/ppm-v2/", import.meta.url).pathname;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

const tooSmall = (css: string) =>
  [...css.matchAll(/font-size:\s*(?:var\([^,()]+,\s*)?([\d.]+)(rem|px)/g)]
    .filter(([, value, unit]) => (unit === "px" ? Number(value) < 11 : Number(value) < 0.6875))
    .map((match) => match[0]);

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

    const stylesheets = [join(ROOT, "ppm-canvas/canvas.css"), join(STYLES, "system.css"), join(STYLES, "shell.css")];
    expect(stylesheets.flatMap((f) => tooSmall(readFileSync(f, "utf8")).map((m) => `${f}: ${m}`))).toEqual([]);
  });
});
