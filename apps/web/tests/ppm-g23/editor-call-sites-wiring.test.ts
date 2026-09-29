// G2.3 (G-Web, G3/G6): «Вставить коммит/PR» must reach the comment editor, both description editors (detail page
// and the creation modal) and the pages toolbar — checked here in source, since each is wired inside a MobX/
// react-hook-form component that route-wiring.test.ts-style regexes suit better than a full render. Every site must
// use the *resolved workspace id*, never the raw slug (PpmGitService's URLs take the id — ppm-git-service.test.ts
// covers the service side; getOverview(workspace.id, projectId) in ppm-git/route.tsx is the existing precedent).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const liteText = readFileSync(new URL("../../core/components/editor/lite-text/editor.tsx", import.meta.url), "utf8");
const descriptionInput = readFileSync(
  new URL("../../core/components/editor/rich-text/description-input/root.tsx", import.meta.url),
  "utf8"
);
const descriptionModal = readFileSync(
  new URL("../../core/components/issues/issue-modal/components/description-editor.tsx", import.meta.url),
  "utf8"
);
const pagesToolbar = readFileSync(
  new URL("../../core/components/pages/editor/toolbar/root.tsx", import.meta.url),
  "utf8"
);
const pageRoot = readFileSync(new URL("../../core/components/pages/editor/page-root.tsx", import.meta.url), "utf8");

describe("comment editor (LiteTextEditor)", () => {
  it("sits next to IssueCommentToolbar, sharing the same resolved editorRef and workspaceId prop", () => {
    const toolbarAt = liteText.indexOf("<IssueCommentToolbar");
    const buttonAt = liteText.indexOf("<InsertGitObjectButton");
    expect(toolbarAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(toolbarAt);
    const block = liteText.slice(buttonAt, buttonAt + 300);
    expect(block).toContain("workspaceId={workspaceId}");
    expect(block).toContain("projectId={projectId}");
  });

  it("inserts an HTML link at the cursor via setEditorValueAtCursorPosition (works on an empty editor, unlike insertText)", () => {
    expect(liteText).toMatch(
      /onInsert=\{\(\{ label, url \}\) =>\s*editorRef\?\.setEditorValueAtCursorPosition\(buildGitObjectHtmlLink\(label, url\)\)\s*\}/
    );
  });
});

describe("description editor — issue detail page (DescriptionInput)", () => {
  it("is only shown while editing is allowed", () => {
    expect(descriptionInput).toContain("{!disabled && (");
  });

  it("uses the already-resolved workspaceDetails.id, and reads editorRef.current lazily (not at render time)", () => {
    const start = descriptionInput.indexOf("<InsertGitObjectButton");
    const end = descriptionInput.indexOf("/>", start);
    const block = descriptionInput.slice(start, end);
    expect(block).toContain("workspaceId={workspaceDetails.id}");
    expect(block).toContain("editorRef?.current?.setEditorValueAtCursorPosition(buildGitObjectHtmlLink(label, url))");
  });
});

describe("description editor — issue creation modal", () => {
  it("only renders once a projectId exists (the modal may not have one yet while creating)", () => {
    const guardAt = descriptionModal.indexOf("{projectId && (");
    const buttonAt = descriptionModal.indexOf("<InsertGitObjectButton");
    expect(guardAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(guardAt);
    expect(buttonAt - guardAt).toBeLessThan(50); // the button is what that guard immediately wraps
  });

  it("uses the resolved workspaceId local (getWorkspaceBySlug(...).id), not the slug prop", () => {
    const start = descriptionModal.indexOf("<InsertGitObjectButton");
    const end = descriptionModal.indexOf("/>", start);
    const block = descriptionModal.slice(start, end);
    expect(block).toContain("workspaceId={workspaceId}");
  });
});

describe("pages toolbar (PageEditorToolbarRoot)", () => {
  it("receives projectId/workspaceSlug from page-root.tsx (both are new props on an existing call)", () => {
    const start = pageRoot.indexOf("<PageEditorToolbarRoot");
    const end = pageRoot.indexOf("/>", start);
    const block = pageRoot.slice(start, end);
    expect(block).toContain("projectId={projectId}");
    expect(block).toContain("workspaceSlug={workspaceSlug}");
  });

  it("resolves the workspace id itself (page-root.tsx only threads the slug down)", () => {
    expect(pagesToolbar).toContain("const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id;");
  });

  it("shows both the insert button and the work-summary button only once editorRef and workspaceId are both ready", () => {
    expect(pagesToolbar).toContain("{editorRef && workspaceId && (");
  });

  it("the work-summary button inserts summary.html (pages use HTML, Vault uses markdown)", () => {
    expect(pagesToolbar).toContain("onInsert={(summary) => editorRef.setEditorValueAtCursorPosition(summary.html)}");
  });
});
