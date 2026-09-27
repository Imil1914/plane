// RC-2 (AF1.2): client auto-rebase of a board onto the teammate's saved version — the fixture table of inventory §3.3
// «Проверки RC-2»: different nodes; geometry vs props of one node; one text on both sides → copy; delete vs edit (both
// directions); a removed frame + a new child; an arrow to a removed target; projections (move vs remove, pending
// activate/remove); document metadata; > 2 MiB. Plus the rules around them (R-B4/R-B5): the shape under edit, layout-only
// collisions, native shapes and arrows, identical edits, the clean reload.
import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import {
  createPpmCanvasNode,
  createPpmWorkItemRefNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasNode,
  type TPpmCanvasSnapshot,
} from "@ppm/canvas";
import {
  CANVAS_CONFLICT_COPY_LABEL,
  CANVAS_REBASE_MAX_ATTEMPTS,
  canvasAutosaveDelayMs,
  describeCanvasRebase,
  isPpmCanvasAutomergeEnabled,
  rebaseCanvasRecords,
  canvasRebaseRetryDelayMs,
  type TPpmCanvasRebaseOptions,
  type TPpmCanvasRebaseStrings,
} from "@/components/ppm-canvas/board-rebase";

type TRecord = Record<string, unknown>;

/** The notice texts and the copy label in one language, from `@ppm/brand` (canvas.rc2.*). */
function rebaseStrings(locale: "en" | "ru"): TPpmCanvasRebaseStrings {
  return {
    copyLabel: getPpmTranslation(locale, "canvas.rc2.copy_label"),
    localCopy: getPpmTranslation(locale, "canvas.rc2.local_copy"),
    objectsCount: getPpmTranslation(locale, "canvas.rc2.objects_count"),
    remoteCopy: getPpmTranslation(locale, "canvas.rc2.remote_copy"),
    remoteWins: getPpmTranslation(locale, "canvas.rc2.remote_wins"),
    restoredLocal: getPpmTranslation(locale, "canvas.rc2.restored_local"),
    restoredRemote: getPpmTranslation(locale, "canvas.rc2.restored_remote"),
  };
}
const RU = rebaseStrings("ru");
const EN = rebaseStrings("en");

const NOW = "2026-09-27T01:30:00.000Z";
const EARLIER = "2026-09-26T10:00:00.000Z";
const SCHEMA = { schemaVersion: 2, sequences: { "com.tldraw.shape": 4, "com.tldraw.page": 1 } };
const PAGE: TRecord = { id: "page:page", typeName: "page", name: "Page 1", index: "a1", meta: {} };
const DOCUMENT: TRecord = { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} };

function shapeRecord(id: string, node: TPpmCanvasNode, extra: TRecord = {}): TRecord {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type: "ppm-canvas-node",
    parentId: "page:page",
    index: "a1",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: node.visual.width, h: node.visual.height, node: serializePpmCanvasNode(node) },
    ...extra,
  };
}

function owned(id: string, kind: "note" | "frame" | "group" | "checklist", title: string, extra: TRecord = {}) {
  return shapeRecord(id, createPpmCanvasNode({ authorId: "author", kind, now: EARLIER, title }), extra);
}

const BINDING_ID = "00000000-0000-4000-8000-0000000000b1";
function projection(id: string, bindingId = BINDING_ID, extra: TRecord = {}) {
  return shapeRecord(
    id,
    createPpmWorkItemRefNode({
      authorId: "author",
      binding: {
        binding_id: bindingId,
        entity_id: "00000000-0000-4000-8000-0000000000e1",
        entity_type: "work_item",
        source_version: null,
      },
      now: EARLIER,
    }),
    extra
  );
}

function nodeOf(record: TRecord | undefined): TPpmCanvasNode {
  const props = record?.props as { node: string };
  const parsed = parseSerializedPpmCanvasNode(props.node);
  if (parsed.status !== "valid" && parsed.status !== "migrated") throw new Error("invalid node");
  return parsed.node;
}

/** The same record with the node edited the way the editor does it (the patch plus a fresh `updated_at`). */
function editNode(record: TRecord, patch: Record<string, unknown>, updatedAt = NOW): TRecord {
  const node = { ...nodeOf(record), ...patch, updated_at: updatedAt } as TPpmCanvasNode;
  return { ...record, props: { ...(record.props as TRecord), node: serializePpmCanvasNode(node) } };
}

function nativeGeo(id: string, text: string, extra: TRecord = {}): TRecord {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type: "geo",
    parentId: "page:page",
    index: "a2",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { geo: "rectangle", w: 100, h: 100, color: "black", text },
    ...extra,
  };
}

function arrow(id: string, extra: TRecord = {}): TRecord {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type: "arrow",
    parentId: "page:page",
    index: "a3",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0, text: "" },
    ...extra,
  };
}

function arrowBinding(id: string, fromId: string, toId: string, terminal: "start" | "end"): TRecord {
  return {
    id: `binding:${id}`,
    typeName: "binding",
    type: "arrow",
    fromId,
    toId,
    meta: {},
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
  };
}

function snapshot(...records: TRecord[]): TPpmCanvasSnapshot {
  return {
    document: { schema: SCHEMA, store: Object.fromEntries([DOCUMENT, PAGE, ...records].map((r) => [r.id, r])) },
  };
}

function storeOf(value: TPpmCanvasSnapshot): Record<string, TRecord> {
  return (value.document as { store: Record<string, TRecord> }).store;
}

function options(overrides: Partial<TPpmCanvasRebaseOptions> = {}): TPpmCanvasRebaseOptions {
  let next = 0;
  return {
    authorId: "me",
    copyLabel: CANVAS_CONFLICT_COPY_LABEL,
    createShapeId: () => `shape:copy-${++next}`,
    now: NOW,
    ...overrides,
  };
}

/** Applying the patch to the live (local) store must give exactly the merged snapshot the editor then saves. */
function expectPatchReachesSnapshot(local: TPpmCanvasSnapshot, result: ReturnType<typeof rebaseCanvasRecords>) {
  if (result.status !== "merged") throw new Error(`expected a merge, got ${result.status}`);
  const live = new Map(Object.entries(storeOf(local)));
  for (const record of result.patch.put) live.set(record.id as string, record);
  for (const id of result.patch.remove) live.delete(id);
  expect(Object.fromEntries(live)).toEqual(storeOf(result.snapshot));
}

function merged(result: ReturnType<typeof rebaseCanvasRecords>) {
  if (result.status !== "merged") throw new Error(`expected a merge, got ${JSON.stringify(result)}`);
  return result;
}

describe("RC-2 board rebase: fixture table of inventory §3.3", () => {
  it("merges edits to different nodes and patches only the teammate's record", () => {
    const first = owned("first", "note", "First");
    const second = owned("second", "note", "Second");
    const base = snapshot(first, second);
    const local = snapshot(editNode(first, { title: "Mine" }), second);
    const remote = snapshot(first, editNode(second, { title: "Theirs" }));
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(result).toMatchObject({ conflicts: [], restored: [], localChanges: 1, remoteChanges: 1 });
    expect(result.patch).toEqual({ put: [storeOf(remote)["shape:second"]], remove: [] });
    expect(nodeOf(storeOf(result.snapshot)["shape:first"]).title).toBe("Mine");
    expect(nodeOf(storeOf(result.snapshot)["shape:second"]).title).toBe("Theirs");
    expectPatchReachesSnapshot(local, result);
  });

  it("merges geometry on one side with props on the other side of the same node", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const local = snapshot(editNode(note, { body: "typed locally" }));
    const remote = snapshot({ ...note, x: 480, y: 120 });
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    const record = storeOf(result.snapshot)["shape:note"];
    expect(result.conflicts).toEqual([]);
    expect(record).toMatchObject({ x: 480, y: 120 });
    expect(nodeOf(record).kind === "note" && nodeOf(record)).toMatchObject({ body: "typed locally" });
    expectPatchReachesSnapshot(local, result);
  });

  it("merges a resize with a text edit inside the node and keeps the later updated_at", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const resized = editNode(note, { visual: { ...nodeOf(note).visual, width: 400 } }, "2026-09-27T01:00:00.000Z");
    const local = snapshot({ ...resized, props: { ...(resized.props as TRecord), w: 400 } });
    const remote = snapshot(editNode(note, { body: "remote text" }, "2026-09-27T01:05:00.000Z"));
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    const record = storeOf(result.snapshot)["shape:note"];
    expect(result.conflicts).toEqual([]);
    expect(record.props).toMatchObject({ w: 400 });
    expect(nodeOf(record)).toMatchObject({
      body: "remote text",
      updated_at: "2026-09-27T01:05:00.000Z",
      visual: { width: 400 },
    });
  });

  it("keeps the saved (teammate's) text canonical and the local text as a labelled sibling copy", () => {
    const note = owned("note", "note", "Plan", { parentId: "page:page", x: 10, y: 20, index: "a5" });
    const base = snapshot(note);
    const local = snapshot(editNode(note, { title: "Mine" }));
    const remote = snapshot(editNode(note, { title: "Theirs" }));
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    const store = storeOf(result.snapshot);
    expect(result.conflicts).toEqual([{ id: "shape:note", copyId: "shape:copy-1", resolution: "local_copy" }]);
    expect(nodeOf(store["shape:note"]).title).toBe("Theirs");
    const copy = store["shape:copy-1"];
    expect(copy).toMatchObject({ parentId: "page:page", x: 42, y: 52, type: "ppm-canvas-node" });
    expect((copy.index as string) > "a5").toBe(true);
    expect(nodeOf(copy)).toMatchObject({ author_id: "me", title: `${CANVAS_CONFLICT_COPY_LABEL} · Mine` });
    expect(describeCanvasRebase(result, RU)).toContain(`«${CANVAS_CONFLICT_COPY_LABEL}»`);
    expect(describeCanvasRebase(result, EN)).toContain("“Conflict copy”");
    expectPatchReachesSnapshot(local, result);
  });

  it("copies a checklist with new item ids; a Plane task stays linked exactly once", () => {
    const list = owned("list", "checklist", "Tasks");
    const shared = { id: "item-1", text: "Ship", checked: false, work_item_id: "00000000-0000-4000-8000-0000000000e9" };
    const mineOnly = {
      id: "item-2",
      text: "Demo",
      checked: false,
      work_item_id: "00000000-0000-4000-8000-0000000000e8",
    };
    const base = snapshot(editNode(list, { items: [shared] }, EARLIER));
    // Here the item is ticked and a new item is made a Plane task; the teammate renames the shared item.
    const local = snapshot(editNode(list, { items: [{ ...shared, checked: true }, mineOnly] }));
    const remote = snapshot(editNode(list, { items: [{ ...shared, text: "Ship it" }] }));
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    const copy = nodeOf(storeOf(result.snapshot)["shape:copy-1"]);
    expect(copy.kind).toBe("checklist");
    if (copy.kind !== "checklist") return;
    expect(copy.items).toHaveLength(2);
    expect(copy.items[0]).toMatchObject({ text: "Ship", checked: true });
    expect(copy.items[0]?.id).not.toBe("item-1");
    // The shared task stays with the canonical card; the task only this version links keeps its link in the copy.
    expect(copy.items[0]?.work_item_id).toBeUndefined();
    expect(copy.items[1]).toMatchObject({ text: "Demo", work_item_id: mineOnly.work_item_id });
  });

  it("restores an object removed locally when the teammate edited it (edit wins over delete)", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const local = snapshot();
    const remote = snapshot(editNode(note, { title: "Edited by a teammate" }));
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(result.restored).toEqual([{ id: "shape:note", deletedBy: "local" }]);
    expect(nodeOf(storeOf(result.snapshot)["shape:note"]).title).toBe("Edited by a teammate");
    expect(describeCanvasRebase(result, RU)).toContain("Объект изменён коллегой и восстановлен");
    expectPatchReachesSnapshot(local, result);
  });

  it("keeps an own node the teammate removed while it was edited locally", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const local = snapshot(editNode(note, { title: "Still needed" }));
    const remote = snapshot();
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(result.restored).toEqual([{ id: "shape:note", deletedBy: "remote" }]);
    expect(nodeOf(storeOf(result.snapshot)["shape:note"]).title).toBe("Still needed");
    expect(result.patch).toEqual({ put: [], remove: [] });
    expect(describeCanvasRebase(result, RU)).toContain("Коллега удалил объект, с которым вы работали");
  });

  it("restores a removed frame or group with its ancestors for a new child instead of leaving an orphan", () => {
    for (const kind of ["frame", "group"] as const) {
      const outer = owned(`${kind}-outer`, kind, "Outer");
      const inner = owned(`${kind}-inner`, kind, "Inner", { parentId: outer.id });
      const child = owned(`${kind}-child`, "note", "New card", { parentId: inner.id });
      const base = snapshot(outer, inner);
      const withoutContainers = snapshot();
      const withChild = snapshot(outer, inner, child);
      // Removed locally, a teammate put a new card into it…
      const first = merged(rebaseCanvasRecords(base, withoutContainers, withChild, options()));
      expect(Object.keys(storeOf(first.snapshot))).toEqual(expect.arrayContaining([outer.id, inner.id, child.id]));
      expect(first.restored).toEqual(
        expect.arrayContaining([
          { id: inner.id, deletedBy: "local" },
          { id: outer.id, deletedBy: "local" },
        ])
      );
      expectPatchReachesSnapshot(withoutContainers, first);
      // …and the mirror case: a teammate removed it while a new card was put into it here.
      const second = merged(rebaseCanvasRecords(base, withChild, withoutContainers, options()));
      expect(Object.keys(storeOf(second.snapshot))).toEqual(expect.arrayContaining([outer.id, inner.id, child.id]));
      expect(second.restored).toEqual(
        expect.arrayContaining([
          { id: inner.id, deletedBy: "remote" },
          { id: outer.id, deletedBy: "remote" },
        ])
      );
      expectPatchReachesSnapshot(withChild, second);
    }
  });

  it("restores the target of a newly drawn arrow that the teammate removed", () => {
    const target = nativeGeo("target", "Target");
    const source = nativeGeo("source", "Source", { x: 300 });
    const line = arrow("arrow");
    const start = arrowBinding("start", line.id as string, source.id as string, "start");
    const end = arrowBinding("end", line.id as string, target.id as string, "end");
    const base = snapshot(target, source);
    const local = snapshot(target, source, line, start, end);
    const remote = snapshot(source);
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(result.restored).toEqual([{ id: target.id, deletedBy: "remote" }]);
    expect(storeOf(result.snapshot)[end.id as string]).toEqual(end);
    expectPatchReachesSnapshot(local, result);
  });

  it("brings back the arrow bindings a removal took away when the object is restored", () => {
    const target = nativeGeo("target", "Target");
    const source = nativeGeo("source", "Source", { x: 300 });
    const line = arrow("arrow");
    const start = arrowBinding("start", line.id as string, source.id as string, "start");
    const end = arrowBinding("end", line.id as string, target.id as string, "end");
    const base = snapshot(target, source, line, start, end);
    const isolated = { ...line, props: { ...(line.props as TRecord), end: { x: 90, y: 5 } } };
    // Removed here (tldraw also removed its binding and isolated the arrow end), edited by the teammate.
    const local = snapshot(source, isolated, start);
    const remote = snapshot(
      { ...target, props: { ...(target.props as TRecord), text: "Edited" } },
      source,
      line,
      start,
      end
    );
    const first = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(first.restored).toEqual([{ deletedBy: "local", id: target.id }]);
    expect(storeOf(first.snapshot)[end.id as string]).toEqual(end);
    expectPatchReachesSnapshot(local, first);
    // The mirror: removed by the teammate, edited here — the local version comes back with its local binding.
    const second = merged(
      rebaseCanvasRecords(
        base,
        snapshot({ ...target, props: { ...(target.props as TRecord), text: "Edited" } }, source, line, start, end),
        snapshot(source, isolated, start),
        options()
      )
    );
    expect(second.restored).toEqual([{ deletedBy: "remote", id: target.id }]);
    expect(storeOf(second.snapshot)[end.id as string]).toEqual(end);
  });

  it("drops the bindings of a target the teammate removed together with them", () => {
    const target = nativeGeo("target", "Target");
    const source = nativeGeo("source", "Source", { x: 300 });
    const line = arrow("arrow");
    const start = arrowBinding("start", line.id as string, source.id as string, "start");
    const end = arrowBinding("end", line.id as string, target.id as string, "end");
    const base = snapshot(target, source, line, start, end);
    // tldraw removes the bindings of a deleted shape and isolates the arrow end.
    const remote = snapshot(source, { ...line, props: { ...(line.props as TRecord), end: { x: 90, y: 5 } } }, start);
    const local = snapshot(target, { ...source, x: 320 }, line, start, end);
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    const store = storeOf(result.snapshot);
    expect(store[target.id as string]).toBeUndefined();
    expect(store[end.id as string]).toBeUndefined();
    expect(store[source.id as string]).toMatchObject({ x: 320 });
    expect(result.restored).toEqual([]);
    expectPatchReachesSnapshot(local, result);
  });

  it("lets a projection removed by the teammate stay removed even if it was moved here", () => {
    const card = projection("card");
    const base = snapshot(card);
    const local = snapshot({ ...card, x: 200 });
    const remote = snapshot();
    const result = merged(
      rebaseCanvasRecords(base, local, remote, options({ bindingChanges: { activate: [], remove: [] } }))
    );
    expect(storeOf(result.snapshot)["shape:card"]).toBeUndefined();
    expect(result.restored).toEqual([]);
    expect(result.patch).toEqual({ put: [], remove: ["shape:card"] });
  });

  it("restores a projection removed here but moved by the teammate and drops its queued removal", () => {
    const card = projection("card");
    const base = snapshot(card);
    const local = snapshot();
    const remote = snapshot({ ...card, x: 200 });
    const result = merged(
      rebaseCanvasRecords(
        base,
        local,
        remote,
        options({
          bindingChanges: { activate: [], remove: [BINDING_ID] },
          serverActiveBindingIds: new Set([BINDING_ID]),
        })
      )
    );
    expect(storeOf(result.snapshot)["shape:card"]).toMatchObject({ x: 200 });
    expect(result.bindingChanges).toEqual({ activate: [], remove: [] });
    expect(result.droppedBindingChanges).toEqual({ activate: [], remove: [BINDING_ID] });
  });

  it("keeps the teammate's geometry for a projection moved on both sides, without a copy", () => {
    const card = projection("card");
    const base = snapshot(card);
    const local = snapshot({ ...card, x: 100, y: 100 });
    const remote = snapshot({ ...card, x: 300, y: 50 });
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(storeOf(result.snapshot)["shape:card"]).toMatchObject({ x: 300, y: 50 });
    expect(Object.keys(storeOf(result.snapshot)).filter((id) => id.startsWith("shape:"))).toEqual(["shape:card"]);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps pending activations only for projections still on the board and removals only while active", () => {
    const kept = "00000000-0000-4000-8000-0000000000a1";
    const gone = "00000000-0000-4000-8000-0000000000a2";
    const alreadyRemoved = "00000000-0000-4000-8000-0000000000a3";
    const newCard = projection("new-card", kept);
    const base = snapshot();
    const local = snapshot(newCard);
    const remote = snapshot(owned("other", "note", "Other"));
    const result = merged(
      rebaseCanvasRecords(
        base,
        local,
        remote,
        options({
          bindingChanges: { activate: [kept, gone], remove: [alreadyRemoved] },
          serverActiveBindingIds: new Set(),
        })
      )
    );
    expect(result.bindingChanges).toEqual({ activate: [kept], remove: [] });
    expect(result.droppedBindingChanges).toEqual({ activate: [gone], remove: [alreadyRemoved] });
  });

  it("falls back to the manual mode when the document metadata differs", () => {
    const base = snapshot();
    const local = snapshot(owned("note", "note", "Mine"));
    const remote: TPpmCanvasSnapshot = {
      document: { ...(snapshot().document as TRecord), schema: { ...SCHEMA, schemaVersion: 3 } },
    };
    expect(rebaseCanvasRecords(base, local, remote, options())).toEqual({ status: "manual", reason: "schema" });
  });

  it("falls back to the manual mode when the merged board would exceed the save limit", () => {
    const base = snapshot();
    const local = snapshot(owned("note", "note", "Mine"));
    const remote = snapshot(owned("other", "note", "Theirs"));
    expect(rebaseCanvasRecords(base, local, remote, options({ maxBytes: 256 }))).toEqual({
      status: "manual",
      reason: "too_large",
    });
    expect(rebaseCanvasRecords(base, local, remote, options({ maxBytes: 2 * 1024 * 1024 })).status).toBe("merged");
  });
});

describe("RC-2 board rebase: rules around the table", () => {
  it("postpones while the shape under edit was changed by the teammate, and never touches its record", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const local = snapshot(editNode(note, { body: "typing…" }));
    const remote = snapshot(editNode(note, { body: "their words" }));
    expect(rebaseCanvasRecords(base, local, remote, options({ protectedIds: new Set(["shape:note"]) }))).toEqual({
      status: "postpone",
      ids: ["shape:note"],
    });
    // The same shape under edit is not a reason to wait when the teammate did not touch it.
    const other = snapshot(note, owned("other", "note", "Other"));
    expect(rebaseCanvasRecords(base, local, other, options({ protectedIds: new Set(["shape:note"]) })).status).toBe(
      "merged"
    );
  });

  it("after editing ends, keeps the local text canonical and turns the teammate's version into the copy", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const local = snapshot(editNode(note, { title: "Mine" }));
    const remote = snapshot(editNode(note, { title: "Theirs" }));
    const result = merged(
      rebaseCanvasRecords(base, local, remote, options({ preferLocalIds: new Set(["shape:note"]) }))
    );
    const store = storeOf(result.snapshot);
    expect(result.conflicts).toEqual([{ id: "shape:note", copyId: "shape:copy-1", resolution: "remote_copy" }]);
    expect(nodeOf(store["shape:note"]).title).toBe("Mine");
    expect(nodeOf(store["shape:copy-1"]).title).toBe(`${CANVAS_CONFLICT_COPY_LABEL} · Theirs`);
    // The teammate's version is not credited to the local user.
    expect(nodeOf(store["shape:copy-1"]).author_id).toBe("author");
    expectPatchReachesSnapshot(local, result);
  });

  it("writes the copy label of the user's language and counts several collisions in the notice", () => {
    const first = owned("first", "note", "One");
    const second = owned("second", "note", "Two");
    const base = snapshot(first, second);
    const local = snapshot(editNode(first, { title: "Mine 1" }), editNode(second, { title: "Mine 2" }));
    const remote = snapshot(editNode(first, { title: "Theirs 1" }), editNode(second, { title: "Theirs 2" }));
    const result = merged(rebaseCanvasRecords(base, local, remote, options({ copyLabel: EN.copyLabel })));
    expect(nodeOf(storeOf(result.snapshot)["shape:copy-1"]).title).toBe("Conflict copy · Mine 1");
    expect(describeCanvasRebase(result, EN)).toBe(
      "A teammate changed the same object at the same time: their version is kept, yours is next to it marked " +
        "“Conflict copy”. Objects: 2."
    );
    expect(describeCanvasRebase(result, RU)).toContain("Объектов: 2.");
  });

  it("resolves a move on both sides silently in favour of the saved position", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const local = snapshot({ ...note, x: 100 });
    const remote = snapshot({ ...note, x: 300, y: 40 });
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(storeOf(result.snapshot)["shape:note"]).toMatchObject({ x: 300, y: 40 });
    expect(result.conflicts).toEqual([]);
    expect(describeCanvasRebase(result, RU)).toBeUndefined();
  });

  it("accepts the same change made on both sides", () => {
    const note = owned("note", "note", "Plan");
    const same = editNode(note, { title: "Agreed" });
    const result = merged(rebaseCanvasRecords(snapshot(note), snapshot(same), snapshot(same), options()));
    expect(result.conflicts).toEqual([]);
    expect(result.patch).toEqual({ put: [], remove: [] });
  });

  it("copies a native shape with a conflicting label and marks the copy in meta", () => {
    const geo = nativeGeo("geo", "Start");
    const base = snapshot(geo);
    const local = snapshot({ ...geo, props: { ...(geo.props as TRecord), text: "Mine" } });
    const remote = snapshot({ ...geo, props: { ...(geo.props as TRecord), text: "Theirs" } });
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    const store = storeOf(result.snapshot);
    expect(store["shape:geo"]).toMatchObject({ props: { text: "Theirs" } });
    expect(store["shape:copy-1"]).toMatchObject({
      type: "geo",
      props: { text: "Mine" },
      meta: { ppm_conflict_copy_of: "shape:geo" },
    });
  });

  it("keeps the teammate's version of an arrow or a binding changed on both sides, without copies", () => {
    const line = arrow("arrow");
    const base = snapshot(line);
    const local = snapshot({ ...line, props: { ...(line.props as TRecord), text: "mine", bend: 20 } });
    const remote = snapshot({ ...line, props: { ...(line.props as TRecord), text: "theirs" } });
    const result = merged(rebaseCanvasRecords(base, local, remote, options()));
    expect(storeOf(result.snapshot)["shape:arrow"]).toMatchObject({ props: { text: "theirs", bend: 20 } });
    expect(result.conflicts).toEqual([{ id: "shape:arrow", resolution: "remote_wins" }]);
    expect(Object.keys(storeOf(result.snapshot))).not.toContain("shape:copy-1");
  });

  it("applies the teammate's save unchanged when nothing changed locally (the clean reload)", () => {
    const note = owned("note", "note", "Plan");
    const base = snapshot(note);
    const remote = snapshot(editNode(note, { title: "Theirs" }), owned("new", "note", "New"));
    const result = merged(rebaseCanvasRecords(base, base, remote, options()));
    expect(result.snapshot).toEqual(remote);
    expect(result.localChanges).toBe(0);
    expectPatchReachesSnapshot(base, result);
  });

  it("merges into a board that had no saved version yet (identical default page and document)", () => {
    const empty: TPpmCanvasSnapshot = { document: { schema: SCHEMA, store: {} } };
    const local = snapshot(owned("mine", "note", "Mine"));
    const remote = snapshot(owned("theirs", "note", "Theirs"));
    const result = merged(rebaseCanvasRecords(empty, local, remote, options()));
    expect(new Set(Object.keys(storeOf(result.snapshot)))).toEqual(
      new Set(["document:document", "page:page", "shape:mine", "shape:theirs"])
    );
  });

  it("falls back to the manual mode for a page or document record changed differently on both sides", () => {
    const base = snapshot();
    const local = snapshot();
    const remote = snapshot();
    storeOf(local)["page:page"] = { ...PAGE, name: "Mine" };
    storeOf(remote)["page:page"] = { ...PAGE, name: "Theirs" };
    expect(rebaseCanvasRecords(base, local, remote, options())).toEqual({ status: "manual", reason: "structure" });
  });
});

describe("RC-2 helpers", () => {
  it("reads PPM_CANVAS_AUTOMERGE like the other PPM flags: on unless explicitly off", () => {
    for (const value of [undefined, "", "1", "true", "on"]) expect(isPpmCanvasAutomergeEnabled(value)).toBe(true);
    for (const value of ["0", "false", "no", "off", "disabled", " OFF "])
      expect(isPpmCanvasAutomergeEnabled(value)).toBe(false);
  });

  it("retries a stale save at most three times, with jitter between the attempts", () => {
    expect(CANVAS_REBASE_MAX_ATTEMPTS).toBe(3);
    expect(canvasRebaseRetryDelayMs(0, 0)).toBeGreaterThan(0);
    expect(canvasRebaseRetryDelayMs(0, 0)).toBeLessThan(canvasRebaseRetryDelayMs(0, 1));
    expect(canvasRebaseRetryDelayMs(1, 0.5)).toBeGreaterThan(canvasRebaseRetryDelayMs(0, 0.5));
    expect(canvasRebaseRetryDelayMs(9, 1)).toBeLessThanOrEqual(2_000);
  });

  it("uses a two-second autosave debounce only while a teammate is on the board", () => {
    expect(canvasAutosaveDelayMs(0)).toBe(1_000);
    expect(canvasAutosaveDelayMs(1)).toBe(1_000);
    expect(canvasAutosaveDelayMs(2)).toBe(2_000);
  });
});
