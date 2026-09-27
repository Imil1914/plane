import { describe, expect, it, vi } from "vitest";
import {
  createPpmCanvasNode,
  createPpmWorkItemRefNode,
  parsePpmCanvasBoardExport,
  serializePpmCanvasNode,
} from "@ppm/canvas";
import {
  canvasRecoveryKey,
  classifyCanvasRecoveryDraft,
  clearCanvasRecoveryDraft,
  clearDurableCanvasRecoveryDraft,
  durableCanvasRecoveryKey,
  listDurableCanvasRecoveryDrafts,
  mergeDisjointCanvasSnapshots,
  readCanvasRecoveryDraft,
  sameCanvasSnapshots,
  serializeCanvasRecoveryDraft,
  writeCanvasRecoveryDraft,
  writeDurableCanvasRecoveryDraft,
  type TPpmCanvasRecoveryDraft,
} from "@/components/ppm-canvas/board-recovery";
import { PpmCanvasService } from "@/services/ppm-canvas.service";

const scope = {
  authorId: "user-one",
  boardId: "board-one",
  projectId: "project-one",
  workspaceId: "workspace-one",
};

const draft: TPpmCanvasRecoveryDraft = {
  format: "ppm-canvas-recovery",
  schema_version: 2,
  base_version: 4,
  saved_at: "2026-09-23T08:00:00.000Z",
  snapshot: { document: { store: { "shape:one": { typeName: "shape", id: "shape:one" } } } },
  binding_changes: { activate: [], remove: [] },
};

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

describe("Canvas local recovery", () => {
  it("fetches the immutable base version through the project-scoped board API", async () => {
    const service = new PpmCanvasService();
    const boardId = "11111111-1111-4111-8111-111111111111";
    const get = vi.spyOn(service, "get").mockResolvedValue({
      data: {
        board_id: boardId,
        version: 4,
        schema_version: 2,
        snapshot: { document: { store: {} } },
        content_hash: "a".repeat(64),
        saved_by: "22222222-2222-4222-8222-222222222222",
        saved_at: "2026-09-23T10:00:00.000Z",
      },
    } as never);

    await expect(service.getBoardVersion("workspace", "project", boardId, 4)).resolves.toMatchObject({ version: 4 });
    expect(get).toHaveBeenCalledWith(
      `/api/ppm/v1/workspaces/workspace/projects/project/canvas/boards/${boardId}/versions/4/`
    );
  });

  it("isolates drafts by workspace, project, board and user", () => {
    const storage = fakeStorage();
    expect(writeCanvasRecoveryDraft(storage, scope, draft)).toBe(true);
    expect(readCanvasRecoveryDraft(storage, scope)).toEqual(draft);
    for (const field of ["authorId", "boardId", "projectId", "workspaceId"] as const) {
      expect(readCanvasRecoveryDraft(storage, { ...scope, [field]: `another-${field}` })).toBeUndefined();
    }
    clearCanvasRecoveryDraft(storage, scope);
    expect(readCanvasRecoveryDraft(storage, scope)).toBeUndefined();
  });

  it("keeps separate durable drafts for two tabs and scopes their discovery", () => {
    const storage = fakeStorage();
    const first = { ...draft, saved_at: "2026-09-23T08:01:00.000Z" };
    const second = { ...draft, saved_at: "2026-09-23T08:02:00.000Z" };
    expect(writeDurableCanvasRecoveryDraft(storage, scope, "tab-one", first)).toBe(true);
    expect(writeDurableCanvasRecoveryDraft(storage, scope, "tab-two", second)).toBe(true);
    expect(listDurableCanvasRecoveryDrafts(storage, scope)).toEqual([
      { key: durableCanvasRecoveryKey(scope, "tab-one"), draft: first },
      { key: durableCanvasRecoveryKey(scope, "tab-two"), draft: second },
    ]);
    expect(listDurableCanvasRecoveryDrafts(storage, { ...scope, authorId: "other-user" })).toEqual([]);
    expect(listDurableCanvasRecoveryDrafts(storage, { ...scope, boardId: "other-board" })).toEqual([]);
    clearDurableCanvasRecoveryDraft(storage, durableCanvasRecoveryKey(scope, "tab-one"));
    expect(listDurableCanvasRecoveryDrafts(storage, scope)).toEqual([
      { key: durableCanvasRecoveryKey(scope, "tab-two"), draft: second },
    ]);
  });

  it("preserves an unacknowledged operation ID and exact payload for a restart retry", () => {
    const storage = fakeStorage();
    const pending = {
      ...draft,
      pending_operation: {
        base_version: draft.base_version,
        binding_changes: draft.binding_changes,
        client_operation_id: "00000000-0000-4000-8000-000000000123",
        snapshot: draft.snapshot,
      },
    };
    expect(writeDurableCanvasRecoveryDraft(storage, scope, "restart", pending)).toBe(true);
    expect(listDurableCanvasRecoveryDrafts(storage, scope)[0]?.draft.pending_operation).toEqual(
      pending.pending_operation
    );
    expect(JSON.parse(serializeCanvasRecoveryDraft(pending)).pending_operation).toEqual(pending.pending_operation);
  });

  it("drops invalid durable records without deleting another tab's draft", () => {
    const storage = fakeStorage();
    storage.setItem(durableCanvasRecoveryKey(scope, "bad"), JSON.stringify({ ...draft, schema_version: 999 }));
    writeDurableCanvasRecoveryDraft(storage, scope, "good", draft);
    expect(listDurableCanvasRecoveryDrafts(storage, scope)).toEqual([
      { key: durableCanvasRecoveryKey(scope, "good"), draft },
    ]);
    expect(storage.values.has(durableCanvasRecoveryKey(scope, "bad"))).toBe(false);
  });

  it("keeps the last durable record when its replacement exceeds browser quota", () => {
    const storage = fakeStorage();
    writeDurableCanvasRecoveryDraft(storage, scope, "tab-one", draft);
    const blockedStorage = {
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: storage.removeItem,
    };
    expect(writeDurableCanvasRecoveryDraft(blockedStorage, scope, "tab-one", draft)).toBe(false);
    expect(listDurableCanvasRecoveryDrafts(storage, scope)).toEqual([
      { key: durableCanvasRecoveryKey(scope, "tab-one"), draft },
    ]);
  });

  it("removes malformed or unsupported drafts instead of loading them", () => {
    const storage = fakeStorage();
    storage.setItem(canvasRecoveryKey(scope), JSON.stringify({ ...draft, schema_version: 999 }));
    expect(readCanvasRecoveryDraft(storage, scope)).toBeUndefined();
    expect(storage.values.size).toBe(0);
  });

  it("removes an older draft when browser storage rejects the latest write", () => {
    const storage = fakeStorage();
    writeCanvasRecoveryDraft(storage, scope, draft);
    expect(
      writeCanvasRecoveryDraft(
        {
          setItem: () => {
            throw new Error("quota");
          },
          removeItem: storage.removeItem,
        },
        scope,
        { ...draft, saved_at: "2026-09-23T08:01:00.000Z" }
      )
    ).toBe(false);
    expect(readCanvasRecoveryDraft(storage, scope)).toBeUndefined();
  });

  it("restores only against the same server version, without silently replacing a newer board", () => {
    expect(classifyCanvasRecoveryDraft(draft, 4, null)).toBe("restore");
    expect(classifyCanvasRecoveryDraft(draft, 5, null)).toBe("export_only");
    expect(classifyCanvasRecoveryDraft(draft, 5, draft.snapshot)).toBe("already_saved");
    expect(classifyCanvasRecoveryDraft(draft, 4, draft.snapshot)).toBe("already_saved");
    expect(
      classifyCanvasRecoveryDraft(
        { ...draft, snapshot: { document: { schema: { alpha: 1, beta: 2 }, store: {} } } },
        5,
        { document: { store: {}, schema: { beta: 2, alpha: 1 } } }
      )
    ).toBe("already_saved");
    expect(
      classifyCanvasRecoveryDraft(
        { ...draft, binding_changes: { activate: ["00000000-0000-4000-8000-000000000001"], remove: [] } },
        4,
        draft.snapshot
      )
    ).toBe("restore");
    expect(
      classifyCanvasRecoveryDraft(
        { ...draft, binding_changes: { activate: ["00000000-0000-4000-8000-000000000001"], remove: [] } },
        5,
        draft.snapshot
      )
    ).toBe("export_only");
  });

  it("downloads a recovery-specific file with its base version and pending bindings", () => {
    const pending = {
      ...draft,
      binding_changes: { activate: ["00000000-0000-4000-8000-000000000001"], remove: [] },
    };
    const serialized = serializeCanvasRecoveryDraft(pending);
    expect(JSON.parse(serialized)).toEqual(pending);
    expect(() => parsePpmCanvasBoardExport(serialized)).toThrow();
  });

  it("merges edits to different owned nodes without replacing the remote version", () => {
    const shape = (id: string, title: string) => ({
      id: `shape:${id}`,
      typeName: "shape",
      type: "ppm-canvas-node",
      props: { node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: "user-one", kind: "note", title })) },
    });
    const first = shape("first", "First");
    const second = shape("second", "Second");
    const base = {
      document: {
        schema: { schemaVersion: 2, sequences: { alpha: 1, beta: 2 } },
        store: { [first.id]: first, [second.id]: second },
      },
    };
    const localFirst = shape("first", "Edited locally");
    const remoteSecond = shape("second", "Edited remotely");
    const local = {
      document: {
        ...base.document,
        schema: { sequences: { beta: 2, alpha: 1 }, schemaVersion: 2 },
        store: { ...base.document.store, [first.id]: localFirst },
      },
    };
    const remote = { document: { ...base.document, store: { ...base.document.store, [second.id]: remoteSecond } } };
    const merge = mergeDisjointCanvasSnapshots(base, local, remote);
    expect(merge).toMatchObject({ localChanges: 1, remoteChanges: 1 });
    expect(merge?.snapshot.document).toMatchObject({
      store: { [first.id]: localFirst, [second.id]: remoteSecond },
    });
    expect(base.document.store[first.id]).toEqual(first);
    expect(remote.document.store[first.id]).toEqual(first);
  });

  it("rejects overlapping, structural and projection changes instead of guessing", () => {
    const first = {
      id: "shape:first",
      typeName: "shape",
      type: "ppm-canvas-node",
      props: { node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: "user-one", kind: "note", title: "A" })) },
    };
    const changed = { ...first, x: 100 };
    const base = { document: { schema: { schemaVersion: 2 }, store: { [first.id]: first } } };
    const local = { document: { ...base.document, store: { [first.id]: changed } } };
    const remote = { document: { ...base.document, store: { [first.id]: { ...first, x: 200 } } } };
    expect(mergeDisjointCanvasSnapshots(base, local, remote)).toBeUndefined();
    expect(
      mergeDisjointCanvasSnapshots(base, local, {
        document: { ...base.document, schema: { schemaVersion: 3 } },
      })
    ).toBeUndefined();
    expect(
      mergeDisjointCanvasSnapshots(base, local, {
        document: {
          ...base.document,
          store: { ...base.document.store, "binding:new": { id: "binding:new", typeName: "binding" } },
        },
      })
    ).toBeUndefined();
    expect(mergeDisjointCanvasSnapshots(base, base, local)).toBeUndefined();
    const projected = {
      ...first,
      props: {
        node: serializePpmCanvasNode(
          createPpmWorkItemRefNode({
            authorId: "user-one",
            binding: {
              binding_id: "00000000-0000-4000-8000-000000000001",
              entity_id: "00000000-0000-4000-8000-000000000002",
              entity_type: "work_item",
              source_version: null,
            },
          })
        ),
      },
    };
    expect(
      mergeDisjointCanvasSnapshots(
        { document: { ...base.document, store: { [first.id]: projected } } },
        { document: { ...base.document, store: { [first.id]: { ...projected, x: 100 } } } },
        { document: { ...base.document, store: { [first.id]: projected } } }
      )
    ).toBeUndefined();
  });

  it("keeps remote additions when a different owned node is removed locally", () => {
    const shape = (id: string) => ({
      id: `shape:${id}`,
      typeName: "shape",
      type: "ppm-canvas-node",
      props: { node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: "user-one", kind: "note", title: id })) },
    });
    const first = shape("first");
    const second = shape("second");
    const base = { document: { schema: { schemaVersion: 2 }, store: { [first.id]: first } } };
    const local = { document: { ...base.document, store: {} } };
    const remote = { document: { ...base.document, store: { ...base.document.store, [second.id]: second } } };
    const merge = mergeDisjointCanvasSnapshots(base, local, remote);
    expect(merge).toMatchObject({ localChanges: 1, remoteChanges: 1 });
    expect(merge?.snapshot.document).toMatchObject({ store: { [second.id]: second } });
  });

  // ── RC-2: пробел прежнего правила — удаление «своей» рамки/группы на одной стороне и новый ребёнок в ней на другой
  // проходили проверку (обе записи «свои») и давали сироту с parentId на удалённого родителя. ──
  it("refuses a manual merge that would orphan a new child of a frame or group removed on the other side", () => {
    const shape = (id: string, kind: "frame" | "group" | "note", parentId = "page:page") => ({
      id: `shape:${id}`,
      typeName: "shape",
      type: "ppm-canvas-node",
      parentId,
      props: { node: serializePpmCanvasNode(createPpmCanvasNode({ authorId: "user-one", kind, title: id })) },
    });
    for (const kind of ["frame", "group"] as const) {
      const container = shape(`${kind}-parent`, kind);
      const child = shape(`${kind}-child`, "note", container.id);
      const page = { id: "page:page", typeName: "page", name: "Page 1", index: "a1", meta: {} };
      const base = {
        document: { schema: { schemaVersion: 2 }, store: { [page.id]: page, [container.id]: container } },
      };
      const withoutContainer = { document: { ...base.document, store: { [page.id]: page } } };
      const withChild = { document: { ...base.document, store: { ...base.document.store, [child.id]: child } } };
      // The container is removed locally while a teammate puts a new card into it — and the mirror case.
      expect(mergeDisjointCanvasSnapshots(base, withoutContainer, withChild)).toBeUndefined();
      expect(mergeDisjointCanvasSnapshots(base, withChild, withoutContainer)).toBeUndefined();
    }
  });
  // ── /RC-2 ──

  it("treats reordered JSON keys as the same saved snapshot", () => {
    const first = { document: { schema: { schemaVersion: 2, sequences: { alpha: 1, beta: 2 } }, store: {} } };
    const reordered = { document: { store: {}, schema: { sequences: { beta: 2, alpha: 1 }, schemaVersion: 2 } } };
    expect(sameCanvasSnapshots(first, reordered)).toBe(true);
    expect(sameCanvasSnapshots(first, { document: { ...first.document, store: { "shape:new": {} } } })).toBe(false);
  });
});
