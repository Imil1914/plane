// RC-2 (AF1.2): the driver test bench — a fake board server with the save rules of `save_canvas_snapshot` (strict
// version, replay of a written operation ID, binding operations validated against the snapshot, offline = no request)
// and a stand-in of the editor's autosave with its contract (`flushSave`: pending operation from the live board and the
// queues, 409 CANVAS_VERSION_CONFLICT → the driver, a network failure keeps the operation). Shared by
// board-rebase-driver.test.ts and board-rebase-reconnect.test.ts.
import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import {
  createPpmWorkItemRefNode,
  serializePpmCanvasNode,
  type TPpmCanvasReadResponse,
  type TPpmCanvasSnapshot,
} from "@ppm/canvas";
import { sameCanvasSnapshots } from "@/components/ppm-canvas/board-recovery";
import {
  PpmCanvasRebaseDriver,
  focusedCardShapeId,
  type TPpmCanvasFocusElement,
  type TPpmCanvasRebaseDriverDeps,
} from "@/components/ppm-canvas/board-rebase-driver";
import { PpmCanvasServiceError } from "@/services/ppm-canvas.service";
import { documentOf, readResponse, recordOf, withRecords, withTitle, type TTestNodeShape } from "./rc2-tldraw";

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export type TSaveRequest = {
  base_version: number;
  binding_changes: { activate: string[]; remove: string[] };
  client_operation_id: string;
  snapshot: TPpmCanvasSnapshot;
};

export function shapeIdsOf(snapshot: TPpmCanvasSnapshot): Set<string> {
  const store = (snapshot.document as { store: Record<string, { typeName?: string }> }).store;
  return new Set(Object.keys(store).filter((id) => store[id]?.typeName === "shape"));
}

function conflict(code: string, currentVersion: number) {
  return new PpmCanvasServiceError(code, { code, details: { current_version: currentVersion }, status: 409 });
}

/** The board on the server: strict version and the binding checks of `_validate_and_lock_binding_changes`. */
export class FakeBoardServer {
  version: number;
  snapshot: TPpmCanvasSnapshot;
  readonly active = new Map<string, string>();
  readonly pending = new Map<string, string>();
  readonly saves: TSaveRequest[] = [];
  reads = 0;
  access: "edit" | "read" = "edit";
  offline = false;
  loseNextAnswer = false;
  private readonly written = new Map<string, number>();
  private gate?: Promise<void>;
  /** Called before a save is checked: a teammate saves first (the save then gets 409). */
  beforeSave?: () => void;

  constructor(snapshot: TPpmCanvasSnapshot, version = 1) {
    this.snapshot = snapshot;
    this.version = version;
  }

  /** The next reads answer only after `release()` — with the state at the moment of the request. */
  holdReads(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = undefined;
      release();
    };
  }

  async read(): Promise<TPpmCanvasReadResponse> {
    this.reads += 1;
    const response = {
      ...readResponse(
        this.snapshot,
        this.version,
        [...this.active].map(([binding_id, shape_id]) => ({ binding_id, shape_id })) as never
      ),
      access: this.access,
    };
    if (this.gate) await this.gate;
    return response;
  }

  teammateSave(change: (snapshot: TPpmCanvasSnapshot) => TPpmCanvasSnapshot): number {
    this.snapshot = change(this.snapshot);
    this.version += 1;
    return this.version;
  }

  async save(request: TSaveRequest): Promise<{ version: number }> {
    // Offline: the request never reaches the server (the service reports it without an HTTP status).
    if (this.offline) throw new PpmCanvasServiceError("Network Error");
    this.beforeSave?.();
    // A written operation ID is replayed (the answer of the first write), as `save_canvas_snapshot` does.
    const written = this.written.get(request.client_operation_id);
    if (written !== undefined) return { version: written };
    if (request.base_version !== this.version) throw conflict("CANVAS_VERSION_CONFLICT", this.version);
    const shapes = shapeIdsOf(request.snapshot);
    for (const id of request.binding_changes.activate) {
      const shapeId = this.pending.get(id);
      if (!shapeId) throw conflict(this.active.has(id) ? "CANVAS_BINDING_NOT_PENDING" : "CANVAS_BINDING_NOT_FOUND", 0);
      if (!shapes.has(shapeId)) throw conflict("CANVAS_BINDING_SHAPE_MISSING", 0);
    }
    for (const id of request.binding_changes.remove) {
      const shapeId = this.active.get(id);
      if (!shapeId) throw conflict("CANVAS_BINDING_NOT_ACTIVE", 0);
      if (shapes.has(shapeId)) throw conflict("CANVAS_BINDING_SHAPE_PRESENT", 0);
    }
    for (const [id, shapeId] of this.active)
      if (!request.binding_changes.remove.includes(id) && !shapes.has(shapeId))
        throw conflict("CANVAS_ACTIVE_BINDING_SHAPE_MISSING", 0);
    for (const id of request.binding_changes.activate) {
      this.active.set(id, this.pending.get(id)!);
      this.pending.delete(id);
    }
    for (const id of request.binding_changes.remove) this.active.delete(id);
    this.saves.push(request);
    this.snapshot = request.snapshot;
    this.version += 1;
    this.written.set(request.client_operation_id, this.version);
    if (this.loseNextAnswer) {
      // Written, but the answer never reaches the page.
      this.loseNextAnswer = false;
      throw new PpmCanvasServiceError("Network Error");
    }
    return { version: this.version };
  }
}

/** The editor's refs, the driver and a stand-in of `flushSave` with the editor's contract. */
/** Operation IDs are unique across the harnesses of a test file (a remount is a new harness, as in the editor). */
let operation = 0;

export function harness(editor: Editor, server: FakeBoardServer) {
  const refs: TPpmCanvasRebaseDriverDeps["refs"] = {
    baseline: { current: server.snapshot },
    blocked: { current: false },
    dirty: { current: false },
    editable: { current: true },
    generation: { current: 1 },
    initialized: { current: true },
    pendingSave: { current: undefined },
    queuedActivations: { current: new Set<string>() },
    queuedRemovals: { current: new Set<string>() },
    remoteConflict: { current: false },
    saving: { current: false },
    version: { current: server.version },
  };
  const log = {
    manual: 0,
    networkErrors: 0,
    notices: [] as string[],
    otherConflicts: [] as string[],
    reloads: 0,
    statuses: [] as string[],
    unsavedAtApply: [] as Set<string>[],
  };
  const tracked = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    tracked.add(promise);
    void promise.finally(() => tracked.delete(promise));
  };
  let focused: TPpmCanvasFocusElement | null = null;
  const container = { contains: (node: unknown) => node !== null && node === focused };

  const flushSave = async () => {
    if (!refs.editable.current || refs.blocked.current || refs.saving.current || driver.isPostponed()) return;
    let pending = refs.pendingSave.current as TSaveRequest | undefined;
    if (!pending) {
      const snapshot = documentOf(editor);
      if (
        refs.baseline.current &&
        refs.queuedActivations.current.size === 0 &&
        refs.queuedRemovals.current.size === 0 &&
        sameCanvasSnapshots(snapshot, refs.baseline.current)
      ) {
        refs.dirty.current = false;
        track(driver.onSaveSettled(false));
        return;
      }
      operation += 1;
      pending = {
        base_version: refs.version.current,
        binding_changes: { activate: [...refs.queuedActivations.current], remove: [...refs.queuedRemovals.current] },
        client_operation_id: `${uuid(0).slice(0, 24)}${String(operation).padStart(12, "0")}`,
        snapshot,
      };
      refs.queuedActivations.current.clear();
      refs.queuedRemovals.current.clear();
      refs.pendingSave.current = pending;
      refs.dirty.current = false;
    }
    refs.saving.current = true;
    try {
      const response = await server.save(pending);
      refs.version.current = response.version;
      refs.baseline.current = pending.snapshot;
      refs.pendingSave.current = undefined;
      refs.saving.current = false;
      track(driver.onSaveSettled(true));
    } catch (error) {
      refs.saving.current = false;
      if (error instanceof PpmCanvasServiceError && error.code === "CANVAS_VERSION_CONFLICT") {
        await driver.onVersionConflict(pending, error.details.current_version);
        return;
      }
      // A network failure keeps the unacknowledged operation (same ID next time), as the editor's autosave does.
      if (error instanceof PpmCanvasServiceError && error.status === undefined) {
        log.networkErrors += 1;
        return;
      }
      // Any other 409 is the pre-RC-2 conflict mode in the editor.
      log.otherConflicts.push(error instanceof PpmCanvasServiceError ? String(error.code) : String(error));
      refs.remoteConflict.current = true;
    }
  };

  const deps: TPpmCanvasRebaseDriverDeps = {
    approveRemoval: () => undefined,
    authorId: "me",
    canEdit: true,
    cancelPendingBinding: async (bindingId) => server.pending.delete(bindingId),
    clearNotice: (text) => {
      log.notices = log.notices.filter((notice) => notice !== text);
    },
    clearSaveTimer: () => undefined,
    createShapeId: () => createShapeId(`copy-${Math.random().toString(36).slice(2, 8)}`),
    editor: () => editor,
    enabled: true,
    enterManualConflict: async () => {
      log.manual += 1;
      refs.remoteConflict.current = true;
      refs.blocked.current = true;
    },
    isRetryableError: () => false,
    maxBytes: 2 * 1024 * 1024,
    now: () => "2026-09-27T02:00:00.000Z",
    onApplied: () => {
      log.unsavedAtApply.push(
        new Set([
          ...refs.queuedActivations.current,
          ...((refs.pendingSave.current as TSaveRequest | undefined)?.binding_changes.activate ?? []),
        ])
      );
    },
    onNotice: (text) => log.notices.push(text),
    onStatus: (status) => log.statuses.push(status),
    protectedShapeIds: () =>
      [editor.getEditingShapeId(), focusedCardShapeId(focused, container)].filter((id): id is NonNullable<typeof id> =>
        Boolean(id)
      ),
    random: () => 0.5,
    read: () => server.read(),
    refs,
    reloadFromRemote: (remote) => {
      // As editor.tsx: the saved version is loaded, the board follows the access it grants.
      log.reloads += 1;
      refs.version.current = remote.version;
      refs.baseline.current = remote.snapshot;
      refs.editable.current = remote.access === "edit";
      refs.blocked.current = remote.access !== "edit";
    },
    save: flushSave,
    scheduleRetry: () => undefined,
    sleep: async () => undefined,
    strings: {
      copyLabel: "Conflict copy",
      localCopy: "local copy “{label}”",
      objectsCount: "Objects: {count}.",
      postponed: "waiting for the end of editing",
      remoteCopy: "remote copy “{label}”",
      remoteWins: "remote wins",
      restoredLocal: "restored (local)",
      restoredRemote: "restored (remote)",
    },
    withdrawApproval: () => undefined,
  };
  const driver = new PpmCanvasRebaseDriver(deps);
  /** Waits for every save/catch-up the driver started on its own (as editor.tsx fires them with `void`). */
  const settle = async (): Promise<void> => {
    if (tracked.size > 0) {
      await Promise.all(tracked);
      return settle();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (tracked.size > 0) return settle();
  };
  return {
    driver,
    flushSave,
    focus: (element: TPpmCanvasFocusElement | null) => {
      focused = element;
    },
    log,
    refs,
    settle,
    /** A user edit as the editor's store listener sees it. */
    userEdit: (change: () => void) => {
      change();
      refs.dirty.current = true;
    },
  };
}

export function projectionShape(editor: Editor, name: string, bindingId: string): TLShapeId {
  const id = createShapeId(name);
  const node = createPpmWorkItemRefNode({
    authorId: "me",
    binding: { binding_id: bindingId, entity_id: uuid(900), entity_type: "work_item", source_version: null },
    now: "2026-09-26T10:00:00.000Z",
  });
  editor.createShape<TTestNodeShape>({
    id,
    props: { h: node.visual.height, node: serializePpmCanvasNode(node), w: node.visual.width },
    type: "ppm-canvas-node",
    x: 400,
    y: 0,
  });
  return id;
}

export function renameOnServer(id: string, title: string) {
  return (snapshot: TPpmCanvasSnapshot) => withRecords(snapshot, [withTitle(recordOf(snapshot, id), title)]);
}
