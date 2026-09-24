import { describe, expect, it, vi } from "vitest";
import {
  PpmBrainService,
  type TPpmAgentRun,
  type TPpmBrainAnswerRun,
  type TPpmBrainQueryResponse,
  type TPpmBrainSearchStreamRun,
} from "@/services/ppm-brain.service";

function streamingAgentRun(status: "queued" | "running" | "completed"): TPpmAgentRun {
  return {
    action_summary: {
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
      review_complete: false,
      reviewed: 0,
      total: 0,
    },
    actions: [],
    agent_kind: "project_reporter",
    audit_trace: [],
    capabilities: ["list_work_items", "read_work_item"],
    cancel_requested: false,
    citations: [],
    context: { locale: "ru", selected_shape_ids: [] },
    created_at: "2026-09-21T12:00:00Z",
    error_code: "",
    error_message: "",
    finished_at: status === "completed" ? "2026-09-21T12:00:02Z" : null,
    id: "11111111-1111-4111-8111-111111111111",
    model: "local-deterministic",
    policy_version: "ppm-agents-v1",
    provider: "local",
    result:
      status === "completed"
        ? {
            generated_at: "2026-09-21T12:00:02Z",
            highlights: [],
            kind: "project_report",
            markdown: "# Сводка проекта",
            metrics: {
              completed_count: 1,
              issue_count: 3,
              overdue_count: 0,
              risk_count: 0,
              state_counts: { completed: 1, started: 2 },
            },
            scope: {
              project_id: "33333333-3333-4333-8333-333333333333",
              workspace_id: "22222222-2222-4222-8222-222222222222",
            },
            uncited_highlight_count: 0,
          }
        : {},
    started_at: status === "queued" ? null : "2026-09-21T12:00:01Z",
    status,
    updated_at:
      status === "queued"
        ? "2026-09-21T12:00:00Z"
        : status === "running"
          ? "2026-09-21T12:00:01Z"
          : "2026-09-21T12:00:02Z",
  };
}

function streamingAnswerRun(status: "queued" | "degraded"): TPpmBrainAnswerRun {
  return {
    answer: status === "degraded" ? "Проверяемая сводка" : "",
    board_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    cancel_requested: false,
    citations: [],
    created_at: "2026-09-22T08:00:00Z",
    error: null,
    finished_at: status === "degraded" ? "2026-09-22T08:00:02Z" : null,
    graph_depth: 1,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    model: null,
    policy_version: "ppm-brain-answer-v1",
    provider: status === "degraded" ? "disabled" : null,
    query: "Что происходит?",
    retrieval: status === "degraded" ? { degraded: true, mode: "keyword" } : {},
    retrieved_sources: [],
    scope: { mode: "project" },
    selected_shape_ids: [],
    started_at: status === "degraded" ? "2026-09-22T08:00:01Z" : null,
    status,
    updated_at: status === "degraded" ? "2026-09-22T08:00:02Z" : "2026-09-22T08:00:00Z",
  };
}

describe("PPM Project Reporter service", () => {
  it("loads recent answer runs so an active answer can be restored after reload", async () => {
    const service = new PpmBrainService();
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: { results: [] } } as never);

    await expect(
      service.getAnswerRuns("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")
    ).resolves.toEqual({ results: [] });
    expect(get).toHaveBeenCalledWith(
      "/api/ppm/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/knowledge/answers/"
    );
  });

  it("loads recent agent runs so timed-out work can be resumed", async () => {
    const service = new PpmBrainService();
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: { results: [] } } as never);

    await expect(
      service.getAgentRuns("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")
    ).resolves.toEqual({ results: [] });
    expect(get).toHaveBeenCalledWith(
      "/api/ppm/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/knowledge/agents/runs/"
    );
  });

  it("loads one project-scoped agent run while the panel restores observation", async () => {
    const service = new PpmBrainService();
    const run = streamingAgentRun("running");
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: run } as never);

    await expect(
      service.getAgentRun("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", run.id)
    ).resolves.toEqual(run);
    expect(get).toHaveBeenCalledWith(
      `/api/ppm/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/knowledge/agents/runs/${run.id}/`
    );
  });

  it("starts the read-only reporter inside the selected project", async () => {
    const service = new PpmBrainService();
    const run = {
      action_summary: {
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
        review_complete: false,
        reviewed: 0,
        total: 0,
      },
      actions: [],
      agent_kind: "project_reporter",
      capabilities: ["list_work_items", "read_work_item"],
      cancel_requested: false,
      citations: [],
      context: { locale: "ru", selected_shape_ids: [] },
      created_at: "2026-09-21T12:00:00Z",
      error_code: "",
      error_message: "",
      finished_at: "2026-09-21T12:00:01Z",
      id: "11111111-1111-4111-8111-111111111111",
      model: "",
      policy_version: "ppm-agents-v1",
      provider: "",
      result: {
        generated_at: "2026-09-21T12:00:00Z",
        highlights: [],
        kind: "project_report",
        markdown: "# Сводка проекта",
        metrics: {
          completed_count: 1,
          issue_count: 3,
          overdue_count: 1,
          risk_count: 1,
          state_counts: { completed: 1, started: 2 },
        },
        scope: {
          project_id: "33333333-3333-4333-8333-333333333333",
          workspace_id: "22222222-2222-4222-8222-222222222222",
        },
        uncited_highlight_count: 0,
      },
      status: "completed",
      started_at: "2026-09-21T12:00:00Z",
      updated_at: "2026-09-21T12:00:01Z",
      audit_trace: [],
    } satisfies TPpmAgentRun;
    const post = vi.spyOn(service, "post").mockResolvedValue({ data: run } as never);

    await expect(
      service.createAgentRun("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", {
        agent_kind: "project_reporter",
        client_operation_id: "44444444-4444-4444-8444-444444444444",
        context: { locale: "ru" },
        options: { max_highlights: 10 },
      })
    ).resolves.toEqual(run);
    expect(post).toHaveBeenCalledWith(
      "/api/ppm/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/knowledge/agents/runs/",
      {
        agent_kind: "project_reporter",
        client_operation_id: "44444444-4444-4444-8444-444444444444",
        context: { locale: "ru" },
        options: { max_highlights: 10 },
      }
    );
  });

  it("streams queued, running, and completed agent snapshots across response chunks", async () => {
    const service = new PpmBrainService();
    const runs = [streamingAgentRun("queued"), streamingAgentRun("running"), streamingAgentRun("completed")];
    const progress = {
      call_id: "55555555-5555-4555-8555-555555555555",
      occurred_at: "2026-09-21T12:00:01Z",
      run_id: runs[0].id,
      tool: { mode: "read", name: "list_work_items", result_count: null, status: "running" },
    } as const;
    const payload = [
      `event: run\ndata: ${JSON.stringify(runs[0])}\n\n`,
      `event: run\ndata: ${JSON.stringify(runs[1])}\n\n`,
      `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
      `event: progress\ndata: ${JSON.stringify({ ...progress, tool: { ...progress.tool, result_count: 3, status: "completed" } })}\n\n`,
      `event: run\ndata: ${JSON.stringify(runs[2])}\n\n`,
    ].join("");
    const encoded = new TextEncoder().encode(payload);
    const chunks = [encoded.slice(0, 37), encoded.slice(37, 311), encoded.slice(311)];
    let chunkIndex = 0;
    const fetchMock = vi.fn().mockResolvedValue({
      body: {
        getReader: () => ({
          read: async () =>
            chunkIndex < chunks.length
              ? { done: false, value: chunks[chunkIndex++] }
              : { done: true, value: undefined },
        }),
      },
      ok: true,
      status: 201,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const statuses: TPpmAgentRun["status"][] = [];
      const progressStatuses: string[] = [];
      await expect(
        service.streamAgentRun(
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
          {
            agent_kind: "project_reporter",
            client_operation_id: "44444444-4444-4444-8444-444444444444",
            context: { locale: "ru" },
          },
          (run) => statuses.push(run.status),
          (event) => progressStatuses.push(event.tool.status)
        )
      ).resolves.toEqual(runs[2]);
      expect(statuses).toEqual(["queued", "running", "completed"]);
      expect(progressStatuses).toEqual(["running", "completed"]);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/ppm/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/knowledge/agents/runs/stream/"
        ),
        expect.objectContaining({ credentials: "include", method: "POST" })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams one search lifecycle through the shared service stream contract", async () => {
    const service = new PpmBrainService();
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const output = {
      results: [
        {
          chunk_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          excerpt: "Подтверждённый источник",
          locator: { identifier: "PPM-1" },
          score: 1,
          source_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          source_type: "work_item",
          source_version: "v1",
          title: "PPM-1 · Проверка",
        },
      ],
      retrieval: { degraded: true, mode: "keyword", reason: "EMBEDDING_PROVIDER_DISABLED" },
      service_run: {
        created_at: "2026-09-22T08:00:00Z",
        finished_at: "2026-09-22T08:00:01Z",
        kind: "search",
        model: null,
        policy_version: "ppm-brain-search-v1",
        provider: null,
        run_id: runId,
        started_at: "2026-09-22T08:00:00Z",
        status: "degraded",
        updated_at: "2026-09-22T08:00:01Z",
      },
    } satisfies TPpmBrainQueryResponse;
    const runs: TPpmBrainSearchStreamRun[] = [
      {
        output: null,
        service_run: {
          ...output.service_run,
          finished_at: null,
          status: "running",
          updated_at: output.service_run.created_at,
        },
      },
      { output, service_run: output.service_run },
    ];
    const progress = {
      occurred_at: "2026-09-22T08:00:01Z",
      run_id: runId,
      stage: { name: "search_project_knowledge", result_count: 1, status: "completed" },
    } as const;
    const encoded = new TextEncoder().encode(
      [
        `event: run\ndata: ${JSON.stringify(runs[0])}\n\n`,
        `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
        `event: run\ndata: ${JSON.stringify(runs[1])}\n\n`,
      ].join("")
    );
    let read = false;
    const fetchMock = vi.fn().mockResolvedValue({
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: encoded };
          },
        }),
      },
      ok: true,
      status: 200,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const statuses: string[] = [];
      const stages: string[] = [];
      await expect(
        service.streamQuery(
          "workspace",
          "project",
          { graph_depth: 1, query: "Проверка", selected_shape_ids: [] },
          (run) => statuses.push(run.service_run.status),
          (event) => stages.push(event.stage.status)
        )
      ).resolves.toEqual(runs[1]);
      expect(statuses).toEqual(["running", "degraded"]);
      expect(stages).toEqual(["completed"]);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/knowledge/query/stream/"),
        expect.objectContaining({ credentials: "include", method: "POST" })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates and observes an answer in one streamed request", async () => {
    const service = new PpmBrainService();
    const queued = streamingAnswerRun("queued");
    const completed = streamingAnswerRun("degraded");
    const progress = {
      occurred_at: "2026-09-22T08:00:02Z",
      run_id: queued.id,
      stage: { name: "prepare_grounded_answer", result_count: 1, status: "completed" },
    } as const;
    const encoded = new TextEncoder().encode(
      [
        `event: run\ndata: ${JSON.stringify(queued)}\n\n`,
        `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
        `event: run\ndata: ${JSON.stringify(completed)}\n\n`,
      ].join("")
    );
    let read = false;
    const fetchMock = vi.fn().mockResolvedValue({
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: encoded };
          },
        }),
      },
      ok: true,
      status: 201,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const statuses: string[] = [];
      const stages: string[] = [];
      await expect(
        service.streamAnswerRun(
          "workspace",
          "project",
          {
            board_id: queued.board_id ?? "",
            client_operation_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            graph_depth: 1,
            query: queued.query,
            selected_shape_ids: [],
          },
          (run) => statuses.push(run.status),
          (event) => stages.push(event.stage.status)
        )
      ).resolves.toEqual(completed);
      expect(statuses).toEqual(["queued", "degraded"]);
      expect(stages).toEqual(["completed"]);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/knowledge/answers/stream/"),
        expect.objectContaining({ credentials: "include", method: "POST" })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams a retry through the project-scoped retry endpoint", async () => {
    const service = new PpmBrainService();
    const queued = { ...streamingAgentRun("queued"), id: "66666666-6666-4666-8666-666666666666" };
    const completed = { ...streamingAgentRun("completed"), id: queued.id };
    const progress = {
      call_id: "77777777-7777-4777-8777-777777777777",
      occurred_at: "2026-09-21T12:00:01Z",
      run_id: queued.id,
      tool: { mode: "read", name: "list_work_items", result_count: 3, status: "completed" },
    } as const;
    const encoded = new TextEncoder().encode(
      [
        `event: run\ndata: ${JSON.stringify(queued)}\n\n`,
        `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
        `event: run\ndata: ${JSON.stringify(completed)}\n\n`,
      ].join("")
    );
    let read = false;
    const fetchMock = vi.fn().mockResolvedValue({
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: encoded };
          },
        }),
      },
      ok: true,
      status: 201,
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const statuses: TPpmAgentRun["status"][] = [];
      const progressStatuses: string[] = [];
      await expect(
        service.streamRetryAgentRun(
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
          "11111111-1111-4111-8111-111111111111",
          {
            client_operation_id: "44444444-4444-4444-8444-444444444444",
            options: { max_highlights: 10 },
          },
          (run) => statuses.push(run.status),
          (event) => progressStatuses.push(event.tool.status)
        )
      ).resolves.toEqual(completed);
      expect(statuses).toEqual(["queued", "completed"]);
      expect(progressStatuses).toEqual(["completed"]);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/ppm/v1/workspaces/22222222-2222-4222-8222-222222222222/projects/33333333-3333-4333-8333-333333333333/knowledge/agents/runs/11111111-1111-4111-8111-111111111111/retry/stream/"
        ),
        expect.objectContaining({ credentials: "include", method: "POST" })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prepares and reviews a work decomposition without applying tasks", async () => {
    const service = new PpmBrainService();
    const run = {
      action_summary: {
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
          action_kind: "create_work_items",
          approved_at: null,
          approved_by: null,
          error_code: "",
          error_message: "",
          id: "55555555-5555-4555-8555-555555555555",
          payload: {
            items: [
              {
                acceptance_criteria: ["Результат проверен"],
                source_ids: ["66666666-6666-4666-8666-666666666666"],
                title: "Проверить результат",
              },
            ],
          },
          preconditions: {},
          preview: { title: "Предложено 1 задача" },
          proposal_tool: "propose_work_items",
          rejected_at: null,
          rejected_by: null,
          result: {},
          sequence: 0,
          status: "proposed",
        },
      ],
      agent_kind: "work_decomposer",
      capabilities: ["read_work_item", "propose_work_items"],
      cancel_requested: false,
      citations: [],
      context: { locale: "ru", selected_shape_ids: [] },
      created_at: "2026-09-21T12:00:00Z",
      error_code: "",
      error_message: "",
      finished_at: null,
      id: "11111111-1111-4111-8111-111111111111",
      model: "",
      policy_version: "ppm-agents-v1",
      provider: "",
      result: {
        action_id: "55555555-5555-4555-8555-555555555555",
        action_ids: ["55555555-5555-4555-8555-555555555555"],
        canonical_changes_applied: false,
        generated_at: "2026-09-21T12:00:00Z",
        goal: "Подготовить запуск",
        item_count: 1,
        kind: "work_decomposition",
        source: {
          id: "66666666-6666-4666-8666-666666666666",
          identifier: "PPM-1",
          title: "PPM-1 · Исходная задача",
        },
      },
      status: "awaiting_approval",
      started_at: "2026-09-21T12:00:00Z",
      updated_at: "2026-09-21T12:00:01Z",
      audit_trace: [],
    } satisfies TPpmAgentRun;
    const post = vi.spyOn(service, "post").mockResolvedValue({ data: run } as never);

    await expect(
      service.createAgentRun("workspace", "project", {
        agent_kind: "work_decomposer",
        client_operation_id: "operation",
        context: { locale: "ru" },
        options: { goal: "Подготовить запуск", source_id: "66666666-6666-4666-8666-666666666666" },
      })
    ).resolves.toEqual(run);
    await expect(
      service.reviewAgentAction("workspace", "project", "55555555-5555-4555-8555-555555555555", "approve")
    ).resolves.toEqual(run);
    expect(post).toHaveBeenLastCalledWith(
      "/api/ppm/v1/workspaces/workspace/projects/project/knowledge/agents/actions/55555555-5555-4555-8555-555555555555/review/",
      { decision: "approve" }
    );
    await expect(
      service.reviewAgentActionBatch("workspace", "project", run.id, [
        { action_id: "55555555-5555-4555-8555-555555555555", decision: "approve" },
      ])
    ).resolves.toEqual(run);
    expect(post).toHaveBeenLastCalledWith(
      `/api/ppm/v1/workspaces/workspace/projects/project/knowledge/agents/runs/${run.id}/review/`,
      {
        decisions: [{ action_id: "55555555-5555-4555-8555-555555555555", decision: "approve" }],
      }
    );
    await expect(
      service.applyAgentActionBatch("workspace", "project", run.id, ["55555555-5555-4555-8555-555555555555"])
    ).resolves.toEqual(run);
    expect(post).toHaveBeenLastCalledWith(
      `/api/ppm/v1/workspaces/workspace/projects/project/knowledge/agents/runs/${run.id}/apply/`,
      { action_ids: ["55555555-5555-4555-8555-555555555555"] }
    );
  });

  it("prepares and reviews a knowledge draft without writing to the Vault", async () => {
    const service = new PpmBrainService();
    const run = {
      action_summary: {
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
          action_kind: "write_vault_file",
          approved_at: null,
          approved_by: null,
          error_code: "",
          error_message: "",
          id: "77777777-7777-4777-8777-777777777777",
          payload: {
            body: "# Дополнение: Резервное копирование",
            source_ids: ["88888888-8888-4888-8888-888888888888"],
            target: "vault_markdown",
            title: "Дополнение: Резервное копирование",
          },
          preconditions: {},
          preview: { title: "Дополнение: Резервное копирование" },
          proposal_tool: "propose_page_or_vault_note",
          rejected_at: null,
          rejected_by: null,
          result: {},
          sequence: 0,
          status: "proposed",
        },
      ],
      agent_kind: "knowledge_librarian",
      capabilities: ["read_vault_file", "propose_page_or_vault_note"],
      cancel_requested: false,
      citations: [],
      context: { locale: "ru", selected_shape_ids: [] },
      created_at: "2026-09-21T12:00:00Z",
      error_code: "",
      error_message: "",
      finished_at: null,
      id: "11111111-1111-4111-8111-111111111111",
      model: "",
      policy_version: "ppm-agents-v1",
      provider: "",
      result: {
        action_id: "77777777-7777-4777-8777-777777777777",
        canonical_changes_applied: false,
        generated_at: "2026-09-21T12:00:00Z",
        kind: "knowledge_proposal",
        source: {
          id: "88888888-8888-4888-8888-888888888888",
          path: "Архитектура.md",
          title: "Архитектура.md",
        },
        title: "Дополнение: Резервное копирование",
        topic: "Резервное копирование",
      },
      status: "awaiting_approval",
      started_at: "2026-09-21T12:00:00Z",
      updated_at: "2026-09-21T12:00:01Z",
      audit_trace: [],
    } satisfies TPpmAgentRun;
    const post = vi.spyOn(service, "post").mockResolvedValue({ data: run } as never);

    await expect(
      service.createAgentRun("workspace", "project", {
        agent_kind: "knowledge_librarian",
        client_operation_id: "operation",
        context: { locale: "ru" },
        options: { source_id: "88888888-8888-4888-8888-888888888888", topic: "Резервное копирование" },
      })
    ).resolves.toEqual(run);
    expect(post).toHaveBeenCalledWith("/api/ppm/v1/workspaces/workspace/projects/project/knowledge/agents/runs/", {
      agent_kind: "knowledge_librarian",
      client_operation_id: "operation",
      context: { locale: "ru" },
      options: { source_id: "88888888-8888-4888-8888-888888888888", topic: "Резервное копирование" },
    });
  });

  it("prepares a semantic edge proposal for two selected canvas objects", async () => {
    const service = new PpmBrainService();
    const run = {
      action_summary: {
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
          action_kind: "apply_semantic_edges",
          approved_at: null,
          approved_by: null,
          error_code: "",
          error_message: "",
          id: "99999999-9999-4999-8999-999999999999",
          payload: {
            edges: [
              {
                board_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                from_shape_id: "shape:knowledge",
                reason: "Материал объясняет задачу.",
                relation: "explains",
                source_ids: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
                to_shape_id: "shape:work",
              },
            ],
          },
          preconditions: {},
          preview: { title: "Предложена смысловая связь" },
          proposal_tool: "propose_semantic_edges",
          rejected_at: null,
          rejected_by: null,
          result: {},
          sequence: 0,
          status: "proposed",
        },
      ],
      agent_kind: "relationship_analyst",
      capabilities: ["read_canvas_neighborhood", "propose_semantic_edges"],
      cancel_requested: false,
      citations: [],
      context: {
        canvas_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        locale: "ru",
        selected_shape_ids: ["shape:knowledge", "shape:work"],
      },
      created_at: "2026-09-21T12:00:00Z",
      error_code: "",
      error_message: "",
      finished_at: null,
      id: "11111111-1111-4111-8111-111111111111",
      model: "",
      policy_version: "ppm-agents-v1",
      provider: "",
      result: {
        action_id: "99999999-9999-4999-8999-999999999999",
        board: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Главная", version: 1 },
        canonical_changes_applied: false,
        edge: {
          board_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          from_shape_id: "shape:knowledge",
          from_title: "Основание.md",
          reason: "Материал объясняет задачу.",
          relation: "explains",
          source_ids: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
          to_shape_id: "shape:work",
          to_title: "PPM-1 · Задача",
        },
        generated_at: "2026-09-21T12:00:00Z",
        kind: "semantic_edge_proposal",
      },
      status: "awaiting_approval",
      started_at: "2026-09-21T12:00:00Z",
      updated_at: "2026-09-21T12:00:01Z",
      audit_trace: [],
    } satisfies TPpmAgentRun;
    const post = vi.spyOn(service, "post").mockResolvedValue({ data: run } as never);

    await expect(
      service.createAgentRun("workspace", "project", {
        agent_kind: "relationship_analyst",
        client_operation_id: "operation",
        context: {
          canvas_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          locale: "ru",
          selected_shape_ids: ["shape:knowledge", "shape:work"],
        },
        options: {
          from_shape_id: "shape:knowledge",
          reason: "Материал объясняет задачу.",
          relation: "explains",
          to_shape_id: "shape:work",
        },
      })
    ).resolves.toEqual(run);
    expect(post).toHaveBeenCalledWith(
      "/api/ppm/v1/workspaces/workspace/projects/project/knowledge/agents/runs/",
      expect.objectContaining({ agent_kind: "relationship_analyst" })
    );
  });

  it("cancels and retries an agent run through project-scoped endpoints", async () => {
    const service = new PpmBrainService();
    const response = { data: { id: "run-id", status: "cancelled" } };
    const post = vi.spyOn(service, "post").mockResolvedValue(response as never);

    await service.cancelAgentRun("workspace", "project", "run-id");
    expect(post).toHaveBeenLastCalledWith(
      "/api/ppm/v1/workspaces/workspace/projects/project/knowledge/agents/runs/run-id/cancel/",
      {}
    );

    await service.retryAgentRun("workspace", "project", "run-id", {
      client_operation_id: "retry-operation",
      options: { goal: "Повторить", source_id: "source-id" },
    });
    expect(post).toHaveBeenLastCalledWith(
      "/api/ppm/v1/workspaces/workspace/projects/project/knowledge/agents/runs/run-id/retry/",
      {
        client_operation_id: "retry-operation",
        options: { goal: "Повторить", source_id: "source-id" },
      }
    );
  });
});
