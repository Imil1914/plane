// UX1.1 T: the v1 (wave 0) branch of every Plane file edited by lane T keeps its exact markup literal.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CORE = new URL("../../core/components/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, CORE), "utf8");

const CASES: Array<[string, string]> = [
  [
    "issues/issue-layouts/list/block.tsx",
    '"group/list-block relative flex min-h-11 flex-col gap-3 bg-layer-transparent py-3 text-13 transition-colors hover:bg-layer-transparent-hover"',
  ],
  ["issues/issue-layouts/list/block.tsx", '"cursor-pointer truncate text-body-xs-medium text-primary"'],
  [
    "issues/issue-layouts/list/block-root.tsx",
    "<ListLoaderItemRow shouldAnimate={false} renderForPlaceHolder defaultPropertyCount={4} />",
  ],
  [
    "issues/issue-layouts/list/list-group.tsx",
    '"w-full flex-shrink-0 border-b border-subtle bg-layer-1 py-1 pr-3 hover:bg-layer-1-hover"',
  ],
  ["issues/issue-layouts/list/list-group.tsx", "!collapsedGroups?.group_by.includes(group.id)"],
  [
    "issues/issue-layouts/list/headers/group-by-card.tsx",
    '"group/list-header flex w-full flex-shrink-0 items-center gap-2 py-1.5"',
  ],
  ["issues/issue-layouts/list/headers/group-by-card.tsx", '"Create work item"'],
  ["issues/header.tsx", '<div className="hidden sm:block">{t("issue.add.label")}</div>'],
  ["issues/header.tsx", "<CountChip count={issuesCount} />"],
  ["issues/issue-layouts/filters/header/layout-selection.tsx", '"flex items-center gap-1 rounded-md bg-layer-3 p-1"'],
  [
    "issues/issue-layouts/roots/project-layout-root.tsx",
    'className="relative h-full w-full overflow-auto bg-surface-1"',
  ],
  [
    "issues/issue-layouts/quick-add/button/list.tsx",
    '"flex w-full cursor-pointer items-center gap-2 bg-layer-transparent py-3 hover:bg-layer-transparent-hover"',
  ],
];

describe("lane T keeps the v1 markup literals", () => {
  it.each(CASES)("%s keeps %s", (file, literal) => {
    expect(read(file)).toContain(literal);
  });

  it("the project list root does not observe the peek (v1 root never re-renders on peek open/close)", () => {
    const source = read("issues/issue-layouts/roots/project-layout-root.tsx");
    const root = source.slice(source.indexOf("export const ProjectLayoutRoot"));
    expect(root).not.toMatch(/peekIssue|useIssueDetail\(/);
    // Only the v2 curator slot reads it, and the slot is rendered only in the v2 branch.
    expect(source).toMatch(/function PpmTasksCuratorSlot\([^)]*\) \{\s*const \{ peekIssue \} = useIssueDetail\(\);/);
    expect(root.indexOf("<PpmTasksCuratorSlot")).toBeGreaterThan(root.indexOf("{isDesignV2 ? ("));
    expect(root.indexOf("<PpmTasksCuratorSlot")).toBeLessThan(root.indexOf(") : ("));
  });
});
