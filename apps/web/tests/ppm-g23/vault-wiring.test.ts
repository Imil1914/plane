// G2.3 (G-Web, Review Focus item 4): the Vault note is a plain <textarea>, no @plane/editor — its two buttons must
// insert Markdown (not HTML) through the cursor-preserving helper, only while editable, and the ref must be the
// textarea onChange itself still controls (so typing keeps working around an inserted link).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../core/components/ppm-vault/route.tsx", import.meta.url), "utf8");

describe("Vault note markdown insertion", () => {
  it("attaches the textarea ref the insertion helper needs, on the same textarea onChangeMarkdown controls", () => {
    const start = source.indexOf('id="ppm-vault-markdown-editor"');
    const end = source.indexOf("/>", start);
    const block = source.slice(start, end);
    expect(block).toContain("ref={markdownTextareaRef}");
    expect(block).toContain("onChange={(event) => onChangeMarkdown(event.target.value)}");
  });

  it("both buttons render only for an editable note (canEdit), directly under the Markdown label", () => {
    const labelAt = source.indexOf('htmlFor="ppm-vault-markdown-editor"');
    const guardAt = source.indexOf("{canEdit && (", labelAt);
    const buttonAt = source.indexOf("<InsertGitObjectButton", labelAt);
    expect(guardAt).toBeGreaterThan(labelAt);
    expect(buttonAt).toBeGreaterThan(guardAt);
    expect(buttonAt - guardAt).toBeLessThan(120); // the guard wraps the button div directly, nothing else in between
  });

  it("inserts commit/PR links as Markdown (not the HTML used by @plane/editor call sites)", () => {
    expect(source).toContain('import { buildGitObjectMarkdownLink } from "@/components/ppm-git/insert/format";');
    expect(source).toContain(
      "onInsert={({ label, url }) => insertMarkdownAtCursor(buildGitObjectMarkdownLink(label, url))}"
    );
    expect(source).not.toContain("buildGitObjectHtmlLink");
  });

  it("the work-summary button inserts summary.markdown, not summary.html", () => {
    expect(source).toContain(
      "onInsert={(summary) => insertMarkdownAtCursor(summary.markdown, { ensureOwnLine: true })}"
    );
  });

  it("goes through the execCommand-first helper, not a bare setState replacement (keeps Ctrl+Z on the insertion)", () => {
    const start = source.indexOf("const insertMarkdownAtCursor = ");
    const end = source.indexOf('if (entry.kind === "folder")');
    const body = source.slice(start, end);
    expect(body).toContain("insertTextIntoTextarea(textarea, content, (next) => {");
    expect(body).toContain("onChangeMarkdown(next.value);");
    expect(body).toContain("textarea.setSelectionRange(next.cursorPosition, next.cursorPosition)");
  });

  it(
    "review round 2 (#3): prepends a blank line before the summary only when ensureOwnLine asks for it and the " +
      "caret is not already at the start of a line — a single commit/PR link never opts in",
    () => {
      const start = source.indexOf("const insertMarkdownAtCursor = ");
      const end = source.indexOf('if (entry.kind === "folder")');
      const body = source.slice(start, end);
      expect(body).toContain(
        "const content = options?.ensureOwnLine && needsLeadingNewline(textarea.value, position) ? `\\n\\n${text}` : text;"
      );
      expect(source).toContain(
        'import { insertTextIntoTextarea, needsLeadingNewline } from "@/components/ppm-git/insert/textarea-insert";'
      );
    }
  );
});
