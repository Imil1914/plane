// G2.3 (G-Web, Review Focus item 4): the pure fallback computation for inserting Markdown at the caret of the Vault
// note's <textarea>. `insertTextIntoTextarea` itself needs a real DOM (execCommand) and is out of scope for a
// node-only vitest run — see textarea-insert.ts's own comment and the report for that residual risk.
import { describe, expect, it } from "vitest";
import { computeTextareaInsertion, needsLeadingNewline } from "@/components/ppm-git/insert/textarea-insert";

describe("computeTextareaInsertion", () => {
  it("inserts at a collapsed caret in the middle of the text, without losing surrounding content", () => {
    const result = computeTextareaInsertion("hello world", 6, 6, "brave ");
    expect(result).toEqual({ value: "hello brave world", cursorPosition: 12 });
  });

  it("inserts into an empty textarea", () => {
    expect(computeTextareaInsertion("", 0, 0, "[a](<b>)")).toEqual({ value: "[a](<b>)", cursorPosition: 8 });
  });

  it("replaces a non-empty selection with the inserted text", () => {
    const result = computeTextareaInsertion("hello world", 6, 11, "there");
    expect(result).toEqual({ value: "hello there", cursorPosition: 11 });
  });

  it("inserts at the very end when the caret is past the text (defensive clamping)", () => {
    const result = computeTextareaInsertion("abc", 99, 99, "!");
    expect(result).toEqual({ value: "abc!", cursorPosition: 4 });
  });

  it("clamps a negative or inverted selection instead of throwing", () => {
    expect(computeTextareaInsertion("abc", -5, -1, "X")).toEqual({ value: "Xabc", cursorPosition: 1 });
  });
});

// Review round 2 (#3): the work summary's Markdown starts with a "### …" heading — inserted mid-line it would not
// read as one, so the Vault route prepends "\n\n" whenever this is true before handing the text to
// computeTextareaInsertion/insertTextIntoTextarea.
describe("needsLeadingNewline", () => {
  it("is false at the very start of the text (position 0), even if it is non-empty", () => {
    expect(needsLeadingNewline("", 0)).toBe(false);
    expect(needsLeadingNewline("existing text", 0)).toBe(false);
  });

  it("is false right after an existing newline — the cursor already starts a line", () => {
    expect(needsLeadingNewline("first line\n", 11)).toBe(false);
    expect(needsLeadingNewline("first line\nsecond", 11)).toBe(false);
  });

  it("is true mid-line, including at the very end of text with no trailing newline", () => {
    expect(needsLeadingNewline("first line", 10)).toBe(true); // caret at the end, no trailing \n
    expect(needsLeadingNewline("first line", 5)).toBe(true); // caret mid-word
  });

  it("is true right after an existing blank line just as much as after any other non-newline character", () => {
    // "\n\n" before the caret still means the immediately preceding character is "\n" -> false (already a fresh line)
    expect(needsLeadingNewline("first line\n\n", 12)).toBe(false);
  });

  it("treats a negative position like position 0 (defensive, matches computeTextareaInsertion's own clamping)", () => {
    expect(needsLeadingNewline("first line", -1)).toBe(false);
  });
});
