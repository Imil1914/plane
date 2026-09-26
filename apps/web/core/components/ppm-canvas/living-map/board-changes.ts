/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// AF2.2 C1 · useBoardChanges — `changes` контекста «Живой карты» (провайдер F): индекс меток на карточках, число на
// кнопке и состояние панели «Что изменилось». Контракт F: пусто при !args.enabled (облик v1, минимальный режим); сеть,
// window/document — только при args.isActive (AF2.1 R19); результат стабилен (useMemo); living-map-context.ts не
// импортировать (цикл через провайдер). Лента — при открытии доски и возврате на её вкладку, при открытии панели и смене
// периода, при возврате в окно и раз в 60 с, пока панель открыта (R8). На сервер пишется одно — личная отметка
// просмотра, и только по «Отметить просмотренным». Всё состояние живёт здесь, а не в CanvasControls: тот
// перемонтируется при каждом сохранении доски (components-memo editor.tsx), а панель и её период должны это пережить.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCycle } from "@/hooks/store/use-cycle";
import { PpmCanvasChangesService, type TPpmBoardChange } from "@/services/ppm-canvas-changes.service";
import {
  applySeen,
  beginChangesLoad,
  boardTopLevelShapes,
  buildBoardChangeIndex,
  changesLoadStatus,
  changesPeriodKey,
  clampChangesDate,
  failChangesLoad,
  findSprintCycleId,
  groupBoardChanges,
  INITIAL_BOARD_CHANGES_STATE,
  loadBoardChanges,
  localDateValue,
  mergeLoadedChanges,
  PPM_CHANGES_DATE_DEBOUNCE_MS,
  PPM_CHANGES_POLL_MS,
  shouldRefreshOnReturn,
  type TBoardChangesPanel,
  type TBoardChangesState,
  type TChangesMode,
  unseenChangeEntries,
} from "./changes-model";
import { EMPTY_BOARD_CHANGE_INDEX, type TBoardChangeIndex, type TLivingMapArgs } from "./living-map-types";

const NO_CHANGES: readonly TPpmBoardChange[] = [];

export function useBoardChanges(args: TLivingMapArgs): TBoardChangeIndex {
  // Зависимости — примитивы окружения, не весь args: его объект меняется с каждой привязкой на доске.
  const { authorId, boardId, boards, editor, enabled, isActive, projectId, workspaceId, workspaceSlug } = args;
  const service = useMemo(() => new PpmCanvasChangesService(), []);
  const cycleStore = useCycle();
  const boardCreatedAt = boards.find((board) => board.board_id === boardId)?.created_at ?? null;
  const [state, setState] = useState<TBoardChangesState>(INITIAL_BOARD_CHANGES_STATE);
  const [open, setOpenState] = useState(false);
  const [mode, setModeState] = useState<TChangesMode>("last_seen");
  // «с даты…»: в поле — набранное; в ленту — через 400 мс после последней правки и в пределах окна (appliedDate).
  const [customDate, setCustomDate] = useState("");
  const [appliedDate, setAppliedDate] = useState("");
  const [sprintStart, setSprintStart] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState(false);
  // «С начала спринта» — только на карте (есть рамка спринта) и когда известна дата его начала.
  const effectiveMode: TChangesMode = mode === "sprint" && !sprintStart ? "last_seen" : mode;
  const wantedKey = changesPeriodKey(effectiveMode, appliedDate, sprintStart);
  const periodKey = open ? wantedKey : "closed";
  const requestRef = useRef(0);
  const lastLoadRef = useRef(0);
  const mountedRef = useRef(true);
  // Доска открыта и её вкладка активна — сейчас (для ответа, пришедшего после await).
  const liveRef = useRef(false);
  liveRef.current = enabled && isActive;
  const focusTargetRef = useRef<"panel" | "button" | null>(null);
  const inputsRef = useRef({ boardCreatedAt, customDate: appliedDate, mode: effectiveMode, open, sprintStart });
  inputsRef.current = { boardCreatedAt, customDate: appliedDate, mode: effectiveMode, open, sprintStart };
  // Для «с даты…» без даты: набранное и начало показанной сейчас ленты (заполняется ниже, читается в setMode).
  const prefillRef = useRef<{ customDate: string; since: string | null }>({ customDate: "", since: null });

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    lastLoadRef.current = Date.now();
    const { open: panelOpen, ...inputs } = inputsRef.current;
    setState(beginChangesLoad);
    try {
      const loaded = await loadBoardChanges(
        {
          getChanges: (since) => service.getChanges(workspaceId, projectId, boardId, since),
          getSeen: () => service.getSeen(workspaceId, projectId, boardId),
        },
        { ...inputs, now: Date.now(), panelOpen }
      );
      if (request === requestRef.current) setState((current) => mergeLoadedChanges(current, loaded));
    } catch (error) {
      if (request !== requestRef.current) return;
      setState((current) => failChangesLoad(current, error));
      // 403/404 — ленты на этой доске нет: панель закрывается (фокус не трогаем), опрос встаёт; лента вернётся при
      // возврате на вкладку или в окно — кнопкой, панель сама не откроется.
      if (changesLoadStatus(error) === "unavailable") setOpenState(false);
    }
  }, [boardId, projectId, service, workspaceId]);

  // Открытие доски, возврат на её вкладку, открытие и закрытие панели, смена периода.
  useEffect(() => {
    if (!enabled || !isActive) return;
    void load();
  }, [enabled, isActive, load, periodKey]);

  // Возврат в окно браузера (focus и visibilitychange приходят парой — один запрос).
  useEffect(() => {
    if (!enabled || !isActive) return;
    const onReturn = () => {
      if (document.visibilityState !== "visible" || !shouldRefreshOnReturn(lastLoadRef.current, Date.now())) return;
      void load();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [enabled, isActive, load]);

  // R8: раз в 60 с, пока панель открыта, вкладка доски активна и окно видно.
  useEffect(() => {
    if (!enabled || !isActive || !open) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, PPM_CHANGES_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, isActive, load, open]);

  // «с даты…»: поле шлёт значение на каждую цифру года — в ленту дата уходит через 400 мс после последней правки.
  useEffect(() => {
    const next = clampChangesDate(customDate, Date.now());
    if (next === appliedDate) return;
    const timer = window.setTimeout(() => setAppliedDate(next), PPM_CHANGES_DATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [appliedDate, customDate]);

  // Ответы, пришедшие после закрытия доски, в состояние не пишутся; после «Отметить просмотренным» — без загрузки.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  // «С начала спринта»: рамка спринта на доске → дата начала спринта из стора Plane (или запрос деталей спринта).
  useEffect(() => {
    if (!enabled || !isActive || !open || !editor) return;
    const cycleId = findSprintCycleId(boardTopLevelShapes(editor));
    if (!cycleId) {
      setSprintStart(null);
      return;
    }
    const known = cycleStore.getCycleById(cycleId);
    if (known) {
      setSprintStart(known.start_date);
      return;
    }
    let active = true;
    const fetchSprint = async () => {
      try {
        const cycle = await cycleStore.fetchCycleDetails(workspaceSlug, projectId, cycleId);
        if (active) setSprintStart(cycle.start_date);
      } catch {
        if (active) setSprintStart(null);
      }
    };
    void fetchSprint();
    return () => {
      active = false;
    };
  }, [cycleStore, editor, enabled, isActive, open, projectId, workspaceSlug]);

  const setOpen = useCallback((next: boolean) => {
    focusTargetRef.current = next ? "panel" : "button";
    setMarkError(false);
    setOpenState(next);
  }, []);
  const setMode = useCallback((next: TChangesMode) => {
    // «с даты…» без даты — сразу день, с которого лента показана сейчас (без задержки ввода и лишней загрузки).
    const { customDate: typed, since } = prefillRef.current;
    if (next === "date" && !typed) {
      const value = clampChangesDate(localDateValue(since ?? Date.now()), Date.now());
      setCustomDate(value);
      setAppliedDate(value);
    }
    setModeState(next);
  }, []);
  const consumeFocus = useCallback((target: "panel" | "button") => {
    if (focusTargetRef.current !== target) return false;
    focusTargetRef.current = null;
    return true;
  }, []);
  const retry = useCallback(() => {
    void load();
  }, [load]);
  const markSeen = useCallback(() => {
    if (marking) return;
    setMarking(true);
    setMarkError(false);
    const run = async () => {
      try {
        const seen = await service.markSeen(workspaceId, projectId, boardId);
        if (!mountedRef.current) return;
        // Загрузки, начатые до отметки, считали непросмотренное от старой отметки — их ответы не нужны.
        requestRef.current += 1;
        setState((current) => applySeen(current, seen.seen_at));
        // Свежая лента — только у открытой доски в активной вкладке; скрытая догрузит при возврате.
        if (liveRef.current) void load();
      } catch {
        if (mountedRef.current) setMarkError(true);
      } finally {
        if (mountedRef.current) setMarking(false);
      }
    };
    void run();
  }, [boardId, load, marking, projectId, service, workspaceId]);

  const unseenItems = state.unseen?.items ?? NO_CHANGES;
  // R9: «с последнего просмотра» — число на кнопке, метки и список — без своих действий (unseenChangeEntries).
  const unseenEntries = useMemo(() => unseenChangeEntries(unseenItems, authorId), [authorId, unseenItems]);
  const index = useMemo(() => buildBoardChangeIndex(unseenEntries), [unseenEntries]);
  const periodFeed =
    effectiveMode === "last_seen" ? state.unseen : state.period?.key === wantedKey ? state.period : null;
  const periodItems = periodFeed?.items;
  // Другие периоды — все события, свои с подписью «Вы»; их лента ещё не пришла — строк нет («Загружаем…», «Повторить»).
  const entries = useMemo(
    () => (effectiveMode === "last_seen" ? unseenEntries : periodItems ? groupBoardChanges(periodItems) : NO_CHANGES),
    [effectiveMode, periodItems, unseenEntries]
  );
  const panelStatus = state.status === "ready" && !periodFeed ? "loading" : state.status;
  prefillRef.current = { customDate, since: periodFeed?.since ?? null };

  const panel = useMemo<TBoardChangesPanel>(
    () => ({
      consumeFocus,
      currentUserId: authorId,
      customDate,
      entries,
      markError,
      markSeen,
      marking,
      mode: effectiveMode,
      open,
      retry,
      setCustomDate,
      setMode,
      setOpen,
      since: periodFeed?.since ?? null,
      sprintAvailable: Boolean(sprintStart),
      status: panelStatus,
      truncated: periodFeed?.truncated ?? false,
      unseenTruncated: state.unseen?.truncated ?? false,
    }),
    [
      authorId,
      consumeFocus,
      customDate,
      effectiveMode,
      entries,
      markError,
      markSeen,
      marking,
      open,
      panelStatus,
      periodFeed,
      retry,
      setMode,
      setOpen,
      sprintStart,
      state.unseen,
    ]
  );

  return useMemo<TBoardChangeIndex>(
    () =>
      enabled
        ? {
            ...EMPTY_BOARD_CHANGE_INDEX,
            byShapeId: index.byShapeId,
            byWorkItemId: index.byWorkItemId,
            count: unseenEntries.length,
            panel,
          }
        : EMPTY_BOARD_CHANGE_INDEX,
    [enabled, index, panel, unseenEntries.length]
  );
}
