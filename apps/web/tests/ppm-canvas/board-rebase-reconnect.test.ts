// RC-2 (AF1.2), D-4 (lane G, browser gate): an offline edit, then the connection comes back. On reconnect Plane's
// workspace wrapper re-reads the user's workspace membership and shows its spinner meanwhile
// (`fetchUserWorkspaceInfo` → `loader`), so the whole canvas unmounts and mounts again in the same page. The new mount
// found the tab's own draft and offered it as a «draft after reload» — the manual, read-only recovery. In an open tab the
// session has to continue instead: the unacknowledged save is replayed with its own ID, gets 409, is rebased onto the
// teammate's version and saved — as any other stale save. After a real reload (a new page) nothing is remembered and the
// draft stays manual (§3.3 point 7).
import { describe, expect, it } from "vitest";
import type { TLShapeId } from "tldraw";
import {
  applyOpenCanvasSession,
  captureOpenCanvasSession,
  rememberOpenCanvasSession,
  takeOpenCanvasSession,
} from "@/components/ppm-canvas/board-rebase-driver";
import { FakeBoardServer, harness, renameOnServer, shapeIdsOf } from "./fixtures/rc2-driver";
import { card, documentOf, titleOf, useTldrawInNode } from "./fixtures/rc2-tldraw";

const { createEditor } = useTldrawInNode();

const draftKeyOf = (draftId: string) => `ppm:canvas:durable-recovery:v1:board:${draftId}`;

describe("RC-2: reconnect after an offline edit (D-4)", () => {
  it("continues the open session after a remount: the replayed save gets 409, is rebased and saved", async () => {
    const editorA = createEditor();
    const note = card(editorA, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editorA));
    const a = harness(editorA, server);

    // Offline: the new note cannot be saved; the unacknowledged operation (and its ID) is kept.
    server.offline = true;
    let offlineNote: TLShapeId | undefined;
    a.userEdit(() => {
      offlineNote = card(editorA, "offline-note", "Written offline");
    });
    await a.flushSave();
    expect(a.log.networkErrors).toBe(1);
    const unacknowledged = a.refs.pendingSave.current as { client_operation_id: string } | undefined;
    expect(unacknowledged).toBeDefined();
    // A teammate saves meanwhile.
    const teamVersion = server.teammateSave(renameOnServer(note, "Renamed by a teammate"));

    // Reconnect: the canvas unmounts (its cleanup remembers the open session and keeps the draft) and mounts again.
    server.offline = false;
    const session = captureOpenCanvasSession(editorA, a.refs, "tab-draft", []);
    expect(session).toBeDefined();
    rememberOpenCanvasSession("board", session!);
    const editorB = createEditor();
    editorB.loadSnapshot(server.snapshot as never);
    editorB.clearHistory();
    const b = harness(editorB, server);
    expect(b.refs.version.current).toBe(teamVersion);

    // The mount finds its own draft as the only draft on offer: the session continues instead of the manual recovery.
    const resumed = takeOpenCanvasSession("board", [draftKeyOf("tab-draft")], draftKeyOf);
    expect(resumed).toBeDefined();
    applyOpenCanvasSession(editorB, b.refs, resumed!);
    expect(b.refs.pendingSave.current).toEqual(unacknowledged);
    expect(editorB.getShape(offlineNote!)).toBeDefined();
    await b.flushSave();
    await b.settle();

    expect(b.log.manual).toBe(0);
    expect(b.log.otherConflicts).toEqual([]);
    expect(server.version).toBe(teamVersion + 1);
    expect(shapeIdsOf(server.snapshot).has(offlineNote!)).toBe(true);
    expect(titleOf(editorB, note)).toBe("Renamed by a teammate");
    expect(b.refs.pendingSave.current).toBeUndefined();
    expect(b.refs.dirty.current).toBe(false);
    // The replay carried the original operation ID (409 — never written), then a new operation was saved.
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]?.client_operation_id).not.toBe(unacknowledged?.client_operation_id);
  });

  it("replays a save whose answer was lost with its own ID after the remount, without writing it twice", async () => {
    const editorA = createEditor();
    card(editorA, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editorA));
    const a = harness(editorA, server);
    let newNote: TLShapeId | undefined;
    a.userEdit(() => {
      newNote = card(editorA, "new-note", "New");
    });
    // The save is written, but its answer is lost: the page keeps the operation as unacknowledged.
    server.loseNextAnswer = true;
    await a.flushSave();
    expect(server.saves).toHaveLength(1);
    expect(a.refs.pendingSave.current).toBeDefined();

    rememberOpenCanvasSession("board", captureOpenCanvasSession(editorA, a.refs, "tab-draft", [])!);
    const editorB = createEditor();
    editorB.loadSnapshot(server.snapshot as never);
    editorB.clearHistory();
    const b = harness(editorB, server);
    applyOpenCanvasSession(editorB, b.refs, takeOpenCanvasSession("board", [draftKeyOf("tab-draft")], draftKeyOf)!);
    await b.flushSave();
    await b.settle();

    // The replay returns the first write: one version, no conflict, nothing left to save.
    expect(server.saves).toHaveLength(1);
    expect(b.refs.version.current).toBe(server.version);
    expect(b.refs.pendingSave.current).toBeUndefined();
    expect(b.log.manual + b.log.otherConflicts.length).toBe(0);
    expect(editorB.getShape(newNote!)).toBeDefined();
  });
});

describe("RC-2: what a new mount may continue", () => {
  it("continues only its own session, once, and only while its own draft is the only draft on offer", () => {
    const session = {
      activations: [],
      baseline: null,
      bindings: [],
      dirty: true,
      draftId: "tab-draft",
      pendingSave: undefined,
      removals: [],
      snapshot: { document: { schema: {}, store: {} } },
      version: 3,
    };
    // A new page (a reload): nothing is remembered — the draft stays with the manual recovery.
    expect(takeOpenCanvasSession("fresh", [draftKeyOf("tab-draft")], draftKeyOf)).toBeUndefined();
    // The draft of another tab or an earlier page is on offer too: all of them stay manual.
    rememberOpenCanvasSession("board", session);
    expect(takeOpenCanvasSession("board", [draftKeyOf("tab-draft"), draftKeyOf("other")], draftKeyOf)).toBeUndefined();
    // Taken once: a second mount does not continue the same session again.
    rememberOpenCanvasSession("board", session);
    expect(takeOpenCanvasSession("board", [draftKeyOf("tab-draft")], draftKeyOf)).toEqual(session);
    expect(takeOpenCanvasSession("board", [draftKeyOf("tab-draft")], draftKeyOf)).toBeUndefined();
    // Its draft is gone (the last save went through before the remount): nothing to continue.
    rememberOpenCanvasSession("board", session);
    expect(takeOpenCanvasSession("board", [], draftKeyOf)).toBeUndefined();
  });
});
