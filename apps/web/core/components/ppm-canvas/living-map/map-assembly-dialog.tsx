/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Map as MapIcon, X } from "lucide-react";
import { createShapeId, useEditor } from "tldraw";
import { useTranslation } from "@plane/i18n";
import { formatPpmSprintRange } from "@/components/ppm-tasks/sprint";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmCanvasChangesService } from "@/services/ppm-canvas-changes.service";
import { PpmCanvasMapService } from "@/services/ppm-canvas-map.service";
import { PpmCanvasService } from "@/services/ppm-canvas.service";
import { fillCanvasTemplate } from "../canvas-grammar";
import { syncCanvasEditorFocus } from "../file-preview";
import { usePpmLivingMap } from "./living-map-context";
import {
  assembleSprintMap,
  buildSprintMapBoard,
  createSeenAfterSave,
  type TSprintMapBuildResult,
} from "./map-assembly";
import { hasSprintMapAssembly, queueSprintMapAssembly, takeSprintMapAssembly } from "./map-assembly-queue";
import {
  activeBoardNames,
  pluralKey,
  selectSprintCandidates,
  uniqueMapBoardName,
  type TSprintCandidate,
} from "./map-model";
import { applyMapChange, revealSprintMap } from "./map-shapes";

// AF2.2 M1: «Собрать карту спринта». Команда build-sprint-map (рейка, палитра, пустая доска) → блок M CanvasControls
// (F) → openSprintMapDialog({ boardId }). PpmSprintMapDialog — дочерний <Tldraw> каждой доски v2 (F): показывает
// диалог у активной вкладки своей доски и собирает карту из очереди, когда это новая доска. Диалог — портал в body:
// корень [data-ppm-canvas-grammar="v2"] (стили living-map.css) и [data-ppm-canvas-modal] (гард клавиш workspace.tsx).
export type TPpmSprintMapDialogRequest = { boardId: string };

let openedFor: string | null = null;
// Итоговое ревью M-9: где был фокус, когда диалог открыли (кнопка рейки, пустой доски…), — туда он вернётся.
let returnFocusTo: HTMLElement | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

/** M-9: куда вернуть фокус после диалога — элемент страницы с focus(); body (фокуса не было) — никуда. */
export function sprintMapDialogFocusTarget(activeElement: Element | null): HTMLElement | null {
  if (!activeElement || activeElement === activeElement.ownerDocument?.body) return null;
  const target = activeElement as HTMLElement;
  return typeof target.focus === "function" ? target : null;
}

/** Вернуть фокус, если элемент ещё в документе и не во вкладке другой (скрытой) доски — иначе фокус не трогаем. */
export function restoreSprintMapDialogFocus(target: HTMLElement | null): boolean {
  if (!target?.isConnected || target.closest('[aria-hidden="true"]')) return false;
  target.focus();
  return true;
}

/** Кнопка меню рейки «Из проекта» (canvas-rail.tsx): её Esc тоже возвращает фокус туда. */
export const SPRINT_MAP_FOCUS_RAIL_TRIGGER = '.ppm-canvas-toolkit-rail button[data-menu="project"]:not(:disabled)';
/** Холст активной доски рабочего пространства (workspace.tsx: панель вкладки с data-active). */
export const SPRINT_MAP_FOCUS_ACTIVE_CANVAS = ".ppm-canvas-workspace__editor[data-active] .tl-container";

/**
 * Ревью FW-W, I-1: элемент, открывший диалог, обычно исчезает раньше, чем диалог закроется, — пункт всплывающего меню
 * рейки «Из проекта» (меню снимается в том же нажатии) или строка палитры ⌘K. Тогда фокус — на устойчивую цель, как
 * returnFocus в workspace.tsx: кнопка меню рейки «Из проекта», без неё (или она недоступна) — холст активной доски.
 * anchor — холст доски диалога (editor.getContainer): от него ищется рабочее пространство; вне его — сам холст.
 */
export function sprintMapDialogFallbackFocus(anchor: Element | null): HTMLElement | null {
  const workspace = anchor?.closest(".ppm-canvas-workspace");
  if (!workspace) return sprintMapDialogFocusTarget(anchor);
  return (
    workspace.querySelector<HTMLElement>(SPRINT_MAP_FOCUS_RAIL_TRIGGER) ??
    workspace.querySelector<HTMLElement>(SPRINT_MAP_FOCUS_ACTIVE_CANVAS)
  );
}

/** Следующий кадр — как returnFocus в workspace.tsx; без requestAnimationFrame (тесты, env node) — сразу. */
function afterNextFrame(task: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(task);
  else task();
}

export function openSprintMapDialog(
  request: TPpmSprintMapDialogRequest,
  activeElement: Element | null = typeof document === "undefined" ? null : document.activeElement
): void {
  // Диалог уже открыт — фокус в нём самом: куда вернуться, запомнено при первом открытии.
  if (openedFor === null) returnFocusTo = sprintMapDialogFocusTarget(activeElement);
  openedFor = request.boardId;
  emit();
}

/**
 * Единственный выход из диалога: Esc, щелчок по фону, «Отмена», крестик, удачная сборка, уход с вкладки; anchor — холст
 * доски диалога (запасная цель фокуса). Фокус возвращается на следующем кадре (ревью FW-W, I-1): диалог уже убран, а
 * после сборки новой карты вкладки уже переключены — решение по настоящему DOM: туда, откуда открыли, иначе запасная
 * цель; во вкладку другой (скрытой) доски — никогда. Холст, который забрал фокус при закрытии (syncCanvasEditorFocus),
 * отдаёт его.
 */
export function closeSprintMapDialog(anchor: Element | null = null): void {
  if (openedFor === null) return;
  const opener = returnFocusTo;
  returnFocusTo = null;
  openedFor = null;
  emit();
  afterNextFrame(() => {
    if (!restoreSprintMapDialogFocus(opener)) restoreSprintMapDialogFocus(sprintMapDialogFallbackFocus(anchor));
  });
}

export type TSprintMapDialogDeps = {
  /** Имя новой доски — незанятое среди активных досок, как его создаст build. */
  boardName: (cycle: TSprintCandidate) => string;
  build: (cycle: TSprintCandidate) => Promise<TSprintMapBuildResult>;
  /** Есть ли свободная вкладка для новой доски (args.canOpenBoard). */
  canOpenBoard: () => boolean;
  loadCandidates: () => Promise<TSprintCandidate[]>;
};

export function PpmSprintMapDialog() {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const { args } = usePpmLivingMap();
  const openedForBoard = useSyncExternalStore(
    subscribe,
    () => openedFor,
    () => null
  );
  const argsRef = useRef(args);
  argsRef.current = args;
  const assemblingRef = useRef(false);
  const services = useMemo(
    () => ({ canvas: new PpmCanvasService(), changes: new PpmCanvasChangesService(), map: new PpmCanvasMapService() }),
    []
  );
  // RM14: после сохранения, активировавшего карточки новой карты, — одна личная отметка «просмотрено» (S3, линия C).
  // Компонент — дочерний <Tldraw> (не перемонтируется при сохранении), поэтому ожидание переживает автосохранения.
  const seenAfterSave = useMemo(
    () =>
      createSeenAfterSave(() => {
        const { boardId, projectId, workspaceId } = argsRef.current;
        return services.changes.markSeen(workspaceId, projectId, boardId);
      }),
    [services]
  );
  const open = args.enabled && args.isActive && args.canEdit && openedForBoard === args.boardId;

  // M-9 (ревью FW-W, I-1): закрытие — с холстом этой доски: от него ищется запасная цель фокуса (рейка, холст).
  const closeDialog = useCallback(() => closeSprintMapDialog(editor.getContainer()), [editor]);

  // Диалог — только у активной вкладки своей доски (AF2.1 R19).
  useEffect(() => {
    if (openedForBoard === args.boardId && !args.isActive) closeSprintMapDialog(editor.getContainer());
  }, [args.boardId, args.isActive, editor, openedForBoard]);

  // Пока диалог открыт, горячие клавиши tldraw (Backspace/Delete, буквы инструментов) не доходят до доски.
  useEffect(() => {
    if (!open) return;
    syncCanvasEditorFocus(editor, { isActive: true, modalOpen: true });
    return () => syncCanvasEditorFocus(editor, { isActive: argsRef.current.isActive, modalOpen: false });
  }, [editor, open]);

  // Сборка: план из очереди забирает редактор новой доски — загруженной, доступной для правки и активной — один раз.
  useEffect(() => {
    const current = argsRef.current;
    if (!current.enabled || !current.isActive || !current.loaded || !current.canEdit || assemblingRef.current) return;
    if (!hasSprintMapAssembly(current.boardId)) return;
    const plan = takeSprintMapAssembly(current.boardId);
    if (!plan) return;
    if (editor.getCurrentPageShapeIds().size > 0) {
      // Карта собирается только на новой (пустой) доске — существующее содержимое не трогаем.
      current.notify?.(ppmT("canvas.map.board_not_empty"));
      return;
    }
    assemblingRef.current = true;
    const { boardId, projectId, workspaceId } = current;
    void assembleSprintMap(
      {
        applyChange: (change) => applyMapChange(editor, change),
        authorId: current.authorId,
        bindBatch: (items) => services.map.bindBatch(workspaceId, projectId, boardId, items),
        cancelBinding: (bindingId) => services.canvas.cancelPendingBinding(workspaceId, projectId, boardId, bindingId),
        newShapeId: () => createShapeId(),
        now: () => new Date().toISOString(),
        registerBindings: (bindings) => {
          current.registerBindings(bindings);
          seenAfterSave.expect(bindings);
        },
      },
      plan
    )
      .then((result) => {
        revealSprintMap(editor, result.frameId);
        current.notify?.(
          result.failed > 0
            ? fillCanvasTemplate(ppmT("canvas.map.built_partial"), { failed: result.failed, placed: result.placed })
            : fillCanvasTemplate(ppmT("canvas.map.built"), { count: result.placed })
        );
        return undefined;
      })
      .catch(() => {
        current.notify?.(ppmT("canvas.map.assembly_error"));
      })
      .finally(() => {
        assemblingRef.current = false;
      });
  }, [args.boardId, args.canEdit, args.enabled, args.isActive, args.loaded, editor, ppmT, seenAfterSave, services]);

  // RM14: привязки доски меняются и после сохранения (pending → active) — тогда отметка уходит, один раз на сборку.
  // Это продолжение нажатия «Собрать карту» этой вкладки, не опрос: без сборки ждать нечего.
  useEffect(() => {
    seenAfterSave.check(args.bindingsByShapeId);
  }, [args.bindingsByShapeId, seenAfterSave]);

  // RM15 + RM-a: страж живых карточек при удалении групп — в map-guard.ts; его регистрирует блок M editor.tsx в любом
  // облике (ревью M1, раунд 1), не этот хост: он есть только под v2.

  const deps = useMemo<TSprintMapDialogDeps>(
    () => ({
      // Имя, которое увидит пользователь, — то же, что buildSprintMapBoard попробует первым (ревью M1, раунд 1).
      boardName: (cycle) =>
        uniqueMapBoardName(ppmT("canvas.map.board_name"), cycle.name, activeBoardNames(argsRef.current.boards)),
      build: (cycle) => {
        const current = argsRef.current;
        return buildSprintMapBoard(
          {
            canOpenBoard: () => argsRef.current.canOpenBoard?.() ?? true,
            createBoard: (name) => services.canvas.createBoard(current.workspaceId, current.projectId, name),
            existingBoardNames: () => activeBoardNames(argsRef.current.boards),
            loadModules: () => services.map.getModules(current.workspaceSlug, current.projectId),
            loadSprintIssues: (cycleId) => services.map.getIssues(current.workspaceSlug, current.projectId, cycleId),
            locale: currentLocale,
            newShapeId: () => createShapeId(),
            onBoardCreated: (created) => argsRef.current.onBoardCreated(created),
            queue: queueSprintMapAssembly,
            t: ppmT,
          },
          cycle
        );
      },
      canOpenBoard: () => argsRef.current.canOpenBoard?.() ?? true,
      loadCandidates: async () => {
        const current = argsRef.current;
        return selectSprintCandidates(
          await services.map.getCycles(current.workspaceSlug, current.projectId),
          new Date()
        );
      },
    }),
    [currentLocale, ppmT, services]
  );

  if (!open) return null;
  return <SprintMapDialog deps={deps} onClose={closeDialog} />;
}

type TDialogStatus = "build_error" | "building" | "empty" | "load_error" | "loading" | "ready" | "tab_limit";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const PHASE_KEYS = {
  completed: "canvas.map.dialog_phase_completed",
  current: "canvas.map.dialog_phase_current",
  upcoming: "canvas.map.dialog_phase_upcoming",
} as const;
const TASK_KEYS = {
  few: "canvas.map.section_tasks_few",
  many: "canvas.map.section_tasks_many",
  one: "canvas.map.section_tasks_one",
} as const;

function SprintMapDialog({ deps, onClose }: { deps: TSprintMapDialogDeps; onClose: () => void }) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const [candidates, setCandidates] = useState<TSprintCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState<TDialogStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busy = status === "building";

  useEffect(() => {
    let active = true;
    setStatus("loading");
    void deps
      .loadCandidates()
      .then((list) => {
        if (!active) return undefined;
        setCandidates(list);
        setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id));
        setStatus("ready");
        return undefined;
      })
      .catch(() => {
        if (active) setStatus("load_error");
      });
    return () => {
      active = false;
    };
  }, [attempt, deps]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const selected = candidates.find((item) => item.id === selectedId);
  // Новая доска откроется вкладкой — нет свободной (8 открыто): предупреждение, «Собрать карту» недоступна, ничего не
  // создаётся; вкладки сами не закрываются (решение контроллера, ревью M1). Пока диалог открыт, вкладки под фоном.
  const tabsFull = status === "tab_limit" || !deps.canOpenBoard();
  const close = () => {
    if (!busy) onClose();
  };
  const build = async () => {
    if (!selected || busy || tabsFull) return;
    setStatus("building");
    try {
      const result = await deps.build(selected);
      if (result.status === "empty" || result.status === "tab_limit") {
        setStatus(result.status);
        return;
      }
      onClose();
    } catch {
      setStatus("build_error");
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.code === "Escape") {
      close();
      return;
    }
    if (event.code !== "Tab") return;
    const dialog = dialogRef.current;
    const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    if (!dialog || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const focused = document.activeElement;
    if (event.shiftKey && (focused === first || focused === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (focused === last || focused === dialog)) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="ppm-sprint-map-backdrop" data-ppm-canvas-grammar="v2" role="presentation" onPointerDown={close}>
      <div
        ref={dialogRef}
        aria-labelledby="ppm-sprint-map-title"
        aria-modal="true"
        className="ppm-sprint-map-dialog"
        data-ppm-canvas-modal=""
        role="dialog"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="ppm-sprint-map-dialog__header">
          <MapIcon aria-hidden="true" />
          <h2 id="ppm-sprint-map-title">{ppmT("canvas.af22.sprint_map")}</h2>
          <button type="button" aria-label={ppmT("canvas.close")} disabled={busy} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        {status === "loading" && (
          <p className="ppm-sprint-map-dialog__note" role="status">
            {ppmT("canvas.map.dialog_loading")}
          </p>
        )}
        {status === "load_error" && (
          <p className="ppm-sprint-map-dialog__error" role="alert">
            {ppmT("canvas.map.dialog_load_error")}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              {ppmT("canvas.map.dialog_retry")}
            </button>
          </p>
        )}
        {status !== "loading" && status !== "load_error" && candidates.length === 0 && (
          <p className="ppm-sprint-map-dialog__note">{ppmT("canvas.map.dialog_empty")}</p>
        )}
        {candidates.length > 0 && (
          <fieldset className="ppm-sprint-map-dialog__sprints" disabled={busy}>
            <legend>{ppmT("canvas.map.dialog_sprint_label")}</legend>
            {candidates.map((item) => {
              const range = formatPpmSprintRange(item.start_date, item.end_date, currentLocale);
              const tasks = fillCanvasTemplate(ppmT(pluralKey(item.total_issues, currentLocale, TASK_KEYS)), {
                count: item.total_issues,
              });
              return (
                <label
                  key={item.id}
                  className="ppm-sprint-map-dialog__sprint"
                  data-selected={item.id === selectedId || undefined}
                >
                  <input
                    checked={item.id === selectedId}
                    name="ppm-sprint-map-cycle"
                    type="radio"
                    value={item.id}
                    onChange={() => setSelectedId(item.id)}
                  />
                  <span className="ppm-sprint-map-dialog__sprint-name">{item.name}</span>
                  <span className="ppm-sprint-map-dialog__sprint-meta">
                    {[range, ppmT(PHASE_KEYS[item.phase]), tasks].filter(Boolean).join(" · ")}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        <p className="ppm-sprint-map-dialog__note">{ppmT("canvas.map.dialog_grouping")}</p>
        {selected && (
          <p className="ppm-sprint-map-dialog__note">
            {fillCanvasTemplate(ppmT("canvas.map.dialog_new_board"), {
              name: deps.boardName(selected),
            })}
          </p>
        )}
        {tabsFull && (
          <p className="ppm-sprint-map-dialog__error" role="alert">
            {ppmT("canvas.map.dialog_tab_limit")}
          </p>
        )}
        {status === "empty" && (
          <p className="ppm-sprint-map-dialog__error" role="alert">
            {ppmT("canvas.map.dialog_no_tasks")}
          </p>
        )}
        {status === "build_error" && (
          <p className="ppm-sprint-map-dialog__error" role="alert">
            {ppmT("canvas.map.dialog_build_error")}
            <button type="button" onClick={() => void build()}>
              {ppmT("canvas.map.dialog_retry")}
            </button>
          </p>
        )}
        <footer className="ppm-sprint-map-dialog__footer">
          <button type="button" className="ppm-sprint-map-dialog__secondary" disabled={busy} onClick={onClose}>
            {ppmT("canvas.map.dialog_cancel")}
          </button>
          <button
            type="button"
            className="ppm-sprint-map-dialog__primary"
            aria-busy={busy || undefined}
            disabled={!selected || busy || tabsFull}
            onClick={() => void build()}
          >
            {busy && <LoaderCircle aria-hidden="true" className="ppm-sprint-map-dialog__spinner" />}
            {ppmT(busy ? "canvas.map.dialog_building" : "canvas.map.dialog_build")}
          </button>
        </footer>
      </div>
    </div>,
    window.document.body
  );
}
