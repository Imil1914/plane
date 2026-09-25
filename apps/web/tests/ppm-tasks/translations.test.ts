// UX1.1 T: every tasks.* key used by lane T exists in both locales, en/ru parity, no banned RU terms.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PPM_TRANSLATIONS } from "@ppm/brand";
import { describe, expect, it } from "vitest";

const en = PPM_TRANSLATIONS.en as Record<string, string>;
const ru = PPM_TRANSLATIONS.ru as Record<string, string>;
const taskKeys = (dict: Record<string, string>) =>
  Object.keys(dict)
    .filter((key) => key.startsWith("tasks."))
    .sort();
const CORE = new URL("../../core/components/", import.meta.url).pathname;
const APP = new URL("../../app/", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
    : [];
const FILES = [
  ...walk(join(CORE, "ppm-tasks")),
  join(CORE, "issues/issue-layouts/list/block.tsx"),
  join(CORE, "issues/issue-layouts/list/list-group.tsx"),
  join(CORE, "issues/issue-layouts/list/headers/group-by-card.tsx"),
  join(CORE, "issues/header.tsx"),
  join(APP, "(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/issues/(list)/layout.tsx"),
].filter((file) => /\.(ts|tsx)$/.test(file));
const BANNED = [
  /рабоч\p{L}*\s+элемент/iu,
  /(?<!\p{L})цикл(?!ическ)/iu,
  /(?<!\p{L})модул/iu,
  /представлени/iu,
  /(?<!\p{L})ИИ(?!\p{L})/u,
  /Plane/u,
];

describe("tasks.* translations", () => {
  it("defines the same tasks.* keys in en and ru", () => {
    expect(taskKeys(en).length).toBeGreaterThan(40);
    expect(taskKeys(ru)).toEqual(taskKeys(en));
  });
  it("defines every tasks.* key referenced by lane T", () => {
    const used = new Set(
      FILES.flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/["'`](tasks\.[a-z0-9_.]+)["'`]/g)].map((m) => m[1])
      )
    );
    expect([...used].filter((key) => !(key in en) || !(key in ru))).toEqual([]);
  });
  it("keeps banned terms out of the Russian strings", () => {
    expect(taskKeys(ru).filter((key) => BANNED.some((re) => re.test(ru[key])))).toEqual([]);
  });
});
