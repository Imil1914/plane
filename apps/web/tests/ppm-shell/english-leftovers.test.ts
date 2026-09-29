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

// Line L (owner request 2026-09-28): the sign-in screens — sign-in, sign-up, forgot/reset/set password and the e-mail
// code. Their shell flag is `IS_PPM_SHELL_ENABLED`; an upstream English literal (or a Plane i18n key whose Russian
// still says "Email"/"SMTP") may stay only as the fallback of an `IS_PPM_SHELL_ENABLED ? … : …` ternary on its line.
const AUTH_FORMS = new URL("account/auth-forms/", CORE);
const AUTH_CASES: Array<[string, string]> = [
  ["forgot-password.tsx", '"Reset password"'],
  ["forgot-password.tsx", "Regain access to your account."],
  ["forgot-password.tsx", 't("auth.common.email.label")'],
  ["forgot-password.tsx", 't("auth.common.email.placeholder")'],
  ["forgot-password.tsx", 't("auth.forgot_password.email_sent")'],
  ["forgot-password.tsx", 't("auth.forgot_password.toast.success.title")'],
  ["forgot-password.tsx", 't("auth.forgot_password.toast.success.message")'],
  ["forgot-password-popover.tsx", 't("auth.forgot_password.errors.smtp_not_enabled")'],
  ["reset-password.tsx", '"Reset password"'],
  ["reset-password.tsx", "Create a new password."],
  ["reset-password.tsx", 't("auth.common.email.label")'],
  ["reset-password.tsx", 't("auth.common.email.placeholder")'],
  ["set-password.tsx", '"Set password"'],
  ["set-password.tsx", "Create a new password."],
  ["set-password.tsx", 't("auth.common.email.label")'],
  ["set-password.tsx", 't("auth.common.email.placeholder")'],
  ["unique-code.tsx", 't("auth.common.email.label")'],
  ["unique-code.tsx", 't("auth.common.email.placeholder")'],
  ["unique-code.tsx", 't("auth.common.unique_code.paste_code")'],
  ["unique-code.tsx", 't("aria_labels.auth_forms.clear_email")'],
];

const offendingAuth = (source: string, literal: string) => {
  const lines = source.split("\n");
  return lines.filter((line, index) => {
    if (!line.includes(literal) || /IS_PPM_SHELL_ENABLED\s*\?[^:]*:/.test(line)) return false;
    // oxfmt splits a long ternary over three lines: `… IS_PPM_SHELL_ENABLED` / `? ppmT(…)` / `: <upstream>`.
    const isWrappedFallback =
      /^\s*:/.test(line) &&
      /^\s*\?/.test(lines[index - 1] ?? "") &&
      /IS_PPM_SHELL_ENABLED\s*$/.test(lines[index - 2] ?? "");
    return !isWrappedFallback;
  });
};

describe("no English leftovers on the PPM sign-in screens (line L)", () => {
  it.each(AUTH_CASES)("%s has no bare %s", (file, literal) => {
    const source = readFileSync(new URL(file, AUTH_FORMS), "utf8");
    expect(source).toContain(literal);
    expect(offendingAuth(source, literal)).toEqual([]);
  });

  it.each(["password.tsx", "reset-password.tsx", "set-password.tsx"])(
    "%s shows the translated strength meter and the password hints under the PPM shell",
    (file) => {
      const source = readFileSync(new URL(file, AUTH_FORMS), "utf8");
      const upstreamMeters = source.match(/<PasswordStrengthIndicator\b/g) ?? [];
      expect(upstreamMeters.length).toBeGreaterThan(0);
      expect(source.match(/IS_PPM_SHELL_ENABLED \? \(\s*<PpmPasswordStrengthIndicator\b/g)).toHaveLength(
        upstreamMeters.length
      );
      expect(source).toMatch(/IS_PPM_SHELL_ENABLED && \(\s*<PasswordFieldHints\b/);
      expect(source).toMatch(/\{\.\.\.passwordHints\.inputProps\}/);
    }
  );

  it("the sign-in error helper keeps no English sentence of its own: the texts live in the PPM dictionary", () => {
    const source = readFileSync(new URL("../../helpers/authentication.helper.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/Please (try again|contact)|Authentication failed|already registered|No account found/);
  });

  it("the sign-in screens pass the interface language to the error helper", () => {
    for (const file of ["auth-root.tsx", "form-root.tsx", "reset-password.tsx", "forgot-password.tsx"]) {
      const source = readFileSync(new URL(file, AUTH_FORMS), "utf8");
      // Each call, up to the end of its statement (the calls hold no `;` of their own).
      const calls = [...source.matchAll(/\b(?:authErrorHandler|getAuthErrorText|getResetLinkErrorText)\(/g)].map(
        (match) => source.slice(match.index, source.indexOf(";", match.index))
      );
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call.replaceAll(/\s+/g, " "), file).toMatch(/,\s*currentLocale\s*,?\s*\)/);
    }
  });
});

// Line R (owner request 2026-09-28): the Russian interface on the main routes — confirmation dialogs (the owner's
// «Удалить Задача» / «Are you sure you want to delete work item BIO-4 ?…» / «Cancel/Delete»), task properties, filters,
// the create/edit dialog, the activity feed, sprint/direction/document flows and the navigation settings. Each phrase
// may stay in the source only as the upstream fallback (`ppmText(key, <upstream>)`, `ppmServerError(…, <upstream>)` or
// the false branch of a PPM-shell ternary) — checked on the AST, so multi-line JSX fallbacks count as gated.
const { jsxAttributeNames, scanPpmLiterals, scanPpmSource } = await import("./ppm-gated-literals");
const { getPpmTranslation, PPM_TRANSLATIONS } = await import("@ppm/brand");

const R_CASES: Array<[string, string[]]> = [
  // R1: confirmation dialogs
  [
    "issues/delete-issue-modal.tsx",
    [
      "Are you sure you want to delete",
      "permanently removed",
      "entity.delete.label",
      "entity.delete.success",
      "Cancel",
      "Delete",
    ],
  ],
  [
    "cycles/delete-modal.tsx",
    ["Delete cycle", "Are you sure you want to delete cycle", "Cycle deleted successfully.", "Warning!", "Cancel"],
  ],
  [
    "cycles/archived-cycles/modal.tsx",
    ["Archive cycle", "Are you sure you want to archive the cycle?", "Archive success", "Archiving", "Cancel"],
  ],
  [
    "modules/delete-module-modal.tsx",
    ["Delete module", "Are you sure you want to delete module-", "Module deleted successfully."],
  ],
  [
    "modules/archived-modules/modal.tsx",
    ["Archive module", "Are you sure you want to archive the module?", "Archive success"],
  ],
  [
    "pages/modals/delete-page-modal.tsx",
    ["Delete page", "Are you sure you want to delete page-", "Page deleted successfully."],
  ],
  ["labels/delete-label-modal.tsx", ["Delete Label", "Are you sure you want to delete", "Label could not be deleted"]],
  [
    "project-states/state-delete-modal.tsx",
    ["Delete State", "Are you sure you want to delete state-", "State could not be deleted"],
  ],
  [
    "project-states/options/delete.tsx",
    ["Delete State", "Cannot delete the default state.", "Cannot have an empty group."],
  ],
  ["issues/attachment/delete-attachment-modal.tsx", ["Are you sure you want to delete attachment-"]],
  ["issues/confirm-issue-discard.tsx", ["Save this draft?", "Save to Drafts", "Discard", "Cancel"]],
  ["views/delete-view-modal.tsx", ["View deleted successfully.", "View could not be deleted."]],
  [
    "project/confirm-project-member-remove.tsx",
    [
      "Leave project?",
      "Are you sure you want to leave the",
      "Are you sure you want to remove member-",
      "Removing...",
      "Leave",
    ],
  ],
  ["workspace/confirm-workspace-member-remove.tsx", ["Leave workspace?", "Are you sure you want to remove member-"]],
  [
    "project/archive-restore-modal.tsx",
    ["Archive success", "Restore success", "This project and its work items", "Restoring a project"],
  ],
  [
    "project/delete-project-modal.tsx",
    [
      "Delete project",
      "Are you sure you want to delete project",
      "Enter the project name",
      "To confirm, type",
      "delete my project",
    ],
  ],
  ["inbox/modals/delete-issue-modal.tsx", ["Are you sure you want to delete work item"]],
  ["inbox/modals/decline-issue-modal.tsx", ["Are you sure you want to decline work item"]],
  ["web-hooks/delete-webhook-modal.tsx", ["Delete webhook", "Are you sure you want to delete this webhook?"]],
  [
    "issues/issue-layouts/quick-action-dropdowns/helper.tsx",
    ["Remove from cycle", "Remove from module", "Work item link copied to clipboard", "Restore success"],
  ],
  [
    "common/quick-actions-helper.tsx",
    ["Only completed cycles can be archived", "Only completed or cancelled modules can be archived"],
  ],
  // R2: dates and the sprint dialog (overlap message, date range placeholders)
  [
    "cycles/modal.tsx",
    [
      "You already have a cycle on the given dates",
      "Cycle created successfully.",
      "Cycle updated successfully.",
      "Error in creating cycle",
    ],
  ],
  ["modules/module-card-item.tsx", ["Start date", "End date", "No lead", "Adding module to favorites...", "Work item"]],
  ["dropdowns/date.tsx", ["Date", "None"]],
  ["issues/issue-layouts/properties/all-properties.tsx", ["Date Range"]],
  [
    "cycles/transfer-issues-modal.tsx",
    ["Transfer work items", "Search for a cycle...", "You don’t have any current cycle", "Loading..."],
  ],
  ["cycles/transfer-issues.tsx", ["Completed cycles are not editable.", "Transfer work items"]],
  // R3: task properties and chips, the create/edit dialog
  ["dropdowns/module/button-content.tsx", ["module", "Module", "Title", "Remove"]],
  ["issues/issue-layouts/properties/labels.tsx", ["Labels", "None"]],
  ["ui/labels-list.tsx", ["Labels"]],
  ["issues/label.tsx", ["Labels", "Label"]],
  ["issues/issue-modal/form.tsx", ["Editor is still processing changes", "Failed to move work item to project"]],
  ["issues/issue-layouts/spreadsheet/columns/assignee-column.tsx", ["Assignees"]],
  ["issues/issue-layouts/spreadsheet/columns/module-column.tsx", ["Select modules"]],
  ["issues/issue-layouts/spreadsheet/columns/attachment-column.tsx", ["attachment"]],
  ["issues/peek-overview/properties.tsx", ["None"]],
  ["issues/issue-layouts/kanban/base-kanban-root.tsx", ["Drop here to delete the work item."]],
  ["issues/issue-layouts/kanban/block.tsx", ["Cannot move work item", "Drag and drop is disabled"]],
  [
    "issues/issue-layouts/kanban/headers/group-by-card.tsx",
    ["Create work item", "Add an existing work item", "Work items added to the cycle"],
  ],
  ["issues/issue-layouts/group-drag-overlay.tsx", ["entity.drop_here_to_move"]],
  [
    "issues/issue-detail-widgets/relations/helper.tsx",
    ["entity.link_copied_to_clipboard", "entity.update.success", "entity.update.failed"],
  ],
  [
    "issues/issue-detail-widgets/sub-issues/helper.ts",
    ["entity.fetch.failed", "entity.add.success", "entity.remove.success"],
  ],
  [
    "issues/issue-detail-widgets/attachments/helper.tsx",
    ["Uploading attachment...", "Attachment uploaded", "Attachment removed"],
  ],
  ["issues/attachment/attachment-upload.tsx", ["Drop here...", "Uploading...", "Click or drag a file here"]],
  // R3: the activity feed of a work item
  ["issues/issue-detail/issue-activity/activity/actions/state.tsx", ["set the state to"]],
  ["issues/issue-detail/issue-activity/activity/actions/priority.tsx", ["set the priority to"]],
  ["issues/issue-detail/issue-activity/activity/actions/label.tsx", ["added a new label", "removed the label"]],
  [
    "issues/issue-detail/issue-activity/activity/actions/assignee.tsx",
    ["added a new assignee", "removed the assignee"],
  ],
  [
    "issues/issue-detail/issue-activity/activity/actions/cycle.tsx",
    ["added this work item to the cycle", "set the cycle to"],
  ],
  [
    "issues/issue-detail/issue-activity/activity/actions/module.tsx",
    ["added this work item to the module", "set the module to"],
  ],
  [
    "issues/issue-detail/issue-activity/activity/actions/target_date.tsx",
    ["set the due date to", "removed the due date"],
  ],
  [
    "issues/issue-detail/issue-activity/activity/actions/archived-at.tsx",
    ["restored the work item", "archived the work item"],
  ],
  // R4: filters, «Вид», documents, navigation settings
  ["rich-filters/filters-row.tsx", ["Clear all", "Save view", "Update view", "Confirming", "Filters"]],
  ["rich-filters/add-filters/dropdown.tsx", ["All filters applied", "Filter configuration error"]],
  [
    "issues/issue-layouts/filters/header/filters/assignee.tsx",
    ["Assignee", "View all", "View less", "No matches found", "You"],
  ],
  ["issues/issue-layouts/filters/header/filters/due-date.tsx", ["Due date", "Custom", "No matches found"]],
  ["issues/issue-layouts/filters/header/display-filters/sub-group-by.tsx", ["Sub-group by"]],
  [
    "navigation/customize-navigation-dialog.tsx",
    [
      "Selected items will always stay visible",
      "Feature tabs will appear",
      "Minimum value is 1",
      "accordion_navigation_control",
      "horizontal_navigation_bar",
    ],
  ],
  ["pages/dropdowns/actions.tsx", ["Make private", "Make public", "Open in new tab", "Make a copy"]],
  ["pages/modals/page-form.tsx", ["Create page", "Create Page", "Max length of the name"]],
  [
    "pages/modals/export-page-modal.tsx",
    ["Export page", "Export format", "Include content", "Page exported successfully."],
  ],
  ["pages/header/lock-control.tsx", ["Lock", "Locked", "Unlocked"]],
];

describe("no English leftovers on the PPM main routes (line R)", () => {
  it.each(R_CASES)("%s shows no bare English", (file, phrases) => {
    const { present, ungated } = scanPpmLiterals(new URL(file, CORE), phrases);
    expect(ungated).toEqual([]);
    // Most phrases stay as the upstream fallback; a case that no longer finds any of them points at nothing.
    expect(present.length, `${file}: none of the phrases is left even as a fallback`).toBeGreaterThan(0);
  });

  it("replaced literals are gone or translated where they are rendered", () => {
    const source = (file: string) => readFileSync(new URL(file, CORE), "utf8");
    // Same keys as the entity menus: their English values are exactly the former literals.
    expect(source("common/quick-actions-factory.tsx")).not.toMatch(/"Open in new tab"|"Copy link"/);
    expect(source("cycles/form.tsx")).not.toMatch(/"Start date"|"End date"/);
    // «Создать ещё одну» with its tooltip replaces the unclear «Создать еще» in the Russian PPM interface.
    expect(source("issues/issue-modal/form.tsx")).toMatch(
      /isPpmRu \? ppmT\("ui\.issue\.create_more"\) : t\("create_more"\)/
    );
    // Module-level option lists keep the upstream labels; the render goes through ppmText by key.
    expect(source("pages/list/tab-navigation.tsx")).toMatch(/ppmText\(PAGE_TAB_LABELS\[tab\.key\], tab\.label\)/);
    expect(source("pages/list/order-by.tsx")).toMatch(/sortLabel\(option\)/);
  });

  it("every confirmation dialog passes its button labels (AlertModalCore defaults to «Cancel» / «Delete»)", () => {
    const callers = [
      "issues/delete-issue-modal.tsx",
      "cycles/delete-modal.tsx",
      "modules/delete-module-modal.tsx",
      "pages/modals/delete-page-modal.tsx",
      "labels/delete-label-modal.tsx",
      "project-states/state-delete-modal.tsx",
      "project-states/options/delete.tsx",
      "views/delete-view-modal.tsx",
      "workspace/views/delete-view-modal.tsx",
      "issues/attachment/delete-attachment-modal.tsx",
      "inbox/modals/delete-issue-modal.tsx",
      "inbox/modals/decline-issue-modal.tsx",
      "stickies/delete-modal.tsx",
      "web-hooks/delete-webhook-modal.tsx",
      "api-token/delete-token-modal.tsx",
      "issues/workspace-draft/delete-modal.tsx",
      "ppm-shell/use-ppm-confirm.tsx",
    ];
    for (const file of callers) {
      const elements = jsxAttributeNames(new URL(file, CORE), "AlertModalCore");
      expect(elements.length, file).toBeGreaterThan(0);
      for (const attributes of elements) {
        expect(attributes, file).toContain("primaryButtonText");
        expect(attributes, file).toContain("secondaryButtonText");
      }
    }
  });

  it("names the entity in the right case instead of «Удалить Задача» (no verb + nominative glue)", () => {
    expect(getPpmTranslation("ru", "ui.confirm.delete_task_title")).toBe("Удалить задачу");
    expect(getPpmTranslation("ru", "ui.confirm.delete_cycle_title")).toBe("Удалить спринт");
    expect(getPpmTranslation("ru", "ui.confirm.delete_module_title")).toBe("Удалить направление");
    expect(getPpmTranslation("ru", "ui.confirm.delete_page_title")).toBe("Удалить документ");
    expect(getPpmTranslation("ru", "ui.common.cancel")).toBe("Отмена");
    expect(getPpmTranslation("ru", "ui.common.delete")).toBe("Удалить");
    // The glue check itself: the owner's title, built the upstream way ("Удалить {entity}" + the capitalised
    // entity label), must be caught. JS `\b` is an ASCII boundary even with /u, so the end is a Unicode lookahead.
    const glue =
      /(?:Удалить|Архивировать|Восстановить|Отклонить|Создать) (?:Задача|Спринт|Направление|Документ|Метка|Статус)(?![\p{L}\p{N}_])/u;
    const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    const upstreamRu = readJson("../../../../packages/i18n/src/locales/ru/common.json");
    const overlayRu = readJson("../../../../packages/ppm-brand/src/locales/i18n-overlay.json").ru;
    // delete-issue-modal: t("entity.delete.label", { entity: t("common.work_item") }) — «Задача» comes from the overlay.
    const ownerTitle = upstreamRu.entity.delete.label.replace("{entity}", overlayRu.common.common.work_item);
    expect(ownerTitle).toBe("Удалить Задача");
    expect(glue.test(ownerTitle)).toBe(true);
    expect(glue.test("Удалить Задачу")).toBe(false);
    expect(glue.test("Удалить Задачи")).toBe(false);
    const glued = Object.entries(PPM_TRANSLATIONS.ru).filter(([, value]) => glue.test(value));
    expect(glued).toEqual([]);
  });

  it("the scanner counts only an exact shell flag as a gate (synthetic file)", () => {
    const sample = [
      'const a = IS_PPM_SHELL_TEXT ? ppmT("k") : "Delete gated";',
      'const b = !IS_PPM_SHELL_TEXT ? "Delete negated" : ppmT("k");',
      'const c = IS_PPM_SHELL_TEXT && extra ? ppmT("k") : "Delete and";',
      'const d = IS_PPM_SHELL_TEXT || extra ? ppmT("k") : "Delete or";',
      'const e = isPpmShellEnabled(x, y) ? ppmT("k") : "Delete call";',
      'const f = ppmText("ui.delete_key", "Delete fallback");',
      'const g = "Delete bare";',
      'const h = isPpmRu ? ppmT("k") : "Delete ru";',
      'const i = someFlag ? ppmT("k") : "Delete other flag";',
      'const j = (IS_PPM_SHELL_TEXT) ? ppmT("k") : "Delete parenthesised";',
      "const k = <p>{isPpmShell ? <b /> : <>Delete jsx</>}</p>;",
      "const l = <p>{isPpmShell && <b />}Delete after</p>;",
      'handleOptionalAction(onRemove, "Delete internal action name");',
      'handleOptionalAction("Delete not the name argument", onRemove);',
    ].join("\n");
    const { ungated } = scanPpmSource(sample, ["Delete"]);
    expect(ungated.map((entry) => entry.split(": ")[0])).toEqual(["2", "3", "4", "7", "9", "10", "12", "14"]);
  });

  it("uses the PPM priority names everywhere a priority title is shown", async () => {
    const { PPM_PRIORITY_TITLE_KEYS } = await import("@/components/ppm-shell/priority-title");
    expect(
      Object.fromEntries(
        Object.entries(PPM_PRIORITY_TITLE_KEYS).map(([key, value]) => [key, getPpmTranslation("ru", value)])
      )
    ).toEqual({
      urgent: "Срочный",
      high: "Высокий",
      medium: "Средний",
      low: "Низкий",
      none: "Без приоритета",
    });
    for (const file of [
      "dropdowns/priority.tsx",
      "readonly/priority.tsx",
      "issues/issue-layouts/filters/header/filters/priority.tsx",
    ])
      expect(readFileSync(new URL(file, CORE), "utf8"), file).toMatch(/usePpmPriorityTitle\(\)/);
  });
});

// Line R2 (after line R): notifications, intake (Заявки), the workspace settings (members, invitations, logo, delete,
// webhooks, API tokens, exports) and the document/description editor. Same AST rule as line R; the editor package has
// no i18n of its own, so its texts go through `editorText(key, <upstream>)` (@plane/editor core/helpers/ppm-text) and
// the web registers the Russian dictionary only in the Russian PPM interface.
const EDITOR_SRC = new URL("../../../../packages/editor/src/", import.meta.url);
const HEADINGS = ["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"];

const R2_CASES: Array<[URL, string[]]> = [
  // R2-5 (round 1): no Plane support address under the PPM brand — gated by the brand flag (a ternary or an early
  // return on IS_PPM_BRAND_ENABLED), the upstream text stays only for PPM_BRAND_ENABLED=0.
  [
    new URL("instance/maintenance-message.tsx", CORE),
    ["Looks like Plane didn", "Some services might have failed to start", "Contact Support", "support@plane.so"],
  ],
  [new URL("global/product-updates/footer.tsx", CORE), ["support@plane.so"]],
  [
    new URL("error/prod.tsx", APP),
    ["Looks like something went wrong", "Contact Support", "support@plane.so", "status.plane.so", "Go to home"],
  ],
  [
    new URL("../../../space/app/error.tsx", import.meta.url),
    ["Yikes!", "That crashed Plane", "support@plane.so", "forum.plane.so", "Refresh"],
  ],
  // R2-1: notifications
  [new URL("workspace-notifications/sidebar/notification-card/item.tsx", CORE), ["Till"]],
  [
    new URL("workspace-notifications/sidebar/notification-card/options/snooze/modal.tsx", CORE),
    [
      "Customize Snooze Time",
      "Pick a date",
      "Please select a date",
      "Select date",
      "Pick a time",
      "Please select a time",
      "Select a time",
      "No available time for this date.",
      "Cancel",
      "Submitting...",
      "Submit",
    ],
  ],
  // R2-2: intake
  [
    new URL("inbox/content/inbox-issue-header.tsx", CORE),
    [
      "Permission denied",
      "Previous work item",
      "Next work item",
      "Only project admins can mark work item as duplicate",
    ],
  ],
  [
    new URL("inbox/content/inbox-issue-mobile-header.tsx", CORE),
    [
      "Previous work item",
      "Next work item",
      "Copy work item link",
      "Open work item",
      "Only project admins can snooze/Un-snooze work items",
      "Un-snooze",
      "Snooze",
      "Only project admins can mark work items as duplicate",
      "Mark as duplicate",
      "Only project admins can accept work items",
      "Accept",
      "Only project admins can deny work items",
      "Decline",
      "Delete",
    ],
  ],
  [
    new URL("inbox/content/issue-properties.tsx", CORE),
    [
      "Properties",
      "State",
      "Assignees",
      "Add assignees",
      "Priority",
      "Due date",
      "Add due date",
      "Labels",
      "Duplicate of",
    ],
  ],
  [
    new URL("inbox/content/issue-root.tsx", CORE),
    [
      "Success!",
      "Work item deleted successfully",
      "Error!",
      "Work item delete failed",
      "Work item update failed",
      "Intake Form user",
    ],
  ],
  [
    new URL("inbox/inbox-filter/applied-filters/root.tsx", CORE),
    ["Assignees", "Created By", "Created date", "Updated date"],
  ],
  [new URL("inbox/inbox-filter/applied-filters/label.tsx", CORE), ["Label"]],
  [new URL("inbox/inbox-filter/applied-filters/state.tsx", CORE), ["State"]],
  [new URL("inbox/inbox-filter/applied-filters/status.tsx", CORE), ["Status"]],
  [new URL("inbox/inbox-filter/filters/date.tsx", CORE), ["Created date", "Custom", "No matches found"]],
  [
    new URL("inbox/inbox-filter/filters/filter-selection.tsx", CORE),
    ["Search", "Assignees", "Created By", "Created date", "Last updated date"],
  ],
  [new URL("inbox/inbox-filter/filters/labels.tsx", CORE), ["Label", "View less", "View all", "No matches found"]],
  [
    new URL("inbox/inbox-filter/filters/members.tsx", CORE),
    ["Members", "You", "View less", "View all", "No matches found"],
  ],
  [new URL("inbox/inbox-filter/filters/state.tsx", CORE), ["State", "View less", "View all", "No matches found"]],
  [new URL("inbox/inbox-filter/filters/status.tsx", CORE), ["Work item Status", "No matches found"]],
  [new URL("inbox/inbox-filter/root.tsx", CORE), ["Filters"]],
  [
    new URL("inbox/modals/create-modal/create-root.tsx", CORE),
    [
      "Error!",
      "Editor is still processing changes",
      "Success!",
      "Work item created successfully.",
      "Some error occurred. Please try again.",
    ],
  ],
  [
    new URL("inbox/modals/create-modal/issue-properties.tsx", CORE),
    [
      "Assignees",
      "Start date",
      "Due date",
      "Cycle",
      "Modules",
      "Estimate",
      "Add parent",
      "Change parent work item",
      "Remove parent work item",
    ],
  ],
  [new URL("inbox/modals/select-duplicate.tsx", CORE), ["Error", "Select work item", "Search..."]],
  [new URL("inbox/sidebar/inbox-list-item.tsx", CORE), ["Created on", "Priority", "None", "labels"]],
  [
    new URL("inbox/sidebar/root.tsx", CORE),
    ["No request closed yet", "All the work items whether accepted or declined"],
  ],
  // R2-3: workspace settings
  [new URL("(all)/[workspaceSlug]/(settings)/settings/(workspace)/members/page.tsx", APP), ["Success!", "Error!"]],
  [
    new URL("(all)/[workspaceSlug]/(settings)/settings/(workspace)/webhooks/[webhookId]/page.tsx", APP),
    [
      "Success!",
      "Webhook updated successfully.",
      "Error!",
      "Something went wrong. Please try again.",
      "You are not authorized to access this page.",
    ],
  ],
  [new URL("settings/workspace/sidebar/header.tsx", CORE), ["Workspace settings"]],
  [
    new URL("workspace/settings/invitations-list-item.tsx", CORE),
    [
      "Success!",
      "Invitation removed successfully.",
      "Error!",
      "Something went wrong. Please try again.",
      "An error occurred while updating member role",
    ],
  ],
  [new URL("workspace/settings/members-list-item.tsx", CORE), ["Error!"]],
  [
    new URL("workspace/settings/workspace-details.tsx", CORE),
    [
      "Success!",
      "Workspace updated successfully",
      "Workspace picture removed successfully.",
      "Error!",
      "There was some error in deleting your profile picture",
      "Workspace URL copied to the clipboard.",
      "Workspace Logo",
    ],
  ],
  [
    new URL("workspace/delete-workspace-form.tsx", CORE),
    [
      "You are about to delete the workspace",
      "Tread very carefully",
      "Type in this workspace",
      "For final confirmation, type",
      "delete my workspace",
    ],
  ],
  [
    new URL("core/modals/workspace-image-upload-modal.tsx", CORE),
    [
      "Something went wrong",
      "Upload image",
      "Edit",
      "Drop image here to upload",
      "Drag & drop image here",
      "The image size cannot exceed 5 MB.",
      "Please upload a file in a valid format.",
      "File formats supported",
      "Removing",
      "Remove",
      "Cancel",
      "Uploading",
      "Upload & Save",
    ],
  ],
  [
    new URL("web-hooks/empty-state.tsx", CORE),
    ["No webhooks", "Create webhooks to receive real-time updates", "Add webhook"],
  ],
  [new URL("web-hooks/form/delete-section.tsx", CORE), ["Danger zone", "Once a webhook is deleted", "Delete webhook"]],
  [
    new URL("web-hooks/form/secret-key.tsx", CORE),
    ["New key regenerated successfully.", "View secret key", "Copy secret key"],
  ],
  [new URL("web-hooks/form/toggle.tsx", CORE), ["Enable webhook"]],
  [new URL("web-hooks/generated-hook-details.tsx", CORE), ["Close"]],
  [new URL("api-token/empty-state.tsx", CORE), ["No API tokens", "Create API tokens for safe", "Add token"]],
  [new URL("api-token/token-list-item.tsx", CORE), ["Delete token", "Active", "Expired", "Expires", "Never expires"]],
  [
    new URL("api-token/modal/form.tsx", CORE),
    [
      "Error!",
      "Please select an expiration date.",
      "Custom date",
      "Set expiration date",
      "Custom",
      "Set date",
      "Expires",
    ],
  ],
  [new URL("api-token/modal/generated-token-details.tsx", CORE), ["Copy secret key", "Expires", "Never expires"]],
  [new URL("api-token/modal/create-token-modal.tsx", CORE), ["Error!"]],
  [new URL("exporter/column.tsx", CORE), ["project(s)", "Expired"]],
  [new URL("exporter/export-form.tsx", CORE), ["All projects"]],
  // R2-4: editor wrappers in web
  [new URL("editor/sticky-editor/color-palette.tsx", CORE), ["Background colors"]],
  [new URL("editor/sticky-editor/toolbar.tsx", CORE), ["Background color", "Delete"]],
  [new URL("editor/embeds/mentions/user.tsx", CORE), ["@suspended user"]],
  [new URL("pages/editor/toolbar/toolbar.tsx", CORE), ["Text"]],
  [new URL("../hooks/editor/use-editor-mention.tsx", CORE), ["Users"]],
  // R2-4: the editor package (menus «/», formatting, links, tables, images, upload errors)
  [
    new URL("core/constants/common.ts", EDITOR_SRC),
    [
      "Text",
      ...HEADINGS,
      "Left align",
      "Center align",
      "Right align",
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Bulleted list",
      "Numbered list",
      "To-do list",
      "Quote",
      "Code",
      "Table",
      "Image",
      "Gray",
      "Peach",
      "Pink",
      "Orange",
      "Green",
      "Light blue",
      "Dark blue",
      "Purple",
      "Sans serif",
      "Serif",
      "Mono",
    ],
  ],
  [
    new URL("core/components/menus/menu-items.ts", EDITOR_SRC),
    [
      "Text",
      ...HEADINGS,
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Bulleted list",
      "Numbered list",
      "To-do list",
      "Quote",
      "Code",
      "Table",
      "Image",
      "Divider",
      "Link",
      "Color",
      "Background color",
      "Text align",
    ],
  ],
  [new URL("core/components/menus/block-menu.tsx", EDITOR_SRC), ["Delete", "Duplicate"]],
  [new URL("core/components/menus/block-menu-options.tsx", EDITOR_SRC), ["Fit to width"]],
  [
    new URL("core/components/menus/bubble-menu/color-selector.tsx", EDITOR_SRC),
    ["Color", "Text colors", "Background colors"],
  ],
  [
    new URL("core/components/menus/bubble-menu/link-selector.tsx", EDITOR_SRC),
    ["Link", "Enter or paste a link", "Please enter a valid URL"],
  ],
  [new URL("core/components/menus/bubble-menu/node-selector.tsx", EDITOR_SRC), ["Multiple"]],
  [
    new URL("core/components/links/link-edit-view.tsx", EDITOR_SRC),
    ["Enter or paste URL", "Text", "Enter Text to display", "Remove Link"],
  ],
  [new URL("core/extensions/callout/color-selector.tsx", EDITOR_SRC), ["Color"]],
  [new URL("core/extensions/code/code-block-node-view.tsx", EDITOR_SRC), ["Copy code"]],
  [new URL("core/extensions/custom-image/components/toolbar/alignment.tsx", EDITOR_SRC), ["Align"]],
  [new URL("core/extensions/custom-image/components/toolbar/download.tsx", EDITOR_SRC), ["Download", "Download image"]],
  [
    new URL("core/extensions/custom-image/components/toolbar/full-screen/modal.tsx", EDITOR_SRC),
    ["Fullscreen image viewer", "Close image viewer", "Zoom out", "Zoom in", "Download image", "Open image in new tab"],
  ],
  [
    new URL("core/extensions/custom-image/components/toolbar/full-screen/root.tsx", EDITOR_SRC),
    ["View in full screen", "View image in full screen"],
  ],
  [
    new URL("core/extensions/custom-image/components/uploader.tsx", EDITOR_SRC),
    ["Error loading image", "Uploading...", "Drop image here", "Add an image", "Retry duplication", "Retry"],
  ],
  [new URL("core/extensions/custom-image/utils.ts", EDITOR_SRC), ["Left", "Center", "Right"]],
  [new URL("core/helpers/file.ts", EDITOR_SRC), ["No file selected", "Invalid file type.", "File size too large"]],
  [new URL("core/extensions/emoji/components/emojis-list.tsx", EDITOR_SRC), ["No emojis found"]],
  [new URL("core/extensions/mentions/mentions-list-dropdown.tsx", EDITOR_SRC), ["Loading...", "No results"]],
  [new URL("core/extensions/placeholder.ts", EDITOR_SRC), ["Heading ", "Press '/' for commands..."]],
  [new URL("core/hooks/use-title-editor.ts", EDITOR_SRC), ["Untitled"]],
  [
    new URL("core/extensions/slash-commands/command-items-list.tsx", EDITOR_SRC),
    [
      "Just start typing with plain text.",
      ...HEADINGS,
      "Big section heading.",
      "Medium section heading.",
      "Small section heading.",
      "Numbered list",
      "Create a numbered list.",
      "Bulleted list",
      "Create a bulleted list.",
      "To-do list",
      "Create a to-do list.",
      "Create a table",
      "Capture a quote.",
      "Capture a code snippet.",
      "Callout",
      "Insert callout",
      "Divider",
      "Visually divide blocks.",
      "Emoji",
      "Insert an emoji",
      "Colors",
      "Default",
      "Change text color",
      "Background colors",
      "Change background color",
      "Insert an image",
    ],
  ],
  [
    new URL("core/extensions/table/plugins/drag-handles/color-selector.tsx", EDITOR_SRC),
    ["Color", "Background colors"],
  ],
  [
    new URL("core/extensions/table/plugins/drag-handles/column/dropdown.tsx", EDITOR_SRC),
    ["Insert left", "Insert right", "Duplicate", "Clear contents", "Delete", "Header column"],
  ],
  [
    new URL("core/extensions/table/plugins/drag-handles/row/dropdown.tsx", EDITOR_SRC),
    ["Insert above", "Insert below", "Duplicate", "Clear contents", "Delete", "Header row"],
  ],
  [new URL("core/extensions/table/plugins/insert-handlers/utils.ts", EDITOR_SRC), ["Insert columns", "Insert rows"]],
];

describe("no English leftovers in notifications, intake, workspace settings and the editor (line R2)", () => {
  it.each(R2_CASES)("%s shows no bare English", (file, phrases) => {
    const { present, ungated } = scanPpmLiterals(file, phrases);
    expect(ungated).toEqual([]);
    expect(present.length, `${file.pathname}: none of the phrases is left even as a fallback`).toBeGreaterThan(0);
  });

  it("the scanner counts the brand flag and an early return on a flag as a gate (synthetic file)", () => {
    const sample = [
      'const a = IS_PPM_BRAND_ENABLED ? ppmT("k") : "Support gated";',
      'const b = isPpmBrandEnabled(process.env.PPM_BRAND_ENABLED) ? ppmT("k") : "Support call";',
      "function C() {",
      "  if (IS_PPM_BRAND_ENABLED) return <b />;",
      '  const links = [{ label: "Support early" }];',
      "  return <p>{links.length} Support after</p>;",
      "}",
      "function D() {",
      "  if (IS_PPM_BRAND_ENABLED) {",
      "    log();",
      "  }",
      '  return "Support no return";',
      "}",
      "function E() {",
      "  if (!IS_PPM_BRAND_ENABLED) return <b />;",
      '  return "Support negated";',
      "}",
      "function F() {",
      '  const before = "Support before";',
      "  if (isPpmShell) {",
      "    return <b />;",
      "  }",
      '  return before + "Support block return";',
      "}",
      "function G() {",
      "  if (IS_PPM_BRAND_ENABLED) return <b />;",
      "  else log();",
      '  return "Support with else";',
      "}",
    ].join("\n");
    const { ungated } = scanPpmSource(sample, ["Support"]);
    expect(ungated.map((entry) => entry.split(": ")[0])).toEqual(["12", "16", "19", "28"]);
  });

  it("the scanner counts editorText(key, <upstream>) as a fallback (synthetic file)", () => {
    const sample = [
      'const a = editorText("ui.editor.bold", "Bold gated");',
      'const b = editorText("Bold as the key only");',
      'const c = "Bold bare";',
      'const d = { get label() { return editorText("ui.editor.bold", "Bold getter"); } };',
    ].join("\n");
    const { ungated } = scanPpmSource(sample, ["Bold"]);
    expect(ungated.map((entry) => entry.split(": ")[0])).toEqual(["3"]);
  });

  it("module-level option lists keep the upstream labels and are rendered by key in the Russian PPM interface", () => {
    const source = (file: string) => readFileSync(new URL(file, CORE), "utf8");
    // Webhook events: labels and descriptions of INDIVIDUAL_WEBHOOK_OPTIONS.
    const webhookEvents = source("web-hooks/form/individual-event-options.tsx");
    expect(webhookEvents).toMatch(/ppmText\(WEBHOOK_EVENT_TEXT_KEYS\[option\.key\]\.label, option\.label\)/);
    expect(webhookEvents).toMatch(
      /ppmText\(WEBHOOK_EVENT_TEXT_KEYS\[option\.key\]\.description, option\.description\)/
    );
    // API token expiry presets: EXPIRY_DATE_OPTIONS.
    const tokenForm = source("api-token/modal/form.tsx");
    expect(tokenForm.match(/ppmText\(TOKEN_EXPIRY_TEXT_KEYS\[option\.key\], option\.label\)/g)?.length).toBe(1);
    expect(tokenForm).toMatch(/ppmText\(TOKEN_EXPIRY_TEXT_KEYS\[selectedOption\.key\], selectedOption\.label\)/);
    // Intake date presets: PAST_DURATION_FILTER_OPTIONS of @plane/constants.
    expect(source("inbox/inbox-filter/filters/date.tsx")).toMatch(
      /intakeDatePresetName\(option\.value, option\.name\)/
    );
    expect(source("inbox/inbox-filter/applied-filters/date.tsx")).toMatch(
      /intakeDatePresetName\(currentDate\.value, currentDate\.name\)/
    );
    // Export history: column headers and statuses.
    const exportColumns = source("exporter/column.tsx");
    for (const [key, upstream] of [
      ["ui.export.exported_by", "Exported By"],
      ["ui.export.exported_on", "Exported On"],
      ["ui.export.projects", "Exported projects"],
      ["ui.export.format", "Format"],
      ["ui.export.status", "Status"],
      ["ui.export.download", "Download"],
    ])
      expect(exportColumns).toContain(`content: ppmText("${key}", "${upstream}")`);
    expect(exportColumns).toMatch(/exportStatus\(rowData\.status\)/);
    // Comment access tooltips: the Plane keys (en = "Private"/"Public") in the Russian PPM interface.
    expect(source("editor/lite-text/toolbar.tsx")).toMatch(
      /tooltipContent=\{isPpmRu \? t\(access\.i18nLabel\) : access\.label\}/
    );
  });

  it("the notification card speaks Russian through the PPM phrase map in the Russian PPM interface", () => {
    const source = readFileSync(new URL("workspace-notifications/sidebar/notification-card/content.tsx", CORE), "utf8");
    expect(source).toMatch(
      /if \(isPpmRu\) \{\s*const ppm = resolvePpmNotificationPhrase\(fieldData, renderCommentBox\);/
    );
    expect(source).toMatch(/template=\{ppmT\(ppm\.phrase\)\}/);
    const snooze = readFileSync(
      new URL("workspace-notifications/sidebar/notification-card/options/snooze/root.tsx", CORE),
      "utf8"
    );
    expect(snooze.match(/isPpmRu \? ppmT\("ui\.toast\.success"\) : `\$\{t\("common\.success"\)\}!`/g)).toHaveLength(2);
    const modal = readFileSync(
      new URL("workspace-notifications/sidebar/notification-card/options/snooze/modal.tsx", CORE),
      "utf8"
    );
    expect(modal).toMatch(/isPpmRu \? ppmT\("ui\.notification\.am"\) : "AM"/);
    expect(modal).toMatch(/isPpmRu \? ppmT\("ui\.notification\.pm"\) : "PM"/);
  });

  it("the workspace delete confirmation follows the interface language («удалить это пространство», no «ё» to mistype)", () => {
    const source = readFileSync(new URL("workspace/delete-workspace-form.tsx", CORE), "utf8");
    expect(source).toContain('ppmText("ui.ws.delete_phrase", "delete my workspace")');
    expect(source).toMatch(/watch\("confirmDelete"\) === confirmPhrase/);
    expect(getPpmTranslation("ru", "ui.ws.delete_phrase")).toBe("удалить это пространство");
    expect(getPpmTranslation("en", "ui.ws.delete_phrase")).toBe("delete my workspace");
  });

  it("the web registers the editor texts in every editor wrapper and toolbar", () => {
    for (const file of [
      "editor/document/editor.tsx",
      "editor/lite-text/editor.tsx",
      "editor/rich-text/editor.tsx",
      "editor/sticky-editor/editor.tsx",
      "pages/editor/editor-body.tsx",
      "pages/editor/toolbar/toolbar.tsx",
      "editor/lite-text/toolbar.tsx",
      "editor/sticky-editor/toolbar.tsx",
    ])
      expect(readFileSync(new URL(file, CORE), "utf8"), file).toMatch(/usePpmEditorLanguage\(\);/);
  });
});
