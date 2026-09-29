import { describe, expect, it } from "vitest";
import { PPM_TRANSLATIONS } from "../index";
import overlay from "../locales/i18n-overlay.json";
import { AF21_CANVAS_TRANSLATIONS } from "../translations/af21-canvas";
import { AF22_LIVING_MAP_TRANSLATIONS } from "../translations/af22-living-map";
import { G21_CANVAS_ASSIGNEES_TRANSLATIONS } from "../translations/g21-canvas-assignees";
import { R_RU_UI_TRANSLATIONS } from "../translations/r-ru-ui";
import { R2_RU_UI_TRANSLATIONS } from "../translations/r2-ru-ui";
import { S_LIVE_STATS_TRANSLATIONS } from "../translations/s-live-stats";
import { UX11_CANVAS_TRANSLATIONS } from "../translations/ux11-canvas";
import { UX11_SYSTEM_TRANSLATIONS } from "../translations/ux11-system";
import { UX11_TASKS_TRANSLATIONS } from "../translations/ux11-tasks";

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

// Line R2: notifications, intake, workspace settings, the editor and the support contact — one module of `ui.*` keys.
describe("R2 dictionary", () => {
  const en = R2_RU_UI_TRANSLATIONS.en as Record<string, string>;
  const ru = R2_RU_UI_TRANSLATIONS.ru as Record<string, string>;

  it("has the same keys and placeholders in both languages, Russian in ru", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]));
      expect(ru[key], key).toMatch(/[А-Яа-яЁё]/);
      expect(en[key], key).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it("uses its own key prefixes: no key of another module is overwritten", () => {
    const own = /^ui\.(notification|intake|ws|webhook|token|export|support|editor)\./;
    for (const key of Object.keys(en)) expect(key, key).toMatch(own);
    const others = [
      R_RU_UI_TRANSLATIONS,
      S_LIVE_STATS_TRANSLATIONS,
      G21_CANVAS_ASSIGNEES_TRANSLATIONS,
      UX11_SYSTEM_TRANSLATIONS,
      UX11_TASKS_TRANSLATIONS,
      UX11_CANVAS_TRANSLATIONS,
      AF21_CANVAS_TRANSLATIONS,
      AF22_LIVING_MAP_TRANSLATIONS,
    ].flatMap((module) => Object.keys(module.en));
    expect(Object.keys(en).filter((key) => others.includes(key))).toEqual([]);
  });

  it("reaches PPM_TRANSLATIONS unchanged", () => {
    for (const locale of ["en", "ru"] as const)
      for (const [key, value] of Object.entries(R2_RU_UI_TRANSLATIONS[locale]))
        expect((PPM_TRANSLATIONS[locale] as Record<string, string>)[key], `${locale}:${key}`).toBe(value);
  });

  it("keeps one form inside a list and distinct texts for distinct controls (round 1 wording)", () => {
    // Intake statuses in the filter and the chips: short participles agreeing with «заявка».
    const statuses = (overlay as { ru: { inbox: { inbox_issue: { status: Record<string, { title: string }> } } } }).ru
      .inbox.inbox_issue.status;
    expect(["pending", "declined", "snoozed", "accepted", "duplicate"].map((key) => statuses[key].title)).toEqual([
      "Не рассмотрена",
      "Отклонена",
      "Отложена",
      "Принята",
      "Отмечена как дубликат",
    ]);
    // Menu «/»: every description is a short noun phrase with a period, none an instruction («Вставить таблицу.»).
    const slashDescriptions = [
      "slash_text",
      "slash_h1",
      "slash_h2",
      "slash_small_heading",
      "slash_numbered",
      "slash_bulleted",
      "slash_todo",
      "slash_table",
      "slash_quote",
      "slash_code",
      "slash_callout",
      "slash_divider",
      "slash_emoji",
      "slash_image",
      "change_text_color",
      "change_background_color",
    ].map((key) => ru[`ui.editor.${key}`]);
    for (const value of slashDescriptions) {
      expect(value).toMatch(/\.$/);
      expect(value).not.toMatch(/^\p{Lu}\p{Ll}*(?:ть|ти)(?!\p{L})/u);
    }
    // Headers over a set of swatches are plural; the control itself stays singular.
    expect([ru["ui.editor.colors"], ru["ui.editor.text_colors"], ru["ui.editor.background_colors"]]).toEqual([
      "Цвета текста",
      "Цвета текста",
      "Цвета фона",
    ]);
    expect(ru["ui.editor.background_color"]).toBe("Цвет фона");
    // The API token expiry: the option in the list and the button after choosing it are different texts.
    expect(ru["ui.token.custom"]).not.toBe(ru["ui.token.custom_date"]);
    // Intake filters: the request's own status and the task's state are named apart.
    expect([ru["ui.intake.status_chip"], ru["ui.intake.state"]]).toEqual(["Статус заявки", "Статус задачи"]);
  });

  it("names intake «заявка», sprints and directions in the PPM vocabulary, and never Plane's support", () => {
    expect(ru["ui.intake.open"]).toBe("Открыть заявку");
    expect(ru["ui.webhook.event_cycles"]).toBe("Спринты");
    expect(ru["ui.webhook.event_modules"]).toBe("Направления");
    for (const value of Object.values(ru)) expect(value).not.toMatch(/Plane|support@|рабоч\p{L}* элемент/iu);
  });
});
