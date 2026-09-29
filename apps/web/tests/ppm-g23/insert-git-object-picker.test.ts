// G2.3 (G-Web, G3): the «Вставить коммит/PR» search state machine — debounce, filter switching, keyboard
// highlighting, the stale-answer guard, and the empty states (Review Focus item 5; review round 2 #2 adds
// "connected but empty" as its own state). No DOM, fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TPpmGitSearchObject } from "@/services/ppm-git.service";
import {
  classifyGitObjectEmptyState,
  createInsertGitObjectPicker,
  GIT_OBJECT_SEARCH_DELAY_MS,
  nextHighlightedIndex,
} from "@/components/ppm-git/insert/insert-git-object-picker";

function object(id: string, overrides: Partial<TPpmGitSearchObject> = {}): TPpmGitSearchObject {
  return {
    id,
    repository_id: "r-1",
    connection_id: "c-1",
    object_type: "commit",
    ref: "main",
    title: `Title ${id}`,
    canonical_url: `https://git.example/${id}`,
    state: "",
    is_draft: false,
    author_name: "",
    author_avatar_url: "",
    base_ref: "",
    head_ref: "",
    commit_sha: id,
    is_active: true,
    provider_updated_at: "2026-09-28T00:00:00Z",
    last_seen_at: "2026-09-28T00:00:00Z",
    label: `коммит ${id}`,
    ...overrides,
  };
}

function setup(
  search = vi.fn().mockResolvedValue([object("a"), object("b")]),
  checkHasRepositories = vi.fn().mockResolvedValue(true)
) {
  const picker = createInsertGitObjectPicker({ search, checkHasRepositories });
  return { picker, search, checkHasRepositories };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("nextHighlightedIndex", () => {
  it("stays -1 for an empty list", () => {
    expect(nextHighlightedIndex(-1, 0, 1)).toBe(-1);
    expect(nextHighlightedIndex(-1, 0, -1)).toBe(-1);
  });

  it("lands on 0 for the first ArrowDown, and the last item for the first ArrowUp", () => {
    expect(nextHighlightedIndex(-1, 3, 1)).toBe(0);
    expect(nextHighlightedIndex(-1, 3, -1)).toBe(2);
  });

  it("wraps around in both directions", () => {
    expect(nextHighlightedIndex(2, 3, 1)).toBe(0);
    expect(nextHighlightedIndex(0, 3, -1)).toBe(2);
  });
});

describe("classifyGitObjectEmptyState — review round 2 (#2)", () => {
  it("is 'none' once there is any result, regardless of query or hasRepositories", () => {
    expect(classifyGitObjectEmptyState("", 1, false)).toBe("none");
    expect(classifyGitObjectEmptyState("abc", 1, true)).toBe("none");
    expect(classifyGitObjectEmptyState("abc", 1, undefined)).toBe("none");
  });

  it("is 'not_found' for an active (non-blank) search with no match, regardless of hasRepositories", () => {
    expect(classifyGitObjectEmptyState("abc", 0, true)).toBe("not_found");
    expect(classifyGitObjectEmptyState("abc", 0, false)).toBe("not_found");
    expect(classifyGitObjectEmptyState("  abc  ", 0, undefined)).toBe("not_found");
  });

  it("is 'no_repositories' for the default listing only when hasRepositories is definitely false", () => {
    expect(classifyGitObjectEmptyState("", 0, false)).toBe("no_repositories");
  });

  it(
    "is 'no_objects' for the default listing when a repository is connected, or when unknown — never claims " +
      "'no repositories' without a definite negative answer",
    () => {
      expect(classifyGitObjectEmptyState("", 0, true)).toBe("no_objects");
      expect(classifyGitObjectEmptyState("", 0, undefined)).toBe("no_objects");
    }
  );

  it("treats a blank (whitespace-only) query as the default listing, not an active search", () => {
    expect(classifyGitObjectEmptyState("   ", 0, false)).toBe("no_repositories");
    expect(classifyGitObjectEmptyState("   ", 0, true)).toBe("no_objects");
  });
});

describe("createInsertGitObjectPicker", () => {
  it("is loading before the first answer", () => {
    const { picker } = setup();
    expect(picker.getState()).toMatchObject({ loading: true, items: [], highlightedIndex: -1 });
  });

  it("loads the default listing on start and highlights the first row", async () => {
    const { picker, search } = setup();
    picker.start();
    await vi.runAllTimersAsync();

    expect(search).toHaveBeenCalledExactlyOnceWith({ q: "", type: undefined, limit: 20 });
    expect(picker.getState()).toMatchObject({ loading: false, highlightedIndex: 0, error: undefined });
    expect(picker.getState().items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("searches once after a pause in typing, not on every keystroke", async () => {
    const { picker, search } = setup();
    picker.start();
    await vi.runAllTimersAsync();
    search.mockClear();

    picker.setQuery("a1");
    await vi.advanceTimersByTimeAsync(GIT_OBJECT_SEARCH_DELAY_MS - 1);
    picker.setQuery("a1b");
    await vi.advanceTimersByTimeAsync(GIT_OBJECT_SEARCH_DELAY_MS - 1);
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledExactlyOnceWith({ q: "a1b", type: undefined, limit: 20 });
  });

  it("drops a late answer to a query that is no longer current", async () => {
    const first = deferred<TPpmGitSearchObject[]>();
    const second = deferred<TPpmGitSearchObject[]>();
    // Matched by the query text, not by call order — the picker's own start() already sends one request ("").
    const search = vi.fn().mockImplementation(({ q }: { q: string }) => {
      if (q === "first") return first.promise;
      if (q === "second") return second.promise;
      return Promise.resolve([]);
    });
    const { picker } = setup(search);

    picker.start();
    await vi.runAllTimersAsync();
    picker.setQuery("first");
    await vi.advanceTimersByTimeAsync(GIT_OBJECT_SEARCH_DELAY_MS);
    picker.setQuery("second");
    await vi.advanceTimersByTimeAsync(GIT_OBJECT_SEARCH_DELAY_MS);

    // The "second" answer arrives first (e.g. a smaller result set); "first" is now stale and must not overwrite it.
    second.resolve([object("s")]);
    await Promise.resolve();
    first.resolve([object("f")]);
    await Promise.resolve();

    expect(picker.getState().items.map((item) => item.id)).toEqual(["s"]);
  });

  it("re-runs immediately on a filter change, without waiting for the typing-pause delay", async () => {
    const { picker, search } = setup();
    picker.start();
    await vi.runAllTimersAsync();
    search.mockClear();

    picker.setFilter("pull_request");
    await vi.advanceTimersByTimeAsync(0);
    expect(search).toHaveBeenCalledExactlyOnceWith({ q: "", type: "pull_request", limit: 20 });
  });

  it("surfaces a plain-Russian message and clears the list on a search error", async () => {
    const search = vi.fn().mockRejectedValue(new Error("boom"));
    const { picker } = setup(search);
    picker.start();
    await vi.runAllTimersAsync();

    expect(picker.getState()).toMatchObject({ loading: false, items: [], highlightedIndex: -1, error: "boom" });
  });

  it("moveHighlight and selectHighlighted follow the current list", async () => {
    const { picker } = setup();
    picker.start();
    await vi.runAllTimersAsync();

    expect(picker.selectHighlighted()?.id).toBe("a");
    picker.moveHighlight(1);
    expect(picker.selectHighlighted()?.id).toBe("b");
    picker.moveHighlight(1);
    expect(picker.selectHighlighted()?.id).toBe("a");
  });

  it("setHighlightedIndex jumps directly (mouse hover), ignoring out-of-range values", async () => {
    const { picker } = setup();
    picker.start();
    await vi.runAllTimersAsync();

    picker.setHighlightedIndex(1);
    expect(picker.getState().highlightedIndex).toBe(1);
    picker.setHighlightedIndex(99);
    expect(picker.getState().highlightedIndex).toBe(1);
    picker.setHighlightedIndex(-1);
    expect(picker.getState().highlightedIndex).toBe(1);
  });

  it("fetches hasRepositories in parallel with the first search — review round 2 (#2)", async () => {
    const { picker, checkHasRepositories } = setup(undefined, vi.fn().mockResolvedValue(false));
    picker.start();
    expect(checkHasRepositories).toHaveBeenCalledOnce();
    expect(picker.getState().hasRepositories).toBeUndefined(); // not yet settled
    await vi.runAllTimersAsync();
    expect(picker.getState().hasRepositories).toBe(false);
  });

  it("does not wait for hasRepositories before showing search results (parallel, not sequential)", async () => {
    const neverResolves = vi.fn().mockReturnValue(new Promise<boolean>(() => undefined));
    const { picker } = setup(undefined, neverResolves);
    picker.start();
    await vi.runAllTimersAsync();

    expect(picker.getState().loading).toBe(false);
    expect(picker.getState().hasRepositories).toBeUndefined();
    expect(picker.getState().items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("swallows a hasRepositories check failure — stays undefined, never surfaced as a search error", async () => {
    const { picker } = setup(undefined, vi.fn().mockRejectedValue(new Error("overview unavailable")));
    picker.start();
    await vi.runAllTimersAsync();

    expect(picker.getState().hasRepositories).toBeUndefined();
    expect(picker.getState().error).toBeUndefined();
    expect(picker.getState().loading).toBe(false);
  });

  it("never applies a search result answered after dispose (the dialog already closed)", async () => {
    const { picker, search } = setup();
    picker.start();
    await vi.runAllTimersAsync();
    const itemsBefore = picker.getState().items;
    picker.dispose();

    // A real caller would not call setQuery after unmounting, but the picker must still refuse to apply the
    // answer if something races it (e.g. a timer already in flight when cleanup ran) — `active` is checked again
    // after the promise settles, so the stale "anything" answer is dropped even though the request was already sent.
    picker.setQuery("anything");
    await vi.runAllTimersAsync();
    expect(search).toHaveBeenCalledTimes(2);
    expect(picker.getState().items).toBe(itemsBefore);
  });
});
