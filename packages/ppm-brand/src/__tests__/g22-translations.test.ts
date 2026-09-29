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

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

// Line S4 (G2.2): web single sign-on — «Код» hints and the admin center's «Git server» tab, one module of `g22.*`
// keys. No shell gating (`usePpmRu`/`ppmText`, lines R/R2): this is new PPM-only UI, not a translation of an
// existing upstream string, so it uses the plain locale dictionary (`ppmT`/`usePpmTranslation`) like `admin.*`/`code.*`.
describe("G22 dictionary", () => {
  const en = G22_SSO_TRANSLATIONS.en as Record<string, string>;
  const ru = G22_SSO_TRANSLATIONS.ru as Record<string, string>;

  // "g22.admin.git_problem_kind_ppm" is the product's own name, identical in both languages (as it already is in
  // other ru strings, e.g. "Войти через PPM") — the one value with no Cyrillic of its own.
  const NAME_ONLY_KEYS = new Set(["g22.admin.git_problem_kind_ppm"]);

  it("has the same keys and placeholders in both languages, Russian in ru, neutral English in en", () => {
    expect(Object.keys(ru).toSorted()).toEqual(Object.keys(en).toSorted());
    expect(Object.keys(en).length).toBeGreaterThan(0);
    for (const key of Object.keys(en)) {
      expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]));
      if (!NAME_ONLY_KEYS.has(key)) expect(ru[key], key).toMatch(/[А-Яа-яЁё]/);
      expect(en[key], key).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it("uses its own key prefixes: no key of another module is overwritten", () => {
    const own = /^g22\.(code|admin)\./;
    for (const key of Object.keys(en)) expect(key, key).toMatch(own);
    const others = new Set(
      [
        R_RU_UI_TRANSLATIONS,
        R2_RU_UI_TRANSLATIONS,
        S_LIVE_STATS_TRANSLATIONS,
        G21_CANVAS_ASSIGNEES_TRANSLATIONS,
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
      for (const [key, value] of Object.entries(G22_SSO_TRANSLATIONS[locale]))
        expect((PPM_TRANSLATIONS[locale] as Record<string, string>)[key], `${locale}:${key}`).toBe(value);
  });

  it("names the Git server's own sign-in button consistently with the spec wording", () => {
    expect(ru["g22.code.connect_account_required_action"]).toBe("Войти через PPM");
    expect(ru["g22.code.connect_account_required_description"]).toBe(
      "Сначала войдите на Git-сервер кнопкой «Войти через PPM» — здесь появятся ваши репозитории."
    );
    expect(ru["g22.code.sign_in_hint"]).toBe("Войдите на Git-сервер кнопкой «Войти через PPM».");
    expect(ru["g22.code.your_git_username"]).toContain("{username}");
    expect(ru["g22.admin.git_sync_retry_after"]).toContain("{seconds}");
  });

  it("never names Plane or leaks a secret-sounding word", () => {
    for (const value of [...Object.values(ru), ...Object.values(en)]) {
      expect(value).not.toMatch(/Plane|support@/i);
      expect(value).not.toMatch(/secret|token value|private key/i);
    }
  });
});
