// G2.3 (line G-Web): state of the «Вставить коммит/PR» dialog, kept outside React so it can be tested without a DOM —
// same shape as `createForgejoRepositoryPicker` (ppm-git/forgejo-repository-picker.ts): search waits for a pause in
// typing, every new query invalidates older in-flight answers, and a highlighted row tracks arrow-key navigation.
// No pagination: the contract caps results at `limit` (≤ 20) — enough for a picker, not a browsable list.
import { getGitObjectSearchErrorMessage } from "@/components/ppm-git/insert/errors";
import type { TPpmGitObjectSearchType, TPpmGitSearchObject } from "@/services/ppm-git.service";

export const GIT_OBJECT_SEARCH_DELAY_MS = 250;

export type TGitObjectFilter = "all" | TPpmGitObjectSearchType;

export type TInsertGitObjectPickerState = {
  /** What is typed in the search field. */
  query: string;
  /** The query the rows on screen answer (may lag `query` during the debounce delay). */
  appliedQuery: string;
  filter: TGitObjectFilter;
  items: TPpmGitSearchObject[];
  /** Index into `items` the keyboard currently highlights; -1 when nothing is highlighted (empty list). */
  highlightedIndex: number;
  loading: boolean;
  error?: string;
  /** Review round 2 (#2): whether the project has at least one actively connected repository (the "Код" overview) —
   * `undefined` while still checking, or if the check itself failed (never surfaced as `error`: the search is the
   * primary operation). Used only by `classifyGitObjectEmptyState` to tell apart "no repositories connected" from
   * "repositories connected, nothing matched yet" — a project can have a repository with no commits/PRs synced. */
  hasRepositories?: boolean;
};

export type TInsertGitObjectPickerDeps = {
  search: (request: { q: string; type?: TPpmGitObjectSearchType; limit: number }) => Promise<TPpmGitSearchObject[]>;
  /** Checked once, in parallel with the first search — the "Код" overview is the only existing source for this (the
   * search contract has no such field). A rejection is swallowed: `hasRepositories` simply stays `undefined`. */
  checkHasRepositories: () => Promise<boolean>;
  limit?: number;
};

export type TInsertGitObjectPicker = {
  getState: () => TInsertGitObjectPickerState;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  dispose: () => void;
  setQuery: (value: string) => void;
  setFilter: (value: TGitObjectFilter) => void;
  moveHighlight: (direction: 1 | -1) => void;
  setHighlightedIndex: (index: number) => void;
  selectHighlighted: () => TPpmGitSearchObject | undefined;
};

const INITIAL_STATE: TInsertGitObjectPickerState = {
  query: "",
  appliedQuery: "",
  filter: "all",
  items: [],
  highlightedIndex: -1,
  loading: true,
};

/** Pure: the next highlighted index for an Arrow key press — wraps around, and lands on 0 (not -1) the first time an
 * arrow is pressed against a non-empty list. */
export function nextHighlightedIndex(current: number, itemCount: number, direction: 1 | -1): number {
  if (itemCount === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : itemCount - 1;
  return (current + direction + itemCount) % itemCount;
}

export type TGitObjectEmptyStateKind = "none" | "no_repositories" | "no_objects" | "not_found";

/** Pure: which of the three empty states applies (review round 2 #2 adds "no_objects" — a connected-but-empty
 * repository, or one whose objects have not synced yet, is not the same situation as no repository at all).
 * - "not_found": an active search (non-blank query) matched nothing.
 * - "no_repositories": the default listing (blank query) is empty AND the project has no active repository —
 *   `hasRepositories === false`, the only case with a definite negative answer.
 * - "no_objects": the default listing is empty but a repository *is* connected, or repository status could not be
 *   determined (`hasRepositories` `true` or `undefined`) — claiming "no repositories" would be misleading here. */
export function classifyGitObjectEmptyState(
  appliedQuery: string,
  itemCount: number,
  hasRepositories: boolean | undefined
): TGitObjectEmptyStateKind {
  if (itemCount > 0) return "none";
  if (appliedQuery.trim() !== "") return "not_found";
  return hasRepositories === false ? "no_repositories" : "no_objects";
}

export function createInsertGitObjectPicker(deps: TInsertGitObjectPickerDeps): TInsertGitObjectPicker {
  const limit = deps.limit ?? 20;
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let active = false;

  const update = (patch: Partial<TInsertGitObjectPickerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const clearSearchTimer = () => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
  };

  const checkRepositories = async () => {
    try {
      const hasRepositories = await deps.checkHasRepositories();
      if (active) update({ hasRepositories });
    } catch {
      // Swallowed by design: never becomes a user-facing `error` — `hasRepositories` simply stays undefined, which
      // classifyGitObjectEmptyState treats like "connected" (see there).
    }
  };

  const runSearch = async (query: string, filter: TGitObjectFilter) => {
    generation += 1;
    const ticket = generation;
    update({ loading: true, error: undefined, appliedQuery: query });
    try {
      const items = await deps.search({
        q: query,
        type: filter === "all" ? undefined : filter,
        limit,
      });
      if (!active || ticket !== generation) return;
      update({ items, loading: false, highlightedIndex: items.length > 0 ? 0 : -1 });
    } catch (reason) {
      if (!active || ticket !== generation) return;
      update({ items: [], loading: false, highlightedIndex: -1, error: getGitObjectSearchErrorMessage(reason) });
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
      // In parallel, not sequential: waiting for checkRepositories before searching would delay the list opening
      // for no reason in the common case (some objects already exist).
      void runSearch("", "all");
      void checkRepositories();
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
        void runSearch(value.trim(), state.filter);
      }, GIT_OBJECT_SEARCH_DELAY_MS);
    },
    setFilter: (value) => {
      if (value === state.filter) return;
      update({ filter: value });
      clearSearchTimer();
      // A filter change re-runs immediately (no reason to wait for a typing pause the user did not cause).
      void runSearch(state.query.trim(), value);
    },
    moveHighlight: (direction) => {
      update({ highlightedIndex: nextHighlightedIndex(state.highlightedIndex, state.items.length, direction) });
    },
    setHighlightedIndex: (index) => {
      if (index < 0 || index >= state.items.length || index === state.highlightedIndex) return;
      update({ highlightedIndex: index });
    },
    selectHighlighted: () => state.items[state.highlightedIndex],
  };
}
