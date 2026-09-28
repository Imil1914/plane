// G2.1 (R11): «Код» names the provider of each repository and connection — «GitHub» or «Наш Git-сервер» — and
// speaks neutrally («Git-сервер») where the text is about a connected repository in general. GitHub-only flows
// (GitHub App installation, the G1.3 write flow) keep «GitHub» and see only GitHub connections.
import { describe, expect, it } from "vitest";
import {
  getActiveGithubInstallation,
  getActiveGithubRepositories,
  getGitCodeSearchConnectHint,
  getGitConnectionStatusLabel,
  getGitProviderLabel,
  getGitRepositoryOpenLabel,
  getGitSecurityNote,
  getPpmGitServer,
  PPM_GIT_MANUAL_PROVIDERS,
  safeGitWebUrl,
  splitGitConnectionsByProvider,
} from "@/components/ppm-git/git-provider-labels";
import type {
  TPpmGitConnection,
  TPpmGitInstallation,
  TPpmGitOverview,
  TPpmGitRepository,
} from "@/services/ppm-git.service";

const LEGACY_SECURITY_NOTE =
  "PPM не сохраняет токены: для каждого запроса берётся краткоживущий доступ только к выбранному репозиторию — на " +
  "чтение, а для подтверждённой ветки или черновика PR — на запись. При включённом поиске индексируются только " +
  "разрешённые текстовые файлы точного коммита; секреты, зависимости и двоичные файлы отбрасываются. Коммиты и push " +
  "выполняются обычным Git, слияние (merge) — только в GitHub.";

function installation(id: string, provider: TPpmGitInstallation["provider"], status = "active"): TPpmGitInstallation {
  return {
    id,
    provider,
    account_login: provider === "github" ? "lab-org" : "ppm-bot",
    account_type: "Organization",
    repository_selection: "selected",
    permissions: {},
    events: [],
    status: status as TPpmGitInstallation["status"],
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
  };
}

function repository(id: string, provider: TPpmGitRepository["provider"]): TPpmGitRepository {
  return {
    id,
    name: id,
    provider,
    provider_repository_id: 1,
    provider_full_name: `lab/${id}`,
    canonical_url: `https://git.ppm.example/lab/${id}`,
    clone_https: `https://git.ppm.example/lab/${id}.git`,
    clone_ssh: "",
    default_branch: "main",
    visibility: "private",
    is_default: false,
    status: "active",
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
    code_index: {
      enabled: false,
      branch: "main",
      include_paths: [],
      exclude_paths: [],
      limits: { max_files: 1, max_file_bytes: 1, max_total_bytes: 1 },
      snapshot: null,
    },
  };
}

function connection(id: string, repositoryId: string, installationId: string, status = "active"): TPpmGitConnection {
  return {
    id,
    repository_id: repositoryId,
    installation_id: installationId,
    provider_repository_id: 1,
    provider_full_name: `lab/${repositoryId}`,
    status: status as TPpmGitConnection["status"],
    last_sync_at: null,
    last_event_at: null,
    last_error: null,
    retry_after: null,
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
  };
}

// One project with a GitHub repository and a repository of our Git server, as the G2.1 API answers.
const mixed: Pick<TPpmGitOverview, "installations" | "repositories" | "connections"> = {
  installations: [installation("i-forgejo", "forgejo"), installation("i-github", "github")],
  repositories: [repository("robot", "forgejo"), repository("site", "github")],
  connections: [connection("c-robot", "robot", "i-forgejo"), connection("c-site", "site", "i-github")],
};

describe("provider labels", () => {
  it("names GitHub and our Git server, the rest as before", () => {
    expect(getGitProviderLabel("github")).toBe("GitHub");
    expect(getGitProviderLabel("forgejo")).toBe("Наш Git-сервер");
    expect(getGitProviderLabel("gitlab")).toBe("GitLab");
    expect(getGitProviderLabel("bitbucket")).toBe("Bitbucket");
    expect(getGitProviderLabel("gitea")).toBe("Gitea");
    expect(getGitProviderLabel("generic")).toBe("Git");
    expect(getGitProviderLabel("something-new")).toBe("Git-сервер");
    expect(getGitProviderLabel(undefined)).toBe("Git-сервер");
  });

  it("does not offer our Git server for a manual record: it is connected, not typed in", () => {
    expect(PPM_GIT_MANUAL_PROVIDERS).toEqual(["github", "gitlab", "bitbucket", "gitea", "generic"]);
  });

  it("opens a repository of our Git server «на Git-сервере»", () => {
    expect(getGitRepositoryOpenLabel("forgejo")).toBe("Открыть на Git-сервере");
    expect(getGitRepositoryOpenLabel("github")).toBe("Открыть репозиторий");
  });

  it("says «Git-сервер просит подождать» for our server and keeps the GitHub wording for GitHub", () => {
    expect(getGitConnectionStatusLabel("rate_limited", "forgejo")).toBe("Git-сервер просит подождать");
    expect(getGitConnectionStatusLabel("suspended", "forgejo")).toBe("Подключение приостановлено");
    expect(getGitConnectionStatusLabel("active", "forgejo")).toBe("Подключён");
    expect(getGitConnectionStatusLabel("rate_limited", "github")).toBe("GitHub просит подождать");
    expect(getGitConnectionStatusLabel("suspended", "github")).toBe("Установка приостановлена");
  });

  it("asks to connect a repository for code search through its own provider", () => {
    expect(getGitCodeSearchConnectHint("github")).toEqual({
      title: "Сначала подключите репозиторий через GitHub",
      note: "Для поиска сначала подключите этот репозиторий через GitHub.",
    });
    expect(getGitCodeSearchConnectHint("forgejo").note).toBe(
      "Для поиска сначала подключите этот репозиторий с нашего Git-сервера."
    );
    expect(getGitCodeSearchConnectHint("gitlab").note).toBe(
      "Для поиска сначала подключите этот репозиторий через Git-сервер."
    );
    expect(JSON.stringify(getGitCodeSearchConnectHint("forgejo"))).not.toContain("GitHub");
  });
});

describe("GitHub-only flows see only GitHub", () => {
  it("splits connections by the provider of their installation", () => {
    const { github, forgejo } = splitGitConnectionsByProvider(mixed);
    expect(github.map((item) => item.id)).toEqual(["c-site"]);
    expect(forgejo.map((item) => item.id)).toEqual(["c-robot"]);
  });

  it("falls back to the repository provider and then to GitHub (older API)", () => {
    const orphan = connection("c-old", "site", "i-gone");
    const unknown = connection("c-unknown", "gone", "i-gone");
    const { github, forgejo } = splitGitConnectionsByProvider({
      installations: [],
      repositories: [repository("site", "forgejo")],
      connections: [orphan, unknown],
    });
    expect(forgejo.map((item) => item.id)).toEqual(["c-old"]);
    expect(github.map((item) => item.id)).toEqual(["c-unknown"]);
  });

  it("never takes our Git server's installation for the GitHub App", () => {
    expect(getActiveGithubInstallation(mixed.installations)?.id).toBe("i-github");
    expect(getActiveGithubInstallation([installation("i-forgejo", "forgejo")])).toBeUndefined();
    expect(getActiveGithubInstallation([installation("i-github", "github", "suspended")])).toBeUndefined();
  });

  it("offers the branch and draft PR flow only for actively connected GitHub repositories", () => {
    expect(getActiveGithubRepositories(mixed).map((item) => item.id)).toEqual(["site"]);
    expect(
      getActiveGithubRepositories({
        ...mixed,
        connections: [connection("c-robot", "robot", "i-forgejo"), connection("c-site", "site", "i-github", "error")],
      })
    ).toEqual([]);
  });
});

describe("our Git server in the overview", () => {
  it("is off for an older API without providers and manage_git_server", () => {
    expect(
      getPpmGitServer({
        capabilities: {
          read: true,
          manage_repositories: true,
          manage_links: true,
          manage_provider: true,
          manage_write_actions: true,
        },
      })
    ).toEqual({ configured: false, publicUrl: null, canManage: false });
  });

  it("reads the configuration, the public address and the global-administrator right", () => {
    expect(
      getPpmGitServer({
        capabilities: {
          read: true,
          manage_repositories: false,
          manage_links: true,
          manage_provider: false,
          manage_write_actions: true,
          manage_git_server: true,
        },
        providers: {
          github: { configured: false },
          forgejo: { configured: true, public_url: "https://git.ppm.example" },
        },
      })
    ).toEqual({ configured: true, publicUrl: "https://git.ppm.example", canManage: true });
  });

  it("links only to http(s) addresses", () => {
    expect(safeGitWebUrl("https://git.ppm.example/lab/robot")).toBe("https://git.ppm.example/lab/robot");
    expect(safeGitWebUrl("javascript:alert(1)")).toBeNull();
    expect(safeGitWebUrl("not a url")).toBeNull();
    expect(safeGitWebUrl(null)).toBeNull();
  });
});

describe("security note", () => {
  it("keeps the RC.1 text while our Git server is not in use", () => {
    expect(getGitSecurityNote({ github: true, forgejo: false })).toBe(LEGACY_SECURITY_NOTE);
    expect(getGitSecurityNote({ github: false, forgejo: false })).toBe(LEGACY_SECURITY_NOTE);
  });

  it("describes our Git server without GitHub when only it is used", () => {
    const note = getGitSecurityNote({ github: false, forgejo: true });
    expect(note).not.toContain("GitHub");
    expect(note).toContain("только на чтение");
    expect(note).toContain("слияние (merge) — на Git-сервере");
  });

  it("describes both when both are used", () => {
    const note = getGitSecurityNote({ github: true, forgejo: true });
    expect(note).toContain("GitHub даёт краткоживущий доступ");
    expect(note).toContain("с нашего Git-сервера");
    expect(note).toContain("слияние (merge) — на Git-сервере");
  });
});
