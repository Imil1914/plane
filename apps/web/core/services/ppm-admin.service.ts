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

// G2.2 (R18/R19): the admin center's «Git-сервер» tab — `GET /api/ppm/v1/git/forgejo/access/status/` and
// `POST …/access/sync/` (`docs/superpowers/plans/2026-09-29-g22-sso/plan.md`, HTTP contract for web).
export const PPM_ADMIN_GIT_SERVER_SYNC_STATUSES = ["ok", "partial", "error"] as const;
export const ppmAdminGitServerSyncStatusSchema = z.enum(PPM_ADMIN_GIT_SERVER_SYNC_STATUSES);

// Review round 1 (Important #2): the plan fixes exactly these five counts — no longer an open dictionary. `.catch(0)`
// keeps the panel's five tiles rendering even if S2's answer is momentarily missing one during integration.
const ppmAdminGitServerCountsSchema = z.object({
  accounts: z.number().catch(0),
  organizations: z.number().catch(0),
  teams: z.number().catch(0),
  repositories: z.number().catch(0),
  changes: z.number().catch(0),
});

const ppmAdminGitServerLastSyncSchema = z.object({
  started_at: z.string(),
  finished_at: z.string().nullable(),
  status: ppmAdminGitServerSyncStatusSchema,
  counts: ppmAdminGitServerCountsSchema,
});

const ppmAdminGitServerProblemSchema = z.object({
  at: z.string(),
  kind: z.string(),
  subject: z.string(),
  message: z.string(),
});

export const ppmAdminGitServerStatusSchema = z.object({
  configured: z.boolean(),
  sso_enabled: z.boolean(),
  reachable: z.boolean(),
  last_full_sync: ppmAdminGitServerLastSyncSchema.nullable(),
  problems: z.array(ppmAdminGitServerProblemSchema),
  forgejo_admin_url: z.string().nullable(),
});

export const ppmAdminGitServerSyncSchema = z.object({
  scheduled: z.literal(true),
});

export type TPpmAdminGitServerSyncStatus = (typeof PPM_ADMIN_GIT_SERVER_SYNC_STATUSES)[number];
export type TPpmAdminGitServerCounts = z.infer<typeof ppmAdminGitServerCountsSchema>;
export type TPpmAdminGitServerStatus = z.infer<typeof ppmAdminGitServerStatusSchema>;
export type TPpmAdminGitServerProblem = z.infer<typeof ppmAdminGitServerProblemSchema>;

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
  /** G2.2 (R19): `details.retry_after_seconds` of a 429 on `POST …/access/sync/` (same field name as the Git
   * provider's own rate limiting, `PpmGitProviderRateLimited` — `apps/api/plane/ppm_git/providers/base.py`). */
  retryAfterSeconds?: number;

  constructor(message: string, options: { code?: string; status?: number; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "PpmAdminServiceError";
    this.code = options.code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
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

  /** G2.2 (R18): status of the OpenID Connect single sign-on and the automatic access sync to our Git server. */
  async getGitServerStatus(): Promise<TPpmAdminGitServerStatus> {
    try {
      const response = await this.get("/api/ppm/v1/git/forgejo/access/status/");
      return ppmAdminGitServerStatusSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }

  /** G2.2 (R18/R19): «Синхронизировать сейчас» — 202 once scheduled, 429 (`retryAfterSeconds`) at most once per 30 s. */
  async syncGitServerNow(): Promise<z.infer<typeof ppmAdminGitServerSyncSchema>> {
    try {
      const response = await this.post("/api/ppm/v1/git/forgejo/access/sync/");
      return ppmAdminGitServerSyncSchema.parse(response.data);
    } catch (error) {
      throw normalizeAdminError(error);
    }
  }
}

function normalizeAdminError(error: unknown): PpmAdminServiceError {
  if (error instanceof PpmAdminServiceError) return error;
  if (isAxiosError(error)) {
    const payload = error.response?.data as
      | { error?: { code?: unknown; message?: unknown; details?: unknown } }
      | { detail?: unknown }
      | undefined;
    const nested = payload && "error" in payload ? payload.error : undefined;
    const message =
      nested && typeof nested.message === "string"
        ? nested.message
        : payload && "detail" in payload && typeof payload.detail === "string"
          ? payload.detail
          : "Центр администратора временно недоступен.";
    // G2.2 review round 1 (#6): `POST …/access/sync/` answers a too-early retry with 429, code `GIT_SYNC_RATE_LIMITED`
    // and `details.retry_after_seconds` (the plan's fixed contract) — with the HTTP `Retry-After` header as the
    // documented fallback if `details` is ever missing it. Anything else (neither present, or not a finite number)
    // leaves `retryAfterSeconds` undefined.
    const details = nested && typeof nested === "object" ? (nested as { details?: unknown }).details : undefined;
    const retryAfterRaw =
      details && typeof details === "object" && details !== null
        ? (details as { retry_after_seconds?: unknown }).retry_after_seconds
        : undefined;
    const retryAfterHeaderRaw = getRetryAfterHeader(error.response?.headers);
    const retryAfterHeader = retryAfterHeaderRaw === undefined ? undefined : Number(retryAfterHeaderRaw);
    const retryAfterSeconds =
      (typeof retryAfterRaw === "number" && Number.isFinite(retryAfterRaw) ? retryAfterRaw : undefined) ??
      (retryAfterHeader !== undefined && Number.isFinite(retryAfterHeader) ? retryAfterHeader : undefined);
    return new PpmAdminServiceError(message, {
      code: nested && typeof nested.code === "string" ? nested.code : undefined,
      status: error.response?.status,
      retryAfterSeconds,
    });
  }
  return new PpmAdminServiceError(error instanceof Error ? error.message : "Неизвестная ошибка центра администратора.");
}

/** `error.response.headers` is an `AxiosHeaders` instance in the real client (`.get`) or a plain object in a test
 * fixture — reads `Retry-After` either way, case-insensitively (`AxiosHeaders` already normalizes; a plain object
 * fixture is expected lower-case, matching how HTTP headers arrive). */
function getRetryAfterHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if ("get" in headers && typeof (headers as { get: unknown }).get === "function") {
    const value = (headers as { get: (name: string) => unknown }).get("retry-after");
    return typeof value === "string" ? value : undefined;
  }
  const value = (headers as Record<string, unknown>)["retry-after"];
  return typeof value === "string" ? value : undefined;
}
