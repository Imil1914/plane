import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getPpmProjectPath,
  getPpmTranslation,
  isPpmBrandEnabled,
  isPpmShellEnabled,
  PLANE_SOURCE_ATTRIBUTION,
  PPM_BRAND,
  PPM_PROJECT_NAVIGATION_CONTRACT,
  resolvePpmInitialLanguage,
  shouldInitializePpmProfileLanguage,
} from "../index";

const tokenSource = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

describe("PPM brand feature flag", () => {
  it("enables PPM branding by default", () => {
    expect(isPpmBrandEnabled(undefined)).toBe(true);
    expect(isPpmBrandEnabled("")).toBe(true);
    expect(isPpmBrandEnabled("1")).toBe(true);
  });

  it.each(["0", "false", "FALSE", "off", "no", "disabled"])("treats %s as disabled", (value) => {
    expect(isPpmBrandEnabled(value)).toBe(false);
  });
});

describe("PPM shell contract", () => {
  it("defaults to the Russian shell while preserving an explicit language", () => {
    expect(resolvePpmInitialLanguage(null, true)).toBe("ru");
    expect(resolvePpmInitialLanguage("en", true)).toBe("en");
    expect(resolvePpmInitialLanguage(null, false)).toBe("en");
  });

  it("persists Russian only for a new profile that still has the upstream default", () => {
    expect(
      shouldInitializePpmProfileLanguage({
        isOnboarded: false,
        profileLanguage: "en",
        shellEnabled: true,
        storedLanguage: "ru",
      })
    ).toBe(true);
    expect(
      shouldInitializePpmProfileLanguage({
        isOnboarded: true,
        profileLanguage: "en",
        shellEnabled: true,
        storedLanguage: "ru",
      })
    ).toBe(false);
    expect(
      shouldInitializePpmProfileLanguage({
        isOnboarded: false,
        profileLanguage: "en",
        shellEnabled: true,
        storedLanguage: "en",
      })
    ).toBe(false);
  });

  it("rolls back together with the brand or through its own flag", () => {
    expect(isPpmShellEnabled(undefined, undefined)).toBe(true);
    expect(isPpmShellEnabled("0", undefined)).toBe(false);
    expect(isPpmShellEnabled("1", "0")).toBe(false);
  });

  it("keeps Russian and English terminology behind stable keys", () => {
    expect(getPpmTranslation("ru", "project.tasks")).toBe("Задачи");
    expect(getPpmTranslation("en", "project.tasks")).toBe("Tasks");
    expect(getPpmTranslation("fr", "project.brain")).toBe("Project brain");
    expect(getPpmTranslation("ru", "navigation.project")).toBe("Навигация проекта");
    expect(getPpmTranslation("en", "navigation.more_project_sections")).toBe("More project sections");
    expect(getPpmTranslation("ru", "navigation.search_commands")).toBe("Поиск команд…");
    expect(getPpmTranslation("en", "actions.clear_search")).toBe("Clear search");
    expect(getPpmTranslation("ru", "onboarding.role.developer")).toBe("Разработчик");
    expect(getPpmTranslation("ru", "onboarding.usecase.sprints")).toBe("Управлять спринтами разработки");
    expect(getPpmTranslation("ru", "auth.welcome_back")).toBe("С возвращением в PPM.");
    expect(getPpmTranslation("ru", "auth.create_account")).toBe("Создать аккаунт");
    expect(getPpmTranslation("ru", "auth.terms")).toBe("Условия использования");
    expect(getPpmTranslation("ru", "home.personalize_account_title")).toBe("Настройте PPM под себя");
    expect(getPpmTranslation("ru", "work_item.saved")).toBe("Сохранено");
    expect(getPpmTranslation("ru", "work_item.view")).toBe("Открыть задачу");
    expect(getPpmTranslation("ru", "navigation.open_workspace_menu")).toBe("Открыть меню пространства");
    expect(getPpmTranslation("ru", "canvas.add_note")).toBe("Добавить заметку");
    expect(getPpmTranslation("en", "canvas.permission_denied_title")).toBe("Canvas access denied");
  });

  it("builds reload-safe project routes", () => {
    expect(getPpmProjectPath("demo", "project-1", "brain")).toBe("/demo/projects/project-1/brain");
    expect(getPpmProjectPath("demo", "project-1", "tasks")).toBe("/demo/projects/project-1/issues");
  });

  it("publishes navigation in the canonical PPM information-architecture order", () => {
    expect(PPM_PROJECT_NAVIGATION_CONTRACT.map(({ key }) => key)).toEqual([
      "overview",
      "brain",
      "work_items",
      "views",
      "cycles",
      "modules",
      "intake",
      "knowledge",
      "pages",
      "code",
    ]);
  });

  it("marks unavailable capabilities with a delivery stage", () => {
    const plannedCapabilities = PPM_PROJECT_NAVIGATION_CONTRACT.filter(({ capability }) => capability === "planned");

    expect(plannedCapabilities).toEqual([
      expect.objectContaining({ key: "knowledge", stage: "I0.7" }),
      expect.objectContaining({ key: "code", stage: "G0.1" }),
    ]);
  });
});

describe("PPM token bridge", () => {
  it("keeps cyan as the single primary accent", () => {
    expect(PPM_BRAND.accentColor).toBe("#22D3EE");
    expect(tokenSource).toContain("--ppm-color-accent: #22d3ee");
    expect(tokenSource).toContain("--bg-accent-primary: var(--ppm-color-accent)");
  });

  it("is gated and provides Graphite and Light semantic surfaces", () => {
    expect(tokenSource).toContain('[data-ppm-brand="enabled"]');
    expect(tokenSource).toContain("--ppm-color-canvas: #0e0f12");
    expect(tokenSource).toContain("--ppm-color-canvas: #eef0f3");
    expect(tokenSource).toContain("--border-accent-strong: var(--ppm-color-focus)");
  });

  it("keeps representative text and focus combinations above WCAG AA", () => {
    expect(contrastRatio("#1A1D23", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#E7EAF0", "#15171C")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#062B32", "#22D3EE")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#0891B2", "#FFFFFF")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#67E8F9", "#0E0F12")).toBeGreaterThanOrEqual(3);
  });
});

describe("Plane source attribution", () => {
  it("points to the pinned, licensed baseline", () => {
    expect(PLANE_SOURCE_ATTRIBUTION.releaseTag).toBe("v1.4.2");
    expect(PLANE_SOURCE_ATTRIBUTION.baselineCommit).toHaveLength(40);
    expect(PLANE_SOURCE_ATTRIBUTION.license).toBe("AGPL-3.0-only");
  });
});

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((value) => Number.parseInt(value, 16) / 255);

  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);

  const [red, green, blue] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
