// AF2.2 M1 · RM-f (ревью F2): «Карта спринта» действительно открывает диалог. Рейка «Из проекта», палитра команд и
// кнопка пустой доски шлют build-sprint-map своей доски; блок M CanvasControls отвечает openSprintMapDialog({ boardId });
// хост PpmSprintMapDialog этой доски (дочерний <Tldraw>) рисует диалог — только у активной вкладки редактора под v2.
// Хост рисуется в строку (env node, без DOM), как в других тестах видов.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorContext, type Editor } from "tldraw";
import { PPM_RAIL_MENUS, visibleRailMenuItems } from "@/components/ppm-canvas/canvas-toolkit-model";
import { PPM_LIVING_MAP_DEFAULT, PpmLivingMapContext } from "@/components/ppm-canvas/living-map/living-map-context";
import { EMPTY_LIVING_MAP_ARGS, type TLivingMapArgs } from "@/components/ppm-canvas/living-map/living-map-types";
import {
  closeSprintMapDialog,
  openSprintMapDialog,
  PpmSprintMapDialog,
  restoreSprintMapDialogFocus,
  SPRINT_MAP_FOCUS_ACTIVE_CANVAS,
  SPRINT_MAP_FOCUS_RAIL_TRIGGER,
  sprintMapDialogFallbackFocus,
  sprintMapDialogFocusTarget,
} from "@/components/ppm-canvas/living-map/map-assembly-dialog";
import { BOARD, norm, PROJECT, USER, uuid, WS } from "./fixtures/living-map";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ currentLocale: "ru", t: (key: string) => key }) }));

// Диалог — портал в body; в строку он рисуется на месте.
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));

// В строку React берёт «серверное» значение хранилища диалога (null: на сервере холст не рисуется); здесь — то же,
// что в браузере: доска, для которой диалог открыли.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: <TSnapshot>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => TSnapshot) =>
      actual.useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
  };
});

const dir = new URL("../../core/components/ppm-canvas/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const has = (source: string, needle: string) => expect(norm(source), needle).toContain(norm(needle));

/** Редактор доски BOARD в её активной вкладке под v2. */
const EDITOR_TAB: TLivingMapArgs = {
  ...EMPTY_LIVING_MAP_ARGS,
  authorId: USER,
  boardId: BOARD,
  canEdit: true,
  enabled: true,
  isActive: true,
  loaded: true,
  projectId: PROJECT,
  workspaceId: WS,
  workspaceSlug: "lab",
};

/** Хост диалога так, как его монтирует editor.tsx: внутри <Tldraw> (редактор) и провайдера «Живой карты». */
function renderHost(args: TLivingMapArgs): string {
  return renderToStaticMarkup(
    createElement(
      EditorContext.Provider,
      { value: {} as Editor },
      createElement(
        PpmLivingMapContext.Provider,
        { value: { ...PPM_LIVING_MAP_DEFAULT, args } },
        createElement(PpmSprintMapDialog)
      )
    )
  );
}

describe("AF2.2 M1 (RM-f): «Карта спринта» открывает диалог", () => {
  beforeEach(() => {
    // Портал вычисляет window.document.body и при отрисовке в строку.
    vi.stubGlobal("window", { document: { body: null } });
  });

  afterEach(() => {
    closeSprintMapDialog();
    vi.unstubAllGlobals();
  });

  it("sends build-sprint-map for its board from the rail, the palette and the empty board", () => {
    // Рейка «Из проекта» (редактору), палитра (облик v2) и пустая доска — одна команда своей доски.
    expect(visibleRailMenuItems(PPM_RAIL_MENUS.project, true).map((item) => item.command)).toContain(
      "build-sprint-map"
    );
    const workspace = read("workspace.tsx");
    has(workspace, 'command: "build-sprint-map" as const,');
    has(workspace, "dispatchPpmCanvasCommand({ boardId: activeBoardId, command, ...extra });");
    const editor = read("editor.tsx");
    has(editor, 'onClick={() => dispatchPpmCanvasCommand({ boardId, command: "build-sprint-map" })}');
    // CanvasControls той доски (редактор, облик v2) открывает диалог линии M для неё.
    has(editor, 'case "build-sprint-map": if (canEdit && grammarV2) openSprintMapDialog({ boardId }); break;');
  });

  it("shows the dialog in the host of that board once the command opens it, and nowhere else", () => {
    expect(renderHost(EDITOR_TAB)).toBe("");
    openSprintMapDialog({ boardId: BOARD });
    const html = renderHost(EDITOR_TAB);
    for (const marker of [
      'role="dialog"',
      'aria-modal="true"',
      'data-ppm-canvas-grammar="v2"',
      'data-ppm-canvas-modal=""',
      ">Карта спринта</h2>",
      "Загружаем спринты…",
      "Секции — по направлениям",
      "Собрать карту",
    ])
      expect(html, marker).toContain(marker);
    // Хост другой доски, неактивная вкладка, читатель, облик v1 — диалога нет.
    expect(renderHost({ ...EDITOR_TAB, boardId: uuid(9099) })).toBe("");
    expect(renderHost({ ...EDITOR_TAB, isActive: false })).toBe("");
    expect(renderHost({ ...EDITOR_TAB, canEdit: false })).toBe("");
    expect(renderHost({ ...EDITOR_TAB, enabled: false })).toBe("");
    // «Отмена», Escape, уход с вкладки — closeSprintMapDialog: диалог закрыт.
    closeSprintMapDialog();
    expect(renderHost(EDITOR_TAB)).toBe("");
  });

  it("warns in the open dialog when every board tab is taken (ревью M1, раунд 1)", () => {
    openSprintMapDialog({ boardId: BOARD });
    const warning = "Открыто 8 досок — закройте одну вкладку, чтобы собрать карту";
    expect(renderHost({ ...EDITOR_TAB, canOpenBoard: () => false })).toContain(warning);
    expect(renderHost({ ...EDITOR_TAB, canOpenBoard: () => true })).not.toContain(warning);
    // Без поля (одна доска, без вкладок) — место есть.
    expect(renderHost(EDITOR_TAB)).not.toContain(warning);
  });
});

const asElement = (value: object) => value as unknown as Element;

// Итоговое ревью M-9: диалог «Карта спринта» при закрытии (Esc, «Отмена», крестик, после сборки) возвращает фокус туда,
// где он был при открытии (кнопка рейки, пустой доски…), если этот элемент ещё в документе.
describe("AF2.2 финальная волна (FW-W): фокус после диалога «Карта спринта»", () => {
  const BODY = { tagName: "BODY" };
  /** Элемент страницы так, как его видит возврат фокуса. */
  function element(options: { connected?: boolean; hiddenTab?: boolean } = {}) {
    return {
      closest: vi.fn((selector: string) => (options.hiddenTab && selector === '[aria-hidden="true"]' ? {} : null)),
      focus: vi.fn(),
      isConnected: options.connected ?? true,
      ownerDocument: { body: BODY },
      tagName: "BUTTON",
    };
  }

  afterEach(() => {
    closeSprintMapDialog();
  });

  it("returns the focus on close to the element that had it when the dialog opened", () => {
    const railButton = element();
    openSprintMapDialog({ boardId: BOARD }, asElement(railButton));
    expect(railButton.focus).not.toHaveBeenCalled();
    closeSprintMapDialog();
    expect(railButton.focus).toHaveBeenCalledTimes(1);
    // Уже закрыт — второй раз некуда и незачем.
    closeSprintMapDialog();
    expect(railButton.focus).toHaveBeenCalledTimes(1);
    // Повторное открытие того же диалога (он уже открыт) не подменяет, куда вернуть фокус.
    const first = element();
    openSprintMapDialog({ boardId: BOARD }, asElement(first));
    openSprintMapDialog({ boardId: BOARD }, asElement(element()));
    closeSprintMapDialog();
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it("leaves the focus alone when that element left the document, sits in a hidden board tab or was the page body", () => {
    const gone = element({ connected: false });
    openSprintMapDialog({ boardId: BOARD }, asElement(gone));
    closeSprintMapDialog();
    expect(gone.focus).not.toHaveBeenCalled();
    const hidden = element({ hiddenTab: true });
    expect(restoreSprintMapDialogFocus(sprintMapDialogFocusTarget(asElement(hidden)))).toBe(false);
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(sprintMapDialogFocusTarget(asElement(BODY))).toBeNull();
    expect(sprintMapDialogFocusTarget(null)).toBeNull();
    expect(restoreSprintMapDialogFocus(null)).toBe(false);
  });

  // Ревью FW-W, I-1: с рейки диалог открывает пункт всплывающего меню «Из проекта», из палитры — её строка; оба исчезают
  // раньше, чем диалог закроется. Тогда — запасная цель: кнопка рейки «Из проекта», без неё — холст активной доски.
  /** Рабочее пространство доски так, как его видит запасная цель; anchor — холст доски диалога (editor.getContainer). */
  function workspace(options: {
    canvas?: ReturnType<typeof element> | null;
    trigger?: ReturnType<typeof element> | null;
  }) {
    const root = {
      querySelector: vi.fn((selector: string) => {
        if (selector === SPRINT_MAP_FOCUS_RAIL_TRIGGER) return options.trigger ?? null;
        return selector === SPRINT_MAP_FOCUS_ACTIVE_CANVAS ? (options.canvas ?? null) : null;
      }),
    };
    const anchor = { closest: vi.fn((selector: string) => (selector === ".ppm-canvas-workspace" ? root : null)) };
    return asElement(anchor);
  }

  it("falls back to the rail «Из проекта» button when the opener left the document before close (I-1)", () => {
    const menuItem = element();
    const trigger = element();
    const canvas = element();
    openSprintMapDialog({ boardId: BOARD }, asElement(menuItem));
    // Пункт меню снят в том же нажатии (canvas-rail.tsx runItem → setOpenMenu(undefined)).
    menuItem.isConnected = false;
    closeSprintMapDialog(workspace({ canvas, trigger }));
    expect(menuItem.focus).not.toHaveBeenCalled();
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(canvas.focus).not.toHaveBeenCalled();
  });

  it("falls back to the active board's canvas without a usable rail button, never into a hidden tab (I-1)", () => {
    // Палитра ⌘K к закрытию диалога уже убрана; кнопки рейки нет (или она недоступна) — холст активной доски.
    const palette = element({ connected: false });
    const canvas = element();
    openSprintMapDialog({ boardId: BOARD }, asElement(palette));
    closeSprintMapDialog(workspace({ canvas, trigger: null }));
    expect(canvas.focus).toHaveBeenCalledTimes(1);
    // Кнопка пустой доски, оставшаяся после сборки в скрытой вкладке, — не туда; скрытый холст — тоже нет.
    const emptyBoardButton = element({ hiddenTab: true });
    const hiddenCanvas = element({ hiddenTab: true });
    openSprintMapDialog({ boardId: BOARD }, asElement(emptyBoardButton));
    closeSprintMapDialog(workspace({ canvas: hiddenCanvas, trigger: null }));
    expect(emptyBoardButton.focus).not.toHaveBeenCalled();
    expect(hiddenCanvas.focus).not.toHaveBeenCalled();
    // Вне рабочего пространства запасная цель — сам холст доски диалога.
    const bare = { ...element(), closest: vi.fn(() => null) };
    expect(sprintMapDialogFallbackFocus(asElement(bare))).toBe(bare);
    expect(sprintMapDialogFallbackFocus(null)).toBeNull();
  });

  it("returns the focus on the next frame, when the dialog is gone and the tabs have switched (I-1)", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    try {
      const menuItem = element();
      const trigger = element();
      openSprintMapDialog({ boardId: BOARD }, asElement(menuItem));
      closeSprintMapDialog(workspace({ trigger }));
      // Диалог закрыт сразу (хосты перерисовываются), фокус — кадром позже, по настоящему DOM.
      expect(renderHost(EDITOR_TAB)).toBe("");
      expect(trigger.focus).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      menuItem.isConnected = false;
      for (const frame of frames.splice(0)) frame(0);
      expect(menuItem.focus).not.toHaveBeenCalled();
      expect(trigger.focus).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes every way through closeSprintMapDialog with this board's canvas, then returns the focus", () => {
    const dialog = read("living-map/map-assembly-dialog.tsx");
    // Esc и щелчок по фону → close() → onClose; «Отмена» и крестик → onClose; удачная сборка → onClose(); уход с вкладки
    // → эффект хоста — у всех один выход, и каждый даёт холст своей доски для запасной цели.
    has(dialog, "const closeDialog = useCallback(() => closeSprintMapDialog(editor.getContainer()), [editor]);");
    has(dialog, "return <SprintMapDialog deps={deps} onClose={closeDialog} />;");
    has(dialog, "if (openedForBoard === args.boardId && !args.isActive) closeSprintMapDialog(editor.getContainer());");
    const close = dialog.slice(dialog.indexOf("export function closeSprintMapDialog"));
    expect(close.indexOf("emit();")).toBeGreaterThan(-1);
    expect(close.indexOf("emit();")).toBeLessThan(close.indexOf("afterNextFrame("));
    // Запасная цель — в той разметке, что рисуют рейка и рабочее пространство.
    has(read("canvas-rail.tsx"), '<aside ref={railRef} className="ppm-canvas-toolkit-rail"');
    has(read("canvas-rail.tsx"), "data-menu={menu}");
    const workspaceSource = read("workspace.tsx");
    has(workspaceSource, '<div ref={workspaceRef} className="ppm-canvas-workspace"');
    has(
      workspaceSource,
      'className="ppm-canvas-workspace__editor" data-active={boardId === activeBoardId || undefined}'
    );
    expect(SPRINT_MAP_FOCUS_RAIL_TRIGGER).toBe('.ppm-canvas-toolkit-rail button[data-menu="project"]:not(:disabled)');
    expect(SPRINT_MAP_FOCUS_ACTIVE_CANVAS).toBe(".ppm-canvas-workspace__editor[data-active] .tl-container");
  });
});
