import type {
  TPpmCanvasAgentCitation,
  TPpmCanvasAgentAnswerNode,
  TPpmCanvasOrchestratorNode,
  TPpmCanvasSearchNode,
  TPpmCanvasSearchResult,
  TPpmCanvasServiceRunEnvelope,
} from "@ppm/canvas";

export const PPM_CANVAS_COMMAND_EVENT = "ppm-canvas-command";

export const PPM_CANVAS_COMMANDS = [
  "select",
  "add-note",
  "add-document",
  "add-checklist",
  "add-table",
  "draw-rectangle",
  "draw-ellipse",
  "draw-diamond",
  "draw-line",
  "draw-pen",
  "draw-text",
  "open-tasks",
  "add-agent-answer",
  "add-orchestrator-run",
  "add-search-results",
  "draw-connection",
  "semantic-edges",
  "undo",
  "redo",
  "zoom-in",
  "zoom-out",
  "fit-view",
  "zoom-reset",
  "focus-selection",
  "align-left",
  "align-center-horizontal",
  "align-right",
  "align-top",
  "align-center-vertical",
  "align-bottom",
] as const;

export type TPpmCanvasCommand = (typeof PPM_CANVAS_COMMANDS)[number];

export type TPpmCanvasCommandDetail = {
  boardId: string;
  command: TPpmCanvasCommand;
  agentAnswer?: {
    answer: string;
    citations: TPpmCanvasAgentCitation[];
    query: string;
    runId: string;
    runStatus: TPpmCanvasAgentAnswerNode["run_status"];
    selectedShapeIds: string[];
    serviceRun: TPpmCanvasServiceRunEnvelope;
  };
  orchestratorRun?: {
    action_summary: TPpmCanvasOrchestratorNode["action_summary"];
    actions: TPpmCanvasOrchestratorNode["actions"];
    agent_kind: TPpmCanvasOrchestratorNode["agent_kind"];
    citations: TPpmCanvasOrchestratorNode["citations"];
    model: TPpmCanvasOrchestratorNode["model"];
    policy_version: TPpmCanvasOrchestratorNode["policy_version"];
    provider: TPpmCanvasOrchestratorNode["provider"];
    run_created_at: TPpmCanvasOrchestratorNode["run_created_at"];
    run_finished_at: TPpmCanvasOrchestratorNode["run_finished_at"];
    run_id: TPpmCanvasOrchestratorNode["run_id"];
    run_started_at: string | null;
    run_status: TPpmCanvasOrchestratorNode["run_status"];
    run_updated_at: NonNullable<TPpmCanvasOrchestratorNode["run_updated_at"]>;
    selected_shape_ids: TPpmCanvasOrchestratorNode["selected_shape_ids"];
    summary: TPpmCanvasOrchestratorNode["summary"];
    title: TPpmCanvasOrchestratorNode["title"];
    trace: TPpmCanvasOrchestratorNode["trace"];
    expand?: boolean;
  };
  searchResults?: {
    degraded: boolean;
    graphDepth: number;
    query: string;
    reason?: string;
    results: TPpmCanvasSearchResult[];
    retrievalMode: TPpmCanvasSearchNode["retrieval_mode"];
    selectedShapeIds: string[];
    serviceRun: TPpmCanvasServiceRunEnvelope;
  };
};

export function dispatchPpmCanvasCommand(detail: TPpmCanvasCommandDetail) {
  window.dispatchEvent(new CustomEvent<TPpmCanvasCommandDetail>(PPM_CANVAS_COMMAND_EVENT, { detail }));
}
