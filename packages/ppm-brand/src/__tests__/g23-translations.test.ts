import { describe, expect, it } from "vitest";
import { PPM_TRANSLATIONS } from "../index";
import { AF21_CANVAS_TRANSLATIONS } from "../translations/af21-canvas";
import { AF22_LIVING_MAP_TRANSLATIONS } from "../translations/af22-living-map";
import { G21_CANVAS_ASSIGNEES_TRANSLATIONS } from "../translations/g21-canvas-assignees";
import { G22_SSO_TRANSLATIONS } from "../translations/g22-sso";
import { R_RU_UI_TRANSLATIONS } from "../translations/r-ru-ui";
import { R2_RU_UI_TRANSLATIONS } from "../translations/r2-ru-ui";
import { S_LIVE_STATS_TRANSLATIONS } from "../translations/s-live-stats";
import { UX11_CANVAS_TRANSLATIONS } from "../translations/ux11-canvas";
import { UX11_SYSTEM_TRANSLATIONS } from "../translations/ux11-system";
import { UX11_TASKS_TRANSLATIONS } from "../translations/ux11-tasks";
import { G23_REPORTS_TRANSLATIONS } from "../translations/g23-reports";

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

// G2.3 (line G-Web): «Вставить коммит/PR» and «Что сделано за период» dialog chrome. Two keys are the deliberate
// exception to the module's own `g23.*` prefix: `ui.editor.git_object`/`ui.editor.slash_git_object`, read by the
// "/" slash item inside `@plane/editor` through `editorText`/`resolvePpmEditorText` (same dictionary as everything
// else here, no second word list) — apps/web/tests/ppm-shell/r2-editor-text.test.tsx scans every `editorText(...)`
// call in that package and requires exactly the package-wide `ui.editor.*`/`ui.editor.slash_*` prefix (e.g.
// `ui.editor.text`/`ui.editor.slash_text`), so these two cannot use `g23.*` like the rest of this module.
// New PPM-only UI, no upstream string to translate — plain `ppmT`/`usePpmTranslation`, like g22.
describe("G23 dictionary", () => {
  const en = G23_REPORTS_TRANSLATIONS.en as Record<string, string>;
  const ru = G23_REPORTS_TRANSLATIONS.ru as Record<string, string>;

  // "PR" is used as-is in Russian too (already the case elsewhere in ppm-git, e.g. route.tsx's own «PR» rows).
  const ABBREVIATION_ONLY_KEYS = new Set(["g23.insert.filter_pull_request", "g23.summary.totals_pull_requests"]);
  const EDITOR_SHARED_KEYS = new Set(["ui.editor.git_object", "ui.editor.slash_git_object"]);

  it("has the same keys and placeholders in both languages, Russian in ru, neutral English in en", () => {
    expect(Object.keys(ru).toSorted()).toEqual(Object.keys(en).toSorted());
    expect(Object.keys(en).length).toBeGreaterThan(0);
    for (const key of Object.keys(en)) {
      expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]));
      if (!ABBREVIATION_ONLY_KEYS.has(key)) expect(ru[key], key).toMatch(/[А-Яа-яЁё]/);
      expect(en[key], key).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it("uses its own key prefix (g23.insert/summary), except the two ui.editor.* keys shared with @plane/editor", () => {
    const own = /^g23\.(insert|summary)\./;
    for (const key of Object.keys(en)) {
      if (EDITOR_SHARED_KEYS.has(key)) continue;
      expect(key, key).toMatch(own);
    }
    const others = new Set(
      [
        R_RU_UI_TRANSLATIONS,
        R2_RU_UI_TRANSLATIONS,
        S_LIVE_STATS_TRANSLATIONS,
        G21_CANVAS_ASSIGNEES_TRANSLATIONS,
        G22_SSO_TRANSLATIONS,
        UX11_SYSTEM_TRANSLATIONS,
        UX11_TASKS_TRANSLATIONS,
        UX11_CANVAS_TRANSLATIONS,
        AF21_CANVAS_TRANSLATIONS,
        AF22_LIVING_MAP_TRANSLATIONS,
      ].flatMap((module) => Object.keys(module.en))
    );
    expect(Object.keys(en).filter((key) => others.has(key))).toEqual([]);
  });

  it("reaches PPM_TRANSLATIONS unchanged, before the AF2.1/AF2.2 spreads that must stay last", () => {
    for (const locale of ["en", "ru"] as const)
      for (const [key, value] of Object.entries(G23_REPORTS_TRANSLATIONS[locale]))
        expect((PPM_TRANSLATIONS[locale] as Record<string, string>)[key], `${locale}:${key}`).toBe(value);
  });

  it("gives the pages '/' item the same Russian text as the plan (G3): «Коммит или PR»", () => {
    expect(ru["ui.editor.git_object"]).toBe("Коммит или PR");
  });

  it("never names Plane or leaks a secret-sounding word", () => {
    for (const value of [...Object.values(ru), ...Object.values(en)]) {
      expect(value).not.toMatch(/Plane|support@/i);
      expect(value).not.toMatch(/secret|token value|private key/i);
    }
  });
});
