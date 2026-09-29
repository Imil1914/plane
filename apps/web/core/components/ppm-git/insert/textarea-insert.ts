// G2.3 (line G-Web): inserting Git-object/work-summary Markdown into a Vault note's plain <textarea> at the caret,
// keeping the browser's native undo — Ctrl+Z must undo exactly this insertion (Review Focus item 4, G2.3 plan.md).
//
// `document.execCommand("insertText", …)` on a focused, selected textarea is the only reliable cross-browser way to
// do this: the browser treats it as a real text-input transaction (like typing), so it both fires the native `input`
// event React's onChange relies on and stays on the native undo stack. Replacing a controlled value via `setState`
// instead — the pattern `ppm-canvas/code-block.tsx`'s `insertSoftTab` already uses for the Tab key — breaks native
// undo, which is fine for a soft indent but not for this explicit requirement.
//
// Review round 3 (E2E, task-EF-report.md G23-1): in Chrome, `execCommand` can return `true` yet insert nothing.
// `InsertGitObjectDialog.select()` calls `onInsert` *before* `onClose()`, so the dialog (a Headless UI Dialog, with
// its own focus trap) is technically still mounted at the moment this runs `textarea.focus()`; Chrome's trap wins the
// race and keeps focus inside the (closing) dialog, so `execCommand` acts on nothing meaningful there — Firefox's
// trap loses the same race, which is why it worked there. The caller-supplied `selectionStart`/`selectionEnd` (round
// 3: remembered *before* the dialog ever opened, since the textarea's own live selection cannot be trusted once
// something else has taken focus) is applied unconditionally; `execCommandInsertionSucceeded` then checks the
// textarea's value actually changed — not just execCommand's return value — before trusting that path. The fallback,
// `setRangeText` + a manually dispatched `input` event, does not depend on real DOM focus at all (it mutates the
// specific element instance directly), so it works even while focus is still trapped elsewhere; the dispatched
// native `input` event is what makes React's own `onChange` on the textarea fire and update the note's state, the
// same way a real keystroke would.

export type TTextareaInsertion = { value: string; cursorPosition: number };

/** Pure: `insertText` placed between `selectionStart`/`selectionEnd` of `value` (clamped to its bounds), with the
 * resulting caret position placed right after the inserted text — matching what `setRangeText(…, "end")` and
 * execCommand both do natively. Used both as the fallback's actual value/caret math and, on its own, as the only
 * part of this module a node-only test suite (no DOM) can exercise directly. */
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

/** Review round 3 (#G23-1): whether an `execCommand("insertText")` call actually did something, rather than trusting
 * its return value alone — Chrome can return `true` while leaving `textarea.value` completely untouched when the
 * element was not the real `document.activeElement` at the moment of the call (see the module comment above). A
 * `false` return is the more common, honest refusal signal; both are treated the same way: fall back. */
export function execCommandInsertionSucceeded(applied: boolean, valueBefore: string, valueAfter: string): boolean {
  return applied && valueBefore !== valueAfter;
}

/**
 * Inserts `insertText` into `textarea` at the explicit `[selectionStart, selectionEnd]` range — supplied by the
 * caller rather than read live from the element, because by the time this runs the browser's own idea of that
 * textarea's selection may already be stale or gone (round 3: the caller is expected to have remembered it from
 * before anything else — e.g. the insert dialog's search field — ever took focus). Focus and that exact selection
 * are (re-)applied first, then `execCommand("insertText")` is tried so the browser's own undo stack learns about the
 * change when it works; `execCommandInsertionSucceeded` decides whether to trust it. On refusal (by return value or
 * by a no-op value), falls back to `setRangeText` (moves the caret to just after the inserted text on its own, via
 * its `"end"` selection mode — no separate `setSelectionRange` needed) plus a manually dispatched, bubbling `input`
 * event, so the textarea's own `onChange` fires and updates the note's React state exactly as a real keystroke
 * would. The fallback does not preserve native undo (documented residual risk — Ctrl+Z then does nothing or undoes
 * something else, better than the insertion silently failing).
 */
export function insertTextIntoTextarea(
  textarea: HTMLTextAreaElement,
  insertText: string,
  selectionStart: number,
  selectionEnd: number
): void {
  textarea.focus();
  textarea.setSelectionRange(selectionStart, selectionEnd);
  const valueBefore = textarea.value;
  let applied = false;
  try {
    applied =
      typeof document !== "undefined" &&
      typeof document.execCommand === "function" &&
      document.execCommand("insertText", false, insertText);
  } catch {
    applied = false;
  }
  if (execCommandInsertionSucceeded(applied, valueBefore, textarea.value)) return;
  textarea.setRangeText(insertText, selectionStart, selectionEnd, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
