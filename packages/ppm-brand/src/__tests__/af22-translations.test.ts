// AF2.2 F1: строки «Живой карты» — паритет en/ru, блоки линий F, M, C, T в каждой локали и ключи только со своим
// префиксом, без пересечений с модулями UX1.1 и AF2.1, без «ИИ»; модуль подключён последним спредом обеих локалей
// и доходит до PPM_TRANSLATIONS без изменений.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation, PPM_TRANSLATIONS } from "../index";
import { AF21_CANVAS_TRANSLATIONS } from "../translations/af21-canvas";
import { AF22_LIVING_MAP_TRANSLATIONS } from "../translations/af22-living-map";
import { UX11_CANVAS_TRANSLATIONS } from "../translations/ux11-canvas";
import { UX11_SYSTEM_TRANSLATIONS } from "../translations/ux11-system";
import { UX11_TASKS_TRANSLATIONS } from "../translations/ux11-tasks";

type TLane = "F" | "M" | "C" | "T";

const LANE_PREFIX: Record<TLane, RegExp> = {
  F: /^canvas\.af22\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/,
  M: /^canvas\.(?:map|traffic|tray)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/,
  C: /^canvas\.changes\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/,
  T: /^issue\.canvas_boards\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/,
};
const source = readFileSync(new URL("../translations/af22-living-map.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

function localeSection(locale: "en" | "ru"): string {
  const start = source.indexOf(`  ${locale}: {`);
  return source.slice(start, locale === "en" ? source.indexOf("  ru: {") : source.indexOf("} as const;"));
}

/** Keys of one locale grouped by the lane block (`// ── F: …`) they are written in. */
function keysByLane(locale: "en" | "ru"): Record<TLane, string[]> {
  const lanes: Record<TLane, string[]> = { F: [], M: [], C: [], T: [] };
  let lane: TLane | undefined;
  for (const line of localeSection(locale).split("\n")) {
    const marker = /\/\/ ── ([FMCT]):/.exec(line);
    if (marker) lane = marker[1] as TLane;
    const key = /^\s+"([^"]+)":/.exec(line);
    if (!key) continue;
    expect(lane, `${locale}: ${key[1]} stands before the F block`).toBeDefined();
    if (lane) lanes[lane].push(key[1]);
  }
  return lanes;
}

describe("AF2.2 living map translations", () => {
  it("en and ru carry the same keys", () => {
    expect(Object.keys(AF22_LIVING_MAP_TRANSLATIONS.ru).toSorted()).toEqual(
      Object.keys(AF22_LIVING_MAP_TRANSLATIONS.en).toSorted()
    );
  });

  it("opens the four lane blocks once per locale, in the order F, M, C, T", () => {
    for (const locale of ["en", "ru"] as const)
      expect(
        [...localeSection(locale).matchAll(/\/\/ ── ([FMCT]):/g)].map((match) => match[1]),
        locale
      ).toEqual(["F", "M", "C", "T"]);
  });

  it("keeps every key in its lane's block with the lane's prefix, the same keys in both locales", () => {
    const en = keysByLane("en");
    const ru = keysByLane("ru");
    for (const lane of ["F", "M", "C", "T"] as const) {
      for (const key of en[lane]) expect(key, `en ${lane}`).toMatch(LANE_PREFIX[lane]);
      expect(ru[lane].toSorted(), lane).toEqual(en[lane].toSorted());
    }
    expect(Object.values(en).flat()).toHaveLength(Object.keys(AF22_LIVING_MAP_TRANSLATIONS.en).length);
  });

  it("never shares a key with the UX1.1 and AF2.1 modules", () => {
    const earlier = new Set(
      [UX11_SYSTEM_TRANSLATIONS, UX11_TASKS_TRANSLATIONS, UX11_CANVAS_TRANSLATIONS, AF21_CANVAS_TRANSLATIONS].flatMap(
        (mod) => Object.keys(mod.en)
      )
    );
    for (const key of Object.keys(AF22_LIVING_MAP_TRANSLATIONS.en)) expect(earlier.has(key), key).toBe(false);
  });

  it("is the last spread of both locales and reaches PPM_TRANSLATIONS unchanged", () => {
    for (const locale of ["en", "ru"] as const) {
      expect(indexSource).toMatch(
        new RegExp(
          `\\.\\.\\.AF21_CANVAS_TRANSLATIONS\\.${locale},\\s+\\.\\.\\.AF22_LIVING_MAP_TRANSLATIONS\\.${locale},\\s+\\},`
        )
      );
      for (const [key, value] of Object.entries(AF22_LIVING_MAP_TRANSLATIONS[locale]))
        expect((PPM_TRANSLATIONS[locale] as Record<string, string>)[key], `${locale}:${key}`).toBe(value);
    }
  });

  it("names the foundation's actions as in the rail, the empty board and the link notice", () => {
    expect(getPpmTranslation("ru", "canvas.af22.sprint_map")).toBe("Карта спринта");
    expect(getPpmTranslation("ru", "canvas.af22.source_sprints")).toBe("Спринты");
    expect(getPpmTranslation("ru", "canvas.af22.empty_sprint_map")).toBe("Собрать карту спринта");
    expect(getPpmTranslation("en", "canvas.af22.sprint_map")).toBe("Sprint map");
    for (const key of ["canvas.af22.sprint_map_hint", "canvas.af22.shape_not_found"] as const) {
      expect(getPpmTranslation("ru", key), key).toMatch(/[а-яё]/i);
      expect(getPpmTranslation("en", key), key).not.toMatch(/[а-яё]/i);
    }
  });

  it("never says «ИИ»/AI", () => {
    for (const value of Object.values(AF22_LIVING_MAP_TRANSLATIONS.ru))
      expect(value).not.toMatch(/(?<!\p{L})ИИ(?!\p{L})/u);
    for (const value of Object.values(AF22_LIVING_MAP_TRANSLATIONS.en)) expect(value).not.toMatch(/\bAI\b/);
  });
});
