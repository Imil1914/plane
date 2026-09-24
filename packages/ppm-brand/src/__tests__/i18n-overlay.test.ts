import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PPM_TRANSLATIONS } from "../index";
import overlay from "../locales/i18n-overlay.json";

const LOCALE_DIR = (lng: string) => new URL(`../../../i18n/src/locales/${lng}/`, import.meta.url);
const ALLOW = new Set([
  "work-item-type:formula.circular_reference",
  "empty-state:workspace_empty_state.dashboard.description",
]);
// Upstream Plane terms that the PPM Russian vocabulary replaces (задачи, спринты, направления, фильтры задач).
const BANNED_RU_TERMS = [/рабоч\p{L}*\s+элемент/iu, /(?<!\p{L})цикл(?!ическ)/iu, /(?<!\p{L})модул/iu, /представлени/iu];
const BANNED = [...BANNED_RU_TERMS, /(?<!\p{L})Plane(?!\p{L})/u];
// Power-K command titles for PPM-only project sections (Canvas/Vault/Code) that have no
// upstream Plane equivalent, so they cannot "override" an existing string. Both the ru and
// en overlays must define every one of these, and neither may shadow a real upstream key.
const NEW_KEYS = new Set([
  "power-k:power_k.navigation_actions.nav_project_canvas",
  "power-k:power_k.navigation_actions.nav_project_knowledge",
  "power-k:power_k.navigation_actions.nav_project_code",
]);

type Tree = { [k: string]: string | Tree };
const flatten = (tree: Tree, prefix = ""): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return Object.assign(acc, typeof v === "string" ? { [key]: v } : flatten(v, key));
  }, {});
const placeholders = (s: string) => (s.match(/\{\s*[\w.]+/g) ?? []).map((p) => p.replace(/[{\s]/g, "")).sort();
const balanced = (s: string) =>
  [...s].reduce((d, c) => (d < 0 ? d : c === "{" ? d + 1 : c === "}" ? d - 1 : d), 0) === 0;

const upstreamFor = (lng: string): Record<string, Record<string, string>> =>
  Object.fromEntries(
    readdirSync(LOCALE_DIR(lng))
      .filter((f) => f.endsWith(".json"))
      .map((f) => [f.replace(/\.json$/, ""), flatten(JSON.parse(readFileSync(new URL(f, LOCALE_DIR(lng)), "utf8")))])
  );
const upstreamRu = upstreamFor("ru");
const upstreamEn = upstreamFor("en");
const overlayLocales = overlay as Record<string, Record<string, Tree>>;
const ru = overlayLocales.ru ?? {};
const en = overlayLocales.en ?? {};
const flatIds = (tree: Record<string, Tree>) =>
  new Set(Object.entries(tree).flatMap(([ns, sub]) => Object.keys(flatten(sub)).map((key) => `${ns}:${key}`)));

describe("PPM RU overlay", () => {
  it("only overrides existing upstream string keys, or defines an allow-listed new PPM key, keeping placeholders and ICU balanced", () => {
    for (const [ns, tree] of Object.entries(ru)) {
      for (const [key, value] of Object.entries(flatten(tree))) {
        const id = `${ns}:${key}`;
        const base = upstreamRu[ns]?.[key];
        if (NEW_KEYS.has(id)) {
          expect(base, `${id} is allow-listed as new and must not shadow an existing upstream key`).toBeUndefined();
          expect(balanced(value), `${id} braces`).toBe(true);
          continue;
        }
        expect(typeof base, `${id} must exist upstream`).toBe("string");
        expect(placeholders(value), `${id} placeholders`).toEqual(placeholders(base!));
        expect(balanced(value), `${id} braces`).toBe(true);
      }
    }
  });
  it("leaves no banned terms in the effective Russian UI", () => {
    const offenders: string[] = [];
    for (const [ns, keys] of Object.entries(upstreamRu)) {
      const over = ru[ns] ? flatten(ru[ns]) : {};
      for (const [key, base] of Object.entries(keys)) {
        const value = over[key] ?? base;
        if (!ALLOW.has(`${ns}:${key}`) && BANNED.some((re) => re.test(value)))
          offenders.push(`${ns}:${key} = ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("leaves no banned terms in the PPM-owned Russian strings (PPM_TRANSLATIONS.ru)", () => {
    const offenders = Object.entries(PPM_TRANSLATIONS.ru)
      .filter(([, value]) => BANNED_RU_TERMS.some((re) => re.test(value)))
      .map(([key, value]) => `${key} = ${value}`);
    expect(offenders).toEqual([]);
  });
  it("only adds allow-listed new PPM keys to the English overlay, never shadowing an upstream string", () => {
    for (const [ns, tree] of Object.entries(en)) {
      for (const [key, value] of Object.entries(flatten(tree))) {
        const id = `${ns}:${key}`;
        expect(NEW_KEYS.has(id), `${id} is not allow-listed as a new PPM-only key`).toBe(true);
        expect(upstreamEn[ns]?.[key], `${id} must not shadow an existing upstream key`).toBeUndefined();
        expect(balanced(value), `${id} braces`).toBe(true);
      }
    }
  });
  it("defines every allow-listed new PPM key in both the ru and en overlays", () => {
    const ruIds = flatIds(ru);
    const enIds = flatIds(en);
    for (const id of NEW_KEYS) {
      expect(ruIds.has(id), `${id} missing from ru overlay`).toBe(true);
      expect(enIds.has(id), `${id} missing from en overlay`).toBe(true);
    }
  });
});
