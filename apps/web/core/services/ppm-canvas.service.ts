import { isAxiosError } from "axios";
import { API_BASE_URL } from "@plane/constants";
import {
  ppmCanvasErrorResponseSchema,
  ppmCanvasReadResponseSchema,
  ppmCanvasSaveResponseSchema,
  type TPpmCanvasReadResponse,
  type TPpmCanvasSaveRequest,
  type TPpmCanvasSaveResponse,
} from "@ppm/canvas";
import { APIService } from "@/services/api.service";

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
      return ppmCanvasReadResponseSchema.parse(response.data);
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

  private canvasPath(workspaceId: string, projectId: string) {
    return `/api/ppm/v1/workspaces/${workspaceId}/projects/${projectId}/canvas/`;
  }
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
