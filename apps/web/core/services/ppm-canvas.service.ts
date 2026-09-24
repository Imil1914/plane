import { isAxiosError } from "axios";
import { API_BASE_URL } from "@plane/constants";
import {
  ppmCanvasBindingMutationResponseSchema,
  ppmCanvasBindingsResponseSchema,
  ppmCanvasBoardMutationResponseSchema,
  ppmCanvasBoardVersionResponseSchema,
  ppmCanvasBoardsReorderResponseSchema,
  ppmCanvasBoardsResponseSchema,
  ppmCanvasErrorResponseSchema,
  ppmCanvasReadResponseSchema,
  ppmCanvasSaveResponseSchema,
  ppmCanvasSemanticEdgeMutationResponseSchema,
  ppmCanvasSemanticEdgesResponseSchema,
  ppmProjectionSearchResponseSchema,
  ppmWorkItemViewCreateResponseSchema,
  ppmWorkItemProjectionSchema,
  ppmWorkItemsViewResponseSchema,
  type TPpmCanvasBindingCreateRequest,
  type TPpmCanvasBindingsResponse,
  type TPpmCanvasContentBinding,
  type TPpmCanvasGitBinding,
  type TPpmCanvasBoardMutationResponse,
  type TPpmCanvasBoardVersionResponse,
  type TPpmCanvasBoardsReorderResponse,
  type TPpmCanvasBoardsResponse,
  type TPpmCanvasReadResponse,
  type TPpmCanvasSaveRequest,
  type TPpmCanvasSaveResponse,
  type TPpmCanvasSemanticEdge,
  type TPpmCanvasSemanticEdgeCreateRequest,
  type TPpmCanvasSemanticEdgePatchRequest,
  type TPpmCanvasSemanticEdgesResponse,
  type TPpmProjectionSearchResponse,
  type TPpmWorkItemCreateRequest,
  type TPpmCanvasWorkItemBinding,
  type TPpmWorkItemViewCreateRequest,
  type TPpmWorkItemPatchRequest,
  type TPpmWorkItemProjection,
  type TPpmWorkItemsViewQuery,
  type TPpmWorkItemsViewResponse,
} from "@ppm/canvas";
import { APIService } from "@/services/api.service";

const PPM_ASSET_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || API_BASE_URL;

export class PpmCanvasServiceError extends Error {
  code?: string;
  details: Record<string, unknown>;
  requestId?: string;
  status?: number;

  constructor(
    message: string,
    options: { code?: string; details?: Record<string, unknown>; requestId?: string; status?: number } = {}
  ) {
    super(message);
    this.name = "PpmCanvasServiceError";
    this.code = options.code;
    this.details = options.details ?? {};
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

export class PpmCanvasService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getCanvas(workspaceId: string, projectId: string): Promise<TPpmCanvasReadResponse> {
    try {
      const response = await this.get(this.canvasPath(workspaceId, projectId));
      return normalizeCanvasReadResponse(ppmCanvasReadResponseSchema.parse(response.data));
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async getBoards(workspaceId: string, projectId: string, includeArchived = false): Promise<TPpmCanvasBoardsResponse> {
    try {
      const response = await this.get(this.boardsPath(workspaceId, projectId), {
        params: includeArchived ? { include_archived: "true" } : undefined,
      });
      return ppmCanvasBoardsResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async getBoard(workspaceId: string, projectId: string, boardId: string): Promise<TPpmCanvasReadResponse> {
    try {
      const response = await this.get(this.boardPath(workspaceId, projectId, boardId));
      return normalizeCanvasReadResponse(ppmCanvasReadResponseSchema.parse(response.data));
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async getBoardVersion(
    workspaceId: string,
    projectId: string,
    boardId: string,
    version: number
  ): Promise<TPpmCanvasBoardVersionResponse> {
    try {
      const response = await this.get(`${this.boardPath(workspaceId, projectId, boardId)}versions/${version}/`);
      return ppmCanvasBoardVersionResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async createBoard(workspaceId: string, projectId: string, name: string): Promise<TPpmCanvasBoardMutationResponse> {
    try {
      const response = await this.post(this.boardsPath(workspaceId, projectId), {
        name,
        client_operation_id: crypto.randomUUID(),
      });
      return ppmCanvasBoardMutationResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async renameBoard(
    workspaceId: string,
    projectId: string,
    boardId: string,
    name: string
  ): Promise<TPpmCanvasBoardMutationResponse> {
    try {
      const response = await this.patch(this.boardPath(workspaceId, projectId, boardId), {
        name,
        client_operation_id: crypto.randomUUID(),
      });
      return ppmCanvasBoardMutationResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async duplicateBoard(
    workspaceId: string,
    projectId: string,
    boardId: string,
    name?: string
  ): Promise<TPpmCanvasBoardMutationResponse> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}duplicate/`, {
        ...(name?.trim() ? { name: name.trim() } : {}),
        client_operation_id: crypto.randomUUID(),
      });
      return ppmCanvasBoardMutationResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async archiveBoard(
    workspaceId: string,
    projectId: string,
    boardId: string
  ): Promise<TPpmCanvasBoardMutationResponse> {
    return this.runBoardOperation(workspaceId, projectId, boardId, "archive");
  }

  async restoreBoard(
    workspaceId: string,
    projectId: string,
    boardId: string
  ): Promise<TPpmCanvasBoardMutationResponse> {
    return this.runBoardOperation(workspaceId, projectId, boardId, "restore");
  }

  async reorderBoards(
    workspaceId: string,
    projectId: string,
    boardIds: string[]
  ): Promise<TPpmCanvasBoardsReorderResponse> {
    try {
      const response = await this.post(`${this.boardsPath(workspaceId, projectId)}reorder/`, {
        board_ids: boardIds,
        client_operation_id: crypto.randomUUID(),
      });
      return ppmCanvasBoardsReorderResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async saveCanvas(
    workspaceId: string,
    projectId: string,
    request: TPpmCanvasSaveRequest
  ): Promise<TPpmCanvasSaveResponse> {
    try {
      const response = await this.put(this.canvasPath(workspaceId, projectId), request, {
        headers: { "X-Request-ID": crypto.randomUUID() },
      });
      return ppmCanvasSaveResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async saveBoard(
    workspaceId: string,
    projectId: string,
    boardId: string,
    request: TPpmCanvasSaveRequest
  ): Promise<TPpmCanvasSaveResponse> {
    try {
      const response = await this.put(`${this.boardPath(workspaceId, projectId, boardId)}snapshot/`, request, {
        headers: { "X-Request-ID": crypto.randomUUID() },
      });
      return ppmCanvasSaveResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async getBindings(workspaceId: string, projectId: string, boardId?: string): Promise<TPpmCanvasBindingsResponse> {
    try {
      const response = await this.get(
        boardId
          ? `${this.boardPath(workspaceId, projectId, boardId)}bindings/`
          : `${this.canvasPath(workspaceId, projectId)}bindings/`
      );
      const parsed = ppmCanvasBindingsResponseSchema.parse(response.data);
      return {
        ...parsed,
        bindings: parsed.bindings.map((binding) =>
          isContentBinding(binding) ? normalizeContentBindingUrls(binding) : binding
        ),
      };
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async searchWorkItems(
    workspaceId: string,
    projectId: string,
    query: string,
    cursor?: string,
    limit = 20
  ): Promise<TPpmProjectionSearchResponse> {
    try {
      const response = await this.get(`${this.projectPath(workspaceId, projectId)}/projections/search/`, {
        params: { types: "work_item", q: query, cursor, limit },
      });
      return ppmProjectionSearchResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async bindWorkItem(
    workspaceId: string,
    projectId: string,
    boardId: string,
    request: TPpmCanvasBindingCreateRequest
  ): Promise<TPpmCanvasWorkItemBinding & { idempotent_replay: boolean }> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}bindings/`, request);
      const binding = ppmCanvasBindingMutationResponseSchema.parse(response.data);
      if (binding.entity_type !== "work_item") throw new Error("Expected a work item binding.");
      return binding;
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async bindContent(
    workspaceId: string,
    projectId: string,
    boardId: string,
    request: TPpmCanvasBindingCreateRequest
  ): Promise<TPpmCanvasContentBinding & { idempotent_replay: boolean }> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}bindings/`, request);
      const binding = ppmCanvasBindingMutationResponseSchema.parse(response.data);
      if (!isContentBinding(binding)) throw new Error("Expected a content binding.");
      return normalizeContentBindingUrls(binding);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async bindGit(
    workspaceId: string,
    projectId: string,
    boardId: string,
    request: TPpmCanvasBindingCreateRequest
  ): Promise<TPpmCanvasGitBinding & { idempotent_replay: boolean }> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}bindings/`, request);
      const binding = ppmCanvasBindingMutationResponseSchema.parse(response.data);
      if (!isGitBinding(binding)) throw new Error("Expected a Git binding.");
      return binding;
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async createWorkItem(
    workspaceId: string,
    projectId: string,
    boardId: string,
    request: TPpmWorkItemCreateRequest
  ): Promise<TPpmCanvasWorkItemBinding & { idempotent_replay: boolean }> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}work-items/`, request);
      const binding = ppmCanvasBindingMutationResponseSchema.parse(response.data);
      if (binding.entity_type !== "work_item") throw new Error("Expected a work item binding.");
      return binding;
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async updateWorkItem(
    workspaceId: string,
    projectId: string,
    entityId: string,
    request: TPpmWorkItemPatchRequest
  ): Promise<TPpmWorkItemProjection> {
    try {
      const response = await this.patch(`${this.projectPath(workspaceId, projectId)}/work-items/${entityId}/`, request);
      return ppmWorkItemProjectionSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async getWorkItemsView(
    workspaceId: string,
    projectId: string,
    boardId: string,
    query: TPpmWorkItemsViewQuery
  ): Promise<TPpmWorkItemsViewResponse> {
    try {
      const response = await this.get(`${this.boardPath(workspaceId, projectId, boardId)}work-items-view/`, {
        params: workItemsViewParams(query),
      });
      return ppmWorkItemsViewResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async createWorkItemFromView(
    workspaceId: string,
    projectId: string,
    boardId: string,
    request: TPpmWorkItemViewCreateRequest
  ): Promise<TPpmWorkItemProjection> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}work-items-view/`, request);
      return ppmWorkItemViewCreateResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async exportWorkItemsView(
    workspaceId: string,
    projectId: string,
    boardId: string,
    format: "csv" | "markdown",
    query: TPpmWorkItemsViewQuery
  ): Promise<{ blob: Blob; filename: string }> {
    try {
      const response = await this.get(
        `${this.boardPath(workspaceId, projectId, boardId)}work-items-view/export/${format}/`,
        { params: workItemsViewParams(query), responseType: "blob" }
      );
      const fallback = format === "csv" ? "ppm-work-items.csv" : "ppm-work-items.md";
      const disposition = String(response.headers?.["content-disposition"] ?? "");
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? fallback;
      return { blob: response.data as Blob, filename };
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async cancelPendingBinding(
    workspaceId: string,
    projectId: string,
    boardId: string,
    bindingId: string
  ): Promise<void> {
    try {
      await this.delete(`${this.boardPath(workspaceId, projectId, boardId)}bindings/${bindingId}/`);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async getSemanticEdges(
    workspaceId: string,
    projectId: string,
    boardId: string
  ): Promise<TPpmCanvasSemanticEdgesResponse> {
    try {
      const response = await this.get(`${this.boardPath(workspaceId, projectId, boardId)}semantic-edges/`);
      return ppmCanvasSemanticEdgesResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async createSemanticEdge(
    workspaceId: string,
    projectId: string,
    boardId: string,
    request: TPpmCanvasSemanticEdgeCreateRequest
  ): Promise<TPpmCanvasSemanticEdge> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}semantic-edges/`, request);
      return ppmCanvasSemanticEdgeMutationResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async updateSemanticEdge(
    workspaceId: string,
    projectId: string,
    boardId: string,
    edgeId: string,
    request: TPpmCanvasSemanticEdgePatchRequest
  ): Promise<TPpmCanvasSemanticEdge> {
    try {
      const response = await this.patch(
        `${this.boardPath(workspaceId, projectId, boardId)}semantic-edges/${edgeId}/`,
        request
      );
      return ppmCanvasSemanticEdgeMutationResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  async deleteSemanticEdge(workspaceId: string, projectId: string, boardId: string, edgeId: string): Promise<void> {
    try {
      await this.delete(`${this.boardPath(workspaceId, projectId, boardId)}semantic-edges/${edgeId}/`);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  private canvasPath(workspaceId: string, projectId: string) {
    return `${this.projectPath(workspaceId, projectId)}/canvas/`;
  }

  private boardsPath(workspaceId: string, projectId: string) {
    return `${this.canvasPath(workspaceId, projectId)}boards/`;
  }

  private boardPath(workspaceId: string, projectId: string, boardId: string) {
    return `${this.boardsPath(workspaceId, projectId)}${boardId}/`;
  }

  private async runBoardOperation(
    workspaceId: string,
    projectId: string,
    boardId: string,
    operation: "archive" | "restore"
  ): Promise<TPpmCanvasBoardMutationResponse> {
    try {
      const response = await this.post(`${this.boardPath(workspaceId, projectId, boardId)}${operation}/`, {
        client_operation_id: crypto.randomUUID(),
      });
      return ppmCanvasBoardMutationResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeCanvasError(error);
    }
  }

  private projectPath(workspaceId: string, projectId: string) {
    return `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}`;
  }
}

function workItemsViewParams(query: TPpmWorkItemsViewQuery) {
  return {
    q: query.query || undefined,
    cursor: query.cursor,
    limit: query.limit,
    state_ids: query.state_ids.join(",") || undefined,
    priorities: query.priorities.join(",") || undefined,
    assignee_ids: query.assignee_ids.join(",") || undefined,
    include_archived: query.include_archived ? "true" : undefined,
    sort: query.sort,
  };
}

function normalizeContentBindingUrls<T extends TPpmCanvasContentBinding>(binding: T): T {
  const previewUrl = binding.source.display.preview_url;
  if (!previewUrl || /^https?:\/\//i.test(previewUrl)) return binding;

  const baseUrl = PPM_ASSET_API_BASE_URL.replace(/\/$/, "");
  const normalizedUrl = `${baseUrl}${previewUrl.startsWith("/") ? "" : "/"}${previewUrl}`;
  return {
    ...binding,
    source: {
      ...binding.source,
      display: {
        ...binding.source.display,
        preview_url: normalizedUrl,
      },
    },
  };
}

function isContentBinding(binding: { entity_type: string }): binding is TPpmCanvasContentBinding {
  return ["page", "attachment", "vault_file"].includes(binding.entity_type);
}

function isGitBinding(binding: { entity_type: string }): binding is TPpmCanvasGitBinding {
  return ["repository", "branch", "commit", "pull_request"].includes(binding.entity_type);
}

function normalizeCanvasReadResponse(response: TPpmCanvasReadResponse): TPpmCanvasReadResponse {
  return {
    ...response,
    bindings: response.bindings.map((binding) =>
      isContentBinding(binding) ? normalizeContentBindingUrls(binding) : binding
    ),
  };
}

function normalizeCanvasError(error: unknown): PpmCanvasServiceError {
  if (error instanceof PpmCanvasServiceError) return error;
  if (isAxiosError(error)) {
    const parsed = ppmCanvasErrorResponseSchema.safeParse(error.response?.data);
    if (parsed.success) {
      return new PpmCanvasServiceError(parsed.data.error.message, {
        code: parsed.data.error.code,
        details: parsed.data.error.details,
        requestId: parsed.data.error.request_id,
        status: error.response?.status,
      });
    }
    return new PpmCanvasServiceError("Canvas request failed.", { status: error.response?.status });
  }
  return new PpmCanvasServiceError(error instanceof Error ? error.message : "Canvas request failed.");
}
