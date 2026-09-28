/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line S: the panels are wired to the live refresh (the rules themselves are tested in the neighbouring files), the
// burndown chart uses the new points, and the texts of the line's files are Russian under the PPM shell while the
// upstream English literal stays as the fallback on the same line (PPM_SHELL_ENABLED=0 renders it unchanged).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation, PPM_TRANSLATIONS } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import {
  isActiveCyclePriorityTab,
  isCycleStatsLive,
  isModuleStatsLive,
  LIVE_STATS_KEYS,
  priorityIssuesPageSize,
} from "@/components/ppm-live-stats/live-subjects";

const CORE = new URL("../../core/components/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, CORE), "utf8");
const before = (source: string, first: string, second: string) => {
  expect(source.indexOf(first), first).toBeGreaterThan(-1);
  expect(source.indexOf(second), second).toBeGreaterThan(-1);
  expect(source.indexOf(first), `${first} before ${second}`).toBeLessThan(source.indexOf(second));
};

describe("line S: which sprints and modules are kept fresh", () => {
  it("a current, upcoming or draft sprint is re-read; a completed or archived one is not", () => {
    expect(isCycleStatsLive({ id: "c", status: "current" })).toBe(true);
    expect(isCycleStatsLive({ id: "c", status: "upcoming" })).toBe(true);
    expect(isCycleStatsLive({ id: "c", status: "draft" })).toBe(true);
    expect(isCycleStatsLive({ id: "c", status: "COMPLETED" })).toBe(false);
    expect(isCycleStatsLive({ id: "c", status: "current", archived_at: "2026-09-01" })).toBe(false);
    expect(isCycleStatsLive(null)).toBe(false);
  });

  it("a module is re-read unless it is archived or opened from the archive", () => {
    expect(isModuleStatsLive({ id: "m" })).toBe(true);
    expect(isModuleStatsLive({ id: "m", archived_at: "2026-09-01" })).toBe(false);
    expect(isModuleStatsLive({ id: "m" }, true)).toBe(false);
    expect(isModuleStatsLive(undefined)).toBe(false);
  });

  it("the sprint stats of the panel and the sidebar share one refresh; the priority list has its own", () => {
    expect(LIVE_STATS_KEYS.cycleStats("c")).not.toBe(LIVE_STATS_KEYS.cyclePriorityIssues("c"));
    expect(LIVE_STATS_KEYS.moduleStats("c")).not.toBe(LIVE_STATS_KEYS.cycleStats("c"));
  });
});

describe("line S: the panels are wired to the live refresh", () => {
  it("the active-sprint panel (progress, burndown, priority list, assignees, labels)", () => {
    const source = read("cycles/active-cycle/root.tsx");
    before(
      source,
      "useCycleLiveStats({ workspaceSlug, projectId, cycle: activeCycle, withPriorityIssues: true });",
      "if (!cycleId || !activeCycle) {"
    );
  });

  it("the sprint analytics sidebar", () => {
    const source = read("cycles/analytics-sidebar/root.tsx");
    before(
      source,
      "useCycleLiveStats({ workspaceSlug, projectId, cycle: isArchived ? null : cycleDetails });",
      "if (!cycleDetails)"
    );
  });

  it("the module (направление) analytics sidebar", () => {
    const source = read("modules/analytics-sidebar/root.tsx");
    before(source, "useModuleLiveStats({", "if (!moduleDetails)");
  });

  it("a change re-reads the sprint members too; the priority list keeps the rows already loaded", () => {
    const source = read("cycles/active-cycle/use-cycle-live-stats.ts");
    expect(source).toContain(
      'refreshCycleStats(workspaceSlug, projectId, cycleId, { withDetails: reason === "change" })'
    );
    expect(source).toContain("priorityIssuesPageSize(getActiveCycleById(cycleId)?.issueIds.length ?? 0)");
    expect(read("cycles/active-cycle/use-cycles-details.ts")).toContain(
      "fetchActiveCycleIssues(workspaceSlug, projectId, ACTIVE_CYCLE_PRIORITY_PAGE_SIZE, cycle?.id)"
    );
  });

  it("each registration refreshes the key it registered (a panel switched to another sprint does not steal it)", () => {
    expect(read("ppm-live-stats/use-live-stats.ts")).toContain("bindRefreshToKey(key, registered.refresh, latestRef)");
  });

  it("the priority list keeps showing the previous rows of the same sprint while it is re-read", () => {
    const source = read("cycles/active-cycle/use-cycles-details.ts");
    expect(source).toMatch(
      /storedCycleIssueDetails \?\? \(shownCycleIssues\?\.cycleId === cycle\.id \? shownCycleIssues\.details : undefined\)/
    );
  });
});

describe("line S (fix round 1): «Приоритетные задачи»", () => {
  it("a refresh re-reads as many rows as are loaded — never less than a page, never more than the API allows", () => {
    expect(priorityIssuesPageSize(0)).toBe(30);
    expect(priorityIssuesPageSize(30)).toBe(30);
    expect(priorityIssuesPageSize(47)).toBe(47);
    expect(priorityIssuesPageSize(90)).toBe(90);
    expect(priorityIssuesPageSize(5000)).toBe(1000);
  });

  it("the list is re-read only while its tab is open (the same fallback as the panel's tabs)", () => {
    expect(isActiveCyclePriorityTab("Priority-Issues")).toBe(true);
    expect(isActiveCyclePriorityTab("Assignees")).toBe(false);
    expect(isActiveCyclePriorityTab("Labels")).toBe(false);
    expect(isActiveCyclePriorityTab(null)).toBe(true);
  });

  it("the live refresh and the panel read the same stored tab", () => {
    const tabHook = /useLocalStorage\(\s*ACTIVE_CYCLE_TAB_STORAGE_KEY,\s*ACTIVE_CYCLE_DEFAULT_TAB\s*\)/;
    const liveSource = read("cycles/active-cycle/use-cycle-live-stats.ts");
    expect(liveSource).toMatch(tabHook);
    expect(liveSource).toContain("enabled: enabled && withPriorityIssues && isActiveCyclePriorityTab(activeTab)");
    expect(read("cycles/active-cycle/cycle-stats.tsx")).toMatch(tabHook);
  });
});

describe("line S (fix round 1): a draft sprint without dates never asks for analytics", () => {
  it("the first load asks for the distributions only when both dates are set", () => {
    const source = read("cycles/active-cycle/use-cycles-details.ts");
    expect(source).toContain("const hasDates = Boolean(cycle?.start_date && cycle?.end_date);");
    expect(source.match(/cycle\?\.id && hasDates && !cycle\?\.(estimate_)?distribution/g)).toHaveLength(4);
  });
});

describe("line S3: the burndown chart", () => {
  it("draws the points from buildBurndownChartData instead of turning future days into 0", () => {
    const source = read("core/sidebar/progress-chart.tsx");
    expect(source).toContain("buildBurndownChartData(distribution, totalIssues, {");
    expect(source).toContain("today: toLocalDateKey(new Date())");
    expect(source).not.toContain("distribution[key] ?? 0");
  });

  it("the sprint sidebar passes whether the sprint is completed (a completed sprint is drawn as before)", () => {
    expect(read("cycles/analytics-sidebar/sidebar-chart.tsx")).toContain(
      'isCompleted={cycleDetails?.status?.toLowerCase() === "completed"}'
    );
  });
});

describe("line S4: Russian texts in the line's files (upstream English kept as the fallback on the same line)", () => {
  it.each([
    [
      "core/sidebar/single-progress-stats.tsx",
      'isPpmShell ? ppmT("stats.of_total").replace("{total}", String(total)) : `of ${total}`',
    ],
    [
      "core/sidebar/progress-stats/state_group.tsx",
      "isPpmShell ? t(`workspace_projects.state.${group.state}`) : group.state",
    ],
    ["cycles/active-cycle/cycle-stats.tsx", 'isPpmShell ? ppmT("stats.tooltip_title") : "Title"'],
    ["cycles/active-cycle/cycle-stats.tsx", 'isPpmShell ? ppmT("stats.tooltip_due_date") : "Target Date"'],
    ["cycles/active-cycle/cycle-stats.tsx", 'isPpmShell ? ppmT("stats.no_label") : "No labels"'],
    [
      "cycles/analytics-sidebar/sidebar-details.tsx",
      'isPpmShell ? ppmT("stats.no_work_items") : `0 ${t("common.work_item")}`',
    ],
    ["modules/analytics-sidebar/root.tsx", 'isPpmShell ? ppmT("stats.no_work_items") : "0 work items"'],
    ["modules/analytics-sidebar/root.tsx", 'isPpmShell ? ppmT("stats.toast_success") : "Success!"'],
    ["modules/analytics-sidebar/root.tsx", 'isPpmShell ? ppmT("stats.toast_error") : "Error!"'],
    ["modules/analytics-sidebar/root.tsx", 'isPpmShell ? ppmT("stats.something_went_wrong") : "Some error occurred"'],
    [
      "modules/analytics-sidebar/root.tsx",
      'isPpmShell ? ppmT("stats.module_link_deleted") : "Module link deleted successfully."',
    ],
    [
      "modules/analytics-sidebar/root.tsx",
      'isPpmShell ? ppmT("stats.module_updated") : "Module updated successfully."',
    ],
  ])("%s: %s", (file, expression) => {
    expect(read(file)).toContain(expression);
  });

  it.each([
    ["core/sidebar/single-progress-stats.tsx", "<span>of {total}</span>"],
    ["cycles/active-cycle/cycle-stats.tsx", 'tooltipHeading="Title"'],
    ["cycles/active-cycle/cycle-stats.tsx", 'tooltipHeading="Target Date"'],
    ["cycles/active-cycle/cycle-stats.tsx", '?? "No labels"'],
    ["modules/analytics-sidebar/root.tsx", 'title: "Success!"'],
    ["modules/analytics-sidebar/root.tsx", 'title: "Error!"'],
  ])("%s has no bare %s", (file, literal) => {
    expect(read(file)).not.toContain(literal);
  });

  it("«0% из 1», «0 задач», «Срок», «Без метки» and the module toasts in Russian; the same keys in English", () => {
    const keys = Object.keys(PPM_TRANSLATIONS.en).filter((key) => key.startsWith("stats.")) as TPpmTranslationKey[];
    expect(keys.length).toBeGreaterThanOrEqual(10);
    expect(new Set(Object.keys(PPM_TRANSLATIONS.ru).filter((key) => key.startsWith("stats.")))).toEqual(new Set(keys));
    expect(getPpmTranslation("ru", "stats.of_total").replace("{total}", "1")).toBe("из 1");
    expect(getPpmTranslation("en", "stats.of_total").replace("{total}", "1")).toBe("of 1");
    expect(getPpmTranslation("ru", "stats.no_work_items")).toBe("0 задач");
    expect(getPpmTranslation("ru", "stats.tooltip_due_date")).toBe("Срок");
    expect(getPpmTranslation("ru", "stats.no_label")).toBe("Без метки");
    expect(getPpmTranslation("ru", "stats.module_updated")).toBe("Направление обновлено.");
    for (const key of keys) {
      const ru = getPpmTranslation("ru", key).replace(/\{\w+\}/g, "");
      expect(ru, key).not.toMatch(/[A-Za-z]{3,}/);
      expect(ru, key).not.toMatch(/рабоч\p{L}*\s+элемент|(?<!\p{L})модул|(?<!\p{L})цикл/iu);
    }
  });

  it("the chart legend and axes stay on the existing PPM keys: «Фактически», «План», «Дата»", () => {
    expect(getPpmTranslation("ru", "cycle.chart_current_work_items")).toContain("Фактически");
    expect(getPpmTranslation("ru", "cycle.chart_ideal_work_items")).toContain("План");
    expect(getPpmTranslation("ru", "cycle.chart_axis_date")).toBe("Дата");
  });
});
