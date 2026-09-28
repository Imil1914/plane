// G2.1 (R10): the «Подключить с нашего Git-сервера» dialog logic without React — search waits for a pause in typing,
// a late answer to an old query never overwrites a newer one, «Показать ещё» appends the next page of the same query,
// and a successful connect hands over to the page (refresh the «Код» overview, close the dialog).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createForgejoRepositoryPicker, FORGEJO_SEARCH_DELAY_MS } from "@/components/ppm-git/forgejo-repository-picker";
import {
  PpmGitServiceError,
  type TPpmForgejoRepository,
  type TPpmForgejoRepositoryPage,
} from "@/services/ppm-git.service";

function repo(id: number, overrides: Partial<TPpmForgejoRepository> = {}): TPpmForgejoRepository {
  return {
    provider_repository_id: id,
    full_name: `lab/repo-${id}`,
    name: `repo-${id}`,
    owner: "lab",
    description: "",
    private: true,
    archived: false,
    default_branch: "main",
    html_url: `https://git.ppm.example/lab/repo-${id}`,
    clone_https: `https://git.ppm.example/lab/repo-${id}.git`,
    clone_ssh: "",
    updated_at: null,
    connected: false,
    ...overrides,
  };
}

function page(results: TPpmForgejoRepository[], pageNumber = 1, hasNext = false): TPpmForgejoRepositoryPage {
  return { results, page: pageNumber, has_next: hasNext };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(list = vi.fn().mockResolvedValue(page([repo(1), repo(2)], 1, true))) {
  const connect = vi.fn().mockResolvedValue({});
  const onConnected = vi.fn().mockResolvedValue(undefined);
  const picker = createForgejoRepositoryPicker({ list, connect, onConnected });
  return { picker, list, connect, onConnected };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("our Git server repository picker", () => {
  it("is loading before the first answer, so the dialog never flashes «пока нет репозиториев»", () => {
    const { picker } = setup();
    expect(picker.getState()).toMatchObject({ loading: "list", items: [] });
    expect(picker.getState().error).toBeUndefined();
  });

  it("loads the first page on open", async () => {
    const { picker, list } = setup();
    picker.start();
    expect(picker.getState().loading).toBe("list");
    await vi.runAllTimersAsync();

    expect(list).toHaveBeenCalledExactlyOnceWith({ search: "", page: 1 });
    expect(picker.getState()).toMatchObject({ loading: null, page: 1, hasNext: true, error: undefined });
    expect(picker.getState().items.map((item) => item.provider_repository_id)).toEqual([1, 2]);
  });

  it("searches once after a pause in typing", async () => {
    const { picker, list } = setup();
    picker.start();
    await vi.runAllTimersAsync();
    list.mockClear();

    picker.setQuery("ro");
    await vi.advanceTimersByTimeAsync(FORGEJO_SEARCH_DELAY_MS - 50);
    picker.setQuery("rob");
    await vi.advanceTimersByTimeAsync(FORGEJO_SEARCH_DELAY_MS - 1);
    expect(list).not.toHaveBeenCalled();
    expect(picker.getState().query).toBe("rob");

    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledExactlyOnceWith({ search: "rob", page: 1 });
  });

  it("does not repeat the same search for spaces around the words", async () => {
    const { picker, list } = setup();
    picker.start();
    await vi.runAllTimersAsync();
    picker.setQuery("robot");
    await vi.runAllTimersAsync();
    list.mockClear();

    picker.setQuery("robot  ");
    await vi.runAllTimersAsync();
    expect(list).not.toHaveBeenCalled();
  });

  it("ignores a late answer to an older query", async () => {
    const first = deferred<TPpmForgejoRepositoryPage>();
    const second = deferred<TPpmForgejoRepositoryPage>();
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([]))
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { picker } = setup(list);
    picker.start();
    await vi.runAllTimersAsync();

    picker.setQuery("ro");
    await vi.runAllTimersAsync();
    picker.setQuery("robot");
    await vi.runAllTimersAsync();

    second.resolve(page([repo(7)]));
    await vi.runAllTimersAsync();
    first.resolve(page([repo(3), repo(4)]));
    await vi.runAllTimersAsync();

    expect(picker.getState().items.map((item) => item.provider_repository_id)).toEqual([7]);
    expect(picker.getState().appliedQuery).toBe("robot");
  });

  it("«Показать ещё» appends the next page of the same query without duplicates", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([repo(1), repo(2)], 1, true))
      .mockResolvedValueOnce(page([repo(1), repo(2)], 1, true))
      .mockResolvedValueOnce(page([repo(2), repo(3)], 2, false));
    const { picker } = setup(list);
    picker.start();
    await vi.runAllTimersAsync();
    picker.setQuery("repo");
    await vi.runAllTimersAsync();

    picker.loadMore();
    expect(picker.getState().loading).toBe("more");
    await vi.runAllTimersAsync();

    expect(list).toHaveBeenLastCalledWith({ search: "repo", page: 2 });
    expect(picker.getState().items.map((item) => item.provider_repository_id)).toEqual([1, 2, 3]);
    expect(picker.getState()).toMatchObject({ page: 2, hasNext: false, loading: null });

    list.mockClear();
    picker.loadMore();
    expect(list).not.toHaveBeenCalled();
  });

  it("shows a list error and loads again on «Повторить»", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new PpmGitServiceError("Git-сервер не отвечает. Повторите чуть позже.", { status: 502 }))
      .mockResolvedValueOnce(page([repo(1)]));
    const { picker } = setup(list);
    picker.start();
    await vi.runAllTimersAsync();
    expect(picker.getState()).toMatchObject({
      error: { message: "Git-сервер не отвечает. Повторите чуть позже.", during: "list" },
      items: [],
    });

    picker.reload();
    await vi.runAllTimersAsync();
    expect(picker.getState().error).toBeUndefined();
    expect(picker.getState().items).toHaveLength(1);
  });

  it("keeps the loaded rows when only the next page fails", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([repo(1)], 1, true))
      .mockRejectedValueOnce(new PpmGitServiceError("Git-сервер просит подождать. Повторите чуть позже."));
    const { picker } = setup(list);
    picker.start();
    await vi.runAllTimersAsync();
    picker.loadMore();
    await vi.runAllTimersAsync();

    expect(picker.getState()).toMatchObject({
      error: { message: "Git-сервер просит подождать. Повторите чуть позже.", during: "more" },
      hasNext: true,
      page: 1,
    });
    expect(picker.getState().items).toHaveLength(1);
  });

  it("connects a repository and then hands over to the page to refresh the overview", async () => {
    const { picker, connect, onConnected } = setup();
    picker.start();
    await vi.runAllTimersAsync();

    const connecting = picker.connect(2);
    expect(picker.getState().connectingId).toBe(2);
    picker.connect(1);
    await connecting;

    expect(connect).toHaveBeenCalledExactlyOnceWith(2);
    expect(onConnected).toHaveBeenCalledOnce();
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(onConnected.mock.invocationCallOrder[0]);
    expect(picker.getState().items.find((item) => item.provider_repository_id === 2)?.connected).toBe(true);
    expect(picker.getState().connectingId).toBeUndefined();
  });

  it("does not connect a connected or archived repository", async () => {
    const { picker, connect } = setup(
      vi.fn().mockResolvedValue(page([repo(1, { connected: true }), repo(2, { archived: true })]))
    );
    picker.start();
    await vi.runAllTimersAsync();

    await picker.connect(1);
    await picker.connect(2);
    await picker.connect(99);
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the reason when connecting fails", async () => {
    const { picker, connect, onConnected } = setup();
    connect.mockRejectedValueOnce(new PpmGitServiceError("Репозиторий уже подключён.", { status: 409 }));
    picker.start();
    await vi.runAllTimersAsync();

    await picker.connect(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(picker.getState()).toMatchObject({ connectingId: undefined, connectError: "Репозиторий уже подключён." });
  });

  it("on 409 asks the Git server again, so an already connected row stops offering «Подключить»", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([repo(1), repo(2)], 1, true))
      .mockResolvedValueOnce(page([repo(1), repo(2)], 1, true))
      .mockResolvedValueOnce(page([repo(1, { connected: true }), repo(2)], 1, true));
    const { picker, connect, onConnected } = setup(list);
    connect.mockRejectedValueOnce(
      new PpmGitServiceError("Репозиторий уже подключён.", { code: "GIT_REPOSITORY_CONFLICT", status: 409 })
    );
    picker.start();
    await vi.runAllTimersAsync();
    picker.setQuery("repo");
    await vi.runAllTimersAsync();

    await picker.connect(1);
    await vi.runAllTimersAsync();

    expect(onConnected).not.toHaveBeenCalled();
    expect(list).toHaveBeenLastCalledWith({ search: "repo", page: 1 });
    expect(picker.getState()).toMatchObject({ connectError: "Репозиторий уже подключён.", connectingId: undefined });
    expect(picker.getState().items.map((item) => [item.provider_repository_id, item.connected])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("does not ask again after other refusals", async () => {
    const { picker, connect, list } = setup();
    connect.mockRejectedValueOnce(new PpmGitServiceError("Git-сервер не отвечает.", { status: 502 }));
    picker.start();
    await vi.runAllTimersAsync();
    list.mockClear();

    await picker.connect(1);
    await vi.runAllTimersAsync();
    expect(list).not.toHaveBeenCalled();
  });

  it("stops listening after close, and starts over when opened again", async () => {
    const late = deferred<TPpmForgejoRepositoryPage>();
    const list = vi
      .fn()
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(page([repo(5)]));
    const { picker } = setup(list);
    const listener = vi.fn();
    picker.subscribe(listener);

    picker.start();
    picker.setQuery("x");
    picker.dispose();
    listener.mockClear();
    late.resolve(page([repo(1)]));
    await vi.runAllTimersAsync();
    expect(listener).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();

    picker.start();
    await vi.runAllTimersAsync();
    expect(picker.getState().items.map((item) => item.provider_repository_id)).toEqual([5]);
  });
});
