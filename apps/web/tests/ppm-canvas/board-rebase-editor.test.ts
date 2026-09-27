// RC-2 (AF1.2): the editor side of the rebase against a real tldraw 3.15.6 Editor (node + a tiny DOM stand-in) —
// pins the tldraw semantics §3.3 relies on: `mergeRemoteChanges` is not a user change (no autosave trigger, no undo
// entry, the user's undo stays theirs), the editor's own delete side effect still runs for remote changes (bindings of a
// removed shape go, the selection is cleaned), a PPM delete guard can refuse a remote removal unless pre-approved — and
// then nothing of the patch stays (all or nothing), the snapshot of an older client is migrated, and one rebase step
// end to end (applied / postpone / manual / stale).
import { describe, expect, it } from "vitest";
import { createBindingId, createShapeId, type TLRecord } from "tldraw";
import type { TPpmCanvasSnapshot } from "@ppm/canvas";
import { sameCanvasSnapshots, stableCanvasJson } from "@/components/ppm-canvas/board-recovery";
import { applyCanvasRebasePatch, normalizeCanvasSnapshot, rebaseOpenBoard } from "@/components/ppm-canvas/board-rebase";
import {
  card,
  documentOf,
  flushListeners,
  geo,
  readResponse,
  recordOf,
  titleOf,
  useTldrawInNode,
  withRecords,
  withTitle,
} from "./fixtures/rc2-tldraw";

const { createEditor } = useTldrawInNode();

const COPY_LABEL = "Conflict copy";

function stepOptions(editor: ReturnType<typeof createEditor>, base: TPpmCanvasSnapshot) {
  return {
    authorId: "me",
    base,
    bindingChanges: () => ({ activate: [], remove: [] }),
    canEdit: true,
    copyLabel: COPY_LABEL,
    createShapeId: () => createShapeId(),
    editor,
    isCurrent: () => true,
    maxBytes: 2 * 1024 * 1024,
    now: "2026-09-27T01:45:00.000Z",
    protectedShapeIds: () => [] as string[],
  };
}

describe("RC-2 rebase in a real tldraw editor", () => {
  it("applies the teammate's records as a remote change: no autosave trigger, no undo entry", async () => {
    const editor = createEditor();
    const mine = geo(editor, "mine");
    const theirs = geo(editor, "theirs", 300);
    editor.clearHistory();
    editor.updateShape({ id: mine, type: "geo", x: 50 });
    const heard: string[] = [];
    const stop = editor.store.listen(
      ({ changes }) => heard.push(...Object.keys(changes.updated), ...Object.keys(changes.added)),
      { scope: "document", source: "user" }
    );
    const moved = { ...editor.getShape(theirs)!, x: 500 } as TLRecord;
    expect(applyCanvasRebasePatch(editor.store, { put: [moved as never], remove: [] })).toBe(true);
    await flushListeners();
    stop();
    expect(heard).toEqual([]);
    // The user's undo still reverts only the user's own edit; the teammate's move stays.
    editor.undo();
    expect(editor.getShape(mine)?.x).toBe(0);
    expect(editor.getShape(theirs)?.x).toBe(500);
    editor.undo();
    expect(editor.getShape(theirs)?.x).toBe(500);
  });

  it("keeps the editor's delete side effect for a remote removal: bindings go, the selection is cleaned", () => {
    const editor = createEditor();
    const start = geo(editor, "start");
    const end = geo(editor, "end", 300);
    const arrowId = createShapeId("arrow");
    editor.createShape({ id: arrowId, type: "arrow", x: 50, y: 50 });
    editor.createBindings([
      {
        fromId: arrowId,
        id: createBindingId("start"),
        props: { isExact: false, isPrecise: false, normalizedAnchor: { x: 0.5, y: 0.5 }, terminal: "start" },
        toId: start,
        type: "arrow",
      },
      {
        fromId: arrowId,
        id: createBindingId("end"),
        props: { isExact: false, isPrecise: false, normalizedAnchor: { x: 0.5, y: 0.5 }, terminal: "end" },
        toId: end,
        type: "arrow",
      },
    ]);
    editor.select(end);
    expect(applyCanvasRebasePatch(editor.store, { put: [], remove: [end] })).toBe(true);
    expect(editor.getShape(end)).toBeUndefined();
    expect(editor.store.has(createBindingId("end"))).toBe(false);
    expect(editor.store.has(createBindingId("start"))).toBe(true);
    expect(editor.getSelectedShapeIds()).toEqual([]);
  });

  it("applies a patch all or nothing: a removal a PPM delete guard refuses rolls the rest back", () => {
    const editor = createEditor();
    const guarded = card(editor, "projection", "Work item");
    const other = geo(editor, "other");
    const approved = new Set<string>();
    const stopGuard = editor.sideEffects.registerBeforeDeleteHandler("shape", (shape) =>
      shape.id === guarded && !approved.delete(shape.id) ? false : undefined
    );
    const before = stableCanvasJson(documentOf(editor).document);
    const moved = { ...editor.getShape(other)!, x: 777 } as TLRecord;
    expect(applyCanvasRebasePatch(editor.store, { put: [moved as never], remove: [guarded] })).toBe(false);
    // Nothing of the refused patch stayed: the teammate's move is rolled back together with the refused removal.
    expect(stableCanvasJson(documentOf(editor).document)).toBe(before);
    approved.add(guarded);
    expect(applyCanvasRebasePatch(editor.store, { put: [moved as never], remove: [guarded] })).toBe(true);
    expect(editor.getShape(guarded)).toBeUndefined();
    expect(editor.getShape(other)?.x).toBe(777);
    stopGuard();
  });

  it("migrates a snapshot of an older client, refuses one from a newer client, reads a never-saved board as empty", () => {
    const editor = createEditor();
    geo(editor, "shape");
    const current = documentOf(editor);
    const { schema, store } = current.document as {
      schema: { sequences: Record<string, number> };
      store: Record<string, Record<string, unknown>>;
    };
    const oldDocument = { ...store["document:document"] };
    delete oldDocument.meta;
    const older: TPpmCanvasSnapshot = {
      document: {
        schema: { ...schema, sequences: { ...schema.sequences, "com.tldraw.document": 1 } },
        store: { ...store, "document:document": oldDocument },
      },
    };
    const migrated = normalizeCanvasSnapshot(editor.store, older);
    expect(migrated && sameCanvasSnapshots(migrated, current)).toBe(true);
    const newer: TPpmCanvasSnapshot = {
      document: { schema: { ...schema, sequences: { ...schema.sequences, "com.tldraw.document": 99 } }, store },
    };
    expect(normalizeCanvasSnapshot(editor.store, newer)).toBeUndefined();
    expect(normalizeCanvasSnapshot(editor.store, null)).toEqual({
      document: { schema: editor.store.schema.serialize(), store: {} },
    });
  });

  it("rebases the open board end to end and leaves exactly the snapshot to save in the editor", async () => {
    const editor = createEditor();
    const mine = card(editor, "mine", "Mine");
    const shared = card(editor, "shared", "Shared");
    const base = documentOf(editor);
    editor.clearHistory();
    editor.updateShape({ id: mine, type: "ppm-canvas-node", x: 120 });
    const teammateEdit = withTitle(editor.getShape(shared)! as unknown as TLRecord, "Renamed by a teammate");
    const remote = withRecords(base, [teammateEdit]);
    const step = await rebaseOpenBoard({
      ...stepOptions(editor, base),
      read: async () => readResponse(remote, 8),
      version: 7,
    });
    expect(step.status).toBe("applied");
    if (step.status !== "applied") return;
    expect(editor.getShape(mine)?.x).toBe(120);
    expect(titleOf(editor, shared)).toBe("Renamed by a teammate");
    expect(stableCanvasJson(documentOf(editor).document)).toBe(stableCanvasJson(step.merge.snapshot.document));
    // Undo keeps belonging to the user: it reverts the local move, not the teammate's title.
    editor.undo();
    expect(editor.getShape(mine)?.x).toBe(0);
    expect(titleOf(editor, shared)).toBe("Renamed by a teammate");
  });

  it("writes the copy label it is given (the user's language) for one text edited on both sides", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const base = documentOf(editor);
    editor.updateShape(withTitle(editor.getShape(note)! as unknown as TLRecord, "Mine") as never);
    const remote = withRecords(base, [withTitle(recordOf(base, "shape:note"), "Theirs")]);
    const step = await rebaseOpenBoard({
      ...stepOptions(editor, base),
      createShapeId: () => createShapeId("copy"),
      read: async () => readResponse(remote, 2),
      version: 1,
    });
    expect(step.status).toBe("applied");
    expect(titleOf(editor, note)).toBe("Theirs");
    expect(titleOf(editor, createShapeId("copy"))).toBe(`${COPY_LABEL} · Mine`);
  });

  it("waits while the teammate changed a shape under edit — tldraw's editing state or a focused card field", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const base = documentOf(editor);
    const remote = withRecords(base, [withTitle(recordOf(base, "shape:note"), "Theirs")]);
    const before = stableCanvasJson(documentOf(editor).document);
    // A focused field of a card (v1 cards, v2 documents/checklists/tables) counts the same as tldraw's editing state.
    const focused = await rebaseOpenBoard({
      ...stepOptions(editor, base),
      protectedShapeIds: () => [note],
      read: async () => readResponse(remote, 2),
      version: 1,
    });
    expect(focused).toEqual({ ids: [note], status: "postpone" });
    expect(stableCanvasJson(documentOf(editor).document)).toBe(before);
  });

  it("does nothing for a stale read, a current version, lost access or a corrupt board", async () => {
    const editor = createEditor();
    card(editor, "note", "Plan");
    const base = documentOf(editor);
    const common = { ...stepOptions(editor, base), version: 3 };
    const next = readResponse(withRecords(base, [], ["shape:note"]), 4);
    expect(await rebaseOpenBoard({ ...common, isCurrent: () => false, read: async () => next })).toEqual({
      status: "stale",
    });
    expect((await rebaseOpenBoard({ ...common, read: async () => readResponse(base, 3) })).status).toBe("current");
    expect(await rebaseOpenBoard({ ...common, read: async () => ({ ...next, access: "read" }) })).toMatchObject({
      reason: "access",
      remote: { access: "read", version: 4 },
      status: "manual",
    });
    expect(
      await rebaseOpenBoard({
        ...common,
        read: async () => ({ ...next, snapshot: null, snapshot_status: "corrupt" }),
      })
    ).toMatchObject({ reason: "corrupt", status: "manual" });
    expect(editor.getShape(createShapeId("note"))).toBeDefined();
  });
});
