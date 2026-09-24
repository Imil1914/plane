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
  PPM_SOURCE_ATTRIBUTION,
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
    expect(getPpmTranslation("ru", "project.brain")).toBe("Холст");
    expect(getPpmTranslation("fr", "project.brain")).toBe("Canvas");
    expect(getPpmTranslation("ru", "actions.open_canvas")).toBe("Открыть холст");
    expect(getPpmTranslation("ru", "project.views")).toBe("Фильтры задач");
    expect(getPpmTranslation("ru", "project.stages")).toBe("Спринты");
    expect(getPpmTranslation("ru", "project.knowledge")).toBe("Хранилище");
    expect(getPpmTranslation("ru", "project.collaborative_pages")).toBe("Документы");
    expect(getPpmTranslation("ru", "help.title")).toBe("Помощь");
    expect(getPpmTranslation("ru", "help.guide")).toBe("Руководство PPM");
    expect(getPpmTranslation("ru", "help.report_problem")).toBe("Сообщить о проблеме");
    expect(getPpmTranslation("ru", "about.title")).toBe("О программе");
    expect(getPpmTranslation("en", "about.source_code")).toBe("PPM source code");
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
    expect(getPpmTranslation("ru", "confirm.cancel")).toBe("Отмена");
    expect(getPpmTranslation("ru", "vault.confirm_trash_action")).toBe("В корзину");
    expect(getPpmTranslation("en", "code.confirm_disable_index_action")).toBe("Turn off");
    expect(getPpmTranslation("ru", "a11y.editor.align_left")).toBe("Выровнять по левому краю");
    expect(getPpmTranslation("ru", "a11y.editor.align_center")).toBe("Выровнять по центру");
    expect(getPpmTranslation("ru", "a11y.editor.align_right")).toBe("Выровнять по правому краю");
    expect(getPpmTranslation("en", "a11y.editor.align_center")).toBe("Center align");
    expect(getPpmTranslation("ru", "vault.tree_label")).toBe("Хранилище проекта");
    expect(getPpmTranslation("en", "vault.tree_label")).toBe("Project storage");
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

  it("has no planned capabilities left: every navigation entry is available", () => {
    expect(PPM_PROJECT_NAVIGATION_CONTRACT.every(({ capability }) => capability === "available")).toBe(true);
    expect(PPM_PROJECT_NAVIGATION_CONTRACT).toContainEqual(
      expect.objectContaining({ key: "knowledge", capability: "available" })
    );
    expect(PPM_PROJECT_NAVIGATION_CONTRACT).toContainEqual(
      expect.objectContaining({ key: "code", capability: "available" })
    );
  });
});

describe("PPM canvas board-info pill (fix round 2/5, controller ruling R7)", () => {
  it("phrases the object count plural-neutral instead of '{count} object(s)'", () => {
    const enValue = getPpmTranslation("en", "canvas.board_info_objects");
    const ruValue = getPpmTranslation("ru", "canvas.board_info_objects");
    expect(enValue).toBe("Objects: {count}");
    expect(ruValue).toBe("Объектов: {count}");
  });

  it("never renders a '{count} object'/'{count} объект' form in any locale", () => {
    const enValue = getPpmTranslation("en", "canvas.board_info_objects");
    const ruValue = getPpmTranslation("ru", "canvas.board_info_objects");
    expect(enValue).not.toMatch(/\{count\}\s*objects?\b/i);
    expect(ruValue).not.toMatch(/\{count\}\s*объект/i);
  });

  it("removes the unused canvas.board_version key (no reference left in apps/web or packages)", () => {
    // `getPpmTranslation` is typed by `TPpmTranslationKey`, which is derived from the
    // PPM_TRANSLATIONS object itself — casting past that type here to assert removal
    // actually happened at runtime, not just that TypeScript would refuse to compile a
    // reference to it (which it now also does, by construction).
    expect(getPpmTranslation("en", "canvas.board_version" as never)).toBeUndefined();
    expect(getPpmTranslation("ru", "canvas.board_version" as never)).toBeUndefined();
  });
});

describe("PPM token bridge", () => {
  it("keeps cyan as the single primary accent", () => {
    expect(PPM_BRAND.accentColor).toBe("#22D3EE");
    expect(tokenSource).toContain("--ppm-color-accent: oklch(0.7971 0.1339 211.53)");
    expect(tokenSource).toContain("--bg-accent-primary: var(--ppm-color-accent)");
  });

  it("is gated and provides Graphite and Light semantic surfaces", () => {
    expect(tokenSource).toContain('[data-ppm-brand="enabled"]');
    expect(tokenSource).toContain("--ppm-color-canvas: oklch(0.1687 0.0065 271.01)");
    expect(tokenSource).toContain("--ppm-color-canvas: oklch(0.9545 0.0046 258.32)");
    expect(tokenSource).toContain("--border-accent-strong: var(--ppm-color-selection)");
  });

  it("keeps representative text and focus combinations above WCAG AA", () => {
    expect(contrastRatio("#1A1D23", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#E7EAF0", "#15171C")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#062B32", "#22D3EE")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#136782", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#67E8F9", "#0E0F12")).toBeGreaterThanOrEqual(3);
  });
});

describe("Plane source attribution", () => {
  it("points to the pinned, licensed baseline", () => {
    expect(PLANE_SOURCE_ATTRIBUTION.releaseTag).toBe("v1.4.2");
    expect(PLANE_SOURCE_ATTRIBUTION.baselineCommit).toHaveLength(40);
    expect(PLANE_SOURCE_ATTRIBUTION.license).toBe("AGPL-3.0-only");
  });

  it("publishes the PPM source and release identity contract", () => {
    expect(PPM_SOURCE_ATTRIBUTION.version).toBe("0.1.0");
    expect(PPM_SOURCE_ATTRIBUTION.repository).toBe("https://github.com/Imil1914/PPM");
    expect(PPM_SOURCE_ATTRIBUTION.license).toBe("AGPL-3.0-only");
    expect(PPM_SOURCE_ATTRIBUTION.sourceRevisionEnvironment).toBe("VITE_PPM_SOURCE_REVISION");
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
