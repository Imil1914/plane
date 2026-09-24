// UX0.2 Task 16: icon-only buttons on the work-item detail page must carry an accessible name
// (aria-label/ariaLabel/aria-labelledby). Static scan of the files listed in
// docs/superpowers/plans/2026-09-24-ux02/notes/a11y.md §4.1.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import { LITE_TOOLBAR_A11Y_KEY } from "@/components/editor/lite-text/toolbar-a11y";

const CORE = new URL("../../core/components/", import.meta.url);
// Paths per notes/a11y.md §4.1 — the implementer verifies each with rg before running.
const FILES = [
  "issues/issue-detail/issue-detail-quick-actions.tsx",
  "issues/issue-detail/subscription.tsx",
  "issues/issue-detail/issue-activity/sort-root.tsx",
  "issues/issue-detail/issue-activity/activity-filter.tsx",
  "issues/issue-layouts/filters/header/layout-selection.tsx",
].map((f) => new URL(f, CORE));

// An IconButton or icon-only <button> element (opening tag up to its first ">") must carry a name.
const unnamed = (source: string) =>
  [...source.matchAll(/<(IconButton|button)\b[^>]*>/gs)]
    .map((m) => m[0])
    .filter(
      (tag) =>
        (tag.startsWith("<IconButton") || /icon/i.test(tag)) && !/aria-label=|ariaLabel=|aria-labelledby=/.test(tag)
    );

describe("icon-only buttons have accessible names", () => {
  it.each(FILES.map((u) => [u.pathname.split("/components/")[1], u] as const))("%s", (_name, url) => {
    expect(unnamed(readFileSync(url, "utf8"))).toEqual([]);
  });
});

// UX0.2 final fix F3: the comment (lite) editor toolbar renders one button per ToolbarMenuItem with only an
// icon inside. Names are looked up by renderKey, which is unique per button — the three alignment buttons
// share the itemKey "text-align" and were left unnamed when names were keyed by itemKey.
describe("comment editor toolbar buttons have accessible names", () => {
  const editorConstants = readFileSync(
    new URL("../../../../packages/editor/src/core/constants/common.ts", import.meta.url),
    "utf8"
  );
  const liteRenderKeys = [...editorConstants.matchAll(/renderKey:\s*"([^"]+)"[^}]*?editors:\s*\[([^\]]*)\]/gs)]
    .filter((m) => m[2].includes('"lite"'))
    .map((m) => m[1]);

  it("covers every lite toolbar button, including the three alignment buttons", () => {
    expect(liteRenderKeys).toEqual(
      expect.arrayContaining(["bold", "text-align-left", "text-align-center", "text-align-right", "image"])
    );
    expect(liteRenderKeys.filter((key) => !LITE_TOOLBAR_A11Y_KEY[key])).toEqual([]);
  });

  it("gives each button a distinct Russian and English name", () => {
    for (const locale of ["ru", "en"]) {
      const names = liteRenderKeys.map((key) => getPpmTranslation(locale, LITE_TOOLBAR_A11Y_KEY[key]));
      expect(names.every((name) => typeof name === "string" && name.trim().length > 0)).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
    expect(getPpmTranslation("ru", LITE_TOOLBAR_A11Y_KEY["text-align-left"])).toBe("Выровнять по левому краю");
  });

  it("toolbar.tsx labels the buttons by renderKey, falling back to the upstream item name", () => {
    const toolbar = readFileSync(new URL("editor/lite-text/toolbar.tsx", CORE), "utf8");
    expect(toolbar).toMatch(
      /aria-label=\{\s*LITE_TOOLBAR_A11Y_KEY\[item\.renderKey\]\s*\?\s*ppmT\(LITE_TOOLBAR_A11Y_KEY\[item\.renderKey\]\)\s*:\s*item\.name\s*\}/
    );
  });
});
