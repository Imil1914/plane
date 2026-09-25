// UX1.1 F5: shell v2 — grouped project navigation, inert hooks, shell.css scope, keyboard hints.
// Controller rulings R25/R26 (see task-5-brief.md) override the original brief text and are reflected here:
// R25 — the content frame stays as on the mockups: shell.css must NOT carry "no frame" rules
//       ([data-ppm-app-frame="gutter"|"panel"]) or a topbar border-bottom.
// R26 — the sidebar «Новая задача» button gets no `N I` hint; PpmKbdHint/PPM_CREATE_WORK_ITEM_KEYS are still
//       exported for lane T's main button, and the Ctrl K/⌘K hint in the topbar search stays.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import {
  groupProjectNavigationItems,
  PPM_NAVIGATION_SECTION_LABEL_KEYS,
  type TPpmNavigationSection,
  type TProjectNavigationItem,
} from "@/components/navigation/project-navigation-items";
import { getPpmCommandShortcutLabel, PPM_CREATE_WORK_ITEM_KEYS } from "@/components/ppm-shell/kbd-hint";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CORE = "../../core/components/";
const APP = "../../app/";

const item = (key: string, ppmSection?: TPpmNavigationSection): TProjectNavigationItem => ({
  access: [],
  href: `/demo/projects/p/${key}`,
  i18n_key: key,
  icon: () => null,
  key,
  name: key,
  shouldRender: true,
  sortOrder: 0,
  ppmSection,
});

describe("shell v2 (UX1.1)", () => {
  it("groups consecutive items of a section and keeps the canonical order", () => {
    const runs = groupProjectNavigationItems([
      item("overview", "context"),
      item("brain", "context"),
      item("work_items", "work"),
      item("views", "work"),
      item("cycles", "work"),
      item("modules", "work"),
      item("knowledge", "knowledge"),
      item("pages", "knowledge"),
      item("code", "code"),
      item("settings", "project"),
    ]);
    expect(runs.map((run) => run.section)).toEqual(["context", "work", "knowledge", "code", "project"]);
    expect(runs.flatMap((run) => run.items.map(({ key }) => key))).toEqual([
      "overview",
      "brain",
      "work_items",
      "views",
      "cycles",
      "modules",
      "knowledge",
      "pages",
      "code",
      "settings",
    ]);
  });

  it("never merges items without a section or runs that are not adjacent", () => {
    const runs = groupProjectNavigationItems([
      item("a"),
      item("b"),
      item("c", "work"),
      item("d", "code"),
      item("e", "work"),
    ]);
    expect(runs.map((run) => run.items.map(({ key }) => key))).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    expect(new Set(runs.map((run) => run.key)).size).toBe(runs.length);
  });

  it("labels only «Работа» and «Знания»", () => {
    // oxlint-disable-next-line unicorn/no-array-sort -- the TypeScript target predates Array#toSorted
    expect(Object.keys(PPM_NAVIGATION_SECTION_LABEL_KEYS).sort()).toEqual(["knowledge", "work"]);
    expect(getPpmTranslation("ru", PPM_NAVIGATION_SECTION_LABEL_KEYS.work!)).toBe("Работа");
    expect(getPpmTranslation("ru", PPM_NAVIGATION_SECTION_LABEL_KEYS.knowledge!)).toBe("Знания");
  });

  it("groups the project navigation only under shell + v2 and keeps the wave-0 list otherwise", () => {
    const source = read(`${CORE}workspace/sidebar/project-navigation.tsx`);
    expect(source).toContain("if (!(isPpmShell && isDesignV2))");
    expect(source).toContain('role="group"');
    expect(source).toContain("aria-labelledby={labelId}");
    expect(source).toContain('isPpmShell && isDesignV2 ? "text-13 leading-5 font-medium" : "text-11 font-medium"');
  });

  it("adds only inert data-attribute hooks to upstream and shell markup", () => {
    const hooks: Array<[string, string]> = [
      [`${CORE}sidebar/sidebar-navigation.tsx`, 'data-ppm-nav-item=""'],
      [`${CORE}sidebar/sidebar-navigation.tsx`, 'data-active={isActive ? "" : undefined}'],
      [`${CORE}workspace/sidebar/projects-list-item.tsx`, 'data-ppm-nav-item=""'],
      [`${CORE}workspace/content-wrapper.tsx`, 'data-ppm-app-frame="gutter"'],
      [`${APP}(all)/[workspaceSlug]/(projects)/layout.tsx`, 'data-ppm-app-frame="panel"'],
      [`${APP}(all)/[workspaceSlug]/(settings)/layout.tsx`, 'data-ppm-app-frame="panel"'],
      [`${APP}(all)/settings/profile/layout.tsx`, 'data-ppm-app-frame="gutter"'],
      [`${APP}(all)/settings/profile/layout.tsx`, 'data-ppm-app-frame="panel"'],
      [`${CORE}navigation/top-navigation-root.tsx`, 'data-ppm-topbar=""'],
      [`${CORE}navigation/top-nav-power-k.tsx`, 'data-ppm-command-search=""'],
      [`${CORE}navigation/top-nav-power-k.tsx`, 'data-ppm-command-panel=""'],
      [
        `${CORE}workspace/sidebar/workspace-menu-root.tsx`,
        'data-ppm-topbar-menu={variant === "top-navigation" ? "" : undefined}',
      ],
    ];
    for (const [file, hook] of hooks) expect(read(file), file).toContain(hook);
  });

  it("styles only those hooks, under design v2 and the PPM shell (R25: no frame rules, no topbar border)", () => {
    const css = read("../../styles/ppm-v2/shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/^\s*([^@{}\s][^{}]*)\{/gm)].map((match) => match[1].trim());
    expect(selectors.length).toBeGreaterThanOrEqual(6);
    for (const selector of selectors)
      expect(
        selector.startsWith(':where(html[data-ppm-design="v2"][data-ppm-shell="enabled"]) [data-ppm-'),
        selector
      ).toBe(true);
    // R25: the controller kept the wave-0 frame — no rules for the gutter/panel hooks and no topbar border.
    expect(css).not.toContain('[data-ppm-app-frame="gutter"]');
    expect(css).not.toContain('[data-ppm-app-frame="panel"]');
    expect(css).not.toMatch(/\[data-ppm-topbar\]\s*\{[^}]*border-bottom/);
  });

  it("hints the real shortcut in the command search: Ctrl K / ⌘K by platform (R9)", () => {
    expect(getPpmCommandShortcutLabel("MacIntel")).toBe("⌘K");
    expect(getPpmCommandShortcutLabel("iPhone")).toBe("⌘K");
    expect(getPpmCommandShortcutLabel("Win32")).toBe("Ctrl K");
    expect(getPpmCommandShortcutLabel("")).toBe("Ctrl K");
    expect([...PPM_CREATE_WORK_ITEM_KEYS]).toEqual(["N", "I"]);
    expect(read(`${CORE}power-k/config/creation/command.ts`)).toContain('keySequence: "ni"');
    // Class order is left to oxfmt's Tailwind sorter: assert the classes, not their order.
    const v2Only = /<PpmKbdHint[^>]*className="(?=[^"]*\bhidden\b)(?=[^"]*ppm-v2:inline-flex)[^"]*"/;
    const search = read(`${CORE}navigation/top-nav-power-k.tsx`);
    expect(search).toContain("keys={[commandShortcutLabel]}");
    expect(search).toMatch(v2Only);
  });

  it("R26: the sidebar «Новая задача» button has no N I hint (PPM_CREATE_WORK_ITEM_KEYS is for lane T's main button only)", () => {
    const quickActions = read(`${CORE}workspace/sidebar/quick-actions.tsx`);
    expect(quickActions).not.toContain("PpmKbdHint");
    expect(quickActions).not.toContain("PPM_CREATE_WORK_ITEM_KEYS");
  });
});
