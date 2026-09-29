// G2.1 (R11): how «Код» names Git providers. A repository or a connection shows its own provider — «GitHub» or
// «Наш Git-сервер» (Forgejo next to PPM); a text about a connected repository in general says «Git-сервер». GitHub-only
// flows (the GitHub App installation, the G1.3 branch and draft PR) keep «GitHub» and see only GitHub connections.
import { getDate, getDateFormatLanguage, renderFormattedDate, renderFormattedTime } from "@plane/utils";
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

/**
 * G2.1 D-3/M-3: PR status for a Git object/link row in «Код» — «Открыт» / «Черновик» / «Закрыт» / «Слит». Same for
 * every provider (GitHub, our Git server, …): the raw `state` is already provider-neutral («open»/«closed»/«merged»,
 * `providers/github.py:924-934`, `providers/forgejo.py:244-258`). `isDraft` is only known for a `TPpmGitObject`
 * (`GET .../objects/`); a `TPpmGitLink` row carries just `git_object_state`, so a draft PR shows as «Открыт» there —
 * still correct, just less specific. Not a PR (branch/commit: `state` is `"committed"`/`"active"`/`"deleted"`, an
 * unrelated vocabulary) or an unknown/empty state → null, so the row shows nothing extra.
 *
 * M-3: a merged PR now also carries the API's `provider_merged_at`/`git_object_merged_at` (only ever set on a
 * merged PR) — see `formatMergedAtLabel` for the exact rendering («Слит 28 сент., 14:05»). A missing/unparseable
 * time (older records, GitHub before this field existed) keeps the bare «Слит», exactly as before M-3.
 */
export function getGitPullRequestStatusLabel(
  state: string | null | undefined,
  isDraft?: boolean | null,
  mergedAt?: string | null
): string | null {
  if (state === "merged") return formatMergedAtLabel(mergedAt);
  if (state === "closed") return "Закрыт";
  if (state === "open") return isDraft ? "Черновик" : "Открыт";
  return null;
}

/**
 * «Слит 28 сент., 14:05» — day + month in the short genitive form (`renderFormattedDate`/`@plane/utils`, already
 * switched to Russian by `setDateFormatLanguage`, same as every other date in the app), the year added only when it
 * is not the current one («Слит 28 сент. 2025, 14:05»), then HH:mm in the browser's own timezone
 * (`renderFormattedTime`). English interface — «Merged Sep 28, 14:05» (and «Merged Sep 28, 2025, 14:05» for another
 * year) through the same formatter and `getDateFormatLanguage`, no separate locale parameter needed. No self-written
 * month table: every piece comes from the project's own date formatter. An unknown or unparseable time falls back to
 * the plain «Слит», unchanged from before M-3.
 */
function formatMergedAtLabel(mergedAt: string | null | undefined): string {
  if (!mergedAt) return "Слит";
  const parsedDate = getDate(mergedAt);
  if (!parsedDate) return "Слит";
  const sameYear = parsedDate.getFullYear() === new Date().getFullYear();
  const datePart = renderFormattedDate(mergedAt, sameYear ? "MMM d" : "MMM d, yyyy");
  const timePart = renderFormattedTime(mergedAt);
  if (!datePart || !timePart) return "Слит";
  return `${getDateFormatLanguage() === "ru" ? "Слит" : "Merged"} ${datePart}, ${timePart}`;
}

/**
 * Full merge date-time for a hover tooltip on the short label above — the same «date, time» pattern already used
 * for activity and comment timestamps elsewhere in the app (`activity-block.tsx`), always with the year (unlike the
 * short label, which drops it in the current year).
 */
export function getGitMergedAtTitle(mergedAt: string | null | undefined): string | undefined {
  if (!mergedAt || !getDate(mergedAt)) return undefined;
  const datePart = renderFormattedDate(mergedAt);
  const timePart = renderFormattedTime(mergedAt);
  return datePart && timePart ? `${datePart}, ${timePart}` : undefined;
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

/**
 * Our Git server as the overview describes it; an older API without the G2.1 fields means «not set up». G2.2:
 * `canManage` now follows `connect_git_server_repositories` when the API sends it (a project administrator gets it
 * too, once single sign-on is configured) — falling back to the G2.1-only `manage_git_server` for an older/cached
 * response, so nothing changes while single sign-on is off.
 */
export function getPpmGitServer(overview: Pick<TPpmGitOverview, "capabilities" | "providers">): {
  configured: boolean;
  publicUrl: string | null;
  canManage: boolean;
  /** G2.2: single sign-on through PPM is configured for our Git server. */
  ssoEnabled: boolean;
  /** G2.2: the viewer's own username on our Git server, or null without a personal account there yet. */
  username: string | null;
  /** G2.2: one-click sign-in link (`getForgejoSsoOpenUrl` turns it into a link to a specific repository). */
  ssoLoginUrl: string | null;
} {
  const forgejo = overview.providers?.forgejo;
  return {
    configured: forgejo?.configured === true,
    publicUrl: safeGitWebUrl(forgejo?.public_url),
    canManage:
      overview.capabilities.connect_git_server_repositories ?? overview.capabilities.manage_git_server === true,
    ssoEnabled: forgejo?.sso_enabled === true,
    username: forgejo?.username ?? null,
    ssoLoginUrl: safeGitWebUrl(forgejo?.sso_login_url),
  };
}

/**
 * G2.2 (R17/R21): a one-click sign-in link to a specific repository of our Git server through PPM single sign-on
 * (Forgejo signs the person in and lands them straight on that page) — `sso_login_url` with `redirect_to`
 * (`research/forgejo-facts.md`/`ppm-facts.md`: `https://git.<domain>/user/oauth2/PPM?redirect_to=/<org>/<repo>`).
 * Review round 1 (#5): built through `URL`/`searchParams.set` rather than string concatenation, so the value is
 * correctly percent-encoded — org/repository names are ordinarily safe slug characters, but a display name with a
 * space, `&` or `#` must not spill into being a second query parameter or truncate the path. Null without a login
 * link or a full name to redirect to (the caller then falls back to the plain `canonical_url`), or if `ssoLoginUrl`
 * is not itself a valid URL.
 */
export function getForgejoSsoOpenUrl(
  ssoLoginUrl: string | null | undefined,
  fullName: string | null | undefined
): string | null {
  const base = safeGitWebUrl(ssoLoginUrl);
  const target = fullName?.trim().replace(/^\/+/, "");
  if (!base || !target) return null;
  try {
    const url = new URL(base);
    url.searchParams.set("redirect_to", `/${target}`);
    return url.toString();
  } catch {
    return null;
  }
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
