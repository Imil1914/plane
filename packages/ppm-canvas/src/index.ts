import { z } from "zod";

export const PPM_CANVAS_SCHEMA_VERSION = 1 as const;
export const PPM_CANVAS_AUTOSAVE_DELAY_MS = 1_000;

export const PPM_CANVAS_NODE_KINDS = ["note", "group"] as const;
export type TPpmCanvasNodeKind = (typeof PPM_CANVAS_NODE_KINDS)[number];

export const PPM_CANVAS_COLORS = ["yellow", "cyan", "green", "violet"] as const;
export type TPpmCanvasColor = (typeof PPM_CANVAS_COLORS)[number];

const visualSchema = z
  .object({
    color: z.enum(PPM_CANVAS_COLORS),
    collapsed: z.boolean().optional(),
    width: z.number().finite().min(160).max(1600),
    height: z.number().finite().min(96).max(1200),
  })
  .passthrough();

const sharedNodeFields = {
  schema_version: z.literal(PPM_CANVAS_SCHEMA_VERSION),
  title: z.string().max(160),
  body: z.string().max(50_000),
  author_id: z.string().max(160),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  visual: visualSchema,
};

export const ppmCanvasNoteSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("note"),
  })
  .passthrough();

export const ppmCanvasGroupSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("group"),
  })
  .passthrough();

export const ppmCanvasNodeSchema = z.discriminatedUnion("kind", [ppmCanvasNoteSchema, ppmCanvasGroupSchema]);

export type TPpmCanvasNode = z.infer<typeof ppmCanvasNodeSchema>;

const ppmCanvasDocumentSchema = z.custom<object>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "Canvas document must be an object."
);

export const ppmCanvasSnapshotSchema = z.object({ document: ppmCanvasDocumentSchema }).passthrough();

export const ppmCanvasReadResponseSchema = z
  .object({
    canvas_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    project_id: z.string().uuid(),
    name: z.string(),
    schema_version: z.literal(PPM_CANVAS_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    snapshot: ppmCanvasSnapshotSchema.nullable(),
    snapshot_status: z.enum(["empty", "ready", "corrupt"]),
    content_hash: z.string().length(64).nullable(),
    saved_at: z.string().datetime({ offset: true }).nullable(),
    saved_by: z.string().uuid().nullable(),
    access: z.enum(["edit", "read"]),
  })
  .superRefine((value, context) => {
    if (value.snapshot_status === "ready" && value.snapshot === null) {
      context.addIssue({
        code: "custom",
        message: "Ready Canvas response must include a snapshot.",
        path: ["snapshot"],
      });
    }
    if (value.snapshot_status !== "ready" && value.snapshot !== null) {
      context.addIssue({
        code: "custom",
        message: "Empty or corrupt Canvas response must not include a snapshot.",
        path: ["snapshot"],
      });
    }
  });

export const ppmCanvasSaveResponseSchema = z.object({
  canvas_id: z.string().uuid(),
  version: z.number().int().positive(),
  content_hash: z.string().length(64),
  saved_at: z.string().datetime({ offset: true }),
  saved_by: z.string().uuid(),
  request_id: z.string().uuid(),
  idempotent_replay: z.boolean(),
});

export const ppmCanvasErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().uuid(),
    details: z.record(z.string(), z.unknown()),
  }),
});

export type TPpmCanvasSnapshot = z.infer<typeof ppmCanvasSnapshotSchema>;
export type TPpmCanvasReadResponse = z.infer<typeof ppmCanvasReadResponseSchema>;
export type TPpmCanvasSaveResponse = z.infer<typeof ppmCanvasSaveResponseSchema>;
export type TPpmCanvasSyncStatus = "conflict" | "corrupt" | "error" | "loading" | "saved" | "saving";

export type TPpmCanvasSaveRequest = {
  schema_version: typeof PPM_CANVAS_SCHEMA_VERSION;
  base_version: number;
  snapshot: TPpmCanvasSnapshot;
  client_operation_id: string;
};

export const PPM_CANVAS_NODE_REGISTRY = {
  note: {
    defaultColor: "yellow",
    defaultHeight: 220,
    defaultWidth: 320,
  },
  group: {
    defaultColor: "cyan",
    defaultHeight: 360,
    defaultWidth: 560,
  },
} as const satisfies Record<
  TPpmCanvasNodeKind,
  { defaultColor: TPpmCanvasColor; defaultHeight: number; defaultWidth: number }
>;

export type TPpmCanvasParseResult =
  | { status: "valid" | "migrated"; node: TPpmCanvasNode }
  | { status: "unknown"; kind: string; raw: unknown }
  | { status: "corrupt"; raw: unknown; reason: string };

export function createPpmCanvasNode({
  authorId,
  body = "",
  kind,
  now = new Date().toISOString(),
  title,
}: {
  authorId: string;
  body?: string;
  kind: TPpmCanvasNodeKind;
  now?: string;
  title: string;
}): TPpmCanvasNode {
  const definition = PPM_CANVAS_NODE_REGISTRY[kind];
  return ppmCanvasNodeSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind,
    title,
    body,
    author_id: authorId,
    created_at: now,
    updated_at: now,
    visual: {
      color: definition.defaultColor,
      width: definition.defaultWidth,
      height: definition.defaultHeight,
    },
  });
}

export function parseAndMigratePpmCanvasNode(raw: unknown): TPpmCanvasParseResult {
  if (!isPlainObject(raw)) return { status: "corrupt", raw, reason: "Node payload must be an object." };

  const rawKind = raw.kind;
  if (typeof rawKind !== "string") return { status: "corrupt", raw, reason: "Node kind is missing." };
  if (!isPpmCanvasNodeKind(rawKind)) return { status: "unknown", kind: rawKind, raw };

  const rawVersion = raw.schema_version ?? raw.schemaVersion ?? 0;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 0)
    return { status: "corrupt", raw, reason: "Node schema version is invalid." };
  if (rawVersion > PPM_CANVAS_SCHEMA_VERSION) return { status: "unknown", kind: rawKind, raw };

  const migrated = rawVersion === 0 ? migrateLegacyNode(raw, rawKind) : raw;
  const parsed = ppmCanvasNodeSchema.safeParse(migrated);

  if (!parsed.success)
    return {
      status: "corrupt",
      raw,
      reason: parsed.error.issues[0]?.message ?? "Node payload is invalid.",
    };

  return { status: rawVersion === 0 ? "migrated" : "valid", node: parsed.data };
}

export function parseSerializedPpmCanvasNode(serialized: string): TPpmCanvasParseResult {
  try {
    return parseAndMigratePpmCanvasNode(JSON.parse(serialized));
  } catch {
    return { status: "corrupt", raw: serialized, reason: "Node JSON is invalid." };
  }
}

export function serializePpmCanvasNode(node: TPpmCanvasNode): string {
  return JSON.stringify(node);
}

export function updatePpmCanvasNode(
  node: TPpmCanvasNode,
  patch: Partial<Pick<TPpmCanvasNode, "body" | "title">>,
  now = new Date().toISOString()
): TPpmCanvasNode {
  return ppmCanvasNodeSchema.parse({ ...node, ...patch, updated_at: now });
}

export function getPpmCanvasPersistenceKey(workspaceSlug: string, projectId: string, userId: string): string {
  return ["ppm", "i0.4", "canvas", workspaceSlug, projectId, userId].map(encodeURIComponent).join(":");
}

export function isPpmCanvasEnabled(value: string | undefined, shellEnabled: boolean): boolean {
  if (!shellEnabled) return false;
  if (value === undefined || value.trim() === "") return true;
  return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
}

function migrateLegacyNode(raw: Record<string, unknown>, kind: TPpmCanvasNodeKind): Record<string, unknown> {
  const definition = PPM_CANVAS_NODE_REGISTRY[kind];
  const legacyVisual = isPlainObject(raw.visual) ? raw.visual : {};
  const now = typeof raw.updated_at === "string" ? raw.updated_at : new Date(0).toISOString();
  const { color, height, schemaVersion: _schemaVersion, width, ...preserved } = raw;

  return {
    ...preserved,
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    body: typeof raw.body === "string" ? raw.body : "",
    author_id: typeof raw.author_id === "string" ? raw.author_id : "legacy",
    created_at: typeof raw.created_at === "string" ? raw.created_at : now,
    updated_at: now,
    visual: {
      ...legacyVisual,
      color: isPpmCanvasColor(color)
        ? color
        : isPpmCanvasColor(legacyVisual.color)
          ? legacyVisual.color
          : definition.defaultColor,
      width: typeof width === "number" ? width : numberOrDefault(legacyVisual.width, definition.defaultWidth),
      height: typeof height === "number" ? height : numberOrDefault(legacyVisual.height, definition.defaultHeight),
    },
  };
}

function isPpmCanvasNodeKind(value: string): value is TPpmCanvasNodeKind {
  return PPM_CANVAS_NODE_KINDS.includes(value as TPpmCanvasNodeKind);
}

function isPpmCanvasColor(value: unknown): value is TPpmCanvasColor {
  return typeof value === "string" && PPM_CANVAS_COLORS.includes(value as TPpmCanvasColor);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
