import { isAxiosError } from "axios";
import { z } from "zod";
import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

const nullableIsoDateSchema = z.string().datetime({ offset: true }).nullable();

export const ppmAdminAccessSchema = z.object({
  is_global_admin: z.boolean(),
  role: z.literal("ppm_global_admin").nullable(),
  granted_at: nullableIsoDateSchema,
  reauthenticated_until: nullableIsoDateSchema,
});

const paginationSchema = z.object({
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  has_next: z.boolean(),
});

const projectIntegrationSchema = z.object({
  status: z.string(),
  available: z.boolean().optional(),
  active_boards: z.number().int().nonnegative().optional(),
  archived_boards: z.number().int().nonnegative().optional(),
  current_version: z.number().int().nonnegative().optional(),
});

export const ppmAdminProjectSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string(),
  identifier: z.string(),
  workspace: z.object({
    workspace_id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
  }),
  lead: z
    .object({
      user_id: z.string().uuid(),
      display_name: z.string(),
      email: z.string().nullable(),
    })
    .nullable(),
  member_count: z.number().int().nonnegative(),
  status: z.enum(["active", "archived"]),
  updated_at: z.string().datetime({ offset: true }),
  integrations: z.object({
    canvas: projectIntegrationSchema,
    vault: projectIntegrationSchema,
    brain: projectIntegrationSchema,
    git: projectIntegrationSchema,
  }),
});

export const ppmAdminProjectsResponseSchema = z.object({
  results: z.array(ppmAdminProjectSchema),
  pagination: paginationSchema,
});

export const ppmAdminUserSchema = z.object({
  user_id: z.string().uuid(),
  display_name: z.string(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  is_active: z.boolean(),
  is_bot: z.boolean(),
  is_global_admin: z.boolean(),
  workspace_count: z.number().int().nonnegative(),
  project_count: z.number().int().nonnegative(),
  last_active: nullableIsoDateSchema,
});

export const ppmAdminUsersResponseSchema = z.object({
  results: z.array(ppmAdminUserSchema),
  pagination: paginationSchema,
});

export const ppmAdminAuditSchema = z.object({
  audit_id: z.string().uuid(),
  action: z.string(),
  actor: z.object({
    user_id: z.string().uuid(),
    display_name: z.string(),
    email: z.string().nullable(),
  }),
  workspace_id: z.string().uuid().nullable(),
  project_id: z.string().uuid().nullable(),
  method: z.string(),
  path: z.string(),
  request_id: z.string().uuid(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime({ offset: true }),
});

export const ppmAdminAuditResponseSchema = z.object({
  results: z.array(ppmAdminAuditSchema),
  pagination: paginationSchema,
});

export const ppmAdminEnterProjectSchema = z.object({
  project_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  workspace_slug: z.string(),
  admin_mode: z.literal(true),
  navigation_url: z.string().startsWith("/"),
});

export const ppmAdminReauthSchema = z.object({
  reauthenticated: z.literal(true),
  reauthenticated_until: z.string().datetime({ offset: true }),
});

export type TPpmAdminAccess = z.infer<typeof ppmAdminAccessSchema>;
export type TPpmAdminProject = z.infer<typeof ppmAdminProjectSchema>;
export type TPpmAdminProjectsResponse = z.infer<typeof ppmAdminProjectsResponseSchema>;
export type TPpmAdminUser = z.infer<typeof ppmAdminUserSchema>;
export type TPpmAdminUsersResponse = z.infer<typeof ppmAdminUsersResponseSchema>;
export type TPpmAdminAudit = z.infer<typeof ppmAdminAuditSchema>;
export type TPpmAdminAuditResponse = z.infer<typeof ppmAdminAuditResponseSchema>;

export class PpmAdminServiceError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "PpmAdminServiceError";
    this.code = options.code;
    this.status = options.status;
  }
}

export class PpmAdminService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getAccess(): Promise<TPpmAdminAccess> {
    try {
      const response = await this.get("/api/ppm/v1/admin/access/");
      return ppmAdminAccessSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async getProjects(query = "", page = 1): Promise<TPpmAdminProjectsResponse> {
    try {
      const response = await this.get("/api/ppm/v1/admin/projects/", {
        params: { q: query, page, page_size: 25 },
      });
      return ppmAdminProjectsResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async getUsers(query = "", page = 1): Promise<TPpmAdminUsersResponse> {
    try {
      const response = await this.get("/api/ppm/v1/admin/users/", {
        params: { q: query, page, page_size: 25 },
      });
      return ppmAdminUsersResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async getAudit(page = 1): Promise<TPpmAdminAuditResponse> {
    try {
      const response = await this.get("/api/ppm/v1/admin/audit/", {
        params: { page, page_size: 25 },
      });
      return ppmAdminAuditResponseSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async enterProject(projectId: string): Promise<z.infer<typeof ppmAdminEnterProjectSchema>> {
    try {
      const response = await this.post(`/api/ppm/v1/admin/projects/${projectId}/enter/`);
      return ppmAdminEnterProjectSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  async reauthenticate(password: string): Promise<z.infer<typeof ppmAdminReauthSchema>> {
    try {
      const response = await this.post("/api/ppm/v1/admin/reauthenticate/", { password });
      return ppmAdminReauthSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }
}

function normalizeAdminError(error: unknown): PpmAdminServiceError {
  if (error instanceof PpmAdminServiceError) return error;
  if (isAxiosError(error)) {
    const payload = error.response?.data as
      | { error?: { code?: unknown; message?: unknown } }
      | { detail?: unknown }
      | undefined;
    const nested = payload && "error" in payload ? payload.error : undefined;
    const message =
      nested && typeof nested.message === "string"
        ? nested.message
        : payload && "detail" in payload && typeof payload.detail === "string"
          ? payload.detail
          : "Центр администратора временно недоступен.";
    return new PpmAdminServiceError(message, {
      code: nested && typeof nested.code === "string" ? nested.code : undefined,
      status: error.response?.status,
    });
  }
  return new PpmAdminServiceError(error instanceof Error ? error.message : "Неизвестная ошибка центра администратора.");
}
