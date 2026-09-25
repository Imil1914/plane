import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Archive,
  ArrowDown,
  ArrowUp,
  BrainCircuit,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Columns3,
  Code2,
  Copy,
  FileText,
  Focus,
  Frame,
  GitFork,
  Group,
  LayoutGrid,
  Link,
  ListChecks,
  ListPlus,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Minus,
  MousePointer2,
  Network,
  Pencil,
  Presentation,
  Plus,
  Search,
  StickyNote,
  Table2,
  Workflow,
  Redo2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { isPpmProjectAskEnabled } from "@ppm/canvas";
import type { TPpmCanvasBoard, TPpmCanvasCapabilities, TPpmCanvasSyncStatus } from "@ppm/canvas";
import { PPM_BRAND } from "@ppm/brand";
import { useTranslation } from "@plane/i18n";
import { formatPpmTimeAgo } from "@/helpers/ppm-time-ago.helper";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmDesignV2 } from "@/lib/ppm-design";
import { PpmCanvasService, PpmCanvasServiceError } from "@/services/ppm-canvas.service";
import type { TPpmBrainAnswerRun } from "@/services/ppm-brain.service";
import {
  CANVAS_RAIL_COLLAPSE_QUERY,
  canvasBoardTabsKey,
  closeBoardTab,
  filterCanvasCommands,
  footerRoleLabelKey,
  formatCanvasCommandShortcut,
  formatCanvasStatusParts,
  formatCanvasZoom,
  isCanvasCommandAllowedReadOnly,
  MAX_OPEN_CANVAS_BOARDS,
  moveBoard,
  openBoardTab,
  readCanvasBoardTabs,
  shouldCanvasOwnCommandShortcut,
  shouldShowTabSyncDot,
  writeCanvasBoardTabs,
  type TPpmCanvasCommandItem,
} from "./board-workspace-state";
import { PpmBoardPresence, usePpmBoardPresence } from "./board-presence";
import { dispatchPpmCanvasCommand, type TPpmCanvasCommand, type TPpmCanvasCommandDetail } from "./commands";
import { PpmBrainPanel, type TPpmBrainPanelMode } from "./brain-panel";
import { fillCanvasTemplate } from "./canvas-grammar";
import { createCanvasZoomStore, type TPpmCanvasZoomStore } from "./canvas-zoom-store";

const PpmCanvasEditor = lazy(() => import("./editor"));

const CANVAS_COMMAND_SHORTCUT = formatCanvasCommandShortcut(getCanvasPlatform());

// Build-time flag: PPM 1.0 keeps only the non-AI project search; agents and answers need PPM_PROJECT_ASK_ENABLED=1.
const PROJECT_ASK_MODE: TPpmBrainPanelMode = isPpmProjectAskEnabled(process.env.PPM_PROJECT_ASK_ENABLED)
  ? "full"
  : "search";

type TPpmCanvasWorkspaceProps = {
  authorId: string;
  canEdit: boolean;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceSlug: string;
};

type TBoardDialog =
  | { kind: "create" }
  | { board: TPpmCanvasBoard; kind: "duplicate" | "rename" }
  | { board: TPpmCanvasBoard; kind: "archive" };

const EMPTY_CAPABILITIES: TPpmCanvasCapabilities = {
  archive_board: false,
  create_board: false,
  duplicate_board: false,
  edit: false,
  manage_canvas: false,
  read: false,
  rename_board: false,
  reorder_boards: false,
  restore_board: false,
};

const EMPTY_ORCHESTRATOR_RUN_VERSIONS: Record<string, string> = {};

export default function PpmCanvasWorkspace({
  authorId,
  canEdit,
  projectId,
  projectName,
  workspaceId,
  workspaceSlug,
}: TPpmCanvasWorkspaceProps) {
  const ppmT = usePpmTranslation();
  const service = useMemo(() => new PpmCanvasService(), []);
  const [boards, setBoards] = useState<TPpmCanvasBoard[]>([]);
  const [capabilities, setCapabilities] = useState<TPpmCanvasCapabilities>(EMPTY_CAPABILITIES);
  const [defaultBoardId, setDefaultBoardId] = useState<string>();
  const [activeBoardId, setActiveBoardId] = useState<string>();
  const [openBoardIds, setOpenBoardIds] = useState<string[]>([]);
  const boardTabScope = useMemo(() => ({ authorId, projectId, workspaceId }), [authorId, projectId, workspaceId]);
  const boardTabScopeKey = canvasBoardTabsKey(boardTabScope);
  const [loadedBoardTabScopeKey, setLoadedBoardTabScopeKey] = useState<string>();
  const [syncByBoardId, setSyncByBoardId] = useState<Record<string, TPpmCanvasSyncStatus>>({});
  const [editableBoardIds, setEditableBoardIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(
    () => typeof window === "undefined" || !window.matchMedia(CANVAS_RAIL_COLLAPSE_QUERY).matches
  );
  const [showArchived, setShowArchived] = useState(false);
  const [brainPanelOpen, setBrainPanelOpen] = useState(false);
  const brainPanelDraftRef = useRef(false);
  const brainTriggerRef = useRef<HTMLButtonElement>(null);
  const boardSwitcherButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const boardTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const commandReturnFocusRef = useRef<HTMLElement | null>(null);
  const [selectionByBoardId, setSelectionByBoardId] = useState<Record<string, string[]>>({});
  const [toolByBoardId, setToolByBoardId] = useState<Record<string, string>>({});
  const [orchestratorRunVersionsByBoardId, setOrchestratorRunVersionsByBoardId] = useState<
    Record<string, Record<string, string>>
  >({});
  const [dialog, setDialog] = useState<TBoardDialog>();
  const presence = usePpmBoardPresence({ boardId: activeBoardId, projectId, workspaceId });
  const designV2 = usePpmDesignV2();
  const { currentLocale } = useTranslation();
  const [savedAtByBoardId, setSavedAtByBoardId] = useState<Record<string, string | null>>({});
  const zoomStore = useMemo(() => createCanvasZoomStore(), []);
  const handleSavedAtChange = useCallback((boardId: string, savedAt: string | null) => {
    setSavedAtByBoardId((current) => (current[boardId] === savedAt ? current : { ...current, [boardId]: savedAt }));
  }, []);

  useEffect(() => {
    const narrowViewport = window.matchMedia(CANVAS_RAIL_COLLAPSE_QUERY);
    const collapseRailOnNarrowViewport = () => {
      if (narrowViewport.matches) setRailExpanded(false);
    };
    narrowViewport.addEventListener("change", collapseRailOnNarrowViewport);
    return () => narrowViewport.removeEventListener("change", collapseRailOnNarrowViewport);
  }, []);

  const returnFocus = (target: HTMLElement | null) => {
    requestAnimationFrame(() => (target?.isConnected ? target : boardSwitcherButtonRef.current)?.focus());
  };
  const openBoardDialog = (nextDialog: TBoardDialog) => {
    dialogReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBoardMenuOpen(false);
    setDialog(nextDialog);
  };
  const closeBoardDialog = () => {
    setDialog(undefined);
    returnFocus(dialogReturnFocusRef.current);
  };
  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    returnFocus(commandReturnFocusRef.current);
  };
  const brainTriggerLabel = ppmT(PROJECT_ASK_MODE === "search" ? "project_search.title" : "ask_project.title");
  const closeBrainPanel = () => {
    const focusInPanel =
      document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest(".ppm-brain-panel"));
    setBrainPanelOpen(false);
    if (focusInPanel) returnFocus(brainTriggerRef.current);
  };
  const onBrainPanelDraftChange = useCallback((hasDraft: boolean) => {
    brainPanelDraftRef.current = hasDraft;
  }, []);

  const loadBoards = useCallback(
    async (includeArchived: boolean) => {
      setActionError(undefined);
      try {
        const response = await service.getBoards(workspaceId, projectId, includeArchived);
        setBoards(response.boards);
        setCapabilities(response.capabilities);
        setDefaultBoardId(response.default_board_id);
        const activeBoards = response.boards.filter((board) => board.status === "active");
        if (activeBoards.length === 0) throw new Error("Canvas has no active board.");
        const validIds = new Set(activeBoards.map((board) => board.board_id));
        const savedTabs = readCanvasBoardTabs(getBoardTabStorage(), boardTabScope, validIds, response.default_board_id);
        setOpenBoardIds((current) => {
          const restored = current.filter((id) => validIds.has(id));
          const next = restored.length > 0 ? restored : savedTabs.openBoardIds;
          return next.filter((id) => validIds.has(id));
        });
        setActiveBoardId((current) => (current && validIds.has(current) ? current : savedTabs.activeBoardId));
        setLoadedBoardTabScopeKey(boardTabScopeKey);
        setError(undefined);
      } catch (reason) {
        setLoadedBoardTabScopeKey(undefined);
        if (reason instanceof PpmCanvasServiceError && (reason.status === 403 || reason.status === 404)) {
          try {
            getBoardTabStorage()?.removeItem(boardTabScopeKey);
          } catch {
            // Browser storage can be unavailable when project access changes.
          }
        }
        setError(reason instanceof PpmCanvasServiceError ? reason.message : ppmT("canvas.error_description"));
      } finally {
        setLoading(false);
      }
    },
    [boardTabScope, boardTabScopeKey, ppmT, projectId, service, workspaceId]
  );

  useEffect(() => {
    void loadBoards(false);
  }, [loadBoards]);

  useEffect(() => {
    if (loading || loadedBoardTabScopeKey !== boardTabScopeKey || !activeBoardId || openBoardIds.length === 0) return;
    if (!openBoardIds.includes(activeBoardId)) setActiveBoardId(openBoardIds[0]);
  }, [activeBoardId, boardTabScopeKey, loadedBoardTabScopeKey, loading, openBoardIds]);

  useEffect(() => {
    if (loading || loadedBoardTabScopeKey !== boardTabScopeKey || !activeBoardId || openBoardIds.length === 0) return;
    writeCanvasBoardTabs(getBoardTabStorage(), boardTabScope, { activeBoardId, openBoardIds });
  }, [activeBoardId, boardTabScope, boardTabScopeKey, loadedBoardTabScopeKey, loading, openBoardIds]);

  useEffect(() => {
    if (!capabilities.manage_canvas || !showArchived) return;
    void loadBoards(true);
  }, [capabilities.manage_canvas, loadBoards, showArchived]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || Boolean(target?.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyK") {
        // Focus in Plane's shell (top bar, Power-K, modals): let the event through to Plane's palette.
        if (!shouldCanvasOwnCommandShortcut(document.activeElement, workspaceRef.current)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (commandPaletteOpen) closeCommandPalette();
        else {
          commandReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setCommandPaletteOpen(true);
        }
        return;
      }
      if (event.key === "Escape") {
        if (boardMenuOpen) requestAnimationFrame(() => boardSwitcherButtonRef.current?.focus());
        setBoardMenuOpen(false);
        if (commandPaletteOpen) closeCommandPalette();
        if (dialog) closeBoardDialog();
        // Esc elsewhere (e.g. deselecting on the canvas) must not discard a typed search query.
        if (brainPanelOpen && (Boolean(target?.closest(".ppm-brain-panel")) || !brainPanelDraftRef.current))
          closeBrainPanel();
        return;
      }
      if (typing || !activeBoardId || !editableBoardIds.has(activeBoardId)) return;
      if (event.shiftKey && event.code === "KeyN") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCanvasCommand("add-note");
      }
      if (event.shiftKey && event.code === "KeyG") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCanvasCommand("add-group");
      }
      if (event.shiftKey && event.code === "KeyT") {
        event.preventDefault();
        event.stopImmediatePropagation();
        runCanvasCommand("add-work-item");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const activeBoard = boards.find((board) => board.board_id === activeBoardId);
  // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array.
  const activeBoards = boards.filter((board) => board.status === "active").sort(compareBoards);
  // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array.
  const archivedBoards = boards.filter((board) => board.status === "archived").sort(compareBoards);
  const openBoards = openBoardIds
    .map((boardId) => boards.find((board) => board.board_id === boardId))
    .filter((board): board is TPpmCanvasBoard => Boolean(board));
  const activeBoardEditReady = Boolean(
    activeBoardId && canEdit && capabilities.edit && editableBoardIds.has(activeBoardId)
  );
  const activeTool = activeBoardId ? toolByBoardId[activeBoardId] : undefined;

  const runCanvasCommand = (command: TPpmCanvasCommand) => {
    if (!activeBoardId) return;
    if (!activeBoardEditReady && !isCanvasCommandAllowedReadOnly(command, designV2)) return;
    dispatchPpmCanvasCommand({ boardId: activeBoardId, command });
  };

  const handleEditabilityChange = useCallback((boardId: string, editable: boolean) => {
    setEditableBoardIds((current) => {
      if (current.has(boardId) === editable) return current;
      const next = new Set(current);
      if (editable) next.add(boardId);
      else next.delete(boardId);
      return next;
    });
  }, []);

  const handleSelectionChange = useCallback((boardId: string, shapeIds: string[]) => {
    setSelectionByBoardId((current) => {
      const previous = current[boardId] ?? [];
      if (previous.length === shapeIds.length && previous.every((value, index) => value === shapeIds[index])) {
        return current;
      }
      return { ...current, [boardId]: shapeIds };
    });
  }, []);

  const handleToolChange = useCallback((boardId: string, toolId: string) => {
    setToolByBoardId((current) => (current[boardId] === toolId ? current : { ...current, [boardId]: toolId }));
  }, []);

  const handleOrchestratorRunVersionsChange = useCallback((boardId: string, versions: Record<string, string>) => {
    setOrchestratorRunVersionsByBoardId((current) => {
      const previous = current[boardId] ?? {};
      const nextEntries = Object.entries(versions);
      if (
        Object.keys(previous).length === nextEntries.length &&
        nextEntries.every(([runId, version]) => previous[runId] === version)
      )
        return current;
      return { ...current, [boardId]: versions };
    });
  }, []);

  const saveAnswerToCanvas = (run: TPpmBrainAnswerRun) => {
    if (!activeBoardId || !run.answer || run.status === "cancelled" || run.status === "failed") return;
    dispatchPpmCanvasCommand({
      boardId: activeBoardId,
      command: "add-agent-answer",
      agentAnswer: {
        answer: run.answer,
        citations: run.citations,
        query: run.query,
        runId: run.id,
        runStatus: run.status === "completed" ? "completed" : run.status === "no_sources" ? "no_sources" : "degraded",
        selectedShapeIds: run.selected_shape_ids,
        serviceRun: {
          run_id: run.id,
          kind: "answer",
          status: run.status === "completed" ? "completed" : run.status === "no_sources" ? "no_sources" : "degraded",
          provider: run.provider,
          model: run.model,
          policy_version: run.policy_version,
          created_at: run.created_at,
          started_at: run.started_at,
          finished_at: run.finished_at,
          updated_at: run.updated_at,
        },
      },
    });
  };

  const saveSearchToCanvas = (searchResults: NonNullable<TPpmCanvasCommandDetail["searchResults"]>) => {
    if (!activeBoardId || searchResults.results.length === 0) return;
    dispatchPpmCanvasCommand({
      boardId: activeBoardId,
      command: "add-search-results",
      searchResults,
    });
  };

  const saveOrchestratorRunToCanvas = (orchestratorRun: NonNullable<TPpmCanvasCommandDetail["orchestratorRun"]>) => {
    if (!activeBoardId) return;
    dispatchPpmCanvasCommand({
      boardId: activeBoardId,
      command: "add-orchestrator-run",
      orchestratorRun,
    });
  };

  const openBoard = (boardId: string) => {
    if (!openBoardIds.includes(boardId) && openBoardIds.length >= MAX_OPEN_CANVAS_BOARDS) {
      setActionError(ppmT("canvas.board_tab_limit"));
      setBoardMenuOpen(false);
      return;
    }
    setOpenBoardIds((current) => openBoardTab(current, boardId));
    setActiveBoardId(boardId);
    setBoardMenuOpen(false);
  };

  const closeTab = (boardId: string) => {
    if (!activeBoardId) return;
    if (hasPendingCanvasChanges(syncByBoardId[boardId])) {
      setActionError(ppmT("canvas.board_unsaved_changes"));
      return;
    }
    const next = closeBoardTab(openBoardIds, boardId, activeBoardId);
    setOpenBoardIds(next.openBoardIds);
    setActiveBoardId(next.activeBoardId);
    requestAnimationFrame(() => boardTabRefs.current[next.activeBoardId]?.focus());
  };

  const onBoardTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = openBoards.length - 1;
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = index === lastIndex ? 0 : index + 1;
        break;
      case "ArrowLeft":
        nextIndex = index === 0 ? lastIndex : index - 1;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = lastIndex;
        break;
      default:
        return;
    }
    event.preventDefault();
    const board = openBoards[nextIndex];
    if (!board) return;
    openBoard(board.board_id);
    requestAnimationFrame(() => boardTabRefs.current[board.board_id]?.focus());
  };

  const upsertBoard = (board: TPpmCanvasBoard) => {
    setBoards((current) => {
      const found = current.some((item) => item.board_id === board.board_id);
      return found ? current.map((item) => (item.board_id === board.board_id ? board : item)) : [...current, board];
    });
  };

  const submitNamedBoardAction = async (name: string) => {
    setActionError(undefined);
    try {
      if (!dialog || dialog.kind === "archive") return;
      if (dialog.kind === "create") {
        const created = await service.createBoard(workspaceId, projectId, name);
        upsertBoard(created);
        openBoard(created.board_id);
      } else if (dialog.kind === "rename") {
        const renamed = await service.renameBoard(workspaceId, projectId, dialog.board.board_id, name);
        upsertBoard(renamed);
      } else {
        const duplicated = await service.duplicateBoard(workspaceId, projectId, dialog.board.board_id, name);
        upsertBoard(duplicated);
        openBoard(duplicated.board_id);
      }
      closeBoardDialog();
    } catch (reason) {
      setActionError(boardActionMessage(reason, ppmT("canvas.board_action_error")));
    }
  };

  const archiveBoard = async (board: TPpmCanvasBoard) => {
    setActionError(undefined);
    if (hasPendingCanvasChanges(syncByBoardId[board.board_id])) {
      setActionError(ppmT("canvas.board_unsaved_changes"));
      closeBoardDialog();
      return;
    }
    try {
      const archived = await service.archiveBoard(workspaceId, projectId, board.board_id);
      upsertBoard(archived);
      if (activeBoardId) {
        const next = closeBoardTab(openBoardIds, board.board_id, activeBoardId);
        setOpenBoardIds(next.openBoardIds.filter((id) => id !== board.board_id));
        setActiveBoardId(next.activeBoardId === board.board_id ? defaultBoardId : next.activeBoardId);
      }
      closeBoardDialog();
      await loadBoards(showArchived);
    } catch (reason) {
      setActionError(boardActionMessage(reason, ppmT("canvas.board_action_error")));
    }
  };

  const restoreBoard = async (board: TPpmCanvasBoard) => {
    setActionError(undefined);
    try {
      const restored = await service.restoreBoard(workspaceId, projectId, board.board_id);
      upsertBoard(restored);
      openBoard(restored.board_id);
    } catch (reason) {
      setActionError(boardActionMessage(reason, ppmT("canvas.board_action_error")));
    }
  };

  const reorderBoard = async (boardId: string, direction: -1 | 1) => {
    const previous = boards;
    const next = moveBoard(boards, boardId, direction);
    if (next === boards) return;
    setBoards(next);
    try {
      const response = await service.reorderBoards(
        workspaceId,
        projectId,
        next
          .filter((board) => board.status === "active")
          // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array.
          .sort(compareBoards)
          .map((board) => board.board_id)
      );
      setBoards((current) => [...response.boards, ...current.filter((board) => board.status === "archived")]);
    } catch (reason) {
      setBoards(previous);
      setActionError(boardActionMessage(reason, ppmT("canvas.board_action_error")));
    }
  };

  const commands = useMemo<TPpmCanvasCommandItem<TPpmCanvasCommand>[]>(
    () => [
      { command: "select", id: "select", keywords: ["cursor"], label: ppmT("canvas.select") },
      ...(activeBoardEditReady
        ? [
            { command: "add-note" as const, id: "add-note", keywords: ["note"], label: ppmT("canvas.add_note") },
            {
              command: "add-document" as const,
              id: "add-document",
              keywords: ["document", "markdown"],
              label: ppmT("canvas.add_document"),
            },
            {
              command: "add-checklist" as const,
              id: "add-checklist",
              keywords: ["checklist", "todo"],
              label: ppmT("canvas.add_checklist"),
            },
            {
              command: "add-table" as const,
              id: "add-table",
              keywords: ["table", "grid"],
              label: ppmT("canvas.add_table"),
            },
            {
              command: "add-code" as const,
              id: "add-code",
              keywords: ["code", "snippet"],
              label: ppmT("canvas.add_code"),
            },
            {
              command: "add-group" as const,
              id: "add-group",
              keywords: ["group", "frame"],
              label: ppmT("canvas.add_group"),
            },
            {
              command: "add-frame" as const,
              id: "add-frame",
              keywords: ["frame", "section"],
              label: ppmT("canvas.add_frame"),
            },
            {
              command: "add-board-link" as const,
              id: "add-board-link",
              keywords: ["board", "link"],
              label: ppmT("canvas.add_board_link"),
            },
            {
              command: "add-work-item" as const,
              id: "add-work-item",
              keywords: ["task", "issue"],
              label: ppmT("canvas.add_work_item"),
            },
            {
              command: "add-work-items-view" as const,
              id: "add-work-items-view",
              keywords: ["kanban", "backlog", "board", "tasks"],
              label: ppmT("canvas.add_work_items_view"),
            },
            {
              command: "add-diagram" as const,
              id: "add-diagram",
              keywords: ["diagram", "mermaid", "scheme"],
              label: ppmT("canvas.add_diagram"),
            },
            {
              command: "add-deck" as const,
              id: "add-deck",
              keywords: ["presentation", "slides", "deck"],
              label: ppmT("canvas.add_deck"),
            },
            {
              command: "draw-connection" as const,
              id: "draw-connection",
              keywords: ["arrow", "link"],
              label: ppmT("canvas.draw_connection"),
            },
            {
              command: "semantic-edges" as const,
              id: "semantic-edges",
              keywords: ["meaning", "relation"],
              label: ppmT("canvas.semantic_edges"),
            },
            { command: "undo" as const, id: "undo", keywords: ["history"], label: ppmT("canvas.undo") },
            { command: "redo" as const, id: "redo", keywords: ["history"], label: ppmT("canvas.redo") },
          ]
        : []),
      ...(designV2 && !activeBoardEditReady
        ? [
            {
              command: "semantic-edges" as const,
              id: "semantic-edges",
              keywords: ["meaning", "relation"],
              label: ppmT("canvas.semantic_edges"),
            },
          ]
        : []),
      { command: "fit-view", id: "fit-view", keywords: ["camera"], label: ppmT("canvas.fit_view") },
      {
        command: "focus-selection",
        id: "focus-selection",
        keywords: ["camera", "selected"],
        label: ppmT("canvas.focus_selection"),
      },
      { command: "zoom-in", id: "zoom-in", keywords: ["camera"], label: ppmT("canvas.zoom_in") },
      { command: "zoom-out", id: "zoom-out", keywords: ["camera"], label: ppmT("canvas.zoom_out") },
      ...(activeBoardEditReady
        ? [
            {
              command: "align-left" as const,
              id: "align-left",
              keywords: ["selection"],
              label: ppmT("canvas.align_left"),
            },
            {
              command: "align-center-horizontal" as const,
              id: "align-center-horizontal",
              keywords: ["selection"],
              label: ppmT("canvas.align_center_horizontal"),
            },
            {
              command: "align-right" as const,
              id: "align-right",
              keywords: ["selection"],
              label: ppmT("canvas.align_right"),
            },
            {
              command: "align-top" as const,
              id: "align-top",
              keywords: ["selection"],
              label: ppmT("canvas.align_top"),
            },
            {
              command: "align-center-vertical" as const,
              id: "align-center-vertical",
              keywords: ["selection"],
              label: ppmT("canvas.align_center_vertical"),
            },
            {
              command: "align-bottom" as const,
              id: "align-bottom",
              keywords: ["selection"],
              label: ppmT("canvas.align_bottom"),
            },
          ]
        : []),
    ],
    [activeBoardEditReady, designV2, ppmT]
  );

  if (loading) return <WorkspaceState icon={LoaderCircle} spinning text={ppmT("canvas.loading_description")} />;
  if (error || !activeBoardId || !activeBoard)
    return (
      <WorkspaceState
        actionLabel={ppmT("canvas.reload")}
        icon={BrainCircuit}
        onAction={() => void loadBoards(false)}
        text={error ?? ppmT("canvas.error_description")}
      />
    );
  if (presence.status === "denied")
    return (
      <WorkspaceState
        actionLabel={ppmT("canvas.reload")}
        icon={LockKeyhole}
        onAction={() => window.location.reload()}
        text={ppmT("canvas.permission_denied_description")}
      />
    );
  // The footer is the only visible save status; the role is not repeated when the status already says read-only.
  const activeStatusKey = syncStatusLabel(syncByBoardId[activeBoardId], capabilities.edit);
  const activeRoleKey = footerRoleLabelKey(capabilities.edit, activeStatusKey);

  return (
    <div ref={workspaceRef} className="ppm-canvas-workspace" data-rail-expanded={railExpanded || undefined}>
      <header className="ppm-canvas-workspace__header">
        <button
          ref={boardSwitcherButtonRef}
          type="button"
          className="ppm-canvas-board-switcher"
          aria-label={`${projectName}: ${activeBoard.name}`}
          aria-expanded={boardMenuOpen}
          onClick={() => setBoardMenuOpen((current) => !current)}
        >
          <span>{projectName}</span>
          <ChevronRight aria-hidden="true" />
          <strong>{activeBoard.name}</strong>
          <ChevronDown aria-hidden="true" />
        </button>
        <div
          className="ppm-canvas-tabs"
          role="tablist"
          aria-label={ppmT("canvas.open_boards")}
          aria-owns={openBoards.map((board) => `ppm-canvas-tab-${board.board_id}`).join(" ")}
        >
          {openBoards.map((board, index) => (
            <div
              className="ppm-canvas-tab"
              data-active={board.board_id === activeBoardId || undefined}
              key={board.board_id}
              role="presentation"
            >
              <button
                type="button"
                role="tab"
                id={`ppm-canvas-tab-${board.board_id}`}
                ref={(element) => {
                  boardTabRefs.current[board.board_id] = element;
                }}
                aria-controls={`ppm-canvas-panel-${board.board_id}`}
                aria-selected={board.board_id === activeBoardId}
                tabIndex={board.board_id === activeBoardId ? 0 : -1}
                onClick={() => openBoard(board.board_id)}
                onKeyDown={(event) => onBoardTabKeyDown(event, index)}
              >
                {shouldShowTabSyncDot(syncByBoardId[board.board_id]) && (
                  <SyncDot status={syncByBoardId[board.board_id]} />
                )}
                <span>{board.name}</span>
              </button>
              {openBoards.length > 1 && (
                <button
                  type="button"
                  className="ppm-canvas-tab__close"
                  aria-label={ppmT("canvas.close_board_tab")}
                  onClick={() => closeTab(board.board_id)}
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
        {capabilities.create_board && openBoards.length < MAX_OPEN_CANVAS_BOARDS && (
          <button
            type="button"
            className="ppm-canvas-tabs__new"
            aria-label={ppmT("canvas.new_board")}
            title={ppmT("canvas.new_board")}
            onClick={() => openBoardDialog({ kind: "create" })}
          >
            <Plus aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="ppm-canvas-command-trigger"
          aria-label={ppmT("canvas.command_search")}
          onClick={(event) => {
            commandReturnFocusRef.current = event.currentTarget;
            setCommandPaletteOpen(true);
          }}
        >
          <Search aria-hidden="true" />
          <span>{ppmT("canvas.command_search")}</span>
          <kbd>{CANVAS_COMMAND_SHORTCUT}</kbd>
        </button>
        <PpmBoardPresence presence={presence} />
        <button
          ref={brainTriggerRef}
          type="button"
          className="ppm-canvas-brain-trigger"
          aria-label={brainTriggerLabel}
          onClick={() => setBrainPanelOpen(true)}
        >
          {PROJECT_ASK_MODE === "search" ? <Search aria-hidden="true" /> : <BrainCircuit aria-hidden="true" />}
          <span>{brainTriggerLabel}</span>
        </button>
      </header>

      <aside className="ppm-canvas-rail" aria-label={ppmT("canvas.toolbar")}>
        <button
          type="button"
          className="ppm-canvas-rail__brand"
          title={ppmT(railExpanded ? "canvas.collapse_panel" : "canvas.expand_panel")}
          aria-label={ppmT(railExpanded ? "canvas.collapse_panel" : "canvas.expand_panel")}
          onClick={() => setRailExpanded((current) => !current)}
        >
          <img src={PPM_BRAND.assets.mark} alt="" aria-hidden="true" />
          {railExpanded && <strong>PPM</strong>}
          {railExpanded ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
        <RailSectionLabel expanded={railExpanded} label={ppmT("canvas.navigation")} />
        <RailButton
          pressed={activeTool === "select"}
          expanded={railExpanded}
          icon={LayoutGrid}
          label={ppmT("canvas.canvas")}
          onClick={() => runCanvasCommand("select")}
        />
        <RailButton
          expanded={railExpanded}
          icon={Menu}
          label={ppmT("canvas.boards")}
          onClick={() => setBoardMenuOpen((current) => !current)}
        />
        <RailSectionLabel expanded={railExpanded} label={ppmT("canvas.nodes")} />
        {capabilities.edit && (
          <>
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={StickyNote}
              label={ppmT("canvas.add_note")}
              shortcut="⇧N"
              onClick={() => runCanvasCommand("add-note")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={FileText}
              label={ppmT("canvas.add_document")}
              onClick={() => runCanvasCommand("add-document")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={ListChecks}
              label={ppmT("canvas.add_checklist")}
              onClick={() => runCanvasCommand("add-checklist")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Table2}
              label={ppmT("canvas.add_table")}
              onClick={() => runCanvasCommand("add-table")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Code2}
              label={ppmT("canvas.add_code")}
              onClick={() => runCanvasCommand("add-code")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Group}
              label={ppmT("canvas.add_group")}
              shortcut="⇧G"
              onClick={() => runCanvasCommand("add-group")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Frame}
              label={ppmT("canvas.add_frame")}
              onClick={() => runCanvasCommand("add-frame")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Link}
              label={ppmT("canvas.add_board_link")}
              onClick={() => runCanvasCommand("add-board-link")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={ListPlus}
              label={ppmT("canvas.add_work_item")}
              shortcut="⇧T"
              onClick={() => runCanvasCommand("add-work-item")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Columns3}
              label={ppmT("canvas.add_work_items_view")}
              onClick={() => runCanvasCommand("add-work-items-view")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Workflow}
              label={ppmT("canvas.add_diagram")}
              onClick={() => runCanvasCommand("add-diagram")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Presentation}
              label={ppmT("canvas.add_deck")}
              onClick={() => runCanvasCommand("add-deck")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={GitFork}
              label={ppmT("canvas.draw_connection")}
              pressed={activeTool === "arrow"}
              onClick={() => runCanvasCommand("draw-connection")}
            />
            <RailButton
              // v2: the read-only list stays reachable when the board is read-only, in conflict or being restored.
              disabled={!activeBoardEditReady && !isCanvasCommandAllowedReadOnly("semantic-edges", designV2)}
              expanded={railExpanded}
              icon={Network}
              label={ppmT("canvas.semantic_edges")}
              onClick={() => runCanvasCommand("semantic-edges")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Undo2}
              label={ppmT("canvas.undo")}
              onClick={() => runCanvasCommand("undo")}
            />
            <RailButton
              disabled={!activeBoardEditReady}
              expanded={railExpanded}
              icon={Redo2}
              label={ppmT("canvas.redo")}
              onClick={() => runCanvasCommand("redo")}
            />
          </>
        )}
        {designV2 && !capabilities.edit && (
          <RailButton
            expanded={railExpanded}
            icon={Network}
            label={ppmT("canvas.semantic_edges")}
            onClick={() => runCanvasCommand("semantic-edges")}
          />
        )}
        {(!designV2 || (railExpanded && capabilities.edit)) && (
          <RailSectionLabel expanded={railExpanded} label={ppmT("canvas.view")} />
        )}
        {!designV2 && (
          <>
            <RailButton
              expanded={railExpanded}
              icon={Focus}
              label={ppmT("canvas.fit_view")}
              onClick={() => runCanvasCommand("fit-view")}
            />
            <RailButton
              expanded={railExpanded}
              icon={ZoomIn}
              label={ppmT("canvas.zoom_in")}
              onClick={() => runCanvasCommand("zoom-in")}
            />
            <RailButton
              expanded={railExpanded}
              icon={ZoomOut}
              label={ppmT("canvas.zoom_out")}
              onClick={() => runCanvasCommand("zoom-out")}
            />
          </>
        )}
        {railExpanded && capabilities.edit && (
          <div className="ppm-canvas-rail__align" aria-label={ppmT("canvas.align")}>
            <button
              disabled={!activeBoardEditReady}
              type="button"
              title={ppmT("canvas.align_left")}
              onClick={() => runCanvasCommand("align-left")}
            >
              <AlignStartVertical aria-hidden="true" />
            </button>
            <button
              type="button"
              title={ppmT("canvas.align_center_horizontal")}
              onClick={() => runCanvasCommand("align-center-horizontal")}
              disabled={!activeBoardEditReady}
            >
              <AlignCenterVertical aria-hidden="true" />
            </button>
            <button
              disabled={!activeBoardEditReady}
              type="button"
              title={ppmT("canvas.align_right")}
              onClick={() => runCanvasCommand("align-right")}
            >
              <AlignEndVertical aria-hidden="true" />
            </button>
            <button
              disabled={!activeBoardEditReady}
              type="button"
              title={ppmT("canvas.align_top")}
              onClick={() => runCanvasCommand("align-top")}
            >
              <AlignStartHorizontal aria-hidden="true" />
            </button>
            <button
              type="button"
              title={ppmT("canvas.align_center_vertical")}
              onClick={() => runCanvasCommand("align-center-vertical")}
              disabled={!activeBoardEditReady}
            >
              <AlignCenterHorizontal aria-hidden="true" />
            </button>
            <button
              disabled={!activeBoardEditReady}
              type="button"
              title={ppmT("canvas.align_bottom")}
              onClick={() => runCanvasCommand("align-bottom")}
            >
              <AlignEndHorizontal aria-hidden="true" />
            </button>
          </div>
        )}
      </aside>

      <main className="ppm-canvas-workspace__content">
        {openBoardIds.map((boardId) => (
          <div
            className="ppm-canvas-workspace__editor"
            data-active={boardId === activeBoardId || undefined}
            id={`ppm-canvas-panel-${boardId}`}
            role="tabpanel"
            aria-labelledby={`ppm-canvas-tab-${boardId}`}
            aria-hidden={boardId !== activeBoardId}
            key={boardId}
          >
            <Suspense
              fallback={<WorkspaceState icon={LoaderCircle} spinning text={ppmT("canvas.loading_description")} />}
            >
              <PpmCanvasEditor
                authorId={authorId}
                boardId={boardId}
                boards={boards}
                canEdit={canEdit && capabilities.edit}
                onEditabilityChange={handleEditabilityChange}
                onOpenBoard={openBoard}
                onOrchestratorRunVersionsChange={handleOrchestratorRunVersionsChange}
                onSelectionChange={handleSelectionChange}
                onSavedAtChange={designV2 ? handleSavedAtChange : undefined}
                onZoomChange={designV2 ? zoomStore.set : undefined}
                onToolChange={handleToolChange}
                onSyncStatusChange={(id, status) =>
                  setSyncByBoardId((current) => (current[id] === status ? current : { ...current, [id]: status }))
                }
                presence={boardId === activeBoardId ? presence : undefined}
                projectId={projectId}
                statusPlacement="footer"
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
              />
            </Suspense>
          </div>
        ))}
      </main>

      {designV2 ? (
        <CanvasStatusLineV2
          activeBoardIds={activeBoards.map((board) => board.board_id)}
          boardId={activeBoardId}
          locale={currentLocale}
          roleKey={activeRoleKey}
          savedAt={savedAtByBoardId[activeBoardId]}
          status={syncByBoardId[activeBoardId]}
          statusKey={activeStatusKey}
          zoomStore={zoomStore}
          onCommand={runCanvasCommand}
        />
      ) : (
        <footer className="ppm-canvas-workspace__status">
          <span>
            <SyncDot status={syncByBoardId[activeBoardId]} />
            {ppmT(activeStatusKey)}
          </span>
          {activeRoleKey && <span>{ppmT(activeRoleKey)}</span>}
        </footer>
      )}

      {boardMenuOpen && (
        <BoardSwitcher
          activeBoardId={activeBoardId}
          activeBoards={activeBoards}
          archivedBoards={archivedBoards}
          capabilities={capabilities}
          onArchive={(board) => openBoardDialog({ board, kind: "archive" })}
          onClose={() => {
            setBoardMenuOpen(false);
            requestAnimationFrame(() => boardSwitcherButtonRef.current?.focus());
          }}
          onCreate={() => openBoardDialog({ kind: "create" })}
          onDuplicate={(board) => openBoardDialog({ board, kind: "duplicate" })}
          onMove={reorderBoard}
          onOpen={openBoard}
          onRename={(board) => openBoardDialog({ board, kind: "rename" })}
          onRestore={(board) => void restoreBoard(board)}
          onToggleArchived={() => setShowArchived((current) => !current)}
          showArchived={showArchived}
        />
      )}

      {brainPanelOpen && (
        <PpmBrainPanel
          boardId={activeBoardId}
          canEdit={canEdit && capabilities.edit}
          canvasAgentRunVersions={orchestratorRunVersionsByBoardId[activeBoardId] ?? EMPTY_ORCHESTRATOR_RUN_VERSIONS}
          mode={PROJECT_ASK_MODE}
          onClose={closeBrainPanel}
          onDraftChange={onBrainPanelDraftChange}
          onSaveAnswer={saveAnswerToCanvas}
          onSaveAgentRun={saveOrchestratorRunToCanvas}
          onSaveSearch={saveSearchToCanvas}
          projectId={projectId}
          selectedShapeIds={selectionByBoardId[activeBoardId] ?? []}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
        />
      )}

      {commandPaletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={closeCommandPalette}
          onRun={(command) => {
            runCanvasCommand(command);
            closeCommandPalette();
          }}
        />
      )}

      {dialog && dialog.kind !== "archive" && (
        <BoardNameDialog
          initialName={
            dialog.kind === "rename"
              ? dialog.board.name
              : dialog.kind === "duplicate"
                ? `${dialog.board.name} — копия`
                : ""
          }
          kind={dialog.kind}
          onClose={closeBoardDialog}
          onSubmit={(name) => void submitNamedBoardAction(name)}
        />
      )}
      {dialog?.kind === "archive" && (
        <ConfirmArchiveDialog
          board={dialog.board}
          onClose={closeBoardDialog}
          onConfirm={() => void archiveBoard(dialog.board)}
        />
      )}
      {actionError && (
        <div className="ppm-canvas-toast" role="alert">
          <CircleDot aria-hidden="true" />
          <span>{actionError}</span>
          <button type="button" aria-label={ppmT("canvas.close")} onClick={() => setActionError(undefined)}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

function BoardSwitcher({
  activeBoardId,
  activeBoards,
  archivedBoards,
  capabilities,
  onArchive,
  onClose,
  onCreate,
  onDuplicate,
  onMove,
  onOpen,
  onRename,
  onRestore,
  onToggleArchived,
  showArchived,
}: {
  activeBoardId: string;
  activeBoards: TPpmCanvasBoard[];
  archivedBoards: TPpmCanvasBoard[];
  capabilities: TPpmCanvasCapabilities;
  onArchive: (board: TPpmCanvasBoard) => void;
  onClose: () => void;
  onCreate: () => void;
  onDuplicate: (board: TPpmCanvasBoard) => void;
  onMove: (boardId: string, direction: -1 | 1) => void;
  onOpen: (boardId: string) => void;
  onRename: (board: TPpmCanvasBoard) => void;
  onRestore: (board: TPpmCanvasBoard) => void;
  onToggleArchived: () => void;
  showArchived: boolean;
}) {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus(), []);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleActive = activeBoards.filter((board) => board.name.toLocaleLowerCase().includes(normalizedQuery));
  const visibleArchived = archivedBoards.filter((board) => board.name.toLocaleLowerCase().includes(normalizedQuery));

  return (
    <div className="ppm-canvas-popover-backdrop" onPointerDown={onClose}>
      <section
        className="ppm-canvas-board-panel"
        aria-label={ppmT("canvas.boards")}
        aria-modal="true"
        role="dialog"
        onKeyDown={trapDialogTab}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{ppmT("canvas.boards")}</strong>
            <span>{ppmT("canvas.boards_description")}</span>
          </div>
          <button type="button" aria-label={ppmT("canvas.close")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <label className="ppm-canvas-panel-search">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label={ppmT("canvas.search_boards")}
            placeholder={ppmT("canvas.search_boards")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div className="ppm-canvas-board-panel__list">
          <small>{ppmT("canvas.active_boards")}</small>
          {visibleActive.map((board, index) => (
            <div
              className="ppm-canvas-board-row"
              data-active={board.board_id === activeBoardId || undefined}
              key={board.board_id}
            >
              <button type="button" className="ppm-canvas-board-row__open" onClick={() => onOpen(board.board_id)}>
                <Frame aria-hidden="true" />
                <span>
                  <strong>{board.name}</strong>
                  <small>
                    {ppmT("canvas.board_updated")} {formatPpmTimeAgo(board.updated_at, currentLocale)}
                  </small>
                </span>
              </button>
              <div className="ppm-canvas-board-row__actions">
                {capabilities.reorder_boards && (
                  <>
                    <button
                      type="button"
                      disabled={index === 0}
                      title={ppmT("canvas.move_up")}
                      onClick={() => onMove(board.board_id, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={index === activeBoards.length - 1}
                      title={ppmT("canvas.move_down")}
                      onClick={() => onMove(board.board_id, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </button>
                  </>
                )}
                {capabilities.rename_board && (
                  <button type="button" title={ppmT("canvas.rename_board")} onClick={() => onRename(board)}>
                    <Pencil aria-hidden="true" />
                  </button>
                )}
                {capabilities.duplicate_board && (
                  <button type="button" title={ppmT("canvas.duplicate_board")} onClick={() => onDuplicate(board)}>
                    <Copy aria-hidden="true" />
                  </button>
                )}
                {capabilities.archive_board && activeBoards.length > 1 && (
                  <button type="button" title={ppmT("canvas.archive_board")} onClick={() => onArchive(board)}>
                    <Archive aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          ))}
          {visibleActive.length === 0 && <p>{ppmT("canvas.boards_empty_search")}</p>}
          {showArchived && archivedBoards.length > 0 && (
            <>
              <small>{ppmT("canvas.archived_boards")}</small>
              {visibleArchived.map((board) => (
                <div className="ppm-canvas-board-row" key={board.board_id}>
                  <div className="ppm-canvas-board-row__open">
                    <Archive aria-hidden="true" />
                    <span>
                      <strong>{board.name}</strong>
                      <small>{ppmT("canvas.archived")}</small>
                    </span>
                  </div>
                  {capabilities.restore_board && (
                    <button type="button" className="ppm-canvas-board-row__restore" onClick={() => onRestore(board)}>
                      {ppmT("canvas.restore_board")}
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
        <footer>
          {capabilities.manage_canvas && (
            <button type="button" onClick={onToggleArchived}>
              <Archive aria-hidden="true" />
              {ppmT(showArchived ? "canvas.hide_archived" : "canvas.show_archived")}
            </button>
          )}
          {capabilities.create_board && (
            <button type="button" className="ppm-canvas-board-panel__primary" onClick={onCreate}>
              <Plus aria-hidden="true" />
              {ppmT("canvas.new_board")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function CommandPalette({
  commands,
  onClose,
  onRun,
}: {
  commands: TPpmCanvasCommandItem<TPpmCanvasCommand>[];
  onClose: () => void;
  onRun: (command: TPpmCanvasCommand) => void;
}) {
  const ppmT = usePpmTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus(), []);
  const visible = filterCanvasCommands(commands, query);
  useEffect(() => setActiveIndex(0), [query]);
  return (
    <div className="ppm-canvas-dialog-backdrop" onPointerDown={onClose}>
      <section
        className="ppm-canvas-command-palette"
        aria-label={ppmT("canvas.command_palette")}
        aria-modal="true"
        onKeyDown={trapDialogTab}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <label>
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label={ppmT("canvas.command_search")}
            placeholder={ppmT("canvas.command_search")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) => Math.min(current + 1, Math.max(visible.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter" && visible[activeIndex]) {
                event.preventDefault();
                onRun(visible[activeIndex].command);
              }
            }}
          />
          <kbd>ESC</kbd>
        </label>
        <div>
          {visible.map((item, index) => (
            <button
              type="button"
              data-active={index === activeIndex || undefined}
              key={item.id}
              onClick={() => onRun(item.command)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <MousePointer2 aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
          {visible.length === 0 && <p>{ppmT("canvas.no_commands")}</p>}
        </div>
      </section>
    </div>
  );
}

function BoardNameDialog({
  initialName,
  kind,
  onClose,
  onSubmit,
}: {
  initialName: string;
  kind: "create" | "duplicate" | "rename";
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const ppmT = usePpmTranslation();
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const title = ppmT(
    kind === "create" ? "canvas.new_board" : kind === "rename" ? "canvas.rename_board" : "canvas.duplicate_board"
  );
  return (
    <div className="ppm-canvas-dialog-backdrop" onPointerDown={onClose}>
      <form
        className="ppm-canvas-board-dialog"
        aria-label={title}
        aria-modal="true"
        onKeyDown={trapDialogTab}
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSubmit(name.trim());
        }}
        role="dialog"
      >
        <header>
          <strong>{title}</strong>
          <button type="button" aria-label={ppmT("canvas.close")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <label>
          <span>{ppmT("canvas.board_name")}</span>
          <input ref={inputRef} maxLength={120} value={name} onChange={(event) => setName(event.currentTarget.value)} />
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            {ppmT("canvas.cancel")}
          </button>
          <button type="submit" className="ppm-canvas-board-dialog__primary" disabled={!name.trim()}>
            {title}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ConfirmArchiveDialog({
  board,
  onClose,
  onConfirm,
}: {
  board: TPpmCanvasBoard;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ppmT = usePpmTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <div className="ppm-canvas-dialog-backdrop" onPointerDown={onClose}>
      <section
        className="ppm-canvas-board-dialog"
        aria-label={ppmT("canvas.archive_board")}
        aria-modal="true"
        onKeyDown={trapDialogTab}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <strong>{ppmT("canvas.archive_board")}</strong>
          <button ref={closeRef} type="button" aria-label={ppmT("canvas.close")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <p>{ppmT("canvas.archive_board_description").replace("{name}", board.name)}</p>
        <footer>
          <button type="button" onClick={onClose}>
            {ppmT("canvas.cancel")}
          </button>
          <button type="button" className="ppm-canvas-board-dialog__danger" onClick={onConfirm}>
            {ppmT("canvas.archive_board")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function RailButton({
  disabled = false,
  expanded,
  icon: Icon,
  label,
  onClick,
  // Only actual toggle buttons ("Холст" / "Нарисовать визуальную связь") pass this. Leaving it
  // undefined for plain action buttons (add-note, undo, ...) keeps aria-pressed off them entirely
  // instead of falsely announcing every rail button as a toggle.
  pressed,
  shortcut,
}: {
  disabled?: boolean;
  expanded: boolean;
  icon: typeof BrainCircuit;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      className="ppm-canvas-rail-button"
      aria-pressed={pressed}
      data-active={pressed || undefined}
      disabled={disabled}
      title={label}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
      {expanded && (
        <>
          <span>{label}</span>
          {shortcut && <kbd>{shortcut}</kbd>}
        </>
      )}
    </button>
  );
}

function RailSectionLabel({ expanded, label }: { expanded: boolean; label: string }) {
  if (!expanded) return <span className="ppm-canvas-rail__divider" aria-hidden="true" />;
  return <small className="ppm-canvas-rail__label">{label}</small>;
}

function SyncDot({ status }: { status?: TPpmCanvasSyncStatus }) {
  return <span className="ppm-canvas-sync-dot" data-status={status ?? "loading"} aria-hidden="true" />;
}

// UX1.1 status line. Separators are aria-hidden siblings, so the saved label keeps its exact text for e2e.
function CanvasStatusLineV2({
  activeBoardIds,
  boardId,
  locale,
  onCommand,
  roleKey,
  savedAt,
  status,
  statusKey,
  zoomStore,
}: {
  activeBoardIds: string[];
  boardId: string;
  locale: string;
  onCommand: (command: TPpmCanvasCommand) => void;
  roleKey: ReturnType<typeof footerRoleLabelKey>;
  savedAt: string | null | undefined;
  status?: TPpmCanvasSyncStatus;
  statusKey: ReturnType<typeof syncStatusLabel>;
  zoomStore: TPpmCanvasZoomStore;
}) {
  const ppmT = usePpmTranslation();
  const parts = formatCanvasStatusParts({ activeBoardIds, boardId, locale, roleKey, savedAt, statusKey });
  return (
    <footer className="ppm-canvas-workspace__status ppm-canvas-statusline">
      <span className="ppm-canvas-statusline__info">
        {parts.sheet && (
          <>
            <span className="ppm-canvas-statusline__sheet">
              {fillCanvasTemplate(ppmT("canvas.status_sheet"), parts.sheet)}
            </span>
            <span className="ppm-canvas-statusline__sep ppm-canvas-statusline__sep--sheet" aria-hidden="true">
              ·
            </span>
          </>
        )}
        <span className="ppm-canvas-statusline__sync">
          <SyncDot status={status} />
          {ppmT(statusKey)}
        </span>
        {parts.time && (
          <>
            <span className="ppm-canvas-statusline__sep ppm-canvas-statusline__sep--time" aria-hidden="true">
              ·
            </span>
            <time className="ppm-canvas-statusline__time" dateTime={parts.time.iso}>
              {parts.time.label}
            </time>
          </>
        )}
        {parts.role && (
          <>
            <span className="ppm-canvas-statusline__sep" aria-hidden="true">
              ·
            </span>
            <span>{ppmT(parts.role)}</span>
          </>
        )}
      </span>
      <span className="ppm-canvas-zoom" role="group" aria-label={ppmT("canvas.zoom_group")}>
        <button
          type="button"
          aria-label={ppmT("canvas.zoom_out")}
          title={ppmT("canvas.zoom_out")}
          onClick={() => onCommand("zoom-out")}
        >
          <Minus aria-hidden="true" />
        </button>
        <CanvasZoomResetButton boardId={boardId} store={zoomStore} onReset={() => onCommand("zoom-reset")} />
        <button
          type="button"
          aria-label={ppmT("canvas.zoom_in")}
          title={ppmT("canvas.zoom_in")}
          onClick={() => onCommand("zoom-in")}
        >
          <Plus aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={ppmT("canvas.fit_view")}
          title={ppmT("canvas.fit_view")}
          onClick={() => onCommand("fit-view")}
        >
          <Focus aria-hidden="true" />
        </button>
      </span>
    </footer>
  );
}

function CanvasZoomResetButton({
  boardId,
  onReset,
  store,
}: {
  boardId: string;
  onReset: () => void;
  store: TPpmCanvasZoomStore;
}) {
  const ppmT = usePpmTranslation();
  const zoom = useSyncExternalStore(
    store.subscribe,
    () => store.get(boardId),
    () => 100
  );
  const label = fillCanvasTemplate(ppmT("canvas.zoom_reset_label"), { zoom });
  return (
    <button type="button" className="ppm-canvas-zoom__reset" aria-label={label} title={label} onClick={onReset}>
      {formatCanvasZoom(zoom)}
    </button>
  );
}

function WorkspaceState({
  actionLabel,
  icon: Icon,
  onAction,
  spinning = false,
  text,
}: {
  actionLabel?: string;
  icon: typeof BrainCircuit;
  onAction?: () => void;
  spinning?: boolean;
  text: string;
}) {
  return (
    <div className="ppm-canvas-workspace-state">
      <Icon className={spinning ? "animate-spin" : undefined} aria-hidden="true" />
      <span>{text}</span>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function syncStatusLabel(status: TPpmCanvasSyncStatus | undefined, canEdit: boolean) {
  if (!canEdit && (!status || status === "saved")) return "canvas.read_only_title" as const;
  const labels = {
    conflict: "canvas.sync_conflict",
    corrupt: "canvas.sync_corrupt",
    error: "canvas.sync_error",
    loading: "canvas.sync_loading",
    saved: "canvas.sync_saved",
    saving: "canvas.sync_saving",
  } as const;
  return labels[status ?? "loading"];
}

function boardActionMessage(reason: unknown, fallback: string) {
  return reason instanceof PpmCanvasServiceError ? reason.message : fallback;
}

function hasPendingCanvasChanges(status?: TPpmCanvasSyncStatus) {
  return status === "saving" || status === "error" || status === "conflict";
}

function getBoardTabStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function getCanvasPlatform(): string {
  if (typeof navigator === "undefined") return "";
  // userAgentData is not in the DOM typings yet; navigator.platform covers Safari and Firefox.
  const { userAgentData } = navigator as Navigator & { userAgentData?: { platform?: string } };
  return userAgentData?.platform || navigator.platform;
}

function trapDialogTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter(
    (element) => element.tabIndex >= 0 && !element.hasAttribute("disabled") && element.getClientRects().length > 0
  );
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function compareBoards(first: TPpmCanvasBoard, second: TPpmCanvasBoard) {
  return first.position - second.position || first.created_at.localeCompare(second.created_at);
}
