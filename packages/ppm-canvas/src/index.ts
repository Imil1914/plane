import { z } from "zod";

export const PPM_CANVAS_SCHEMA_VERSION = 2 as const;
export const PPM_CANVAS_AUTOSAVE_DELAY_MS = 1_000;

export const PPM_CANVAS_NODE_KINDS = [
  "note",
  "document",
  "checklist",
  "table",
  "code",
  "group",
  "frame",
  "board_link",
  "work_item_ref",
  "work_items_view",
  "page_ref",
  "attachment_ref",
  "vault_file_ref",
  "pdf",
  "image",
  "reference",
  "diagram",
  "deck",
  "git_ref",
  "search",
  "orchestrator",
  "orchtask",
  "orchcall",
  "agent_query",
  "agent_answer",
] as const;
export type TPpmCanvasNodeKind = (typeof PPM_CANVAS_NODE_KINDS)[number];
export const PPM_CANVAS_OWNED_NODE_KINDS = [
  "note",
  "document",
  "checklist",
  "table",
  "code",
  "group",
  "frame",
  "board_link",
  "work_items_view",
  "diagram",
  "deck",
] as const;
export type TPpmCanvasOwnedNodeKind = (typeof PPM_CANVAS_OWNED_NODE_KINDS)[number];

export const PPM_CANVAS_BOARD_STATUSES = ["active", "archived"] as const;
export type TPpmCanvasBoardStatus = (typeof PPM_CANVAS_BOARD_STATUSES)[number];

export const PPM_CANVAS_SEMANTIC_RELATION_TYPES = [
  "relates_to",
  "depends_on",
  "blocks",
  "explains",
  "implements",
  "evidence_for",
  "contradicts",
  "derived_from",
  "result_of",
] as const;
export type TPpmCanvasSemanticRelationType = (typeof PPM_CANVAS_SEMANTIC_RELATION_TYPES)[number];

export const PPM_CANVAS_COLORS = ["yellow", "cyan", "green", "violet"] as const;
export type TPpmCanvasColor = (typeof PPM_CANVAS_COLORS)[number];
export const PPM_CANVAS_GIT_PROVIDERS = ["github", "gitlab", "bitbucket", "gitea", "generic"] as const;
export const PPM_CANVAS_GIT_OBJECT_TYPES = ["repository", "branch", "commit", "pull_request"] as const;

const visualSchema = z
  .object({
    color: z.enum(PPM_CANVAS_COLORS),
    collapsed: z.boolean().optional(),
    expanded_height: z.number().finite().min(96).max(1200).optional(),
    width: z.number().finite().min(160).max(1600),
    height: z.number().finite().min(96).max(1200),
  })
  .passthrough();

const sharedNodeFields = {
  schema_version: z.literal(PPM_CANVAS_SCHEMA_VERSION),
  author_id: z.string().max(160),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  visual: visualSchema,
};

const sharedOwnedNodeFields = {
  ...sharedNodeFields,
  title: z.string().max(160),
  body: z.string().max(50_000),
};

export const ppmCanvasNoteSchema = z
  .object({
    ...sharedOwnedNodeFields,
    kind: z.literal("note"),
  })
  .passthrough();

export const ppmCanvasDocumentNodeSchema = z
  .object({
    ...sharedOwnedNodeFields,
    kind: z.literal("document"),
    format: z.literal("markdown").default("markdown"),
  })
  .passthrough();

export const ppmCanvasChecklistItemSchema = z.object({
  id: z.string().min(1).max(120),
  text: z.string().max(1_000),
  checked: z.boolean(),
});

export const ppmCanvasChecklistSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("checklist"),
    title: z.string().max(160),
    items: z.array(ppmCanvasChecklistItemSchema).max(500),
  })
  .passthrough();

export const ppmCanvasTableColumnSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().max(160),
});

export const ppmCanvasTableRowSchema = z.object({
  id: z.string().min(1).max(120),
  cells: z.record(z.string(), z.string().max(5_000)),
});

export const ppmCanvasTableSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("table"),
    title: z.string().max(160),
    columns: z.array(ppmCanvasTableColumnSchema).min(1).max(20),
    rows: z.array(ppmCanvasTableRowSchema).max(500),
  })
  .passthrough();

export const ppmCanvasCodeSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("code"),
    title: z.string().max(160),
    code: z.string().max(100_000),
    language: z.string().max(64),
    executable: z.literal(false),
  })
  .passthrough();

export const ppmCanvasGroupSchema = z
  .object({
    ...sharedOwnedNodeFields,
    kind: z.literal("group"),
  })
  .passthrough();

export const ppmCanvasFrameSchema = z
  .object({
    ...sharedOwnedNodeFields,
    kind: z.literal("frame"),
  })
  .passthrough();

export const ppmCanvasBoardLinkSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("board_link"),
    title: z.string().max(160),
    target_board_id: z.string().uuid(),
  })
  .passthrough();

export const ppmCanvasWorkItemBindingSchema = z.object({
  binding_id: z.string().uuid(),
  entity_type: z.literal("work_item"),
  entity_id: z.string().uuid(),
  source_version: z.string().max(64).nullable(),
});

export const ppmCanvasWorkItemRefSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("work_item_ref"),
    binding: ppmCanvasWorkItemBindingSchema,
  })
  .passthrough();

export const PPM_WORK_ITEMS_VIEW_LAYOUTS = ["kanban", "backlog", "list"] as const;
export const PPM_WORK_ITEMS_VIEW_GROUPS = ["state", "priority", "assignee", "none"] as const;
export const PPM_WORK_ITEMS_VIEW_SORTS = [
  "updated_desc",
  "updated_asc",
  "created_desc",
  "created_asc",
  "due_asc",
  "due_desc",
] as const;

export const ppmCanvasWorkItemsViewFiltersSchema = z.object({
  query: z.string().max(160),
  state_ids: z.array(z.string().uuid()).max(100),
  priorities: z.array(z.enum(["urgent", "high", "medium", "low", "none"])).max(5),
  assignee_ids: z.array(z.string().uuid()).max(100),
  include_archived: z.boolean(),
});

export const ppmCanvasWorkItemsViewSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("work_items_view"),
    title: z.string().max(160),
    layout: z.enum(PPM_WORK_ITEMS_VIEW_LAYOUTS),
    group_by: z.enum(PPM_WORK_ITEMS_VIEW_GROUPS),
    sort: z.enum(PPM_WORK_ITEMS_VIEW_SORTS),
    filters: ppmCanvasWorkItemsViewFiltersSchema,
  })
  .passthrough();

const ppmCanvasContentEntityTypeSchema = z.enum(["page", "attachment", "vault_file"]);

export const ppmCanvasContentNodeBindingSchema = z.object({
  binding_id: z.string().uuid(),
  entity_type: ppmCanvasContentEntityTypeSchema,
  entity_id: z.string().uuid(),
  source_version: z.string().max(64).nullable(),
});

const sharedContentReferenceFields = {
  ...sharedNodeFields,
  title: z.string().max(300),
  source_url: z.string().max(2_048),
};

export const ppmCanvasPageRefSchema = z
  .object({
    ...sharedContentReferenceFields,
    kind: z.literal("page_ref"),
    binding: ppmCanvasContentNodeBindingSchema,
  })
  .passthrough();

export const ppmCanvasAttachmentRefSchema = z
  .object({
    ...sharedContentReferenceFields,
    kind: z.literal("attachment_ref"),
    binding: ppmCanvasContentNodeBindingSchema,
  })
  .passthrough();

export const ppmCanvasVaultFileRefSchema = z
  .object({
    ...sharedContentReferenceFields,
    kind: z.literal("vault_file_ref"),
    binding: ppmCanvasContentNodeBindingSchema.optional(),
    extension: z.string().max(32),
    source_version: z.string().max(64),
  })
  .passthrough();

const ppmCanvasMediaReferenceFields = {
  ...sharedContentReferenceFields,
  binding: ppmCanvasContentNodeBindingSchema,
  extension: z.string().max(32).nullable(),
};

export const ppmCanvasPdfSchema = z
  .object({
    ...ppmCanvasMediaReferenceFields,
    kind: z.literal("pdf"),
  })
  .passthrough();

export const ppmCanvasImageSchema = z
  .object({
    ...ppmCanvasMediaReferenceFields,
    kind: z.literal("image"),
    alt: z.string().max(500).default(""),
  })
  .passthrough();

export const ppmCanvasReferenceSchema = z
  .object({
    ...ppmCanvasMediaReferenceFields,
    kind: z.literal("reference"),
  })
  .passthrough();

export const ppmCanvasDiagramSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("diagram"),
    title: z.string().max(160),
    syntax: z.literal("mermaid"),
    source: z.string().max(100_000).refine(isPpmMermaidSourceSafe, "Unsafe Mermaid directive."),
  })
  .passthrough();

const UNSAFE_MERMAID_SOURCE =
  /(?:<\/?(?:script|iframe|object|embed|foreignObject)\b|javascript\s*:|%%\s*\{\s*init|\bclick\s+\S+)/iu;

export function isPpmMermaidSourceSafe(source: string): boolean {
  return source.length <= 100_000 && !UNSAFE_MERMAID_SOURCE.test(source);
}

export const ppmCanvasDeckSlideSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().max(200),
  body: z.string().max(10_000),
});

export const ppmCanvasDeckSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("deck"),
    title: z.string().max(160),
    slides: z.array(ppmCanvasDeckSlideSchema).min(1).max(200),
    active_slide: z.number().int().nonnegative(),
  })
  .passthrough();

export const ppmCanvasGitRefSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("git_ref"),
    source_id: z.string().uuid(),
    title: z.string().max(300),
    provider: z.enum(PPM_CANVAS_GIT_PROVIDERS),
    repository_name: z.string().max(300),
    object_type: z.enum(PPM_CANVAS_GIT_OBJECT_TYPES),
    canonical_url: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => value.startsWith("https://")),
    work_item_key: z.string().max(64).nullable(),
    binding: z
      .object({
        binding_id: z.string().uuid(),
        entity_type: z.enum(PPM_CANVAS_GIT_OBJECT_TYPES),
        entity_id: z.string().uuid(),
        source_version: z.string().max(255).nullable(),
      })
      .optional(),
  })
  .passthrough();

export const ppmCanvasSearchResultSchema = z.object({
  result_id: z.string().min(1).max(255),
  source_id: z.string().max(255),
  source_type: z.enum(["work_item", "vault_file", "git_code"]),
  source_version: z.string().max(255),
  source_url: z.string().max(2_048),
  title: z.string().max(500),
  excerpt: z.string().max(10_000),
  score: z.number().finite(),
  locator: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const PPM_CANVAS_SERVICE_RUN_KINDS = ["search", "answer", "orchestrator"] as const;
export const PPM_CANVAS_SERVICE_RUN_STATUSES = [
  "queued",
  "retrieving",
  "completing",
  "running",
  "awaiting_approval",
  "applying",
  "completed",
  "degraded",
  "no_sources",
  "failed",
  "timed_out",
  "cancelled",
  "rejected",
] as const;

export const ppmCanvasServiceRunEnvelopeSchema = z
  .object({
    run_id: z.string().uuid(),
    kind: z.enum(PPM_CANVAS_SERVICE_RUN_KINDS),
    status: z.enum(PPM_CANVAS_SERVICE_RUN_STATUSES),
    provider: z.string().max(120).nullable(),
    model: z.string().max(160).nullable(),
    policy_version: z.string().max(120),
    created_at: z.string().datetime({ offset: true }),
    started_at: z.string().datetime({ offset: true }).nullable(),
    finished_at: z.string().datetime({ offset: true }).nullable(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .superRefine((run, context) => {
    const createdAt = Date.parse(run.created_at);
    const startedAt = run.started_at ? Date.parse(run.started_at) : createdAt;
    const finishedAt = run.finished_at ? Date.parse(run.finished_at) : undefined;
    const updatedAt = Date.parse(run.updated_at);
    if (startedAt < createdAt)
      context.addIssue({ code: "custom", message: "Run cannot start before it is created.", path: ["started_at"] });
    if (finishedAt !== undefined && finishedAt < startedAt)
      context.addIssue({ code: "custom", message: "Run cannot finish before it starts.", path: ["finished_at"] });
    if (updatedAt < createdAt || (finishedAt !== undefined && updatedAt < finishedAt))
      context.addIssue({
        code: "custom",
        message: "Run update time cannot precede its lifecycle.",
        path: ["updated_at"],
      });
  });

export const ppmCanvasSearchSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("search"),
    title: z.string().max(300),
    query: z.string().max(50_000),
    results: z.array(ppmCanvasSearchResultSchema).max(50),
    retrieval_mode: z.enum(["keyword", "hybrid"]),
    degraded: z.boolean(),
    reason: z.string().max(1_000).optional(),
    selected_shape_ids: z.array(z.string().max(255)).max(500),
    graph_depth: z.number().int().min(0).max(2),
    service_run: ppmCanvasServiceRunEnvelopeSchema.optional(),
  })
  .passthrough();

export const PPM_CANVAS_AGENT_KINDS = [
  "project_reporter",
  "work_decomposer",
  "knowledge_librarian",
  "relationship_analyst",
] as const;
export const PPM_CANVAS_AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "applying",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "rejected",
] as const;
export const PPM_CANVAS_AGENT_ACTION_KINDS = ["create_work_items", "apply_semantic_edges", "write_vault_file"] as const;
export const PPM_CANVAS_AGENT_ACTION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "applying",
  "applied",
  "conflict",
  "failed",
  "cancelled",
] as const;
export const PPM_CANVAS_AGENT_TOOL_MODES = ["read", "propose", "apply"] as const;
export const PPM_CANVAS_AGENT_TOOL_STATUSES = ["completed", "failed"] as const;
export const PPM_CANVAS_ORCHESTRATOR_TRACE_KINDS = ["run_created", "run_status", "action_status", "tool_call"] as const;

const ppmAgentRunStatusSchema = z.enum(["completed", "degraded", "no_sources"]);

export const ppmCanvasAgentQuerySchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("agent_query"),
    run_id: z.string().uuid().optional(),
    title: z.string().max(300),
    query: z.string().max(50_000),
    selected_shape_ids: z.array(z.string().max(255)).max(500),
    run_status: ppmAgentRunStatusSchema,
    service_run: ppmCanvasServiceRunEnvelopeSchema.optional(),
  })
  .passthrough();

export const ppmCanvasAgentCitationSchema = z.object({
  citation_id: z.string().max(255),
  title: z.string().max(500),
  source_url: z.string().max(2_048),
  source_type: z.enum(["work_item", "vault_file", "git_code"]).optional(),
  source_id: z.string().max(255).optional(),
  source_version: z.string().max(255).optional(),
  locator: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const ppmCanvasOrchestratorActionSchema = z.object({
  action_id: z.string().uuid(),
  action_kind: z.enum(PPM_CANVAS_AGENT_ACTION_KINDS),
  status: z.enum(PPM_CANVAS_AGENT_ACTION_STATUSES),
  title: z.string().max(500),
  summary: z.string().max(5_000),
  canonical_changes_applied: z.boolean(),
  result_url: z.string().max(2_048).optional(),
});

const ppmCanvasOrchestratorTraceFields = {
  trace_id: z.string().max(255),
  occurred_at: z.string().datetime({ offset: true }),
};

export const ppmCanvasOrchestratorTraceSchema = z.discriminatedUnion("kind", [
  z.object({
    ...ppmCanvasOrchestratorTraceFields,
    kind: z.literal("run_created"),
    status: z.literal("queued"),
  }),
  z.object({
    ...ppmCanvasOrchestratorTraceFields,
    kind: z.literal("run_status"),
    status: z.enum(PPM_CANVAS_AGENT_RUN_STATUSES),
  }),
  z.object({
    ...ppmCanvasOrchestratorTraceFields,
    kind: z.literal("action_status"),
    status: z.enum(PPM_CANVAS_AGENT_ACTION_STATUSES),
    action_id: z.string().uuid(),
    action_title: z.string().max(500),
  }),
  z.object({
    ...ppmCanvasOrchestratorTraceFields,
    kind: z.literal("tool_call"),
    status: z.enum(PPM_CANVAS_AGENT_TOOL_STATUSES),
    tool_name: z.string().max(64),
    tool_mode: z.enum(PPM_CANVAS_AGENT_TOOL_MODES),
    title: z.string().max(500),
    summary: z.string().max(1_000),
    result_count: z.number().int().min(0).max(100_000).optional(),
    action_id: z.string().uuid().optional(),
  }),
]);

export const ppmCanvasOrchestratorSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("orchestrator"),
    run_id: z.string().uuid(),
    title: z.string().max(300),
    agent_kind: z.enum(PPM_CANVAS_AGENT_KINDS),
    run_status: z.enum(PPM_CANVAS_AGENT_RUN_STATUSES),
    summary: z.string().max(20_000),
    actions: z.array(ppmCanvasOrchestratorActionSchema).max(100),
    citations: z.array(ppmCanvasAgentCitationSchema).max(200),
    selected_shape_ids: z.array(z.string().max(255)).max(500),
    provider: z.string().max(120),
    model: z.string().max(160),
    policy_version: z.string().max(120),
    run_created_at: z.string().datetime({ offset: true }),
    run_finished_at: z.string().datetime({ offset: true }).nullable(),
    run_updated_at: z.string().datetime({ offset: true }).optional(),
    service_run: ppmCanvasServiceRunEnvelopeSchema.optional(),
    trace: z.array(ppmCanvasOrchestratorTraceSchema).max(100).default([]),
    action_summary: z
      .object({
        applied: z.number().int().min(0),
        applying: z.number().int().min(0),
        approved: z.number().int().min(0),
        cancelled: z.number().int().min(0),
        canonical_changes_applied: z.boolean(),
        conflict: z.number().int().min(0),
        failed: z.number().int().min(0),
        partial: z.boolean(),
        rejected: z.number().int().min(0),
        remaining: z.number().int().min(0),
        review_complete: z.boolean(),
        reviewed: z.number().int().min(0),
        total: z.number().int().min(0),
      })
      .passthrough(),
  })
  .passthrough();

export const ppmCanvasOrchestratorTaskSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("orchtask"),
    run_id: z.string().uuid(),
    action_id: z.string().uuid(),
    action_kind: z.enum(PPM_CANVAS_AGENT_ACTION_KINDS),
    status: z.enum(PPM_CANVAS_AGENT_ACTION_STATUSES),
    title: z.string().max(500),
    summary: z.string().max(5_000),
    canonical_changes_applied: z.boolean(),
    result_url: z.string().max(2_048).optional(),
  })
  .passthrough();

export const ppmCanvasOrchestratorCallSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("orchcall"),
    run_id: z.string().uuid(),
    action_id: z.string().uuid().optional(),
    trace_id: z.string().max(255),
    trace_kind: z.enum(["action_status", "tool_call"]).default("action_status"),
    status: z.union([z.enum(PPM_CANVAS_AGENT_ACTION_STATUSES), z.enum(PPM_CANVAS_AGENT_TOOL_STATUSES)]),
    title: z.string().max(500),
    summary: z.string().max(1_000).optional(),
    tool_name: z.string().max(64).optional(),
    tool_mode: z.enum(PPM_CANVAS_AGENT_TOOL_MODES).optional(),
    result_count: z.number().int().min(0).max(100_000).optional(),
    occurred_at: z.string().datetime({ offset: true }),
  })
  .passthrough();

export const ppmCanvasAgentAnswerSchema = z
  .object({
    ...sharedNodeFields,
    kind: z.literal("agent_answer"),
    run_id: z.string().uuid().optional(),
    title: z.string().max(300),
    body: z.string().max(100_000),
    citations: z.array(ppmCanvasAgentCitationSchema).max(200),
    run_status: ppmAgentRunStatusSchema,
    service_run: ppmCanvasServiceRunEnvelopeSchema.optional(),
  })
  .passthrough();

export const ppmCanvasNodeSchema = z.discriminatedUnion("kind", [
  ppmCanvasNoteSchema,
  ppmCanvasDocumentNodeSchema,
  ppmCanvasChecklistSchema,
  ppmCanvasTableSchema,
  ppmCanvasCodeSchema,
  ppmCanvasGroupSchema,
  ppmCanvasFrameSchema,
  ppmCanvasBoardLinkSchema,
  ppmCanvasWorkItemRefSchema,
  ppmCanvasWorkItemsViewSchema,
  ppmCanvasPageRefSchema,
  ppmCanvasAttachmentRefSchema,
  ppmCanvasVaultFileRefSchema,
  ppmCanvasPdfSchema,
  ppmCanvasImageSchema,
  ppmCanvasReferenceSchema,
  ppmCanvasDiagramSchema,
  ppmCanvasDeckSchema,
  ppmCanvasGitRefSchema,
  ppmCanvasSearchSchema,
  ppmCanvasOrchestratorSchema,
  ppmCanvasOrchestratorTaskSchema,
  ppmCanvasOrchestratorCallSchema,
  ppmCanvasAgentQuerySchema,
  ppmCanvasAgentAnswerSchema,
]);

export type TPpmCanvasNode = z.infer<typeof ppmCanvasNodeSchema>;
export type TPpmCanvasOwnedNode = Extract<TPpmCanvasNode, { kind: TPpmCanvasOwnedNodeKind }>;
export type TPpmCanvasWorkItemRefNode = z.infer<typeof ppmCanvasWorkItemRefSchema>;
export type TPpmCanvasWorkItemsViewNode = z.infer<typeof ppmCanvasWorkItemsViewSchema>;
export type TPpmCanvasVaultFileRefNode = z.infer<typeof ppmCanvasVaultFileRefSchema>;
export type TPpmCanvasMediaNode = z.infer<
  typeof ppmCanvasPdfSchema | typeof ppmCanvasImageSchema | typeof ppmCanvasReferenceSchema
>;
export type TPpmCanvasGitRefNode = z.infer<typeof ppmCanvasGitRefSchema>;
export type TPpmCanvasSearchNode = z.infer<typeof ppmCanvasSearchSchema>;
export type TPpmCanvasSearchResult = z.infer<typeof ppmCanvasSearchResultSchema>;
export type TPpmCanvasServiceRunEnvelope = z.infer<typeof ppmCanvasServiceRunEnvelopeSchema>;
export type TPpmCanvasOrchestratorNode = z.infer<typeof ppmCanvasOrchestratorSchema>;
export type TPpmCanvasOrchestratorAction = z.infer<typeof ppmCanvasOrchestratorActionSchema>;
export type TPpmCanvasOrchestratorTrace = z.infer<typeof ppmCanvasOrchestratorTraceSchema>;
export type TPpmCanvasOrchestratorTaskNode = z.infer<typeof ppmCanvasOrchestratorTaskSchema>;
export type TPpmCanvasOrchestratorCallNode = z.infer<typeof ppmCanvasOrchestratorCallSchema>;
export type TPpmCanvasAgentQueryNode = z.infer<typeof ppmCanvasAgentQuerySchema>;
export type TPpmCanvasAgentAnswerNode = z.infer<typeof ppmCanvasAgentAnswerSchema>;
export type TPpmCanvasAgentCitation = z.infer<typeof ppmCanvasAgentCitationSchema>;

const ppmCanvasDocumentSchema = z.custom<object>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "Canvas document must be an object."
);

export const ppmCanvasSnapshotSchema = z.object({ document: ppmCanvasDocumentSchema }).passthrough();

export const ppmWorkItemStateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  group: z.string(),
  color: z.string(),
});

export const ppmWorkItemAssigneeSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
});

export const ppmWorkItemProjectionSchema = z.object({
  identity: z.object({
    entity_type: z.literal("work_item"),
    entity_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    project_id: z.string().uuid(),
    identifier: z.string().nullable(),
    source_url: z.string().nullable(),
  }),
  display: z.object({
    title: z.string(),
    state: ppmWorkItemStateSchema.nullable(),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]),
    assignees: z.array(ppmWorkItemAssigneeSchema),
    due_date: z.string().date().nullable(),
    source_status: z.enum(["active", "archived", "deleted"]),
  }),
  capabilities: z.object({
    read: z.boolean(),
    update: z.boolean(),
    delete_source: z.literal(false),
    editable_fields: z.array(z.enum(["state_id", "priority", "assignee_ids", "due_date"])),
  }),
  source_version: z.string().max(64).nullable(),
});

export const ppmCanvasWorkItemBindingProjectionSchema = z.object({
  binding_id: z.string().uuid(),
  board_id: z.string().uuid().optional(),
  binding_status: z.enum(["pending", "active"]),
  shape_id: z.string(),
  entity_type: z.literal("work_item"),
  entity_id: z.string().uuid(),
  source_version: z.string().max(64).nullable(),
  source: ppmWorkItemProjectionSchema,
});

export const ppmCanvasContentProjectionSchema = z.object({
  identity: z.object({
    entity_type: ppmCanvasContentEntityTypeSchema,
    entity_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    project_id: z.string().uuid(),
    source_url: z.string().max(2_048).nullable(),
  }),
  display: z.object({
    title: z.string(),
    excerpt: z.string().nullable(),
    extension: z.string().max(32).nullable(),
    mime_type: z.string().max(127),
    size_bytes: z.number().int().nonnegative(),
    preview_url: z.string().max(2_048).nullable(),
    source_status: z.enum(["active", "archived", "deleted", "quarantined"]),
  }),
  capabilities: z.object({
    read: z.boolean(),
    update: z.boolean(),
    delete_source: z.boolean(),
  }),
  source_version: z.string().max(64).nullable(),
});

export const ppmCanvasContentBindingSchema = z.object({
  binding_id: z.string().uuid(),
  board_id: z.string().uuid().optional(),
  binding_status: z.enum(["pending", "active"]),
  shape_id: z.string(),
  entity_type: ppmCanvasContentEntityTypeSchema,
  entity_id: z.string().uuid(),
  source_version: z.string().max(64).nullable(),
  source: ppmCanvasContentProjectionSchema,
});

export const ppmCanvasGitProjectionSchema = z.object({
  identity: z.object({
    entity_type: z.enum(PPM_CANVAS_GIT_OBJECT_TYPES),
    entity_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    project_id: z.string().uuid(),
    source_url: z.string().url().max(2_048).nullable(),
  }),
  display: z.object({
    title: z.string(),
    provider: z.enum(PPM_CANVAS_GIT_PROVIDERS),
    repository_name: z.string(),
    object_type: z.enum(PPM_CANVAS_GIT_OBJECT_TYPES),
    ref: z.string(),
    state: z.string(),
    author_name: z.string(),
    base_ref: z.string(),
    head_ref: z.string(),
    commit_sha: z.string(),
    work_items: z.array(
      z.object({
        id: z.string().uuid(),
        identifier: z.string(),
        title: z.string(),
      })
    ),
    source_status: z.enum(["active", "archived", "deleted"]),
  }),
  capabilities: z.object({
    read: z.boolean(),
    update: z.literal(false),
    delete_source: z.literal(false),
  }),
  source_version: z.string().max(255).nullable(),
});

export const ppmCanvasGitBindingSchema = z.object({
  binding_id: z.string().uuid(),
  board_id: z.string().uuid().optional(),
  binding_status: z.enum(["pending", "active"]),
  shape_id: z.string(),
  entity_type: z.enum(PPM_CANVAS_GIT_OBJECT_TYPES),
  entity_id: z.string().uuid(),
  source_version: z.string().max(255).nullable(),
  source: ppmCanvasGitProjectionSchema,
});

export const ppmCanvasBindingSchema = z.discriminatedUnion("entity_type", [
  ppmCanvasWorkItemBindingProjectionSchema,
  ppmCanvasContentBindingSchema,
  ppmCanvasGitBindingSchema,
]);

export const ppmWorkItemEditOptionsSchema = z.object({
  states: z.array(ppmWorkItemStateSchema),
  priorities: z.array(z.enum(["urgent", "high", "medium", "low", "none"])),
  assignees: z.array(ppmWorkItemAssigneeSchema),
});

export const ppmCanvasBindingsResponseSchema = z.object({
  board_id: z.string().uuid().optional(),
  bindings: z.array(ppmCanvasBindingSchema),
  work_item_options: ppmWorkItemEditOptionsSchema,
});

export const ppmCanvasCapabilitiesSchema = z.object({
  read: z.boolean(),
  edit: z.boolean(),
  create_board: z.boolean(),
  rename_board: z.boolean(),
  reorder_boards: z.boolean(),
  duplicate_board: z.boolean(),
  archive_board: z.boolean(),
  restore_board: z.boolean(),
  manage_canvas: z.boolean(),
});

export const ppmCanvasBoardSchema = z.object({
  board_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  position: z.number().int().nonnegative(),
  status: z.enum(PPM_CANVAS_BOARD_STATUSES),
  version: z.number().int().nonnegative(),
  created_by: z.string().uuid(),
  updated_by: z.string().uuid(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  archived_at: z.string().datetime({ offset: true }).nullable(),
});

export const ppmCanvasBoardsResponseSchema = z.object({
  canvas_id: z.string().uuid(),
  default_board_id: z.string().uuid(),
  boards: z.array(ppmCanvasBoardSchema),
  access: z.enum(["edit", "read"]),
  capabilities: ppmCanvasCapabilitiesSchema,
});

export const ppmCanvasBoardMutationResponseSchema = ppmCanvasBoardSchema.extend({
  idempotent_replay: z.boolean(),
});

export const ppmCanvasBoardsReorderResponseSchema = z.object({
  boards: z.array(ppmCanvasBoardSchema),
  idempotent_replay: z.boolean(),
});

export const ppmCanvasSemanticEdgeSchema = z.object({
  edge_id: z.string().uuid(),
  board_id: z.string().uuid(),
  from_shape_id: z.string().startsWith("shape:").max(255),
  to_shape_id: z.string().startsWith("shape:").max(255),
  relation_type: z.enum(PPM_CANVAS_SEMANTIC_RELATION_TYPES),
  label: z.string().max(255).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  origin: z.enum(["user", "agent", "import"]),
  confirmation_status: z.enum(["proposed", "confirmed", "rejected"]),
  confirmed_by: z.string().uuid().nullable(),
  confirmed_at: z.string().datetime({ offset: true }).nullable(),
  created_by: z.string().uuid(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

export const ppmCanvasSemanticEdgesResponseSchema = z.object({
  semantic_edges: z.array(ppmCanvasSemanticEdgeSchema),
});

export const ppmCanvasSemanticEdgeMutationResponseSchema = ppmCanvasSemanticEdgeSchema.extend({
  idempotent_replay: z.boolean().optional(),
});

export const ppmProjectionSearchResponseSchema = z.object({
  results: z.array(ppmWorkItemProjectionSchema),
  next_cursor: z.string().nullable(),
});

export const ppmWorkItemsViewStateSummarySchema = z.object({
  state_id: z.string().uuid().nullable(),
  name: z.string(),
  group: z.string(),
  color: z.string(),
  count: z.number().int().nonnegative(),
});

export const ppmWorkItemsViewResponseSchema = z.object({
  results: z.array(ppmWorkItemProjectionSchema),
  next_cursor: z.string().nullable(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    progress_percent: z.number().int().min(0).max(100),
    by_state: z.array(ppmWorkItemsViewStateSummarySchema),
  }),
  work_item_options: ppmWorkItemEditOptionsSchema,
});

export const ppmWorkItemViewCreateResponseSchema = ppmWorkItemProjectionSchema.extend({
  idempotent_replay: z.boolean(),
});

export const ppmCanvasBindingMutationResponseSchema = z.discriminatedUnion("entity_type", [
  ppmCanvasWorkItemBindingProjectionSchema.extend({ idempotent_replay: z.boolean() }),
  ppmCanvasContentBindingSchema.extend({ idempotent_replay: z.boolean() }),
  ppmCanvasGitBindingSchema.extend({ idempotent_replay: z.boolean() }),
]);

export const ppmCanvasReadResponseSchema = z
  .object({
    canvas_id: z.string().uuid(),
    board_id: z.string().uuid().optional(),
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
    capabilities: ppmCanvasCapabilitiesSchema.optional(),
    bindings: z.array(ppmCanvasBindingSchema).default([]),
    work_item_options: ppmWorkItemEditOptionsSchema.default({ states: [], priorities: [], assignees: [] }),
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

export const ppmCanvasBoardVersionResponseSchema = z.object({
  board_id: z.string().uuid(),
  version: z.number().int().positive(),
  schema_version: z.literal(PPM_CANVAS_SCHEMA_VERSION),
  snapshot: ppmCanvasSnapshotSchema,
  content_hash: z.string().length(64),
  saved_by: z.string().uuid(),
  saved_at: z.string().datetime({ offset: true }),
});

export const ppmCanvasSaveResponseSchema = z.object({
  canvas_id: z.string().uuid(),
  board_id: z.string().uuid().optional(),
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
export type TPpmCanvasBoardVersionResponse = z.infer<typeof ppmCanvasBoardVersionResponseSchema>;
export type TPpmCanvasSaveResponse = z.infer<typeof ppmCanvasSaveResponseSchema>;
export type TPpmCanvasBoard = z.infer<typeof ppmCanvasBoardSchema>;
export type TPpmCanvasBoardsResponse = z.infer<typeof ppmCanvasBoardsResponseSchema>;
export type TPpmCanvasBoardMutationResponse = z.infer<typeof ppmCanvasBoardMutationResponseSchema>;
export type TPpmCanvasBoardsReorderResponse = z.infer<typeof ppmCanvasBoardsReorderResponseSchema>;
export type TPpmCanvasSemanticEdge = z.infer<typeof ppmCanvasSemanticEdgeSchema>;
export type TPpmCanvasSemanticEdgesResponse = z.infer<typeof ppmCanvasSemanticEdgesResponseSchema>;
export type TPpmCanvasCapabilities = z.infer<typeof ppmCanvasCapabilitiesSchema>;
export type TPpmCanvasBinding = z.infer<typeof ppmCanvasBindingSchema>;
export type TPpmCanvasWorkItemBinding = z.infer<typeof ppmCanvasWorkItemBindingProjectionSchema>;
export type TPpmCanvasContentBinding = z.infer<typeof ppmCanvasContentBindingSchema>;
export type TPpmCanvasGitBinding = z.infer<typeof ppmCanvasGitBindingSchema>;
export type TPpmCanvasBindingMutationResponse = z.infer<typeof ppmCanvasBindingMutationResponseSchema>;
export type TPpmCanvasBindingsResponse = z.infer<typeof ppmCanvasBindingsResponseSchema>;
export type TPpmProjectionSearchResponse = z.infer<typeof ppmProjectionSearchResponseSchema>;
export type TPpmWorkItemEditOptions = z.infer<typeof ppmWorkItemEditOptionsSchema>;
export type TPpmWorkItemProjection = z.infer<typeof ppmWorkItemProjectionSchema>;
export type TPpmWorkItemsViewResponse = z.infer<typeof ppmWorkItemsViewResponseSchema>;
export type TPpmWorkItemsViewFilters = z.infer<typeof ppmCanvasWorkItemsViewFiltersSchema>;
export type TPpmWorkItemsViewLayout = (typeof PPM_WORK_ITEMS_VIEW_LAYOUTS)[number];
export type TPpmWorkItemsViewGroup = (typeof PPM_WORK_ITEMS_VIEW_GROUPS)[number];
export type TPpmWorkItemsViewSort = (typeof PPM_WORK_ITEMS_VIEW_SORTS)[number];
export type TPpmCanvasSyncStatus = "conflict" | "corrupt" | "error" | "loading" | "saved" | "saving";

export type TPpmCanvasSaveRequest = {
  schema_version: typeof PPM_CANVAS_SCHEMA_VERSION;
  base_version: number;
  snapshot: TPpmCanvasSnapshot;
  client_operation_id: string;
  binding_changes: {
    activate: string[];
    remove: string[];
  };
};

export type TPpmCanvasBindingCreateRequest = {
  shape_id: string;
  entity_type: "work_item" | "page" | "attachment" | "vault_file" | "repository" | "branch" | "commit" | "pull_request";
  entity_id: string;
  client_operation_id: string;
};

export type TPpmCanvasSemanticEdgeCreateRequest = {
  from_shape_id: string;
  to_shape_id: string;
  relation_type: TPpmCanvasSemanticRelationType;
  label?: string | null;
  confidence?: number | null;
  origin?: "user" | "agent" | "import";
  client_operation_id: string;
};

export type TPpmCanvasSemanticEdgePatchRequest = Partial<
  Pick<TPpmCanvasSemanticEdgeCreateRequest, "confidence" | "label" | "relation_type">
> & {
  confirmation_status?: "confirmed" | "rejected";
};

export type TPpmWorkItemCreateRequest = {
  name: string;
  shape_id: string;
  client_operation_id: string;
  state_id?: string;
  priority?: TPpmWorkItemProjection["display"]["priority"];
  assignee_ids?: string[];
  due_date?: string | null;
};

export type TPpmWorkItemPatchRequest = {
  source_version: string;
  state_id?: string;
  priority?: TPpmWorkItemProjection["display"]["priority"];
  assignee_ids?: string[];
  due_date?: string | null;
};

export type TPpmWorkItemsViewQuery = TPpmWorkItemsViewFilters & {
  cursor?: string;
  limit?: number;
  sort: TPpmWorkItemsViewSort;
};

export type TPpmWorkItemViewCreateRequest = Omit<TPpmWorkItemCreateRequest, "shape_id">;

export const PPM_CANVAS_NODE_REGISTRY = {
  note: {
    defaultColor: "yellow",
    defaultHeight: 220,
    defaultWidth: 320,
  },
  document: {
    defaultColor: "cyan",
    defaultHeight: 360,
    defaultWidth: 420,
  },
  checklist: {
    defaultColor: "green",
    defaultHeight: 300,
    defaultWidth: 360,
  },
  table: {
    defaultColor: "cyan",
    defaultHeight: 320,
    defaultWidth: 520,
  },
  code: {
    defaultColor: "violet",
    defaultHeight: 340,
    defaultWidth: 460,
  },
  group: {
    defaultColor: "cyan",
    defaultHeight: 360,
    defaultWidth: 560,
  },
  frame: {
    defaultColor: "cyan",
    defaultHeight: 420,
    defaultWidth: 640,
  },
  board_link: {
    defaultColor: "violet",
    defaultHeight: 160,
    defaultWidth: 320,
  },
  work_item_ref: {
    defaultColor: "green",
    defaultHeight: 248,
    defaultWidth: 360,
  },
  work_items_view: {
    defaultColor: "cyan",
    defaultHeight: 680,
    defaultWidth: 1100,
  },
  pdf: {
    defaultColor: "cyan",
    defaultHeight: 480,
    defaultWidth: 380,
  },
  image: {
    defaultColor: "cyan",
    defaultHeight: 360,
    defaultWidth: 420,
  },
  reference: {
    defaultColor: "violet",
    defaultHeight: 240,
    defaultWidth: 380,
  },
  diagram: {
    defaultColor: "cyan",
    defaultHeight: 420,
    defaultWidth: 620,
  },
  deck: {
    defaultColor: "violet",
    defaultHeight: 420,
    defaultWidth: 640,
  },
  page_ref: {
    defaultColor: "cyan",
    defaultHeight: 240,
    defaultWidth: 360,
  },
  attachment_ref: {
    defaultColor: "violet",
    defaultHeight: 240,
    defaultWidth: 360,
  },
  vault_file_ref: {
    defaultColor: "cyan",
    defaultHeight: 240,
    defaultWidth: 360,
  },
  git_ref: {
    defaultColor: "violet",
    defaultHeight: 220,
    defaultWidth: 360,
  },
  search: {
    defaultColor: "cyan",
    defaultHeight: 360,
    defaultWidth: 420,
  },
  orchestrator: {
    defaultColor: "violet",
    defaultHeight: 380,
    defaultWidth: 440,
  },
  orchtask: {
    defaultColor: "violet",
    defaultHeight: 180,
    defaultWidth: 300,
  },
  orchcall: {
    defaultColor: "cyan",
    defaultHeight: 140,
    defaultWidth: 260,
  },
  agent_query: {
    defaultColor: "violet",
    defaultHeight: 220,
    defaultWidth: 380,
  },
  agent_answer: {
    defaultColor: "green",
    defaultHeight: 320,
    defaultWidth: 420,
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
  targetBoardId,
  title,
}: {
  authorId: string;
  body?: string;
  kind: TPpmCanvasOwnedNodeKind;
  now?: string;
  targetBoardId?: string;
  title: string;
}): TPpmCanvasOwnedNode {
  const definition = PPM_CANVAS_NODE_REGISTRY[kind];
  const common = {
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind,
    title,
    author_id: authorId,
    created_at: now,
    updated_at: now,
    visual: {
      color: definition.defaultColor,
      width: definition.defaultWidth,
      height: definition.defaultHeight,
    },
  };
  const payload: Record<string, unknown> = { ...common };
  if (kind === "note" || kind === "document" || kind === "group" || kind === "frame") payload.body = body;
  if (kind === "document") payload.format = "markdown";
  if (kind === "checklist") payload.items = [];
  if (kind === "table") {
    const firstColumnId = createPortableId();
    payload.columns = [{ id: firstColumnId, label: "Столбец" }];
    payload.rows = [];
  }
  if (kind === "code") {
    payload.code = body;
    payload.language = "text";
    payload.executable = false;
  }
  if (kind === "board_link") {
    if (!targetBoardId) throw new Error("A board link requires a target board ID.");
    payload.target_board_id = targetBoardId;
  }
  if (kind === "work_items_view") {
    payload.layout = "kanban";
    payload.group_by = "state";
    payload.sort = "updated_desc";
    payload.filters = {
      query: "",
      state_ids: [],
      priorities: [],
      assignee_ids: [],
      include_archived: false,
    };
  }
  if (kind === "diagram") {
    payload.syntax = "mermaid";
    payload.source = body || "flowchart LR\n  A[Идея] --> B[Результат]";
  }
  if (kind === "deck") {
    payload.slides = [{ id: createPortableId(), title, body: body || "" }];
    payload.active_slide = 0;
  }
  return ppmCanvasNodeSchema.parse(payload) as TPpmCanvasOwnedNode;
}

export function createPpmWorkItemRefNode({
  authorId,
  binding,
  now = new Date().toISOString(),
}: {
  authorId: string;
  binding: z.input<typeof ppmCanvasWorkItemBindingSchema>;
  now?: string;
}): TPpmCanvasWorkItemRefNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.work_item_ref;
  return ppmCanvasWorkItemRefSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "work_item_ref",
    binding,
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

export function createPpmVaultFileRefNode({
  authorId,
  entryId,
  extension,
  now = new Date().toISOString(),
  sourceUrl,
  sourceVersion,
  title,
}: {
  authorId: string;
  entryId: string;
  extension: string;
  now?: string;
  sourceUrl: string;
  sourceVersion: string;
  title: string;
}): TPpmCanvasVaultFileRefNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.vault_file_ref;
  return ppmCanvasVaultFileRefSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "vault_file_ref",
    title,
    extension: extension.startsWith(".") ? extension : `.${extension}`,
    source_url: sourceUrl,
    source_version: sourceVersion,
    entry_id: entryId,
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

export function createPpmContentRefNode({
  authorId,
  binding,
  extension,
  kind,
  now = new Date().toISOString(),
  sourceUrl,
  title,
}: {
  authorId: string;
  binding: z.input<typeof ppmCanvasContentNodeBindingSchema>;
  extension: string | null;
  kind: "pdf" | "image" | "reference";
  now?: string;
  sourceUrl: string;
  title: string;
}): TPpmCanvasMediaNode {
  const definition = PPM_CANVAS_NODE_REGISTRY[kind];
  return ppmCanvasNodeSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind,
    title,
    source_url: sourceUrl,
    extension,
    ...(kind === "image" ? { alt: title } : {}),
    binding,
    author_id: authorId,
    created_at: now,
    updated_at: now,
    visual: {
      color: definition.defaultColor,
      width: definition.defaultWidth,
      height: definition.defaultHeight,
    },
  }) as TPpmCanvasMediaNode;
}

export function createPpmGitRefNode({
  authorId,
  binding,
  canonicalUrl,
  now = new Date().toISOString(),
  objectType,
  provider,
  repositoryName,
  sourceId,
  title,
  workItemKey = null,
}: {
  authorId: string;
  binding?: z.infer<typeof ppmCanvasGitRefSchema>["binding"];
  canonicalUrl: string;
  now?: string;
  objectType: TPpmCanvasGitRefNode["object_type"];
  provider: TPpmCanvasGitRefNode["provider"];
  repositoryName: string;
  sourceId: string;
  title: string;
  workItemKey?: string | null;
}): TPpmCanvasGitRefNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.git_ref;
  return ppmCanvasGitRefSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "git_ref",
    source_id: sourceId,
    title,
    provider,
    repository_name: repositoryName,
    object_type: objectType,
    canonical_url: canonicalUrl,
    work_item_key: workItemKey,
    binding,
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

export function createPpmSearchNode({
  authorId,
  degraded,
  graphDepth,
  now = new Date().toISOString(),
  query,
  reason,
  results,
  retrievalMode,
  selectedShapeIds,
  serviceRun,
  title,
}: {
  authorId: string;
  degraded: boolean;
  graphDepth: number;
  now?: string;
  query: string;
  reason?: string;
  results: TPpmCanvasSearchResult[];
  retrievalMode: TPpmCanvasSearchNode["retrieval_mode"];
  selectedShapeIds: string[];
  serviceRun: TPpmCanvasServiceRunEnvelope;
  title: string;
}): TPpmCanvasSearchNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.search;
  if (serviceRun.kind !== "search") throw new Error("Search snapshot requires a search service run.");
  const expectedStatus = results.length === 0 ? "no_sources" : degraded ? "degraded" : "completed";
  if (serviceRun.status !== expectedStatus) throw new Error("Search snapshot status must match its result state.");
  return ppmCanvasSearchSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "search",
    title,
    query,
    results,
    retrieval_mode: retrievalMode,
    degraded,
    reason,
    selected_shape_ids: selectedShapeIds,
    graph_depth: graphDepth,
    service_run: serviceRun,
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

export function createPpmOrchestratorTrace({
  actions,
  runCreatedAt,
  runFinishedAt,
  runId,
  runStatus,
  runUpdatedAt,
}: {
  actions: TPpmCanvasOrchestratorAction[];
  runCreatedAt: string;
  runFinishedAt: string | null;
  runId: string;
  runStatus: TPpmCanvasOrchestratorNode["run_status"];
  runUpdatedAt: string;
}): TPpmCanvasOrchestratorTrace[] {
  const trace: TPpmCanvasOrchestratorTrace[] = [
    {
      trace_id: `run:${runId}:created`,
      kind: "run_created",
      status: "queued",
      occurred_at: runCreatedAt,
    },
  ];

  if (runStatus !== "queued") {
    trace.push({
      trace_id: `run:${runId}:status:${runStatus}`,
      kind: "run_status",
      status: runStatus,
      occurred_at: runFinishedAt ?? runUpdatedAt,
    });
  }

  for (const action of actions) {
    trace.push({
      trace_id: `action:${action.action_id}:status:${action.status}`,
      kind: "action_status",
      status: action.status,
      occurred_at: runUpdatedAt,
      action_id: action.action_id,
      action_title: action.title,
    });
  }

  return trace;
}

export function mergePpmOrchestratorTrace(
  ...traceGroups: ReadonlyArray<ReadonlyArray<TPpmCanvasOrchestratorTrace>>
): TPpmCanvasOrchestratorTrace[] {
  const traceById = new Map<string, TPpmCanvasOrchestratorTrace>();
  for (const trace of traceGroups) {
    for (const item of trace) traceById.set(item.trace_id, item);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- this is a fresh array and older supported browsers lack toSorted.
  const sortedTrace = [...traceById.values()].sort((left, right) => {
    const timestampDelta = Date.parse(left.occurred_at) - Date.parse(right.occurred_at);
    return timestampDelta === 0 ? left.trace_id.localeCompare(right.trace_id) : timestampDelta;
  });
  const createdTrace = sortedTrace.find((item) => item.kind === "run_created");
  return sortedTrace.length <= 100
    ? sortedTrace
    : [
        ...(createdTrace ? [createdTrace] : []),
        ...sortedTrace.filter((item) => item.trace_id !== createdTrace?.trace_id).slice(createdTrace ? -99 : -100),
      ];
}

export function mergePpmOrchestratorNode(
  current: TPpmCanvasOrchestratorNode,
  incoming: TPpmCanvasOrchestratorNode,
  now = new Date().toISOString()
): TPpmCanvasOrchestratorNode {
  if (current.run_id !== incoming.run_id) throw new Error("Orchestrator snapshots must belong to the same run.");

  if (
    current.run_updated_at &&
    incoming.run_updated_at &&
    Date.parse(incoming.run_updated_at) < Date.parse(current.run_updated_at)
  ) {
    return current;
  }

  const merged = ppmCanvasOrchestratorSchema.parse({
    ...current,
    ...incoming,
    author_id: current.author_id,
    created_at: current.created_at,
    updated_at: now,
    visual: current.visual,
    trace: mergePpmOrchestratorTrace(current.trace, incoming.trace),
  });
  if (JSON.stringify({ ...merged, updated_at: current.updated_at }) === JSON.stringify(current)) return current;
  return merged;
}

export function createPpmOrchestratorNode({
  actionSummary,
  actions,
  agentKind,
  authorId,
  citations,
  model,
  now = new Date().toISOString(),
  policyVersion,
  provider,
  runCreatedAt,
  runFinishedAt,
  runId,
  runStartedAt = null,
  runStatus,
  runUpdatedAt = runFinishedAt ?? runCreatedAt,
  selectedShapeIds,
  summary,
  title,
  trace = [],
}: {
  actionSummary: TPpmCanvasOrchestratorNode["action_summary"];
  actions: TPpmCanvasOrchestratorAction[];
  agentKind: TPpmCanvasOrchestratorNode["agent_kind"];
  authorId: string;
  citations: TPpmCanvasAgentCitation[];
  model: string;
  now?: string;
  policyVersion: string;
  provider: string;
  runCreatedAt: string;
  runFinishedAt: string | null;
  runId: string;
  runStartedAt?: string | null;
  runStatus: TPpmCanvasOrchestratorNode["run_status"];
  runUpdatedAt?: string;
  selectedShapeIds: string[];
  summary: string;
  title: string;
  trace?: TPpmCanvasOrchestratorTrace[];
}): TPpmCanvasOrchestratorNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.orchestrator;
  return ppmCanvasOrchestratorSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "orchestrator",
    run_id: runId,
    title,
    agent_kind: agentKind,
    run_status: runStatus,
    summary,
    actions,
    citations,
    selected_shape_ids: selectedShapeIds,
    provider,
    model,
    policy_version: policyVersion,
    run_created_at: runCreatedAt,
    run_finished_at: runFinishedAt,
    run_updated_at: runUpdatedAt,
    service_run: {
      run_id: runId,
      kind: "orchestrator",
      status: runStatus,
      provider: provider || null,
      model: model || null,
      policy_version: policyVersion,
      created_at: runCreatedAt,
      started_at: runStartedAt,
      finished_at: runFinishedAt,
      updated_at: runUpdatedAt,
    },
    trace: mergePpmOrchestratorTrace(
      createPpmOrchestratorTrace({
        actions,
        runCreatedAt,
        runFinishedAt,
        runId,
        runStatus,
        runUpdatedAt,
      }),
      trace
    ),
    action_summary: actionSummary,
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

export function createPpmOrchestratorTaskNode({
  action,
  authorId,
  now = new Date().toISOString(),
  runId,
}: {
  action: TPpmCanvasOrchestratorAction;
  authorId: string;
  now?: string;
  runId: string;
}): TPpmCanvasOrchestratorTaskNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.orchtask;
  return ppmCanvasOrchestratorTaskSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "orchtask",
    run_id: runId,
    action_id: action.action_id,
    action_kind: action.action_kind,
    status: action.status,
    title: action.title,
    summary: action.summary,
    canonical_changes_applied: action.canonical_changes_applied,
    result_url: action.result_url,
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

export function createPpmOrchestratorCallNode({
  action,
  authorId,
  now = new Date().toISOString(),
  runId,
  trace,
}: {
  action?: TPpmCanvasOrchestratorAction;
  authorId: string;
  now?: string;
  runId: string;
  trace: Extract<TPpmCanvasOrchestratorTrace, { kind: "action_status" | "tool_call" }>;
}): TPpmCanvasOrchestratorCallNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.orchcall;
  if (trace.kind === "action_status" && !action) {
    throw new Error("Action status projection requires an orchestrator action.");
  }
  const title = trace.kind === "tool_call" ? trace.title : (action?.title ?? trace.action_title);
  return ppmCanvasOrchestratorCallSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "orchcall",
    run_id: runId,
    action_id: trace.kind === "tool_call" ? trace.action_id : action?.action_id,
    trace_id: trace.trace_id,
    trace_kind: trace.kind,
    status: trace.status,
    title,
    summary: trace.kind === "tool_call" ? trace.summary : undefined,
    tool_name: trace.kind === "tool_call" ? trace.tool_name : undefined,
    tool_mode: trace.kind === "tool_call" ? trace.tool_mode : undefined,
    result_count: trace.kind === "tool_call" ? trace.result_count : undefined,
    occurred_at: trace.occurred_at,
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

export type TPpmCanvasOrchestratorProjectionRef =
  | { kind: "orchestrator"; run_id: string }
  | { action_id: string; kind: "orchtask"; run_id: string }
  | { action_id?: string; kind: "orchcall"; run_id: string; trace_id: string };

export type TPpmCanvasOrchestratorProjectionConnection = {
  action_id?: string;
  connection_id: string;
  from: TPpmCanvasOrchestratorProjectionRef;
  to: TPpmCanvasOrchestratorProjectionRef;
};

export function isSamePpmOrchestratorProjection(
  current: TPpmCanvasOrchestratorTaskNode | TPpmCanvasOrchestratorCallNode,
  incoming: TPpmCanvasOrchestratorTaskNode | TPpmCanvasOrchestratorCallNode
) {
  if (current.kind !== incoming.kind || current.run_id !== incoming.run_id) return false;
  if (current.kind === "orchtask" && incoming.kind === "orchtask") return current.action_id === incoming.action_id;
  return current.kind === "orchcall" && incoming.kind === "orchcall" && current.trace_id === incoming.trace_id;
}

export function createPpmOrchestratorProjectionConnections(
  node: TPpmCanvasOrchestratorNode
): TPpmCanvasOrchestratorProjectionConnection[] {
  const connections: TPpmCanvasOrchestratorProjectionConnection[] = [];

  for (const action of node.actions) {
    const taskRef: TPpmCanvasOrchestratorProjectionRef = {
      action_id: action.action_id,
      kind: "orchtask",
      run_id: node.run_id,
    };
    connections.push({
      action_id: action.action_id,
      connection_id: `orchestrator:${node.run_id}:action:${action.action_id}`,
      from: { kind: "orchestrator", run_id: node.run_id },
      to: taskRef,
    });

    let previousRef = taskRef;
    for (const trace of node.trace) {
      if ((trace.kind !== "action_status" && trace.kind !== "tool_call") || trace.action_id !== action.action_id)
        continue;
      const callRef: TPpmCanvasOrchestratorProjectionRef = {
        action_id: action.action_id,
        kind: "orchcall",
        run_id: node.run_id,
        trace_id: trace.trace_id,
      };
      connections.push({
        action_id: action.action_id,
        connection_id: `orchestrator:${node.run_id}:trace:${trace.trace_id}`,
        from: previousRef,
        to: callRef,
      });
      previousRef = callRef;
    }
  }

  let previousRunRef: TPpmCanvasOrchestratorProjectionRef = { kind: "orchestrator", run_id: node.run_id };
  for (const trace of node.trace) {
    if (trace.kind !== "tool_call" || trace.action_id) continue;
    const callRef: TPpmCanvasOrchestratorProjectionRef = {
      kind: "orchcall",
      run_id: node.run_id,
      trace_id: trace.trace_id,
    };
    connections.push({
      connection_id: `orchestrator:${node.run_id}:trace:${trace.trace_id}`,
      from: previousRunRef,
      to: callRef,
    });
    previousRunRef = callRef;
  }

  return connections;
}

export function createPpmAgentQueryNode({
  authorId,
  now = new Date().toISOString(),
  query,
  runId,
  runStatus,
  selectedShapeIds,
  serviceRun,
  title,
}: {
  authorId: string;
  now?: string;
  query: string;
  runId: string;
  runStatus: TPpmCanvasAgentQueryNode["run_status"];
  selectedShapeIds: string[];
  serviceRun: TPpmCanvasServiceRunEnvelope;
  title: string;
}): TPpmCanvasAgentQueryNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.agent_query;
  if (serviceRun.kind !== "answer" || serviceRun.run_id !== runId || serviceRun.status !== runStatus)
    throw new Error("Question snapshot must match its answer service run.");
  return ppmCanvasAgentQuerySchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "agent_query",
    run_id: runId,
    title,
    query,
    selected_shape_ids: selectedShapeIds,
    run_status: runStatus,
    service_run: serviceRun,
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

export function createPpmAgentAnswerNode({
  authorId,
  body,
  citations,
  now = new Date().toISOString(),
  runId,
  runStatus,
  serviceRun,
  title,
}: {
  authorId: string;
  body: string;
  citations: TPpmCanvasAgentCitation[];
  now?: string;
  runId: string;
  runStatus: TPpmCanvasAgentAnswerNode["run_status"];
  serviceRun: TPpmCanvasServiceRunEnvelope;
  title: string;
}): TPpmCanvasAgentAnswerNode {
  const definition = PPM_CANVAS_NODE_REGISTRY.agent_answer;
  if (serviceRun.kind !== "answer" || serviceRun.run_id !== runId || serviceRun.status !== runStatus)
    throw new Error("Answer snapshot must match its service run.");
  return ppmCanvasAgentAnswerSchema.parse({
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    kind: "agent_answer",
    run_id: runId,
    title,
    body,
    citations,
    run_status: runStatus,
    service_run: serviceRun,
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

  const migrated = migrateNodeToCurrent(raw, rawKind, rawVersion);
  const parsed = ppmCanvasNodeSchema.safeParse(migrated);

  if (!parsed.success)
    return {
      status: "corrupt",
      raw,
      reason: parsed.error.issues[0]?.message ?? "Node payload is invalid.",
    };

  return { status: rawVersion < PPM_CANVAS_SCHEMA_VERSION ? "migrated" : "valid", node: parsed.data };
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

export function updatePpmCanvasNode<TNode extends TPpmCanvasOwnedNode>(
  node: TNode,
  patch: Partial<Omit<TNode, "author_id" | "created_at" | "kind" | "schema_version">>,
  now = new Date().toISOString()
): TNode {
  return ppmCanvasNodeSchema.parse({
    ...node,
    ...patch,
    updated_at: now,
  }) as TNode;
}

export function duplicatePpmCanvasNode<TNode extends TPpmCanvasOwnedNode>(
  node: TNode,
  authorId: string,
  now = new Date().toISOString()
): TNode {
  const duplicate = {
    ...node,
    author_id: authorId,
    created_at: now,
    updated_at: now,
  } as Record<string, unknown>;
  if (node.kind === "checklist") duplicate.items = node.items.map((item) => ({ ...item, id: createPortableId() }));
  if (node.kind === "table") {
    const columnIds = new Map(node.columns.map((column) => [column.id, createPortableId()]));
    duplicate.columns = node.columns.map((column) => ({ ...column, id: columnIds.get(column.id) }));
    duplicate.rows = node.rows.map((row) => ({
      ...row,
      id: createPortableId(),
      cells: Object.fromEntries(
        Object.entries(row.cells).map(([columnId, value]) => [columnIds.get(columnId) ?? columnId, value])
      ),
    }));
  }
  if (node.kind === "deck") {
    duplicate.slides = node.slides.map((slide) => ({ ...slide, id: createPortableId() }));
    duplicate.active_slide = 0;
  }
  return ppmCanvasNodeSchema.parse(duplicate) as TNode;
}

export const ppmCanvasBoardExportSchema = z
  .object({
    format: z.literal("ppm-canvas-board"),
    schema_version: z.literal(PPM_CANVAS_SCHEMA_VERSION),
    exported_at: z.string().datetime(),
    document: ppmCanvasDocumentSchema,
    sources: z
      .array(
        z.object({
          shape_id: z.string().max(255),
          entity_type: z.enum([
            "work_item",
            "page",
            "attachment",
            "vault_file",
            "repository",
            "branch",
            "commit",
            "pull_request",
          ]),
          entity_id: z.string().uuid(),
          source_version: z.string().max(255).nullable(),
          source_url: z.string().max(2_048).nullable(),
        })
      )
      .default([]),
  })
  .passthrough();

export type TPpmCanvasBoardExport = z.infer<typeof ppmCanvasBoardExportSchema>;

export function createPpmCanvasBoardExport(
  snapshot: TPpmCanvasSnapshot,
  now = new Date().toISOString()
): TPpmCanvasBoardExport {
  const store = (snapshot.document as { store?: Record<string, unknown> }).store ?? {};
  const sources = Object.entries(store).flatMap(([shapeId, record]) => {
    if (!isPlainObject(record) || record.type !== "ppm-canvas-node" || !isPlainObject(record.props)) return [];
    const serialized = record.props.node;
    if (typeof serialized !== "string") return [];
    const parsed = parseSerializedPpmCanvasNode(serialized);
    if (parsed.status !== "valid" && parsed.status !== "migrated") return [];
    const node = parsed.node;
    if (!("binding" in node) || !isPlainObject(node.binding)) return [];
    const binding = node.binding as z.infer<
      typeof ppmCanvasWorkItemBindingSchema | typeof ppmCanvasContentNodeBindingSchema
    > & {
      entity_type: (typeof PPM_CANVAS_GIT_OBJECT_TYPES)[number] | "work_item" | "page" | "attachment" | "vault_file";
    };
    return [
      {
        shape_id: shapeId,
        entity_type: binding.entity_type,
        entity_id: binding.entity_id,
        source_version: binding.source_version,
        source_url: "source_url" in node ? node.source_url : null,
      },
    ];
  });
  return ppmCanvasBoardExportSchema.parse({
    format: "ppm-canvas-board",
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
    exported_at: now,
    document: snapshot.document,
    sources,
  });
}

export function parsePpmCanvasBoardExport(raw: string | unknown): TPpmCanvasBoardExport {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return ppmCanvasBoardExportSchema.parse(value);
}

export function getPpmCanvasPersistenceKey(workspaceSlug: string, projectId: string, userId: string): string {
  return ["ppm", "i0.4", "canvas", workspaceSlug, projectId, userId].map(encodeURIComponent).join(":");
}

export function isPpmCanvasEnabled(value: string | undefined, shellEnabled: boolean): boolean {
  if (!shellEnabled) return false;
  if (value === undefined || value.trim() === "") return true;
  return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
}

export function isPpmAntyFlowShellEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
}

function migrateNodeToCurrent(
  raw: Record<string, unknown>,
  kind: TPpmCanvasNodeKind,
  rawVersion: number
): Record<string, unknown> {
  if (rawVersion === PPM_CANVAS_SCHEMA_VERSION) return raw;
  if (rawVersion === 1) return { ...raw, schema_version: PPM_CANVAS_SCHEMA_VERSION };
  if (rawVersion === 0 && isPpmCanvasOwnedNodeKind(kind)) return migrateLegacyNode(raw, kind);
  return raw;
}

function migrateLegacyNode(raw: Record<string, unknown>, kind: TPpmCanvasOwnedNodeKind): Record<string, unknown> {
  const definition = PPM_CANVAS_NODE_REGISTRY[kind];
  const legacyVisual = isPlainObject(raw.visual) ? raw.visual : {};
  const now = typeof raw.updated_at === "string" ? raw.updated_at : new Date(0).toISOString();
  const { color, height, schemaVersion: _schemaVersion, width, ...preserved } = raw;

  const migrated: Record<string, unknown> = {
    ...preserved,
    schema_version: PPM_CANVAS_SCHEMA_VERSION,
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
  if (kind === "note" || kind === "document" || kind === "group" || kind === "frame")
    migrated.body = typeof raw.body === "string" ? raw.body : "";
  if (kind === "document") migrated.format = "markdown";
  if (kind === "checklist") migrated.items = Array.isArray(raw.items) ? raw.items : [];
  if (kind === "table") {
    migrated.columns =
      Array.isArray(raw.columns) && raw.columns.length > 0 ? raw.columns : [{ id: "column-1", label: "Столбец" }];
    migrated.rows = Array.isArray(raw.rows) ? raw.rows : [];
  }
  if (kind === "code") {
    migrated.code = typeof raw.code === "string" ? raw.code : "";
    migrated.language = typeof raw.language === "string" ? raw.language : "text";
    migrated.executable = false;
  }
  return migrated;
}

function isPpmCanvasNodeKind(value: string): value is TPpmCanvasNodeKind {
  return PPM_CANVAS_NODE_KINDS.includes(value as TPpmCanvasNodeKind);
}

function isPpmCanvasOwnedNodeKind(value: string): value is TPpmCanvasOwnedNodeKind {
  return PPM_CANVAS_OWNED_NODE_KINDS.includes(value as TPpmCanvasOwnedNodeKind);
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

function createPortableId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ppm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
