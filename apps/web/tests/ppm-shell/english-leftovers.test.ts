/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// UX0.2 Task 12: static scan for hardcoded English/Plane leftovers on the PPM main path
// (Overview, Requests/Intake, Cycles/Modules/Views/Pages breadcrumbs, Git status copy). A literal
// is only allowed when it is the upstream branch of an `isPpmShell ? ppmT(...) : "<upstream>"`
// ternary sitting on the SAME line — that keeps `PPM_SHELL_ENABLED=0` rendering the exact
// upstream string while the PPM path never shows it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const APP = new URL("../../app/", import.meta.url);
const CORE = new URL("../../core/components/", import.meta.url);

// [file (relative), literal] pairs; file paths verified against notes/vocab.md §6.
// Literals that are common English words (Cycles/Modules/Views/Pages/Intake) are quoted
// ("Cycles") to match only the string literal, not identifiers such as `CyclesListHeader`
// that legitimately contain the same substring.
const CASES: Array<[URL, string]> = [
  [new URL("stickies/layout/stickies-list.tsx", CORE), "stickies in Plane"],
  [new URL("stickies/modal/stickies.tsx", CORE), "Add sticky"],
  [new URL("stickies/modal/stickies.tsx", CORE), "Your stickies"],
  [new URL("(all)/[workspaceSlug]/(projects)/stickies/header.tsx", APP), '"Stickies"'],
  [new URL("(all)/[workspaceSlug]/(settings)/settings/(workspace)/webhooks/[webhookId]/page.tsx", APP), '"Webhook"'],
  [new URL("settings/project/sidebar/header.tsx", CORE), "Project settings"],
  [new URL("project/form.tsx", CORE), "Project ID"],
  [new URL("sidebar/resizable-sidebar.tsx", CORE), "Main sidebar"],
  [new URL("sidebar/resizable-sidebar.tsx", CORE), "Sidebar peek view"],
  [new URL("ppm-git/route.tsx", CORE), "в этой сборке"],
  [new URL("projects/settings/intake/header.tsx", CORE), '"Intake"'],
  [new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/cycles/(list)/header.tsx", APP), '"Cycles"'],
  [
    new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/cycles/(detail)/header.tsx", APP),
    '"Cycles"',
  ],
  [
    new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/modules/(list)/header.tsx", APP),
    '"Modules"',
  ],
  [
    new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/modules/(detail)/header.tsx", APP),
    '"Modules"',
  ],
  [new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/modules/(list)/page.tsx", APP), '"Modules"'],
  [new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/views/(list)/header.tsx", APP), '"Views"'],
  [
    new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/views/(detail)/[viewId]/header.tsx", APP),
    '"Views"',
  ],
  [new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/views/(list)/page.tsx", APP), '"Views"'],
  [new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/pages/(list)/header.tsx", APP), '"Pages"'],
  [new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/pages/(detail)/header.tsx", APP), '"Pages"'],
  [new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/pages/(list)/page.tsx", APP), '"Pages"'],
  [
    new URL("(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/archives/issues/(detail)/header.tsx", APP),
    "Work items",
  ],
  [new URL("(all)/[workspaceSlug]/(projects)/drafts/page.tsx", APP), "Workspace Draft"],
];

const offending = (source: string, literal: string) =>
  source.split("\n").filter((line) => line.includes(literal) && !/isPpmShell\s*\?[^:]*:\s*["'`]/.test(line));

describe("no English or Plane leftovers on the PPM path", () => {
  it.each(CASES)("%s has no bare %s", (file, literal) => {
    expect(offending(readFileSync(file, "utf8"), literal)).toEqual([]);
  });
});

// Fix round 1: these two spots reuse a translation key whose English value does not match
// the pre-existing upstream literal (`stickies.title` = "Your stickies" vs. upstream
// "Stickies"; `workspace_settings.settings.webhooks.title` = "Webhooks" vs. upstream
// singular "Webhook"). The generic scan above can't tell "gated" from "never had the
// literal at all", so assert the exact gated expression directly: it fails if the gate is
// ever dropped in favor of calling `t(...)` unconditionally again.
describe("PPM shell gates translated strings whose value differs from the upstream literal", () => {
  it("stickies breadcrumb keeps the upstream literal when the PPM shell is disabled", () => {
    const source = readFileSync(new URL("(all)/[workspaceSlug]/(projects)/stickies/header.tsx", APP), "utf8");
    expect(source).toMatch(/isPpmShell\s*\?\s*t\("stickies\.title"\)\s*:\s*"Stickies"/);
  });

  it("webhook detail page title keeps the upstream singular literal when the PPM shell is disabled", () => {
    const source = readFileSync(
      new URL("(all)/[workspaceSlug]/(settings)/settings/(workspace)/webhooks/[webhookId]/page.tsx", APP),
      "utf8"
    );
    expect(source).toMatch(/isPpmShell\s*\?\s*t\("workspace_settings\.settings\.webhooks\.title"\)\s*:\s*"Webhook"/);
  });
});

// Fix round 2: the active-cycle progress card and burndown chart on the Спринты page
// (`cycles/active-cycle/progress.tsx`, `productivity.tsx`, and the shared
// `core/sidebar/progress-chart.tsx`) hardcoded "Completed"/"Started"/"Unstarted"/"Backlog",
// "N Work item(s) closed", "Pending work items - N", and the chart's "Current/Ideal work
// items" + "Date"/"Completion" axis labels. Same multi-line-ternary limitation as fix round 1
// applies to the CASES table above (these literals also live in the PPM-shell fallback branch,
// by design, so a bare-literal scan can't distinguish "gated" from "never gated"); assert the
// exact gated expressions instead, tolerant of the ternary spanning several lines.
describe("PPM shell gates the active-cycle progress card and burndown chart (fix round 2/5)", () => {
  const progressSource = readFileSync(new URL("cycles/active-cycle/progress.tsx", CORE), "utf8");
  const productivitySource = readFileSync(new URL("cycles/active-cycle/productivity.tsx", CORE), "utf8");
  const progressChartSource = readFileSync(new URL("core/sidebar/progress-chart.tsx", CORE), "utf8");

  it("state group labels (Completed/Started/Unstarted/Backlog) resolve via the existing i18n key only under the PPM shell", () => {
    expect(progressSource).toMatch(/isPpmShell\s*\?\s*t\(`workspace_projects\.state\.\$\{group\}`\)\s*:\s*group/);
  });

  it("the closed-count pill uses the plural-neutral PPM key and keeps the upstream '.../... closed' fallback", () => {
    expect(progressSource).toMatch(/isPpmShell\s*\n\s*\?\s*ppmT\("cycle\.work_items_closed"\)/);
    expect(progressSource).toMatch(/\$\{closedCount\}\/\$\{totalCount\}.*Work items.*Work item.*closed/s);
  });

  it("the per-group count uses the plural-neutral PPM key and keeps the upstream 'N Work item(s)' fallback", () => {
    expect(progressSource).toMatch(/isPpmShell\s*\n\s*\?\s*ppmT\("cycle\.work_items_count"\)/);
    expect(progressSource).toMatch(/\$\{groupedIssues\[group\]\}\s*\$\{groupedIssues\[group\] > 1 \? "Work items"/);
  });

  it("the cancelled-issues notice uses the PPM key and keeps the upstream literal fallback", () => {
    expect(progressSource).toMatch(/isPpmShell\s*\n\s*\?\s*ppmT\("cycle\.work_items_excluded"\)/);
    expect(progressSource).toMatch(/cancelled \$\{\s*cycle\.cancelled_issues > 1 \? "work items are" : "work item is"/);
  });

  it("'Pending points - N' / 'Pending work items - N' resolve via PPM keys and keep the upstream fallback", () => {
    expect(productivitySource).toMatch(/isPpmShell\s*\n\s*\?\s*ppmT\("cycle\.pending_points"\)/);
    expect(productivitySource).toMatch(/`Pending points - \$\{pendingPoints\}`/);
    expect(productivitySource).toMatch(/isPpmShell\s*\n\s*\?\s*ppmT\("cycle\.pending_work_items"\)/);
    expect(productivitySource).toMatch(/`Pending work items - \$\{pendingWorkItems\}`/);
  });

  it("the burndown chart passes PPM-translated legend/axis labels only when the PPM shell is on", () => {
    expect(productivitySource).toMatch(
      /currentLabel=\{isPpmShell \? ppmT\("cycle\.chart_current_points"\) : undefined\}/
    );
    expect(productivitySource).toMatch(/idealLabel=\{isPpmShell \? ppmT\("cycle\.chart_ideal_points"\) : undefined\}/);
    expect(productivitySource).toMatch(
      /currentLabel=\{isPpmShell \? ppmT\("cycle\.chart_current_work_items"\) : undefined\}/
    );
    expect(productivitySource).toMatch(
      /idealLabel=\{isPpmShell \? ppmT\("cycle\.chart_ideal_work_items"\) : undefined\}/
    );
    expect(
      productivitySource.match(/dateAxisLabel=\{isPpmShell \? ppmT\("cycle\.chart_axis_date"\) : undefined\}/g)
    ).toHaveLength(2);
    expect(
      productivitySource.match(
        /completionAxisLabel=\{isPpmShell \? ppmT\("cycle\.chart_axis_completion"\) : undefined\}/g
      )
    ).toHaveLength(2);
  });

  it("the shared ProgressChart keeps its upstream 'Current/Ideal {plotTitle}' and 'Date'/'Completion' defaults for callers that pass no override (every caller while the PPM shell is off)", () => {
    expect(progressChartSource).toMatch(/label:\s*currentLabel\s*\?\?\s*`Current \$\{plotTitle\}`/);
    expect(progressChartSource).toMatch(/label:\s*idealLabel\s*\?\?\s*`Ideal \$\{plotTitle\}`/);
    expect(progressChartSource).toMatch(/label:\s*dateAxisLabel\s*\?\?\s*"Date"/);
    expect(progressChartSource).toMatch(/label:\s*completionAxisLabel\s*\?\?\s*"Completion"/);
  });
});

// UX0.2 final fix F7: the other two ProgressChart callers — the Направления (modules) analytics sidebar and
// the sprint (cycle) detail analytics sidebar — pass the same PPM legend/axis keys as the active-cycle
// burndown, gated on the PPM shell (undefined keeps the chart's upstream English defaults).
const gatedChartLabel = (prop: string, key: string) =>
  new RegExp(`${prop}=\\{isPpmShell \\? ppmT\\("cycle\\.${key}"\\) : undefined\\}`, "g");

describe("PPM shell gates the burndown legend/axes in the module and cycle analytics sidebars (final fix F7)", () => {
  const moduleSource = readFileSync(new URL("modules/analytics-sidebar/issue-progress.tsx", CORE), "utf8");
  const cycleSidebarSource = readFileSync(new URL("cycles/analytics-sidebar/sidebar-chart.tsx", CORE), "utf8");

  it("module sidebar: points and work-item charts", () => {
    expect(moduleSource.match(gatedChartLabel("currentLabel", "chart_current_points"))).toHaveLength(1);
    expect(moduleSource.match(gatedChartLabel("idealLabel", "chart_ideal_points"))).toHaveLength(1);
    expect(moduleSource.match(gatedChartLabel("currentLabel", "chart_current_work_items"))).toHaveLength(1);
    expect(moduleSource.match(gatedChartLabel("idealLabel", "chart_ideal_work_items"))).toHaveLength(1);
    expect(moduleSource.match(gatedChartLabel("dateAxisLabel", "chart_axis_date"))).toHaveLength(2);
    expect(moduleSource.match(gatedChartLabel("completionAxisLabel", "chart_axis_completion"))).toHaveLength(2);
  });

  it("module sidebar: the invalid-date 'Progress' heading uses the existing i18n key only under the PPM shell", () => {
    expect(moduleSource).toMatch(/\{isPpmShell \? t\("common\.progress"\) : "Progress"\}/);
  });

  it("cycle detail sidebar: labels follow the selected estimate type", () => {
    expect(cycleSidebarSource).toMatch(
      /currentLabel=\{\s*isPpmShell\s*\?\s*ppmT\(\s*estimateType === "points" \? "cycle\.chart_current_points" : "cycle\.chart_current_work_items"\s*\)\s*:\s*undefined\s*\}/
    );
    expect(cycleSidebarSource).toMatch(
      /idealLabel=\{\s*isPpmShell\s*\?\s*ppmT\(\s*estimateType === "points" \? "cycle\.chart_ideal_points" : "cycle\.chart_ideal_work_items"\s*\)\s*:\s*undefined\s*\}/
    );
    expect(cycleSidebarSource.match(gatedChartLabel("dateAxisLabel", "chart_axis_date"))).toHaveLength(1);
    expect(cycleSidebarSource.match(gatedChartLabel("completionAxisLabel", "chart_axis_completion"))).toHaveLength(1);
  });
});
