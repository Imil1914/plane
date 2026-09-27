// G1.3 (RC-C): view model of one Git write step on the «Код» page. Two separately approved steps: a branch from the
// exact base commit, then — after the first push — a draft PR. Merge is never offered: it stays in GitHub.
import type { TPpmGitWriteAction, TPpmGitWriteApplyBlocker } from "@/services/ppm-git.service";

export type TPpmGitWriteCommand =
  | "approve"
  | "reject"
  | "apply"
  | "retry"
  | "cancel"
  | "prepare_pull_request"
  | "prepare_again"
  | "open_follow_up";

export type TPpmGitWriteManual =
  | { kind: "branch"; commands: string[] }
  /** The name or SHA is not shell-neutral: no copyable commands, only GitHub's branch page and a hint. */
  | { kind: "branch_link"; url: string; baseRef: string; baseSha: string }
  | { kind: "pull_request"; url: string };

export type TPpmGitWriteView = {
  stageLabel: string;
  statusLabel: string;
  tone: "neutral" | "success" | "warning" | "danger";
  /** Buttons in display order; empty for people who may only read. */
  commands: TPpmGitWriteCommand[];
  applyLabel?: string;
  /** Set when apply/retry is shown but cannot run now — the button stays visible and explains why. */
  applyDisabledReason?: string;
  manual?: TPpmGitWriteManual;
  notice?: string;
  resultUrl?: string;
  /** Where to look in GitHub when a step failed or its outcome could not be confirmed. */
  checkUrl?: string;
};

const STAGE_LABELS: Record<TPpmGitWriteAction["stage"], string> = {
  branch: "Шаг 1 · ветка",
  pull_request: "Шаг 2 · черновик PR",
  legacy: "Старое предложение",
};

const OPEN_STATUSES = new Set<TPpmGitWriteAction["status"]>(["proposed", "approved", "applying", "failed"]);

const UNKNOWN_OUTCOME_NOTICE =
  "Неизвестно, успела ли прошлая попытка создать объект в GitHub. «Повторить» проверит GitHub и зафиксирует " +
  "результат; отменить до этой проверки нельзя.";

export function shortSha(sha?: string | null) {
  return sha ? sha.slice(0, 7) : "";
}

export function getGitWriteStatusLabel(action: Pick<TPpmGitWriteAction, "stage" | "status">) {
  const pullRequest = action.stage === "pull_request";
  switch (action.status) {
    case "proposed":
      return "Ждёт подтверждения";
    case "approved":
      return "Подтверждено";
    case "rejected":
      return "Отклонено";
    case "applying":
      return pullRequest ? "Черновик PR создаётся…" : "Ветка создаётся…";
    case "applied":
      return pullRequest ? "Черновик PR создан" : action.stage === "legacy" ? "Создано в GitHub" : "Ветка создана";
    case "conflict":
      return "Нужен новый предпросмотр";
    case "failed":
      return "Ошибка GitHub";
    case "cancelled":
      return "Отменено";
  }
}

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const SAFE_SHA = /^[0-9a-f]{40,64}$/;

/**
 * Same rule as the API (`is_safe_git_ref`): a shell-neutral alphabet plus git's ref-name rules. Only such names are
 * ever put into copyable commands — quoting is not portable across POSIX shells, PowerShell and cmd.
 */
export function isSafeGitRefName(ref: string) {
  return (
    ref.length > 0 &&
    ref.length <= 244 &&
    SAFE_REF.test(ref) &&
    !/^[-/.]/.test(ref) &&
    !/(\/|\.|\.lock)$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  );
}

export function isSafeSha(sha: string) {
  return SAFE_SHA.test(sha);
}

/** Copyable commands for the manual branch, or `undefined` when a value is not shell-neutral. */
export function buildManualBranchCommands(action: Pick<TPpmGitWriteAction, "base_sha" | "preview">) {
  const head = action.preview.branch.head_ref;
  if (!isSafeGitRefName(head) || !isSafeSha(action.base_sha)) return undefined;
  return ["git fetch origin", `git switch -c ${head} ${action.base_sha}`, `git push -u origin ${head}`];
}

const encodeRef = (ref: string) => encodeURIComponent(ref).replaceAll("%2F", "/");

export function buildManualPullRequestUrl(action: Pick<TPpmGitWriteAction, "preview">) {
  const { base_ref: base, head_ref: head } = action.preview.branch;
  return `${action.preview.repository.canonical_url}/compare/${encodeRef(base)}...${encodeRef(head)}?expand=1`;
}

function formatRetryTime(value: string | null) {
  const time = value ? new Date(value) : null;
  if (!time || !Number.isFinite(time.getTime())) return "";
  return time.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function disabledReason(action: TPpmGitWriteAction): string | undefined {
  if (action.apply_available) return undefined;
  const has = (blocker: TPpmGitWriteApplyBlocker) => action.apply_blockers.includes(blocker);
  if (has("APPLY_IN_PROGRESS")) return "Уже применяется — обновите через несколько секунд.";
  if (has("RETRY_LATER")) {
    const time = formatRetryTime(action.retry_after);
    return time ? `GitHub просил подождать до ${time}.` : "GitHub просил подождать — повторите чуть позже.";
  }
  if (has("PROVIDER_WRITE_DISABLED"))
    return "Запись в GitHub выключена администратором PPM — сделайте это вручную по инструкции ниже.";
  if (has("CONNECTION_INACTIVE")) return "Подключение репозитория неактивно — подключите его заново.";
  if (has("GITHUB_PERMISSIONS_MISSING"))
    return "У GitHub App нет прав на запись — выдайте их в GitHub и нажмите «Проверить права».";
  if (has("APPROVAL_REQUIRED")) return "Сначала подтвердите предпросмотр.";
  return "Сейчас применить нельзя.";
}

function manualPath(action: TPpmGitWriteAction): TPpmGitWriteManual | undefined {
  if (action.stage === "legacy" || !OPEN_STATUSES.has(action.status)) return undefined;
  const writesOff = action.apply_blockers.includes("PROVIDER_WRITE_DISABLED");
  const draftUnsupported = action.error?.code === "GITHUB_DRAFT_UNSUPPORTED";
  if (!writesOff && !draftUnsupported) return undefined;
  if (action.stage === "pull_request") return { kind: "pull_request", url: buildManualPullRequestUrl(action) };
  const commands = buildManualBranchCommands(action);
  if (commands) return { kind: "branch", commands };
  return {
    kind: "branch_link",
    url: `${action.preview.repository.canonical_url}/branches`,
    baseRef: action.preview.branch.base_ref,
    baseSha: action.base_sha,
  };
}

/** Links from GitHub data are rendered only when they point to GitHub over HTTPS. */
export function safeGithubUrl(url?: string | null) {
  return url && url.startsWith("https://github.com/") ? url : undefined;
}

export function getGitWriteActionView(
  action: TPpmGitWriteAction,
  { canManage }: { canManage: boolean }
): TPpmGitWriteView {
  const pullRequest = action.stage === "pull_request";
  const view: TPpmGitWriteView = {
    stageLabel: STAGE_LABELS[action.stage],
    statusLabel: getGitWriteStatusLabel(action),
    tone:
      action.status === "applied"
        ? "success"
        : action.status === "failed" || action.status === "conflict"
          ? "danger"
          : action.status === "approved" || action.status === "applying"
            ? "warning"
            : "neutral",
    commands: [],
    manual: manualPath(action),
    resultUrl: safeGithubUrl(action.result.pull_request?.canonical_url ?? action.result.branch?.canonical_url),
    checkUrl:
      action.status === "failed" || action.status === "conflict"
        ? safeGithubUrl(action.result.error_details?.canonical_url)
        : undefined,
  };
  const applyLabel = pullRequest ? "Создать черновик PR в GitHub" : "Создать ветку в GitHub";

  if (action.stage === "legacy") {
    view.notice =
      "Предложение в старом формате: теперь ветка и черновик PR подтверждаются отдельно. Подготовьте новый предпросмотр ветки.";
    if (canManage) view.commands = action.can_cancel ? ["prepare_again", "cancel"] : ["prepare_again"];
    return view;
  }

  switch (action.status) {
    case "proposed":
      view.commands = ["reject", "approve"];
      if (action.apply_blockers.includes("PROVIDER_WRITE_DISABLED"))
        view.notice = "Запись в GitHub выключена администратором: решение сохранится, а создать можно вручную.";
      break;
    case "approved":
      view.commands = ["cancel", "apply"];
      view.applyLabel = applyLabel;
      view.applyDisabledReason = disabledReason(action);
      break;
    case "applying":
      if (action.apply_blockers.includes("APPLY_IN_PROGRESS")) {
        view.notice = "Создаётся в GitHub — обновите через несколько секунд.";
      } else {
        // The attempt died mid-way: GitHub may already hold the object, so only a reconciling retry is offered.
        view.notice = UNKNOWN_OUTCOME_NOTICE;
        view.commands = ["retry"];
        view.applyLabel = "Повторить";
        view.applyDisabledReason = disabledReason(action);
      }
      break;
    case "failed":
      view.notice = action.outcome_unknown
        ? [action.error?.message, UNKNOWN_OUTCOME_NOTICE].filter(Boolean).join(" ")
        : action.error?.message;
      view.commands = action.can_cancel ? ["cancel", "retry"] : ["retry"];
      view.applyLabel = "Повторить";
      view.applyDisabledReason = disabledReason(action);
      break;
    case "conflict":
      view.notice = [action.error?.message, "Подготовьте новый предпросмотр."].filter(Boolean).join(" ");
      view.commands = ["prepare_again"];
      break;
    case "applied":
      if (pullRequest) {
        view.notice = "Черновик PR создан. Слияние (merge) выполняется только в GitHub.";
      } else if (action.follow_up?.pull_request_action) {
        view.notice = `Шаг 2 уже начат: ${getGitWriteStatusLabel({
          stage: "pull_request",
          status: action.follow_up.pull_request_action.status,
        }).toLowerCase()}.`;
        view.commands = ["open_follow_up"];
      } else {
        view.notice = action.follow_up?.pull_request_ready
          ? "В ветке есть новые коммиты — можно подготовить черновик PR (шаг 2)."
          : "Сделайте commit и push в эту ветку, затем подготовьте черновик PR (шаг 2).";
        view.commands = ["prepare_pull_request"];
      }
      break;
    case "rejected":
    case "cancelled":
      view.commands = ["prepare_again"];
      break;
  }

  if (!canManage) {
    view.commands = [];
    if (OPEN_STATUSES.has(action.status))
      view.notice = "Подтверждать и применять Git-действия могут руководитель и участники проекта.";
  }
  return view;
}
