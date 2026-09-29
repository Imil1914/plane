// Blocks of the «Код» page shared by both providers (moved out of route.tsx for G2.1): a repository card and a row of
// a provider connection. They name the provider of their repository or connection (git-provider-labels.ts).
import { Archive, Check, Clipboard, Code2, ExternalLink, RefreshCw, Search, Star } from "lucide-react";
import Link from "next/link";
import { getPpmGitWebhookStatus, type TPpmGitWebhookStatus } from "@/helpers/ppm-git-webhook-status.helper";
import type { TPpmGitConnection, TPpmGitProvider, TPpmGitRepository } from "@/services/ppm-git.service";
import { GitCloneCommands, type TPpmForgejoIdentityHint } from "./git-clone-commands";
import {
  getGitCodeSearchConnectHint,
  getGitConnectionStatusLabel,
  getGitProviderLabel,
  getGitRepositoryOpenLabel,
} from "./git-provider-labels";

export const PPM_GIT_VISIBILITY_LABELS: Record<TPpmGitRepository["visibility"], string> = {
  public: "публичный",
  private: "приватный",
  internal: "внутренний",
  unknown: "видимость не указана",
};

const CODE_INDEX_STATUS_LABELS = {
  failed: "Ошибка индексации",
  pending: "Индексация ожидает запуска",
  ready: "Код доступен Мозгу проекта",
  revoked: "Индекс удалён",
  superseded: "Снимок заменён",
} as const;

const WEBHOOK_STATUS_CLASS_NAMES: Record<TPpmGitWebhookStatus["tone"], string> = {
  confirmed: "border-success-subtle bg-success-subtle text-success-primary",
  waiting: "border-warning-subtle bg-warning-subtle text-warning-primary",
  inactive: "border-subtle bg-surface-2 text-tertiary",
};

/** A connected repository in a provider panel: status, webhook, last error and — for managers — sync/disconnect. */
export function GitConnectionRow({
  canDisconnect,
  canSync,
  connection,
  onDisconnect,
  onSync,
  openUrl,
  provider,
  saving,
}: {
  canDisconnect: boolean;
  canSync: boolean;
  connection: TPpmGitConnection;
  onDisconnect: (connection: TPpmGitConnection) => void;
  onSync: (connection: TPpmGitConnection) => void;
  /** «Открыть на Git-сервере ↗» — our Git server only. */
  openUrl?: string | null;
  provider: TPpmGitProvider;
  saving: boolean;
}) {
  const webhookStatus = getPpmGitWebhookStatus(connection);
  const canAct = (canSync || canDisconnect) && !["disconnected", "revoked"].includes(connection.status);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-layer-1 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate text-12 font-semibold text-primary">{connection.provider_full_name}</p>
        <p className="mt-1 text-11 text-tertiary">
          {getGitConnectionStatusLabel(connection.status, provider)}
          {connection.last_sync_at
            ? ` · синхронизирован ${new Date(connection.last_sync_at).toLocaleString("ru-RU")}`
            : ""}
        </p>
        <p
          className={`mt-2 inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-md border px-2 py-1 text-11 ${WEBHOOK_STATUS_CLASS_NAMES[webhookStatus.tone]}`}
          aria-label={`Статус webhook: ${webhookStatus.label}, ${webhookStatus.detail}`}
        >
          <span className="font-semibold">{webhookStatus.label}</span>
          <span aria-hidden="true">·</span>
          <span>{webhookStatus.detail}</span>
        </p>
        {connection.last_error && <p className="mt-1 text-12 text-danger-primary">{connection.last_error.message}</p>}
        {openUrl && (
          <a
            className="mt-2 flex w-fit items-center gap-1 text-12 font-semibold text-accent-primary hover:underline"
            href={openUrl}
            target="_blank"
            rel="noreferrer"
          >
            Открыть на Git-сервере <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
      {canAct && (
        <div className="flex gap-2">
          {canSync && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 text-primary disabled:opacity-50"
              disabled={saving}
              onClick={() => onSync(connection)}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" /> Обновить
            </button>
          )}
          {canDisconnect && (
            <button
              type="button"
              className="rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
              disabled={saving}
              onClick={() => onDisconnect(connection)}
            >
              Отключить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function RepositoryCard({
  canManage,
  canManageCode,
  canvasHref,
  copied,
  forgejoIdentity,
  hasActiveConnection,
  onArchive,
  onCopy,
  onMakeDefault,
  onSyncCode,
  onToggleCode,
  openUrl,
  repository,
  saving,
}: {
  canManage: boolean;
  canManageCode: boolean;
  /** «На холст» (route.tsx builds it: the canvas reads exactly the parameters it puts there). */
  canvasHref: string;
  copied?: string;
  /** G2.2 (R21): forwarded to «Как скачать код» — the viewer's own username hint, only for a forgejo repository
   * under single sign-on (route.tsx decides; this component stays a pure function of its props). */
  forgejoIdentity?: TPpmForgejoIdentityHint;
  hasActiveConnection: boolean;
  onArchive: (repository: TPpmGitRepository) => void;
  onCopy: (value: string, key: string) => void;
  onMakeDefault: (repository: TPpmGitRepository) => void;
  onSyncCode: (repository: TPpmGitRepository) => void;
  onToggleCode: (repository: TPpmGitRepository, enabled: boolean) => void;
  /** G2.2 (R21): a one-click Git-server sign-in link when the repository is ours and single sign-on is configured
   * (route.tsx: `getForgejoSsoOpenUrl`); falls back to `repository.canonical_url` (G2.1 behaviour) otherwise. */
  openUrl?: string | null;
  repository: TPpmGitRepository;
  saving: boolean;
}) {
  const snapshot = repository.code_index.snapshot;
  const openLabel = getGitRepositoryOpenLabel(repository.provider);
  const connectHint = getGitCodeSearchConnectHint(repository.provider);
  return (
    <article className="rounded-xl border border-subtle bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-14 font-semibold text-primary">{repository.name}</h3>
            {repository.is_default && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-11 font-semibold text-warning-primary">
                <Star className="size-3 fill-current" aria-hidden="true" /> Основной
              </span>
            )}
          </div>
          <p className="mt-1 text-11 text-tertiary">
            {getGitProviderLabel(repository.provider)} · {PPM_GIT_VISIBILITY_LABELS[repository.visibility]}
            {repository.default_branch ? ` · ${repository.default_branch}` : ""}
          </p>
        </div>
        <a
          className="text-secondary hover:text-primary"
          href={openUrl ?? repository.canonical_url}
          target="_blank"
          rel="noreferrer"
          aria-label={openLabel}
          title={openLabel}
        >
          <ExternalLink className="size-4" />
        </a>
      </div>

      <CloneRow
        copied={copied === `${repository.id}:https`}
        label="HTTPS"
        value={repository.clone_https}
        onCopy={() => onCopy(repository.clone_https, `${repository.id}:https`)}
      />
      {repository.clone_ssh && (
        <CloneRow
          copied={copied === `${repository.id}:ssh`}
          label="SSH"
          value={repository.clone_ssh}
          onCopy={() => onCopy(repository.clone_ssh, `${repository.id}:ssh`)}
        />
      )}
      <GitCloneCommands copied={copied} forgejoIdentity={forgejoIdentity} onCopy={onCopy} repository={repository} />

      <div className="mt-3 rounded-lg border border-subtle bg-layer-1 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-12 font-semibold text-primary">
              <Search className="size-3.5 text-accent-primary" aria-hidden="true" /> Поиск по коду
            </p>
            <p className="mt-1 text-12 leading-5 text-secondary">
              {!repository.code_index.enabled
                ? "Выключен: PPM не читает содержимое файлов."
                : snapshot
                  ? CODE_INDEX_STATUS_LABELS[snapshot.status]
                  : "Включён: первый безопасный снимок создаётся в фоне."}
            </p>
          </div>
          <span
            className={`mt-0.5 size-2 shrink-0 rounded-full bg-current ${
              snapshot?.status === "ready"
                ? "text-icon-success-primary"
                : snapshot?.status === "failed"
                  ? "text-icon-danger-primary"
                  : repository.code_index.enabled
                    ? "text-icon-warning-primary"
                    : "text-icon-tertiary"
            }`}
            aria-hidden="true"
          />
        </div>
        {repository.code_index.enabled && snapshot && (
          <div className="mt-2 text-11 leading-5 text-tertiary">
            <p>
              Ветка {snapshot.branch} · коммит {snapshot.commit_sha.slice(0, 12)}
            </p>
            {snapshot.status === "ready" && (
              <p>
                {snapshot.file_count} файлов · {formatBytes(snapshot.total_bytes)} безопасного текста
              </p>
            )}
            {snapshot.error?.message && <p className="text-danger-primary">{snapshot.error.message}</p>}
          </div>
        )}
        {canManageCode && (
          <div className="mt-3 flex flex-wrap gap-2">
            {repository.code_index.enabled ? (
              <>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-2 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={saving || !hasActiveConnection}
                  onClick={() => onSyncCode(repository)}
                >
                  <RefreshCw className={`size-3.5 ${saving ? "animate-spin" : ""}`} aria-hidden="true" /> Обновить
                </button>
                <button
                  type="button"
                  className="rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-danger-subtle hover:text-danger-primary disabled:opacity-50"
                  disabled={saving}
                  onClick={() => onToggleCode(repository, false)}
                >
                  Выключить и удалить индекс
                </button>
              </>
            ) : (
              <button
                type="button"
                className="rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-2 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={saving || !hasActiveConnection}
                title={hasActiveConnection ? undefined : connectHint.title}
                onClick={() => onToggleCode(repository, true)}
              >
                Включить безопасный поиск
              </button>
            )}
          </div>
        )}
        {!hasActiveConnection && canManageCode && <p className="mt-2 text-12 text-tertiary">{connectHint.note}</p>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-subtle pt-3">
        <Link
          className="inline-flex items-center gap-1.5 rounded-md border border-subtle px-2.5 py-1.5 text-12 font-semibold text-primary hover:bg-layer-1"
          href={canvasHref}
        >
          <Code2 className="size-3.5" aria-hidden="true" /> На холст
        </Link>
        {canManage && !repository.is_default && (
          <button
            type="button"
            className="rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-layer-1 hover:text-primary"
            onClick={() => onMakeDefault(repository)}
          >
            Сделать основным
          </button>
        )}
        {canManage && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-12 text-secondary hover:bg-danger-subtle hover:text-danger-primary"
            onClick={() => onArchive(repository)}
          >
            <Archive className="size-3.5" aria-hidden="true" /> Убрать
          </button>
        )}
      </div>
    </article>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

// The clone address itself (for an IDE's «Clone repository»); ready terminal commands are in «Как скачать код».
function CloneRow({
  copied,
  label,
  onCopy,
  value,
}: {
  copied: boolean;
  label: string;
  onCopy: () => void;
  value: string;
}) {
  return (
    <div className="mt-3 grid grid-cols-[3.2rem_minmax(0,1fr)_2rem] items-center gap-2 rounded-md border border-subtle bg-layer-1 px-2 py-1.5">
      <span className="text-11 font-semibold text-tertiary">{label}</span>
      <code className="truncate text-12 text-secondary" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="grid size-7 place-items-center rounded text-secondary hover:bg-layer-2 hover:text-primary"
        aria-label={`Копировать ${label}`}
        onClick={onCopy}
      >
        {copied ? <Check className="size-3.5 text-icon-success-primary" /> : <Clipboard className="size-3.5" />}
      </button>
    </div>
  );
}
