import { describe, expect, it } from "vitest";
import {
  createPpmCanvasNode,
  createPpmAgentAnswerNode,
  createPpmAgentQueryNode,
  createPpmCanvasBoardExport,
  createPpmContentRefNode,
  createPpmGitRefNode,
  createPpmOrchestratorNode,
  createPpmOrchestratorCallNode,
  createPpmOrchestratorProjectionConnections,
  createPpmOrchestratorTaskNode,
  createPpmSearchNode,
  duplicatePpmCanvasNode,
  createPpmWorkItemRefNode,
  createPpmVaultFileRefNode,
  getPpmCanvasPersistenceKey,
  isPpmAntyFlowShellEnabled,
  isPpmCanvasEnabled,
  isPpmMermaidSourceSafe,
  isPpmProjectAskEnabled,
  isSamePpmOrchestratorProjection,
  mergePpmOrchestratorNode,
  mergePpmOrchestratorTrace,
  parseAndMigratePpmCanvasNode,
  parsePpmCanvasBoardExport,
  parseSerializedPpmCanvasNode,
  PPM_CANVAS_NODE_REGISTRY,
  ppmCanvasErrorResponseSchema,
  ppmCanvasBindingMutationResponseSchema,
  ppmCanvasBoardsResponseSchema,
  ppmCanvasBoardVersionResponseSchema,
  ppmCanvasReadResponseSchema,
  ppmCanvasSaveResponseSchema,
  ppmCanvasSemanticEdgesResponseSchema,
  updatePpmCanvasNode,
} from "../index";

const NOW = "2026-09-13T00:00:00.000Z";
const ANSWER_RUN_ID = "9ccca22c-1f55-4aed-873a-cf9a2f48ce07";
const ANSWER_SERVICE_RUN = {
  run_id: ANSWER_RUN_ID,
  kind: "answer" as const,
  status: "degraded" as const,
  provider: "local",
  model: "deterministic-v1",
  policy_version: "ppm-brain-answer-v1",
  created_at: NOW,
  started_at: NOW,
  finished_at: NOW,
  updated_at: NOW,
};

describe("PPM Canvas node schema", () => {
  it("creates a versioned note with browser-safe data", () => {
    const note = createPpmCanvasNode({ authorId: "user-1", kind: "note", now: NOW, title: "Новая заметка" });

    expect(note).toMatchObject({
      schema_version: 2,
      kind: "note",
      title: "Новая заметка",
      author_id: "user-1",
      created_at: NOW,
      updated_at: NOW,
      visual: {
        color: PPM_CANVAS_NODE_REGISTRY.note.defaultColor,
        height: PPM_CANVAS_NODE_REGISTRY.note.defaultHeight,
        width: PPM_CANVAS_NODE_REGISTRY.note.defaultWidth,
      },
    });
  });

  it("creates auditable project question and grounded answer nodes", () => {
    const runId = ANSWER_RUN_ID;
    const query = createPpmAgentQueryNode({
      authorId: "user-1",
      now: NOW,
      query: "Что блокирует испытания?",
      runId,
      runStatus: "degraded",
      selectedShapeIds: ["shape:task"],
      serviceRun: ANSWER_SERVICE_RUN,
      title: "Вопрос проекту",
    });
    const answer = createPpmAgentAnswerNode({
      authorId: "user-1",
      body: "Протокол пока не приложен.",
      citations: [
        {
          citation_id: "chunk-1",
          source_id: "issue-1",
          source_type: "work_item",
          source_url: "/demo/browse/DEMO-1/",
          title: "Проверить испытания",
        },
        {
          citation_id: "chunk-2",
          source_id: "code-1",
          source_type: "git_code",
          source_url: "https://github.com/ppm/ppm/blob/aaaaaaaa/src/app.py#L1-L10",
          title: "ppm:src/app.py",
        },
      ],
      now: NOW,
      runId,
      runStatus: "degraded",
      serviceRun: ANSWER_SERVICE_RUN,
      title: "Ответ Мозга проекта",
    });

    expect(query).toMatchObject({
      kind: "agent_query",
      run_id: runId,
      selected_shape_ids: ["shape:task"],
      service_run: ANSWER_SERVICE_RUN,
    });
    expect(answer).toMatchObject({
      kind: "agent_answer",
      run_id: runId,
      citations: [{ citation_id: "chunk-1" }, { citation_id: "chunk-2", source_type: "git_code" }],
      service_run: ANSWER_SERVICE_RUN,
    });
    expect(parseAndMigratePpmCanvasNode(answer)).toMatchObject({ status: "valid" });
    expect(parseAndMigratePpmCanvasNode({ ...answer, service_run: undefined })).toMatchObject({ status: "valid" });
  });

  it("creates a browser-safe project search snapshot with versioned sources", () => {
    const node = createPpmSearchNode({
      authorId: "user-1",
      degraded: false,
      graphDepth: 1,
      now: NOW,
      query: "Какие решения относятся к Git?",
      results: [
        {
          excerpt: "Выбран двухэтапный Git flow.",
          locator: { heading: "Git" },
          result_id: "chunk-1",
          score: 0.87,
          source_id: "source-1",
          source_type: "vault_file",
          source_url: "/demo/projects/project-1/knowledge/source-1",
          source_version: "3",
          title: "Решение по Git",
        },
      ],
      retrievalMode: "hybrid",
      selectedShapeIds: ["shape:decision"],
      serviceRun: {
        run_id: "108d95d6-c1b5-4f06-a855-aa7013070ab5",
        kind: "search",
        status: "completed",
        provider: null,
        model: null,
        policy_version: "ppm-brain-search-v1",
        created_at: NOW,
        started_at: NOW,
        finished_at: NOW,
        updated_at: NOW,
      },
      title: "Поиск по проекту",
    });

    expect(node).toMatchObject({
      kind: "search",
      retrieval_mode: "hybrid",
      selected_shape_ids: ["shape:decision"],
      results: [{ result_id: "chunk-1", source_version: "3" }],
      service_run: { kind: "search", policy_version: "ppm-brain-search-v1", status: "completed" },
    });
    expect(node).not.toHaveProperty("token");
    expect(node).not.toHaveProperty("credentials");
    expect(parseAndMigratePpmCanvasNode(node)).toMatchObject({ status: "valid" });
  });

  it("validates service-run lifecycle and strips unknown secret fields", () => {
    const serviceRun = {
      run_id: "108d95d6-c1b5-4f06-a855-aa7013070ab5",
      kind: "search" as const,
      status: "no_sources" as const,
      provider: null,
      model: null,
      policy_version: "ppm-brain-search-v1",
      created_at: NOW,
      started_at: NOW,
      finished_at: NOW,
      updated_at: NOW,
      token: "DO_NOT_PERSIST",
    };
    const node = createPpmSearchNode({
      authorId: "user-1",
      degraded: false,
      graphDepth: 0,
      now: NOW,
      query: "Нет результата",
      results: [],
      retrievalMode: "keyword",
      selectedShapeIds: [],
      serviceRun,
      title: "Поиск по проекту",
    });

    expect(node.service_run).not.toHaveProperty("token");
    expect(() =>
      createPpmSearchNode({
        authorId: "user-1",
        degraded: false,
        graphDepth: 0,
        now: NOW,
        query: "Несогласованный результат",
        results: [],
        retrievalMode: "keyword",
        selectedShapeIds: [],
        serviceRun: { ...serviceRun, status: "completed" },
        title: "Поиск по проекту",
      })
    ).toThrow("Search snapshot status must match its result state.");
    expect(() =>
      createPpmSearchNode({
        authorId: "user-1",
        degraded: false,
        graphDepth: 0,
        now: NOW,
        query: "Неверное время",
        results: [],
        retrievalMode: "keyword",
        selectedShapeIds: [],
        serviceRun: { ...serviceRun, updated_at: "2026-09-12T23:59:59.000Z" },
        title: "Поиск по проекту",
      })
    ).toThrow();
  });

  it("creates an auditable orchestrator run snapshot without provider secrets", () => {
    const runId = "9ccca22c-1f55-4aed-873a-cf9a2f48ce07";
    const node = createPpmOrchestratorNode({
      actionSummary: {
        applied: 0,
        applying: 0,
        approved: 1,
        cancelled: 0,
        canonical_changes_applied: false,
        conflict: 0,
        failed: 0,
        partial: true,
        rejected: 0,
        remaining: 1,
        review_complete: false,
        reviewed: 1,
        total: 2,
      },
      actions: [
        {
          action_id: "ef2f471d-9c3d-43e0-9400-ce91f1051d55",
          action_kind: "create_work_items",
          canonical_changes_applied: false,
          status: "approved",
          summary: "Подготовить проверяемый web-срез.",
          title: "Новая задача",
        },
      ],
      agentKind: "work_decomposer",
      authorId: "user-1",
      citations: [
        {
          citation_id: "run-citation-1",
          locator: { identifier: "DEMO-1" },
          source_id: "issue-1",
          source_type: "work_item",
          source_url: "/demo/browse/DEMO-1/",
          source_version: "2026-09-21T12:00:00Z",
          title: "Исходная задача",
        },
      ],
      model: "deterministic-v1",
      now: NOW,
      policyVersion: "ppm-agents-v1",
      provider: "local",
      runCreatedAt: NOW,
      runFinishedAt: null,
      runId,
      runStatus: "awaiting_approval",
      runUpdatedAt: "2026-09-13T00:05:00.000Z",
      selectedShapeIds: ["shape:task"],
      summary: "Предложено 2 задачи, рассмотрена 1.",
      title: "Декомпозиция работы",
    });

    expect(node).toMatchObject({
      kind: "orchestrator",
      run_id: runId,
      agent_kind: "work_decomposer",
      run_status: "awaiting_approval",
      service_run: {
        kind: "orchestrator",
        status: "awaiting_approval",
        policy_version: "ppm-agents-v1",
      },
      action_summary: { total: 2, reviewed: 1, remaining: 1 },
      actions: [{ status: "approved" }],
      trace: [
        { kind: "run_created", status: "queued" },
        { kind: "action_status", status: "approved" },
        { kind: "run_status", status: "awaiting_approval" },
      ],
    });
    expect(node).not.toHaveProperty("token");
    expect(node).not.toHaveProperty("credentials");
    expect(node).not.toHaveProperty("prompt");
    expect(parseAndMigratePpmCanvasNode(node)).toMatchObject({ status: "valid" });
  });

  it("updates one orchestrator snapshot idempotently and retains its observed trace", () => {
    const runId = "9ccca22c-1f55-4aed-873a-cf9a2f48ce07";
    const actionId = "ef2f471d-9c3d-43e0-9400-ce91f1051d55";
    const actionSummary = {
      applied: 0,
      applying: 0,
      approved: 0,
      cancelled: 0,
      canonical_changes_applied: false,
      conflict: 0,
      failed: 0,
      partial: false,
      rejected: 0,
      remaining: 1,
      review_complete: false,
      reviewed: 0,
      total: 1,
    };
    const initial = createPpmOrchestratorNode({
      actionSummary,
      actions: [
        {
          action_id: actionId,
          action_kind: "create_work_items",
          canonical_changes_applied: false,
          status: "proposed",
          summary: "Подготовить проверяемый web-срез.",
          title: "Новая задача",
        },
      ],
      agentKind: "work_decomposer",
      authorId: "user-1",
      citations: [],
      model: "deterministic-v1",
      now: NOW,
      policyVersion: "ppm-agents-v1",
      provider: "local",
      runCreatedAt: NOW,
      runFinishedAt: null,
      runId,
      runStatus: "awaiting_approval",
      runUpdatedAt: "2026-09-13T00:05:00.000Z",
      selectedShapeIds: ["shape:task"],
      summary: "Подготовлено одно предложение.",
      title: "Декомпозиция работы",
    });
    const applied = createPpmOrchestratorNode({
      actionSummary: {
        ...actionSummary,
        applied: 1,
        canonical_changes_applied: true,
        remaining: 0,
        review_complete: true,
        reviewed: 1,
      },
      actions: [
        {
          action_id: actionId,
          action_kind: "create_work_items",
          canonical_changes_applied: true,
          result_url: "/demo/browse/DEMO-2/",
          status: "applied",
          summary: "Подготовить проверяемый web-срез.",
          title: "Новая задача",
        },
      ],
      agentKind: "work_decomposer",
      authorId: "user-2",
      citations: [],
      model: "deterministic-v1",
      now: "2026-09-13T00:10:00.000Z",
      policyVersion: "ppm-agents-v1",
      provider: "local",
      runCreatedAt: NOW,
      runFinishedAt: "2026-09-13T00:10:00.000Z",
      runId,
      runStatus: "completed",
      runUpdatedAt: "2026-09-13T00:10:00.000Z",
      selectedShapeIds: ["shape:task"],
      summary: "Создана одна задача.",
      title: "Декомпозиция работы",
    });

    const merged = mergePpmOrchestratorNode(initial, applied, "2026-09-13T00:11:00.000Z");

    expect(merged).toMatchObject({
      author_id: "user-1",
      created_at: NOW,
      updated_at: "2026-09-13T00:11:00.000Z",
      run_status: "completed",
      run_updated_at: "2026-09-13T00:10:00.000Z",
      actions: [{ canonical_changes_applied: true, status: "applied" }],
    });
    expect(merged.trace.map((item) => item.trace_id)).toEqual([
      `run:${runId}:created`,
      `action:${actionId}:status:proposed`,
      `run:${runId}:status:awaiting_approval`,
      `action:${actionId}:status:applied`,
      `run:${runId}:status:completed`,
    ]);
    expect(mergePpmOrchestratorNode(merged, applied, "2026-09-13T00:12:00.000Z")).toBe(merged);
    expect(mergePpmOrchestratorNode(merged, initial, "2026-09-13T00:12:00.000Z")).toBe(merged);
  });

  it("prefers server audit timestamps when creating an orchestrator trace", () => {
    const runId = "0ffcb7d4-35ef-4878-819d-87ecbe072223";
    const actionId = "d2975458-b265-4807-a445-013cadfa9678";
    const serverTrace = [
      {
        trace_id: `run:${runId}:created`,
        kind: "run_created" as const,
        status: "queued" as const,
        occurred_at: "2026-09-13T00:00:01.000Z",
      },
      {
        trace_id: `action:${actionId}:status:proposed`,
        kind: "action_status" as const,
        status: "proposed" as const,
        occurred_at: "2026-09-13T00:00:02.000Z",
        action_id: actionId,
        action_title: "Проверяемое предложение",
      },
    ];
    const observedTrace = [
      {
        ...serverTrace[0],
        occurred_at: "2026-09-13T00:05:00.000Z",
      },
    ];

    expect(mergePpmOrchestratorTrace(observedTrace, serverTrace)).toEqual(serverTrace);

    const node = createPpmOrchestratorNode({
      actionSummary: {
        applied: 0,
        applying: 0,
        approved: 0,
        cancelled: 0,
        canonical_changes_applied: false,
        conflict: 0,
        failed: 0,
        partial: false,
        rejected: 0,
        remaining: 1,
        review_complete: false,
        reviewed: 0,
        total: 1,
      },
      actions: [
        {
          action_id: actionId,
          action_kind: "create_work_items",
          canonical_changes_applied: false,
          status: "proposed",
          summary: "Проверить безопасную хронологию.",
          title: "Проверяемое предложение",
        },
      ],
      agentKind: "work_decomposer",
      authorId: "user-1",
      citations: [],
      model: "deterministic-v1",
      now: "2026-09-13T00:05:00.000Z",
      policyVersion: "ppm-agents-v1",
      provider: "local",
      runCreatedAt: NOW,
      runFinishedAt: null,
      runId,
      runStatus: "awaiting_approval",
      runUpdatedAt: "2026-09-13T00:05:00.000Z",
      selectedShapeIds: [],
      summary: "Подготовлено одно предложение.",
      title: "Декомпозиция работы",
      trace: serverTrace,
    });

    expect(node.trace.find((item) => item.trace_id === `run:${runId}:created`)?.occurred_at).toBe(
      "2026-09-13T00:00:01.000Z"
    );
    expect(node.trace.filter((item) => item.trace_id === `action:${actionId}:status:proposed`)).toHaveLength(1);
  });

  it("creates safe orchestrator task and call projections", () => {
    const runId = "0ffcb7d4-35ef-4878-819d-87ecbe072223";
    const actionId = "d2975458-b265-4807-a445-013cadfa9678";
    const action = {
      action_id: actionId,
      action_kind: "create_work_items" as const,
      canonical_changes_applied: false,
      status: "rejected" as const,
      summary: "Проверить безопасную проекцию.",
      title: "Проверяемое предложение",
    };
    const trace = {
      trace_id: `action:${actionId}:status:rejected`,
      kind: "action_status" as const,
      status: "rejected" as const,
      occurred_at: "2026-09-13T00:07:00.000Z",
      action_id: actionId,
      action_title: action.title,
    };

    const task = createPpmOrchestratorTaskNode({ action, authorId: "user-1", now: NOW, runId });
    const call = createPpmOrchestratorCallNode({ action, authorId: "user-1", now: NOW, runId, trace });

    expect(task).toMatchObject({
      kind: "orchtask",
      run_id: runId,
      action_id: actionId,
      status: "rejected",
    });
    expect(call).toMatchObject({
      kind: "orchcall",
      run_id: runId,
      action_id: actionId,
      trace_id: trace.trace_id,
      occurred_at: trace.occurred_at,
    });
    expect(JSON.stringify([task, call])).not.toContain("prompt");
    expect(JSON.stringify([task, call])).not.toContain("metadata");
  });

  it("builds a stable orchestrator-to-task-to-call connection chain", () => {
    const runId = "0ffcb7d4-35ef-4878-819d-87ecbe072223";
    const firstActionId = "d2975458-b265-4807-a445-013cadfa9678";
    const secondActionId = "0e41a52e-385f-4ddc-ab21-d4b185d36bc7";
    const node = createPpmOrchestratorNode({
      actionSummary: {
        applied: 0,
        applying: 0,
        approved: 0,
        cancelled: 0,
        canonical_changes_applied: false,
        conflict: 0,
        failed: 0,
        partial: false,
        rejected: 1,
        remaining: 1,
        review_complete: false,
        reviewed: 1,
        total: 2,
      },
      actions: [
        {
          action_id: firstActionId,
          action_kind: "create_work_items",
          canonical_changes_applied: false,
          status: "rejected",
          summary: "Первое действие",
          title: "Первое действие",
        },
        {
          action_id: secondActionId,
          action_kind: "write_vault_file",
          canonical_changes_applied: false,
          status: "proposed",
          summary: "Второе действие",
          title: "Второе действие",
        },
      ],
      agentKind: "work_decomposer",
      authorId: "user-1",
      citations: [],
      model: "deterministic-v1",
      now: NOW,
      policyVersion: "ppm-agents-v1",
      provider: "local",
      runCreatedAt: NOW,
      runFinishedAt: null,
      runId,
      runStatus: "awaiting_approval",
      runUpdatedAt: "2026-09-13T00:07:00.000Z",
      selectedShapeIds: [],
      summary: "Два предложения",
      title: "Декомпозиция работы",
      trace: [
        {
          action_id: firstActionId,
          action_title: "Первое действие",
          kind: "action_status",
          occurred_at: "2026-09-13T00:05:00.000Z",
          status: "proposed",
          trace_id: `action:${firstActionId}:status:proposed`,
        },
        {
          action_id: firstActionId,
          action_title: "Первое действие",
          kind: "action_status",
          occurred_at: "2026-09-13T00:06:00.000Z",
          status: "rejected",
          trace_id: `action:${firstActionId}:status:rejected`,
        },
        {
          action_id: secondActionId,
          action_title: "Второе действие",
          kind: "action_status",
          occurred_at: "2026-09-13T00:07:00.000Z",
          status: "proposed",
          trace_id: `action:${secondActionId}:status:proposed`,
        },
      ],
    });

    const connections = createPpmOrchestratorProjectionConnections(node);

    expect(connections).toHaveLength(5);
    expect(connections.map((connection) => [connection.from.kind, connection.to.kind])).toEqual([
      ["orchestrator", "orchtask"],
      ["orchtask", "orchcall"],
      ["orchcall", "orchcall"],
      ["orchestrator", "orchtask"],
      ["orchtask", "orchcall"],
    ]);
    expect(new Set(connections.map((connection) => connection.connection_id))).toHaveProperty("size", 5);
    expect(JSON.stringify(connections)).not.toContain("summary");
  });

  it("projects real read-only tool telemetry as a run call chain", () => {
    const runId = "7f335c4f-b0ca-43db-83ef-85a620d776c0";
    const firstToolTrace = {
      kind: "tool_call" as const,
      occurred_at: "2026-09-13T00:01:00.000Z",
      result_count: 6,
      status: "completed" as const,
      summary: "Получено результатов: 6",
      title: "Чтение списка задач",
      tool_mode: "read" as const,
      tool_name: "list_work_items",
      trace_id: "tool:event-1",
    };
    const secondToolTrace = {
      kind: "tool_call" as const,
      occurred_at: "2026-09-13T00:02:00.000Z",
      result_count: 1,
      status: "completed" as const,
      summary: "Получено результатов: 1",
      title: "Чтение задачи",
      tool_mode: "read" as const,
      tool_name: "read_work_item",
      trace_id: "tool:event-2",
    };
    const node = createPpmOrchestratorNode({
      actionSummary: {
        applied: 0,
        applying: 0,
        approved: 0,
        cancelled: 0,
        canonical_changes_applied: false,
        conflict: 0,
        failed: 0,
        partial: false,
        rejected: 0,
        remaining: 0,
        review_complete: true,
        reviewed: 0,
        total: 0,
      },
      actions: [],
      agentKind: "project_reporter",
      authorId: "user-1",
      citations: [],
      model: "deterministic-v1",
      now: NOW,
      policyVersion: "ppm-agents-v1",
      provider: "local",
      runCreatedAt: NOW,
      runFinishedAt: "2026-09-13T00:03:00.000Z",
      runId,
      runStatus: "completed",
      runUpdatedAt: "2026-09-13T00:03:00.000Z",
      selectedShapeIds: [],
      summary: "Проверяемая сводка",
      title: "Сводка проекта",
      trace: [firstToolTrace, secondToolTrace],
    });

    const call = createPpmOrchestratorCallNode({
      authorId: "user-1",
      now: NOW,
      runId,
      trace: firstToolTrace,
    });
    const connections = createPpmOrchestratorProjectionConnections(node);

    expect(call).toMatchObject({
      kind: "orchcall",
      result_count: 6,
      status: "completed",
      title: "Чтение списка задач",
      tool_mode: "read",
      tool_name: "list_work_items",
      trace_kind: "tool_call",
    });
    expect(call.action_id).toBeUndefined();
    expect(connections.map((connection) => [connection.from.kind, connection.to.kind])).toEqual([
      ["orchestrator", "orchcall"],
      ["orchcall", "orchcall"],
    ]);
    expect(JSON.stringify(call)).not.toContain("payload");
  });

  it("attaches proposal tool telemetry to its action task", () => {
    const runId = "0ffcb7d4-35ef-4878-819d-87ecbe072223";
    const actionId = "d2975458-b265-4807-a445-013cadfa9678";
    const action = {
      action_id: actionId,
      action_kind: "create_work_items" as const,
      canonical_changes_applied: false,
      status: "proposed" as const,
      summary: "Подготовлена отдельная задача.",
      title: "Подготовить задачу",
    };
    const node = createPpmOrchestratorNode({
      actionSummary: {
        applied: 0,
        applying: 0,
        approved: 0,
        cancelled: 0,
        canonical_changes_applied: false,
        conflict: 0,
        failed: 0,
        partial: false,
        rejected: 0,
        remaining: 1,
        review_complete: false,
        reviewed: 0,
        total: 1,
      },
      actions: [action],
      agentKind: "work_decomposer",
      authorId: "user-1",
      citations: [],
      model: "deterministic-v1",
      now: NOW,
      policyVersion: "ppm-agents-v1",
      provider: "local",
      runCreatedAt: NOW,
      runFinishedAt: null,
      runId,
      runStatus: "awaiting_approval",
      runUpdatedAt: "2026-09-13T00:03:00.000Z",
      selectedShapeIds: [],
      summary: "Одно предложение",
      title: "Декомпозиция работы",
      trace: [
        {
          action_id: actionId,
          kind: "tool_call",
          occurred_at: "2026-09-13T00:01:00.000Z",
          result_count: 1,
          status: "completed",
          summary: "Получено результатов: 1",
          title: "Подготовка задачи",
          tool_mode: "propose",
          tool_name: "propose_work_items",
          trace_id: "tool:event-proposal",
        },
        {
          action_id: actionId,
          action_title: action.title,
          kind: "action_status",
          occurred_at: "2026-09-13T00:02:00.000Z",
          status: "proposed",
          trace_id: `action:${actionId}:status:proposed`,
        },
      ],
    });

    const connections = createPpmOrchestratorProjectionConnections(node);

    expect(connections.map((connection) => [connection.from.kind, connection.to.kind])).toEqual([
      ["orchestrator", "orchtask"],
      ["orchtask", "orchcall"],
      ["orchcall", "orchcall"],
    ]);
    expect(connections[1]?.action_id).toBe(actionId);
  });

  it("does not confuse equal call trace ids from different orchestrator runs", () => {
    const actionId = "d2975458-b265-4807-a445-013cadfa9678";
    const action = {
      action_id: actionId,
      action_kind: "create_work_items" as const,
      canonical_changes_applied: false,
      status: "proposed" as const,
      summary: "Проверить идентичность запуска.",
      title: "Проверяемое предложение",
    };
    const trace = {
      trace_id: `action:${actionId}:status:proposed`,
      kind: "action_status" as const,
      status: "proposed" as const,
      occurred_at: "2026-09-13T00:07:00.000Z",
      action_id: actionId,
      action_title: action.title,
    };
    const firstRunCall = createPpmOrchestratorCallNode({
      action,
      authorId: "user-1",
      now: NOW,
      runId: "0ffcb7d4-35ef-4878-819d-87ecbe072223",
      trace,
    });
    const secondRunCall = createPpmOrchestratorCallNode({
      action,
      authorId: "user-1",
      now: NOW,
      runId: "7f335c4f-b0ca-43db-83ef-85a620d776c0",
      trace,
    });

    expect(isSamePpmOrchestratorProjection(firstRunCall, firstRunCall)).toBe(true);
    expect(isSamePpmOrchestratorProjection(firstRunCall, secondRunCall)).toBe(false);
  });

  it("migrates a legacy note and preserves unknown fields", () => {
    const result = parseAndMigratePpmCanvasNode({
      kind: "note",
      title: "Legacy",
      body: "Text",
      color: "green",
      width: 400,
      height: 240,
      future_hint: { keep: true },
    });

    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") return;
    expect(result.node.visual).toMatchObject({ color: "green", width: 400, height: 240 });
    expect(result.node).toMatchObject({ future_hint: { keep: true } });
  });

  it("migrates schema v1 to v2 without dropping opaque fields", () => {
    const result = parseAndMigratePpmCanvasNode({
      schema_version: 1,
      kind: "note",
      title: "v1",
      body: "Text",
      author_id: "user-1",
      created_at: NOW,
      updated_at: NOW,
      visual: { color: "yellow", width: 320, height: 220 },
      future_hint: { keep: true },
    });

    expect(result).toMatchObject({
      status: "migrated",
      node: { schema_version: 2, future_hint: { keep: true } },
    });
  });

  it("creates every browser-safe native node type", () => {
    const boardId = "ec4d3217-4d33-4628-b4e9-3c7fd63d2bb0";
    const nodes = [
      createPpmCanvasNode({ authorId: "user-1", kind: "document", now: NOW, title: "Документ" }),
      createPpmCanvasNode({ authorId: "user-1", kind: "checklist", now: NOW, title: "Чек-лист" }),
      createPpmCanvasNode({ authorId: "user-1", kind: "table", now: NOW, title: "Таблица" }),
      createPpmCanvasNode({ authorId: "user-1", kind: "code", now: NOW, title: "Код" }),
      createPpmCanvasNode({ authorId: "user-1", kind: "group", now: NOW, title: "Группа" }),
      createPpmCanvasNode({ authorId: "user-1", kind: "frame", now: NOW, title: "Рамка" }),
      createPpmCanvasNode({
        authorId: "user-1",
        kind: "board_link",
        now: NOW,
        targetBoardId: boardId,
        title: "Другая доска",
      }),
      createPpmCanvasNode({ authorId: "user-1", kind: "work_items_view", now: NOW, title: "Работа проекта" }),
      createPpmCanvasNode({ authorId: "user-1", kind: "diagram", now: NOW, title: "Схема" }),
      createPpmCanvasNode({ authorId: "user-1", kind: "deck", now: NOW, title: "Презентация" }),
    ];

    expect(nodes.map((node) => node.kind)).toEqual([
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
    ]);
    expect(nodes.every((node) => parseAndMigratePpmCanvasNode(node).status === "valid")).toBe(true);
    expect(nodes.find((node) => node.kind === "code")).toMatchObject({ executable: false });
    expect(nodes.find((node) => node.kind === "work_items_view")).toMatchObject({
      layout: "kanban",
      group_by: "state",
      sort: "updated_desc",
      filters: { state_ids: [], priorities: [], assignee_ids: [], include_archived: false },
    });
  });

  it("regenerates nested IDs when structured nodes are duplicated", () => {
    const checklist = createPpmCanvasNode({ authorId: "user-1", kind: "checklist", now: NOW, title: "Список" });
    if (checklist.kind !== "checklist") throw new Error("Expected checklist node.");
    const withItem = updatePpmCanvasNode(checklist, {
      items: [{ id: "item-1", text: "Проверить", checked: false }],
    });
    const duplicate = duplicatePpmCanvasNode(withItem, "user-2", "2026-09-13T00:02:00.000Z");

    expect(duplicate.author_id).toBe("user-2");
    expect(duplicate.items[0]?.id).not.toBe(withItem.items[0]?.id);
  });

  it("round-trips a safe board export and rejects a foreign payload", () => {
    const exported = createPpmCanvasBoardExport({ document: { store: {} } }, NOW);
    expect(parsePpmCanvasBoardExport(JSON.stringify(exported))).toMatchObject({
      format: "ppm-canvas-board",
      schema_version: 2,
    });
    expect(() => parsePpmCanvasBoardExport('{"format":"other"}')).toThrow();
  });

  it("keeps unknown tldraw records opaque during board export and import", () => {
    const futureRecord = {
      id: "shape:future-node",
      typeName: "shape",
      type: "future-ppm-node",
      props: { nested: { untouched: true }, version: 99 },
    };
    const exported = createPpmCanvasBoardExport(
      { document: { schema: { schemaVersion: 2 }, store: { [futureRecord.id]: futureRecord } } },
      NOW
    );
    const restored = parsePpmCanvasBoardExport(JSON.stringify(exported));

    expect(restored.document).toMatchObject({ store: { [futureRecord.id]: futureRecord } });
  });

  it("returns stable fallbacks for unknown and corrupt nodes", () => {
    expect(parseAndMigratePpmCanvasNode({ schema_version: 1, kind: "future-node" })).toMatchObject({
      status: "unknown",
      kind: "future-node",
    });
    expect(parseSerializedPpmCanvasNode("{not-json")).toMatchObject({ status: "corrupt" });
    expect(parseAndMigratePpmCanvasNode({ schema_version: 1, kind: "note", title: 7 })).toMatchObject({
      status: "corrupt",
    });
  });

  it("updates editable content without changing authorship", () => {
    const note = createPpmCanvasNode({ authorId: "user-1", kind: "note", now: NOW, title: "Before" });
    const updated = updatePpmCanvasNode(note, { body: "Markdown", title: "After" }, "2026-09-13T00:01:00.000Z");

    expect(updated).toMatchObject({
      author_id: "user-1",
      body: "Markdown",
      title: "After",
      created_at: NOW,
      updated_at: "2026-09-13T00:01:00.000Z",
    });
  });

  it("stores only binding metadata for a Work Item projection", () => {
    const node = createPpmWorkItemRefNode({
      authorId: "user-1",
      now: NOW,
      binding: {
        binding_id: "9ccca22c-1f55-4aed-873a-cf9a2f48ce07",
        entity_type: "work_item",
        entity_id: "af7495ab-f952-4a89-9a24-6498d236584e",
        source_version: "2026-09-13T08:00:00+00:00",
      },
    });

    expect(node).toMatchObject({
      schema_version: 2,
      kind: "work_item_ref",
      binding: { entity_type: "work_item", entity_id: "af7495ab-f952-4a89-9a24-6498d236584e" },
    });
    expect(node).not.toHaveProperty("title");
    expect(node).not.toHaveProperty("state");
    expect(parseAndMigratePpmCanvasNode(node)).toMatchObject({ status: "valid" });
  });
});

it("creates a Vault reference without embedding file content", () => {
  const entryId = "9b412a36-8f94-4de8-b9db-26683229e41a";
  const node = createPpmVaultFileRefNode({
    authorId: "user-1",
    entryId,
    extension: ".pdf",
    sourceUrl: `/workspace/projects/project/knowledge?entry_id=${entryId}`,
    sourceVersion: "1",
    title: "План.pdf",
  });

  expect(node).toMatchObject({
    kind: "vault_file_ref",
    extension: ".pdf",
    source_version: "1",
    title: "План.pdf",
  });
  expect(JSON.stringify(node)).not.toContain("%PDF");
  expect(node).not.toHaveProperty("content");
  expect(node).not.toHaveProperty("blob");
});

it("creates media projections with binding-only provenance", () => {
  const binding = {
    binding_id: "9ccca22c-1f55-4aed-873a-cf9a2f48ce07",
    entity_type: "vault_file" as const,
    entity_id: "9b412a36-8f94-4de8-b9db-26683229e41a",
    source_version: "2",
  };
  const image = createPpmContentRefNode({
    authorId: "user-1",
    binding,
    extension: ".png",
    kind: "image",
    now: NOW,
    sourceUrl: "/workspace/projects/project/vault?entry=9b412a36-8f94-4de8-b9db-26683229e41a",
    title: "Scheme.png",
  });

  expect(image).toMatchObject({ kind: "image", binding, extension: ".png" });
  expect(image).not.toHaveProperty("content");
  expect(image).not.toHaveProperty("blob");
  expect(parseAndMigratePpmCanvasNode(image)).toMatchObject({ status: "valid" });

  const shapeId = "shape:image";
  const exported = createPpmCanvasBoardExport(
    {
      document: {
        store: {
          [shapeId]: {
            id: shapeId,
            typeName: "shape",
            type: "ppm-canvas-node",
            props: { node: JSON.stringify(image) },
          },
        },
      },
    },
    NOW
  );
  expect(exported.sources).toEqual([
    expect.objectContaining({
      shape_id: shapeId,
      entity_type: "vault_file",
      entity_id: binding.entity_id,
      source_version: "2",
    }),
  ]);
});

it("blocks active Mermaid directives and preserves safe diagrams", () => {
  const safe = "flowchart LR\n  A[Idea] --> B[Result]";
  expect(isPpmMermaidSourceSafe(safe)).toBe(true);
  expect(isPpmMermaidSourceSafe('flowchart LR\n  A --> B\n  click A "javascript:alert(1)"')).toBe(false);
  expect(isPpmMermaidSourceSafe("<script>alert(1)</script>")).toBe(false);
  expect(
    createPpmCanvasNode({ authorId: "user-1", body: safe, kind: "diagram", now: NOW, title: "Safe" })
  ).toMatchObject({
    kind: "diagram",
    source: safe,
  });
  expect(() =>
    createPpmCanvasNode({ authorId: "user-1", body: "<script>alert(1)</script>", kind: "diagram", title: "Unsafe" })
  ).toThrow();
});

it("creates a Git reference with canonical metadata and no credentials", () => {
  const binding = {
    binding_id: "9ccca22c-1f55-4aed-873a-cf9a2f48ce07",
    entity_type: "pull_request" as const,
    entity_id: "ef2f471d-9c3d-43e0-9400-ce91f1051d55",
    source_version: "pull-42:v2",
  };
  const node = createPpmGitRefNode({
    authorId: "user-1",
    binding,
    canonicalUrl: "https://github.com/Imil1914/PPM/pull/42",
    objectType: "pull_request",
    provider: "github",
    repositoryName: "PPM",
    sourceId: "ef2f471d-9c3d-43e0-9400-ce91f1051d55",
    title: "GIT-1 — Git integration",
    workItemKey: "GIT-1",
  });

  expect(node).toMatchObject({
    kind: "git_ref",
    object_type: "pull_request",
    provider: "github",
    binding,
    work_item_key: "GIT-1",
  });
  expect(node.canonical_url).toBe("https://github.com/Imil1914/PPM/pull/42");
  expect(node).not.toHaveProperty("token");
  expect(node).not.toHaveProperty("credentials");
  expect(node).not.toHaveProperty("content");
  expect(parseAndMigratePpmCanvasNode(node)).toMatchObject({ status: "valid" });
});

describe("PPM Canvas project boundary", () => {
  it("isolates temporary local stores by workspace, project, and user", () => {
    const first = getPpmCanvasPersistenceKey("workspace-a", "project-a", "user-a");

    expect(first).not.toBe(getPpmCanvasPersistenceKey("workspace-b", "project-a", "user-a"));
    expect(first).not.toBe(getPpmCanvasPersistenceKey("workspace-a", "project-b", "user-a"));
    expect(first).not.toBe(getPpmCanvasPersistenceKey("workspace-a", "project-a", "user-b"));
  });

  it("requires both the shell and Canvas feature flag", () => {
    expect(isPpmCanvasEnabled(undefined, true)).toBe(true);
    expect(isPpmCanvasEnabled("0", true)).toBe(false);
    expect(isPpmCanvasEnabled("1", false)).toBe(false);
  });

  it("can roll the AntyFlow shell back without disabling Canvas data", () => {
    expect(isPpmAntyFlowShellEnabled(undefined)).toBe(true);
    expect(isPpmAntyFlowShellEnabled("off")).toBe(false);
    expect(isPpmAntyFlowShellEnabled("1")).toBe(true);
  });

  it("keeps Ask Project agents hidden unless explicitly enabled", () => {
    for (const value of [undefined, "", "0", "off", "false", "maybe"])
      expect(isPpmProjectAskEnabled(value)).toBe(false);
    for (const value of ["1", " TRUE ", "on", "yes", "enabled"]) expect(isPpmProjectAskEnabled(value)).toBe(true);
  });
});

describe("PPM Canvas HTTP contract", () => {
  const canvasId = "9ccca22c-1f55-4aed-873a-cf9a2f48ce07";
  const workspaceId = "cb25e219-d0b2-491c-ad24-3430b1a2c6d3";
  const projectId = "af7495ab-f952-4a89-9a24-6498d236584e";
  const userId = "8e3389db-299c-4861-89d3-1003d8e36105";

  it("accepts an empty first-open response", () => {
    expect(
      ppmCanvasReadResponseSchema.parse({
        canvas_id: canvasId,
        workspace_id: workspaceId,
        project_id: projectId,
        name: "Мозг проекта",
        schema_version: 2,
        version: 0,
        snapshot: null,
        snapshot_status: "empty",
        content_hash: null,
        saved_at: null,
        saved_by: null,
        access: "edit",
      }).snapshot_status
    ).toBe("empty");
  });

  it("rejects a ready response without a snapshot", () => {
    expect(
      ppmCanvasReadResponseSchema.safeParse({
        canvas_id: canvasId,
        workspace_id: workspaceId,
        project_id: projectId,
        name: "Мозг проекта",
        schema_version: 2,
        version: 1,
        snapshot: null,
        snapshot_status: "ready",
        content_hash: "a".repeat(64),
        saved_at: "2026-09-13T08:00:00.000Z",
        saved_by: userId,
        access: "read",
      }).success
    ).toBe(false);
  });

  it("validates an immutable board version used for recovery merge", () => {
    const payload = {
      board_id: canvasId,
      version: 4,
      schema_version: 2,
      snapshot: { document: { store: {} } },
      content_hash: "a".repeat(64),
      saved_by: userId,
      saved_at: "2026-09-23T10:00:00.000Z",
    };
    expect(ppmCanvasBoardVersionResponseSchema.parse(payload).version).toBe(4);
    expect(ppmCanvasBoardVersionResponseSchema.safeParse({ ...payload, snapshot: null }).success).toBe(false);
    expect(ppmCanvasBoardVersionResponseSchema.safeParse({ ...payload, version: 0 }).success).toBe(false);
  });

  it("validates save and error envelopes", () => {
    expect(
      ppmCanvasSaveResponseSchema.parse({
        canvas_id: canvasId,
        version: 1,
        content_hash: "b".repeat(64),
        saved_at: "2026-09-13T08:00:00.000Z",
        saved_by: userId,
        request_id: "f34502e2-ef58-475f-939f-6f835d7b94ec",
        idempotent_replay: false,
      }).version
    ).toBe(1);
    expect(
      ppmCanvasErrorResponseSchema.parse({
        error: {
          code: "CANVAS_VERSION_CONFLICT",
          message: "conflict",
          request_id: "263d0111-03e4-4f7f-a655-b9b42e0a90fa",
          details: { current_version: 2 },
        },
      }).error.code
    ).toBe("CANVAS_VERSION_CONFLICT");
  });

  it("validates a live Work Item binding response", () => {
    const parsed = ppmCanvasBindingMutationResponseSchema.parse({
      binding_id: canvasId,
      binding_status: "pending",
      shape_id: "shape:work-item",
      entity_type: "work_item",
      entity_id: projectId,
      source_version: "2026-09-13T08:00:00+00:00",
      idempotent_replay: false,
      source: {
        identity: {
          entity_type: "work_item",
          entity_id: projectId,
          workspace_id: workspaceId,
          project_id: projectId,
          identifier: "MAP-12",
          source_url: `/workspace/projects/${projectId}/issues/${projectId}`,
        },
        display: {
          title: "Mapped task",
          state: null,
          priority: "medium",
          assignees: [],
          due_date: null,
          source_status: "active",
        },
        capabilities: {
          read: true,
          update: true,
          delete_source: false,
          editable_fields: ["state_id", "priority", "assignee_ids", "due_date"],
        },
        source_version: "2026-09-13T08:00:00+00:00",
      },
    });

    expect(parsed.source.display.title).toBe("Mapped task");
    expect(parsed.source.capabilities.delete_source).toBe(false);
  });

  it("validates a live Git projection without writable source capabilities", () => {
    const parsed = ppmCanvasBindingMutationResponseSchema.parse({
      binding_id: canvasId,
      binding_status: "pending",
      shape_id: "shape:git-object",
      entity_type: "commit",
      entity_id: projectId,
      source_version: "abc123:v2",
      idempotent_replay: false,
      source: {
        identity: {
          entity_type: "commit",
          entity_id: projectId,
          workspace_id: workspaceId,
          project_id: projectId,
          source_url: "https://github.com/ppm/ppm/commit/abc123",
        },
        display: {
          title: "MAP-12: live projection",
          provider: "github",
          repository_name: "ppm/ppm",
          object_type: "commit",
          ref: "abc123",
          state: "",
          author_name: "PPM Bot",
          base_ref: "",
          head_ref: "",
          commit_sha: "abc123",
          work_items: [{ id: projectId, identifier: "MAP-12", title: "Mapped task" }],
          source_status: "active",
        },
        capabilities: { read: true, update: false, delete_source: false },
        source_version: "abc123:v2",
      },
    });

    expect(parsed.entity_type).toBe("commit");
    if (!("work_items" in parsed.source.display)) throw new Error("Expected Git projection.");
    expect(parsed.source.display.work_items[0]?.identifier).toBe("MAP-12");
    expect(parsed.source.capabilities.update).toBe(false);
  });

  it("validates the multi-board list and capability matrix", () => {
    const boardId = "ec4d3217-4d33-4628-b4e9-3c7fd63d2bb0";
    const parsed = ppmCanvasBoardsResponseSchema.parse({
      canvas_id: canvasId,
      default_board_id: boardId,
      access: "edit",
      capabilities: {
        read: true,
        edit: true,
        create_board: true,
        rename_board: true,
        reorder_boards: true,
        duplicate_board: true,
        archive_board: false,
        restore_board: false,
        manage_canvas: false,
      },
      boards: [
        {
          board_id: boardId,
          name: "Главная",
          position: 0,
          status: "active",
          version: 2,
          created_by: userId,
          updated_by: userId,
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
        },
      ],
    });

    expect(parsed.boards[0]?.name).toBe("Главная");
    expect(parsed.capabilities.archive_board).toBe(false);
  });

  it("validates typed semantic connections between Canvas objects", () => {
    const boardId = "ec4d3217-4d33-4628-b4e9-3c7fd63d2bb0";
    const parsed = ppmCanvasSemanticEdgesResponseSchema.parse({
      semantic_edges: [
        {
          edge_id: canvasId,
          board_id: boardId,
          from_shape_id: "shape:source",
          to_shape_id: "shape:target",
          relation_type: "explains",
          label: "Decision context",
          confidence: null,
          origin: "user",
          confirmation_status: "confirmed",
          confirmed_by: userId,
          confirmed_at: NOW,
          created_by: userId,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });

    expect(parsed.semantic_edges[0]).toMatchObject({ relation_type: "explains", origin: "user" });
  });
});
