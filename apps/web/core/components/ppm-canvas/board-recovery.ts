import { z } from "zod";
import {
  PPM_CANVAS_OWNED_NODE_KINDS,
  PPM_CANVAS_SCHEMA_VERSION,
  parseSerializedPpmCanvasNode,
  ppmCanvasSnapshotSchema,
  type TPpmCanvasSnapshot,
} from "@ppm/canvas";

const recoveryDraftSchema = z.object({
  format: z.literal("ppm-canvas-recovery"),
  schema_version: z.literal(PPM_CANVAS_SCHEMA_VERSION),
  base_version: z.number().int().nonnegative(),
  saved_at: z.string().datetime(),
  snapshot: ppmCanvasSnapshotSchema,
  binding_changes: z.object({
    activate: z.array(z.string().uuid()),
    remove: z.array(z.string().uuid()),
  }),
  pending_operation: z
    .object({
      base_version: z.number().int().nonnegative(),
      binding_changes: z.object({
        activate: z.array(z.string().uuid()),
        remove: z.array(z.string().uuid()),
      }),
      client_operation_id: z.string().uuid(),
      snapshot: ppmCanvasSnapshotSchema,
    })
    .optional(),
});

export type TPpmCanvasRecoveryDraft = z.infer<typeof recoveryDraftSchema>;

export type TPpmCanvasRecoveryScope = {
  authorId: string;
  boardId: string;
  projectId: string;
  workspaceId: string;
};

export function canvasRecoveryKey(scope: TPpmCanvasRecoveryScope): string {
  return ["ppm", "canvas", "recovery", "v1", scope.workspaceId, scope.projectId, scope.boardId, scope.authorId]
    .map(encodeURIComponent)
    .join(":");
}

function durableCanvasRecoveryPrefix(scope: TPpmCanvasRecoveryScope): string {
  return (
    ["ppm", "canvas", "durable-recovery", "v1", scope.workspaceId, scope.projectId, scope.boardId, scope.authorId]
      .map(encodeURIComponent)
      .join(":") + ":"
  );
}

export function durableCanvasRecoveryKey(scope: TPpmCanvasRecoveryScope, instanceId: string): string {
  return `${durableCanvasRecoveryPrefix(scope)}${encodeURIComponent(instanceId)}`;
}

export type TPpmCanvasDurableRecoveryCandidate = { key: string; draft: TPpmCanvasRecoveryDraft };

export function listDurableCanvasRecoveryDrafts(
  storage: Pick<Storage, "length" | "key" | "getItem" | "removeItem">,
  scope: TPpmCanvasRecoveryScope
): TPpmCanvasDurableRecoveryCandidate[] {
  const prefix = durableCanvasRecoveryPrefix(scope);
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys.flatMap((key) => {
    try {
      const raw = storage.getItem(key);
      if (!raw) return [];
      const result = recoveryDraftSchema.safeParse(JSON.parse(raw));
      if (result.success) return [{ key, draft: result.data }];
      storage.removeItem(key);
    } catch {
      // Inaccessible or malformed records cannot be used as a trusted draft.
    }
    return [];
  });
}

export function writeDurableCanvasRecoveryDraft(
  storage: Pick<Storage, "setItem">,
  scope: TPpmCanvasRecoveryScope,
  instanceId: string,
  draft: TPpmCanvasRecoveryDraft
): boolean {
  const key = durableCanvasRecoveryKey(scope, instanceId);
  try {
    storage.setItem(key, JSON.stringify(recoveryDraftSchema.parse(draft)));
    return true;
  } catch {
    // Keep any older valid draft: it may be the only surviving copy. The editor
    // warns that the latest changes were not durably protected.
    return false;
  }
}

export function clearDurableCanvasRecoveryDraft(storage: Pick<Storage, "removeItem">, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage may be unavailable after the board was loaded.
  }
}

export function readCanvasRecoveryDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  scope: TPpmCanvasRecoveryScope
): TPpmCanvasRecoveryDraft | undefined {
  const key = canvasRecoveryKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const result = recoveryDraftSchema.safeParse(JSON.parse(raw));
    if (result.success) return result.data;
    storage.removeItem(key);
  } catch {
    // Browser storage may be disabled or contain an incomplete write.
  }
  return undefined;
}

export function writeCanvasRecoveryDraft(
  storage: Pick<Storage, "setItem" | "removeItem">,
  scope: TPpmCanvasRecoveryScope,
  draft: TPpmCanvasRecoveryDraft
): boolean {
  const key = canvasRecoveryKey(scope);
  try {
    storage.setItem(key, JSON.stringify(recoveryDraftSchema.parse(draft)));
    return true;
  } catch {
    // An outdated partial draft must not masquerade as the newest local state.
    try {
      storage.removeItem(key);
    } catch {
      // Storage itself is unavailable; the UI shows that recovery is not protected.
    }
    return false;
  }
}

export function serializeCanvasRecoveryDraft(draft: TPpmCanvasRecoveryDraft): string {
  // A recovery file is intentionally not a board export: its base version and
  // pending binding operations must survive a manual conflict investigation.
  return JSON.stringify(recoveryDraftSchema.parse(draft), null, 2);
}

export function clearCanvasRecoveryDraft(storage: Pick<Storage, "removeItem">, scope: TPpmCanvasRecoveryScope): void {
  try {
    storage.removeItem(canvasRecoveryKey(scope));
  } catch {
    // Storage may be disabled; there is no trusted local draft to clear.
  }
}

export function classifyCanvasRecoveryDraft(
  draft: TPpmCanvasRecoveryDraft,
  serverVersion: number,
  serverSnapshot: TPpmCanvasSnapshot | null
): "already_saved" | "restore" | "export_only" {
  if (
    serverSnapshot &&
    sameCanvasSnapshots(serverSnapshot, draft.snapshot) &&
    draft.binding_changes.activate.length === 0 &&
    draft.binding_changes.remove.length === 0
  )
    return "already_saved";
  return serverVersion === draft.base_version ? "restore" : "export_only";
}

export type TPpmCanvasDisjointMerge = {
  snapshot: TPpmCanvasSnapshot;
  localChanges: number;
  remoteChanges: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownedShapeRecord(value: unknown): boolean {
  if (!isRecord(value) || value.typeName !== "shape" || value.type !== "ppm-canvas-node" || !isRecord(value.props))
    return false;
  const serialized = value.props.node;
  if (typeof serialized !== "string") return false;
  const parsed = parseSerializedPpmCanvasNode(serialized);
  return (
    (parsed.status === "valid" || parsed.status === "migrated") &&
    PPM_CANVAS_OWNED_NODE_KINDS.some((kind) => kind === parsed.node.kind)
  );
}

function snapshotStore(snapshot: TPpmCanvasSnapshot): Record<string, unknown> | undefined {
  if (!isRecord(snapshot.document) || !isRecord(snapshot.document.store)) return undefined;
  return snapshot.document.store;
}

function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            // oxlint-disable-next-line unicorn/no-array-sort -- Object.keys returns a new array.
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
}

export function sameCanvasSnapshots(first: TPpmCanvasSnapshot, second: TPpmCanvasSnapshot): boolean {
  return stableJson(first.document) === stableJson(second.document);
}

// ── RC-2: целостность склейки — у фигуры есть родитель (страница или фигура), у binding — обе конечные фигуры ──
export { stableJson as stableCanvasJson };

export type TPpmCanvasMissingReference = { id: string; field: "parentId" | "fromId" | "toId"; missing: string };

export function missingCanvasReferences(store: ReadonlyMap<string, unknown>): TPpmCanvasMissingReference[] {
  const missing: TPpmCanvasMissingReference[] = [];
  for (const [id, record] of store) {
    if (!isRecord(record)) continue;
    const fields =
      record.typeName === "shape"
        ? (["parentId"] as const)
        : record.typeName === "binding"
          ? (["fromId", "toId"] as const)
          : [];
    for (const field of fields) {
      const target = record[field];
      // A record without the field is malformed for tldraw itself (its validator rejects it); only real links count.
      if (typeof target === "string" && !store.has(target)) missing.push({ id, field, missing: target });
    }
  }
  return missing;
}
// ── /RC-2 ──

function sameDocumentMetadata(first: TPpmCanvasSnapshot, second: TPpmCanvasSnapshot): boolean {
  return stableJson({ ...first.document, store: undefined }) === stableJson({ ...second.document, store: undefined });
}

export function mergeDisjointCanvasSnapshots(
  base: TPpmCanvasSnapshot,
  local: TPpmCanvasSnapshot,
  remote: TPpmCanvasSnapshot
): TPpmCanvasDisjointMerge | undefined {
  const baseStore = snapshotStore(base);
  const localStore = snapshotStore(local);
  const remoteStore = snapshotStore(remote);
  if (
    !baseStore ||
    !localStore ||
    !remoteStore ||
    !sameDocumentMetadata(base, local) ||
    !sameDocumentMetadata(base, remote)
  )
    return undefined;

  const mergedStore = new Map(Object.entries(remoteStore));
  let localChanges = 0;
  let remoteChanges = 0;
  for (const id of new Set([...Object.keys(baseStore), ...Object.keys(localStore), ...Object.keys(remoteStore)])) {
    const before = baseStore[id];
    const locally = localStore[id];
    const remotely = remoteStore[id];
    const changedLocally = stableJson(before) !== stableJson(locally);
    const changedRemotely = stableJson(before) !== stableJson(remotely);
    if (changedLocally && changedRemotely) return undefined;
    if (changedLocally) {
      if ((before !== undefined && !ownedShapeRecord(before)) || (locally !== undefined && !ownedShapeRecord(locally)))
        return undefined;
      localChanges += 1;
      if (locally === undefined) mergedStore.delete(id);
      else mergedStore.set(id, locally);
    }
    if (changedRemotely) {
      if (
        (before !== undefined && !ownedShapeRecord(before)) ||
        (remotely !== undefined && !ownedShapeRecord(remotely))
      )
        return undefined;
      remoteChanges += 1;
    }
  }
  if (localChanges === 0) return undefined;
  // ── RC-2: ручная склейка не угадывает — сирота (новый ребёнок удалённой рамки/группы) или висящий binding = отказ ──
  if (missingCanvasReferences(mergedStore).length > 0) return undefined;
  // ── /RC-2 ──
  return {
    snapshot: ppmCanvasSnapshotSchema.parse({
      document: { ...remote.document, store: Object.fromEntries(mergedStore) },
    }),
    localChanges,
    remoteChanges,
  };
}
