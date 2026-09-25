// UX1.1 F4: «Профиль → Предпочтения» — device-local density switcher (R3) and Russian strings on the page.
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PpmDensitySwitcher } from "@/components/ppm-shell/density-switcher";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ currentLocale: "ru", t: (key: string) => key }),
}));

vi.mock("@plane/ui", () => ({
  CustomSelect: Object.assign(
    ({ label, children }: { label?: ReactNode; children?: ReactNode }) => (
      <div>
        <span>{label}</span>
        {children}
      </div>
    ),
    {
      Option: ({ children }: { children?: ReactNode }) => (
        <div role="option" aria-selected={false}>
          {children}
        </div>
      ),
    }
  ),
}));

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CORE = "../../core/components/";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// [file under core/components, ppmT key, upstream literal kept for PPM_SHELL_ENABLED=0]
const RU_CASES: Array<[string, string, string]> = [
  ["appearance/theme-switcher.tsx", "ux.preferences.theme_updating", "Updating theme..."],
  ["appearance/theme-switcher.tsx", "ux.preferences.theme_updated", "Theme updated"],
  ["appearance/theme-switcher.tsx", "ux.preferences.theme_reloading", "Reloading to apply changes..."],
  ["appearance/theme-switcher.tsx", "ux.preferences.error_title", "Error!"],
  ["appearance/theme-switcher.tsx", "ux.preferences.theme_failed", "Failed to update theme. Please try again."],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.success_title",
    "Success!",
  ],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.timezone_updated",
    "Timezone updated successfully",
  ],
  ["settings/profile/content/pages/preferences/language-and-timezone-list.tsx", "ux.preferences.error_title", "Error!"],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.timezone_failed",
    "Failed to update timezone",
  ],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.language_updated",
    "Language updated successfully",
  ],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.language_failed",
    "Failed to update language",
  ],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.select_language",
    "Select a language",
  ],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.start_of_week",
    "First day of the week",
  ],
  [
    "settings/profile/content/pages/preferences/language-and-timezone-list.tsx",
    "ux.preferences.start_of_week_description",
    "This will change how all calendars in your app look.",
  ],
  ["profile/start-of-week-preference.tsx", "ux.preferences.success_title", "Success"],
  [
    "profile/start-of-week-preference.tsx",
    "ux.preferences.start_of_week_updated",
    "First day of the week updated successfully",
  ],
  ["profile/start-of-week-preference.tsx", "ux.preferences.update_failed_title", "Update failed"],
  ["profile/start-of-week-preference.tsx", "ux.preferences.try_again_later", "Please try again later."],
];

describe("profile preferences (UX1.1)", () => {
  it("renders «Плотность» with both options and says it is saved on this device", () => {
    const markup = renderToStaticMarkup(<PpmDensitySwitcher />);
    expect(markup).toContain("Плотность");
    expect(markup).toContain("Удобная");
    expect(markup).toContain("Компактная");
    expect(markup).toContain("Сохраняется на этом устройстве.");
  });

  it("writes density only to this device (R3)", () => {
    const switcher = read(`${CORE}ppm-shell/density-switcher.tsx`);
    expect(switcher).toContain("onChange={(value: TPpmDensity) => setPpmDensity(value)}");
    expect(switcher).not.toMatch(/updateUserTheme|updateUserProfile|useUserProfile|@\/services/);
  });

  it("shows the switcher only under the v2 design", () => {
    const list = read(`${CORE}settings/profile/content/pages/preferences/default-list.tsx`);
    expect(list).toContain("const isDesignV2 = usePpmDesignV2();");
    expect(list).toContain("{isDesignV2 && <PpmDensitySwitcher />}");
  });

  it("keeps every English literal on the page only as the upstream branch of an isPpmShell ternary", () => {
    for (const [file, key, literal] of RU_CASES) {
      const source = read(`${CORE}${file}`);
      const occurrences = source.split(`"${literal}"`).length - 1;
      const gated = source.match(
        new RegExp(`isPpmShell\\s*\\?\\s*ppmT\\("${escape(key)}"\\)\\s*:\\s*"${escape(literal)}"`, "g")
      );
      expect(occurrences, `${file}: ${literal}`).toBeGreaterThan(0);
      expect(gated?.length ?? 0, `${file}: ${literal}`).toBe(occurrences);
    }
  });
});
