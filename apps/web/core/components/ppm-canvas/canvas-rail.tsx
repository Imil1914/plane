// AF2.1 R1 (line R): the grouped floating rail of design v2 (K1). Выбор, Рука | Стикер, Текст, Фигуры ▸, Перо, Рамка,
// Связь | Документы и текст ▸, Из проекта ▸, Смысловые связи | Ещё ▸, Отменить, Повторить. Shortcut hints are the real
// e.code keys handled in workspace.tsx (railShortcutCommand); menus: title, caption, items with a one-line hint.
import { useEffect, useRef, useState, type FocusEvent } from "react";
import {
  Archive,
  BookOpen,
  Code2,
  Columns3,
  FileText,
  Frame,
  GitPullRequest,
  Hand,
  LayoutGrid,
  Link,
  List,
  ListTodo,
  MapIcon,
  MousePointer2,
  Network,
  NotebookText,
  PenTool,
  Redo2,
  Search,
  Shapes,
  Spline,
  SquareCheck,
  SquarePlus,
  StickyNote,
  Table2,
  Type,
  Undo2,
  Waypoints,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate } from "./canvas-grammar";
import type { TPpmCanvasRailProps } from "./canvas-rail-legacy";
import {
  isRailFocusLeavingRoot,
  PPM_RAIL_MENUS,
  railShortcutKey,
  railShortcutLabel,
  visibleRailMenuItems,
  type TPpmGeo,
  type TPpmRailMenuId,
  type TPpmRailMenuItem,
} from "./canvas-toolkit-model";
import type { TPpmCanvasCommand } from "./commands";

export type { TPpmCanvasRailProps };

export type TPpmCanvasToolkitRailProps = TPpmCanvasRailProps & {
  onDrawGeo: (geo: TPpmGeo) => void;
};

const MENU_ICONS: Record<TPpmRailMenuId, LucideIcon> = {
  shapes: Shapes,
  docs: FileText,
  project: Waypoints,
  more: SquarePlus,
};

const ITEM_ICONS: Partial<Record<TPpmCanvasCommand, LucideIcon>> = {
  "add-note": NotebookText,
  "add-document-page": BookOpen,
  "add-list": List,
  "add-table": Table2,
  "add-code": Code2,
  "open-shapes": Workflow,
  "add-work-item": SquareCheck,
  "add-work-items-view": Columns3,
  "add-file": Archive,
  "add-git": GitPullRequest,
  "add-page-ref": FileText,
  "open-find": Search,
  "open-tasks": ListTodo,
  "add-board-link": Link,
  "open-board-panel": LayoutGrid,
  // AF2.2 F: «Из проекта → Карта спринта».
  "build-sprint-map": MapIcon,
};

export function PpmCanvasRail({ activeTool, canEdit, editReady, onDrawGeo, onRunCommand }: TPpmCanvasToolkitRailProps) {
  const ppmT = usePpmTranslation();
  const [openMenu, setOpenMenu] = useState<TPpmRailMenuId>();
  const rootRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const triggerRefs = useRef<Partial<Record<TPpmRailMenuId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpenMenu(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      triggerRefs.current[openMenu]?.focus();
      setOpenMenu(undefined);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openMenu]);

  const runItem = (item: TPpmRailMenuItem) => {
    if (item.command === "open-shapes") {
      setOpenMenu("shapes");
      return;
    }
    setOpenMenu(undefined);
    // AF2.1 R1 (final-fix R1): every item — including "open-find" — goes through the same onRunCommand (workspace.tsx
    // runCanvasCommand), the one gateway that checks activeBoardId/read-only gating; no command bypasses it anymore.
    if (item.command === "draw-geo" && item.geo) onDrawGeo(item.geo);
    else onRunCommand(item.command);
  };

  // AF2.1 R1 (final-fix R1 deferred): the open flyout closes when focus leaves its root (Tab out, not just a
  // pointerdown elsewhere or Escape) — onBlur bubbles in React (focusin/focusout under the hood), so this fires once
  // per focus change and relatedTarget says where focus is going.
  // Final-fix round 2, C-1: relatedTarget is only ever a real Node or null (per the DOM spec) — narrowing that here
  // keeps isRailFocusLeavingRoot itself DOM-free for its own unit test.
  const onRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!openMenu) return;
    const next = event.relatedTarget;
    if (!isRailFocusLeavingRoot(next instanceof Node ? next : null, rootRef.current)) return;
    setOpenMenu(undefined);
  };

  const tool = (
    command: TPpmCanvasCommand,
    icon: LucideIcon,
    label: string,
    options: { disabled?: boolean; pressed?: boolean } = {}
  ) => (
    <RailTool
      command={command}
      disabled={options.disabled}
      icon={icon}
      label={label}
      pressed={options.pressed}
      onRun={(next) => {
        setOpenMenu(undefined);
        onRunCommand(next);
      }}
    />
  );

  const trigger = (menu: TPpmRailMenuId, disabled = false) => (
    <RailMenuTrigger
      buttonRef={(element) => {
        triggerRefs.current[menu] = element;
      }}
      disabled={disabled}
      expanded={openMenu === menu}
      icon={MENU_ICONS[menu]}
      label={ppmT(PPM_RAIL_MENUS[menu].labelKey)}
      menu={menu}
      onToggle={() => setOpenMenu((current) => (current === menu ? undefined : menu))}
    />
  );

  const menuTop = openMenu ? (triggerRefs.current[openMenu]?.offsetTop ?? 0) - (railRef.current?.scrollTop ?? 0) : 0;

  return (
    <div ref={rootRef} className="ppm-canvas-toolkit" onBlur={onRootBlur}>
      <aside ref={railRef} className="ppm-canvas-toolkit-rail" aria-label={ppmT("canvas.rail.label")}>
        {tool("select", MousePointer2, ppmT("canvas.rail.select"), { pressed: activeTool === "select" })}
        {tool("select-hand", Hand, ppmT("canvas.rail.hand"), { pressed: activeTool === "hand" })}
        {canEdit && (
          <>
            <span className="ppm-canvas-toolkit-rail__divider" aria-hidden="true" />
            {tool("add-sticky", StickyNote, ppmT("canvas.rail.sticky"), { disabled: !editReady })}
            {tool("draw-text", Type, ppmT("canvas.rail.text"), {
              disabled: !editReady,
              pressed: activeTool === "text",
            })}
            {trigger("shapes", !editReady)}
            {tool("draw-pen", PenTool, ppmT("canvas.rail.pen"), {
              disabled: !editReady,
              pressed: activeTool === "draw",
            })}
            {tool("add-frame", Frame, ppmT("canvas.rail.frame"), { disabled: !editReady })}
            {tool("draw-connection", Spline, ppmT("canvas.rail.connection"), {
              disabled: !editReady,
              pressed: activeTool === "arrow",
            })}
            <span className="ppm-canvas-toolkit-rail__divider" aria-hidden="true" />
            {trigger("docs", !editReady)}
            {trigger("project", !editReady)}
          </>
        )}
        {tool("open-semantic-edges", Network, ppmT("canvas.semantic_edges"))}
        <span className="ppm-canvas-toolkit-rail__divider" aria-hidden="true" />
        {trigger("more")}
        {canEdit && (
          <>
            {tool("undo", Undo2, ppmT("canvas.undo"), { disabled: !editReady })}
            {tool("redo", Redo2, ppmT("canvas.redo"), { disabled: !editReady })}
          </>
        )}
      </aside>
      {openMenu && <RailMenu editReady={editReady} menu={openMenu} top={menuTop} onRun={runItem} />}
    </div>
  );
}

function RailTool({
  command,
  disabled = false,
  icon: Icon,
  label,
  onRun,
  pressed,
}: {
  command: TPpmCanvasCommand;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onRun: (command: TPpmCanvasCommand) => void;
  pressed?: boolean;
}) {
  const ppmT = usePpmTranslation();
  const shortcut = railShortcutLabel(command);
  const key = railShortcutKey(command);
  return (
    <button
      type="button"
      className="ppm-canvas-toolkit-rail__tool"
      aria-keyshortcuts={key}
      aria-label={label}
      aria-pressed={pressed}
      data-active={pressed || undefined}
      disabled={disabled}
      title={shortcut ? fillCanvasTemplate(ppmT("canvas.rail.with_shortcut"), { keys: shortcut, label }) : label}
      onClick={() => onRun(command)}
    >
      <Icon aria-hidden="true" />
      {key && <kbd aria-hidden="true">{key}</kbd>}
    </button>
  );
}

function RailMenuTrigger({
  buttonRef,
  disabled,
  expanded,
  icon: Icon,
  label,
  menu,
  onToggle,
}: {
  buttonRef: (element: HTMLButtonElement | null) => void;
  disabled: boolean;
  expanded: boolean;
  icon: LucideIcon;
  label: string;
  menu: TPpmRailMenuId;
  onToggle: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="ppm-canvas-toolkit-rail__tool"
      aria-expanded={expanded}
      aria-haspopup="menu"
      aria-label={label}
      data-active={expanded || undefined}
      data-menu={menu}
      disabled={disabled}
      title={label}
      onClick={onToggle}
    >
      <Icon aria-hidden="true" />
      <span className="ppm-canvas-toolkit-rail__corner" aria-hidden="true" />
    </button>
  );
}

function RailMenu({
  editReady,
  menu,
  onRun,
  top,
}: {
  editReady: boolean;
  menu: TPpmRailMenuId;
  onRun: (item: TPpmRailMenuItem) => void;
  top: number;
}) {
  const ppmT = usePpmTranslation();
  const definition = PPM_RAIL_MENUS[menu];
  const items = visibleRailMenuItems(definition, editReady);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const MenuIcon = MENU_ICONS[menu];
  useEffect(() => firstItemRef.current?.focus(), [menu]);
  return (
    <div
      className="ppm-canvas-toolkit-menu"
      data-layout={definition.layout}
      role="menu"
      aria-label={fillCanvasTemplate(ppmT("canvas.rail.menu"), { name: ppmT(definition.labelKey) })}
      style={{ top }}
    >
      <header>
        <span className="ppm-canvas-toolkit-menu__icon">
          <MenuIcon aria-hidden="true" />
        </span>
        <span>
          <strong>{ppmT(definition.labelKey)}</strong>
          <small>{ppmT(definition.captionKey)}</small>
        </span>
      </header>
      <div className="ppm-canvas-toolkit-menu__items">
        {items.map((item, index) => {
          const Icon = ITEM_ICONS[item.command];
          return (
            <button
              key={`${item.command}:${item.geo ?? ""}`}
              ref={index === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              onClick={() => onRun(item)}
            >
              {item.geo ? <PpmGeoGlyph geo={item.geo} /> : Icon && <Icon aria-hidden="true" />}
              <span>
                <strong>{ppmT(item.labelKey)}</strong>
                {item.hintKey && <small>{ppmT(item.hintKey)}</small>}
              </span>
              {item.sourceKey && <em>{ppmT(item.sourceKey)}</em>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const GEO_PATHS: Record<TPpmGeo, string> = {
  rectangle: "M2 3h24v14H2Z",
  oval: "M9 3h10a7 7 0 0 1 0 14H9A7 7 0 0 1 9 3Z",
  ellipse: "M2 10a12 7 0 1 0 24 0a12 7 0 1 0-24 0Z",
  diamond: "M14 2 26 10 14 18 2 10Z",
  rhombus: "M7 3h19l-5 14H2Z",
  trapezoid: "M7 3h14l5 14H2Z",
  triangle: "M14 2 26 18H2Z",
  hexagon: "M8 2h12l6 8-6 8H8l-6-8Z",
  cloud: "M8 17a5 5 0 0 1-.6-10A6 6 0 0 1 19 6a5 5 0 0 1 1 11Z",
  "arrow-right": "M2 7h15V3l9 7-9 7v-4H2Z",
};

/** Outline preview of a tldraw geo type (rail «Фигуры», «Продолжить», style toolbar «Форма»). */
export function PpmGeoGlyph({ geo }: { geo: TPpmGeo }) {
  return (
    <svg className="ppm-canvas-geo-glyph" viewBox="0 0 28 20" aria-hidden="true">
      <path d={GEO_PATHS[geo]} fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth={1.5} />
    </svg>
  );
}
