import { describe, expect, it } from "vitest";
import { PPM_TRANSLATIONS } from "../index";
import { AF21_CANVAS_TRANSLATIONS } from "../translations/af21-canvas";
import { AF22_LIVING_MAP_TRANSLATIONS } from "../translations/af22-living-map";
import { G21_CANVAS_ASSIGNEES_TRANSLATIONS } from "../translations/g21-canvas-assignees";
import { G22_ADMIN_USERS_TRANSLATIONS } from "../translations/g22-admin-users";
import { G22_SSO_TRANSLATIONS } from "../translations/g22-sso";
import { G23_REPORTS_TRANSLATIONS } from "../translations/g23-reports";
import { R_RU_UI_TRANSLATIONS } from "../translations/r-ru-ui";
import { R2_RU_UI_TRANSLATIONS } from "../translations/r2-ru-ui";
import { S_LIVE_STATS_TRANSLATIONS } from "../translations/s-live-stats";
import { UX11_CANVAS_TRANSLATIONS } from "../translations/ux11-canvas";
import { UX11_SYSTEM_TRANSLATIONS } from "../translations/ux11-system";
import { UX11_TASKS_TRANSLATIONS } from "../translations/ux11-tasks";

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

// Line ADM (G2.2 R15a): «Отключить» / «Включить» a person in the admin center's «Пользователи» tab — new PPM-only UI,
// plain `ppmT`/`usePpmTranslation` like the rest of `g22.*`, own `g22.users.*` keys.
describe("G22 admin users dictionary", () => {
  const en = G22_ADMIN_USERS_TRANSLATIONS.en as Record<string, string>;
  const ru = G22_ADMIN_USERS_TRANSLATIONS.ru as Record<string, string>;

  it("has the same keys and placeholders in both languages, Russian in ru, neutral English in en", () => {
    expect(Object.keys(ru).toSorted()).toEqual(Object.keys(en).toSorted());
    expect(Object.keys(en).length).toBeGreaterThan(0);
    for (const key of Object.keys(en)) {
      expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]));
      expect(ru[key], key).toMatch(/[А-Яа-яЁё]/);
      expect(en[key], key).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it("uses its own g22.users.* prefix: no key of another module is overwritten", () => {
    for (const key of Object.keys(en)) expect(key, key).toMatch(/^g22\.users\./);
    const others = new Set(
      [
        R_RU_UI_TRANSLATIONS,
        R2_RU_UI_TRANSLATIONS,
        S_LIVE_STATS_TRANSLATIONS,
        G21_CANVAS_ASSIGNEES_TRANSLATIONS,
        G22_SSO_TRANSLATIONS,
        G23_REPORTS_TRANSLATIONS,
        UX11_SYSTEM_TRANSLATIONS,
        UX11_TASKS_TRANSLATIONS,
        UX11_CANVAS_TRANSLATIONS,
        AF21_CANVAS_TRANSLATIONS,
        AF22_LIVING_MAP_TRANSLATIONS,
      ].flatMap((module) => Object.keys(module.en))
    );
    expect(Object.keys(en).filter((key) => others.has(key))).toEqual([]);
  });

  it("reaches PPM_TRANSLATIONS unchanged", () => {
    for (const locale of ["en", "ru"] as const)
      for (const [key, value] of Object.entries(G22_ADMIN_USERS_TRANSLATIONS[locale]))
        expect((PPM_TRANSLATIONS[locale] as Record<string, string>)[key], `${locale}:${key}`).toBe(value);
  });

  it("asks exactly the question of the spec before switching a person off", () => {
    expect(ru["g22.users.confirm_suspend_title"]).toBe("Отключить {name}?");
    expect(ru["g22.users.confirm_suspend_description_git"]).toMatch(/^Он не сможет войти в PPM и на Git-сервер/);
    expect(ru["g22.users.status_suspended"]).toBe("Отключён");
    expect(ru["g22.users.suspend"]).toBe("Отключить");
    expect(ru["g22.users.resume"]).toBe("Включить");
  });

  it("names the Git server only in the texts meant for single sign-on (review round 1)", () => {
    for (const dictionary of [ru, en])
      for (const [key, value] of Object.entries(dictionary))
        if (key.includes("_description")) expect(/Git/.test(value), key).toBe(key.endsWith("_git"));
  });

  it("never names Plane or leaks a secret-sounding word", () => {
    for (const value of [...Object.values(ru), ...Object.values(en)]) {
      expect(value).not.toMatch(/Plane|support@/i);
      expect(value).not.toMatch(/secret|token|password|парол/i);
    }
  });
});
