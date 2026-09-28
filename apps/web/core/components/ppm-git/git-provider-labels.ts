// G2.1 (R11): how «Код» names Git providers. A repository or a connection shows its own provider — «GitHub» or
// «Наш Git-сервер» (Forgejo next to PPM); a text about a connected repository in general says «Git-сервер». GitHub-only
// flows (the GitHub App installation, the G1.3 branch and draft PR) keep «GitHub» and see only GitHub connections.
import { resolvePpmLocale } from "@ppm/brand";
import type {
  TPpmGitConnection,
  TPpmGitInstallation,
  TPpmGitOverview,
  TPpmGitProvider,
  TPpmGitRepository,
} from "@/services/ppm-git.service";

export const PPM_GIT_PROVIDER_LABELS: Record<TPpmGitProvider, string> = {
  github: "GitHub",
  forgejo: "Наш Git-сервер",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  gitea: "Gitea",
  generic: "Git",
};

/** Providers of a manual record. Our Git server is not here: its repositories are connected, not typed in. */
export const PPM_GIT_MANUAL_PROVIDERS: TPpmGitProvider[] = ["github", "gitlab", "bitbucket", "gitea", "generic"];

export function getGitProviderLabel(provider: string | null | undefined): string {
  return (provider && PPM_GIT_PROVIDER_LABELS[provider as TPpmGitProvider]) || "Git-сервер";
}

/** The provider on a canvas Git card: our Git server by name in the UI language, the rest as in RC.1 («GITHUB»). */
export function getCanvasGitProviderLabel(provider: string, locale: string | undefined): string {
  if (provider !== "forgejo") return provider.toUpperCase();
  return resolvePpmLocale(locale) === "ru" ? "Наш Git-сервер" : "Our Git server";
}

/** Accessible name of the «open» link of a repository card. */
export function getGitRepositoryOpenLabel(provider: string | null | undefined): string {
  return provider === "forgejo" ? "Открыть на Git-сервере" : "Открыть репозиторий";
}

const CONNECTION_STATUS_LABELS: Record<TPpmGitConnection["status"], string> = {
  active: "Подключён",
  syncing: "Синхронизация",
  rate_limited: "Git-сервер просит подождать",
  permission_drift: "Доступ к репозиторию отозван",
  error: "Ошибка синхронизации",
  suspended: "Подключение приостановлено",
  disconnected: "Отключён",
  revoked: "Доступ отозван",
};

// RC.1 wording of a GitHub App connection, unchanged.
const GITHUB_CONNECTION_STATUS_LABELS: Record<TPpmGitConnection["status"], string> = {
  ...CONNECTION_STATUS_LABELS,
  rate_limited: "GitHub просит подождать",
  suspended: "Установка приостановлена",
};

export function getGitConnectionStatusLabel(
  status: TPpmGitConnection["status"],
  provider: string | null | undefined
): string {
  const labels = provider === "github" ? GITHUB_CONNECTION_STATUS_LABELS : CONNECTION_STATUS_LABELS;
  return labels[status] ?? "Состояние неизвестно";
}

/** Code search needs an active connection: say through which provider to connect this repository. */
export function getGitCodeSearchConnectHint(provider: string | null | undefined): { title: string; note: string } {
  const through =
    provider === "github" ? "через GitHub" : provider === "forgejo" ? "с нашего Git-сервера" : "через Git-сервер";
  return {
    title: `Сначала подключите репозиторий ${through}`,
    note: `Для поиска сначала подключите этот репозиторий ${through}.`,
  };
}

/** The provider of a connection: its installation's (the G2.1 API), else its repository's, else GitHub (RC.1). */
export function getGitConnectionProvider(
  connection: Pick<TPpmGitConnection, "installation_id" | "repository_id">,
  overview: Pick<TPpmGitOverview, "installations" | "repositories">
): TPpmGitProvider {
  return (
    overview.installations.find((item) => item.id === connection.installation_id)?.provider ??
    overview.repositories.find((item) => item.id === connection.repository_id)?.provider ??
    "github"
  );
}

export function splitGitConnectionsByProvider(
  overview: Pick<TPpmGitOverview, "installations" | "repositories" | "connections">
): { github: TPpmGitConnection[]; forgejo: TPpmGitConnection[] } {
  const github: TPpmGitConnection[] = [];
  const forgejo: TPpmGitConnection[] = [];
  for (const connection of overview.connections) {
    (getGitConnectionProvider(connection, overview) === "forgejo" ? forgejo : github).push(connection);
  }
  return { github, forgejo };
}

/** The active GitHub App installation; our Git server's installation row is never taken for it. */
export function getActiveGithubInstallation(installations: TPpmGitInstallation[]): TPpmGitInstallation | undefined {
  return installations.find((item) => item.status === "active" && item.provider === "github");
}

/** Repositories the G1.3 branch and draft PR flow may use: actively connected through GitHub. */
export function getActiveGithubRepositories(
  overview: Pick<TPpmGitOverview, "installations" | "repositories" | "connections">
): TPpmGitRepository[] {
  const active = splitGitConnectionsByProvider(overview).github.filter((item) => item.status === "active");
  return overview.repositories.filter((repository) => active.some((item) => item.repository_id === repository.id));
}

/** Our Git server as the overview describes it; an older API without the G2.1 fields means «not set up». */
export function getPpmGitServer(overview: Pick<TPpmGitOverview, "capabilities" | "providers">): {
  configured: boolean;
  publicUrl: string | null;
  canManage: boolean;
} {
  const forgejo = overview.providers?.forgejo;
  return {
    configured: forgejo?.configured === true,
    publicUrl: safeGitWebUrl(forgejo?.public_url),
    canManage: overview.capabilities.manage_git_server === true,
  };
}

/** An address the page may link to: http(s) only, as given (trimmed). */
export function safeGitWebUrl(value: string | null | undefined): string | null {
  const address = value?.trim();
  if (!address) return null;
  try {
    const { protocol } = new URL(address);
    return protocol === "https:" || protocol === "http:" ? address : null;
  } catch {
    return null;
  }
}

const SECURITY_NOTE_INDEX =
  "При включённом поиске индексируются только разрешённые текстовые файлы точного коммита; секреты, зависимости и " +
  "двоичные файлы отбрасываются.";

/** The «Без хранения токенов и SSH-ключей» note: RC.1 text until our Git server is in use. */
export function getGitSecurityNote({ github, forgejo }: { github: boolean; forgejo: boolean }): string {
  if (!forgejo) {
    return (
      "PPM не сохраняет токены: для каждого запроса берётся краткоживущий доступ только к выбранному репозиторию — " +
      `на чтение, а для подтверждённой ветки или черновика PR — на запись. ${SECURITY_NOTE_INDEX} Коммиты и push ` +
      "выполняются обычным Git, слияние (merge) — только в GitHub."
    );
  }
  const access = github
    ? "PPM не хранит ваши токены и SSH-ключи. GitHub даёт краткоживущий доступ только к выбранному репозиторию — на " +
      "чтение, а для подтверждённой ветки или черновика PR — на запись; с нашего Git-сервера PPM читает репозитории " +
      "служебной учётной записью только на чтение."
    : "PPM не хранит ваши токены и SSH-ключи: с нашего Git-сервера он читает репозитории служебной учётной записью " +
      "только на чтение и ничего не меняет на сервере.";
  return `${access} ${SECURITY_NOTE_INDEX} Коммиты и push выполняются обычным Git, слияние (merge) — на Git-сервере.`;
}
