/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// RC-2 (AF1.2, inventory §3.3): an open board rebases itself onto the teammate's saved version instead of locking.
// The server stays the strict arbiter (optimistic version, 409, idempotent operation IDs are untouched): the client reads
// the saved version, merges it with its own unsaved records three ways (base = last synced snapshot), applies the
// teammate's part through `store.mergeRemoteChanges` (not undoable, not a user change) and saves the result with the new
// base version. Rules (owner decisions R-B3…R-B6):
// - a record changed on one side takes that side; changed on both sides — merged field by field (the node JSON of a PPM
//   card too, `updated_at` = the later one);
// - the same field of one object on both sides: the saved (teammate's) version stays, the local one becomes a labelled
//   sibling copy «Конфликтная копия» (own PPM cards and native shapes); a collision of positions only
//   (x/y/rotation/index/parentId) keeps the saved position without a copy; projections, arrows, bindings and system
//   cards keep the teammate's version (their content lives in Plane/Vault/Git or is recomputed by tldraw);
// - the shape under edit (tldraw editing state or a focused field of a card) is never touched: the whole rebase waits
//   until editing ends, and then the local version stays and the teammate's becomes the copy;
// - an edit wins over a removal, with the chain of ancestors a kept child or arrow needs; a projection removed by the
//   teammate stays removed (its server binding is gone). A violation that cannot be repaired, document or page records
//   changed on both sides, a different document schema or a result over the save limit → the manual mode (unchanged).
import { getIndexAbove, type IndexKey, type TLRecord, type TLStore } from "tldraw";
import {
  PPM_CANVAS_OWNED_NODE_KINDS,
  duplicatePpmCanvasNode,
  parseSerializedPpmCanvasNode,
  ppmCanvasSnapshotSchema,
  serializePpmCanvasNode,
  type TPpmCanvasNode,
  type TPpmCanvasOwnedNode,
  type TPpmCanvasReadResponse,
  type TPpmCanvasSnapshot,
} from "@ppm/canvas";
import { missingCanvasReferences, stableCanvasJson } from "./board-recovery";

type TRecord = Record<string, unknown>;

/** Fallback only: the editor writes the user's translation (`canvas.rc2.copy_label`) into the copy's title. */
export const CANVAS_CONFLICT_COPY_LABEL = "Конфликтная копия";
export const CANVAS_REBASE_MAX_ATTEMPTS = 3;
const COPY_OFFSET = 32;
const TITLE_LIMIT = 160;
const LAYOUT_FIELDS = new Set(["x", "y", "rotation", "index", "parentId"]);
const OWNED_KINDS = new Set<string>(PPM_CANVAS_OWNED_NODE_KINDS);
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

/** `PPM_CANVAS_AUTOMERGE` (R-B2): on by default; "0/false/no/off/disabled" restores the manual conflict mode. */
export function isPpmCanvasAutomergeEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !OFF_VALUES.has(value.trim().toLowerCase());
}

/** R-B6: pause before re-reading the board after a stale save — 250 ms doubling, ±50 % jitter, at most 2 s. */
export function canvasRebaseRetryDelayMs(attempt: number, random = Math.random()): number {
  const base = Math.min(1_000, 250 * 2 ** Math.min(4, Math.max(0, Math.floor(attempt))));
  const jitter = 0.5 + Math.min(1, Math.max(0, random));
  return Math.min(2_000, Math.round(base * jitter));
}

/** R-B6: with a teammate on the board the autosave waits ~2 s, so two typists do not chain 409s. */
export function canvasAutosaveDelayMs(participants: number, delay = 1_000): number {
  return participants > 1 ? Math.max(delay, 2_000) : delay;
}

export type TPpmCanvasBindingChanges = { activate: readonly string[]; remove: readonly string[] };

/**
 * Texts of the rebase in the user's language (`@ppm/brand`, `canvas.rc2.*`): the copy label written into the board and
 * the notice templates (`{label}`, `{count}`).
 */
export type TPpmCanvasRebaseStrings = {
  copyLabel: string;
  localCopy: string;
  objectsCount: string;
  remoteCopy: string;
  remoteWins: string;
  restoredLocal: string;
  restoredRemote: string;
};

export type TPpmCanvasRebaseOptions = {
  authorId: string;
  /** Pending server-binding operations of the unsaved local state (activations of new projections, removals). */
  bindingChanges?: TPpmCanvasBindingChanges;
  copyLabel: string;
  createShapeId: () => string;
  maxBytes?: number;
  now: string;
  /** Shapes that were under edit while the rebase waited: a content collision keeps the local version. */
  preferLocalIds?: ReadonlySet<string>;
  /** The shape under edit right now: its record is never touched — a teammate's change to it postpones the rebase. */
  protectedIds?: ReadonlySet<string>;
  /** Active server bindings of the saved version: a queued removal of anything else is already done. */
  serverActiveBindingIds?: ReadonlySet<string>;
};

export type TPpmCanvasRebaseConflict = {
  copyId?: string;
  id: string;
  resolution: "local_copy" | "remote_copy" | "remote_wins";
};

export type TPpmCanvasRebaseRestore = { deletedBy: "local" | "remote"; id: string };

export type TPpmCanvasRebaseManualReason = "invalid" | "integrity" | "schema" | "structure" | "too_large";

export type TPpmCanvasRebaseMerged = {
  bindingChanges: { activate: string[]; remove: string[] };
  conflicts: TPpmCanvasRebaseConflict[];
  droppedBindingChanges: { activate: string[]; remove: string[] };
  localChanges: number;
  patch: { put: TRecord[]; remove: string[] };
  remoteChanges: number;
  restored: TPpmCanvasRebaseRestore[];
  snapshot: TPpmCanvasSnapshot;
  status: "merged";
};

export type TPpmCanvasRebase =
  | TPpmCanvasRebaseMerged
  | { ids: string[]; status: "postpone" }
  | { reason: TPpmCanvasRebaseManualReason; status: "manual" };

type TRecordKind =
  | "binding"
  | "connector"
  | "container"
  | "native"
  | "other"
  | "owned"
  | "projection"
  | "structure"
  | "system";

function isRecord(value: unknown): value is TRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const jsonCache = new WeakMap<object, string>();
function stable(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return stableCanvasJson(value);
  const cached = jsonCache.get(value);
  if (cached !== undefined) return cached;
  const json = stableCanvasJson(value) ?? "";
  jsonCache.set(value, json);
  return json;
}

function same(first: unknown, second: unknown): boolean {
  return first === second || stable(first) === stable(second);
}

function storeOf(snapshot: TPpmCanvasSnapshot | null | undefined): TRecord | undefined {
  const document = snapshot?.document;
  if (!isRecord(document) || !isRecord(document.store)) return undefined;
  return document.store;
}

function metadataOf(snapshot: TPpmCanvasSnapshot): string | undefined {
  return stable({ ...(snapshot.document as TRecord), store: undefined });
}

function nodeOf(record: unknown): TPpmCanvasNode | undefined {
  if (!isRecord(record) || record.type !== "ppm-canvas-node" || !isRecord(record.props)) return undefined;
  const serialized = record.props.node;
  if (typeof serialized !== "string") return undefined;
  const parsed = parseSerializedPpmCanvasNode(serialized);
  return parsed.status === "valid" || parsed.status === "migrated" ? parsed.node : undefined;
}

function projectionBindingId(record: unknown): string | undefined {
  const node = nodeOf(record);
  if (!node || !("binding" in node) || !isRecord(node.binding)) return undefined;
  return typeof node.binding.binding_id === "string" ? node.binding.binding_id : undefined;
}

function kindOf(record: unknown): TRecordKind {
  if (!isRecord(record)) return "other";
  if (record.typeName === "document" || record.typeName === "page") return "structure";
  if (record.typeName === "binding") return "binding";
  if (record.typeName !== "shape") return "other";
  if (record.type === "ppm-canvas-node") {
    const node = nodeOf(record);
    if (!node) return "system";
    if (projectionBindingId(record)) return "projection";
    return OWNED_KINDS.has(node.kind) ? "owned" : "system";
  }
  if (record.type === "arrow") return "connector";
  if (record.type === "group") return "container";
  return "native";
}

type TFieldMerge = { conflicts: string[][]; value: unknown };

function parseJsonObject(value: string): TRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Three-way merge of one value; a conflicting path takes the saved (remote) value and is reported. */
function mergeField(base: unknown, local: unknown, remote: unknown, path: string[]): TFieldMerge {
  if (same(local, remote)) return { conflicts: [], value: local };
  if (same(base, local)) return { conflicts: [], value: remote };
  if (same(base, remote)) return { conflicts: [], value: local };
  if (path.at(-1) === "updated_at" && typeof local === "string" && typeof remote === "string")
    return { conflicts: [], value: local > remote ? local : remote };
  if (isRecord(local) && isRecord(remote) && (base === undefined || isRecord(base))) {
    const value: TRecord = {};
    const conflicts: string[][] = [];
    for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)])) {
      const merged = mergeField(base?.[key], local[key], remote[key], [...path, key]);
      if (merged.value !== undefined) value[key] = merged.value;
      conflicts.push(...merged.conflicts);
    }
    return { conflicts, value };
  }
  // A PPM card keeps its node as a JSON string: merge inside it, then accept the result only if it is still a node.
  if (path.length === 2 && path[0] === "props" && path[1] === "node") {
    const nodes = [base, local, remote].map((item) => (typeof item === "string" ? parseJsonObject(item) : undefined));
    if (nodes.every((node) => node !== undefined)) {
      const merged = mergeField(nodes[0], nodes[1], nodes[2], [...path, "#"]);
      if (merged.conflicts.length > 0) return { conflicts: merged.conflicts, value: remote };
      const serialized = JSON.stringify(merged.value);
      const parsed = parseSerializedPpmCanvasNode(serialized);
      if (parsed.status === "valid" || parsed.status === "migrated") return { conflicts: [], value: serialized };
    }
  }
  return { conflicts: [path], value: remote };
}

function clipTitle(title: string): string {
  const characters = Array.from(title);
  while (characters.join("").length > TITLE_LIMIT) characters.pop();
  return characters.join("");
}

function indexAbove(index: unknown): unknown {
  if (typeof index !== "string") return index;
  try {
    return getIndexAbove(index as IndexKey);
  } catch {
    return index;
  }
}

/**
 * A sibling copy of one version of a record: shifted, just above it, labelled (card title or `meta` of a native).
 * `mine` — the local version (its author is the user); a teammate's version keeps its own author. Checklist items keep
 * their Plane task only while the canonical version does not carry that task (a task stays linked exactly once).
 */
function conflictCopy(
  source: TRecord,
  canonical: TRecord,
  mine: boolean,
  options: TPpmCanvasRebaseOptions
): TRecord | undefined {
  const copy: TRecord = {
    ...source,
    id: options.createShapeId(),
    index: indexAbove(source.index),
    x: (typeof source.x === "number" ? source.x : 0) + COPY_OFFSET,
    y: (typeof source.y === "number" ? source.y : 0) + COPY_OFFSET,
  };
  if (source.type !== "ppm-canvas-node") {
    copy.meta = { ...(isRecord(source.meta) ? source.meta : {}), ppm_conflict_copy_of: source.id };
    return copy;
  }
  const node = nodeOf(source);
  if (!node || !OWNED_KINDS.has(node.kind) || !isRecord(source.props)) return undefined;
  const duplicate = duplicatePpmCanvasNode(
    node as TPpmCanvasOwnedNode,
    mine ? options.authorId : node.author_id,
    options.now
  ) as TPpmCanvasOwnedNode;
  const canonicalNode = nodeOf(canonical);
  if (duplicate.kind === "checklist" && node.kind === "checklist") {
    const linked = new Set(
      canonicalNode?.kind === "checklist" ? canonicalNode.items.map((item) => item.work_item_id).filter(Boolean) : []
    );
    duplicate.items = duplicate.items.map((item, index) => {
      const workItemId = node.items[index]?.work_item_id;
      return workItemId && !linked.has(workItemId) ? { ...item, work_item_id: workItemId } : item;
    });
  }
  const label = options.copyLabel || CANVAS_CONFLICT_COPY_LABEL;
  const title = duplicate.title ? `${label} · ${duplicate.title}` : label;
  const serialized = serializePpmCanvasNode({ ...duplicate, title: clipTitle(title) } as TPpmCanvasNode);
  const parsed = parseSerializedPpmCanvasNode(serialized);
  if (parsed.status !== "valid" && parsed.status !== "migrated") return undefined;
  copy.props = { ...source.props, node: serialized };
  return copy;
}

/**
 * Rebase of the live board (`local`) onto the saved version (`remote`) from the last synced snapshot (`base`) — the
 * snapshots must share one document schema (normalize them first). Returns the records to put/remove in the editor
 * (`patch`, relative to `local`) and the full `snapshot` to save; or `postpone` (the shape under edit changed) or
 * `manual` (the old conflict mode).
 */
export function rebaseCanvasRecords(
  base: TPpmCanvasSnapshot,
  local: TPpmCanvasSnapshot,
  remote: TPpmCanvasSnapshot,
  options: TPpmCanvasRebaseOptions
): TPpmCanvasRebase {
  const baseStore = storeOf(base);
  const localStore = storeOf(local);
  const remoteStore = storeOf(remote);
  if (!baseStore || !localStore || !remoteStore) return { reason: "invalid", status: "manual" };
  if (metadataOf(base) !== metadataOf(local) || metadataOf(base) !== metadataOf(remote))
    return { reason: "schema", status: "manual" };

  const protectedIds = options.protectedIds ?? new Set<string>();
  const preferLocalIds = options.preferLocalIds ?? new Set<string>();
  const final = new Map<string, unknown>();
  const conflicts: TPpmCanvasRebaseConflict[] = [];
  const restored: TPpmCanvasRebaseRestore[] = [];
  const postponed: string[] = [];
  let localChanges = 0;
  let remoteChanges = 0;

  for (const id of new Set([...Object.keys(baseStore), ...Object.keys(localStore), ...Object.keys(remoteStore)])) {
    const before = baseStore[id];
    const locally = localStore[id];
    const remotely = remoteStore[id];
    const changedLocally = !same(before, locally);
    const changedRemotely = !same(before, remotely);
    if (changedLocally) localChanges += 1;
    if (changedRemotely) remoteChanges += 1;
    if (!changedRemotely) {
      if (locally !== undefined) final.set(id, locally);
      continue;
    }
    if (protectedIds.has(id) && !same(locally, remotely)) {
      postponed.push(id);
      continue;
    }
    if (!changedLocally || same(locally, remotely)) {
      if (remotely !== undefined) final.set(id, remotely);
      continue;
    }
    // Changed on both sides, differently.
    const kind = kindOf(locally ?? remotely);
    if (kind === "structure") return { reason: "structure", status: "manual" };
    if (locally === undefined) {
      // Removed here, edited by the teammate: the edit wins.
      final.set(id, remotely);
      if (kind !== "binding") restored.push({ deletedBy: "local", id });
      continue;
    }
    if (remotely === undefined) {
      // Removed by the teammate, edited here: own content is kept; a projection's server binding is already gone and
      // a binding follows its arrow — both stay removed.
      if (kind === "projection" || kind === "binding") continue;
      final.set(id, locally);
      restored.push({ deletedBy: "remote", id });
      continue;
    }
    const merged = mergeField(before, locally, remotely, []);
    const contentConflict = merged.conflicts.some((path) => path.length !== 1 || !LAYOUT_FIELDS.has(path[0] ?? ""));
    if (!contentConflict) {
      final.set(id, merged.value);
      continue;
    }
    if (kind !== "owned" && kind !== "native") {
      final.set(id, merged.value);
      conflicts.push({ id, resolution: "remote_wins" });
      continue;
    }
    const keepLocal = preferLocalIds.has(id);
    const copy = keepLocal
      ? conflictCopy(remotely as TRecord, locally as TRecord, false, options)
      : conflictCopy(locally as TRecord, remotely as TRecord, true, options);
    if (!copy) return { reason: "integrity", status: "manual" };
    final.set(id, keepLocal ? locally : remotely);
    final.set(copy.id as string, copy);
    conflicts.push({ copyId: copy.id as string, id, resolution: keepLocal ? "remote_copy" : "local_copy" });
  }
  if (postponed.length > 0) return { ids: postponed, status: "postpone" };

  // Integrity: every shape has its parent, every binding both ends. An edit wins over a removal — the missing record
  // (and, in the next round, its own ancestors) comes back from the side that still has it.
  const restoredIds = new Set(restored.map((item) => item.id));
  for (let round = 0; ; round += 1) {
    const missing = missingCanvasReferences(final);
    if (missing.length === 0) break;
    if (round > final.size + 1) return { reason: "integrity", status: "manual" };
    for (const reference of missing) {
      if (!final.has(reference.id) || final.has(reference.missing)) continue;
      const dependent = final.get(reference.id);
      const fromLocal = localStore[reference.missing];
      const fromRemote = remoteStore[reference.missing];
      const deletedBy = fromLocal === undefined ? "local" : "remote";
      const candidate = fromLocal ?? fromRemote;
      // A projection removed by the teammate cannot come back (its server binding is removed): an arrow end simply
      // becomes free, as when tldraw deletes a bound shape.
      const irrecoverable = candidate === undefined || (deletedBy === "remote" && kindOf(candidate) === "projection");
      if (irrecoverable) {
        if (isRecord(dependent) && dependent.typeName === "binding") {
          final.delete(reference.id);
          continue;
        }
        return { reason: "integrity", status: "manual" };
      }
      final.set(reference.missing, candidate);
      if (!restoredIds.has(reference.missing)) {
        restoredIds.add(reference.missing);
        restored.push({ deletedBy, id: reference.missing });
      }
    }
  }

  // A restored object gets back the arrow bindings that went with its removal (tldraw removes them with the shape),
  // from the side that still has them, once both ends are on the board.
  for (const { deletedBy, id } of restored) {
    const source = deletedBy === "local" ? remoteStore : localStore;
    for (const [bindingId, record] of Object.entries(source)) {
      if (final.has(bindingId) || !isRecord(record) || record.typeName !== "binding") continue;
      if (record.fromId !== id && record.toId !== id) continue;
      if (final.has(String(record.fromId)) && final.has(String(record.toId))) final.set(bindingId, record);
    }
  }

  // Server binding operations follow the merged board (R-B4): an activation needs its shape, a removal needs the shape
  // gone and the binding still active.
  const presentBindings = new Set<string>();
  for (const record of final.values()) {
    const bindingId = projectionBindingId(record);
    if (bindingId) presentBindings.add(bindingId);
  }
  const pending = options.bindingChanges ?? { activate: [], remove: [] };
  const bindingChanges = { activate: [] as string[], remove: [] as string[] };
  const droppedBindingChanges = { activate: [] as string[], remove: [] as string[] };
  for (const bindingId of pending.activate)
    (presentBindings.has(bindingId) ? bindingChanges : droppedBindingChanges).activate.push(bindingId);
  for (const bindingId of pending.remove) {
    const keep =
      !presentBindings.has(bindingId) &&
      (options.serverActiveBindingIds === undefined || options.serverActiveBindingIds.has(bindingId));
    (keep ? bindingChanges : droppedBindingChanges).remove.push(bindingId);
  }

  const put: TRecord[] = [];
  const remove: string[] = [];
  for (const id of new Set([...Object.keys(localStore), ...final.keys()])) {
    if (final.has(id)) {
      const record = final.get(id);
      if (!(id in localStore) || !same(localStore[id], record)) put.push(record as TRecord);
    } else remove.push(id);
  }

  const snapshot = ppmCanvasSnapshotSchema.parse({
    ...remote,
    document: { ...(remote.document as TRecord), store: Object.fromEntries(final) },
  });
  if (options.maxBytes !== undefined && new TextEncoder().encode(JSON.stringify(snapshot)).length > options.maxBytes)
    return { reason: "too_large", status: "manual" };

  return {
    bindingChanges,
    conflicts,
    droppedBindingChanges,
    localChanges,
    patch: { put, remove },
    remoteChanges,
    restored,
    snapshot,
    status: "merged",
  };
}

function fillTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  );
}

/** The non-blocking notice after a rebase in the user's language; nothing when the boards merged without a collision. */
export function describeCanvasRebase(
  result: TPpmCanvasRebaseMerged,
  strings: TPpmCanvasRebaseStrings
): string | undefined {
  const label = strings.copyLabel || CANVAS_CONFLICT_COPY_LABEL;
  const counts: [string, number][] = [
    [strings.localCopy, result.conflicts.filter((conflict) => conflict.resolution === "local_copy").length],
    [strings.remoteCopy, result.conflicts.filter((conflict) => conflict.resolution === "remote_copy").length],
    [strings.remoteWins, result.conflicts.filter((conflict) => conflict.resolution === "remote_wins").length],
    [strings.restoredLocal, result.restored.filter((item) => item.deletedBy === "local").length],
    [strings.restoredRemote, result.restored.filter((item) => item.deletedBy === "remote").length],
  ];
  const parts = counts
    .filter(([, count]) => count > 0)
    .map(([template, count]) => {
      const text = fillTemplate(template, { label });
      return count > 1 ? `${text} ${fillTemplate(strings.objectsCount, { count })}` : text;
    });
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// ── tldraw store helpers (the editor side of the rebase) ──

/**
 * The snapshot in the store's current document schema (migrated like `loadSnapshot` does; only document records), so
 * a board last saved by an older client merges record by record. `null` (never saved) is an empty board. A snapshot
 * from a newer client cannot be migrated → `undefined` (manual mode).
 */
export function normalizeCanvasSnapshot(
  store: Pick<TLStore, "schema" | "scopedTypes">,
  snapshot: TPpmCanvasSnapshot | null
): TPpmCanvasSnapshot | undefined {
  const schema = store.schema.serialize();
  if (!snapshot) return { document: { schema, store: {} } };
  const document = snapshot.document as TRecord;
  if (!isRecord(document.store) || !isRecord(document.schema)) return undefined;
  const migrated = store.schema.migrateStoreSnapshot({
    schema: document.schema as unknown as ReturnType<TLStore["schema"]["serialize"]>,
    store: document.store as never,
  });
  if (migrated.type !== "success") return undefined;
  const records = Object.fromEntries(
    Object.entries(migrated.value as TRecord).filter(
      ([, record]) => isRecord(record) && store.scopedTypes.document.has(record.typeName as TLRecord["typeName"])
    )
  );
  return { ...snapshot, document: { ...document, schema, store: records } };
}

class PartialRebasePatch extends Error {}

/**
 * Applies the teammate's part of a rebase as a remote change: tldraw keeps it out of the undo stack and out of
 * `store.listen(…, { source: "user" })`. All or nothing: when a store handler refuses part of the patch, the whole
 * change is rolled back (the store transaction is aborted) and the result is false — the live board stays as it was.
 */
export function applyCanvasRebasePatch(
  store: Pick<TLStore, "has" | "mergeRemoteChanges" | "put" | "remove">,
  patch: TPpmCanvasRebaseMerged["patch"]
): boolean {
  const records = patch.put as unknown as TLRecord[];
  const removed = patch.remove as TLRecord["id"][];
  if (records.length === 0 && removed.length === 0) return true;
  try {
    store.mergeRemoteChanges(() => {
      if (records.length > 0) store.put(records);
      if (removed.length > 0) store.remove(removed);
      if (!records.every((record) => store.has(record.id)) || removed.some((id) => store.has(id)))
        throw new PartialRebasePatch();
    });
  } catch (error) {
    if (error instanceof PartialRebasePatch) return false;
    throw error;
  }
  return true;
}

export type TPpmCanvasRebaseEditor = {
  getSnapshot: () => { document: unknown };
  store: Pick<TLStore, "has" | "mergeRemoteChanges" | "put" | "remove" | "schema" | "scopedTypes">;
};

export type TPpmCanvasRebaseStep =
  | { baseline: TPpmCanvasSnapshot; merge: TPpmCanvasRebaseMerged; remote: TPpmCanvasReadResponse; status: "applied" }
  | { remote: TPpmCanvasReadResponse; status: "current" }
  | { ids: string[]; status: "postpone" }
  | {
      reason: TPpmCanvasRebaseManualReason | "access" | "corrupt" | "patch";
      /** The saved version that was read — without local edits the editor simply loads it (the pre-RC-2 reload). */
      remote: TPpmCanvasReadResponse;
      status: "manual";
    }
  | { status: "stale" };

/**
 * One rebase of the open board (§3.3 steps 2–4): read the saved version, merge it with the live document captured in
 * the same tick, apply the teammate's part as a remote change. The caller then saves the result with the new base
 * version (step 5) — or keeps waiting (`postpone`), or falls back to the manual mode.
 */
export async function rebaseOpenBoard({
  afterApply,
  authorId,
  base,
  beforeApply,
  bindingChanges,
  canEdit,
  copyLabel,
  createShapeId,
  editor,
  isCurrent,
  maxBytes,
  now,
  preferLocalIds,
  protectedShapeIds,
  read,
  version,
}: {
  /** Runs right after the patch, in the same tick: the caller applies the rebase's own queue deltas there. */
  afterApply?: (merge: TPpmCanvasRebaseMerged) => void;
  authorId: string;
  base: TPpmCanvasSnapshot | null;
  /** Runs right before the patch is applied (the editor pre-approves removals its own delete guards would block). */
  beforeApply?: (merge: TPpmCanvasRebaseMerged) => void;
  /** The live binding operation queues — read after the saved version arrives, in the tick of the local capture. */
  bindingChanges: () => TPpmCanvasBindingChanges;
  canEdit: boolean;
  copyLabel: string;
  createShapeId: () => string;
  editor: TPpmCanvasRebaseEditor;
  /** False once the board was switched or re-initialized while the read was in flight. */
  isCurrent: () => boolean;
  maxBytes: number;
  now: string;
  preferLocalIds?: ReadonlySet<string>;
  /** Shapes the user is editing right now (tldraw editing state or a focused field of a card) — never touched. */
  protectedShapeIds: () => readonly string[];
  read: () => Promise<TPpmCanvasReadResponse>;
  version: number;
}): Promise<TPpmCanvasRebaseStep> {
  const remote = await read();
  if (!isCurrent()) return { status: "stale" };
  if (!canEdit || remote.access !== "edit") return { reason: "access", remote, status: "manual" };
  if (remote.snapshot_status === "corrupt") return { reason: "corrupt", remote, status: "manual" };
  if (remote.version === version) return { remote, status: "current" };
  if (remote.version < version) return { reason: "invalid", remote, status: "manual" };
  const baseline = normalizeCanvasSnapshot(editor.store, remote.snapshot);
  const normalizedBase = normalizeCanvasSnapshot(editor.store, base);
  if (!baseline || !normalizedBase) return { reason: "schema", remote, status: "manual" };
  // From here on everything is synchronous: nothing the user does can slip between the capture of the live board and
  // its queues, the merge and the patch.
  const local = { document: editor.getSnapshot().document } as TPpmCanvasSnapshot;
  const protectedIds = new Set(protectedShapeIds());
  const merge = rebaseCanvasRecords(normalizedBase, local, baseline, {
    authorId,
    bindingChanges: bindingChanges(),
    copyLabel,
    createShapeId,
    maxBytes,
    now,
    preferLocalIds,
    protectedIds,
    serverActiveBindingIds: new Set(remote.bindings.map((binding) => binding.binding_id)),
  });
  if (merge.status === "postpone") return merge;
  if (merge.status === "manual") return { reason: merge.reason, remote, status: "manual" };
  beforeApply?.(merge);
  try {
    if (!applyCanvasRebasePatch(editor.store, merge.patch)) return { reason: "patch", remote, status: "manual" };
  } catch {
    // A record the store rejects rolls the whole remote change back: the live board is untouched.
    return { reason: "patch", remote, status: "manual" };
  }
  afterApply?.(merge);
  return { baseline, merge, remote, status: "applied" };
}
