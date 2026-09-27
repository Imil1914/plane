// RC-2: a real tldraw 3.15.6 Editor in node (vitest `environment: "node"`) — a tiny DOM stand-in for its text
// measurement element, container, rAF and devicePixelRatio, plus the PPM card as the store sees it (type, props
// validators, containers — without its React body). Shared by board-rebase-editor.test.ts and
// board-rebase-driver.test.ts.
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  Editor,
  Rectangle2d,
  ShapeUtil,
  T,
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  defaultTools,
  type RecordProps,
  type TLBaseShape,
  type TLRecord,
  type TLShapeId,
} from "tldraw";
import {
  createPpmCanvasNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasReadResponse,
  type TPpmCanvasSnapshot,
} from "@ppm/canvas";

export type TTestNodeShape = TLBaseShape<"ppm-canvas-node", { h: number; node: string; w: number }>;

class TestPpmNodeShapeUtil extends ShapeUtil<TTestNodeShape> {
  static override type = "ppm-canvas-node" as const;
  static override props: RecordProps<TTestNodeShape> = { h: T.number, node: T.string, w: T.number };
  override getDefaultProps(): TTestNodeShape["props"] {
    return { h: 160, node: "{}", w: 240 };
  }
  override getGeometry(shape: TTestNodeShape) {
    return new Rectangle2d({ height: shape.props.h, isFilled: true, width: shape.props.w });
  }
  override canEdit() {
    return true;
  }
  override canReceiveNewChildrenOfType(shape: TTestNodeShape) {
    const parsed = parseSerializedPpmCanvasNode(shape.props.node);
    return (parsed.status === "valid" || parsed.status === "migrated") && ["frame", "group"].includes(parsed.node.kind);
  }
  override component() {
    return null;
  }
  override indicator() {
    return null;
  }
}

const shapeUtils = [...defaultShapeUtils, TestPpmNodeShapeUtil];

export function fakeElement(): unknown {
  const style = new Map<string, string>();
  return {
    addEventListener() {},
    appendChild() {},
    children: [],
    classList: { add() {}, contains: () => false, remove() {} },
    contains: () => false,
    getBoundingClientRect: () => ({ bottom: 800, height: 800, left: 0, right: 1000, top: 0, width: 1000, x: 0, y: 0 }),
    remove() {},
    removeAttribute() {},
    removeEventListener() {},
    setAttribute() {},
    style: {
      getPropertyValue: (key: string) => style.get(key) ?? "",
      removeProperty: (key: string) => style.delete(key),
      setProperty: (key: string, value: string) => style.set(key, value),
    },
  };
}

/** Installs the DOM stand-in for the file's tests and disposes the editors after each test. */
export function useTldrawInNode(): { createEditor: () => Editor } {
  const installed: string[] = [];
  const editors: Editor[] = [];
  const stub = (name: string, value: unknown) => {
    if (name in globalThis) return;
    (globalThis as Record<string, unknown>)[name] = value;
    installed.push(name);
  };
  beforeAll(() => {
    stub("document", {
      activeElement: null,
      addEventListener() {},
      body: fakeElement(),
      createElement: fakeElement,
      fonts: { add() {}, check: () => true, delete() {}, load: async () => [] },
      removeEventListener() {},
    });
    stub("window", globalThis);
    stub("devicePixelRatio", 1);
    stub("matchMedia", () => ({
      addEventListener() {},
      addListener() {},
      matches: false,
      removeEventListener() {},
      removeListener() {},
    }));
    stub("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
    stub("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  });
  afterEach(() => {
    for (const editor of editors.splice(0)) editor.dispose();
  });
  afterAll(() => {
    for (const name of installed.splice(0)) delete (globalThis as Record<string, unknown>)[name];
  });
  return {
    createEditor: () => {
      const store = createTLStore({ bindingUtils: defaultBindingUtils, shapeUtils });
      const editor = new Editor({
        bindingUtils: defaultBindingUtils,
        getContainer: () => fakeElement() as HTMLElement,
        shapeUtils,
        store,
        tools: defaultTools,
      });
      editors.push(editor);
      return editor;
    },
  };
}

export const flushListeners = () => new Promise((resolve) => setTimeout(resolve, 40));

export function geo(editor: Editor, id: string, x = 0) {
  const shapeId = createShapeId(id);
  editor.createShape({ id: shapeId, type: "geo", x, y: 0, props: { w: 100, h: 100 } });
  return shapeId;
}

export function card(editor: Editor, id: string, title: string, extra: Record<string, unknown> = {}) {
  const shapeId = createShapeId(id);
  const node = { ...createPpmCanvasNode({ authorId: "author", kind: "note", now: "2026-09-26T10:00:00.000Z", title }) };
  editor.createShape<TTestNodeShape>({
    id: shapeId,
    props: {
      h: node.visual.height,
      node: serializePpmCanvasNode({ ...node, ...extra } as never),
      w: node.visual.width,
    },
    type: "ppm-canvas-node",
    x: 0,
    y: 0,
  });
  return shapeId;
}

export function titleOf(editor: Editor, id: TLShapeId): string | undefined {
  const shape = editor.getShape<TTestNodeShape>(id);
  const parsed = shape ? parseSerializedPpmCanvasNode(shape.props.node) : undefined;
  if (!parsed || (parsed.status !== "valid" && parsed.status !== "migrated")) return undefined;
  const title: unknown = (parsed.node as { title?: unknown }).title;
  return typeof title === "string" ? title : undefined;
}

/** The record with its node edited the way the editor does it (the patch plus a fresh `updated_at`). */
export function withNode(record: TLRecord, patch: Record<string, unknown>): TLRecord {
  const shape = record as unknown as TTestNodeShape;
  const parsed = parseSerializedPpmCanvasNode(shape.props.node);
  if (parsed.status !== "valid" && parsed.status !== "migrated") throw new Error("invalid node");
  const node = { ...parsed.node, ...patch, updated_at: "2026-09-27T01:40:00.000Z" };
  return { ...shape, props: { ...shape.props, node: serializePpmCanvasNode(node as never) } } as unknown as TLRecord;
}

export function withTitle(record: TLRecord, title: string): TLRecord {
  return withNode(record, { title });
}

export function documentOf(editor: Editor): TPpmCanvasSnapshot {
  return { document: editor.getSnapshot().document };
}

export function recordOf(snapshot: TPpmCanvasSnapshot, id: string): TLRecord {
  return (snapshot.document as { store: Record<string, TLRecord> }).store[id] as TLRecord;
}

export function withRecords(snapshot: TPpmCanvasSnapshot, put: TLRecord[], remove: string[] = []): TPpmCanvasSnapshot {
  const document = snapshot.document as { schema: unknown; store: Record<string, unknown> };
  const store = { ...document.store };
  for (const record of put) store[record.id] = record;
  for (const id of remove) delete store[id];
  return { document: { ...document, store } };
}

export function readResponse(
  snapshot: TPpmCanvasSnapshot,
  version: number,
  bindings: TPpmCanvasReadResponse["bindings"] = []
): TPpmCanvasReadResponse {
  return {
    access: "edit",
    bindings,
    canvas_id: "00000000-0000-4000-8000-000000000001",
    content_hash: "a".repeat(64),
    name: "Board",
    project_id: "00000000-0000-4000-8000-000000000002",
    saved_at: "2026-09-27T01:40:00.000Z",
    saved_by: "00000000-0000-4000-8000-000000000003",
    schema_version: 2,
    snapshot,
    snapshot_status: "ready",
    version,
    work_item_options: { assignees: [], priorities: [], states: [] },
    workspace_id: "00000000-0000-4000-8000-000000000004",
  };
}
