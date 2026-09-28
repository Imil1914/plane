// G2.1 (R10, R11): what «Код» shows for our Git server — the connect button (active for a PPM global administrator,
// inactive with a hint for everybody else, absent while the server is not set up), the repository picker and a
// repository of our Git server with no «GitHub» anywhere. Rendered to a string (env node, no DOM), as the other views.
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ForgejoProviderPanel,
  ForgejoRepositoryPicker,
  ForgejoRepositoryPickerView,
} from "@/components/ppm-git/forgejo-connect";
import type { TForgejoPickerState } from "@/components/ppm-git/forgejo-repository-picker";
import { GitConnectionRow, RepositoryCard } from "@/components/ppm-git/git-section-parts";
import type { TPpmForgejoRepository, TPpmGitConnection, TPpmGitRepository } from "@/services/ppm-git.service";
import { buttonsNamed, hostElements, press } from "./element-tree";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children?: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const noop = () => undefined;
const text = (html: string) =>
  html
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const robotRepository: TPpmGitRepository = {
  id: "r-robot",
  name: "robot",
  provider: "forgejo",
  provider_repository_id: 42,
  provider_full_name: "lab/robot",
  canonical_url: "https://git.ppm.example/lab/robot",
  clone_https: "https://git.ppm.example/lab/robot.git",
  clone_ssh: "ssh://git@git.ppm.example:2222/lab/robot.git",
  default_branch: "main",
  visibility: "private",
  is_default: true,
  status: "active",
  created_at: "2026-09-28T00:00:00Z",
  updated_at: "2026-09-28T00:00:00Z",
  code_index: {
    enabled: false,
    branch: "main",
    include_paths: [],
    exclude_paths: [],
    limits: { max_files: 1, max_file_bytes: 1, max_total_bytes: 1 },
    snapshot: null,
  },
};

const robotConnection: TPpmGitConnection = {
  id: "c-robot",
  repository_id: "r-robot",
  installation_id: "i-forgejo",
  provider_repository_id: 42,
  provider_full_name: "lab/robot",
  status: "rate_limited",
  last_sync_at: null,
  last_event_at: null,
  last_error: null,
  retry_after: null,
  created_at: "2026-09-28T00:00:00Z",
  updated_at: "2026-09-28T00:00:00Z",
};

function panel(overrides: Partial<Parameters<typeof ForgejoProviderPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <ForgejoProviderPanel
      canConnect
      canSync
      configured
      connections={[]}
      onConnect={noop}
      onDisconnect={noop}
      onSync={noop}
      publicUrl="https://git.ppm.example"
      repositories={[robotRepository]}
      saving={false}
      {...overrides}
    />
  );
}

const connectButton = (html: string) =>
  html.match(/<button[^>]*>(?:(?!<\/button>).)*Подключить с нашего Git-сервера/s)?.[0];

describe("«Подключить с нашего Git-сервера»", () => {
  it("is active for a PPM global administrator", () => {
    const html = panel();
    const button = connectButton(html);
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
    expect(html).not.toContain("Репозиторий подключает администратор PPM");
  });

  it("is inactive with a hint for everybody else", () => {
    const html = panel({ canConnect: false });
    const button = connectButton(html);
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-describedby="ppm-git-server-connect-hint"');
    expect(html).toMatch(/id="ppm-git-server-connect-hint"[^>]*>Репозиторий подключает администратор PPM</);
  });

  it("is absent while our Git server is not set up", () => {
    expect(panel({ configured: false })).toBe("");
    const withHistory = panel({ configured: false, connections: [robotConnection], publicUrl: null });
    expect(connectButton(withHistory)).toBeUndefined();
    expect(withHistory).toContain("Git-сервер не настроен");
    expect(withHistory).toContain("lab/robot");
  });

  it("names our Git server and links to it", () => {
    const html = panel();
    expect(html).toMatch(/<h2[^>]*>Наш Git-сервер<\/h2>/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/git\.ppm\.example"[^>]*>Открыть на Git-сервере/);
  });
});

describe("connections of our Git server", () => {
  it("speak of the Git server, and only the administrator may disconnect", () => {
    const admin = panel({ connections: [robotConnection] });
    expect(admin).toContain("Git-сервер просит подождать");
    expect(admin).toMatch(/>\s*Обновить<\/button>/);
    expect(admin).toContain(">Отключить<");
    expect(admin).toMatch(/<a[^>]*href="https:\/\/git\.ppm\.example\/lab\/robot"[^>]*>Открыть на Git-сервере/);
    expect(admin).not.toContain("GitHub");

    const projectManager = panel({ canConnect: false, connections: [robotConnection] });
    expect(projectManager).toMatch(/>\s*Обновить<\/button>/);
    expect(projectManager).not.toContain(">Отключить<");

    const member = panel({ canConnect: false, canSync: false, connections: [robotConnection] });
    expect(member).not.toMatch(/>\s*Обновить<\/button>/);
  });

  it("keep the RC.1 GitHub row as it was", () => {
    const html = renderToStaticMarkup(
      <GitConnectionRow
        canDisconnect
        canSync
        connection={{ ...robotConnection, provider_full_name: "lab/site" }}
        onDisconnect={noop}
        onSync={noop}
        provider="github"
        saving={false}
      />
    );
    expect(html).toContain("GitHub просит подождать");
    expect(html).not.toContain("Открыть на Git-сервере");
  });
});

function pickerState(overrides: Partial<TForgejoPickerState> = {}): TForgejoPickerState {
  return { query: "", appliedQuery: "", items: [], page: 1, hasNext: false, loading: null, ...overrides };
}

function forgejoRepository(id: number, overrides: Partial<TPpmForgejoRepository> = {}): TPpmForgejoRepository {
  return {
    provider_repository_id: id,
    full_name: `lab/repo-${id}`,
    name: `repo-${id}`,
    owner: "lab",
    description: null,
    private: false,
    archived: false,
    default_branch: "main",
    html_url: `https://git.ppm.example/lab/repo-${id}`,
    clone_https: `https://git.ppm.example/lab/repo-${id}.git`,
    clone_ssh: null,
    updated_at: null,
    connected: false,
    ...overrides,
  };
}

function picker(state: TForgejoPickerState, publicUrl: string | null = "https://git.ppm.example") {
  return renderToStaticMarkup(
    <ForgejoRepositoryPicker
      onClose={noop}
      onConnect={noop}
      onLoadMore={noop}
      onQueryChange={noop}
      onReload={noop}
      publicUrl={publicUrl}
      state={state}
    />
  );
}

describe("repository picker", () => {
  it("lists owner/name, description and privacy with a «Подключить» button per row", () => {
    const html = picker(
      pickerState({
        query: "rob",
        appliedQuery: "rob",
        items: [
          forgejoRepository(1, { full_name: "lab/robot", description: "Прошивка манипулятора", private: true }),
          forgejoRepository(2),
        ],
      })
    );
    expect(html).toMatch(/<label[^>]*for="ppm-forgejo-search"[^>]*>Поиск по названию<\/label>/);
    expect(html).toMatch(/<input[^>]*id="ppm-forgejo-search"[^>]*value="rob"/);
    expect(html).toContain("lab/robot");
    expect(html).toContain("Прошивка манипулятора");
    expect(html).toContain("Приватный");
    expect(html).toContain('aria-label="Подключить lab/robot"');
    expect(html).toContain('aria-label="Подключить lab/repo-2"');
    expect(html).not.toContain("Показать ещё");
  });

  it("marks a connected repository and offers no button for it", () => {
    const html = picker(pickerState({ items: [forgejoRepository(1, { connected: true }), forgejoRepository(2)] }));
    expect(html).toContain("Подключён");
    expect(html).not.toContain('aria-label="Подключить lab/repo-1"');
    expect(html).toContain('aria-label="Подключить lab/repo-2"');
  });

  it("offers «Показать ещё» while the Git server has more", () => {
    const html = picker(pickerState({ items: [forgejoRepository(1)], hasNext: true }));
    expect(html).toMatch(/<button[^>]*>Показать ещё<\/button>/);
    expect(picker(pickerState({ items: [forgejoRepository(1)], hasNext: true, loading: "more" }))).toContain(
      "Загружаем…"
    );
  });

  it("explains an empty Git server with its address", () => {
    const html = picker(pickerState());
    expect(text(html)).toContain(
      "На Git-сервере пока нет репозиториев. Создайте репозиторий на https://git.ppm.example и обновите список."
    );
    expect(html).toMatch(/<a[^>]*href="https:\/\/git\.ppm\.example"/);
    expect(html).toContain("Обновить список");
    expect(text(picker(pickerState(), null))).toContain("Создайте репозиторий на Git-сервере и обновите список.");
  });

  it("says nothing was found for a search", () => {
    const html = picker(pickerState({ query: "zzz", appliedQuery: "zzz" }));
    expect(text(html)).toContain("Ничего не найдено по запросу «zzz».");
    expect(html).not.toContain("пока нет репозиториев");
  });

  it("shows loading, list errors with «Повторить» and connect errors", () => {
    expect(picker(pickerState({ loading: "list" }))).toContain("Загружаем репозитории");
    const failed = picker(
      pickerState({ error: { message: "Git-сервер не отвечает. Повторите чуть позже.", during: "list" } })
    );
    expect(failed).toMatch(/role="alert"[^>]*>.*Git-сервер не отвечает/s);
    expect(failed).toContain(">Повторить<");
    const refused = picker(
      pickerState({
        items: [forgejoRepository(1)],
        connectError: "Подключать репозитории может только администратор PPM.",
      })
    );
    expect(refused).toMatch(/role="alert"[^>]*>Подключать репозитории может только администратор PPM\.</);
  });

  it("disables every row while one repository is being connected", () => {
    const html = picker(pickerState({ items: [forgejoRepository(1), forgejoRepository(2)], connectingId: 1 }));
    expect(html).toMatch(/<button[^>]*aria-label="Подключаем lab\/repo-1"[^>]*disabled=""[^>]*>Подключаем…/);
    expect(html).toMatch(/<button[^>]*aria-label="Подключить lab\/repo-2"[^>]*disabled=""/);
  });
});

describe("a repository of our Git server on the «Код» page", () => {
  const card = (hasActiveConnection: boolean) =>
    renderToStaticMarkup(
      <RepositoryCard
        canManage
        canManageCode
        canvasHref="/lab/projects/p/brain?x=1"
        hasActiveConnection={hasActiveConnection}
        onArchive={noop}
        onCopy={noop}
        onMakeDefault={noop}
        onSyncCode={noop}
        onToggleCode={noop}
        repository={robotRepository}
        saving={false}
      />
    );

  it("names its provider, opens on the Git server and never says «GitHub»", () => {
    for (const html of [card(true), card(false)]) {
      expect(text(html)).toContain("Наш Git-сервер · приватный · main");
      expect(html).toContain('aria-label="Открыть на Git-сервере"');
      expect(html).toContain("Как скачать код");
      expect(html).toContain("git clone https://git.ppm.example/lab/robot.git");
      expect(html).not.toContain("GitHub");
    }
    expect(card(false)).toContain("Для поиска сначала подключите этот репозиторий с нашего Git-сервера.");
  });

  it("keeps the GitHub hint for a GitHub repository", () => {
    const html = renderToStaticMarkup(
      <RepositoryCard
        canManage={false}
        canManageCode
        canvasHref="/lab/projects/p/brain"
        hasActiveConnection={false}
        onArchive={noop}
        onCopy={noop}
        onMakeDefault={noop}
        onSyncCode={noop}
        onToggleCode={noop}
        repository={{ ...robotRepository, provider: "github", canonical_url: "https://github.com/lab/robot" }}
        saving={false}
      />
    );
    expect(text(html)).toContain("GitHub · приватный · main");
    expect(html).toContain("Для поиска сначала подключите этот репозиторий через GitHub.");
    expect(html).toContain('aria-label="Открыть репозиторий"');
  });
});

describe("pressing the controls", () => {
  const panelProps: Parameters<typeof ForgejoProviderPanel>[0] = {
    canConnect: true,
    canSync: true,
    configured: true,
    connections: [{ ...robotConnection, status: "active" }],
    onConnect: noop,
    onDisconnect: noop,
    onSync: noop,
    publicUrl: "https://git.ppm.example",
    repositories: [robotRepository],
    saving: false,
  };

  it("opens the picker for an administrator; the inactive button does nothing", () => {
    const onConnect = vi.fn();
    press(buttonsNamed(ForgejoProviderPanel({ ...panelProps, onConnect }), "Подключить с нашего Git-сервера")[0]);
    expect(onConnect).toHaveBeenCalledOnce();

    const inactive = buttonsNamed(
      ForgejoProviderPanel({ ...panelProps, canConnect: false, onConnect }),
      "Подключить с нашего Git-сервера"
    )[0];
    expect(inactive?.props.disabled).toBe(true);
    expect(inactive?.props.onClick).toBeUndefined();
  });

  it("syncs and disconnects the pressed connection", () => {
    const onSync = vi.fn();
    const onDisconnect = vi.fn();
    const tree = ForgejoProviderPanel({ ...panelProps, onDisconnect, onSync });
    press(buttonsNamed(tree, "Обновить")[0]);
    press(buttonsNamed(tree, "Отключить")[0]);
    expect(onSync).toHaveBeenCalledWith(panelProps.connections[0]);
    expect(onDisconnect).toHaveBeenCalledWith(panelProps.connections[0]);
  });

  it("connects the pressed row, loads more, searches, reloads and closes", () => {
    const handlers = {
      onClose: vi.fn(),
      onConnect: vi.fn(),
      onLoadMore: vi.fn(),
      onQueryChange: vi.fn(),
      onReload: vi.fn(),
    };
    const tree = ForgejoRepositoryPickerView({
      ...handlers,
      publicUrl: "https://git.ppm.example",
      state: pickerState({ items: [forgejoRepository(1, { connected: true }), forgejoRepository(2)], hasNext: true }),
    });

    press(buttonsNamed(tree, "Подключить lab/repo-2")[0]);
    expect(handlers.onConnect).toHaveBeenCalledExactlyOnceWith(2);
    expect(buttonsNamed(tree, "Подключить lab/repo-1")).toEqual([]);

    press(buttonsNamed(tree, "Показать ещё")[0]);
    expect(handlers.onLoadMore).toHaveBeenCalledOnce();

    const search = hostElements(tree).find((element) => element.props.id === "ppm-forgejo-search");
    expect(search?.type).toBe("input");
    const onSearchChange = search?.props.onChange as (event: { target: { value: string } }) => void;
    onSearchChange({ target: { value: "robot" } });
    expect(handlers.onQueryChange).toHaveBeenCalledWith("robot");

    press(buttonsNamed(tree, "Закрыть")[0]);
    expect(handlers.onClose).toHaveBeenCalledOnce();

    press(
      buttonsNamed(
        ForgejoRepositoryPickerView({ ...handlers, publicUrl: null, state: pickerState() }),
        "Обновить список"
      )[0]
    );
    press(
      buttonsNamed(
        ForgejoRepositoryPickerView({
          ...handlers,
          publicUrl: null,
          state: pickerState({ error: { message: "Git-сервер не отвечает.", during: "list" } }),
        }),
        "Повторить"
      )[0]
    );
    expect(handlers.onReload).toHaveBeenCalledTimes(2);
  });

  it("«Как скачать код» in a repository card copies the exact command", () => {
    const onCopy = vi.fn();
    const tree = RepositoryCard({
      canManage: false,
      canManageCode: false,
      canvasHref: "/lab/projects/p/brain",
      hasActiveConnection: true,
      onArchive: noop,
      onCopy,
      onMakeDefault: noop,
      onSyncCode: noop,
      onToggleCode: noop,
      repository: robotRepository,
      saving: false,
    });
    press(buttonsNamed(tree, "Копировать команду HTTPS")[0]);
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(
      "git clone https://git.ppm.example/lab/robot.git",
      "r-robot:clone:https"
    );
    // The bare address stays one click away for an IDE's «Clone repository» (RC.1 rows, unchanged).
    press(buttonsNamed(tree, "Копировать SSH")[0]);
    expect(onCopy).toHaveBeenLastCalledWith("ssh://git@git.ppm.example:2222/lab/robot.git", "r-robot:ssh");
  });
});

describe("fix round 1: the dialog while connecting and on open", () => {
  const handlers = {
    onClose: vi.fn(),
    onConnect: vi.fn(),
    onLoadMore: vi.fn(),
    onQueryChange: vi.fn(),
    onReload: vi.fn(),
  };

  it("cannot be closed while a repository is being connected, so the result is never lost", () => {
    const connecting = ForgejoRepositoryPickerView({
      ...handlers,
      publicUrl: null,
      state: pickerState({ items: [forgejoRepository(1)], connectingId: 1 }),
    });
    const close = buttonsNamed(connecting, "Закрыть")[0];
    expect(close?.props.disabled).toBe(true);
    expect(() => press(close)).toThrow("disabled");

    const idle = ForgejoRepositoryPickerView({ ...handlers, publicUrl: null, state: pickerState() });
    press(buttonsNamed(idle, "Закрыть")[0]);
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("puts the focus into the search field after mount, when the dialog's portal is attached", () => {
    const source = readFileSync(new URL("../../core/components/ppm-git/forgejo-connect.tsx", import.meta.url), "utf8");
    const component = source.slice(source.indexOf("export function ForgejoRepositoryPicker("));
    expect(component).toMatch(/useEffect\(\(\) => \{\s*searchRef\.current\?\.focus\(\);\s*\}, \[\]\);/);
    expect(source).toContain("ref={searchRef}");
    expect(source).not.toContain("focusOnOpen");
    // The view is still rendered by the component (and its markup is the one tested above).
    expect(component).toContain("<ForgejoRepositoryPickerView {...props} searchRef={searchRef} />");
  });
});
