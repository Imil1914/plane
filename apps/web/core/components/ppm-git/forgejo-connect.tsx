// G2.1 (R10): our Git server (Forgejo next to PPM) on the «Код» page — its panel with the connect button and its
// connections, and the repository picker shown in the page's dialog frame (route.tsx keeps the dismissal policy).
// Only a PPM global administrator connects and disconnects: the Git server's service account sees all the code.
// Hooks live in useForgejoRepositoryPicker and ForgejoRepositoryPicker only: the views are plain functions of props.
import { useEffect, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { Archive, Check, LoaderCircle, Lock, LogIn, RefreshCw, Search, Server } from "lucide-react";
import type { TPpmForgejoRepository, TPpmGitConnection, TPpmGitRepository } from "@/services/ppm-git.service";
import {
  createForgejoRepositoryPicker,
  type TForgejoPickerDeps,
  type TForgejoPickerState,
  type TForgejoRepositoryPicker,
} from "./forgejo-repository-picker";
import { getForgejoSsoOpenUrl, safeGitWebUrl } from "./git-provider-labels";
import { GitConnectionRow } from "./git-section-parts";

/** G2.2 (R17): pre-resolved text for the «no personal account yet» hint — kept as plain strings (not a `ppmT` call)
 * so this whole view tree stays hook-free: some tests call it by invoking the component functions directly
 * (`element-tree.ts`'s `hostElements`/`press`), which has no React dispatcher for hooks to run against. Callers
 * resolve the strings with `usePpmTranslation()` where they do hold hooks (`GitServerRepositoryDialog`, route.tsx).
 */
export type TForgejoAccountRequiredHint = {
  title: string;
  description: string;
  action: string;
  /** `sso_login_url`, or null without single sign-on — then the hint shows no link, just the text. */
  loginUrl: string | null;
};

const CONNECT_HINT_ID = "ppm-git-server-connect-hint";

export function ForgejoConnectButton({
  canConnect,
  disabled,
  onClick,
}: {
  canConnect: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  if (canConnect) {
    return (
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-2 rounded-md bg-accent-primary px-3 py-2 text-12 font-semibold text-on-accent disabled:opacity-50"
        disabled={disabled}
        onClick={onClick}
      >
        <Server className="size-4" aria-hidden="true" /> Подключить с нашего Git-сервера
      </button>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
      <button
        type="button"
        className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-subtle px-3 py-2 text-12 font-semibold text-tertiary"
        disabled
        aria-describedby={CONNECT_HINT_ID}
      >
        <Server className="size-4" aria-hidden="true" /> Подключить с нашего Git-сервера
      </button>
      <p id={CONNECT_HINT_ID} className="text-11 text-tertiary">
        {/* G2.2 review round 1 (#7): under single sign-on a project administrator can connect too (R17), not only
            the PPM global administrator (G2.1) — the hint now names both possible connectors. */}
        Репозиторий подключает администратор проекта или PPM
      </p>
    </div>
  );
}

/** Shown while our Git server is set up, or while the project still has its connections (history stays). */
export function ForgejoProviderPanel({
  canConnect,
  canSync,
  configured,
  connections,
  onConnect,
  onDisconnect,
  onSync,
  publicUrl,
  repositories,
  saving,
  ssoEnabled = false,
  ssoLoginUrl = null,
}: {
  /** `capabilities.connect_git_server_repositories` (falls back to `manage_git_server` on an older API, G2.2 R17):
   * connect and disconnect. */
  canConnect: boolean;
  /** `capabilities.manage_provider`: sync now, as for GitHub. */
  canSync: boolean;
  configured: boolean;
  connections: TPpmGitConnection[];
  onConnect: () => void;
  onDisconnect: (connection: TPpmGitConnection) => void;
  onSync: (connection: TPpmGitConnection) => void;
  publicUrl: string | null;
  repositories: TPpmGitRepository[];
  saving: boolean;
  /** G2.2 (R21): single sign-on is configured — a connection's «Открыть на Git-сервере» becomes a one-click link. */
  ssoEnabled?: boolean;
  ssoLoginUrl?: string | null;
}) {
  if (!configured && connections.length === 0) return null;
  const serverUrl = safeGitWebUrl(publicUrl);
  return (
    <section className="rounded-xl border border-subtle bg-surface-2 p-5" aria-labelledby="ppm-git-server-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-layer-1 text-primary">
            <Server className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id="ppm-git-server-title" className="text-16 font-semibold text-primary">
              Наш Git-сервер
            </h2>
            <p className="mt-1 max-w-2xl text-12 leading-5 text-secondary">
              Репозитории команды рядом с PPM: ветки, коммиты и запросы на слияние попадают в проект сами. PPM читает их
              служебной учётной записью только на чтение.
            </p>
            {!configured && (
              <p className="mt-2 text-12 text-tertiary">
                Git-сервер не настроен: синхронизация приостановлена, история и связи сохранены.
              </p>
            )}
            {serverUrl && (
              <a
                className="mt-2 inline-flex items-center gap-1 text-12 font-semibold text-accent-primary hover:underline"
                href={serverUrl}
                target="_blank"
                rel="noreferrer"
              >
                Открыть на Git-сервере <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
        </div>
        {configured && <ForgejoConnectButton canConnect={canConnect} disabled={saving} onClick={onConnect} />}
      </div>

      {connections.length > 0 && (
        <div className="mt-4 grid gap-2 border-t border-subtle pt-4">
          {connections.map((connection) => {
            const repository = repositories.find((item) => item.id === connection.repository_id);
            // G2.2 (R21): a one-click sign-in link when single sign-on is configured, else the plain repository page
            // (G2.1 behaviour, unchanged) — same fallback order the repository card below uses.
            const openUrl =
              (ssoEnabled ? getForgejoSsoOpenUrl(ssoLoginUrl, repository?.provider_full_name) : null) ??
              safeGitWebUrl(repository?.canonical_url);
            return (
              <GitConnectionRow
                canDisconnect={canConnect}
                canSync={canSync}
                connection={connection}
                key={connection.id}
                onDisconnect={onDisconnect}
                onSync={onSync}
                openUrl={openUrl}
                provider="forgejo"
                saving={saving}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

/** One picker per open dialog: loads on open, stops listening on close (answers after that are dropped). */
export function useForgejoRepositoryPicker(deps: TForgejoPickerDeps): {
  picker: TForgejoRepositoryPicker;
  state: TForgejoPickerState;
} {
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });
  const [picker] = useState(() =>
    createForgejoRepositoryPicker({
      list: (request) => depsRef.current.list(request),
      connect: (providerRepositoryId) => depsRef.current.connect(providerRepositoryId),
      onConnected: () => depsRef.current.onConnected(),
    })
  );
  const state = useSyncExternalStore(picker.subscribe, picker.getState, picker.getState);
  useEffect(() => {
    picker.start();
    return () => picker.dispose();
  }, [picker]);
  return { picker, state };
}

type TForgejoRepositoryPickerProps = {
  onClose: () => void;
  onConnect: (providerRepositoryId: number) => void;
  onLoadMore: () => void;
  onQueryChange: (value: string) => void;
  onReload: () => void;
  publicUrl: string | null;
  state: TForgejoPickerState;
  /** G2.2 (R17): shown instead of the generic «Повторить» banner when the list fails with
   * `FORGEJO_ACCOUNT_REQUIRED` — the caller (`GitServerRepositoryDialog`) resolves the text once with `ppmT`. */
  accountRequiredHint: TForgejoAccountRequiredHint;
};

export function ForgejoRepositoryPicker(props: TForgejoRepositoryPickerProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  // The search field takes the focus after mount. Headless UI attaches the dialog's portal node only after the content
  // commits, so a ref callback (or autoFocus) would focus a detached field and the focus trap would fall back to the
  // close button; this effect runs after the attach and before the trap's own initial-focus microtask, which keeps a
  // focus that is already inside the dialog.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  return <ForgejoRepositoryPickerView {...props} searchRef={searchRef} />;
}

export function ForgejoRepositoryPickerView({
  accountRequiredHint,
  onClose,
  onConnect,
  onLoadMore,
  onQueryChange,
  onReload,
  publicUrl,
  searchRef,
  state,
}: TForgejoRepositoryPickerProps & { searchRef?: Ref<HTMLInputElement> }) {
  // While a repository is being connected the dialog stays open (the frame's Esc, backdrop and × are held too).
  const busy = state.connectingId !== undefined;
  return (
    <div className="grid gap-4">
      <div>
        <label className="text-12 font-semibold text-secondary" htmlFor="ppm-forgejo-search">
          Поиск по названию
        </label>
        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary"
            aria-hidden="true"
          />
          <input
            id="ppm-forgejo-search"
            ref={searchRef}
            className="w-full rounded-md border border-subtle bg-surface-2 py-2 pr-9 pl-9 text-13 text-primary outline-none focus:border-accent-strong"
            autoComplete="off"
            placeholder="Например, robot"
            spellCheck={false}
            value={state.query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {state.loading === "list" && state.items.length > 0 && (
            <LoaderCircle
              className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-tertiary"
              aria-hidden="true"
            />
          )}
        </div>
      </div>

      {state.connectError && (
        <p className="rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 text-primary" role="alert">
          {state.connectError}
        </p>
      )}

      <ForgejoRepositoryResults
        accountRequiredHint={accountRequiredHint}
        busy={busy}
        onConnect={onConnect}
        onLoadMore={onLoadMore}
        onReload={onReload}
        publicUrl={safeGitWebUrl(publicUrl)}
        state={state}
      />

      <p className="text-12 leading-5 text-tertiary">
        PPM читает репозиторий служебной учётной записью только на чтение и ничего не меняет на Git-сервере.
      </p>
      <div className="mt-2 flex justify-end gap-2 border-t border-subtle pt-4">
        <button
          type="button"
          className="rounded-md border border-subtle px-3 py-2 text-12 text-primary disabled:opacity-50"
          disabled={busy}
          onClick={onClose}
        >
          Закрыть
        </button>
      </div>
    </div>
  );
}

function ForgejoRepositoryResults({
  accountRequiredHint,
  busy,
  onConnect,
  onLoadMore,
  onReload,
  publicUrl,
  state,
}: {
  accountRequiredHint: TForgejoAccountRequiredHint;
  busy: boolean;
  onConnect: (providerRepositoryId: number) => void;
  onLoadMore: () => void;
  onReload: () => void;
  publicUrl: string | null;
  state: TForgejoPickerState;
}) {
  if (state.error?.during === "list") {
    // G2.2 (R17): a project administrator without a personal account on our Git server yet sees a sign-in hint
    // instead of «Повторить» — retrying would only repeat the same 409 (backend `views.py`: no account, no list).
    if (state.error.code === "FORGEJO_ACCOUNT_REQUIRED") {
      return (
        <div
          className="flex flex-col items-start gap-3 rounded-lg border border-warning-subtle bg-warning-subtle p-3 text-12 text-primary"
          role="alert"
        >
          <p className="font-semibold">{accountRequiredHint.title}</p>
          <p className="text-secondary">{accountRequiredHint.description}</p>
          {accountRequiredHint.loginUrl && (
            <a
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-12 font-semibold text-on-accent"
              href={accountRequiredHint.loginUrl}
            >
              <LogIn className="size-3.5" aria-hidden="true" /> {accountRequiredHint.action}
            </a>
          )}
        </div>
      );
    }
    return (
      <div
        className="flex flex-col items-start gap-3 rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 text-primary"
        role="alert"
      >
        <span>{state.error.message}</span>
        <button
          type="button"
          className="rounded-md border border-subtle bg-surface-2 px-3 py-1.5 text-12 font-semibold text-primary"
          onClick={onReload}
        >
          Повторить
        </button>
      </div>
    );
  }

  if (state.items.length === 0) {
    if (state.loading === "list") {
      return (
        <p className="flex items-center justify-center gap-2 p-6 text-12 text-secondary" role="status">
          <LoaderCircle className="size-4 animate-spin text-accent-primary" aria-hidden="true" /> Загружаем репозитории…
        </p>
      );
    }
    if (state.appliedQuery) {
      return (
        <p className="rounded-lg border border-dashed border-subtle p-6 text-center text-12 text-secondary">
          Ничего не найдено по запросу «{state.appliedQuery}».
        </p>
      );
    }
    return (
      <div className="rounded-lg border border-dashed border-subtle p-6 text-center text-12 leading-5 text-secondary">
        <p>
          На Git-сервере пока нет репозиториев. Создайте репозиторий на{" "}
          {publicUrl ? (
            <a
              className="font-semibold text-accent-primary hover:underline"
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
            >
              {publicUrl}
            </a>
          ) : (
            "Git-сервере"
          )}{" "}
          и обновите список.
        </p>
        <button
          type="button"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-subtle px-3 py-1.5 text-12 font-semibold text-primary hover:bg-layer-1"
          onClick={onReload}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" /> Обновить список
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <ul className="grid gap-2" aria-label="Репозитории Git-сервера">
        {state.items.map((item) => (
          <ForgejoRepositoryRow
            busy={busy}
            connecting={state.connectingId === item.provider_repository_id}
            item={item}
            key={item.provider_repository_id}
            onConnect={onConnect}
          />
        ))}
      </ul>
      {state.error?.during === "more" && (
        <p className="rounded-lg border border-danger-subtle bg-danger-subtle p-3 text-12 text-primary" role="alert">
          {state.error.message}
        </p>
      )}
      {state.hasNext && (
        <button
          type="button"
          className="justify-self-center rounded-md border border-subtle px-3 py-2 text-12 font-semibold text-primary hover:bg-layer-1 disabled:opacity-50"
          disabled={state.loading !== null || busy}
          onClick={onLoadMore}
        >
          {state.loading === "more" ? "Загружаем…" : "Показать ещё"}
        </button>
      )}
    </div>
  );
}

function ForgejoRepositoryRow({
  busy,
  connecting,
  item,
  onConnect,
}: {
  busy: boolean;
  connecting: boolean;
  item: TPpmForgejoRepository;
  onConnect: (providerRepositoryId: number) => void;
}) {
  const name = item.full_name || `${item.owner}/${item.name}`;
  const inactive = item.connected || item.archived;
  return (
    <li
      className={`flex items-start gap-3 rounded-lg border border-subtle p-3 ${inactive ? "bg-surface-2" : "bg-layer-1"}`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-13 font-semibold text-primary" title={name}>
          {name}
        </p>
        {item.description && <p className="mt-0.5 line-clamp-2 text-12 leading-5 text-secondary">{item.description}</p>}
        {(item.private || item.archived || item.connected) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.private && (
              <span className="inline-flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-11 font-semibold text-secondary">
                <Lock className="size-3" aria-hidden="true" /> Приватный
              </span>
            )}
            {item.archived && (
              <span className="inline-flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-11 font-semibold text-secondary">
                <Archive className="size-3" aria-hidden="true" /> Архивный
              </span>
            )}
            {item.connected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-11 font-semibold text-success-primary">
                <Check className="size-3" aria-hidden="true" /> Подключён
              </span>
            )}
          </div>
        )}
      </div>
      {!inactive && (
        <button
          type="button"
          className="shrink-0 rounded-md bg-accent-primary px-3 py-1.5 text-12 font-semibold text-on-accent disabled:opacity-50"
          aria-label={`${connecting ? "Подключаем" : "Подключить"} ${name}`}
          disabled={busy}
          onClick={() => onConnect(item.provider_repository_id)}
        >
          {connecting ? "Подключаем…" : "Подключить"}
        </button>
      )}
    </li>
  );
}
