// G2.1 (R10): the «Код» service talks to our Git server (Forgejo) strictly by the HTTP contract of
// docs/superpowers/plans/2026-09-28-g21-forgejo/plan.md — list with search/page, connect by the Git-server id — and
// turns every contract error into a plain Russian sentence (the API itself is built by lane A2, so answers are faked).
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPpmForgejoErrorMessage,
  PpmGitService,
  PpmGitServiceError,
  type TPpmForgejoRepository,
} from "@/services/ppm-git.service";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const REPOSITORIES = `/api/ppm/v1/workspaces/${WS}/projects/${PROJECT}/git/providers/forgejo/repositories/`;

const robot: TPpmForgejoRepository = {
  provider_repository_id: 42,
  full_name: "lab/robot",
  name: "robot",
  owner: "lab",
  description: "Прошивка манипулятора",
  private: true,
  archived: false,
  default_branch: "main",
  html_url: "https://git.ppm.example/lab/robot",
  clone_https: "https://git.ppm.example/lab/robot.git",
  clone_ssh: "ssh://git@git.ppm.example:2222/lab/robot.git",
  updated_at: "2026-09-28T10:00:00Z",
  connected: false,
};

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PpmGitService — our Git server (Forgejo)", () => {
  it("lists repositories with the trimmed search and the page", async () => {
    const service = new PpmGitService();
    const get = vi
      .spyOn(service, "get")
      .mockResolvedValue({ data: { results: [robot], page: 2, has_next: true } } as never);

    const page = await service.listForgejoRepositories(WS, PROJECT, { search: "  robot ", page: 2 });

    expect(get).toHaveBeenCalledWith(REPOSITORIES, { params: { search: "robot", page: 2 } });
    expect(page).toEqual({ results: [robot], page: 2, has_next: true });
  });

  it("asks for the first page without an empty search", async () => {
    const service = new PpmGitService();
    const get = vi
      .spyOn(service, "get")
      .mockResolvedValue({ data: { results: [], page: 1, has_next: false } } as never);

    await service.listForgejoRepositories(WS, PROJECT);
    await service.listForgejoRepositories(WS, PROJECT, { search: "   " });

    expect(get).toHaveBeenNthCalledWith(1, REPOSITORIES, { params: { page: 1 } });
    expect(get).toHaveBeenNthCalledWith(2, REPOSITORIES, { params: { page: 1 } });
  });

  it("does not break on a partial answer", async () => {
    const service = new PpmGitService();
    vi.spyOn(service, "get").mockResolvedValue({ data: {} } as never);

    await expect(service.listForgejoRepositories(WS, PROJECT, { page: 3 })).resolves.toEqual({
      results: [],
      page: 3,
      has_next: false,
    });
  });

  it("connects a repository by its Git-server id and returns the repository with its connection", async () => {
    const service = new PpmGitService();
    const answer = { repository: { id: "r-1", provider: "forgejo" }, connection: { id: "c-1" } };
    const post = vi.spyOn(service, "post").mockResolvedValue({ data: answer } as never);

    await expect(service.connectForgejoRepository(WS, PROJECT, 42)).resolves.toEqual(answer);
    expect(post).toHaveBeenCalledWith(REPOSITORIES, { provider_repository_id: 42 });
  });

  it.each([
    [403, "GIT_PERMISSION_DENIED", "Подключать репозитории может только администратор PPM"],
    [400, "FORGEJO_NOT_CONFIGURED", "Git-сервер не настроен"],
    [429, "GIT_PROVIDER_RATE_LIMITED", "Git-сервер просит подождать"],
    [502, "GIT_PROVIDER_UNAVAILABLE", "Git-сервер не отвечает"],
    [409, "GIT_REPOSITORY_CONFLICT", "Репозиторий уже подключён"],
  ])("explains HTTP %i %s in Russian for the list and for connecting", async (status, code, text) => {
    const service = new PpmGitService();
    vi.spyOn(service, "get").mockRejectedValue(httpError(status, { code, message: "Server text" }));
    vi.spyOn(service, "post").mockRejectedValue(httpError(status, { code, message: "Server text" }));

    const errors = await Promise.all(
      [
        service.listForgejoRepositories(WS, PROJECT, { search: "robot" }),
        service.connectForgejoRepository(WS, PROJECT, 42),
      ].map((call) => call.catch((reason: unknown) => reason))
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(PpmGitServiceError);
      expect(error).toMatchObject({ code, status });
      expect((error as Error).message).toContain(text);
      expect((error as Error).message).not.toContain("Server text");
    }
  });

  it("keeps the server's Russian message for other refusals and explains a lost connection", async () => {
    const service = new PpmGitService();
    vi.spyOn(service, "post").mockRejectedValueOnce(
      httpError(400, { code: "GIT_INVALID_FIELD", message: "Идентификатор некорректен." })
    );
    await expect(service.connectForgejoRepository(WS, PROJECT, 0)).rejects.toThrow("Идентификатор некорректен.");

    const offline = new AxiosError("Network Error", "ERR_NETWORK");
    vi.spyOn(service, "get").mockRejectedValueOnce(offline);
    await expect(service.listForgejoRepositories(WS, PROJECT)).rejects.toThrow("Нет связи с PPM");
  });

  it("maps by the code first: a not-configured server is not a generic 400", () => {
    expect(getPpmForgejoErrorMessage({ code: "FORGEJO_NOT_CONFIGURED", status: 400 })).toContain(
      "Git-сервер не настроен"
    );
    expect(getPpmForgejoErrorMessage({ status: 404, code: "GIT_REPOSITORY_NOT_FOUND" })).toContain(
      "не найден на Git-сервере"
    );
    expect(getPpmForgejoErrorMessage({})).toBe("Не удалось выполнить операцию с Git-сервером.");
  });
});
