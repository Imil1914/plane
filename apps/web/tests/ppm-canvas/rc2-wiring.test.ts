// RC-2 (AF1.2): pins of how editor.tsx wires the rebase driver. The behaviour itself — queues, catch-up, stale saves,
// the shape under edit — is tested in board-rebase-driver.test.ts (live tldraw editor, fake server); the merge in
// board-rebase(.editor).test.ts. Here: that the editor hands the driver its real refs and events — a teammate's save and
// a stale 409 go to the driver before the pre-RC-2 branches (kept for the flag off), the save reports back to it, the
// «under edit» check includes the focused card field, the texts come from @ppm/brand, and the notice shows in every look.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const editor = read("editor.tsx");
const driver = read("board-rebase-driver.ts");
const rebase = read("board-rebase.ts");
const css = read("canvas.css");
const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");

/** The source without comment lines (the pins are about code, not about what the comments mention). */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
    .join("\n");
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("RC-2 wiring in editor.tsx", () => {
  it("marks balanced RC-2 blocks", () => {
    const opened = editor.split("── RC-2:").length - 1;
    const closed = editor.split("── /RC-2 ──").length - 1;
    expect(opened).toBeGreaterThanOrEqual(10);
    expect(closed).toBe(opened);
  });

  it("reads the PPM_CANVAS_AUTOMERGE build flag, on by default (R-B2)", () => {
    expect(editor).toContain(
      "const PPM_CANVAS_AUTOMERGE = isPpmCanvasAutomergeEnabled(process.env.PPM_CANVAS_AUTOMERGE);"
    );
    expect(editor).toContain("enabled: PPM_CANVAS_AUTOMERGE,");
    expect(viteConfig).toContain('viteEnv.PPM_CANVAS_AUTOMERGE = process.env.PPM_CANVAS_AUTOMERGE ?? "1";');
  });

  it("hands a teammate's save of an editable board to the driver before the old conflict and reload branches", () => {
    const effect = between(editor, "const action = resolveBoardChangeAction({", "const refreshFromServer = async");
    const guard = "if (PPM_CANVAS_AUTOMERGE && editableRef.current && !blockedRef.current) {";
    expect(effect).toContain(guard);
    const flagged = effect.slice(effect.indexOf(guard), effect.indexOf("// ── /RC-2 ──"));
    expect(flagged).toMatch(/void rebaseDriverRef\.current\?\.onRemoteSave\(knownVersion\);\s*return;\s*\}/);
    expect(effect.indexOf(guard)).toBeLessThan(effect.indexOf('if (action === "conflict") {'));
    // The announced version is noted for the catch-up (never lowered — the driver keeps the maximum).
    expect(editor).toContain("rebaseDriverRef.current?.noteKnownVersion(knownVersion)");
  });

  it("reports every save outcome to the driver: a stale 409, a written save and «nothing to save»", () => {
    const flush = between(editor, "const flushSave = useCallback(", "flushSaveRef.current = flushSave;");
    const stale = between(flush, "// ── RC-2: устаревшая база (409 CANVAS_VERSION_CONFLICT)", "// ── /RC-2 ──");
    expect(stale).toContain('error.code === "CANVAS_VERSION_CONFLICT"');
    expect(stale).toContain("await rebaseDriver.onVersionConflict(pending, error.details.current_version);");
    expect(stale).not.toContain("cancelPendingBinding");
    expect(flush).toContain("void rebaseDriverRef.current?.onSaveSettled(true);");
    expect(flush).toContain("void rebaseDriverRef.current?.onSaveSettled(false);");
    expect(flush).toContain("rebaseDriverRef.current?.isPostponed()");
  });

  it("gives the driver the live refs and queues, never copies (C1)", () => {
    const deps = between(
      editor,
      "const rebaseDriverDeps: TPpmCanvasRebaseDriverDeps = {",
      "rebaseDriverRef.current ??="
    );
    for (const wiring of [
      "queuedActivations: queuedBindingActivationsRef,",
      "queuedRemovals: queuedBindingRemovalsRef,",
      "pendingSave: pendingSaveRef,",
      "version: versionRef,",
      "saving: savingRef,",
      "save: () => flushSaveRef.current(),",
      "read: () => service.getBoard(workspaceId, projectId, boardId),",
    ])
      expect(deps).toContain(wiring);
    expect(deps).toContain("approvedProjectionDeletesRef.current.add(shapeId as TLShapeId)");
    expect(deps).toContain("approvedProjectionDeletesRef.current.delete(shapeId as TLShapeId)");
    // Only the rebase's own decisions touch the live queues; they are read after the saved version arrives.
    expect(driver).toContain("refs.queuedActivations.current.delete(id)");
    expect(driver).not.toMatch(/refs\.queued(Activations|Removals)\.current = /);
  });

  it("counts a focused card field as editing and resumes on focusout as well as on the end of tldraw editing (I2)", () => {
    expect(editor).toContain("focusedCardShapeId(document.activeElement, activeEditor.getContainer())");
    expect(editor).toContain('container.addEventListener("focusout", onFocusOut);');
    expect(editor).toContain('container.removeEventListener("focusout", onFocusOut);');
    expect(editor).toContain("void rebaseDriverRef.current?.onEditingMaybeEnded();");
  });

  it("continues the open session when the canvas mounts again in the same page (D-4), drafts after a reload stay manual", () => {
    const cleanup = between(editor, "return () => {\n      active = false;", "initializedRef.current = false;");
    expect(cleanup).toContain("captureOpenCanvasSession(");
    expect(cleanup).toContain("rememberOpenCanvasSession(openSessionKey, openSession)");
    const init = between(editor, "const initialize = async () => {", "void initialize();");
    expect(init).toContain("takeOpenCanvasSession(");
    expect(init).toContain("applyOpenCanvasSession(editor, rebaseDriverRef.current.deps.refs, resumedSession)");
    expect(init).toContain("const recoveryChoices = resumedSession ? [] : availableCandidates;");
    expect(init).toContain("setRecoveryCandidates(recoveryChoices);");
    // The continued session saves right after the mount: the replay with its own ID, a 409 → the driver.
    expect(init.indexOf("void flushSaveRef.current();")).toBeGreaterThan(
      init.indexOf("initializedRef.current = true;")
    );
    // The registry lives in the page (module memory) — a reload starts empty.
    expect(code(driver)).toMatch(/^const openSessions = new Map/m);
  });

  it("never resets the user's undo on the rebase path (R-B3): mergeRemoteChanges, no loadSnapshot/clearHistory", () => {
    // The rebase itself (the driver class) never loads a snapshot or clears history; only the D-4 resume of a fresh mount
    // loads the pre-remount document into an editor whose history is new anyway.
    const rebaseDriver = between(driver, "export class PpmCanvasRebaseDriver", "// ── D-4:");
    expect(code(rebaseDriver)).not.toContain("clearHistory");
    expect(code(rebaseDriver)).not.toContain("loadSnapshot");
    expect(code(rebase)).toContain("store.mergeRemoteChanges(");
    expect(code(rebase)).not.toContain("clearHistory");
    expect(code(rebase)).not.toContain("loadSnapshot");
  });

  it("takes every text from @ppm/brand in the user's language; only the copy label keeps a fallback literal", () => {
    const deps = between(
      editor,
      "const rebaseDriverDeps: TPpmCanvasRebaseDriverDeps = {",
      "rebaseDriverRef.current ??="
    );
    for (const key of [
      "copy_label",
      "local_copy",
      "objects_count",
      "postponed",
      "remote_copy",
      "remote_wins",
      "restored_local",
      "restored_remote",
    ])
      expect(deps).toContain(`ppmT("canvas.rc2.${key}")`);
    expect(code(driver)).not.toMatch(/[А-Яа-яЁё]/);
    expect(code(rebase).match(/"[^"]*[А-Яа-яЁё][^"]*"/g)).toEqual(['"Конфликтная копия"']);
  });

  it("slows the autosave to ~2 s while a teammate is on the board", () => {
    const schedule = between(editor, "const scheduleSave = useCallback(", "scheduleSaveRef.current = scheduleSave;");
    expect(schedule).toContain("canvasAutosaveDelayMs(participantsRef.current, PPM_CANVAS_AUTOSAVE_DELAY_MS)");
  });

  it("shows the non-blocking notice in every look", () => {
    const notice = between(editor, "{mergeNotice && (", "{/* ── /RC-2 ── */}");
    expect(notice).toContain('data-ppm-notice="merge"');
    expect(notice).toContain('role="status"');
    expect(editor).not.toContain("grammarV2 && mergeNotice");
    expect(css).toMatch(/\.ppm-canvas-merge-notice\s*\{[^}]*position:\s*absolute/);
  });

  it("keeps the pre-RC-2 conflict and reload branches for the flag off", () => {
    const effect = between(editor, "const action = resolveBoardChangeAction({", "void refreshFromServer();");
    expect(effect).toContain('if (action === "conflict") {');
    expect(effect).toContain("editor.clearHistory();");
    const flush = between(editor, "const flushSave = useCallback(", "flushSaveRef.current = flushSave;");
    expect(flush).toContain('setSyncStatus("conflict");');
  });
});
