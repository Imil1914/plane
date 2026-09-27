// G1.3 (RC-C): «Код» — a branch and then a draft PR, each with its own exact preview, approval and apply.
// The frame (dismissal policy) and the data flow live in route.tsx; the decisions about which buttons a person
// sees come from helpers/ppm-git-write-flow.helper.ts. Merge is never offered here: it stays in GitHub.
import type { FormEvent } from "react";
import { Check, Clipboard, ExternalLink, GitBranch, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import type { TPpmWorkItemProjection } from "@ppm/canvas";
import {
  getGitWriteActionView,
  getGitWriteStatusLabel,
  safeGithubUrl,
  shortSha,
  type TPpmGitWriteCommand,
  type TPpmGitWriteView,
} from "@/helpers/ppm-git-write-flow.helper";
import type { TPpmGitRepository, TPpmGitWriteAction, TPpmGitWriteReadiness } from "@/services/ppm-git.service";
import { DialogActions, FormInput, PreviewRow } from "./git-dialog-parts";

export type TPpmGitWriteForm = { base_ref: string; head_ref: string; title: string; body: string };
export type TPpmGitWriteWorkItem = { id: string; identifier: string; title: string };
export type TPpmGitWriteDialogError = { message: string; url?: string };

const STAGE_TITLES: Record<TPpmGitWriteAction["stage"], string> = {
  branch: "Ветка",
  pull_request: "Черновик PR",
  legacy: "Ветка и PR (старый формат)",
};

const TONE_CLASS_NAMES: Record<TPpmGitWriteView["tone"], string> = {
  neutral: "border-subtle bg-surface-2 text-secondary",
  success: "border-success-subtle bg-success-subtle text-success-primary",
  warning: "border-warning-subtle bg-warning-subtle text-warning-primary",
  danger: "border-danger-subtle bg-danger-subtle text-danger-primary",
};

const PRIMARY_COMMANDS = new Set<TPpmGitWriteCommand>([
  "approve",
  "apply",
  "retry",
  "prepare_pull_request",
  "prepare_again",
  "open_follow_up",
]);

function actionHeadline(action: TPpmGitWriteAction) {
  if (action.stage === "branch") return `Ветка ${action.preview.branch.head_ref}`;
  return action.preview.draft_pull_request.title;
}

export function GitWriteActionsPanel({
  actions,
  canPrepare,
  canRefreshPermissions,
  onOpen,
  onPrepare,
  onRefreshPermissions,
  readiness,
  refreshingPermissions,
}: {
  actions: TPpmGitWriteAction[];
  canPrepare: boolean;
  canRefreshPermissions: boolean;
  onOpen: (action: TPpmGitWriteAction) => void;
  onPrepare: () => void;
  onRefreshPermissions: () => void;
  readiness: TPpmGitWriteReadiness;
  refreshingPermissions: boolean;
}) {
  return (
    <section className="rounded-xl border border-subtle bg-surface-2 p-5" aria-labelledby="ppm-git-write-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="ppm-git-write-title" className="text-16 font-semibold text-primary">
            Ветка и черновик PR с подтверждением
          </h2>
          <p className="mt-1 max-w-2xl text-12 leading-5 text-secondary">
            Два шага, у каждого — свой точный предпросмотр и отдельное подтверждение: сначала ветка от показанного
            коммита базовой ветки, затем, после вашего первого push, — черновик PR. Слияние (merge) выполняется только в
            GitHub.
          </p>
        </div>
        {canPrepare && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-subtle px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1"
            onClick={onPrepare}
          >
            <GitBranch className="size-4" aria-hidden="true" /> Новая ветка для задачи
          </button>
        )}
      </div>
      {!readiness.provider_writes_enabled && (
        <p className="mt-3 rounded-lg border border-warning-subtle bg-warning-subtle p-3 text-12 leading-5 text-secondary">
          Запись в GitHub выключена администратором PPM. Предпросмотр и подтверждение работают, а ветку и черновик PR
          создайте вручную: PPM покажет готовые команды и ссылку, а затем подхватит результат по webhook.
        </p>
      )}
      <GitWriteReadiness
        canRefresh={canRefreshPermissions}
        onRefresh={onRefreshPermissions}
        readiness={readiness}
        refreshing={refreshingPermissions}
      />
      {actions.length > 0 && (
        <ul className="mt-4 grid gap-2 border-t border-subtle pt-4" aria-label="Последние Git-действия">
          {actions.slice(0, 8).map((action) => (
            <li
              className="flex flex-col gap-2 rounded-lg border border-subtle bg-layer-1 p-3 sm:flex-row sm:items-center"
              key={action.id}
            >
              <div className="min-w-0 flex-1">
                <p className="text-11 font-semibold text-tertiary">
                  {STAGE_TITLES[action.stage]} · {action.preview.work_item.identifier}
                </p>
                <p className="truncate text-12 font-semibold text-primary">{actionHeadline(action)}</p>
                <p className="mt-0.5 truncate text-12 text-secondary">
                  {action.preview.repository.full_name} · {action.preview.branch.base_ref} →{" "}
                  {action.preview.branch.head_ref}
                </p>
              </div>
              <span className="text-11 font-semibold text-tertiary">{getGitWriteStatusLabel(action)}</span>
              <button
                type="button"
                className="rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-surface-2"
                onClick={() => onOpen(action)}
              >
                Открыть
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const WRITE_PERMISSION_LABELS: Record<string, string> = {
  metadata: "Метаданные — чтение",
  contents: "Содержимое — создание ветки",
  pull_requests: "Pull requests — создание черновика PR",
};

const PERMISSION_LEVEL_LABELS: Record<string, string> = { read: "чтение", write: "чтение и запись" };

// GitHub limits pull request titles to 256 characters; the API checks the same limit.
const PULL_REQUEST_TITLE_MAX_LENGTH = 256;

const WRITE_BLOCKER_LABELS: Record<TPpmGitWriteReadiness["blockers"][number], string> = {
  PROVIDER_WRITE_DISABLED: "Запись в GitHub выключена администратором PPM (PPM_GIT_WRITE_ENABLED)",
  GITHUB_PERMISSIONS_MISSING: "GitHub App пока имеет только права чтения",
};

export function GitWriteReadiness({
  canRefresh,
  onRefresh,
  readiness,
  refreshing,
}: {
  canRefresh: boolean;
  onRefresh: () => void;
  readiness: TPpmGitWriteReadiness;
  refreshing: boolean;
}) {
  return (
    <div className="mt-3 rounded-lg border border-subtle bg-layer-1 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-12 font-semibold text-primary">Готовность GitHub App</p>
          <p className="mt-1 text-12 leading-5 text-secondary">
            Порядок: ветка → ваш commit и push → черновик PR. Каждый шаг подтверждается отдельно.
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 sm:mt-0 sm:justify-end">
          {canRefresh && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
              {refreshing ? "Проверяем…" : "Проверить права"}
            </button>
          )}
          <span
            className={`inline-flex w-fit items-center gap-1 rounded-full border px-2 py-1 text-11 font-semibold ${
              readiness.apply_available
                ? "border-success-subtle bg-success-subtle text-success-primary"
                : "border-warning-subtle bg-warning-subtle text-warning-primary"
            }`}
          >
            {readiness.apply_available ? <Check className="size-3" /> : <X className="size-3" />}
            {readiness.apply_available ? "Запись в GitHub доступна" : "Запись в GitHub закрыта"}
          </span>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {Object.entries(readiness.required_permissions).map(([permission, level]) => {
          const ready = readiness.connections.some(
            (connection) => connection.permission_ready || connection.current_permissions[permission] === level
          );
          return (
            <div className="flex items-start gap-2 rounded-md border border-subtle bg-surface-2 p-2" key={permission}>
              {ready ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-icon-success-primary" aria-hidden="true" />
              ) : (
                <X className="mt-0.5 size-3.5 shrink-0 text-icon-warning-primary" aria-hidden="true" />
              )}
              <div>
                <p className="text-12 font-semibold text-primary">
                  {WRITE_PERMISSION_LABELS[permission] ?? permission}
                </p>
                <p className="mt-0.5 text-11 text-tertiary">Требуется: {PERMISSION_LEVEL_LABELS[level] ?? level}</p>
              </div>
            </div>
          );
        })}
      </div>

      {readiness.connections.length > 0 && (
        <div className="mt-3 grid gap-2">
          {readiness.connections.map((connection) => (
            <div className="flex flex-wrap items-center justify-between gap-2 text-12" key={connection.connection_id}>
              <span className="font-medium text-secondary">{connection.repository_full_name}</span>
              <span className={connection.permission_ready ? "text-success-primary" : "text-warning-primary"}>
                {connection.permission_ready
                  ? "Права готовы"
                  : `Не хватает: ${connection.missing_permissions.join(", ") || "активного подключения"}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {readiness.blockers.includes("GITHUB_PERMISSIONS_MISSING") && (
        <div className="mt-3 rounded-md border border-warning-subtle bg-warning-subtle p-3">
          <p className="text-12 font-semibold text-primary">Как выдать права безопасно</p>
          <ol className="mt-2 grid list-decimal gap-1 pl-4 text-12 leading-5 text-secondary">
            <li>В настройках GitHub App откройте «Permissions &amp; events» → «Repository permissions».</li>
            <li>Для «Contents» и «Pull requests» выберите «Read and write», затем сохраните изменения.</li>
            <li>В установке приложения подтвердите запрос новых прав только для нужных репозиториев.</li>
            {canRefresh ? (
              <li>Вернитесь сюда и нажмите «Проверить права».</li>
            ) : (
              <li>Попросите администратора проекта проверить права на этой странице.</li>
            )}
          </ol>
          <p className="mt-2 text-12 leading-5 text-tertiary">
            Эти права ещё ничего не создают сами по себе: ветка и черновик PR потребуют отдельных подтверждений в PPM.
          </p>
        </div>
      )}

      {readiness.blockers.length > 0 && (
        <ul className="mt-3 grid gap-1 border-t border-subtle pt-3 text-12 leading-5 text-tertiary">
          {readiness.blockers.map((blocker) => (
            <li className="flex gap-2" key={blocker}>
              <span aria-hidden="true">•</span>
              <span>{WRITE_BLOCKER_LABELS[blocker]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GitWriteDialogError({ error }: { error?: TPpmGitWriteDialogError }) {
  if (!error) return null;
  return (
    <div
      className="rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 leading-5 text-primary"
      role="alert"
    >
      {error.message}
      {safeGithubUrl(error.url) && (
        <a
          className="ml-2 inline-flex items-center gap-1 font-semibold text-accent-primary underline"
          href={error.url}
          rel="noreferrer"
          target="_blank"
        >
          Открыть в GitHub <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

export function GitWriteBranchForm({
  error,
  form,
  onChange,
  onClose,
  onQueryChange,
  onRepositoryChange,
  onSearch,
  onSelectWorkItem,
  onSubmit,
  repositories,
  repositoryId,
  saving,
  searching,
  workItem,
  workItemQuery,
  workItems,
}: {
  error?: TPpmGitWriteDialogError;
  form: TPpmGitWriteForm;
  onChange: (form: TPpmGitWriteForm) => void;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
  onSearch: () => void;
  onSelectWorkItem: (item: TPpmWorkItemProjection) => void;
  onSubmit: (event: FormEvent) => void;
  repositories: TPpmGitRepository[];
  repositoryId: string;
  saving: boolean;
  searching: boolean;
  workItem?: TPpmGitWriteWorkItem;
  workItemQuery: string;
  workItems: TPpmWorkItemProjection[];
}) {
  return (
    <form className="grid gap-4" onSubmit={onSubmit}>
      <GitWriteDialogError error={error} />
      <label className="text-12 font-semibold text-secondary">
        Подключённый репозиторий
        <select
          className="mt-2 w-full rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
          value={repositoryId}
          onChange={(event) => onRepositoryChange(event.target.value)}
        >
          {repositories.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.provider_full_name || repository.name}
            </option>
          ))}
        </select>
      </label>
      <div>
        <label className="text-12 font-semibold text-secondary" htmlFor="ppm-git-write-work-item-search">
          Задача проекта
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="ppm-git-write-work-item-search"
            className="min-w-0 flex-1 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary"
            placeholder="Ключ или название"
            value={workItemQuery}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <button
            type="button"
            className="grid size-9 place-items-center rounded-md border border-subtle text-secondary hover:text-primary"
            aria-label="Найти задачу"
            onClick={onSearch}
          >
            {searching ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
          </button>
        </div>
        {workItem && (
          <div className="mt-2 rounded-md border border-accent-strong/40 bg-accent-primary/5 p-2 text-12 text-primary">
            <strong>{workItem.identifier}</strong> · {workItem.title}
          </div>
        )}
        {workItems.length > 0 && !workItem && (
          <div className="mt-2 max-h-36 overflow-y-auto rounded-md border border-subtle bg-surface-2 p-1">
            {workItems.map((item) => (
              <button
                type="button"
                className="block w-full rounded px-2 py-2 text-left text-12 text-secondary hover:bg-layer-1 hover:text-primary"
                key={item.identity.entity_id}
                onClick={() => onSelectWorkItem(item)}
              >
                <strong className="text-primary">{item.identity.identifier}</strong> · {item.display.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormInput
          label="Базовая ветка"
          required
          value={form.base_ref}
          onChange={(value) => onChange({ ...form, base_ref: value })}
        />
        <FormInput
          label="Новая ветка"
          placeholder="gwa-1/draft-pr"
          required
          value={form.head_ref}
          onChange={(value) => onChange({ ...form, head_ref: value })}
        />
      </div>
      <FormInput
        label="Название будущего черновика PR"
        maxLength={PULL_REQUEST_TITLE_MAX_LENGTH}
        required
        value={form.title}
        onChange={(value) => onChange({ ...form, title: value })}
      />
      <label className="text-12 font-semibold text-secondary">
        Описание будущего черновика PR
        <textarea
          className="mt-2 min-h-28 w-full resize-y rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
          maxLength={20000}
          value={form.body}
          onChange={(event) => onChange({ ...form, body: event.target.value })}
        />
      </label>
      <p className="text-12 leading-5 text-tertiary">
        Шаг 1 создаст только ветку от текущего коммита базовой ветки — без коммитов и изменения файлов. Черновик PR —
        отдельный шаг после вашего первого push. Сейчас GitHub не изменяется.
      </p>
      <DialogActions
        disabled={!repositoryId || !workItem || !form.base_ref || !form.head_ref || !form.title}
        onClose={onClose}
        saving={saving}
        submitLabel="Показать точный предпросмотр"
      />
    </form>
  );
}

export function GitWritePullRequestForm({
  error,
  form,
  onChange,
  onClose,
  onSubmit,
  parent,
  saving,
}: {
  error?: TPpmGitWriteDialogError;
  form: TPpmGitWriteForm;
  onChange: (form: TPpmGitWriteForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  parent: TPpmGitWriteAction;
  saving: boolean;
}) {
  const branch = parent.preview.branch;
  return (
    <form className="grid gap-4" onSubmit={onSubmit}>
      <GitWriteDialogError error={error} />
      <PreviewRow label="Репозиторий" value={parent.preview.repository.full_name} />
      <PreviewRow label="Ветки" value={`${branch.head_ref} → ${branch.base_ref}`} />
      <PreviewRow
        label="Связанная задача"
        value={`${parent.preview.work_item.identifier} · ${parent.preview.work_item.title}`}
      />
      <FormInput
        label="Название черновика PR"
        maxLength={PULL_REQUEST_TITLE_MAX_LENGTH}
        required
        value={form.title}
        onChange={(value) => onChange({ ...form, title: value })}
      />
      <label className="text-12 font-semibold text-secondary">
        Описание черновика PR
        <textarea
          className="mt-2 min-h-28 w-full resize-y rounded-md border border-subtle bg-surface-2 px-3 py-2 text-13 text-primary outline-none focus:border-accent-strong"
          maxLength={20000}
          value={form.body}
          onChange={(event) => onChange({ ...form, body: event.target.value })}
        />
      </label>
      <p className="text-12 leading-5 text-tertiary">
        PPM прочитает в GitHub точные коммиты ветки и покажет их до подтверждения. Если новых коммитов нет — сначала
        сделайте commit и push: PPM не создаёт скрытых пустых коммитов.
      </p>
      <DialogActions
        disabled={!form.title}
        onClose={onClose}
        saving={saving}
        submitLabel="Показать точный предпросмотр"
      />
    </form>
  );
}

function commandLabel(command: TPpmGitWriteCommand, action: TPpmGitWriteAction, view: TPpmGitWriteView) {
  switch (command) {
    case "approve":
      return action.stage === "pull_request" ? "Подтвердить черновик PR" : "Подтвердить создание ветки";
    case "reject":
      return "Отклонить";
    case "apply":
    case "retry":
      return view.applyLabel ?? "Повторить";
    case "cancel":
      return "Отменить";
    case "prepare_pull_request":
      return "Подготовить черновик PR";
    case "prepare_again":
      return "Подготовить заново";
    case "open_follow_up":
      return "Открыть шаг 2";
  }
}

export function GitWriteActionDetails({
  action,
  canManage,
  copied,
  error,
  onCommand,
  onCopy,
  onRefresh,
  saving,
}: {
  action: TPpmGitWriteAction;
  canManage: boolean;
  copied?: string;
  error?: TPpmGitWriteDialogError;
  onCommand: (command: TPpmGitWriteCommand) => void;
  onCopy: (value: string, key: string) => void;
  onRefresh: () => void;
  saving: boolean;
}) {
  const view = getGitWriteActionView(action, { canManage });
  const { preview } = action;
  const commits = preview.commits;
  const manualKey = `git-write-manual-${action.id}`;
  const reasonId = `git-write-apply-reason-${action.id}`;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-subtle bg-surface-2 px-2 py-1 text-11 font-semibold text-secondary">
          {view.stageLabel}
        </span>
        <span className={`rounded-full border px-2 py-1 text-11 font-semibold ${TONE_CLASS_NAMES[view.tone]}`}>
          {view.statusLabel}
        </span>
        {action.status === "applying" && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-subtle px-2 py-1 text-11 font-semibold text-secondary"
            disabled={saving}
            onClick={onRefresh}
          >
            <RefreshCw className="size-3" aria-hidden="true" /> Обновить
          </button>
        )}
      </div>
      <GitWriteDialogError error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <PreviewRow label="Репозиторий" value={preview.repository.full_name} />
        <PreviewRow label="Аккаунт GitHub" value={preview.provider.account_login} />
      </div>
      {action.stage === "pull_request" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <PreviewRow
            label="Базовая ветка"
            title={preview.branch.base_sha}
            value={`${preview.branch.base_ref} @ ${shortSha(preview.branch.base_sha)}`}
          />
          <PreviewRow
            label="Ветка с изменениями"
            title={preview.branch.head_sha}
            value={`${preview.branch.head_ref} @ ${shortSha(preview.branch.head_sha)}`}
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <PreviewRow
            label="От коммита базовой ветки"
            title={preview.branch.base_sha}
            value={
              preview.branch.base_sha
                ? `${preview.branch.base_ref} @ ${shortSha(preview.branch.base_sha)}`
                : preview.branch.base_ref
            }
          />
          <PreviewRow label="Новая ветка" value={preview.branch.head_ref} />
        </div>
      )}
      <PreviewRow label="Связанная задача" value={`${preview.work_item.identifier} · ${preview.work_item.title}`} />
      {commits && (
        <div className="rounded-lg border border-subtle bg-layer-1 p-3">
          <p className="text-11 font-semibold tracking-wide text-tertiary uppercase">
            Коммиты в черновике PR: {commits.ahead_by}
          </p>
          <ul className="mt-2 grid gap-1">
            {commits.items.map((commit) => (
              <li className="flex gap-2 text-12 leading-5 text-secondary" key={commit.sha}>
                <code className="shrink-0 text-primary" title={commit.sha}>
                  {shortSha(commit.sha)}
                </code>
                <span className="min-w-0 flex-1 break-words">{commit.title}</span>
                {commit.author && <span className="shrink-0 text-tertiary">{commit.author}</span>}
              </li>
            ))}
          </ul>
          {commits.truncated && (
            <p className="mt-2 text-12 text-tertiary">
              И ещё {Math.max(commits.ahead_by - commits.items.length, 0)} — полный список в GitHub.
            </p>
          )}
        </div>
      )}
      {preview.previous_pull_requests && preview.previous_pull_requests.length > 0 && (
        <div className="rounded-lg border border-subtle bg-layer-1 p-3 text-12 leading-5 text-secondary">
          Ранее для этих веток были PR (закрыты или слиты) — они не мешают новому черновику:{" "}
          {preview.previous_pull_requests.map((pullRequest, index) => (
            <span key={pullRequest.provider_object_id}>
              {index > 0 && ", "}
              {safeGithubUrl(pullRequest.canonical_url) ? (
                <a
                  className="font-semibold text-accent-primary underline"
                  href={safeGithubUrl(pullRequest.canonical_url)}
                  rel="noreferrer"
                  target="_blank"
                >
                  #{pullRequest.number}
                </a>
              ) : (
                `#${pullRequest.number}`
              )}
            </span>
          ))}
        </div>
      )}
      <PreviewRow
        label={preview.draft_pull_request.planned ? "Название будущего черновика PR (шаг 2)" : "Название черновика PR"}
        value={preview.draft_pull_request.title}
      />
      {action.stage !== "branch" && (
        <div className="rounded-lg border border-subtle bg-layer-1 p-3">
          <p className="text-11 font-semibold tracking-wide text-tertiary uppercase">Описание черновика PR</p>
          <pre className="mt-2 max-h-40 overflow-auto text-12 leading-5 whitespace-pre-wrap text-secondary">
            {preview.draft_pull_request.body || "Без описания"}
          </pre>
          {preview.draft_pull_request.marker && (
            <p className="mt-2 text-12 leading-5 text-tertiary">
              В конец описания PPM добавит служебную отметку <code>{preview.draft_pull_request.marker}</code> — в GitHub
              она не видна; по ней при повторе PPM узнаёт только свой PR.
            </p>
          )}
        </div>
      )}
      <div className="rounded-lg border border-subtle bg-layer-1 p-3 text-12 leading-5 text-secondary">
        {preview.safety.message} Автоматический merge в PPM отсутствует.
      </div>
      {view.notice && (
        <p className={`rounded-lg border p-3 text-12 leading-5 ${TONE_CLASS_NAMES[view.tone]}`}>{view.notice}</p>
      )}
      {view.resultUrl && (
        <a
          className="inline-flex w-fit items-center gap-1.5 text-12 font-semibold text-accent-primary underline"
          href={view.resultUrl}
          rel="noreferrer"
          target="_blank"
        >
          Открыть в GitHub <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      )}
      {view.checkUrl && (
        <a
          className="inline-flex w-fit items-center gap-1.5 text-12 font-semibold text-accent-primary underline"
          href={view.checkUrl}
          rel="noreferrer"
          target="_blank"
        >
          Проверить в GitHub <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      )}
      {view.manual?.kind === "branch" && (
        <div className="rounded-lg border border-warning-subtle bg-warning-subtle p-3">
          <p className="text-12 font-semibold text-primary">Как создать ветку вручную</p>
          <p className="mt-1 text-12 leading-5 text-secondary">
            Выполните в своей копии репозитория: ветка начнётся ровно с показанного коммита. PPM увидит её по webhook и
            свяжет с задачей, если в имени ветки есть ключ задачи.
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-subtle bg-surface-2 p-2 text-12 leading-5 text-primary">
            <code>{view.manual.commands.join("\n")}</code>
          </pre>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-secondary hover:bg-surface-2"
            onClick={() => view.manual?.kind === "branch" && onCopy(view.manual.commands.join("\n"), manualKey)}
          >
            {copied === manualKey ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
            {copied === manualKey ? "Скопировано" : "Скопировать команды"}
          </button>
        </div>
      )}
      {view.manual?.kind === "branch_link" && (
        <div className="rounded-lg border border-warning-subtle bg-warning-subtle p-3">
          <p className="text-12 font-semibold text-primary">Как создать ветку вручную</p>
          <p className="mt-1 text-12 leading-5 text-secondary">
            Имя ветки нельзя безопасно вставить в терминал, поэтому готовых команд нет. Создайте ветку в GitHub: на
            странице веток нажмите «New branch», имя — как в предпросмотре, источник — {view.manual.baseRef}
            {view.manual.baseSha ? ` @ ${shortSha(view.manual.baseSha)}` : ""}.
          </p>
          <a
            className="mt-2 inline-flex items-center gap-1.5 text-12 font-semibold text-accent-primary underline"
            href={safeGithubUrl(view.manual.url)}
            rel="noreferrer"
            target="_blank"
          >
            Открыть ветки в GitHub <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      )}
      {view.manual?.kind === "pull_request" && (
        <div className="rounded-lg border border-warning-subtle bg-warning-subtle p-3">
          <p className="text-12 font-semibold text-primary">Как создать черновик PR вручную</p>
          <p className="mt-1 text-12 leading-5 text-secondary">
            Откройте сравнение веток в GitHub, выберите «Create draft pull request» и вставьте название и описание из
            предпросмотра. PPM подхватит PR по webhook и свяжет его с задачей.
          </p>
          <a
            className="mt-2 inline-flex items-center gap-1.5 text-12 font-semibold text-accent-primary underline"
            href={safeGithubUrl(view.manual.url)}
            rel="noreferrer"
            target="_blank"
          >
            Открыть сравнение в GitHub <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      )}
      {view.commands.length > 0 && (
        <div className="mt-1 flex flex-wrap justify-end gap-2 border-t border-subtle pt-4">
          {view.commands.map((command) => {
            const blocked = (command === "apply" || command === "retry") && Boolean(view.applyDisabledReason);
            return (
              <button
                aria-describedby={blocked ? reasonId : undefined}
                className={
                  PRIMARY_COMMANDS.has(command)
                    ? "rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
                    : "rounded-md border border-subtle px-3 py-2 text-12 text-primary disabled:opacity-50"
                }
                disabled={saving || blocked}
                key={command}
                type="button"
                onClick={() => onCommand(command)}
              >
                {saving && PRIMARY_COMMANDS.has(command) ? "Сохраняем…" : commandLabel(command, action, view)}
              </button>
            );
          })}
        </div>
      )}
      {view.applyDisabledReason && view.commands.some((command) => command === "apply" || command === "retry") && (
        <p className="text-right text-12 leading-5 text-tertiary" id={reasonId}>
          {view.applyDisabledReason}
        </p>
      )}
    </div>
  );
}
