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
