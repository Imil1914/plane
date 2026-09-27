/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// RC-2 (AF1.2, inventory §3.3): the driver of the open board's rebase — when to rebase, what to do with its result and
// how it meets the save flow. Decisions only: the saved-version read, the save, the queues of server-binding operations,
// the version refs, the «under edit» check and the UI callbacks are injected, so the orchestration is tested by
// behaviour (board-rebase-driver.test.ts, with a live tldraw editor); editor.tsx wires it to its refs and state.
// Rules: a teammate's save and a stale save (409 CANVAS_VERSION_CONFLICT) lead here instead of the conflict mode; at most
// CANVAS_REBASE_MAX_ATTEMPTS stale saves in a row (jittered), then the manual mode; the live queues are never replaced —
// only the rebase's own decisions are applied to them, in the tick of the merge; a version announced during a rebase is
// fetched right after it (bounded, jittered), also on a clean board; the shape under edit is never touched — the rebase
// waits until editing ends (tldraw editing state or the focus of a card field) and then prefers the local version.
import type { TPpmCanvasReadResponse, TPpmCanvasSnapshot } from "@ppm/canvas";
import {
  CANVAS_REBASE_MAX_ATTEMPTS,
  canvasRebaseRetryDelayMs,
  describeCanvasRebase,
  rebaseOpenBoard,
  type TPpmCanvasRebaseEditor,
  type TPpmCanvasRebaseMerged,
  type TPpmCanvasRebaseStep,
  type TPpmCanvasRebaseStrings,
} from "./board-rebase";

export type TPpmCanvasRef<T> = { current: T };

export type TPpmCanvasPendingSave = { binding_changes: { activate: readonly string[]; remove: readonly string[] } };

/** The editor's refs the driver reads and writes (the same objects the save flow uses). */
export type TPpmCanvasRebaseRefs = {
  baseline: TPpmCanvasRef<TPpmCanvasSnapshot | null>;
  blocked: TPpmCanvasRef<boolean>;
  dirty: TPpmCanvasRef<boolean>;
  editable: TPpmCanvasRef<boolean>;
  generation: TPpmCanvasRef<number>;
  initialized: TPpmCanvasRef<boolean>;
  pendingSave: TPpmCanvasRef<unknown>;
  queuedActivations: TPpmCanvasRef<Set<string>>;
  queuedRemovals: TPpmCanvasRef<Set<string>>;
  remoteConflict: TPpmCanvasRef<boolean>;
  saving: TPpmCanvasRef<boolean>;
  version: TPpmCanvasRef<number>;
};

export type TPpmCanvasRebaseDriverDeps = {
  /** Pre-approves a teammate's removal for the projection delete guard; `withdrawApproval` drops an unused one. */
  approveRemoval: (shapeId: string) => void;
  authorId: string;
  canEdit: boolean;
  cancelPendingBinding: (bindingId: string) => Promise<unknown>;
  /** Clears the notice only while it is this text (the «waiting for the end of editing» notice). */
  clearNotice: (text: string) => void;
  clearSaveTimer: () => void;
  createShapeId: () => string;
  editor: () => TPpmCanvasRebaseEditor | undefined;
  enabled: boolean;
  /** The pre-RC-2 conflict mode (draft, cancelled pending activations, read-only, manual merge). */
  enterManualConflict: () => Promise<void>;
  isRetryableError: (error: unknown) => boolean;
  maxBytes: number;
  now: () => string;
  /** UI state after a merge: saved-at time, bindings map (live queues), work item options, semantic edges. */
  onApplied: (remote: TPpmCanvasReadResponse, merge: TPpmCanvasRebaseMerged) => void;
  onNotice: (text: string) => void;
  onStatus: (status: "error" | "saving") => void;
  /** Shapes the user is editing right now: tldraw editing state and the card whose field has the focus. */
  protectedShapeIds: () => readonly string[];
  random: () => number;
  read: () => Promise<TPpmCanvasReadResponse>;
  refs: TPpmCanvasRebaseRefs;
  /** The pre-RC-2 clean reload (`loadSnapshot` + `clearHistory`) for a saved version the merge cannot take. */
  reloadFromRemote: (remote: TPpmCanvasReadResponse) => void;
  /** The editor's autosave (`flushSave`): it reports back through onSaveSettled / onVersionConflict. */
  save: () => Promise<void>;
  scheduleRetry: (run: () => void) => void;
  sleep: (ms: number) => Promise<void>;
  strings: TPpmCanvasRebaseStrings & { postponed: string };
  withdrawApproval: (shapeId: string) => void;
};

export class PpmCanvasRebaseDriver {
  deps: TPpmCanvasRebaseDriverDeps;
  /** Stale saves in a row (R-B6). */
  private attempts = 0;
  /** Catch-up rebases in a row for versions announced meanwhile (bounded like the stale saves). */
  private followUps = 0;
  /** The newest version announced for this board — never lowered. */
  private knownVersion = 0;
  /** Shapes under edit a teammate changed: the rebase waits for the end of their editing. */
  private postponed?: ReadonlySet<string>;
  /** Shapes that were under edit while the rebase waited: a content collision keeps the local version. */
  private readonly preferLocal = new Set<string>();
  /** Rebases in progress: a save inside one does not start its own catch-up. */
  private depth = 0;

  constructor(deps: TPpmCanvasRebaseDriverDeps) {
    this.deps = deps;
  }

  /** A new session of the board (load, reload, the manual mode): nothing carries over. `depth` follows the call stack
   * of rebases still unwinding, so it is left alone. */
  reset(): void {
    this.attempts = 0;
    this.followUps = 0;
    this.knownVersion = 0;
    this.postponed = undefined;
    this.preferLocal.clear();
  }

  get known(): number {
    return this.knownVersion;
  }

  isPostponed(): boolean {
    return this.postponed !== undefined;
  }

  preferredLocalIds(): ReadonlySet<string> {
    return this.preferLocal;
  }

  noteKnownVersion(version: unknown): void {
    if (typeof version === "number" && Number.isInteger(version))
      this.knownVersion = Math.max(this.knownVersion, version);
  }

  private ready(): boolean {
    const { enabled, refs } = this.deps;
    return (
      enabled &&
      this.deps.editor() !== undefined &&
      refs.initialized.current &&
      refs.editable.current &&
      !refs.blocked.current &&
      !refs.remoteConflict.current
    );
  }

  private clean(): boolean {
    const { refs } = this.deps;
    return (
      !refs.dirty.current &&
      !refs.pendingSave.current &&
      refs.queuedActivations.current.size === 0 &&
      refs.queuedRemovals.current.size === 0
    );
  }

  /** A teammate's save was announced (newer than ours, not our own operation). */
  async onRemoteSave(version: number): Promise<void> {
    this.noteKnownVersion(version);
    // A save or rebase in flight catches up when it ends; a postponed rebase runs at the end of editing.
    if (!this.ready() || this.deps.refs.saving.current || this.postponed) return;
    this.followUps = 0;
    await this.run();
  }

  /**
   * The save of `pending` got 409 CANVAS_VERSION_CONFLICT. The server did not write it (a written operation ID would be
   * replayed), so its ID is never reused and its binding operations go back to the live queues — not cancelled.
   */
  async onVersionConflict(pending: TPpmCanvasPendingSave, currentVersion: unknown): Promise<void> {
    const { refs } = this.deps;
    for (const id of pending.binding_changes.activate) refs.queuedActivations.current.add(id);
    for (const id of pending.binding_changes.remove) refs.queuedRemovals.current.add(id);
    if (refs.pendingSave.current === pending) refs.pendingSave.current = undefined;
    refs.dirty.current = true;
    this.noteKnownVersion(currentVersion);
    this.attempts += 1;
    if (this.attempts > CANVAS_REBASE_MAX_ATTEMPTS) {
      this.attempts = 0;
      await this.deps.enterManualConflict();
      return;
    }
    await this.run({ delayMs: canvasRebaseRetryDelayMs(this.attempts - 1, this.deps.random()) });
  }

  /** A save settled (written, or nothing to write): a version announced meanwhile is fetched now. */
  async onSaveSettled(saved: boolean): Promise<void> {
    if (saved) this.attempts = 0;
    if (this.depth > 0) return;
    await this.catchUp();
  }

  /** The tldraw editing state or the focus of a card field changed: a rebase that waited for it runs now. */
  async onEditingMaybeEnded(): Promise<void> {
    const postponed = this.postponed;
    if (!postponed) return;
    const underEdit = new Set(this.deps.protectedShapeIds());
    if ([...postponed].some((id) => underEdit.has(id))) return;
    this.postponed = undefined;
    for (const id of postponed) this.preferLocal.add(id);
    this.deps.clearNotice(this.deps.strings.postponed);
    this.followUps = 0;
    await this.run();
  }

  /** §3.3 steps 2–5 once, then a catch-up when a newer version was announced meanwhile. */
  async run({ delayMs = 0 }: { delayMs?: number } = {}): Promise<void> {
    const { refs } = this.deps;
    const editor = this.deps.editor();
    if (!this.ready() || !editor || refs.saving.current || this.postponed) return;
    if (refs.pendingSave.current) {
      // An unacknowledged save settles first, with its own operation ID (its response may have been lost).
      await this.deps.save();
      return;
    }
    this.depth += 1;
    try {
      await this.runOnce(editor, delayMs);
    } finally {
      this.depth -= 1;
    }
    await this.catchUp();
  }

  private async catchUp(): Promise<void> {
    const { refs } = this.deps;
    if (!this.ready() || refs.saving.current || this.postponed) return;
    if (this.knownVersion <= refs.version.current) {
      this.followUps = 0;
      return;
    }
    if (this.followUps >= CANVAS_REBASE_MAX_ATTEMPTS) return;
    this.followUps += 1;
    await this.run({ delayMs: canvasRebaseRetryDelayMs(this.followUps - 1, this.deps.random()) });
  }

  private postpone(ids: readonly string[]): void {
    this.postponed = new Set(ids);
    this.deps.onNotice(this.deps.strings.postponed);
  }

  private async runOnce(editor: TPpmCanvasRebaseEditor, delayMs: number): Promise<void> {
    const { deps } = this;
    const { refs } = deps;
    const generation = refs.generation.current;
    const isCurrent = () => generation === refs.generation.current && deps.editor() === editor;
    const preferLocalIds = new Set(this.preferLocal);
    const approvals: string[] = [];
    let step: TPpmCanvasRebaseStep = { status: "stale" };
    let failure: "retry" | "stop" | undefined;
    refs.saving.current = true;
    deps.clearSaveTimer();
    // A clean board has nothing to save: no «saving» status for the teammate's save.
    if (!this.clean()) deps.onStatus("saving");
    try {
      if (delayMs > 0) await deps.sleep(delayMs);
      if (isCurrent())
        step = await rebaseOpenBoard({
          // C1: only the rebase's own decisions touch the live queues, in the tick of the merge — an operation queued
          // while the saved version was read survives and goes out with the next save.
          afterApply: (merge) => {
            for (const id of merge.droppedBindingChanges.activate) refs.queuedActivations.current.delete(id);
            for (const id of merge.droppedBindingChanges.remove) refs.queuedRemovals.current.delete(id);
          },
          authorId: deps.authorId,
          base: refs.baseline.current,
          beforeApply: (merge) => {
            for (const id of merge.patch.remove) {
              deps.approveRemoval(id);
              approvals.push(id);
            }
          },
          bindingChanges: () => ({
            activate: [...refs.queuedActivations.current],
            remove: [...refs.queuedRemovals.current],
          }),
          canEdit: deps.canEdit,
          copyLabel: deps.strings.copyLabel,
          createShapeId: deps.createShapeId,
          editor,
          isCurrent,
          maxBytes: deps.maxBytes,
          now: deps.now(),
          preferLocalIds,
          protectedShapeIds: deps.protectedShapeIds,
          read: deps.read,
          version: refs.version.current,
        });
    } catch (error) {
      failure = deps.isRetryableError(error) ? "retry" : "stop";
    } finally {
      for (const id of approvals) deps.withdrawApproval(id);
      refs.saving.current = false;
    }
    if (!isCurrent()) return;
    if (failure === "retry") {
      deps.onStatus("error");
      deps.scheduleRetry(() => void this.run());
      return;
    }
    // The ids preferred for this rebase are settled by it; a postponed rebase keeps them for its next run.
    if (step.status !== "postpone") for (const id of preferLocalIds) this.preferLocal.delete(id);
    if (failure === "stop") {
      if (this.clean()) deps.onStatus("error");
      else await deps.enterManualConflict();
      return;
    }
    switch (step.status) {
      case "stale":
        return;
      case "postpone":
        this.postpone(step.ids);
        return;
      case "manual": {
        if (!this.clean()) {
          await deps.enterManualConflict();
          return;
        }
        // Nothing local to lose: the pre-RC-2 reload — not under the cursor, unless the board has to change now.
        const underEdit = deps.protectedShapeIds();
        if (underEdit.length > 0 && step.reason !== "access" && step.reason !== "corrupt") {
          this.postpone(underEdit);
          return;
        }
        deps.reloadFromRemote(step.remote);
        return;
      }
      case "current":
        this.noteKnownVersion(step.remote.version);
        break;
      case "applied": {
        const { baseline, merge, remote } = step;
        refs.version.current = remote.version;
        this.noteKnownVersion(remote.version);
        refs.baseline.current = baseline;
        for (const id of merge.droppedBindingChanges.activate)
          void deps.cancelPendingBinding(id).catch(() => undefined);
        deps.onApplied(remote, merge);
        const notice = describeCanvasRebase(merge, deps.strings);
        if (notice) deps.onNotice(notice);
        refs.dirty.current = true;
        break;
      }
    }
    // Step 5: the usual save of the live board with the new base version (nothing to send → «saved»).
    await deps.save();
  }
}

// ── D-4: the open session across a remount of the canvas in the same page ──
// On reconnect Plane's workspace wrapper re-reads the user's workspace membership and shows its spinner meanwhile, so the
// whole canvas unmounts and mounts again in the same page (so do other re-renders above it). The new mount must not take
// the tab's own draft for a «draft after reload» (the manual recovery, §3.3 point 7): the page never reloaded, the tab is
// open — its session continues, and its unacknowledged save goes through the driver like any other. The registry lives in
// this module (page memory): after a real reload it is empty, and drafts stay with the manual recovery.

export type TPpmCanvasOpenSession = {
  activations: readonly string[];
  baseline: TPpmCanvasSnapshot | null;
  /** Map entries of the bindings still waiting for activation (the UI map is rebuilt from the server on a mount). */
  bindings: readonly (readonly [string, unknown])[];
  dirty: boolean;
  /** The instance ID of the session's durable draft (the draft the new mount finds). */
  draftId: string;
  pendingSave: unknown;
  removals: readonly string[];
  /** The live document at the unmount — what the user saw. */
  snapshot: TPpmCanvasSnapshot;
  version: number;
};

const openSessions = new Map<string, TPpmCanvasOpenSession>();

/**
 * The session to continue after a remount — only an editable one with something not saved yet. `draftId` is asked only
 * then (the editor writes the draft at that moment); `bindings` — the map entries still waiting for activation.
 */
export function captureOpenCanvasSession(
  editor: { getSnapshot: () => { document: unknown } },
  refs: TPpmCanvasRebaseRefs,
  draftId: string | (() => string | undefined),
  bindings: readonly (readonly [string, unknown])[] | (() => readonly (readonly [string, unknown])[])
): TPpmCanvasOpenSession | undefined {
  if (!refs.initialized.current || !refs.editable.current || refs.blocked.current || refs.remoteConflict.current)
    return undefined;
  const unsaved =
    refs.dirty.current ||
    Boolean(refs.pendingSave.current) ||
    refs.queuedActivations.current.size > 0 ||
    refs.queuedRemovals.current.size > 0;
  if (!unsaved) return undefined;
  const id = typeof draftId === "function" ? draftId() : draftId;
  if (!id) return undefined;
  return {
    activations: [...refs.queuedActivations.current],
    baseline: refs.baseline.current,
    bindings: typeof bindings === "function" ? bindings() : bindings,
    dirty: refs.dirty.current,
    draftId: id,
    pendingSave: refs.pendingSave.current,
    removals: [...refs.queuedRemovals.current],
    snapshot: { document: editor.getSnapshot().document } as TPpmCanvasSnapshot,
    version: refs.version.current,
  };
}

export function rememberOpenCanvasSession(key: string, session: TPpmCanvasOpenSession): void {
  openSessions.set(key, session);
}

/**
 * The remembered session of this board in this page, if a new mount may continue it — taken once. Only while its own
 * draft is the only draft on offer: with a draft of another tab or an earlier page (or none left) everything stays with
 * the manual recovery, as before.
 */
export function takeOpenCanvasSession(
  key: string,
  candidateKeys: readonly string[],
  draftKeyOf: (draftId: string) => string
): TPpmCanvasOpenSession | undefined {
  const session = openSessions.get(key);
  openSessions.delete(key);
  if (!session) return undefined;
  return candidateKeys.length === 1 && candidateKeys[0] === draftKeyOf(session.draftId) ? session : undefined;
}

/**
 * Puts the session back into the freshly mounted editor and its refs — the live document, base, version, the
 * unacknowledged save with its own ID and the queues — as if the canvas had never left; the next save goes on from there.
 */
export function applyOpenCanvasSession(
  editor: { clearHistory: () => unknown; loadSnapshot: (snapshot: never) => unknown },
  refs: TPpmCanvasRebaseRefs,
  session: TPpmCanvasOpenSession
): void {
  editor.loadSnapshot(session.snapshot as never);
  editor.clearHistory();
  refs.version.current = session.version;
  refs.baseline.current = session.baseline;
  refs.pendingSave.current = session.pendingSave;
  refs.queuedActivations.current.clear();
  for (const id of session.activations) refs.queuedActivations.current.add(id);
  refs.queuedRemovals.current.clear();
  for (const id of session.removals) refs.queuedRemovals.current.add(id);
  refs.dirty.current = true;
}
// ── /D-4 ──

export type TPpmCanvasFocusElement = {
  closest: (selector: string) => { getAttribute: (name: string) => string | null } | null;
  getAttribute: (name: string) => string | null;
  isContentEditable?: boolean;
  tagName: string;
};

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * I2: the card whose editable field (a text input, a textarea, contenteditable) has the focus inside this editor — the
 * cards of v1 and several v2 kinds edit their text without tldraw's editing state, so the focus counts as editing.
 */
export function focusedCardShapeId(
  active: TPpmCanvasFocusElement | null | undefined,
  container: { contains: (node: never) => boolean } | undefined
): string | undefined {
  if (!active || !container || !container.contains(active as never)) return undefined;
  const tag = active.tagName.toLowerCase();
  const editable =
    active.isContentEditable === true ||
    tag === "textarea" ||
    (tag === "input" && !NON_TEXT_INPUT_TYPES.has((active.getAttribute("type") ?? "text").toLowerCase()));
  if (!editable) return undefined;
  return active.closest("[data-shape-id]")?.getAttribute("data-shape-id") ?? undefined;
}
