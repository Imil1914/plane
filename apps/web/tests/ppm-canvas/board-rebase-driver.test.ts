// RC-2 (AF1.2): behaviour of the rebase driver (board-rebase-driver.ts) — the orchestration editor.tsx wires to its
// refs. A live tldraw 3.15.6 editor, a fake board server with the save rules of `save_canvas_snapshot` (strict version,
// binding operations validated against the snapshot) and a stand-in of the editor's autosave with the same contract
// (`flushSave`: pending operation from the live board and the queues, 409 CANVAS_VERSION_CONFLICT → the driver).
// Covered: C1 — binding operations queued while the saved version is read survive and go out with the next save;
// I1 — a version announced during a rebase is fetched right after it, on a clean board too, and the known version never
// goes down; R-B6 — the 4th stale save in a row leads to the manual mode; R-B4 — the rebase waits while the teammate
// changed the shape under edit (tldraw editing state or a focused card field) and then keeps the local version.
import { describe, expect, it } from "vitest";
import { type TLRecord, type TLShapeId } from "tldraw";
import { focusedCardShapeId, type TPpmCanvasFocusElement } from "@/components/ppm-canvas/board-rebase-driver";
import { FakeBoardServer, harness, projectionShape, renameOnServer, shapeIdsOf, uuid } from "./fixtures/rc2-driver";
import { card, documentOf, titleOf, useTldrawInNode, withTitle } from "./fixtures/rc2-tldraw";

const { createEditor } = useTldrawInNode();

describe("RC-2 rebase driver: binding operations (C1)", () => {
  it("keeps an activation and a removal queued while the saved version is read, and the next save carries them", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const bindingP = uuid(1);
    const projection = projectionShape(editor, "projection", bindingP);
    const server = new FakeBoardServer(documentOf(editor));
    server.active.set(bindingP, projection);
    const h = harness(editor, server);
    const version = server.teammateSave(renameOnServer(note, "Renamed by a teammate"));

    const release = server.holdReads();
    const rebase = h.driver.onRemoteSave(version);
    // While the saved version is on its way: a new projection is put on the board (its pending binding queued for
    // activation) and the existing projection is removed (its binding queued for removal).
    const bindingQ = uuid(2);
    let newProjection: TLShapeId | undefined;
    h.userEdit(() => {
      newProjection = projectionShape(editor, "new-projection", bindingQ);
      server.pending.set(bindingQ, newProjection);
      h.refs.queuedActivations.current.add(bindingQ);
      editor.deleteShape(projection);
      h.refs.queuedRemovals.current.add(bindingP);
    });
    release();
    await rebase;
    await h.settle();

    expect(h.log.otherConflicts).toEqual([]);
    expect(h.log.manual).toBe(0);
    expect(h.log.unsavedAtApply[0]?.has(bindingQ)).toBe(true);
    expect(server.saves.at(-1)?.binding_changes).toEqual({ activate: [bindingQ], remove: [bindingP] });
    expect(server.active.get(bindingQ)).toBe(newProjection);
    expect(server.active.has(bindingP)).toBe(false);
    expect(shapeIdsOf(server.snapshot).has(projection)).toBe(false);
    expect(titleOf(editor, note)).toBe("Renamed by a teammate");
    expect(h.refs.queuedActivations.current.size + h.refs.queuedRemovals.current.size).toBe(0);
  });

  it("does not bring back an activation cancelled while the saved version is read", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editor));
    const h = harness(editor, server);
    const bindingQ = uuid(3);
    let newProjection: TLShapeId | undefined;
    h.userEdit(() => {
      newProjection = projectionShape(editor, "new-projection", bindingQ);
      server.pending.set(bindingQ, newProjection);
      h.refs.queuedActivations.current.add(bindingQ);
    });
    const version = server.teammateSave(renameOnServer(note, "Renamed"));
    const release = server.holdReads();
    const rebase = h.driver.onRemoteSave(version);
    // «Убрать с холста» before the activation was saved (removeProjection): the activation leaves the queue and is
    // cancelled on the server first; the card itself is deleted only after that request returns.
    h.refs.queuedActivations.current.delete(bindingQ);
    server.pending.delete(bindingQ);
    release();
    await rebase;
    await h.settle();
    h.userEdit(() => editor.deleteShape(newProjection!));
    await h.flushSave();
    await h.settle();

    expect(h.log.otherConflicts).toEqual([]);
    expect(h.log.manual).toBe(0);
    expect(server.saves.flatMap((save) => save.binding_changes.activate)).not.toContain(bindingQ);
    expect(shapeIdsOf(server.snapshot).has(newProjection!)).toBe(false);
    expect(titleOf(editor, note)).toBe("Renamed");
  });

  it("puts the binding operations of a stale save back into the queues instead of cancelling them", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editor));
    const h = harness(editor, server);
    const bindingQ = uuid(4);
    h.userEdit(() => {
      const shape = projectionShape(editor, "new-projection", bindingQ);
      server.pending.set(bindingQ, shape);
      h.refs.queuedActivations.current.add(bindingQ);
    });
    server.teammateSave(renameOnServer(note, "Renamed"));
    // Our save is stale (409) — it is rebased and saved again with the same activation.
    await h.flushSave();
    await h.settle();
    expect(h.log.manual).toBe(0);
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]?.binding_changes.activate).toEqual([bindingQ]);
    expect(server.pending.has(bindingQ)).toBe(false);
    expect(server.active.has(bindingQ)).toBe(true);
  });
});

describe("RC-2 rebase driver: versions announced during a rebase (I1)", () => {
  it("fetches a version announced during a rebase right after it, on a clean board, without saving", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editor));
    const h = harness(editor, server);
    const second = server.teammateSave(renameOnServer(note, "Second"));
    const release = server.holdReads();
    const rebase = h.driver.onRemoteSave(second);
    // Another teammate save lands while the first one is being read; its announcement meets a rebase in flight.
    const third = server.teammateSave(renameOnServer(note, "Third"));
    await h.driver.onRemoteSave(third);
    expect(h.driver.known).toBe(third);
    release();
    await rebase;
    await h.settle();

    expect(h.refs.version.current).toBe(third);
    expect(titleOf(editor, note)).toBe("Third");
    expect(server.saves).toEqual([]);
    expect(server.reads).toBe(2);
    // A clean board shows no «saving» for a teammate's save.
    expect(h.log.statuses).toEqual([]);
  });

  it("never lowers the announced version and retries a lagging read a bounded number of times", async () => {
    const editor = createEditor();
    card(editor, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editor), 2);
    const h = harness(editor, server);
    // The announcement is ahead of what the read returns (the read equals our version: «current»).
    await h.driver.onRemoteSave(3);
    await h.settle();
    expect(h.driver.known).toBe(3);
    expect(server.reads).toBe(4);
    expect(h.refs.version.current).toBe(2);
    // Once the server really has version 3, the next announcement fetches it.
    server.teammateSave((snapshot) => snapshot);
    await h.driver.onRemoteSave(3);
    await h.settle();
    expect(h.refs.version.current).toBe(3);
  });
});

describe("RC-2 rebase driver: stale saves (R-B6)", () => {
  it("rebases a stale save at most three times, then falls back to the manual mode", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const other = card(editor, "other", "Other");
    const server = new FakeBoardServer(documentOf(editor));
    const h = harness(editor, server);
    let teammate = 0;
    server.beforeSave = () => {
      teammate += 1;
      server.teammateSave(renameOnServer(other, `Teammate ${teammate}`));
    };
    h.userEdit(() => editor.updateShape(withTitle(editor.getShape(note)! as unknown as TLRecord, "Mine") as never));
    await h.flushSave();
    await h.settle();
    expect(teammate).toBe(4);
    expect(server.reads).toBe(3);
    expect(server.saves).toEqual([]);
    expect(h.log.manual).toBe(1);
  });
});

describe("RC-2 rebase driver: the shape under edit (R-B4, I2)", () => {
  it("waits for the end of tldraw editing, then keeps the local text and makes the teammate's version the copy", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editor));
    const h = harness(editor, server);
    editor.select(note);
    editor.setEditingShape(note);
    h.userEdit(() => editor.updateShape(withTitle(editor.getShape(note)! as unknown as TLRecord, "Mine") as never));
    const version = server.teammateSave(renameOnServer(note, "Theirs"));
    await h.driver.onRemoteSave(version);
    expect(h.driver.isPostponed()).toBe(true);
    expect(h.log.notices).toEqual(["waiting for the end of editing"]);
    expect(titleOf(editor, note)).toBe("Mine");
    // Autosave waits too (the recovery draft keeps the text meanwhile).
    await h.flushSave();
    expect(server.saves).toEqual([]);

    editor.setEditingShape(null);
    await h.driver.onEditingMaybeEnded();
    await h.settle();
    expect(h.driver.isPostponed()).toBe(false);
    expect(h.log.notices.some((notice) => notice.startsWith("remote copy"))).toBe(true);
    expect(titleOf(editor, note)).toBe("Mine");
    const copies = editor
      .getCurrentPageShapes()
      .filter((shape) => shape.id !== note && titleOf(editor, shape.id)?.startsWith("Conflict copy"));
    expect(copies.map((shape) => titleOf(editor, shape.id))).toEqual(["Conflict copy · Theirs"]);
    expect(server.saves).toHaveLength(1);
    expect(h.driver.preferredLocalIds().size).toBe(0);
  });

  it("treats a focused text field of a card as editing: the teammate's text never replaces it before blur", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editor));
    const h = harness(editor, server);
    const textarea: TPpmCanvasFocusElement = {
      closest: (selector) => (selector === "[data-shape-id]" ? { getAttribute: () => note } : null),
      getAttribute: () => null,
      tagName: "TEXTAREA",
    };
    h.focus(textarea);
    const version = server.teammateSave(renameOnServer(note, "Theirs"));
    await h.driver.onRemoteSave(version);
    expect(h.driver.isPostponed()).toBe(true);
    expect(titleOf(editor, note)).toBe("Plan");
    // Still focused: nothing happens.
    await h.driver.onEditingMaybeEnded();
    expect(titleOf(editor, note)).toBe("Plan");

    h.focus(null);
    await h.driver.onEditingMaybeEnded();
    await h.settle();
    // No local change to this card: the teammate's text is simply applied after the blur, no copy, nothing saved.
    expect(titleOf(editor, note)).toBe("Theirs");
    expect(editor.getCurrentPageShapes()).toHaveLength(1);
    expect(server.saves).toEqual([]);
    expect(h.refs.version.current).toBe(version);
  });

  it("forgets the preference for the local version when the resumed rebase ends without a merge", async () => {
    const editor = createEditor();
    const note = card(editor, "note", "Plan");
    const server = new FakeBoardServer(documentOf(editor));
    const h = harness(editor, server);
    editor.select(note);
    editor.setEditingShape(note);
    const version = server.teammateSave(renameOnServer(note, "Theirs"));
    await h.driver.onRemoteSave(version);
    expect(h.driver.isPostponed()).toBe(true);
    // Meanwhile the user lost edit rights: the resumed rebase ends in the reload (nothing local to lose).
    server.access = "read";
    editor.setEditingShape(null);
    await h.driver.onEditingMaybeEnded();
    await h.settle();
    expect(h.log.reloads).toBe(1);
    expect(h.driver.preferredLocalIds().size).toBe(0);
  });
});

function inside(tagName: string, attributes: Record<string, string> = {}, contentEditable = false) {
  return {
    closest: (selector: string) => (selector === "[data-shape-id]" ? { getAttribute: () => "shape:card" } : null),
    getAttribute: (name: string) => attributes[name] ?? null,
    isContentEditable: contentEditable,
    tagName,
  };
}

function containerOf(element: unknown) {
  return { contains: (node: unknown) => node === element };
}

describe("RC-2 focus of a card field", () => {
  const container = containerOf;

  it("counts text inputs, textareas and contenteditable of this editor's cards", () => {
    for (const element of [
      inside("TEXTAREA"),
      inside("INPUT"),
      inside("INPUT", { type: "search" }),
      inside("DIV", {}, true),
    ])
      expect(focusedCardShapeId(element, container(element))).toBe("shape:card");
  });

  it("ignores checkboxes and buttons, fields outside this editor and focus outside a card", () => {
    const checkbox = inside("INPUT", { type: "checkbox" });
    expect(focusedCardShapeId(checkbox, container(checkbox))).toBeUndefined();
    const button = inside("BUTTON");
    expect(focusedCardShapeId(button, container(button))).toBeUndefined();
    const elsewhere = inside("TEXTAREA");
    expect(focusedCardShapeId(elsewhere, container(null))).toBeUndefined();
    const loose = { ...inside("TEXTAREA"), closest: () => null };
    expect(focusedCardShapeId(loose, container(loose))).toBeUndefined();
    expect(focusedCardShapeId(null, container(null))).toBeUndefined();
  });
});
