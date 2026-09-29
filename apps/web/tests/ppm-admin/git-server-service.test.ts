// G2.2 (R18/R19): the admin center's «Git-сервер» tab talks to the status/sync API strictly by the HTTP contract of
// docs/superpowers/plans/2026-09-29-g22-sso/plan.md (that API is built by line S2b — answers are faked here, as
// forgejo-service.test.ts already does for the sibling «Код» service). Review round 1 (Important #2): `counts` is
// the plan's fixed five fields (`accounts`/`organizations`/`teams`/`repositories`/`changes`), not an open
// dictionary. Round 2 (reconciled with S2b, live-stack E): each one is `number | null` — `null` means "the sync
// engine does not know this number yet", not zero (`ppm-git-server-status.helper.ts`'s `formatCount` shows «—» for
// it) — `.catch(null)` treats anything else unexpected (wrong type, or momentarily missing) the same honest way.
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ppmAdminGitServerStatusSchema,
  ppmAdminGitServerSyncSchema,
  PpmAdminService,
  PpmAdminServiceError,
} from "@/services/ppm-admin.service";

function httpError(status: number, data: unknown) {
  const headers = new AxiosHeaders();
  const config = { headers };
  return new AxiosError(
    "Request failed",
    "ERR_BAD_RESPONSE",
    config,
    {},
    { status, statusText: "", headers, config, data }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PPM Git-server status contract", () => {
  it("accepts a healthy status with a completed full sync and its five fixed counts", () => {
    const result = ppmAdminGitServerStatusSchema.parse({
      configured: true,
      sso_enabled: true,
      reachable: true,
      last_full_sync: {
        started_at: "2026-09-29T02:00:00+03:00",
        finished_at: "2026-09-29T02:00:07+03:00",
        status: "ok",
        counts: { accounts: 12, organizations: 3, teams: 9, repositories: 21, changes: 4 },
      },
      problems: [],
      forgejo_admin_url: "https://git.ppm.example/-/admin",
    });
    expect(result.last_full_sync?.counts).toEqual({
      accounts: 12,
      organizations: 3,
      teams: 9,
      repositories: 21,
      changes: 4,
    });
  });

  it("accepts an explicit null count — unknown, not zero", () => {
    const result = ppmAdminGitServerStatusSchema.parse({
      configured: true,
      sso_enabled: true,
      reachable: true,
      last_full_sync: {
        started_at: "2026-09-29T02:00:00+03:00",
        finished_at: "2026-09-29T02:00:07+03:00",
        status: "partial",
        counts: { accounts: 12, organizations: null, teams: 9, repositories: 21, changes: 4 },
      },
      problems: [],
      forgejo_admin_url: null,
    });
    expect(result.last_full_sync?.counts.organizations).toBeNull();
  });

  it("a count the answer left out reads as null (unknown), not 0, instead of failing the whole status", () => {
    const result = ppmAdminGitServerStatusSchema.parse({
      configured: true,
      sso_enabled: true,
      reachable: true,
      last_full_sync: {
        started_at: "2026-09-29T02:00:00+03:00",
        finished_at: "2026-09-29T02:00:07+03:00",
        status: "ok",
        counts: { accounts: 12 },
      },
      problems: [],
      forgejo_admin_url: null,
    });
    expect(result.last_full_sync?.counts).toEqual({
      accounts: 12,
      organizations: null,
      teams: null,
      repositories: null,
      changes: null,
    });
  });

  it("accepts an un-synced instance (null last_full_sync, no problems yet)", () => {
    const result = ppmAdminGitServerStatusSchema.parse({
      configured: false,
      sso_enabled: false,
      reachable: false,
      last_full_sync: null,
      problems: [],
      forgejo_admin_url: null,
    });
    expect(result.last_full_sync).toBeNull();
  });

  it("accepts a problem list up to the documented 50, each with who/what, a Russian message and a time", () => {
    const problems = Array.from({ length: 50 }, (_, index) => ({
      at: "2026-09-29T02:00:00+03:00",
      kind: "user",
      subject: `person-${index}@ppm.example`,
      message: "Не удалось создать учётку: имя уже занято.",
    }));
    expect(
      ppmAdminGitServerStatusSchema.parse({
        configured: true,
        sso_enabled: true,
        reachable: true,
        last_full_sync: null,
        problems,
        forgejo_admin_url: null,
      }).problems
    ).toHaveLength(50);
  });

  it("rejects an unknown sync outcome", () => {
    expect(() =>
      ppmAdminGitServerStatusSchema.parse({
        configured: true,
        sso_enabled: true,
        reachable: true,
        problems: [],
        forgejo_admin_url: null,
        last_full_sync: { started_at: "2026-09-29T02:00:00Z", finished_at: null, status: "running", counts: {} },
      })
    ).toThrow();
  });

  it("a count that is neither a number nor null reads as null (unknown) rather than failing the whole status", () => {
    const result = ppmAdminGitServerStatusSchema.parse({
      configured: true,
      sso_enabled: true,
      reachable: true,
      problems: [],
      forgejo_admin_url: null,
      last_full_sync: {
        started_at: "2026-09-29T02:00:00Z",
        finished_at: "2026-09-29T02:00:01Z",
        status: "ok",
        counts: { accounts: "12", organizations: 3, teams: 9, repositories: 21, changes: 4 },
      },
    });
    expect(result.last_full_sync?.counts.accounts).toBeNull();
    expect(result.last_full_sync?.counts.organizations).toBe(3);
  });

  it("the sync trigger accepts only the documented 202 shape", () => {
    expect(ppmAdminGitServerSyncSchema.parse({ scheduled: true })).toEqual({ scheduled: true });
    expect(() => ppmAdminGitServerSyncSchema.parse({ scheduled: false })).toThrow();
  });
});

describe("PpmAdminService — Git server status/sync", () => {
  it("calls the exact documented endpoints and returns the parsed body", async () => {
    const service = new PpmAdminService();
    const status = {
      configured: true,
      sso_enabled: true,
      reachable: true,
      last_full_sync: null,
      problems: [],
      forgejo_admin_url: "https://git.ppm.example/-/admin",
    };
    const get = vi.spyOn(service, "get").mockResolvedValue({ data: status } as never);
    await expect(service.getGitServerStatus()).resolves.toEqual(status);
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/ppm/v1/git/forgejo/access/status/");

    const post = vi.spyOn(service, "post").mockResolvedValue({ data: { scheduled: true } } as never);
    await expect(service.syncGitServerNow()).resolves.toEqual({ scheduled: true });
    expect(post).toHaveBeenCalledExactlyOnceWith("/api/ppm/v1/git/forgejo/access/sync/");
  });

  it("only a global administrator may load or trigger — 403 GIT_PERMISSION_DENIED in Russian", async () => {
    const service = new PpmAdminService();
    vi.spyOn(service, "get").mockRejectedValue(
      httpError(403, {
        error: { code: "GIT_PERMISSION_DENIED", message: "Доступно только глобальному администратору." },
      })
    );
    await expect(service.getGitServerStatus()).rejects.toMatchObject({
      code: "GIT_PERMISSION_DENIED",
      status: 403,
      message: "Доступно только глобальному администратору.",
    });
  });

  it("a too-early «Синхронизировать сейчас» answers 429 GIT_SYNC_RATE_LIMITED with retryAfterSeconds (the plan's fixed contract)", async () => {
    const service = new PpmAdminService();
    vi.spyOn(service, "post").mockRejectedValue(
      httpError(429, {
        error: {
          code: "GIT_SYNC_RATE_LIMITED",
          message: "Синхронизация уже недавно запускалась.",
          details: { retry_after_seconds: 17 },
        },
      })
    );
    const error = await service.syncGitServerNow().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PpmAdminServiceError);
    expect((error as PpmAdminServiceError).code).toBe("GIT_SYNC_RATE_LIMITED");
    expect((error as PpmAdminServiceError).status).toBe(429);
    expect((error as PpmAdminServiceError).retryAfterSeconds).toBe(17);
  });

  it("round 1 (#6): falls back to the Retry-After header when details.retry_after_seconds is missing", async () => {
    const service = new PpmAdminService();
    const headers = new AxiosHeaders();
    headers.set("Retry-After", "42");
    const config = { headers };
    vi.spyOn(service, "post").mockRejectedValue(
      new AxiosError(
        "Request failed",
        "ERR_BAD_RESPONSE",
        config,
        {},
        {
          status: 429,
          statusText: "",
          headers,
          config,
          data: { error: { code: "GIT_SYNC_RATE_LIMITED", message: "Синхронизация уже недавно запускалась." } },
        }
      )
    );
    const error = (await service.syncGitServerNow().catch((reason: unknown) => reason)) as PpmAdminServiceError;
    expect(error.retryAfterSeconds).toBe(42);
  });

  it("details.retry_after_seconds wins over the Retry-After header when both are present", async () => {
    const service = new PpmAdminService();
    const headers = new AxiosHeaders();
    headers.set("Retry-After", "99");
    const config = { headers };
    vi.spyOn(service, "post").mockRejectedValue(
      new AxiosError(
        "Request failed",
        "ERR_BAD_RESPONSE",
        config,
        {},
        {
          status: 429,
          statusText: "",
          headers,
          config,
          data: {
            error: {
              code: "GIT_SYNC_RATE_LIMITED",
              message: "m",
              details: { retry_after_seconds: 5 },
            },
          },
        }
      )
    );
    const error = (await service.syncGitServerNow().catch((reason: unknown) => reason)) as PpmAdminServiceError;
    expect(error.retryAfterSeconds).toBe(5);
  });

  it("leaves retryAfterSeconds undefined without a numeric details.retry_after_seconds", async () => {
    const service = new PpmAdminService();
    vi.spyOn(service, "post")
      .mockRejectedValueOnce(httpError(429, { error: { code: "X", message: "m" } }))
      .mockRejectedValueOnce(
        httpError(429, { error: { code: "X", message: "m", details: { retry_after_seconds: "soon" } } })
      );
    const noDetails = (await service.syncGitServerNow().catch((reason: unknown) => reason)) as PpmAdminServiceError;
    expect(noDetails.retryAfterSeconds).toBeUndefined();

    const notNumeric = (await service.syncGitServerNow().catch((reason: unknown) => reason)) as PpmAdminServiceError;
    expect(notNumeric.retryAfterSeconds).toBeUndefined();
  });
});
