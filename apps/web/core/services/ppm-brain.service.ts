import { isAxiosError } from "axios";
import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TPpmBrainSourceType = "work_item" | "vault_file" | "git_code";
export type TPpmBrainIndexState = "pending" | "indexing" | "ready" | "stale" | "failed" | "excluded" | "deleted";

export type TPpmBrainSource = {
  error_code: string;
  error_message: string;
  id: string;
  index_state: TPpmBrainIndexState;
  last_indexed_at: string | null;
  pipeline_version: string;
  source_id: string;
  source_type: TPpmBrainSourceType;
  source_version: string;
  title: string;
  updated_at: string;
};

export type TPpmBrainSources = {
  access: "edit" | "read";
  counts: Record<TPpmBrainIndexState, number>;
  sources: TPpmBrainSource[];
};

export type TPpmBrainHealth = {
  agent_writes_enabled: boolean;
  agents_enabled: boolean;
  answers_enabled: boolean;
  completion: {
    blockers: Array<
      | "credentials_missing"
      | "egress_not_approved"
      | "policy_not_approved"
      | "provider_not_selected"
      | "provider_unsupported"
    >;
    credentials_configured: boolean;
    egress_approved: boolean;
    enabled: boolean;
    model: string | null;
    policy_version: string | null;
    provider: string | null;
  };
  embedding_provider: string | null;
  failed_sources: number;
  graph_enabled: boolean;
  pending_sources: number;
  ready_sources: number;
  retrieval_mode: "keyword" | "hybrid";
  status: "ok";
};

export type TPpmAgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "applying"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "rejected";

export type TPpmAgentCitation = {
  action_id: string | null;
  locator: Record<string, string | number>;
  ordinal: number;
  source_id: string;
  source_type: TPpmBrainSourceType;
  source_version: string;
  title: string;
};

export type TPpmProposedWorkItem = {
  acceptance_criteria: string[];
  description?: string;
  source_ids: string[];
  title: string;
};

export type TPpmAppliedWorkItem = {
  id: string;
  identifier: string;
  name: string;
  url: string;
};

export type TPpmAppliedVaultEntry = {
  id: string;
  name: string;
  url: string;
  version: number;
};

export type TPpmAppliedSemanticEdge = {
  board_id: string;
  confirmation_status: "confirmed";
  edge_id: string;
  from_shape_id: string;
  origin: "agent";
  reason: string;
  relation_type: TPpmSemanticRelation;
  to_shape_id: string;
  url: string;
};

export type TPpmSemanticRelation =
  | "relates_to"
  | "depends_on"
  | "blocks"
  | "explains"
  | "implements"
  | "evidence_for"
  | "contradicts"
  | "derived_from"
  | "result_of";

export type TPpmProposedSemanticEdge = {
  board_id: string;
  from_shape_id: string;
  reason: string;
  relation: TPpmSemanticRelation;
  source_ids: string[];
  to_shape_id: string;
};

export type TPpmAgentAction = {
  action_kind: "create_work_items" | "apply_semantic_edges" | "write_vault_file";
  approved_at: string | null;
  approved_by: string | null;
  error_code: string;
  error_message: string;
  id: string;
  payload: {
    body?: string;
    edges?: TPpmProposedSemanticEdge[];
    items?: TPpmProposedWorkItem[];
    source_ids?: string[];
    target?: "page" | "vault_markdown";
    title?: string;
    [key: string]: unknown;
  };
  preconditions: Record<string, unknown>;
  preview: {
    items?: TPpmProposedWorkItem[];
    body?: string;
    edge?: TPpmProposedSemanticEdge & { from_title?: string; to_title?: string };
    source?: { identifier?: string; path?: string; title?: string };
    summary?: string;
    title?: string;
    [key: string]: unknown;
  };
  proposal_tool: string;
  rejected_at: string | null;
  rejected_by: string | null;
  result: {
    canonical_changes_applied?: boolean;
    created_count?: number;
    issues?: TPpmAppliedWorkItem[];
    semantic_edges?: TPpmAppliedSemanticEdge[];
    vault_entries?: TPpmAppliedVaultEntry[];
    [key: string]: unknown;
  };
  sequence: number;
  status: "proposed" | "approved" | "rejected" | "applying" | "applied" | "conflict" | "failed" | "cancelled";
};

export type TPpmAgentActionDecision = {
  action_id: string;
  decision: "approve" | "reject";
};

export type TPpmAgentActionSummary = {
  applied: number;
  applying: number;
  approved: number;
  cancelled: number;
  canonical_changes_applied: boolean;
  conflict: number;
  failed: number;
  partial: boolean;
  rejected: number;
  remaining: number;
  review_complete: boolean;
  reviewed: number;
  total: number;
};

export type TPpmProjectReportHighlight = {
  id: string;
  identifier: string;
  overdue: boolean;
  priority: "urgent" | "high" | "medium" | "low" | "none";
  state: string;
  state_group: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
  target_date: string | null;
  title: string;
};

export type TPpmProjectReportResult = {
  generated_at: string;
  highlights: TPpmProjectReportHighlight[];
  kind: "project_report";
  markdown: string;
  metrics: {
    completed_count: number;
    issue_count: number;
    overdue_count: number;
    risk_count: number;
    state_counts: Partial<Record<TPpmProjectReportHighlight["state_group"], number>>;
  };
  scope: { project_id: string; workspace_id: string };
  uncited_highlight_count: number;
};

export type TPpmWorkDecompositionResult = {
  action_id: string;
  action_ids: string[];
  applied_action_ids?: string[];
  canonical_changes_applied: boolean;
  generated_at: string;
  goal: string;
  item_count: number;
  kind: "work_decomposition";
  source: { id: string; identifier: string; title: string };
};

export type TPpmKnowledgeProposalResult = {
  action_id: string;
  applied_action_ids?: string[];
  canonical_changes_applied: boolean;
  generated_at: string;
  kind: "knowledge_proposal";
  source: { id: string; path: string; title: string };
  title: string;
  topic: string;
};

export type TPpmSemanticEdgeProposalResult = {
  action_id: string;
  applied_action_ids?: string[];
  board: { id: string; name: string; version: number };
  canonical_changes_applied: boolean;
  edge: TPpmProposedSemanticEdge & { from_title: string; to_title: string };
  generated_at: string;
  kind: "semantic_edge_proposal";
};

export type TPpmAgentRunOptions = {
  from_shape_id?: string;
  goal?: string;
  max_highlights?: number;
  reason?: string;
  relation?: TPpmSemanticRelation;
  source_id?: string;
  to_shape_id?: string;
  topic?: string;
};

export type TPpmAgentAuditEvent = {
  action_id: string | null;
  created_at: string;
  event_type: string;
  id: string;
  tool?: {
    mode: "read" | "propose" | "apply";
    name: string;
    result_count: number | null;
    status: "completed" | "failed";
  };
};

export type TPpmAgentToolProgress = {
  call_id: string;
  occurred_at: string;
  run_id: string;
  tool: {
    mode: "read" | "propose" | "apply";
    name: string;
    result_count: number | null;
    status: "running" | "completed" | "failed";
  };
};

export type TPpmAgentRun = {
  action_summary: TPpmAgentActionSummary;
  actions: TPpmAgentAction[];
  agent_kind: "project_reporter" | "work_decomposer" | "knowledge_librarian" | "relationship_analyst";
  attempt_count?: number;
  audit_trace: TPpmAgentAuditEvent[];
  capabilities: string[];
  cancel_requested: boolean;
  citations: TPpmAgentCitation[];
  context: {
    canvas_id?: string;
    locale?: "ru" | "en";
    selected_shape_ids?: string[];
    thread_id?: string;
  };
  created_at: string;
  error_code: string;
  error_message: string;
  finished_at: string | null;
  id: string;
  model: string;
  policy_version: string;
  provider: string;
  result:
    | TPpmKnowledgeProposalResult
    | TPpmProjectReportResult
    | TPpmSemanticEdgeProposalResult
    | TPpmWorkDecompositionResult
    | Record<string, never>;
  status: TPpmAgentRunStatus;
  started_at: string | null;
  updated_at: string;
};

export type TPpmAgentRunCreateRequest = {
  agent_kind: TPpmAgentRun["agent_kind"];
  client_operation_id: string;
  context?: TPpmAgentRun["context"];
  options?: TPpmAgentRunOptions;
};

export type TPpmBrainServiceRun = {
  created_at: string;
  finished_at: string | null;
  kind: "search" | "answer" | "orchestrator";
  model: string | null;
  policy_version: string;
  provider: string | null;
  run_id: string;
  started_at: string | null;
  status: TPpmAgentRunStatus | TPpmBrainAnswerStatus | "degraded" | "no_sources";
  updated_at: string;
};

export type TPpmBrainAnswerStatus =
  | "queued"
  | "retrieving"
  | "completing"
  | "completed"
  | "degraded"
  | "no_sources"
  | "cancelled"
  | "failed";

export type TPpmBrainCitation = {
  citation_id: string;
  chunk_id: string;
  locator: Record<string, string | number>;
  source_id: string;
  source_type: TPpmBrainSourceType;
  source_url: string;
  source_version: string;
  title: string;
  graph_path: TPpmBrainGraphStep[];
  graph_explanation: string;
};

export type TPpmBrainGraphStep = {
  edge_id: string;
  from_shape_id: string;
  label: string | null;
  relation_type: string;
  to_shape_id: string;
  traversal_direction: "forward" | "reverse";
};

export type TPpmBrainGraphScope = {
  applied_depth: number;
  confirmed_edges_considered: number;
  enabled: boolean;
  neighbor_shapes: number;
  requested_depth: number;
  source_paths: Array<{
    depth: number;
    edges: TPpmBrainGraphStep[];
    shape_id: string;
    source_id: string;
    source_type: TPpmBrainSourceType;
  }>;
};

export type TPpmBrainAnswerRun = {
  answer: string;
  board_id: string | null;
  cancel_requested: boolean;
  citations: TPpmBrainCitation[];
  created_at: string;
  error: { code: string; message: string } | null;
  finished_at: string | null;
  id: string;
  graph_depth: number;
  model: string | null;
  policy_version: string;
  provider: string | null;
  query: string;
  retrieval: { degraded?: boolean; mode?: "keyword" | "hybrid"; reason?: string };
  retrieved_sources: TPpmBrainResult[];
  scope: {
    available_sources?: number;
    bound_sources?: number;
    context_tokens?: number;
    graph?: TPpmBrainGraphScope;
    mode: "project" | "selection";
    selected?: number;
  };
  selected_shape_ids: string[];
  started_at: string | null;
  status: TPpmBrainAnswerStatus;
  updated_at: string;
};

export type TPpmBrainResult = {
  chunk_id: string;
  excerpt: string;
  locator: Record<string, string | number>;
  score: number;
  source_id: string;
  source_type: TPpmBrainSourceType;
  source_version: string;
  title: string;
  graph_path?: TPpmBrainGraphStep[];
  graph_rank_bonus?: number;
};

export type TPpmBrainQueryResponse = {
  results: TPpmBrainResult[];
  retrieval: {
    degraded: boolean;
    graph?: TPpmBrainGraphScope & { rank_bonus: number };
    mode: "keyword" | "hybrid";
    reason?: string;
  };
  service_run: TPpmBrainServiceRun & { kind: "search"; status: "completed" | "degraded" | "no_sources" };
};

export type TPpmBrainServiceProgress = {
  occurred_at: string;
  run_id: string;
  stage: {
    name:
      | "contact_answer_provider"
      | "prepare_grounded_answer"
      | "receive_provider_answer"
      | "retrieve_project_sources"
      | "search_project_knowledge";
    result_count: number | null;
    status: "running" | "completed" | "failed";
  };
};

export type TPpmBrainSearchStreamRun = {
  output: TPpmBrainQueryResponse | null;
  service_run: TPpmBrainServiceRun & {
    kind: "search";
    status: "running" | "completed" | "degraded" | "no_sources";
  };
};

export type TPpmProjectMemoryKind = "decision" | "daily_summary" | "weekly_summary" | "release_summary";

export type TPpmProjectMemoryRecord = {
  body: string;
  confirmation_status: "proposed" | "confirmed" | "rejected";
  confirmed_at: string | null;
  confirmed_by: string | null;
  content_hash: string;
  created_at: string;
  created_by: string;
  freshness_status: "current" | "possibly_stale";
  id: string;
  kind: TPpmProjectMemoryKind;
  origin: "user" | "agent";
  source_references: Array<{
    current_state: TPpmBrainIndexState;
    current_version: string;
    is_current: boolean;
    locator: Record<string, string | number>;
    source_id: string;
    source_type: TPpmBrainSourceType;
    source_version: string;
    title: string;
  }>;
  title: string;
  updated_at: string;
};

export class PpmBrainServiceError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "PpmBrainServiceError";
    this.code = options.code;
    this.status = options.status;
  }
}

export class PpmBrainService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getSources(workspaceId: string, projectId: string): Promise<TPpmBrainSources> {
    try {
      const response = await this.get(`${this.path(workspaceId, projectId)}sources/`);
      return response.data as TPpmBrainSources;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async getHealth(workspaceId: string, projectId: string): Promise<TPpmBrainHealth> {
    try {
      const response = await this.get(`${this.path(workspaceId, projectId)}health/`);
      return response.data as TPpmBrainHealth;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async createAgentRun(
    workspaceId: string,
    projectId: string,
    payload: TPpmAgentRunCreateRequest
  ): Promise<TPpmAgentRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}agents/runs/`, payload);
      return response.data as TPpmAgentRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  private async streamServiceRun<TRun, TProgress>(
    path: string,
    payload: unknown,
    onRun: (run: TRun) => void,
    onProgress: ((progress: TProgress) => void) | undefined,
    signal: AbortSignal | undefined,
    messages: { failed: string; missingBody: string; missingRun: string }
  ): Promise<TRun> {
    let latestRun: TRun | undefined;
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        body: JSON.stringify(payload),
        credentials: "include",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        method: "POST",
        signal,
      });
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => undefined)) as
          | { error?: { code?: string; message?: string } }
          | undefined;
        throw new PpmBrainServiceError(errorPayload?.error?.message ?? messages.failed, {
          code: errorPayload?.error?.code,
          status: response.status,
        });
      }
      if (!response.body) throw new PpmBrainServiceError(messages.missingBody);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleBlock = (block: string) => {
        const lines = block.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data) return;
        const parsed = JSON.parse(data) as TProgress | TRun | { code?: string; message?: string };
        if (event === "run") {
          latestRun = parsed as TRun;
          onRun(latestRun);
        }
        if (event === "progress") onProgress?.(parsed as TProgress);
        if (event === "error") {
          const errorPayload = parsed as { code?: string; message?: string };
          throw new PpmBrainServiceError(errorPayload.message ?? messages.failed, {
            code: errorPayload.code,
          });
        }
      };

      while (true) {
        // Each stream chunk must be read after the previous chunk to preserve SSE event order.
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
        let separator = buffer.indexOf("\n\n");
        while (separator >= 0) {
          handleBlock(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (buffer.trim()) handleBlock(buffer.trim());
      if (!latestRun) throw new PpmBrainServiceError(messages.missingRun);
      return latestRun;
    } catch (error) {
      if (signal?.aborted && latestRun) return latestRun;
      throw normalizeBrainError(error);
    }
  }

  private async streamAgentRunRequest(
    path: string,
    payload: TPpmAgentRunCreateRequest | { client_operation_id: string; options?: TPpmAgentRunOptions },
    onRun: (run: TPpmAgentRun) => void,
    onProgress?: (progress: TPpmAgentToolProgress) => void,
    signal?: AbortSignal
  ): Promise<TPpmAgentRun> {
    return this.streamServiceRun(path, payload, onRun, onProgress, signal, {
      failed: "Не удалось выполнить проектного агента.",
      missingBody: "Сервер не открыл поток проектного агента.",
      missingRun: "Поток проектного агента завершился без результата.",
    });
  }

  async streamAgentRun(
    workspaceId: string,
    projectId: string,
    payload: TPpmAgentRunCreateRequest,
    onRun: (run: TPpmAgentRun) => void,
    onProgress?: (progress: TPpmAgentToolProgress) => void,
    signal?: AbortSignal
  ): Promise<TPpmAgentRun> {
    return this.streamAgentRunRequest(
      `${this.path(workspaceId, projectId)}agents/runs/stream/`,
      payload,
      onRun,
      onProgress,
      signal
    );
  }

  async streamRetryAgentRun(
    workspaceId: string,
    projectId: string,
    runId: string,
    payload: { client_operation_id: string; options?: TPpmAgentRunOptions },
    onRun: (run: TPpmAgentRun) => void,
    onProgress?: (progress: TPpmAgentToolProgress) => void,
    signal?: AbortSignal
  ): Promise<TPpmAgentRun> {
    return this.streamAgentRunRequest(
      `${this.path(workspaceId, projectId)}agents/runs/${runId}/retry/stream/`,
      payload,
      onRun,
      onProgress,
      signal
    );
  }

  async getAgentRuns(workspaceId: string, projectId: string): Promise<{ results: TPpmAgentRun[] }> {
    try {
      const response = await this.get(`${this.path(workspaceId, projectId)}agents/runs/`);
      return response.data as { results: TPpmAgentRun[] };
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async getAgentRun(workspaceId: string, projectId: string, runId: string): Promise<TPpmAgentRun> {
    try {
      const response = await this.get(`${this.path(workspaceId, projectId)}agents/runs/${runId}/`);
      return response.data as TPpmAgentRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async cancelAgentRun(workspaceId: string, projectId: string, runId: string): Promise<TPpmAgentRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}agents/runs/${runId}/cancel/`, {});
      return response.data as TPpmAgentRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async retryAgentRun(
    workspaceId: string,
    projectId: string,
    runId: string,
    payload: { client_operation_id: string; options?: TPpmAgentRunOptions }
  ): Promise<TPpmAgentRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}agents/runs/${runId}/retry/`, payload);
      return response.data as TPpmAgentRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async reviewAgentAction(
    workspaceId: string,
    projectId: string,
    actionId: string,
    decision: "approve" | "reject"
  ): Promise<TPpmAgentRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}agents/actions/${actionId}/review/`, {
        decision,
      });
      return response.data as TPpmAgentRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async reviewAgentActionBatch(
    workspaceId: string,
    projectId: string,
    runId: string,
    decisions: TPpmAgentActionDecision[]
  ): Promise<TPpmAgentRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}agents/runs/${runId}/review/`, {
        decisions,
      });
      return response.data as TPpmAgentRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async applyAgentActionBatch(
    workspaceId: string,
    projectId: string,
    runId: string,
    actionIds: string[]
  ): Promise<TPpmAgentRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}agents/runs/${runId}/apply/`, {
        action_ids: actionIds,
      });
      return response.data as TPpmAgentRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async reindex(workspaceId: string, projectId: string): Promise<{ job_ids: string[]; queued: number }> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}reindex/`);
      return response.data as { job_ids: string[]; queued: number };
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async query(
    workspaceId: string,
    projectId: string,
    payload: {
      board_id?: string;
      graph_depth: number;
      query: string;
      selected_shape_ids: string[];
    }
  ): Promise<TPpmBrainQueryResponse> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}query/`, {
        query: payload.query,
        scope: {
          board_id: payload.board_id,
          graph_depth: payload.graph_depth,
          selected_shape_ids: payload.selected_shape_ids,
          source_types: ["work_item", "vault_file", "git_code"],
        },
        top_k: 12,
      });
      return response.data as TPpmBrainQueryResponse;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async streamQuery(
    workspaceId: string,
    projectId: string,
    payload: {
      board_id?: string;
      graph_depth: number;
      query: string;
      selected_shape_ids: string[];
    },
    onRun: (run: TPpmBrainSearchStreamRun) => void,
    onProgress?: (progress: TPpmBrainServiceProgress) => void,
    signal?: AbortSignal
  ): Promise<TPpmBrainSearchStreamRun> {
    return this.streamServiceRun(
      `${this.path(workspaceId, projectId)}query/stream/`,
      {
        query: payload.query,
        scope: {
          board_id: payload.board_id,
          graph_depth: payload.graph_depth,
          selected_shape_ids: payload.selected_shape_ids,
          source_types: ["work_item", "vault_file", "git_code"],
        },
        top_k: 12,
      },
      onRun,
      onProgress,
      signal,
      {
        failed: "Не удалось выполнить поиск по проекту.",
        missingBody: "Сервер не открыл поток поиска.",
        missingRun: "Поток поиска завершился без результата.",
      }
    );
  }

  async createAnswerRun(
    workspaceId: string,
    projectId: string,
    payload: {
      board_id: string;
      client_operation_id: string;
      graph_depth: number;
      query: string;
      selected_shape_ids: string[];
    }
  ): Promise<TPpmBrainAnswerRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}answers/`, payload);
      return response.data as TPpmBrainAnswerRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async streamAnswerRun(
    workspaceId: string,
    projectId: string,
    payload: {
      board_id: string;
      client_operation_id: string;
      graph_depth: number;
      query: string;
      selected_shape_ids: string[];
    },
    onRun: (run: TPpmBrainAnswerRun) => void,
    onProgress?: (progress: TPpmBrainServiceProgress) => void,
    signal?: AbortSignal
  ): Promise<TPpmBrainAnswerRun> {
    return this.streamServiceRun(
      `${this.path(workspaceId, projectId)}answers/stream/`,
      payload,
      onRun,
      onProgress,
      signal,
      {
        failed: "Не удалось подготовить ответ по проекту.",
        missingBody: "Сервер не открыл поток ответа.",
        missingRun: "Поток ответа завершился без состояния запуска.",
      }
    );
  }

  async getAnswerRuns(workspaceId: string, projectId: string): Promise<{ results: TPpmBrainAnswerRun[] }> {
    try {
      const response = await this.get(`${this.path(workspaceId, projectId)}answers/`);
      return response.data as { results: TPpmBrainAnswerRun[] };
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async getAnswerRun(workspaceId: string, projectId: string, runId: string): Promise<TPpmBrainAnswerRun> {
    try {
      const response = await this.get(`${this.path(workspaceId, projectId)}answers/${runId}/`);
      return response.data as TPpmBrainAnswerRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async cancelAnswerRun(workspaceId: string, projectId: string, runId: string): Promise<TPpmBrainAnswerRun> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}answers/${runId}/cancel/`);
      return response.data as TPpmBrainAnswerRun;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async getMemory(
    workspaceId: string,
    projectId: string
  ): Promise<{ access: "edit" | "read"; records: TPpmProjectMemoryRecord[] }> {
    try {
      const response = await this.get(`${this.path(workspaceId, projectId)}memory/`);
      return response.data as { access: "edit" | "read"; records: TPpmProjectMemoryRecord[] };
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async createMemory(
    workspaceId: string,
    projectId: string,
    payload: {
      body: string;
      client_operation_id: string;
      kind: TPpmProjectMemoryKind;
      source_references: Array<{ chunk_id?: string; source_id: string; source_type: TPpmBrainSourceType }>;
      title: string;
    }
  ): Promise<TPpmProjectMemoryRecord> {
    try {
      const response = await this.post(`${this.path(workspaceId, projectId)}memory/`, payload);
      return response.data as TPpmProjectMemoryRecord;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  async reviewMemory(
    workspaceId: string,
    projectId: string,
    memoryId: string,
    confirmationStatus: "confirmed" | "rejected"
  ): Promise<TPpmProjectMemoryRecord> {
    try {
      const response = await this.patch(`${this.path(workspaceId, projectId)}memory/${memoryId}/`, {
        confirmation_status: confirmationStatus,
      });
      return response.data as TPpmProjectMemoryRecord;
    } catch (error) {
      throw normalizeBrainError(error);
    }
  }

  watchAnswerRun(
    workspaceId: string,
    projectId: string,
    runId: string,
    onRun: (run: TPpmBrainAnswerRun) => void,
    onError: () => void
  ) {
    const source = new EventSource(`${API_BASE_URL}${this.path(workspaceId, projectId)}answers/${runId}/events/`, {
      withCredentials: true,
    });
    source.addEventListener("run", (event) => {
      const run = JSON.parse((event as MessageEvent<string>).data) as TPpmBrainAnswerRun;
      onRun(run);
      if (isTerminalAnswerStatus(run.status)) source.close();
    });
    source.addEventListener("timeout", () => {
      source.close();
      onError();
    });
    source.addEventListener("error", () => {
      source.close();
      onError();
    });
    return () => source.close();
  }

  private path(workspaceId: string, projectId: string) {
    return `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/knowledge/`;
  }
}

export function isTerminalAnswerStatus(status: TPpmBrainAnswerStatus) {
  return new Set<TPpmBrainAnswerStatus>(["completed", "degraded", "no_sources", "cancelled", "failed"]).has(status);
}

function normalizeBrainError(error: unknown) {
  if (error instanceof PpmBrainServiceError) return error;
  if (isAxiosError(error)) {
    const payload = error.response?.data as { error?: { code?: string; message?: string } } | undefined;
    return new PpmBrainServiceError(payload?.error?.message ?? "Не удалось обратиться к Мозгу проекта.", {
      code: payload?.error?.code,
      status: error.response?.status,
    });
  }
  return new PpmBrainServiceError(error instanceof Error ? error.message : "Ошибка Мозга проекта.");
}
