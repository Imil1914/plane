import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { TPpmCanvasOrchestratorTrace } from "@ppm/canvas";
import {
  AlertTriangle,
  BookOpenCheck,
  BrainCircuit,
  Check,
  ExternalLink,
  FileText,
  ListChecks,
  LoaderCircle,
  Network,
  RefreshCcw,
  ShieldCheck,
  Save,
  Search,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  isTerminalAnswerStatus,
  PpmBrainService,
  PpmBrainServiceError,
  type TPpmAgentCitation,
  type TPpmAgentActionDecision,
  type TPpmAgentRun,
  type TPpmAgentRunCreateRequest,
  type TPpmAgentRunOptions,
  type TPpmAgentToolProgress,
  type TPpmBrainAnswerRun,
  type TPpmBrainHealth,
  type TPpmBrainQueryResponse,
  type TPpmBrainResult,
  type TPpmBrainServiceProgress,
  type TPpmBrainSource,
  type TPpmProjectMemoryKind,
  type TPpmProjectMemoryRecord,
  type TPpmSemanticRelation,
} from "@/services/ppm-brain.service";
import type { TPpmCanvasCommandDetail } from "./commands";

type TPpmBrainPanelProps = {
  boardId: string;
  canEdit: boolean;
  canvasAgentRunVersions: Record<string, string>;
  onClose: () => void;
  onSaveAnswer: (run: TPpmBrainAnswerRun) => void;
  onSaveAgentRun: (payload: NonNullable<TPpmCanvasCommandDetail["orchestratorRun"]>) => void;
  onSaveSearch: (payload: NonNullable<TPpmCanvasCommandDetail["searchResults"]>) => void;
  projectId: string;
  selectedShapeIds: string[];
  workspaceId: string;
  workspaceSlug: string;
};

const SOURCE_LABELS = { git_code: "Код", vault_file: "Хранилище", work_item: "Задача" } as const;
const STATE_LABELS = {
  deleted: "Удалён",
  excluded: "Исключён",
  failed: "Ошибка",
  indexing: "Обработка",
  pending: "В очереди",
  ready: "Готов",
  stale: "Обновляется",
} as const;
const RELATION_LABELS: Record<TPpmSemanticRelation, string> = {
  relates_to: "Связано с",
  depends_on: "Зависит от",
  blocks: "Блокирует",
  explains: "Объясняет",
  implements: "Реализует",
  evidence_for: "Подтверждает",
  contradicts: "Противоречит",
  derived_from: "Получено из",
  result_of: "Результат",
};
const AGENT_KIND_LABELS: Record<TPpmAgentRun["agent_kind"], string> = {
  project_reporter: "Сводка проекта",
  work_decomposer: "Декомпозиция работы",
  knowledge_librarian: "Библиотекарь знаний",
  relationship_analyst: "Аналитик связей",
};
const AGENT_ACTION_LABELS: Record<TPpmAgentRun["actions"][number]["action_kind"], string> = {
  create_work_items: "Создание задач",
  apply_semantic_edges: "Смысловая связь",
  write_vault_file: "Файл Хранилища",
};

const AGENT_TOOL_LABELS: Record<string, string> = {
  apply_semantic_edges: "Применение смысловой связи",
  create_git_branch_from_action: "Создание ветки Git",
  create_pull_request_from_action: "Создание pull request",
  create_work_items_from_action: "Создание задач проекта",
  list_work_items: "Чтение списка задач",
  propose_page_or_vault_note: "Подготовка документа",
  propose_semantic_edges: "Подготовка смысловой связи",
  propose_work_items: "Подготовка задачи",
  read_canvas_neighborhood: "Чтение окружения холста",
  read_git_metadata: "Чтение данных Git",
  read_source_fragment: "Чтение фрагмента источника",
  read_vault_file: "Чтение файла Хранилища",
  read_work_item: "Чтение задачи",
  search_project_knowledge: "Поиск по знаниям проекта",
  write_vault_file_from_action: "Запись файла Хранилища",
};

const SERVICE_STAGE_LABELS: Record<TPpmBrainServiceProgress["stage"]["name"], string> = {
  contact_answer_provider: "Подключение к модели ответа",
  prepare_grounded_answer: "Подготовка ответа по источникам",
  receive_provider_answer: "Получение ответа модели",
  retrieve_project_sources: "Поиск подтверждённых источников",
  search_project_knowledge: "Поиск по знаниям проекта",
};
const AGENT_RUN_AUDIT_STATUSES: Record<string, TPpmAgentRun["status"] | undefined> = {
  run_awaiting_approval: "awaiting_approval",
  run_cancelled: "cancelled",
  run_completed: "completed",
  run_failed: "failed",
  run_started: "running",
  run_timed_out: "timed_out",
};
const AGENT_ACTION_AUDIT_STATUSES: Record<string, TPpmAgentRun["actions"][number]["status"] | undefined> = {
  action_applied: "applied",
  action_apply_started: "applying",
  action_approved: "approved",
  action_cancelled: "cancelled",
  action_conflict: "conflict",
  action_proposed: "proposed",
  action_rejected: "rejected",
  action_timed_out: "cancelled",
};

function formatSourceCount(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  const noun =
    lastTwoDigits >= 11 && lastTwoDigits <= 14
      ? "источников"
      : lastDigit === 1
        ? "источник"
        : lastDigit >= 2 && lastDigit <= 4
          ? "источника"
          : "источников";
  return `${count} ${noun}`;
}

function isAgentRunFailure(status: TPpmAgentRun["status"]) {
  return status === "failed" || status === "timed_out";
}

function isActiveAgentRunStatus(status: TPpmAgentRun["status"]) {
  return status === "queued" || status === "running" || status === "applying";
}

function latestAgentToolProgress(run: TPpmAgentRun): TPpmAgentToolProgress | undefined {
  let event: TPpmAgentRun["audit_trace"][number] | undefined;
  for (let index = run.audit_trace.length - 1; index >= 0; index -= 1) {
    if (!run.audit_trace[index].tool) continue;
    event = run.audit_trace[index];
    break;
  }
  if (!event?.tool) return undefined;
  return {
    call_id: event.id,
    occurred_at: event.created_at,
    run_id: run.id,
    tool: {
      ...event.tool,
      status: isAgentRunFailure(run.status) ? "failed" : event.tool.status,
    },
  };
}

function agentRunSummary(run: TPpmAgentRun) {
  if (run.error_message) return run.error_message.slice(0, 20_000);
  if (run.result.kind === "project_report") return run.result.markdown.slice(0, 20_000);
  if (run.result.kind === "work_decomposition") {
    return `Цель: ${run.result.goal}. Подготовлено предложений: ${run.result.item_count}.`;
  }
  if (run.result.kind === "knowledge_proposal") {
    return `Тема: ${run.result.topic}. Подготовлен файл «${run.result.title}».`;
  }
  if (run.result.kind === "semantic_edge_proposal") {
    return `${run.result.edge.from_title} → ${run.result.edge.to_title}: ${run.result.edge.reason}`;
  }
  return "Запуск завершён без текстового результата.";
}

function agentActionTitle(action: TPpmAgentRun["actions"][number]) {
  if (typeof action.preview.title === "string" && action.preview.title.trim())
    return action.preview.title.slice(0, 500);
  if (action.preview.edge) {
    const from = action.preview.edge.from_title || action.preview.edge.from_shape_id;
    const to = action.preview.edge.to_title || action.preview.edge.to_shape_id;
    return `${from} → ${to}`.slice(0, 500);
  }
  const firstItem = action.preview.items?.[0];
  return (firstItem?.title || AGENT_ACTION_LABELS[action.action_kind]).slice(0, 500);
}

function agentActionSummary(action: TPpmAgentRun["actions"][number]) {
  if (typeof action.preview.summary === "string" && action.preview.summary.trim())
    return action.preview.summary.slice(0, 5_000);
  if (typeof action.preview.body === "string" && action.preview.body.trim()) return action.preview.body.slice(0, 5_000);
  if (action.preview.edge?.reason) return action.preview.edge.reason.slice(0, 5_000);
  if (action.preview.items?.length)
    return action.preview.items
      .map((item) => item.title)
      .join(" · ")
      .slice(0, 5_000);
  return AGENT_ACTION_LABELS[action.action_kind];
}

function agentActionResultUrl(action: TPpmAgentRun["actions"][number]) {
  return (
    action.result.issues?.[0]?.url ?? action.result.vault_entries?.[0]?.url ?? action.result.semantic_edges?.[0]?.url
  );
}

function agentAuditTrace(run: TPpmAgentRun): TPpmCanvasOrchestratorTrace[] {
  const actionsById = new Map(run.actions.map((action) => [action.id, action]));
  const trace: TPpmCanvasOrchestratorTrace[] = [];

  for (const event of run.audit_trace) {
    if (event.tool) {
      const title = AGENT_TOOL_LABELS[event.tool.name] ?? `Инструмент: ${event.tool.name}`;
      const resultSummary =
        event.tool.result_count === null ? "Вызов завершён" : `Получено результатов: ${event.tool.result_count}`;
      trace.push({
        trace_id: `tool:${event.id}`,
        kind: "tool_call",
        status: event.tool.status,
        occurred_at: event.created_at,
        action_id: event.action_id ?? undefined,
        result_count: event.tool.result_count ?? undefined,
        summary: resultSummary,
        title,
        tool_mode: event.tool.mode,
        tool_name: event.tool.name,
      });
      continue;
    }

    if (event.event_type === "run_created") {
      trace.push({
        trace_id: `run:${run.id}:created`,
        kind: "run_created",
        status: "queued",
        occurred_at: event.created_at,
      });
      continue;
    }

    const runStatus = AGENT_RUN_AUDIT_STATUSES[event.event_type];
    if (runStatus) {
      trace.push({
        trace_id: `run:${run.id}:status:${runStatus}`,
        kind: "run_status",
        status: runStatus,
        occurred_at: event.created_at,
      });
      continue;
    }

    const actionStatus = AGENT_ACTION_AUDIT_STATUSES[event.event_type];
    const action = event.action_id ? actionsById.get(event.action_id) : undefined;
    if (!actionStatus || !action) continue;
    trace.push({
      trace_id: `action:${action.id}:status:${actionStatus}`,
      kind: "action_status",
      status: actionStatus,
      occurred_at: event.created_at,
      action_id: action.id,
      action_title: agentActionTitle(action),
    });
  }

  return trace;
}

export function PpmBrainPanel({
  boardId,
  canEdit,
  canvasAgentRunVersions,
  onClose,
  onSaveAnswer,
  onSaveAgentRun,
  onSaveSearch,
  projectId,
  selectedShapeIds,
  workspaceId,
  workspaceSlug,
}: TPpmBrainPanelProps) {
  const service = useMemo(() => new PpmBrainService(), []);
  const [health, setHealth] = useState<TPpmBrainHealth>();
  const [sources, setSources] = useState<TPpmBrainSource[]>([]);
  const [memory, setMemory] = useState<TPpmProjectMemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TPpmBrainResult[]>([]);
  const [searchSnapshot, setSearchSnapshot] = useState<{
    graphDepth: number;
    query: string;
    retrieval: TPpmBrainQueryResponse["retrieval"];
    selectedShapeIds: string[];
    serviceRun: TPpmBrainQueryResponse["service_run"];
  }>();
  const [searchSaved, setSearchSaved] = useState(false);
  const [answerRun, setAnswerRun] = useState<TPpmBrainAnswerRun>();
  const [reportRun, setReportRun] = useState<TPpmAgentRun>();
  const [decompositionRun, setDecompositionRun] = useState<TPpmAgentRun>();
  const [decompositionGoal, setDecompositionGoal] = useState("");
  const [decompositionSourceId, setDecompositionSourceId] = useState("");
  const [knowledgeRun, setKnowledgeRun] = useState<TPpmAgentRun>();
  const [knowledgeTopic, setKnowledgeTopic] = useState("");
  const [knowledgeSourceId, setKnowledgeSourceId] = useState("");
  const [relationshipRun, setRelationshipRun] = useState<TPpmAgentRun>();
  const [agentProgress, setAgentProgress] = useState<TPpmAgentToolProgress>();
  const [serviceProgress, setServiceProgress] = useState<TPpmBrainServiceProgress>();
  const [relationshipReason, setRelationshipReason] = useState("");
  const [relationshipType, setRelationshipType] = useState<TPpmSemanticRelation>("relates_to");
  const [useSelection, setUseSelection] = useState(selectedShapeIds.length > 0);
  const [graphDepth, setGraphDepth] = useState(1);
  const [savedRunId, setSavedRunId] = useState<string>();
  const [savedAgentRunVersions, setSavedAgentRunVersions] = useState<Record<string, string>>(canvasAgentRunVersions);
  const [savedMemoryRunId, setSavedMemoryRunId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [startingAnswer, setStartingAnswer] = useState(false);
  const [startingReport, setStartingReport] = useState(false);
  const [startingDecomposition, setStartingDecomposition] = useState(false);
  const [startingKnowledge, setStartingKnowledge] = useState(false);
  const [startingRelationship, setStartingRelationship] = useState(false);
  const [recoveringAnswerRunId, setRecoveringAnswerRunId] = useState<string>();
  const [recoveringAgentRunId, setRecoveringAgentRunId] = useState<string>();
  const [reviewingActionId, setReviewingActionId] = useState<string>();
  const [applyingDecomposition, setApplyingDecomposition] = useState(false);
  const [applyingKnowledge, setApplyingKnowledge] = useState(false);
  const [applyingRelationship, setApplyingRelationship] = useState(false);
  const [changingAgentRunId, setChangingAgentRunId] = useState<string>();
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const stopWatchingRef = useRef<() => void>(() => undefined);

  const watchAgentRun = useCallback(
    (runId: string) => {
      stopWatchingRef.current();
      let stopped = false;
      let failedPolls = 0;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;

      const applyRun = (run: TPpmAgentRun) => {
        if (stopped) return;
        if (run.agent_kind === "project_reporter") setReportRun(run);
        if (run.agent_kind === "work_decomposer") setDecompositionRun(run);
        if (run.agent_kind === "knowledge_librarian") setKnowledgeRun(run);
        if (run.agent_kind === "relationship_analyst") setRelationshipRun(run);
        setAgentProgress(latestAgentToolProgress(run));
        if (isAgentRunFailure(run.status)) setError(run.error_message || "Запуск агента завершился с ошибкой.");
      };

      const stopPolling = () => {
        stopped = true;
        if (pollTimer) clearTimeout(pollTimer);
        setRecoveringAgentRunId((current) => (current === runId ? undefined : current));
      };

      const poll = async () => {
        if (stopped) return;
        try {
          const run = await service.getAgentRun(workspaceId, projectId, runId);
          failedPolls = 0;
          applyRun(run);
          if (isActiveAgentRunStatus(run.status)) {
            pollTimer = setTimeout(() => void poll(), 750);
          } else {
            setRecoveringAgentRunId((current) => (current === runId ? undefined : current));
            if (stopWatchingRef.current === stopPolling) stopWatchingRef.current = () => undefined;
          }
        } catch (reason) {
          if (stopped) return;
          failedPolls += 1;
          if (failedPolls < 3) {
            pollTimer = setTimeout(() => void poll(), failedPolls * 1_000);
          } else {
            setRecoveringAgentRunId((current) => (current === runId ? undefined : current));
            setError(`Не удалось восстановить наблюдение за агентом. ${brainErrorMessage(reason)}`);
          }
        }
      };

      stopWatchingRef.current = stopPolling;
      setRecoveringAgentRunId(runId);
      void poll();
    },
    [projectId, service, workspaceId]
  );

  const loadState = useCallback(async () => {
    try {
      const [nextHealth, sourceResponse, memoryResponse, answerRunResponse, agentRunResponse] = await Promise.all([
        service.getHealth(workspaceId, projectId),
        service.getSources(workspaceId, projectId),
        service.getMemory(workspaceId, projectId),
        service.getAnswerRuns(workspaceId, projectId),
        service.getAgentRuns(workspaceId, projectId),
      ]);
      setHealth(nextHealth);
      setSources(sourceResponse.sources);
      setMemory(memoryResponse.records);
      const activeAnswerRun = answerRunResponse.results.find((run) => !isTerminalAnswerStatus(run.status));
      const activeAgentRun = agentRunResponse.results.find((run) => isActiveAgentRunStatus(run.status));
      const activeRuns: Array<{ kind: "answer"; run: TPpmBrainAnswerRun } | { kind: "agent"; run: TPpmAgentRun }> = [];
      if (activeAnswerRun) activeRuns.push({ kind: "answer", run: activeAnswerRun });
      if (activeAgentRun) activeRuns.push({ kind: "agent", run: activeAgentRun });
      const latestRuns: Array<{ kind: "answer"; run: TPpmBrainAnswerRun } | { kind: "agent"; run: TPpmAgentRun }> = [];
      if (answerRunResponse.results[0]) latestRuns.push({ kind: "answer", run: answerRunResponse.results[0] });
      if (agentRunResponse.results[0]) latestRuns.push({ kind: "agent", run: agentRunResponse.results[0] });
      const runCandidates = activeRuns.length > 0 ? activeRuns : latestRuns;
      const selectedRun = runCandidates.reduce<(typeof runCandidates)[number] | undefined>(
        (latest, candidate) =>
          !latest || Date.parse(candidate.run.updated_at) > Date.parse(latest.run.updated_at) ? candidate : latest,
        undefined
      );
      const selectedAnswerRun = selectedRun?.kind === "answer" ? selectedRun.run : undefined;
      const selectedAgentRun = selectedRun?.kind === "agent" ? selectedRun.run : undefined;
      setAnswerRun(selectedAnswerRun);
      setReportRun(selectedAgentRun?.agent_kind === "project_reporter" ? selectedAgentRun : undefined);
      setDecompositionRun(selectedAgentRun?.agent_kind === "work_decomposer" ? selectedAgentRun : undefined);
      setKnowledgeRun(selectedAgentRun?.agent_kind === "knowledge_librarian" ? selectedAgentRun : undefined);
      setRelationshipRun(selectedAgentRun?.agent_kind === "relationship_analyst" ? selectedAgentRun : undefined);
      setAgentProgress(selectedAgentRun ? latestAgentToolProgress(selectedAgentRun) : undefined);
      const shouldRecoverAnswer = Boolean(activeAnswerRun && selectedAnswerRun?.id === activeAnswerRun.id);
      setStartingAnswer(shouldRecoverAnswer);
      setRecoveringAnswerRunId(shouldRecoverAnswer ? activeAnswerRun?.id : undefined);
      if (activeAgentRun && selectedAgentRun?.id === activeAgentRun.id) watchAgentRun(activeAgentRun.id);
      setError(undefined);
    } catch (errorReason) {
      setError(brainErrorMessage(errorReason));
    } finally {
      setLoading(false);
    }
  }, [projectId, service, watchAgentRun, workspaceId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (selectedShapeIds.length === 0) setUseSelection(false);
  }, [selectedShapeIds.length]);

  useEffect(() => {
    setSavedAgentRunVersions((current) => {
      const nextEntries = Object.entries(canvasAgentRunVersions);
      if (
        Object.keys(current).length === nextEntries.length &&
        nextEntries.every(([runId, version]) => current[runId] === version)
      )
        return current;
      return canvasAgentRunVersions;
    });
  }, [canvasAgentRunVersions]);

  const readyWorkItemSources = useMemo(
    () => sources.filter((source) => source.source_type === "work_item" && source.index_state === "ready"),
    [sources]
  );
  const readyMarkdownSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.source_type === "vault_file" &&
          source.index_state === "ready" &&
          source.title.toLocaleLowerCase("ru").endsWith(".md")
      ),
    [sources]
  );

  useEffect(() => {
    if (!readyWorkItemSources.some((source) => source.source_id === decompositionSourceId)) {
      setDecompositionSourceId(readyWorkItemSources[0]?.source_id ?? "");
    }
  }, [decompositionSourceId, readyWorkItemSources]);

  useEffect(() => {
    if (!readyMarkdownSources.some((source) => source.source_id === knowledgeSourceId)) {
      setKnowledgeSourceId(readyMarkdownSources[0]?.source_id ?? "");
    }
  }, [knowledgeSourceId, readyMarkdownSources]);

  useEffect(() => () => stopWatchingRef.current(), []);

  const watchRun = useCallback(
    (runId: string) => {
      stopWatchingRef.current();
      let stopped = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const applyRun = (run: TPpmBrainAnswerRun) => {
        if (stopped) return;
        setAnswerRun(run);
        setStartingAnswer(false);
        if (isTerminalAnswerStatus(run.status)) {
          setRecoveringAnswerRunId((current) => (current === runId ? undefined : current));
          setServiceProgress(undefined);
        }
        if (run.error?.message && run.status === "failed") setError(run.error.message);
      };
      const poll = async () => {
        if (stopped) return;
        try {
          const run = await service.getAnswerRun(workspaceId, projectId, runId);
          applyRun(run);
          if (!isTerminalAnswerStatus(run.status)) pollTimer = setTimeout(() => void poll(), 750);
        } catch (reason) {
          setStartingAnswer(false);
          setRecoveringAnswerRunId((current) => (current === runId ? undefined : current));
          setError(brainErrorMessage(reason));
        }
      };
      const closeStream = service.watchAnswerRun(workspaceId, projectId, runId, applyRun, () => void poll());
      stopWatchingRef.current = () => {
        stopped = true;
        closeStream();
        if (pollTimer) clearTimeout(pollTimer);
        setRecoveringAnswerRunId((current) => (current === runId ? undefined : current));
      };
    },
    [projectId, service, workspaceId]
  );

  useEffect(() => {
    if (recoveringAnswerRunId) watchRun(recoveringAnswerRunId);
  }, [recoveringAnswerRunId, watchRun]);

  const submitSearch = async () => {
    const value = query.trim();
    if (!value) return;
    const selectedContext = useSelection ? [...selectedShapeIds] : [];
    stopWatchingRef.current();
    const controller = new AbortController();
    const stopStream = () => controller.abort();
    stopWatchingRef.current = stopStream;
    setSearching(true);
    setServiceProgress(undefined);
    setSearchSaved(false);
    setSearchSnapshot(undefined);
    setResults([]);
    setAnswerRun(undefined);
    setReportRun(undefined);
    setDecompositionRun(undefined);
    setKnowledgeRun(undefined);
    setRelationshipRun(undefined);
    setAgentProgress(undefined);
    setNotice(undefined);
    try {
      await service.streamQuery(
        workspaceId,
        projectId,
        {
          board_id: useSelection ? boardId : undefined,
          graph_depth: graphDepth,
          query: value,
          selected_shape_ids: selectedContext,
        },
        (run) => {
          if (!run.output) return;
          const response = run.output;
          setResults(response.results);
          setSearchSnapshot({
            graphDepth,
            query: value,
            retrieval: response.retrieval,
            selectedShapeIds: selectedContext,
            serviceRun: response.service_run,
          });
          setNotice(response.results.length === 0 ? "В индексированных источниках ничего не найдено." : undefined);
        },
        setServiceProgress,
        controller.signal
      );
      setError(undefined);
    } catch (reason) {
      if (!controller.signal.aborted) setError(brainErrorMessage(reason));
    } finally {
      setSearching(false);
      setServiceProgress(undefined);
      if (stopWatchingRef.current === stopStream) stopWatchingRef.current = () => undefined;
    }
  };

  const cancelSearch = () => {
    stopWatchingRef.current();
    stopWatchingRef.current = () => undefined;
    setSearching(false);
    setServiceProgress(undefined);
    setNotice("Поиск остановлен. Данные проекта не изменялись.");
  };

  const saveSearchToCanvas = () => {
    if (!searchSnapshot || results.length === 0) return;
    onSaveSearch({
      degraded: searchSnapshot.retrieval.degraded,
      graphDepth: searchSnapshot.graphDepth,
      query: searchSnapshot.query,
      reason: searchSnapshot.retrieval.reason,
      results: results.slice(0, 12).map((result) => ({
        excerpt: result.excerpt,
        locator: result.locator,
        result_id: result.chunk_id,
        score: result.score,
        source_id: result.source_id,
        source_type: result.source_type,
        source_url: sourceHref(result, workspaceSlug, projectId),
        source_version: result.source_version,
        title: result.title,
      })),
      retrievalMode: searchSnapshot.retrieval.mode,
      selectedShapeIds: searchSnapshot.selectedShapeIds,
      serviceRun: searchSnapshot.serviceRun,
    });
    setSearchSaved(true);
  };

  const saveAgentRunToCanvas = useCallback(
    (run: TPpmAgentRun, expand = false) => {
      onSaveAgentRun({
        action_summary: run.action_summary,
        actions: run.actions.map((action) => ({
          action_id: action.id,
          action_kind: action.action_kind,
          canonical_changes_applied: action.result.canonical_changes_applied === true,
          result_url: agentActionResultUrl(action),
          status: action.status,
          summary: agentActionSummary(action),
          title: agentActionTitle(action),
        })),
        agent_kind: run.agent_kind,
        citations: run.citations.map((citation) => ({
          citation_id: `${run.id}:${citation.ordinal}`,
          locator: citation.locator,
          source_id: citation.source_id,
          source_type: citation.source_type,
          source_url: agentCitationHref(citation, workspaceSlug, projectId),
          source_version: citation.source_version,
          title: citation.title,
        })),
        model: run.model,
        policy_version: run.policy_version,
        provider: run.provider,
        run_created_at: run.created_at,
        run_finished_at: run.finished_at,
        run_id: run.id,
        run_started_at: run.started_at,
        run_status: run.status,
        run_updated_at: run.updated_at,
        selected_shape_ids: run.context.selected_shape_ids ?? [],
        summary: agentRunSummary(run),
        title: AGENT_KIND_LABELS[run.agent_kind],
        trace: agentAuditTrace(run),
        expand,
      });
      setSavedAgentRunVersions((current) => ({ ...current, [run.id]: `${run.id}:${run.updated_at}` }));
    },
    [onSaveAgentRun, projectId, workspaceSlug]
  );

  const submitAnswer = async (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!value || health?.answers_enabled === false) return;
    stopWatchingRef.current();
    const controller = new AbortController();
    const stopStream = () => controller.abort();
    stopWatchingRef.current = stopStream;
    setRecoveringAnswerRunId(undefined);
    setStartingAnswer(true);
    setServiceProgress(undefined);
    setSavedRunId(undefined);
    setSearchSaved(false);
    setSearchSnapshot(undefined);
    setResults([]);
    setAnswerRun(undefined);
    setReportRun(undefined);
    setDecompositionRun(undefined);
    setKnowledgeRun(undefined);
    setRelationshipRun(undefined);
    setAgentProgress(undefined);
    setNotice(undefined);
    setError(undefined);
    try {
      const run = await service.streamAnswerRun(
        workspaceId,
        projectId,
        {
          board_id: boardId,
          client_operation_id: crypto.randomUUID(),
          graph_depth: graphDepth,
          query: value,
          selected_shape_ids: useSelection ? selectedShapeIds : [],
        },
        (nextRun) => {
          setAnswerRun(nextRun);
          setStartingAnswer(false);
          if (isTerminalAnswerStatus(nextRun.status)) setServiceProgress(undefined);
          if (nextRun.error?.message && nextRun.status === "failed") setError(nextRun.error.message);
        },
        setServiceProgress,
        controller.signal
      );
      if (!isTerminalAnswerStatus(run.status)) watchRun(run.id);
    } catch (reason) {
      if (!controller.signal.aborted) setError(brainErrorMessage(reason));
    } finally {
      setStartingAnswer(false);
      if (stopWatchingRef.current === stopStream) stopWatchingRef.current = () => undefined;
    }
  };

  const streamAgentRun = useCallback(
    async (payload: TPpmAgentRunCreateRequest, setRun: (run: TPpmAgentRun) => void, failureMessage: string) => {
      stopWatchingRef.current();
      const controller = new AbortController();
      const stopStream = () => controller.abort();
      stopWatchingRef.current = stopStream;
      setAgentProgress(undefined);
      try {
        const run = await service.streamAgentRun(
          workspaceId,
          projectId,
          payload,
          setRun,
          setAgentProgress,
          controller.signal
        );
        setRun(run);
        if (["cancelled", "failed", "timed_out"].includes(run.status)) {
          setAgentProgress((current) =>
            current ? { ...current, tool: { ...current.tool, status: "failed" } } : current
          );
        }
        if (isAgentRunFailure(run.status)) setError(run.error_message || failureMessage);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setAgentProgress((current) =>
            current ? { ...current, tool: { ...current.tool, status: "failed" } } : current
          );
          setError(brainErrorMessage(reason));
        }
      } finally {
        if (stopWatchingRef.current === stopStream) stopWatchingRef.current = () => undefined;
      }
    },
    [projectId, service, workspaceId]
  );

  const createProjectReport = async () => {
    setStartingReport(true);
    setAnswerRun(undefined);
    setDecompositionRun(undefined);
    setKnowledgeRun(undefined);
    setRelationshipRun(undefined);
    setResults([]);
    setNotice(undefined);
    setError(undefined);
    try {
      await streamAgentRun(
        {
          agent_kind: "project_reporter",
          client_operation_id: crypto.randomUUID(),
          context: { locale: "ru" },
          options: { max_highlights: 10 },
        },
        setReportRun,
        "Не удалось сформировать сводку проекта."
      );
    } finally {
      setStartingReport(false);
    }
  };

  const createWorkDecomposition = async (event: FormEvent) => {
    event.preventDefault();
    const goal = decompositionGoal.trim();
    if (!goal || !decompositionSourceId) return;
    setStartingDecomposition(true);
    setAnswerRun(undefined);
    setReportRun(undefined);
    setKnowledgeRun(undefined);
    setRelationshipRun(undefined);
    setResults([]);
    setNotice(undefined);
    setError(undefined);
    try {
      await streamAgentRun(
        {
          agent_kind: "work_decomposer",
          client_operation_id: crypto.randomUUID(),
          context: { locale: "ru" },
          options: { goal, source_id: decompositionSourceId },
        },
        setDecompositionRun,
        "Не удалось подготовить декомпозицию."
      );
    } finally {
      setStartingDecomposition(false);
    }
  };

  const createKnowledgeProposal = async (event: FormEvent) => {
    event.preventDefault();
    const topic = knowledgeTopic.trim();
    if (!topic || !knowledgeSourceId) return;
    setStartingKnowledge(true);
    setAnswerRun(undefined);
    setReportRun(undefined);
    setDecompositionRun(undefined);
    setRelationshipRun(undefined);
    setResults([]);
    setNotice(undefined);
    setError(undefined);
    try {
      await streamAgentRun(
        {
          agent_kind: "knowledge_librarian",
          client_operation_id: crypto.randomUUID(),
          context: { locale: "ru" },
          options: { source_id: knowledgeSourceId, topic },
        },
        setKnowledgeRun,
        "Не удалось подготовить дополнение."
      );
    } finally {
      setStartingKnowledge(false);
    }
  };

  const createRelationshipProposal = async (event: FormEvent) => {
    event.preventDefault();
    const reason = relationshipReason.trim();
    if (selectedShapeIds.length !== 2 || !reason) return;
    const [fromShapeId, toShapeId] = selectedShapeIds;
    setStartingRelationship(true);
    setAnswerRun(undefined);
    setReportRun(undefined);
    setDecompositionRun(undefined);
    setKnowledgeRun(undefined);
    setResults([]);
    setNotice(undefined);
    setError(undefined);
    try {
      await streamAgentRun(
        {
          agent_kind: "relationship_analyst",
          client_operation_id: crypto.randomUUID(),
          context: { canvas_id: boardId, locale: "ru", selected_shape_ids: selectedShapeIds },
          options: {
            from_shape_id: fromShapeId,
            reason,
            relation: relationshipType,
            to_shape_id: toShapeId,
          },
        },
        setRelationshipRun,
        "Не удалось подготовить смысловую связь."
      );
    } finally {
      setStartingRelationship(false);
    }
  };

  const reviewDecompositionBatch = async (decisions: TPpmAgentActionDecision[]) => {
    if (!decompositionRun || decisions.length === 0) return;
    setReviewingActionId(decompositionRun.id);
    setNotice(undefined);
    setError(undefined);
    try {
      const run = await service.reviewAgentActionBatch(workspaceId, projectId, decompositionRun.id, decisions);
      setDecompositionRun(run);
      const nextStep =
        run.action_summary.approved > 0 && health?.agent_writes_enabled
          ? " Теперь можно создать принятые задачи."
          : " Проект пока не изменён.";
      setNotice(
        `Решения сохранены: принято ${run.action_summary.approved}, отклонено ${run.action_summary.rejected}, ` +
          `без решения ${run.action_summary.remaining}.${nextStep}`
      );
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setReviewingActionId(undefined);
    }
  };

  const applyDecomposition = async () => {
    if (!decompositionRun) return;
    const actionIds = decompositionRun.actions
      .filter((action) => action.status === "approved")
      .map((action) => action.id);
    if (actionIds.length === 0) return;
    setApplyingDecomposition(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const run = await service.applyAgentActionBatch(workspaceId, projectId, decompositionRun.id, actionIds);
      setDecompositionRun(run);
      const createdCount = run.actions
        .filter((action) => actionIds.includes(action.id))
        .reduce((total, action) => total + (action.result.created_count ?? 0), 0);
      setNotice(`Создано задач: ${createdCount}. Они уже доступны в разделе «Задачи» текущего проекта.`);
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setApplyingDecomposition(false);
    }
  };

  const reviewKnowledgeProposal = async (actionId: string, decision: "approve" | "reject") => {
    setReviewingActionId(actionId);
    setNotice(undefined);
    setError(undefined);
    try {
      const run = await service.reviewAgentAction(workspaceId, projectId, actionId, decision);
      setKnowledgeRun(run);
      setNotice(
        decision === "approve"
          ? health?.agent_writes_enabled
            ? "Черновик принят. Теперь его можно отдельной кнопкой создать в Хранилище."
            : "Черновик принят. Файл не создан: применение предложений отключено администратором."
          : "Черновик отклонён без изменений Хранилища."
      );
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setReviewingActionId(undefined);
    }
  };

  const applyKnowledgeProposal = async () => {
    if (!knowledgeRun) return;
    const action = knowledgeRun.actions.find((item) => item.status === "approved");
    if (!action) return;
    setApplyingKnowledge(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const run = await service.applyAgentActionBatch(workspaceId, projectId, knowledgeRun.id, [action.id]);
      setKnowledgeRun(run);
      const createdEntry = run.actions.find((item) => item.id === action.id)?.result.vault_entries?.[0];
      setNotice(
        createdEntry
          ? `Файл «${createdEntry.name}» создан в Хранилище проекта.`
          : "Черновик применён к Хранилищу проекта."
      );
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setApplyingKnowledge(false);
    }
  };

  const reviewRelationshipProposal = async (actionId: string, decision: "approve" | "reject") => {
    setReviewingActionId(actionId);
    setNotice(undefined);
    setError(undefined);
    try {
      const run = await service.reviewAgentAction(workspaceId, projectId, actionId, decision);
      setRelationshipRun(run);
      setNotice(
        decision === "approve"
          ? health?.agent_writes_enabled
            ? "Связь принята. Теперь её можно отдельной кнопкой добавить на Холст."
            : "Связь принята. Холст не изменён: применение предложений отключено администратором."
          : "Предложение связи отклонено без изменений холста."
      );
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setReviewingActionId(undefined);
    }
  };

  const applyRelationshipProposal = async () => {
    if (!relationshipRun) return;
    const action = relationshipRun.actions.find((item) => item.status === "approved");
    if (!action) return;
    setApplyingRelationship(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const run = await service.applyAgentActionBatch(workspaceId, projectId, relationshipRun.id, [action.id]);
      setRelationshipRun(run);
      setNotice("Смысловая связь добавлена на доску и доступна Мозгу проекта.");
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setApplyingRelationship(false);
    }
  };

  const setCurrentAgentRun = (run: TPpmAgentRun) => {
    if (run.agent_kind === "project_reporter") setReportRun(run);
    if (run.agent_kind === "work_decomposer") setDecompositionRun(run);
    if (run.agent_kind === "knowledge_librarian") setKnowledgeRun(run);
    if (run.agent_kind === "relationship_analyst") setRelationshipRun(run);
  };

  const clearCurrentAgentRun = (run: TPpmAgentRun) => {
    if (run.agent_kind === "project_reporter") setReportRun(undefined);
    if (run.agent_kind === "work_decomposer") setDecompositionRun(undefined);
    if (run.agent_kind === "knowledge_librarian") setKnowledgeRun(undefined);
    if (run.agent_kind === "relationship_analyst") setRelationshipRun(undefined);
  };

  const cancelAgentRun = async (run: TPpmAgentRun) => {
    setChangingAgentRunId(run.id);
    setNotice(undefined);
    setError(undefined);
    try {
      stopWatchingRef.current();
      const cancelled = await service.cancelAgentRun(workspaceId, projectId, run.id);
      setCurrentAgentRun(cancelled);
      setNotice("Запуск отменён. Ни одно предложенное изменение не применено.");
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setChangingAgentRunId(undefined);
    }
  };

  const retryAgentRun = async (run: TPpmAgentRun) => {
    const options = retryOptions(run, {
      decompositionGoal,
      decompositionSourceId,
      knowledgeSourceId,
      knowledgeTopic,
      relationshipReason,
      relationshipType,
      selectedShapeIds,
    });
    if (!options) {
      clearCurrentAgentRun(run);
      setError(undefined);
      setNotice(
        "Исходный текст запуска не хранится. Введите параметры ещё раз — предыдущая попытка останется в аудите."
      );
      return;
    }

    setChangingAgentRunId(run.id);
    setAgentProgress(undefined);
    setNotice(undefined);
    setError(undefined);
    stopWatchingRef.current();
    const controller = new AbortController();
    const stopStream = () => controller.abort();
    stopWatchingRef.current = stopStream;
    try {
      const retried = await service.streamRetryAgentRun(
        workspaceId,
        projectId,
        run.id,
        {
          client_operation_id: crypto.randomUUID(),
          options,
        },
        (current) => {
          setCurrentAgentRun(current);
          if (current.id !== run.id) setChangingAgentRunId(undefined);
        },
        setAgentProgress,
        controller.signal
      );
      setCurrentAgentRun(retried);
      if (["cancelled", "failed", "timed_out"].includes(retried.status)) {
        setAgentProgress((current) =>
          current ? { ...current, tool: { ...current.tool, status: "failed" } } : current
        );
      }
      if (isAgentRunFailure(retried.status)) {
        setError(retried.error_message || "Не удалось повторить запуск проектного агента.");
      } else {
        setNotice("Создан новый запуск с теми же параметрами. Предыдущий запуск сохранён в истории аудита.");
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setAgentProgress((current) =>
          current ? { ...current, tool: { ...current.tool, status: "failed" } } : current
        );
        setError(brainErrorMessage(reason));
      }
    } finally {
      setChangingAgentRunId(undefined);
      if (stopWatchingRef.current === stopStream) stopWatchingRef.current = () => undefined;
    }
  };

  const cancelAnswer = async () => {
    if (!answerRun || isTerminalAnswerStatus(answerRun.status)) return;
    try {
      const cancelled = await service.cancelAnswerRun(workspaceId, projectId, answerRun.id);
      stopWatchingRef.current();
      setRecoveringAnswerRunId(undefined);
      setAnswerRun(cancelled);
      setStartingAnswer(false);
      setServiceProgress(undefined);
    } catch (reason) {
      setError(brainErrorMessage(reason));
    }
  };

  const reindex = async () => {
    setReindexing(true);
    setNotice(undefined);
    try {
      const response = await service.reindex(workspaceId, projectId);
      setNotice(response.queued > 0 ? `Поставлено в очередь: ${response.queued}.` : "Все источники уже актуальны.");
      window.setTimeout(() => void loadState(), 1200);
      setError(undefined);
    } catch (reason) {
      setError(brainErrorMessage(reason));
    } finally {
      setReindexing(false);
    }
  };

  const saveAnswerToMemory = async (run: TPpmBrainAnswerRun, kind: TPpmProjectMemoryKind) => {
    if (!run.answer || run.citations.length === 0) return;
    try {
      const record = await service.createMemory(workspaceId, projectId, {
        body: run.answer,
        client_operation_id: crypto.randomUUID(),
        kind,
        source_references: run.citations.map((citation) => ({
          chunk_id: citation.chunk_id,
          source_id: citation.source_id,
          source_type: citation.source_type,
        })),
        title: memoryTitle(kind, run.query),
      });
      setMemory((current) => [record, ...current.filter((item) => item.id !== record.id)]);
      setSavedMemoryRunId(run.id);
      setError(undefined);
    } catch (reason) {
      setError(brainErrorMessage(reason));
    }
  };

  const reviewMemory = async (recordId: string, confirmationStatus: "confirmed" | "rejected") => {
    try {
      const record = await service.reviewMemory(workspaceId, projectId, recordId, confirmationStatus);
      setMemory((current) => current.map((item) => (item.id === record.id ? record : item)));
      setError(undefined);
    } catch (reason) {
      setError(brainErrorMessage(reason));
    }
  };

  const answerRunning = Boolean(answerRun && !isTerminalAnswerStatus(answerRun.status));
  const activeAgentRun = relationshipRun ?? knowledgeRun ?? decompositionRun ?? reportRun;
  const agentStarting = startingReport || startingDecomposition || startingKnowledge || startingRelationship;
  const agentBusy = Boolean(
    agentStarting || (activeAgentRun && ["queued", "running", "applying"].includes(activeAgentRun.status))
  );
  const activeAgentProgress = activeAgentRun && agentProgress?.run_id === activeAgentRun.id ? agentProgress : undefined;
  const canCancelAgentRun = Boolean(
    activeAgentRun &&
    ["queued", "running", "awaiting_approval"].includes(activeAgentRun.status) &&
    !activeAgentRun.actions.some((action) => ["approved", "applying", "applied"].includes(action.status))
  );
  const canRetryAgentRun = Boolean(
    activeAgentRun && ["failed", "timed_out", "cancelled", "rejected"].includes(activeAgentRun.status)
  );
  const canSaveAgentRun = Boolean(
    canEdit && activeAgentRun && !["queued", "running", "applying"].includes(activeAgentRun.status)
  );
  const activeAgentRunVersion = activeAgentRun ? `${activeAgentRun.id}:${activeAgentRun.updated_at}` : undefined;
  const savedActiveAgentRunVersion = activeAgentRun ? savedAgentRunVersions[activeAgentRun.id] : undefined;
  const agentRunControlTitle =
    activeAgentRun?.status === "timed_out"
      ? "Время запуска истекло"
      : canRetryAgentRun
        ? "Запуск можно повторить"
        : "Предложение ещё не применено";
  const agentRunControlDescription =
    activeAgentRun?.status === "timed_out"
      ? "Безопасный лимит остановил запуск. Проект не изменён; запустите агента заново."
      : canRetryAgentRun
        ? "Повтор создаст новый запуск и сохранит предыдущий в аудите."
        : "Отмена закроет запуск и не изменит задачи, Хранилище или Холст.";

  useEffect(() => {
    if (
      !activeAgentRun ||
      !activeAgentRunVersion ||
      !savedActiveAgentRunVersion ||
      savedActiveAgentRunVersion === activeAgentRunVersion
    )
      return;
    saveAgentRunToCanvas(activeAgentRun);
  }, [activeAgentRun, activeAgentRunVersion, saveAgentRunToCanvas, savedActiveAgentRunVersion]);

  return (
    <div className="ppm-brain-panel" role="dialog" aria-label="Спросить проект" aria-modal="true">
      <header className="ppm-brain-panel__header">
        <span className="ppm-brain-panel__icon">
          <BrainCircuit aria-hidden="true" />
        </span>
        <div>
          <strong>Спросить проект</strong>
          <span>Ответы только по доступным задачам и материалам проекта</span>
        </div>
        <button type="button" aria-label="Закрыть" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>

      {loading ? (
        <div className="ppm-brain-panel__state">
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          Проверяем индекс…
        </div>
      ) : (
        <>
          <section className="ppm-brain-panel__summary" aria-label="Состояние индекса">
            <StatusCard label="Готово" value={health?.ready_sources ?? 0} tone="ready" />
            <StatusCard label="В очереди" value={health?.pending_sources ?? 0} tone="pending" />
            <StatusCard label="Ошибки" value={health?.failed_sources ?? 0} tone="failed" />
          </section>

          {health?.answers_enabled !== false && health?.completion.enabled === false && (
            <div className="ppm-brain-panel__message">
              <strong>Ответы без внешней ИИ-модели.</strong> PPM формирует проверяемую сводку по источникам проекта.
              Подключение модели требует утверждённой политики и отдельного серверного ключа.
            </div>
          )}

          <section className="ppm-brain-panel__report-launcher" aria-label="Агент Сводка проекта">
            <span className="ppm-brain-panel__report-icon">
              <FileText aria-hidden="true" />
            </span>
            <div>
              <strong>Сводка проекта</strong>
              <span>
                <ShieldCheck aria-hidden="true" /> Только чтение · задачи проекта не изменяются
              </span>
            </div>
            <button
              type="button"
              disabled={agentBusy || answerRunning || searching || health?.agents_enabled === false}
              onClick={() => void createProjectReport()}
            >
              {startingReport ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <FileText aria-hidden="true" />
              )}
              {reportRun ? "Обновить" : "Создать"}
            </button>
          </section>

          <form
            className="ppm-brain-panel__decomposer-launcher"
            aria-label="Агент Декомпозиция работы"
            onSubmit={createWorkDecomposition}
          >
            <header>
              <span className="ppm-brain-panel__report-icon">
                <ListChecks aria-hidden="true" />
              </span>
              <div>
                <strong>Декомпозиция работы</strong>
                <span>
                  <ShieldCheck aria-hidden="true" /> Черновик · создание задач только после вашего подтверждения
                </span>
              </div>
            </header>
            <textarea
              aria-label="Цель декомпозиции"
              maxLength={500}
              placeholder="Какой результат нужно разложить на задачи?"
              rows={2}
              value={decompositionGoal}
              onChange={(event) => setDecompositionGoal(event.currentTarget.value)}
            />
            <div>
              <select
                aria-label="Исходная задача"
                disabled={readyWorkItemSources.length === 0}
                value={decompositionSourceId}
                onChange={(event) => setDecompositionSourceId(event.currentTarget.value)}
              >
                {readyWorkItemSources.length === 0 ? (
                  <option value="">Нет готовых задач в индексе</option>
                ) : (
                  readyWorkItemSources.map((source) => (
                    <option key={source.id} value={source.source_id}>
                      {source.title || "Задача без названия"}
                    </option>
                  ))
                )}
              </select>
              <button
                type="submit"
                disabled={
                  agentBusy ||
                  answerRunning ||
                  searching ||
                  health?.agents_enabled === false ||
                  !decompositionGoal.trim() ||
                  !decompositionSourceId
                }
              >
                {startingDecomposition ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <ListChecks aria-hidden="true" />
                )}
                Подготовить
              </button>
            </div>
          </form>

          <form
            className="ppm-brain-panel__decomposer-launcher"
            aria-label="Агент Аналитик связей"
            onSubmit={createRelationshipProposal}
          >
            <header>
              <span className="ppm-brain-panel__report-icon">
                <Network aria-hidden="true" />
              </span>
              <div>
                <strong>Аналитик связей</strong>
                <span>
                  <ShieldCheck aria-hidden="true" /> Выберите ровно 2 объекта · связь добавляется после подтверждения
                </span>
              </div>
            </header>
            <textarea
              aria-label="Основание смысловой связи"
              maxLength={1000}
              placeholder="Почему эти объекты связаны?"
              rows={2}
              value={relationshipReason}
              onChange={(event) => setRelationshipReason(event.currentTarget.value)}
            />
            <div>
              <select
                aria-label="Тип смысловой связи"
                value={relationshipType}
                onChange={(event) => setRelationshipType(event.currentTarget.value as TPpmSemanticRelation)}
              >
                {Object.entries(RELATION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={
                  agentBusy ||
                  answerRunning ||
                  searching ||
                  health?.agents_enabled === false ||
                  selectedShapeIds.length !== 2 ||
                  !relationshipReason.trim()
                }
              >
                {startingRelationship ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Network aria-hidden="true" />
                )}
                Предложить
              </button>
            </div>
          </form>

          <form
            className="ppm-brain-panel__decomposer-launcher"
            aria-label="Агент Библиотекарь знаний"
            onSubmit={createKnowledgeProposal}
          >
            <header>
              <span className="ppm-brain-panel__report-icon">
                <BookOpenCheck aria-hidden="true" />
              </span>
              <div>
                <strong>Библиотекарь знаний</strong>
                <span>
                  <ShieldCheck aria-hidden="true" /> Черновик · создание файла после вашего подтверждения
                </span>
              </div>
            </header>
            <textarea
              aria-label="Пробел в знаниях"
              maxLength={500}
              placeholder="Что нужно уточнить или добавить в базу знаний?"
              rows={2}
              value={knowledgeTopic}
              onChange={(event) => setKnowledgeTopic(event.currentTarget.value)}
            />
            <div>
              <select
                aria-label="Исходный Markdown-материал"
                disabled={readyMarkdownSources.length === 0}
                value={knowledgeSourceId}
                onChange={(event) => setKnowledgeSourceId(event.currentTarget.value)}
              >
                {readyMarkdownSources.length === 0 ? (
                  <option value="">Нет готовых Markdown-материалов</option>
                ) : (
                  readyMarkdownSources.map((source) => (
                    <option key={source.id} value={source.source_id}>
                      {source.title || "Материал без названия"}
                    </option>
                  ))
                )}
              </select>
              <button
                type="submit"
                disabled={
                  agentBusy ||
                  answerRunning ||
                  searching ||
                  health?.agents_enabled === false ||
                  !knowledgeTopic.trim() ||
                  !knowledgeSourceId
                }
              >
                {startingKnowledge ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <BookOpenCheck aria-hidden="true" />
                )}
                Подготовить
              </button>
            </div>
          </form>

          {health?.agents_enabled === false && (
            <div className="ppm-brain-panel__message">Проектные агенты отключены глобальным администратором.</div>
          )}

          <form className="ppm-brain-panel__ask" onSubmit={submitAnswer}>
            <textarea
              aria-label="Вопрос проекту"
              maxLength={500}
              placeholder="Например: что блокирует испытания и где это зафиксировано?"
              rows={3}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="ppm-brain-panel__scope">
              <label data-disabled={selectedShapeIds.length === 0 || undefined}>
                <input
                  checked={useSelection}
                  disabled={selectedShapeIds.length === 0 || answerRunning || agentBusy}
                  type="checkbox"
                  onChange={(event) => setUseSelection(event.target.checked)}
                />
                <span>
                  {selectedShapeIds.length > 0
                    ? `Только выбранные объекты: ${selectedShapeIds.length}`
                    : "Весь проект — на холсте ничего не выбрано"}
                </span>
              </label>
              {useSelection && selectedShapeIds.length > 0 && (
                <label data-disabled={health?.graph_enabled === false || undefined}>
                  <span>
                    {health?.graph_enabled === false
                      ? "Соседи по связям отключены администратором"
                      : "Соседи по подтверждённым связям"}
                  </span>
                  <select
                    aria-label="Глубина смыслового графа"
                    disabled={answerRunning || agentBusy || health?.graph_enabled === false}
                    value={graphDepth}
                    onChange={(event) => setGraphDepth(Number(event.currentTarget.value))}
                  >
                    <option value={0}>Не добавлять</option>
                    <option value={1}>1 шаг</option>
                    <option value={2}>2 шага</option>
                  </select>
                </label>
              )}
            </div>
            <div className="ppm-brain-panel__ask-actions">
              <button
                type="button"
                className={searching ? "ppm-brain-panel__cancel" : "ppm-brain-panel__secondary"}
                disabled={agentBusy || answerRunning || (!searching && !query.trim())}
                onClick={() => (searching ? cancelSearch() : void submitSearch())}
              >
                {searching ? <Square aria-hidden="true" /> : <Search aria-hidden="true" />}
                {searching ? "Остановить поиск" : "Найти источники"}
              </button>
              {answerRunning ? (
                <button type="button" className="ppm-brain-panel__cancel" onClick={() => void cancelAnswer()}>
                  <Square aria-hidden="true" />
                  Остановить
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={
                    startingAnswer || searching || agentBusy || !query.trim() || health?.answers_enabled === false
                  }
                >
                  {startingAnswer ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  Спросить
                </button>
              )}
            </div>
          </form>

          {health?.answers_enabled === false && (
            <div className="ppm-brain-panel__message">
              Ответы отключены администратором. Поиск по источникам доступен.
            </div>
          )}
          {error && (
            <div className="ppm-brain-panel__message" data-tone="error">
              {error}
            </div>
          )}
          {notice && <div className="ppm-brain-panel__message">{notice}</div>}

          {serviceProgress && (searching || answerRunning) && (
            <section
              className="ppm-brain-panel__agent-progress"
              data-status={serviceProgress.stage.status}
              aria-live="polite"
              aria-label="Ход выполнения Мозга проекта"
            >
              {serviceProgress.stage.status === "running" ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <div>
                <strong>{SERVICE_STAGE_LABELS[serviceProgress.stage.name]}</strong>
                <span>
                  {serviceProgress.stage.status === "running"
                    ? serviceProgress.stage.name === "receive_provider_answer" &&
                      serviceProgress.stage.result_count !== null
                      ? `Получено фрагментов: ${serviceProgress.stage.result_count}`
                      : "Выполняется"
                    : serviceProgress.stage.result_count === null
                      ? "Выполнено"
                      : serviceProgress.stage.name === "receive_provider_answer"
                        ? `Выполнено · фрагментов: ${serviceProgress.stage.result_count}`
                        : `Выполнено · результатов: ${serviceProgress.stage.result_count}`}
                </span>
              </div>
            </section>
          )}

          {activeAgentRun && (activeAgentRun.attempt_count ?? 1) > 1 && (
            <section
              className="ppm-brain-panel__agent-progress"
              data-status={isActiveAgentRunStatus(activeAgentRun.status) ? "running" : "completed"}
              aria-live="polite"
              aria-label="Восстановление исполнения агента"
            >
              <RefreshCcw aria-hidden="true" />
              <div>
                <strong>Исполнение восстановлено</strong>
                <span>
                  Предыдущий worker остановился. PPM продолжил запуск с попытки {activeAgentRun.attempt_count} без
                  дублирования предложений.
                </span>
              </div>
            </section>
          )}

          {recoveringAnswerRunId && answerRun?.id === recoveringAnswerRunId && (
            <section
              className="ppm-brain-panel__agent-progress"
              data-status="running"
              aria-live="polite"
              aria-label="Наблюдение за ответом проекта"
            >
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              <div>
                <strong>Наблюдение за ответом восстановлено</strong>
                <span>PPM продолжает отслеживать запрос после перезагрузки страницы.</span>
              </div>
            </section>
          )}

          {recoveringAgentRunId && activeAgentRun?.id === recoveringAgentRunId ? (
            <section
              className="ppm-brain-panel__agent-progress"
              data-status="running"
              aria-live="polite"
              aria-label="Наблюдение за запуском агента"
            >
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              <div>
                <strong>Наблюдение восстановлено</strong>
                <span>PPM обновляет состояние запущенного агента…</span>
              </div>
            </section>
          ) : activeAgentProgress ? (
            <section
              className="ppm-brain-panel__agent-progress"
              data-status={activeAgentProgress.tool.status}
              aria-live="polite"
              aria-label={activeAgentProgress.tool.status === "running" ? "Текущий шаг агента" : "Последний шаг агента"}
            >
              {activeAgentProgress.tool.status === "running" ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : activeAgentProgress.tool.status === "failed" ? (
                <AlertTriangle aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              <div>
                <strong>{AGENT_TOOL_LABELS[activeAgentProgress.tool.name] ?? "Безопасный шаг агента"}</strong>
                <span>
                  {activeAgentProgress.tool.status === "running"
                    ? "Выполняется…"
                    : activeAgentProgress.tool.status === "failed"
                      ? "Остановлено"
                      : activeAgentProgress.tool.result_count === null
                        ? "Выполнено"
                        : `Выполнено · результатов: ${activeAgentProgress.tool.result_count}`}
                </span>
              </div>
            </section>
          ) : null}

          {activeAgentRun && (canCancelAgentRun || canRetryAgentRun) && (
            <section className="ppm-brain-panel__agent-run-controls" aria-label="Управление запуском агента">
              <div>
                <strong>{agentRunControlTitle}</strong>
                <span>{agentRunControlDescription}</span>
              </div>
              {canCancelAgentRun && (
                <button
                  type="button"
                  className="ppm-brain-panel__cancel"
                  disabled={changingAgentRunId === activeAgentRun.id}
                  onClick={() => void cancelAgentRun(activeAgentRun)}
                >
                  {changingAgentRunId === activeAgentRun.id ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Square aria-hidden="true" />
                  )}
                  Отменить запуск
                </button>
              )}
              {canRetryAgentRun && (
                <button
                  type="button"
                  className="ppm-brain-panel__secondary"
                  disabled={changingAgentRunId === activeAgentRun.id}
                  onClick={() => void retryAgentRun(activeAgentRun)}
                >
                  {changingAgentRunId === activeAgentRun.id ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCcw aria-hidden="true" />
                  )}
                  {activeAgentRun.status === "timed_out" ? "Запустить заново" : "Повторить"}
                </button>
              )}
            </section>
          )}

          {activeAgentRun && canSaveAgentRun && (
            <section className="ppm-brain-panel__agent-run-save" aria-label="Карточка запуска агента на Холсте">
              <div>
                <strong>Запуск можно закрепить на Холсте</strong>
                <span>Повторное сохранение обновит эту же карточку и дополнит её хронологию без создания дубля.</span>
              </div>
              <button
                type="button"
                disabled={savedActiveAgentRunVersion === activeAgentRunVersion}
                onClick={() => saveAgentRunToCanvas(activeAgentRun)}
              >
                <Save aria-hidden="true" />
                {savedActiveAgentRunVersion === activeAgentRunVersion
                  ? "Карточка актуальна"
                  : savedActiveAgentRunVersion
                    ? "Обновить карточку"
                    : "Добавить на холст"}
              </button>
              {(activeAgentRun.actions.length > 0 || activeAgentRun.audit_trace.some((event) => event.tool)) && (
                <button type="button" onClick={() => saveAgentRunToCanvas(activeAgentRun, true)}>
                  <Network aria-hidden="true" />
                  Разложить на холсте
                </button>
              )}
            </section>
          )}

          <div className="ppm-brain-panel__body">
            {relationshipRun ? (
              <RelationshipProposal
                applying={applyingRelationship}
                canApply={canEdit && health?.agent_writes_enabled === true}
                canReview={canEdit}
                projectId={projectId}
                reviewingActionId={reviewingActionId}
                run={relationshipRun}
                writeEnabled={health?.agent_writes_enabled === true}
                workspaceSlug={workspaceSlug}
                onApply={() => void applyRelationshipProposal()}
                onClose={() => setRelationshipRun(undefined)}
                onReview={(actionId, decision) => void reviewRelationshipProposal(actionId, decision)}
              />
            ) : knowledgeRun ? (
              <KnowledgeProposal
                applying={applyingKnowledge}
                canApply={canEdit && health?.agent_writes_enabled === true}
                canReview={canEdit}
                projectId={projectId}
                reviewingActionId={reviewingActionId}
                run={knowledgeRun}
                writeEnabled={health?.agent_writes_enabled === true}
                workspaceSlug={workspaceSlug}
                onApply={() => void applyKnowledgeProposal()}
                onClose={() => setKnowledgeRun(undefined)}
                onReview={(actionId, decision) => void reviewKnowledgeProposal(actionId, decision)}
              />
            ) : decompositionRun ? (
              <WorkDecomposition
                applying={applyingDecomposition}
                canApply={canEdit && health?.agent_writes_enabled === true}
                canReview={canEdit}
                projectId={projectId}
                reviewing={reviewingActionId === decompositionRun.id}
                run={decompositionRun}
                writeEnabled={health?.agent_writes_enabled === true}
                workspaceSlug={workspaceSlug}
                onApply={() => void applyDecomposition()}
                onClose={() => setDecompositionRun(undefined)}
                onReviewBatch={(decisions) => void reviewDecompositionBatch(decisions)}
              />
            ) : reportRun ? (
              <ProjectReport
                projectId={projectId}
                run={reportRun}
                workspaceSlug={workspaceSlug}
                onClose={() => setReportRun(undefined)}
              />
            ) : answerRun ? (
              <AnswerResult
                canSave={canEdit}
                memorySaved={savedMemoryRunId === answerRun.id}
                run={answerRun}
                saved={savedRunId === answerRun.id}
                onSave={() => {
                  onSaveAnswer(answerRun);
                  setSavedRunId(answerRun.id);
                }}
                onSaveMemory={(kind) => void saveAnswerToMemory(answerRun, kind)}
              />
            ) : results.length > 0 ? (
              <SearchResults
                canSave={canEdit}
                projectId={projectId}
                results={results}
                saved={searchSaved}
                workspaceSlug={workspaceSlug}
                onSave={saveSearchToCanvas}
              />
            ) : (
              <>
                <SourceList
                  canEdit={canEdit}
                  reindexing={reindexing}
                  sources={sources}
                  onReindex={() => void reindex()}
                />
                <MemoryList
                  canEdit={canEdit}
                  records={memory}
                  onReview={(recordId, status) => void reviewMemory(recordId, status)}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function retryOptions(
  run: TPpmAgentRun,
  fallback: {
    decompositionGoal: string;
    decompositionSourceId: string;
    knowledgeSourceId: string;
    knowledgeTopic: string;
    relationshipReason: string;
    relationshipType: TPpmSemanticRelation;
    selectedShapeIds: string[];
  }
): TPpmAgentRunOptions | undefined {
  if (run.agent_kind === "project_reporter") return { max_highlights: 10 };
  if (run.agent_kind === "work_decomposer") {
    if (run.result.kind === "work_decomposition") {
      return { goal: run.result.goal, source_id: run.result.source.id };
    }
    const goal = fallback.decompositionGoal.trim();
    return goal && fallback.decompositionSourceId ? { goal, source_id: fallback.decompositionSourceId } : undefined;
  }
  if (run.agent_kind === "knowledge_librarian") {
    if (run.result.kind === "knowledge_proposal") {
      return { source_id: run.result.source.id, topic: run.result.topic };
    }
    const topic = fallback.knowledgeTopic.trim();
    return fallback.knowledgeSourceId && topic ? { source_id: fallback.knowledgeSourceId, topic } : undefined;
  }
  if (run.result.kind === "semantic_edge_proposal") {
    return {
      from_shape_id: run.result.edge.from_shape_id,
      reason: run.result.edge.reason,
      relation: run.result.edge.relation,
      to_shape_id: run.result.edge.to_shape_id,
    };
  }
  const fromShapeId = fallback.selectedShapeIds[0];
  const reason = fallback.relationshipReason.trim();
  const toShapeId = fallback.selectedShapeIds[1];
  return fromShapeId && reason && toShapeId
    ? {
        from_shape_id: fromShapeId,
        reason,
        relation: fallback.relationshipType,
        to_shape_id: toShapeId,
      }
    : undefined;
}

function RelationshipProposal({
  applying,
  canApply,
  canReview,
  onApply,
  onClose,
  onReview,
  projectId,
  reviewingActionId,
  run,
  writeEnabled,
  workspaceSlug,
}: {
  applying: boolean;
  canApply: boolean;
  canReview: boolean;
  onApply: () => void;
  onClose: () => void;
  onReview: (actionId: string, decision: "approve" | "reject") => void;
  projectId: string;
  reviewingActionId?: string;
  run: TPpmAgentRun;
  writeEnabled: boolean;
  workspaceSlug: string;
}) {
  if (isAgentRunFailure(run.status)) {
    return (
      <section className="ppm-brain-panel__answer-state" data-tone="error">
        <X aria-hidden="true" />
        <strong>Не удалось подготовить связь</strong>
        <span>{run.error_message || "Проверьте выбранные объекты и попробуйте ещё раз."}</span>
      </section>
    );
  }
  const result = run.result;
  if (result.kind !== "semantic_edge_proposal") {
    return (
      <section className="ppm-brain-panel__answer-state" aria-live="polite">
        <LoaderCircle className="animate-spin" aria-hidden="true" />
        <strong>Проверяем связь…</strong>
        <span>Агент проверяет текущую доску, выбранные объекты и доступные источники.</span>
      </section>
    );
  }
  const action = run.actions.find((item) => item.id === result.action_id) ?? run.actions[0];
  const edge = result.edge;

  return (
    <section className="ppm-brain-panel__decomposition" aria-label="Черновик смысловой связи">
      <header>
        <div>
          <span data-status={action?.status}>{decompositionStatus(action?.status)}</span>
          <strong>Смысловая связь · {RELATION_LABELS[edge.relation]}</strong>
          <small>
            Доска: {result.board.name} · версия {result.board.version}
          </small>
        </div>
        <button type="button" onClick={onClose}>
          К источникам
        </button>
      </header>

      <div className="ppm-brain-panel__decomposition-warning">
        <ShieldCheck aria-hidden="true" />
        <span>
          Это предварительный просмотр. Принятие сохраняет решение, а связь добавляется только отдельной кнопкой.
        </span>
      </div>

      <article className="ppm-brain-panel__relationship-draft">
        <div>
          <span>От</span>
          <strong>{edge.from_title}</strong>
        </div>
        <Network aria-hidden="true" />
        <div>
          <span>К</span>
          <strong>{edge.to_title}</strong>
        </div>
        <p>{edge.reason}</p>
      </article>

      {action?.status === "proposed" ? (
        canReview ? (
          <footer>
            <button
              type="button"
              className="ppm-brain-panel__reject-action"
              disabled={reviewingActionId === action.id}
              onClick={() => onReview(action.id, "reject")}
            >
              <X aria-hidden="true" /> Отклонить
            </button>
            <button
              type="button"
              disabled={reviewingActionId === action.id}
              onClick={() => onReview(action.id, "approve")}
            >
              {reviewingActionId === action.id ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              Принять черновик
            </button>
          </footer>
        ) : (
          <div className="ppm-brain-panel__decomposition-note">Ожидает решения руководителя проекта.</div>
        )
      ) : (
        <div className="ppm-brain-panel__decomposition-note" data-status={action?.status}>
          {action?.status === "approved"
            ? "Связь принята и готова к добавлению на Холст."
            : action?.status === "applied"
              ? "Смысловая связь добавлена на доску."
              : action?.status === "conflict" || action?.status === "failed"
                ? action.error_message || "Не удалось добавить связь. Проверьте текущую версию доски."
                : action?.status === "cancelled"
                  ? "Запуск отменён. Холст не изменён."
                  : "Предложение отклонено. Холст не изменён."}
        </div>
      )}

      {action?.status === "approved" && (
        <div className="ppm-brain-panel__apply-actions">
          <div>
            <strong>Готово к добавлению: 1 смысловая связь</strong>
            <span>Перед записью PPM ещё раз проверит доску, выбранные объекты и версии источников.</span>
          </div>
          {canApply ? (
            <button type="button" disabled={applying} onClick={onApply}>
              {applying ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Network aria-hidden="true" />}
              Добавить связь на Холст
            </button>
          ) : (
            <small>
              {writeEnabled
                ? "Добавить связь может руководитель проекта или администратор."
                : "Применение предложений агента пока выключено администратором PPM."}
            </small>
          )}
        </div>
      )}

      {action?.status === "applied" && action.result.semantic_edges?.[0] && (
        <div className="ppm-brain-panel__created-items">
          <a href={action.result.semantic_edges[0].url}>
            <Network aria-hidden="true" />
            {edge.from_title} → {edge.to_title} · {RELATION_LABELS[edge.relation]}
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
      )}

      <AgentCitations citations={run.citations} projectId={projectId} workspaceSlug={workspaceSlug} />
    </section>
  );
}

function KnowledgeProposal({
  applying,
  canApply,
  canReview,
  onApply,
  onClose,
  onReview,
  projectId,
  reviewingActionId,
  run,
  writeEnabled,
  workspaceSlug,
}: {
  applying: boolean;
  canApply: boolean;
  canReview: boolean;
  onApply: () => void;
  onClose: () => void;
  onReview: (actionId: string, decision: "approve" | "reject") => void;
  projectId: string;
  reviewingActionId?: string;
  run: TPpmAgentRun;
  writeEnabled: boolean;
  workspaceSlug: string;
}) {
  if (isAgentRunFailure(run.status)) {
    return (
      <section className="ppm-brain-panel__answer-state" data-tone="error">
        <X aria-hidden="true" />
        <strong>Не удалось подготовить дополнение</strong>
        <span>{run.error_message || "Проверьте материал и попробуйте ещё раз."}</span>
      </section>
    );
  }
  const result = run.result;
  if (result.kind !== "knowledge_proposal") {
    return (
      <section className="ppm-brain-panel__answer-state" aria-live="polite">
        <LoaderCircle className="animate-spin" aria-hidden="true" />
        <strong>Готовим черновик знания…</strong>
        <span>Агент использует только выбранный Markdown текущего проекта.</span>
      </section>
    );
  }
  const action = run.actions.find((item) => item.id === result.action_id) ?? run.actions[0];

  return (
    <section className="ppm-brain-panel__decomposition" aria-label="Черновик дополнения в Хранилище">
      <header>
        <div>
          <span data-status={action?.status}>{decompositionStatus(action?.status)}</span>
          <strong>{result.title}</strong>
          <small>Основание: {result.source.path}</small>
        </div>
        <button type="button" onClick={onClose}>
          К источникам
        </button>
      </header>

      <div className="ppm-brain-panel__decomposition-warning">
        <ShieldCheck aria-hidden="true" />
        <span>
          Это предварительный просмотр. Принятие сохраняет решение, а файл создаётся только отдельной кнопкой.
        </span>
      </div>

      <article className="ppm-brain-panel__knowledge-draft">
        <header>
          <BookOpenCheck aria-hidden="true" />
          <span>Markdown-черновик</span>
        </header>
        <pre>{action?.payload.body || "Черновик недоступен."}</pre>
      </article>

      {action?.status === "proposed" ? (
        canReview ? (
          <footer>
            <button
              type="button"
              className="ppm-brain-panel__reject-action"
              disabled={reviewingActionId === action.id}
              onClick={() => onReview(action.id, "reject")}
            >
              <X aria-hidden="true" /> Отклонить
            </button>
            <button
              type="button"
              disabled={reviewingActionId === action.id}
              onClick={() => onReview(action.id, "approve")}
            >
              {reviewingActionId === action.id ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              Принять черновик
            </button>
          </footer>
        ) : (
          <div className="ppm-brain-panel__decomposition-note">Ожидает решения руководителя проекта.</div>
        )
      ) : (
        <div className="ppm-brain-panel__decomposition-note" data-status={action?.status}>
          {action?.status === "approved"
            ? "Черновик принят и готов к созданию в Хранилище."
            : action?.status === "applied"
              ? "Файл создан в Хранилище проекта."
              : action?.status === "conflict" || action?.status === "failed"
                ? action.error_message || "Не удалось создать файл. Проверьте Хранилище и источник."
                : action?.status === "cancelled"
                  ? "Запуск отменён. Хранилище не изменено."
                  : "Черновик отклонён. Хранилище не изменено."}
        </div>
      )}

      {action?.status === "approved" && (
        <div className="ppm-brain-panel__apply-actions">
          <div>
            <strong>Готово к созданию: 1 Markdown-файл</strong>
            <span>Будет создан новый материал. Существующие файлы и их версии не перезаписываются.</span>
          </div>
          {canApply ? (
            <button type="button" disabled={applying} onClick={onApply}>
              {applying ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              Создать файл в Хранилище
            </button>
          ) : (
            <small>
              {writeEnabled
                ? "Создать файл может руководитель проекта или администратор."
                : "Применение предложений агента пока выключено администратором PPM."}
            </small>
          )}
        </div>
      )}

      {action?.status === "applied" && action.result.vault_entries && action.result.vault_entries.length > 0 && (
        <div className="ppm-brain-panel__created-items">
          {action.result.vault_entries.map((entry) => (
            <a href={entry.url} key={entry.id}>
              <BookOpenCheck aria-hidden="true" />
              {entry.name} · версия {entry.version}
              <ExternalLink aria-hidden="true" />
            </a>
          ))}
        </div>
      )}

      <AgentCitations citations={run.citations} projectId={projectId} workspaceSlug={workspaceSlug} />
    </section>
  );
}

function WorkDecomposition({
  applying,
  canApply,
  canReview,
  onApply,
  onClose,
  onReviewBatch,
  projectId,
  reviewing,
  run,
  writeEnabled,
  workspaceSlug,
}: {
  applying: boolean;
  canApply: boolean;
  canReview: boolean;
  onApply: () => void;
  onClose: () => void;
  onReviewBatch: (decisions: TPpmAgentActionDecision[]) => void;
  projectId: string;
  reviewing: boolean;
  run: TPpmAgentRun;
  writeEnabled: boolean;
  workspaceSlug: string;
}) {
  const [decisions, setDecisions] = useState<Record<string, "approve" | "reject">>({});
  const actionStatusKey = run.actions.map((action) => `${action.id}:${action.status}`).join("|");
  useEffect(() => setDecisions({}), [actionStatusKey, run.id]);

  if (isAgentRunFailure(run.status)) {
    return (
      <section className="ppm-brain-panel__answer-state" data-tone="error">
        <X aria-hidden="true" />
        <strong>Не удалось подготовить декомпозицию</strong>
        <span>{run.error_message || "Проверьте источник и попробуйте ещё раз."}</span>
      </section>
    );
  }
  const result = run.result;
  if (result.kind !== "work_decomposition") {
    return (
      <section className="ppm-brain-panel__answer-state" aria-live="polite">
        <LoaderCircle className="animate-spin" aria-hidden="true" />
        <strong>Готовим черновик задач…</strong>
        <span>Агент использует только выбранный источник текущего проекта.</span>
      </section>
    );
  }
  const proposedActions = run.actions.filter((action) => action.status === "proposed");
  const approvedActions = run.actions.filter((action) => action.status === "approved");
  const selectedDecisions = proposedActions.flatMap((action) => {
    const decision = decisions[action.id];
    return decision ? [{ action_id: action.id, decision }] : [];
  });
  const reviewLabel = run.action_summary.remaining
    ? `${run.action_summary.reviewed} из ${run.action_summary.total} рассмотрено`
    : "Все действия рассмотрены";

  return (
    <section className="ppm-brain-panel__decomposition" aria-label="Черновик декомпозиции">
      <header>
        <div>
          <span data-status={run.action_summary.partial ? "partial" : undefined}>{reviewLabel}</span>
          <strong>{result.goal}</strong>
          <small>
            Основание: {result.source.identifier} · {result.source.title}
          </small>
        </div>
        <button type="button" onClick={onClose}>
          К источникам
        </button>
      </header>

      <div className="ppm-brain-panel__decomposition-warning">
        <ShieldCheck aria-hidden="true" />
        <span>
          Принятие сохраняет ваше решение, но не меняет проект. Реальные задачи создаются только отдельной кнопкой ниже.
        </span>
      </div>

      <div className="ppm-brain-panel__decomposition-items">
        {run.actions.map((action, index) => (
          <article data-status={action.status} key={action.id}>
            <span>{action.sequence + 1}</span>
            <div>
              <small data-status={action.status}>{decompositionStatus(action.status)}</small>
              {(action.payload.items ?? []).map((item) => (
                <div className="ppm-brain-panel__decomposition-item-copy" key={`${action.id}-${item.title}`}>
                  <strong>{item.title}</strong>
                  {item.description && <p>{item.description}</p>}
                  <h4>Критерии приёмки</h4>
                  <ul>
                    {item.acceptance_criteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {action.status === "applied" && action.result.issues && action.result.issues.length > 0 && (
                <div className="ppm-brain-panel__created-items">
                  {action.result.issues.map((issue) => (
                    <a href={issue.url} key={issue.id}>
                      <Check aria-hidden="true" />
                      {issue.identifier}: {issue.name}
                      <ExternalLink aria-hidden="true" />
                    </a>
                  ))}
                </div>
              )}
              {action.status === "proposed" && canReview && (
                <div className="ppm-brain-panel__batch-choice">
                  <button
                    type="button"
                    aria-label={`Отклонить действие ${index + 1}`}
                    data-decision="reject"
                    data-selected={decisions[action.id] === "reject"}
                    disabled={reviewing}
                    onClick={() => setDecisions((current) => ({ ...current, [action.id]: "reject" }))}
                  >
                    <X aria-hidden="true" /> Отклонить
                  </button>
                  <button
                    type="button"
                    aria-label={`Принять действие ${index + 1}`}
                    data-decision="approve"
                    data-selected={decisions[action.id] === "approve"}
                    disabled={reviewing}
                    onClick={() => setDecisions((current) => ({ ...current, [action.id]: "approve" }))}
                  >
                    <Check aria-hidden="true" /> Принять
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      {approvedActions.length > 0 && (
        <div className="ppm-brain-panel__apply-actions">
          <div>
            <strong>Готово к созданию: {approvedActions.length}</strong>
            <span>
              Будут созданы только принятые задачи. Отклонённые и оставленные без решения пункты не изменятся.
            </span>
          </div>
          {canApply ? (
            <button type="button" disabled={applying || reviewing} onClick={onApply}>
              {applying ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              Создать принятые задачи
            </button>
          ) : (
            <small>
              {writeEnabled
                ? "Создать задачи может руководитель проекта или администратор."
                : "Создание задач агентом пока выключено администратором PPM."}
            </small>
          )}
        </div>
      )}

      {proposedActions.length > 0 ? (
        canReview ? (
          <div className="ppm-brain-panel__batch-review">
            <div>
              <strong>Выбрано решений: {selectedDecisions.length}</strong>
              <span>
                Без решения останется {proposedActions.length - selectedDecisions.length}. Можно сохранить только часть
                решений и вернуться к остальным позже.
              </span>
            </div>
            <div>
              <button
                type="button"
                className="ppm-brain-panel__reject-action"
                disabled={reviewing}
                onClick={() =>
                  setDecisions((current) =>
                    Object.fromEntries(
                      proposedActions.map((action) => [action.id, current[action.id] ?? ("reject" as const)])
                    )
                  )
                }
              >
                Отклонить оставшиеся
              </button>
              <button
                type="button"
                className="ppm-brain-panel__secondary"
                disabled={reviewing}
                onClick={() =>
                  setDecisions((current) =>
                    Object.fromEntries(
                      proposedActions.map((action) => [action.id, current[action.id] ?? ("approve" as const)])
                    )
                  )
                }
              >
                Принять оставшиеся
              </button>
              <button
                type="button"
                disabled={reviewing || selectedDecisions.length === 0}
                onClick={() => onReviewBatch(selectedDecisions)}
              >
                {reviewing ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                Сохранить решения
              </button>
            </div>
          </div>
        ) : (
          <div className="ppm-brain-panel__decomposition-note">Ожидает решений руководителя проекта.</div>
        )
      ) : (
        <div
          className="ppm-brain-panel__decomposition-note"
          data-status={run.action_summary.cancelled ? "cancelled" : run.action_summary.partial ? "partial" : undefined}
        >
          {decompositionSummary(run)}
        </div>
      )}

      <AgentCitations citations={run.citations} projectId={projectId} workspaceSlug={workspaceSlug} />
    </section>
  );
}

function decompositionSummary(run: TPpmAgentRun) {
  const summary = run.action_summary;
  if (summary.cancelled === summary.total) return "Запуск отменён. Проект не изменён.";
  if (summary.applied > 0 && summary.rejected > 0) {
    return `Создано задач: ${summary.applied}. Отклонено предложений: ${summary.rejected}.`;
  }
  if (summary.applied === summary.total) return "Все принятые задачи созданы в текущем проекте.";
  if (summary.approved > 0 && summary.rejected > 0) {
    return `Частичное решение сохранено: принято ${summary.approved}, отклонено ${summary.rejected}.`;
  }
  if (summary.approved === summary.total) {
    return "Все черновики приняты и готовы к созданию.";
  }
  return "Все черновики отклонены. Проект не изменён.";
}

function decompositionStatus(status?: string) {
  if (status === "approved") return "Черновик принят";
  if (status === "applying") return "Создаём задачу";
  if (status === "applied") return "Задача создана";
  if (status === "conflict") return "Источник изменился";
  if (status === "failed") return "Ошибка создания";
  if (status === "rejected") return "Черновик отклонён";
  if (status === "cancelled") return "Запуск отменён";
  return "Ожидает решения";
}

function ProjectReport({
  onClose,
  projectId,
  run,
  workspaceSlug,
}: {
  onClose: () => void;
  projectId: string;
  run: TPpmAgentRun;
  workspaceSlug: string;
}) {
  if (isAgentRunFailure(run.status)) {
    return (
      <section className="ppm-brain-panel__answer-state" data-tone="error">
        <X aria-hidden="true" />
        <strong>Не удалось сформировать сводку</strong>
        <span>{run.error_message || "Попробуйте ещё раз."}</span>
      </section>
    );
  }
  if (run.status === "cancelled") {
    return (
      <section className="ppm-brain-panel__answer-state" aria-live="polite">
        <Square aria-hidden="true" />
        <strong>Сводка отменена</strong>
        <span>Задачи и Холст не изменялись. Запуск можно повторить.</span>
      </section>
    );
  }
  if (run.result.kind !== "project_report") {
    return (
      <section className="ppm-brain-panel__answer-state" aria-live="polite">
        <LoaderCircle className="animate-spin" aria-hidden="true" />
        <strong>Формируем сводку проекта…</strong>
        <span>Агент анализирует только доступные задачи текущего проекта.</span>
      </section>
    );
  }

  const report = run.result;
  return (
    <section className="ppm-brain-panel__report" aria-label="Сводка проекта">
      <header>
        <div>
          <span>Сводка проекта</span>
          <small>
            Только чтение ·{" "}
            {new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short" }).format(
              new Date(report.generated_at)
            )}
          </small>
        </div>
        <button type="button" onClick={onClose}>
          К источникам
        </button>
      </header>

      <div className="ppm-brain-panel__report-metrics">
        <ReportMetric label="Всего" value={report.metrics.issue_count} />
        <ReportMetric label="Завершено" tone="ready" value={report.metrics.completed_count} />
        <ReportMetric label="Просрочено" tone="danger" value={report.metrics.overdue_count} />
        <ReportMetric label="Риски" tone="warning" value={report.metrics.risk_count} />
      </div>

      <div className="ppm-brain-panel__report-copy">
        <h3>Текст сводки</h3>
        <p>{report.markdown}</p>
      </div>

      <div className="ppm-brain-panel__report-highlights">
        <h3>Важные задачи</h3>
        {report.highlights.length === 0 ? (
          <span>Открытых задач с высоким риском или просрочкой нет.</span>
        ) : (
          report.highlights.map((item) => (
            <a
              href={`/${encodeURIComponent(workspaceSlug)}/browse/${encodeURIComponent(item.identifier)}/`}
              key={item.id}
            >
              <div>
                <strong>{item.identifier}</strong>
                <span>{item.title}</span>
              </div>
              <small data-tone={item.overdue ? "danger" : "warning"}>
                {item.overdue ? "Просрочено" : priorityLabel(item.priority)}
              </small>
              <ExternalLink aria-hidden="true" />
            </a>
          ))
        )}
      </div>

      {report.uncited_highlight_count > 0 && (
        <div className="ppm-brain-panel__answer-warning">
          {report.uncited_highlight_count} важных задач пока без закреплённой версии в индексе. Обновите индекс, чтобы
          сводка получила все подтверждения.
        </div>
      )}

      <AgentCitations citations={run.citations} projectId={projectId} workspaceSlug={workspaceSlug} />
    </section>
  );
}

function ReportMetric({ label, tone, value }: { label: string; tone?: string; value: number }) {
  return (
    <div data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AgentCitations({
  citations,
  projectId,
  workspaceSlug,
}: {
  citations: TPpmAgentCitation[];
  projectId: string;
  workspaceSlug: string;
}) {
  const visibleCitationKeys = new Set<string>();
  const visibleCitations = citations.filter((citation) => {
    const key = `${citation.source_type}:${citation.source_id}:${citation.source_version}`;
    if (visibleCitationKeys.has(key)) return false;
    visibleCitationKeys.add(key);
    return true;
  });

  return (
    <div className="ppm-brain-panel__citations">
      <h3>Подтверждения</h3>
      {visibleCitations.length === 0 ? (
        <span>Для важных задач пока нет актуальных источников в индексе.</span>
      ) : (
        visibleCitations.map((citation, index) => (
          <a
            href={agentCitationHref(citation, workspaceSlug, projectId)}
            key={`${citation.source_id}-${citation.ordinal}`}
          >
            <span>{index + 1}</span>
            <div>
              <strong>{citation.title}</strong>
              <small>
                {formatLocator(citation.locator)} · версия {citation.source_version.slice(0, 12)}
              </small>
            </div>
            <ExternalLink aria-hidden="true" />
          </a>
        ))
      )}
    </div>
  );
}

function AnswerResult({
  canSave,
  memorySaved,
  onSave,
  onSaveMemory,
  run,
  saved,
}: {
  canSave: boolean;
  memorySaved: boolean;
  onSave: () => void;
  onSaveMemory: (kind: TPpmProjectMemoryKind) => void;
  run: TPpmBrainAnswerRun;
  saved: boolean;
}) {
  const [memoryKind, setMemoryKind] = useState<TPpmProjectMemoryKind>("decision");
  const running = !isTerminalAnswerStatus(run.status);
  if (running) {
    return (
      <section className="ppm-brain-panel__answer-state" aria-live="polite">
        <LoaderCircle className="animate-spin" aria-hidden="true" />
        <strong>{run.status === "completing" ? "Формируем ответ…" : "Собираем подтверждения…"}</strong>
        <span>Источники проверяются внутри текущего проекта.</span>
      </section>
    );
  }
  if (run.status === "cancelled") {
    return (
      <section className="ppm-brain-panel__answer-state">
        <Square aria-hidden="true" />
        <strong>Запрос остановлен</strong>
        <span>Никакие задачи и материалы не изменены.</span>
      </section>
    );
  }
  if (run.status === "failed") {
    return (
      <section className="ppm-brain-panel__answer-state" data-tone="error">
        <X aria-hidden="true" />
        <strong>Не удалось подготовить ответ</strong>
        <span>{run.error?.message ?? "Попробуйте ещё раз."}</span>
      </section>
    );
  }
  return (
    <section className="ppm-brain-panel__answer" aria-label="Ответ Мозга проекта">
      <header>
        <div>
          <span data-status={run.status}>
            {run.status === "completed"
              ? "Ответ по источникам"
              : run.status === "no_sources"
                ? "Нет данных"
                : "Сводка по источникам"}
          </span>
          <small>
            {run.scope.mode === "selection"
              ? `Выбранный контекст · ${formatSourceCount(run.scope.available_sources ?? 0)} · глубина ${run.scope.graph?.applied_depth ?? 0}`
              : "Весь проект"}
          </small>
        </div>
        {canSave && (
          <div className="ppm-brain-panel__answer-actions">
            <button type="button" disabled={saved || !run.answer} onClick={onSave}>
              <Save aria-hidden="true" />
              {saved ? "Добавлено" : "На холст"}
            </button>
            <select
              aria-label="Тип записи памяти"
              disabled={memorySaved}
              value={memoryKind}
              onChange={(event) => setMemoryKind(event.currentTarget.value as TPpmProjectMemoryKind)}
            >
              <option value="decision">Решение</option>
              <option value="daily_summary">Дневная сводка</option>
              <option value="weekly_summary">Недельная сводка</option>
              <option value="release_summary">Релизная сводка</option>
            </select>
            <button
              type="button"
              disabled={memorySaved || !run.answer || run.citations.length === 0}
              onClick={() => onSaveMemory(memoryKind)}
            >
              <BrainCircuit aria-hidden="true" />
              {memorySaved ? "В памяти" : "В память"}
            </button>
          </div>
        )}
      </header>
      <p>{run.answer}</p>
      {run.error?.message && run.status === "degraded" && (
        <div className="ppm-brain-panel__answer-warning">{run.error.message}</div>
      )}
      <div className="ppm-brain-panel__citations">
        <h3>Источники</h3>
        {run.citations.length === 0 ? (
          <span>Проверенных источников для этого ответа нет.</span>
        ) : (
          run.citations.map((citation, index) => (
            <a href={citation.source_url} key={citation.citation_id}>
              <span>{index + 1}</span>
              <div>
                <strong>{citation.title}</strong>
                <small>{formatLocator(citation.locator)}</small>
                {citation.graph_path?.length > 0 && <small>{citation.graph_explanation}</small>}
              </div>
              <ExternalLink aria-hidden="true" />
            </a>
          ))
        )}
      </div>
    </section>
  );
}

function SearchResults({
  canSave,
  onSave,
  projectId,
  results,
  saved,
  workspaceSlug,
}: {
  canSave: boolean;
  onSave: () => void;
  projectId: string;
  results: TPpmBrainResult[];
  saved: boolean;
  workspaceSlug: string;
}) {
  return (
    <section className="ppm-brain-panel__results" aria-label="Результаты поиска">
      <div className="ppm-brain-panel__section-title">
        <div>
          <h3>Найденные источники</h3>
          <span>{formatSourceCount(results.length)} в снимке поиска</span>
        </div>
        {canSave && (
          <button type="button" disabled={saved} onClick={onSave}>
            <Save aria-hidden="true" />
            {saved ? "Добавлено на холст" : "Сохранить на холст"}
          </button>
        )}
      </div>
      {results.map((result) => (
        <article key={result.chunk_id}>
          <div>
            <span>{SOURCE_LABELS[result.source_type]}</span>
            <strong>{result.title}</strong>
          </div>
          <p>{result.excerpt}</p>
          {result.graph_path && result.graph_path.length > 0 && (
            <small>Поднято смысловой связью · {formatGraphPath(result.graph_path)}</small>
          )}
          <footer>
            <small>{formatLocator(result.locator)}</small>
            <a href={sourceHref(result, workspaceSlug, projectId)}>
              Открыть источник
              <ExternalLink aria-hidden="true" />
            </a>
          </footer>
        </article>
      ))}
    </section>
  );
}

function SourceList({
  canEdit,
  onReindex,
  reindexing,
  sources,
}: {
  canEdit: boolean;
  onReindex: () => void;
  reindexing: boolean;
  sources: TPpmBrainSource[];
}) {
  const activeSources = sources.filter((source) => !["deleted", "excluded"].includes(source.index_state));
  const visibleSources = activeSources.slice(0, 100);
  return (
    <section className="ppm-brain-panel__sources" aria-label="Источники проекта">
      <div className="ppm-brain-panel__section-title">
        <div>
          <h3>Источники</h3>
          <span>{activeSources.length} активных в этом проекте</span>
        </div>
        {canEdit && (
          <button type="button" disabled={reindexing} onClick={onReindex}>
            <RefreshCcw className={reindexing ? "animate-spin" : undefined} aria-hidden="true" />
            Обновить индекс
          </button>
        )}
      </div>
      {activeSources.length === 0 ? (
        <div className="ppm-brain-panel__empty">
          <FileText aria-hidden="true" />
          <strong>Индекс пока пуст</strong>
          <span>Добавьте задачи или материалы в Хранилище, затем обновите индекс.</span>
        </div>
      ) : (
        <>
          {visibleSources.map((source) => (
            <article key={source.id}>
              <span className="ppm-brain-panel__source-kind">{SOURCE_LABELS[source.source_type]}</span>
              <div>
                <strong>{source.title || "Источник без названия"}</strong>
                {source.error_message && <small>{source.error_message}</small>}
              </div>
              <span className="ppm-brain-panel__source-state" data-state={source.index_state}>
                {STATE_LABELS[source.index_state]}
              </span>
            </article>
          ))}
          {activeSources.length > visibleSources.length && (
            <div className="ppm-brain-panel__source-limit">
              Показаны первые {visibleSources.length} источников из {activeSources.length}. Используйте поиск, чтобы
              найти материал по содержанию.
            </div>
          )}
        </>
      )}
    </section>
  );
}

const MEMORY_KIND_LABELS: Record<TPpmProjectMemoryKind, string> = {
  decision: "Решение",
  daily_summary: "Дневная сводка",
  weekly_summary: "Недельная сводка",
  release_summary: "Релизная сводка",
};

function MemoryList({
  canEdit,
  onReview,
  records,
}: {
  canEdit: boolean;
  onReview: (recordId: string, status: "confirmed" | "rejected") => void;
  records: TPpmProjectMemoryRecord[];
}) {
  return (
    <section className="ppm-brain-panel__memory" aria-label="Память проекта">
      <div className="ppm-brain-panel__section-title">
        <div>
          <h3>Память проекта</h3>
          <span>Решения и сводки со снимком версий источников</span>
        </div>
      </div>
      {records.length === 0 ? (
        <div className="ppm-brain-panel__empty">
          <BrainCircuit aria-hidden="true" />
          <strong>Память пока пуста</strong>
          <span>Получите ответ по источникам и сохраните его как решение или сводку.</span>
        </div>
      ) : (
        records.map((record) => (
          <article key={record.id} data-status={record.confirmation_status}>
            <header>
              <span>{MEMORY_KIND_LABELS[record.kind]}</span>
              {record.freshness_status === "possibly_stale" ? (
                <small data-tone="warning">
                  <AlertTriangle aria-hidden="true" /> Возможно устарело
                </small>
              ) : (
                <small>
                  <Check aria-hidden="true" /> Источники актуальны
                </small>
              )}
            </header>
            <strong>{record.title}</strong>
            <p>{record.body}</p>
            <footer>
              <span>{formatSourceCount(record.source_references.length)}</span>
              {record.confirmation_status === "proposed" && canEdit && (
                <div>
                  <button type="button" onClick={() => onReview(record.id, "confirmed")}>
                    Подтвердить
                  </button>
                  <button type="button" onClick={() => onReview(record.id, "rejected")}>
                    Отклонить
                  </button>
                </div>
              )}
              {record.confirmation_status === "rejected" && <small>Отклонено</small>}
            </footer>
          </article>
        ))
      )}
    </section>
  );
}

function StatusCard({ label, tone, value }: { label: string; tone: string; value: number }) {
  return (
    <div data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatLocator(locator: Record<string, string | number>) {
  if (locator.identifier) return `Задача ${locator.identifier}`;
  if (locator.page) return `${locator.path ?? "PDF"}, страница ${locator.page}`;
  if (locator.kind === "git_code" && locator.path) {
    const lines = locator.line_start
      ? `, строки ${locator.line_start}${locator.line_end ? `–${locator.line_end}` : ""}`
      : "";
    const commit = locator.commit_sha ? ` · ${String(locator.commit_sha).slice(0, 12)}` : "";
    return `${locator.path}${lines}${commit}`;
  }
  if (locator.path) return String(locator.path);
  return "Источник проекта";
}

function formatGraphPath(path: NonNullable<TPpmBrainResult["graph_path"]>) {
  return path.map((step) => step.relation_type).join(" → ");
}

function memoryTitle(kind: TPpmProjectMemoryKind, query: string) {
  const prefix = MEMORY_KIND_LABELS[kind];
  const normalized = query.trim();
  return `${prefix}: ${normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized}`;
}

function sourceHref(result: TPpmBrainResult, workspaceSlug: string, projectId: string) {
  if (result.source_type === "work_item" && result.locator.identifier) {
    return `/${encodeURIComponent(workspaceSlug)}/browse/${encodeURIComponent(String(result.locator.identifier))}/`;
  }
  if (result.source_type === "git_code" && result.locator.canonical_url) {
    return String(result.locator.canonical_url);
  }
  return `/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/knowledge?entry_id=${encodeURIComponent(result.source_id)}`;
}

function agentCitationHref(citation: TPpmAgentCitation, workspaceSlug: string, projectId: string) {
  if (citation.source_type === "work_item" && citation.locator.identifier) {
    return `/${encodeURIComponent(workspaceSlug)}/browse/${encodeURIComponent(String(citation.locator.identifier))}/`;
  }
  if (citation.source_type === "git_code" && citation.locator.canonical_url) {
    return String(citation.locator.canonical_url);
  }
  return `/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}/knowledge?entry_id=${encodeURIComponent(citation.source_id)}`;
}

function priorityLabel(priority: "urgent" | "high" | "medium" | "low" | "none") {
  return {
    urgent: "Срочный риск",
    high: "Высокий риск",
    medium: "Средний приоритет",
    low: "Низкий приоритет",
    none: "Без приоритета",
  }[priority];
}

function brainErrorMessage(reason: unknown) {
  return reason instanceof PpmBrainServiceError ? reason.message : "Не удалось обратиться к Мозгу проекта.";
}
