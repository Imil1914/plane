// UX1.1 F4: the three UX1.1 translation modules (F: system, T: tasks, C: canvas) stay in en/ru parity, keep their
// lane prefix, never overlap and reach PPM_TRANSLATIONS unchanged.
import { describe, expect, it } from "vitest";
import { getPpmTranslation, PPM_TRANSLATIONS } from "../index";
import type { TPpmTranslationKey } from "../index";
import { UX11_CANVAS_TRANSLATIONS } from "../translations/ux11-canvas";
import { UX11_SYSTEM_TRANSLATIONS } from "../translations/ux11-system";
import { UX11_TASKS_TRANSLATIONS } from "../translations/ux11-tasks";

type TModule = { en: Record<string, string>; ru: Record<string, string> };
const MODULES: Array<[string, TModule, RegExp]> = [
  ["system", UX11_SYSTEM_TRANSLATIONS, /^(ux|density)\./],
  ["tasks", UX11_TASKS_TRANSLATIONS, /^tasks\./],
  ["canvas", UX11_CANVAS_TRANSLATIONS, /^canvas\./],
];

describe("UX1.1 translation modules", () => {
  it("en and ru carry the same keys in every module", () => {
    for (const [name, mod] of MODULES)
      expect(Object.keys(mod.ru).toSorted(), name).toEqual(Object.keys(mod.en).toSorted());
  });

  it("every key carries its lane prefix", () => {
    for (const [name, mod, prefix] of MODULES)
      for (const key of Object.keys(mod.en)) expect(prefix.test(key), `${name}: ${key}`).toBe(true);
  });

  it("modules never share a key", () => {
    const all = MODULES.flatMap(([, mod]) => Object.keys(mod.en));
    expect(new Set(all).size).toBe(all.length);
  });

  it("every module string reaches PPM_TRANSLATIONS unchanged in both locales", () => {
    for (const [, mod] of MODULES)
      for (const locale of ["en", "ru"] as const)
        for (const [key, value] of Object.entries(mod[locale]))
          expect((PPM_TRANSLATIONS[locale] as Record<string, string>)[key], `${locale}:${key}`).toBe(value);
  });

  it("never says «ИИ»/AI in the 1.0 UI", () => {
    for (const [name, mod] of MODULES) {
      for (const value of Object.values(mod.ru)) expect(value, name).not.toMatch(/(?<!\p{L})ИИ(?!\p{L})/u);
      for (const value of Object.values(mod.en)) expect(value, name).not.toMatch(/\bAI\b/);
    }
  });

  it("one status reads the same as a state name (ux.state.*) and as a state-group header (tasks.group.state_*)", () => {
    for (const locale of ["en", "ru"] as const)
      for (const group of ["backlog", "unstarted", "started", "completed", "cancelled"])
        expect(
          getPpmTranslation(locale, `tasks.group.state_${group}` as TPpmTranslationKey),
          `${locale}: ${group}`
        ).toBe(getPpmTranslation(locale, `ux.state.${group}` as TPpmTranslationKey));
    expect(getPpmTranslation("ru", "tasks.group.state_unstarted")).toBe("К работе");
  });

  it("a missing assignee reads the same in list groups and in the curator column", () => {
    for (const locale of ["en", "ru"] as const)
      expect(getPpmTranslation(locale, "tasks.group.no_assignee"), locale).toBe(
        getPpmTranslation(locale, "tasks.curator.unassigned")
      );
    // Both stand where one assignee's name would be (group header per member; the row's assignee), as in H-Tasks.
    expect(getPpmTranslation("ru", "tasks.curator.unassigned")).toBe("Не назначен");
  });

  it("publishes the system strings used by the profile and the sidebar", () => {
    expect(getPpmTranslation("ru", "density.label")).toBe("Плотность");
    expect(getPpmTranslation("ru", "density.comfortable")).toBe("Удобная");
    expect(getPpmTranslation("ru", "density.compact")).toBe("Компактная");
    expect(getPpmTranslation("en", "density.label")).toBe("Density");
    expect(getPpmTranslation("ru", "ux.nav.section_work")).toBe("Работа");
    expect(getPpmTranslation("ru", "ux.nav.section_knowledge")).toBe("Знания");
    expect(getPpmTranslation("ru", "ux.state.started")).toBe("В работе");
    expect(getPpmTranslation("en", "ux.state.started")).toBe("In Progress");
  });
});
