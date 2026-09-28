// G2.1 (R10): state of the «Подключить с нашего Git-сервера» dialog, kept outside React so it can be tested without a
// DOM. Search waits for a pause in typing; every new first-page request invalidates older ones, so a late answer to an
// old query (or to a closed dialog) never lands; «Показать ещё» appends the next page of the query on screen; after a
// successful connect the page refreshes the «Код» overview and closes the dialog (`onConnected`).
import {
  PpmGitServiceError,
  type TPpmForgejoRepository,
  type TPpmForgejoRepositoryPage,
} from "@/services/ppm-git.service";

export const FORGEJO_SEARCH_DELAY_MS = 300;

export type TForgejoPickerState = {
  /** What is typed in the search field. */
  query: string;
  /** The search the rows on screen belong to. */
  appliedQuery: string;
  items: TPpmForgejoRepository[];
  page: number;
  hasNext: boolean;
  loading: "list" | "more" | null;
  error?: { message: string; during: "list" | "more" };
  connectingId?: number;
  connectError?: string;
};

export type TForgejoPickerDeps = {
  list: (request: { search: string; page: number }) => Promise<TPpmForgejoRepositoryPage>;
  connect: (providerRepositoryId: number) => Promise<unknown>;
  onConnected: () => Promise<void> | void;
};

export type TForgejoRepositoryPicker = {
  getState: () => TForgejoPickerState;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  dispose: () => void;
  setQuery: (value: string) => void;
  reload: () => void;
  loadMore: () => void;
  connect: (providerRepositoryId: number) => Promise<void>;
};

// The dialog opens loading: its first render (before the effect that starts the picker) shows «Загружаем…», not
// «пока нет репозиториев».
const INITIAL_STATE: TForgejoPickerState = {
  query: "",
  appliedQuery: "",
  items: [],
  page: 0,
  hasNext: false,
  loading: "list",
};

function messageOf(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function isConflict(reason: unknown) {
  return reason instanceof PpmGitServiceError && (reason.status === 409 || reason.code === "GIT_REPOSITORY_CONFLICT");
}

export function createForgejoRepositoryPicker(deps: TForgejoPickerDeps): TForgejoRepositoryPicker {
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let active = false;

  const update = (patch: Partial<TForgejoPickerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const clearSearchTimer = () => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
  };

  const fetchPage = async (search: string, page: number) => {
    // A first page starts a new list: answers to anything requested before it are dropped.
    if (page === 1) generation += 1;
    const ticket = generation;
    update(
      page === 1 ? { loading: "list", error: undefined, appliedQuery: search } : { loading: "more", error: undefined }
    );
    try {
      const result = await deps.list({ search, page });
      if (!active || ticket !== generation) return;
      const known = new Set(page === 1 ? [] : state.items.map((item) => item.provider_repository_id));
      const fresh = result.results.filter((item) => !known.has(item.provider_repository_id));
      update({
        items: page === 1 ? fresh : [...state.items, ...fresh],
        page: result.page,
        hasNext: result.has_next,
        loading: null,
      });
    } catch (reason) {
      if (!active || ticket !== generation) return;
      const error = {
        message: messageOf(reason, "Не удалось получить репозитории Git-сервера."),
        during: page === 1 ? ("list" as const) : ("more" as const),
      };
      update(page === 1 ? { loading: null, error, items: [], page: 0, hasNext: false } : { loading: null, error });
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      active = true;
      state = INITIAL_STATE;
      void fetchPage("", 1);
    },
    dispose: () => {
      active = false;
      generation += 1;
      clearSearchTimer();
    },
    setQuery: (value) => {
      update({ query: value });
      clearSearchTimer();
      searchTimer = setTimeout(() => {
        searchTimer = undefined;
        const search = value.trim();
        if (search === state.appliedQuery && !state.error) return;
        void fetchPage(search, 1);
      }, FORGEJO_SEARCH_DELAY_MS);
    },
    reload: () => {
      clearSearchTimer();
      void fetchPage(state.query.trim(), 1);
    },
    loadMore: () => {
      if (!state.hasNext || state.loading !== null || state.connectingId !== undefined) return;
      void fetchPage(state.appliedQuery, state.page + 1);
    },
    connect: async (providerRepositoryId) => {
      if (state.connectingId !== undefined) return;
      const target = state.items.find((item) => item.provider_repository_id === providerRepositoryId);
      if (!target || target.connected || target.archived) return;
      update({ connectingId: providerRepositoryId, connectError: undefined });
      try {
        await deps.connect(providerRepositoryId);
      } catch (reason) {
        update({ connectingId: undefined, connectError: messageOf(reason, "Не удалось подключить репозиторий.") });
        // 409: the list on screen is stale — ask the Git server again, and a connected row stops offering «Подключить».
        if (active && isConflict(reason)) void fetchPage(state.appliedQuery, 1);
        return;
      }
      const connected = { ...target, connected: true };
      update({
        items: state.items.map((item) => (item.provider_repository_id === providerRepositoryId ? connected : item)),
      });
      try {
        // The page refreshes the «Код» overview and closes the dialog (it cannot be closed while connecting).
        await deps.onConnected();
      } finally {
        update({ connectingId: undefined });
      }
    },
  };
}
