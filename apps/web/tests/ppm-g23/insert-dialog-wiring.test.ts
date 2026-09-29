// G2.3 (G-Web): the dialogs' React wiring is checked in the source (as route-wiring.test.ts does for «Код») — the
// keyboard handling (arrows/Enter/Esc via e.code, not e.key), the onInsert payload shape the brief fixes
// (`onInsert({ label, url })`), and the button components' guard clauses are not exercisable as pure functions, but
// are simple enough to assert against the literal source.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const insertSource = readFileSync(
  new URL("../../core/components/ppm-git/insert/insert-git-object-dialog.tsx", import.meta.url),
  "utf8"
);
const summarySource = readFileSync(
  new URL("../../core/components/ppm-git/insert/work-summary-dialog.tsx", import.meta.url),
  "utf8"
);

describe("InsertGitObjectDialog keyboard handling", () => {
  it("maps ArrowDown/ArrowUp/Enter through event.code, not event.key", () => {
    expect(insertSource).toContain('event.code === "ArrowDown"');
    expect(insertSource).toContain('event.code === "ArrowUp"');
    expect(insertSource).toContain('event.code === "Enter"');
    expect(insertSource).not.toMatch(/event\.key === "Arrow/);
  });

  it("ArrowDown/ArrowUp move the highlight and prevent the input's own caret movement", () => {
    const start = insertSource.indexOf("const onListKeyDown");
    const end = insertSource.indexOf("const emptyStateKind");
    const body = insertSource.slice(start, end);
    expect(body).toMatch(/ArrowDown"\)\s*{\s*event\.preventDefault\(\);\s*picker\.moveHighlight\(1\);/);
    expect(body).toMatch(/ArrowUp"\)\s*{\s*event\.preventDefault\(\);\s*picker\.moveHighlight\(-1\);/);
    expect(body).toContain("select(picker.selectHighlighted());");
  });

  it("Escape closes through the shared ppm-dialog-dismiss helper, like the other «Код» dialogs", () => {
    expect(insertSource).toContain(
      'import { handlePpmDialogKeyDown, shouldDismissPpmDialog } from "@/helpers/ppm-dialog-dismiss.helper";'
    );
    expect(insertSource).toContain("onKeyDown={(event) => handlePpmDialogKeyDown(event, { saving: false, onClose })}");
  });
});

describe("InsertGitObjectDialog selection", () => {
  it("builds the fixed onInsert payload shape from the API's label + canonical_url, then closes", () => {
    const start = insertSource.indexOf("const select = ");
    const end = insertSource.indexOf("const onListKeyDown");
    const body = insertSource.slice(start, end);
    expect(body).toContain("onInsert({ label: item.label, url: item.canonical_url });");
    expect(body).toContain("onClose();");
  });

  it("tells the three empty states apart with the pure classifier, not ad-hoc logic (review round 2 #2)", () => {
    expect(insertSource).toContain(
      "classifyGitObjectEmptyState(state.appliedQuery, state.items.length, state.hasRepositories)"
    );
    expect(insertSource).toContain("g23.insert.empty_no_repositories");
    expect(insertSource).toContain("g23.insert.empty_no_objects");
    expect(insertSource).toContain("g23.insert.empty_not_found");
    expect(insertSource).not.toContain("isNoRepositoriesEmptyState");
  });

  it("review round 2 (#2): checks hasRepositories through the existing «Код» overview, not a new endpoint", () => {
    expect(insertSource).toContain("checkHasRepositories: async () => {");
    expect(insertSource).toContain("gitService.getOverview(workspaceId, projectId)");
    expect(insertSource).toContain('overview.repositories.some((repository) => repository.status === "active")');
  });
});

describe("InsertGitObjectButton", () => {
  it("renders nothing without a projectId (no half-working button in an unready context)", () => {
    const start = insertSource.indexOf("export function InsertGitObjectButton");
    const body = insertSource.slice(start);
    expect(body).toContain("if (!projectId) return null;");
  });

  it("opens the same dialog on click and forwards onInsert unchanged", () => {
    const start = insertSource.indexOf("export function InsertGitObjectButton");
    const body = insertSource.slice(start);
    expect(body).toContain("onClick={() => setOpen(true)}");
    expect(body).toMatch(/<InsertGitObjectDialog\s+open=\{open\}/);
    expect(body).toContain("onInsert={onInsert}");
  });
});

describe("WorkSummaryDialog insert action", () => {
  it("disables Insert while loading or before a summary has arrived", () => {
    expect(summarySource).toContain("disabled={!state.summary || state.loading}");
  });

  it("hands the caller the whole summary (both html and markdown), not a pre-chosen format", () => {
    const start = summarySource.indexOf("onClick={() => {");
    const body = summarySource.slice(start, start + 120);
    expect(body).toContain("if (state.summary) onInsert(state.summary);");
  });

  it("date inputs are disabled/hidden outside the 'custom' preset and clamp against each other", () => {
    expect(summarySource).toContain('state.preset === "custom" &&');
    expect(summarySource).toContain("max={state.to || undefined}");
    expect(summarySource).toContain("min={state.from || undefined}");
  });
});
