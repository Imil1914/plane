import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { EUserPermissions } from "@plane/constants";
import { describe, expect, it, vi } from "vitest";
import type { TNavigationItem } from "@/components/navigation/tab-navigation-root";
import { TabNavigationOverflowMenu } from "@/components/navigation/tab-navigation-overflow-menu";
import { TabNavigationVisibleItem } from "@/components/navigation/tab-navigation-visible-item";
import { TopNavPowerK } from "@/components/navigation/top-nav-power-k";

function Passthrough({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function MockMenuRoot({
  ariaLabel,
  children,
  customButton,
  customButtonClassName,
}: {
  ariaLabel?: string;
  children?: ReactNode;
  customButton?: ReactNode;
  customButtonClassName?: string;
}) {
  return (
    <div>
      <button type="button" aria-label={ariaLabel} className={customButtonClassName}>
        {customButton}
      </button>
      {children}
    </div>
  );
}

function MockMenuItem({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

function MockCommandList({
  children,
  className,
  id,
  label,
}: {
  children?: ReactNode;
  className?: string;
  id?: string;
  label?: string;
}) {
  return (
    <div id={id} className={className} aria-label={label}>
      {children}
    </div>
  );
}

vi.mock("cmdk", () => ({
  Command: Object.assign(Passthrough, {
    Input: () => null,
    List: MockCommandList,
  }),
}));

vi.mock("mobx-react", () => ({
  observer: (component: unknown) => component,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    currentLocale: "ru",
    t: (key: string) => key,
  }),
}));

vi.mock("@plane/propel/context-menu", () => ({
  ContextMenu: Object.assign(Passthrough, {
    Content: Passthrough,
    Item: Passthrough,
    Portal: Passthrough,
    Trigger: Passthrough,
  }),
}));

vi.mock("@plane/propel/menu", () => ({
  Menu: Object.assign(MockMenuRoot, { MenuItem: MockMenuItem }),
}));

vi.mock("@plane/propel/tab-navigation", () => ({
  TabNavigationItem: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@plane/propel/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/power-k/ui/modal/commands-list", () => ({
  ProjectsAppPowerKCommandsList: () => null,
}));

vi.mock("@/components/power-k/ui/modal/footer", () => ({
  PowerKModalFooter: () => null,
}));

vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: {
      getIssueById: () => undefined,
      getIssueIdByIdentifier: () => undefined,
    },
  }),
}));

vi.mock("@/hooks/store/use-power-k", () => ({
  usePowerK: () => ({
    activeContext: null,
    activePage: null,
    setActivePage: () => {},
    setTopNavInputRef: () => {},
  }),
}));

vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "user-1" } }),
}));

vi.mock("@/hooks/use-app-router", () => ({
  useAppRouter: () => ({}),
}));

vi.mock("@/hooks/use-expandable-search", () => ({
  useExpandableSearch: () => ({
    closePanel: () => {},
    containerRef: { current: null },
    handleClose: () => {},
    handleFocus: () => {},
    handleMouseDown: () => {},
    inputRef: { current: null },
    isOpen: true,
    openPanel: () => {},
  }),
}));

const TASKS_ITEM = {
  access: [EUserPermissions.ADMIN, EUserPermissions.MEMBER, EUserPermissions.GUEST],
  href: "/demo/projects/project-1/issues",
  i18n_key: "sidebar.work_items",
  icon: () => null,
  key: "work_items",
  name: "Tasks",
  ppmLabelKey: "project.tasks",
  ppmSection: "work",
  shouldRender: true,
  sortOrder: 10,
} satisfies TNavigationItem;

describe("project navigation accessibility", () => {
  it("marks the active visible project link and exposes a focus indicator", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <TabNavigationVisibleItem
          item={TASKS_ITEM}
          isActive
          tabPreferences={{ defaultTab: "brain", hiddenTabs: [] }}
          onToggleDefault={() => {}}
          onHide={() => {}}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("focus-visible:outline-accent-strong");
    expect(markup).toContain("Задачи");
  });

  it("names the overflow trigger and its keyboard-revealable actions", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <TabNavigationOverflowMenu
          overflowItems={[TASKS_ITEM]}
          isActive={() => true}
          tabPreferences={{ defaultTab: "brain", hiddenTabs: [TASKS_ITEM.key] }}
          onToggleDefault={() => {}}
          onShow={() => {}}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('aria-label="Другие разделы проекта"');
    expect(markup).toContain("focus-visible:outline-offset-2");
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Показать: Задачи"');
    expect(markup).toContain('aria-label="Сделать стартовой: Задачи"');
    expect(markup).toContain("group-focus-within/menu-item:visible");
  });

  it("exposes the command search as a localized combobox tied to its list", () => {
    const markup = renderToStaticMarkup(<TopNavPowerK />);

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-label="Поиск команд…"');
    expect(markup).toContain('placeholder="Поиск команд…"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="top-nav-command-list"');
    expect(markup).toContain('id="top-nav-command-list"');
    expect(markup).not.toContain('role="button"');
  });

  it("labels the command results list for screen readers under the PPM shell", () => {
    const markup = renderToStaticMarkup(<TopNavPowerK />);

    expect(markup).toContain('aria-label="Результаты поиска команд"');
  });
});
