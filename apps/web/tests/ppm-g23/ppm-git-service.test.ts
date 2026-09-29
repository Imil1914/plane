// G2.3 (G-Web, G1/G2): PpmGitService's two new methods, strictly against the fixed contract of
// docs/superpowers/plans/2026-09-29-g23-reports/plan.md (the API is built by line G-API — answers are faked here,
// same approach as forgejo-service.test.ts). Schemas, empty/blank-query handling, and error normalization.
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PpmGitService,
  PpmGitServiceError,
  type TPpmGitSearchObject,
  type TPpmGitWorkSummary,
} from "@/services/ppm-git.service";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SEARCH_URL = `/api/ppm/v1/workspaces/${WS}/projects/${PROJECT}/git/objects/search/`;
const SUMMARY_URL = `/api/ppm/v1/workspaces/${WS}/projects/${PROJECT}/git/work-summary/`;

function httpError(status: number, error?: { code: string; message: string }) {
  const headers = new AxiosHeaders();
  const config = { headers };
  return new AxiosError(
    "Request failed",
    "ERR_BAD_RESPONSE",
    config,
    {},
    {
      status,
      statusText: "",
      headers,
      config,
      data: error ? { error } : {},
    }
  );
}

const commit: TPpmGitSearchObject = {
  id: "obj-1",
  repository_id: "repo-1",
  connection_id: "conn-1",
  object_type: "commit",
  ref: "main",
  title: "Fix bug",
  canonical_url: "https://git.example/commit/a1b2c3d",
  state: "",
  is_draft: false,
  author_name: "Ада",
  author_avatar_url: "",
  base_ref: "",
  head_ref: "",
  commit_sha: "a1b2c3d",
  is_active: true,
  provider_updated_at: "2026-09-28T10:00:00Z",
  last_seen_at: "2026-09-28T10:00:00Z",
  label: "коммит a1b2c3d «Fix bug»",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PpmGitService.searchGitObjects", () => {
  it("sends the trimmed query, type and limit, and returns the results", async () => {
    const service = new PpmGitService();
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: { results: [commit] } } as never);

    const result = await service.searchGitObjects(WS, PROJECT, { q: "  a1b2  ", type: "commit", limit: 5 });

    expect(get).toHaveBeenCalledExactlyOnceWith(SEARCH_URL, { params: { limit: 5, q: "a1b2", type: "commit" } });
    expect(result).toEqual({ results: [commit] });
  });

  it("omits q for an empty/blank query (asks for the latest objects) and defaults limit to 20", async () => {
    const service = new PpmGitService();
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: { results: [] } } as never);

    await service.searchGitObjects(WS, PROJECT);
    await service.searchGitObjects(WS, PROJECT, { q: "   " });

    expect(get).toHaveBeenNthCalledWith(1, SEARCH_URL, { params: { limit: 20 } });
    expect(get).toHaveBeenNthCalledWith(2, SEARCH_URL, { params: { limit: 20 } });
  });

  it("omits type for the 'all' case (caller passes undefined, not the string 'all')", async () => {
    const service = new PpmGitService();
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: { results: [] } } as never);

    await service.searchGitObjects(WS, PROJECT, { type: undefined });

    expect(get).toHaveBeenCalledExactlyOnceWith(SEARCH_URL, { params: { limit: 20 } });
  });

  it("does not break on a partial/malformed answer", async () => {
    const service = new PpmGitService();
    vi.spyOn(service, "get").mockResolvedValue({ data: {} } as never);

    await expect(service.searchGitObjects(WS, PROJECT)).resolves.toEqual({ results: [] });
  });

  it("normalizes a 403 GIT_PERMISSION_DENIED like the other ppm_git contract errors", async () => {
    const service = new PpmGitService();
    vi.spyOn(service, "get").mockRejectedValue(
      httpError(403, { code: "GIT_PERMISSION_DENIED", message: "Нет доступа к разделу «Код»." })
    );

    const error = await service.searchGitObjects(WS, PROJECT).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PpmGitServiceError);
    expect((error as PpmGitServiceError).code).toBe("GIT_PERMISSION_DENIED");
    expect((error as PpmGitServiceError).status).toBe(403);
    expect((error as Error).message).toBe("Нет доступа к разделу «Код».");
  });

  it("falls back to a generic Russian message when the server sent nothing usable", async () => {
    const service = new PpmGitService();
    vi.spyOn(service, "get").mockRejectedValue(httpError(500));

    const error = await service.searchGitObjects(WS, PROJECT).catch((reason: unknown) => reason);
    expect((error as Error).message).toBe("Не удалось выполнить Git-операцию.");
  });
});

describe("PpmGitService.getWorkSummary", () => {
  const workSummary: TPpmGitWorkSummary = {
    from: "2026-09-22",
    to: "2026-09-28",
    totals: { done: 3, in_progress: 1, other: 0, commits: 5, pull_requests: 2 },
    items: [],
    markdown: "# Что сделано с 22 по 28 сент. 2026",
    html: "<h3>Что сделано с 22 по 28 сент. 2026</h3>",
  };

  it("sends from/to as plain query params and returns the payload as-is", async () => {
    const service = new PpmGitService();
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: workSummary } as never);

    const result = await service.getWorkSummary(WS, PROJECT, { from: "2026-09-22", to: "2026-09-28" });

    expect(get).toHaveBeenCalledExactlyOnceWith(SUMMARY_URL, {
      params: { from: "2026-09-22", to: "2026-09-28" },
    });
    expect(result).toEqual(workSummary);
  });

  it("normalizes 400 WORK_SUMMARY_RANGE_INVALID", async () => {
    const service = new PpmGitService();
    vi.spyOn(service, "get").mockRejectedValue(
      httpError(400, { code: "WORK_SUMMARY_RANGE_INVALID", message: "Период длиннее 92 дней." })
    );

    const error = await service
      .getWorkSummary(WS, PROJECT, { from: "2026-01-01", to: "2026-12-31" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PpmGitServiceError);
    expect((error as PpmGitServiceError).code).toBe("WORK_SUMMARY_RANGE_INVALID");
    expect((error as Error).message).toBe("Период длиннее 92 дней.");
  });

  it("normalizes a network failure (no response) distinctly from a contract error", async () => {
    const service = new PpmGitService();
    const offline = new AxiosError("Network Error", "ERR_NETWORK");
    vi.spyOn(service, "get").mockRejectedValue(offline);

    const error = await service
      .getWorkSummary(WS, PROJECT, { from: "2026-09-22", to: "2026-09-28" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PpmGitServiceError);
    expect((error as PpmGitServiceError).status).toBeUndefined();
  });
});
