// AF2.1 F1: the canvas-toolkit strings (palette, rail, shapes, style toolbar, «+»; line B adds note/code/document/files)
// stay in en/ru parity, never override an existing key and reach PPM_TRANSLATIONS unchanged.
import { describe, expect, it } from "vitest";
import { getPpmTranslation, PPM_TRANSLATIONS } from "../index";
import { AF21_CANVAS_TRANSLATIONS } from "../translations/af21-canvas";
import { UX11_CANVAS_TRANSLATIONS } from "../translations/ux11-canvas";
import { UX11_SYSTEM_TRANSLATIONS } from "../translations/ux11-system";
import { UX11_TASKS_TRANSLATIONS } from "../translations/ux11-tasks";

const PALETTE = ["neutral", "yellow", "orange", "terracotta", "pink", "violet", "blue", "cyan", "green"] as const;

describe("AF2.1 canvas translations", () => {
  it("en and ru carry the same keys", () => {
    expect(Object.keys(AF21_CANVAS_TRANSLATIONS.ru).toSorted()).toEqual(
      Object.keys(AF21_CANVAS_TRANSLATIONS.en).toSorted()
    );
  });

  it("every key is a canvas.* key", () => {
    for (const key of Object.keys(AF21_CANVAS_TRANSLATIONS.en))
      expect(key).toMatch(/^canvas\.[a-z0-9_]+(\.[a-z0-9_]+)?$/);
  });

  it("never shares a key with the UX1.1 modules", () => {
    const ux11 = new Set(
      [UX11_SYSTEM_TRANSLATIONS, UX11_TASKS_TRANSLATIONS, UX11_CANVAS_TRANSLATIONS].flatMap((mod) =>
        Object.keys(mod.en)
      )
    );
    for (const key of Object.keys(AF21_CANVAS_TRANSLATIONS.en)) expect(ux11.has(key), key).toBe(false);
  });

  it("reaches PPM_TRANSLATIONS unchanged in both locales", () => {
    for (const locale of ["en", "ru"] as const)
      for (const [key, value] of Object.entries(AF21_CANVAS_TRANSLATIONS[locale]))
        expect((PPM_TRANSLATIONS[locale] as Record<string, string>)[key], `${locale}:${key}`).toBe(value);
  });

  it("names every palette colour as on the K2 colour panel", () => {
    expect(PALETTE.map((color) => getPpmTranslation("ru", `canvas.palette.${color}`))).toEqual([
      "Нейтральный",
      "Жёлтый",
      "Янтарный",
      "Терракотовый",
      "Розовый",
      "Фиолетовый",
      "Синий",
      "Бирюзовый",
      "Зелёный",
    ]);
  });

  it("keeps the K1 menu wording", () => {
    expect(getPpmTranslation("ru", "canvas.rail.docs")).toBe("Документы и текст");
    expect(getPpmTranslation("ru", "canvas.rail.docs_caption")).toBe("Заметки, документы, таблицы и схемы");
    expect(getPpmTranslation("ru", "canvas.rail.project_caption")).toBe("Живые карточки: правки — в источнике");
    expect(getPpmTranslation("ru", "canvas.quick.with_link")).toBe("{shape} · сразу со связью");
  });

  it("never says «ИИ»/AI", () => {
    for (const value of Object.values(AF21_CANVAS_TRANSLATIONS.ru)) expect(value).not.toMatch(/(?<!\p{L})ИИ(?!\p{L})/u);
    for (const value of Object.values(AF21_CANVAS_TRANSLATIONS.en)) expect(value).not.toMatch(/\bAI\b/);
  });
});
