// G2.1 (R11): «Код» names the provider of each repository and connection — «GitHub» or «Наш Git-сервер» — and
// speaks neutrally («Git-сервер») where the text is about a connected repository in general. GitHub-only flows
// (GitHub App installation, the G1.3 write flow) keep «GitHub» and see only GitHub connections.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDateFormatLanguage } from "@plane/utils";
import {
  getActiveGithubInstallation,
  getActiveGithubRepositories,
  getGitCodeSearchConnectHint,
  getGitConnectionStatusLabel,
  getGitMergedAtTitle,
  getGitProviderLabel,
  getGitPullRequestStatusLabel,
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

// G2.1 M-3: local HH:mm of an ISO instant, computed the same way the label/tooltip themselves compute it (`new
// Date(iso)` local getters) — so date+time assertions below do not hardcode this machine's own UTC offset.
const localTime = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

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

describe("PR status on «Код» rows (D-3)", () => {
  it("names the four PR states", () => {
    expect(getGitPullRequestStatusLabel("open", false)).toBe("Открыт");
    expect(getGitPullRequestStatusLabel("open", true)).toBe("Черновик");
    expect(getGitPullRequestStatusLabel("closed")).toBe("Закрыт");
    expect(getGitPullRequestStatusLabel("merged")).toBe("Слит");
  });

  it("treats an open PR without a known draft flag as «Открыт» (a link row has no is_draft)", () => {
    expect(getGitPullRequestStatusLabel("open")).toBe("Открыт");
    expect(getGitPullRequestStatusLabel("open", null)).toBe("Открыт");
    expect(getGitPullRequestStatusLabel("open", undefined)).toBe("Открыт");
  });

  it("says nothing for a branch/commit state or an unknown/empty one", () => {
    expect(getGitPullRequestStatusLabel("committed")).toBeNull();
    expect(getGitPullRequestStatusLabel("active")).toBeNull();
    expect(getGitPullRequestStatusLabel("deleted")).toBeNull();
    expect(getGitPullRequestStatusLabel("")).toBeNull();
    expect(getGitPullRequestStatusLabel(null)).toBeNull();
    expect(getGitPullRequestStatusLabel(undefined)).toBeNull();
  });

  it("is_draft never overrides a closed or merged state", () => {
    expect(getGitPullRequestStatusLabel("closed", true)).toBe("Закрыт");
    expect(getGitPullRequestStatusLabel("merged", true)).toBe("Слит");
  });
});

// G2.1 M-3: a merged PR with a known merge time («Слит 28 сент., 14:05», year added only for another year;
// «Merged Sep 28, 14:05» in English) — through the project's own date formatter (@plane/utils), same mechanism as
// every other date in the app (setDateFormatLanguage). Local HH:mm is computed the same way the label itself
// computes it (`new Date(iso)` local getters), so the assertion does not hardcode this machine's own UTC offset.
// The merge instant (14:05 UTC) is deliberately far from local midnight so the calendar day itself («28 сент.») does
// not depend on the timezone either, for any reasonably plausible one.
describe("PR merge date+time label (M-3)", () => {
  const CURRENT_YEAR_MERGE = "2026-09-28T14:05:00+00:00";
  const OTHER_YEAR_MERGE = "2025-09-28T14:05:00+00:00";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T09:00:00+00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
    setDateFormatLanguage("en");
  });

  it("shows day + short genitive month + time, no year in the current year (Russian)", () => {
    setDateFormatLanguage("ru");
    expect(getGitPullRequestStatusLabel("merged", undefined, CURRENT_YEAR_MERGE)).toBe(
      `Слит 28 сент., ${localTime(CURRENT_YEAR_MERGE)}`
    );
  });

  it("adds the year when the merge was not this year (Russian)", () => {
    setDateFormatLanguage("ru");
    expect(getGitPullRequestStatusLabel("merged", undefined, OTHER_YEAR_MERGE)).toBe(
      `Слит 28 сент. 2025, ${localTime(OTHER_YEAR_MERGE)}`
    );
  });

  it("uses the same mechanism for the English interface", () => {
    setDateFormatLanguage("en");
    expect(getGitPullRequestStatusLabel("merged", undefined, CURRENT_YEAR_MERGE)).toBe(
      `Merged Sep 28, ${localTime(CURRENT_YEAR_MERGE)}`
    );
    expect(getGitPullRequestStatusLabel("merged", undefined, OTHER_YEAR_MERGE)).toBe(
      `Merged Sep 28, 2025, ${localTime(OTHER_YEAR_MERGE)}`
    );
  });

  it("keeps the bare «Слит» — unchanged from before M-3 — when the merge time is unknown, in either language", () => {
    expect(getGitPullRequestStatusLabel("merged")).toBe("Слит");
    expect(getGitPullRequestStatusLabel("merged", undefined, null)).toBe("Слит");
    setDateFormatLanguage("en");
    expect(getGitPullRequestStatusLabel("merged", undefined, null)).toBe("Слит");
    expect(getGitPullRequestStatusLabel("merged", undefined, undefined)).toBe("Слит");
  });

  it("falls back to the bare «Слит» for an unparseable merge time", () => {
    expect(getGitPullRequestStatusLabel("merged", undefined, "not-a-date")).toBe("Слит");
  });

  it("ignores a merge time on any state other than merged", () => {
    expect(getGitPullRequestStatusLabel("open", true, CURRENT_YEAR_MERGE)).toBe("Черновик");
    expect(getGitPullRequestStatusLabel("open", false, CURRENT_YEAR_MERGE)).toBe("Открыт");
    expect(getGitPullRequestStatusLabel("closed", false, CURRENT_YEAR_MERGE)).toBe("Закрыт");
    expect(getGitPullRequestStatusLabel("committed", false, CURRENT_YEAR_MERGE)).toBeNull();
  });
});

// G2.1 M-3: the full merge date-time for the row's hover tooltip — always with the year, same «date, time» pattern
// already used for activity/comment timestamps elsewhere in the app.
describe("getGitMergedAtTitle", () => {
  const MERGE_TIME = "2026-09-28T14:05:00+00:00";

  afterEach(() => setDateFormatLanguage("en"));

  it("is undefined without a merge time or with an unparseable one", () => {
    expect(getGitMergedAtTitle(null)).toBeUndefined();
    expect(getGitMergedAtTitle(undefined)).toBeUndefined();
    expect(getGitMergedAtTitle("not-a-date")).toBeUndefined();
  });

  it("always carries the year, in either language", () => {
    setDateFormatLanguage("ru");
    expect(getGitMergedAtTitle(MERGE_TIME)).toBe(`28 сент. 2026, ${localTime(MERGE_TIME)}`);
    setDateFormatLanguage("en");
    expect(getGitMergedAtTitle(MERGE_TIME)).toBe(`Sep 28, 2026, ${localTime(MERGE_TIME)}`);
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
