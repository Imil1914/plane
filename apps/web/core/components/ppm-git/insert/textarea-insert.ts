// G2.3 (line G-Web): inserting Git-object/work-summary Markdown into a Vault note's plain <textarea> at the caret,
// keeping the browser's native undo — Ctrl+Z must undo exactly this insertion (Review Focus item 4, G2.3 plan.md).
//
// `document.execCommand("insertText", …)` on a focused, selected textarea is the only reliable cross-browser way to
// do this: the browser treats it as a real text-input transaction (like typing), so it both fires the native `input`
// event React's onChange relies on and stays on the native undo stack. Replacing a controlled value via `setState`
// instead — the pattern `ppm-canvas/code-block.tsx`'s `insertSoftTab` already uses for the Tab key — breaks native
// undo, which is fine for a soft indent but not for this explicit requirement. `computeTextareaInsertion` is the pure
// fallback for the rare environment without execCommand, and is what vitest (node, no DOM) actually exercises; the
// execCommand path itself needs a real browser to verify (noted as a risk in the report — no jsdom in this suite).

export type TTextareaInsertion = { value: string; cursorPosition: number };

/** Pure: `insertText` placed between `selectionStart`/`selectionEnd` of `value` (clamped to its bounds), with the
 * resulting caret position placed right after the inserted text — matching what execCommand does natively. */
export function computeTextareaInsertion(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  insertText: string
): TTextareaInsertion {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const nextValue = value.slice(0, start) + insertText + value.slice(end);
  return { value: nextValue, cursorPosition: start + insertText.length };
}

/** Review round 2 (#3): whether inserting Markdown at `position` needs a blank line first, so a block-level
 * construct (e.g. the work summary's leading "### …" heading) starts its own line instead of gluing onto whatever
 * precedes the cursor mid-line — true unless `position` is already at the very start of the text or immediately
 * follows a newline (i.e., the cursor already sits at the start of a line). */
export function needsLeadingNewline(value: string, position: number): boolean {
  if (position <= 0) return false;
  return value[position - 1] !== "\n";
}

/**
 * Inserts `insertText` into `textarea` at its current selection (or at the caret, when nothing is selected). Tries
 * `execCommand("insertText")` first so the browser's own undo stack learns about the change; falls back to
 * `onFallback` — the pure computation above — only when execCommand is unavailable or refuses. The fallback path
 * does not preserve native undo; the caller is responsible for applying `next.value` to its own state and restoring
 * `next.cursorPosition` (via `setSelectionRange` after the next render, since a controlled-value update re-renders
 * the element first).
 */
export function insertTextIntoTextarea(
  textarea: HTMLTextAreaElement,
  insertText: string,
  onFallback: (next: TTextareaInsertion) => void
): void {
  textarea.focus();
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.setSelectionRange(start, end);
  let applied = false;
  try {
    applied =
      typeof document !== "undefined" &&
      typeof document.execCommand === "function" &&
      document.execCommand("insertText", false, insertText);
  } catch {
    applied = false;
  }
  if (applied) return;
  onFallback(computeTextareaInsertion(textarea.value, start, end, insertText));
}
