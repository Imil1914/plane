// UX1.1 T: text >= 11px on Tasks v2 surfaces, compact density covered, curator visibility left to Tailwind.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../core/components/ppm-tasks/", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const css = readFileSync(new URL("../../styles/ppm-v2/tasks.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
const ruleBody = (selectorEnd: string) =>
  [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].find((m) => m[1].trim().endsWith(selectorEnd))?.[2] ?? "";

describe("Tasks v2 guards", () => {
  it("uses no text below 11px in ppm-tasks components", () => {
    const bad = files(ROOT)
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => [f, i + 1, line] as const)
      )
      .filter(([, , line]) => /\btext-(9|10)\b|text-\[(?:[0-9]|10)px\]/.test(line));
    expect(bad.map(([f, n]) => `${f}:${n}`)).toEqual([]);
  });

  it("keeps every tasks.css font size at 11px or larger", () => {
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)(rem|px)/g)].map((m) =>
      m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1])
    );
    expect(sizes.filter((px) => px < 11)).toEqual([]);
  });

  it("leaves curator visibility to hidden/min-[1440px]:flex", () => {
    expect(ruleBody(".ppm-curator")).not.toMatch(/display\s*:/);
  });

  it("styles the compact density", () => {
    expect(css).toContain(':where(html[data-ppm-design="v2"][data-ppm-density="compact"]) .ppm-sprint');
    expect(css).toContain(':where(html[data-ppm-design="v2"][data-ppm-density="compact"]) .ppm-curator__item');
    expect(ruleBody(".ppm-task-quick-add")).toMatch(/min-height:\s*var\(--ppm-row-height,/);
  });
});
