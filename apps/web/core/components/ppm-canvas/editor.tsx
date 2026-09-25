/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileArchive,
  Frame,
  MousePointer2,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Box,
  Tldraw,
  createShapeId,
  GeoShapeGeoStyle,
  useEditor,
  useValue,
  type Editor,
  type TLComponents,
  type TLEditorSnapshot,
  type TLArrowBinding,
  type TLArrowShape,
  type TLGroupShape,
  type TLShapeId,
} from "tldraw";
import { useTheme } from "next-themes";
import {
  PPM_CANVAS_AUTOSAVE_DELAY_MS,
  PPM_CANVAS_GIT_OBJECT_TYPES,
  PPM_CANVAS_SCHEMA_VERSION,
  createPpmCanvasBoardExport,
  createPpmAgentAnswerNode,
  createPpmAgentQueryNode,
  createPpmContentRefNode,
  createPpmCanvasNode,
  createPpmGitRefNode,
  createPpmOrchestratorNode,
  createPpmSearchNode,
  createPpmWorkItemRefNode,
  mergePpmOrchestratorNode,
  parseSerializedPpmCanvasNode,
  parsePpmCanvasBoardExport,
  serializePpmCanvasNode,
  type TPpmCanvasBinding,
  type TPpmCanvasBoard,
  type TPpmCanvasContentBinding,
  type TPpmCanvasGitBinding,
  type TPpmCanvasMediaNode,
  type TPpmCanvasSaveRequest,
  type TPpmCanvasSnapshot,
  type TPpmCanvasSemanticEdge,
  type TPpmCanvasSemanticRelationType,
  type TPpmCanvasOwnedNodeKind,
  type TPpmCanvasWorkItemBinding,
  type TPpmCanvasGitRefNode,
  type TPpmCanvasSyncStatus,
  type TPpmProjectionSearchResponse,
  type TPpmWorkItemEditOptions,
  type TPpmWorkItemPatchRequest,
  type TPpmWorkItemProjection,
  type TPpmWorkItemViewCreateRequest,
  type TPpmWorkItemsViewQuery,
  type TPpmWorkItemsViewResponse,
} from "@ppm/canvas";
import type { TPpmTranslationKey } from "@ppm/brand";
import { EFileAssetType } from "@plane/types";
import { resolveGeneralTheme } from "@plane/utils";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmDesignV2 } from "@/lib/ppm-design";
import { PpmCanvasService, PpmCanvasServiceError } from "@/services/ppm-canvas.service";
import { FileService } from "@/services/file.service";
import { PpmVaultService } from "@/services/ppm-vault.service";
import {
  PPM_CANVAS_SHAPE_TYPE,
  PpmCanvasNodeShapeUtil,
  PpmCanvasBoardNavigationContext,
  PpmWorkItemProjectionContext,
  expandOrchestratorRun,
  type TPpmCanvasShape,
} from "./shape";
import { PPM_CANVAS_COMMAND_EVENT, type TPpmCanvasCommandDetail } from "./commands";
import {
  presenceCursorColors,
  resolveBoardChangeAction,
  resolveBoardSaveCompletion,
  type TPpmBoardPresenceController,
} from "./board-presence";
import {
  classifyCanvasRecoveryDraft,
  clearCanvasRecoveryDraft,
  clearDurableCanvasRecoveryDraft,
  durableCanvasRecoveryKey,
  listDurableCanvasRecoveryDrafts,
  mergeDisjointCanvasSnapshots,
  readCanvasRecoveryDraft,
  sameCanvasSnapshots,
  serializeCanvasRecoveryDraft,
  writeCanvasRecoveryDraft,
  writeDurableCanvasRecoveryDraft,
  type TPpmCanvasRecoveryDraft,
} from "./board-recovery";
import { canvasSaveRetryDelayMs, shouldRetryCanvasSave } from "./board-save-retry";
import { isBlockingCanvasStatus } from "./board-workspace-state";
import { PpmCanvasInspector } from "./canvas-inspector";
import { PpmCanvasGrammarContext, isCanvasGrammarV2 } from "./canvas-grammar";
import { PpmSemanticEdgeFocusContext, PpmSemanticEdgesContext, PpmSemanticEdgesLayer } from "./semantic-edges-layer";
import { SEMANTIC_RELATION_LABELS, sameSemanticEdges } from "./semantic-edge-style";
import {
  MAX_CANVAS_IMPORT_SNAPSHOT_BYTES,
  createDesktopImportReport,
  prepareDesktopFlowImport,
  type TPpmDesktopImportPlan,
  type TPpmDesktopImportReport,
} from "./desktop-import";
// oxlint-disable-next-line import/no-unassigned-import -- tldraw owns the canvas interaction styles
import "tldraw/tldraw.css";
// oxlint-disable-next-line import/no-unassigned-import -- PPM theme is intentionally scoped to this route
import "./canvas.css";
// oxlint-disable-next-line import/no-unassigned-import -- UX1.1: v2 look, every rule scoped to html[data-ppm-design="v2"]
import "./canvas-v2.css";

type TPpmCanvasEditorProps = {
  authorId: string;
  boardId: string;
  boards: TPpmCanvasBoard[];
  canEdit: boolean;
  onEditabilityChange?: (boardId: string, editable: boolean) => void;
  onOpenBoard: (boardId: string) => void;
  onOrchestratorRunVersionsChange?: (boardId: string, versions: Record<string, string>) => void;
  onSelectionChange?: (boardId: string, shapeIds: string[]) => void;
  onSyncStatusChange?: (boardId: string, status: TPpmCanvasSyncStatus) => void;
  // UX1.1 (v2 workspace only): server time of the last saved version and the rounded zoom, for the footer.
  onSavedAtChange?: (boardId: string, savedAt: string | null) => void;
  onZoomChange?: (boardId: string, zoom: number) => void;
  onToolChange?: (boardId: string, toolId: string) => void;
  presence?: TPpmBoardPresenceController;
  projectId: string;
  // "card": the status card inside the editor (minimal workspace, the only status there).
  // "footer": the workspace footer owns the status; the editor keeps a blocking banner and a "Board" pill.
  statusPlacement?: "card" | "footer";
  workspaceId: string;
  workspaceSlug: string;
};

type TPendingFileDrop = {
  files: File[];
  pagePoint: { x: number; y: number };
};

type TPendingCanvasSave = Pick<
  TPpmCanvasSaveRequest,
  "base_version" | "binding_changes" | "client_operation_id" | "snapshot"
>;

type TRecoveryCandidate = {
  draft: TPpmCanvasRecoveryDraft;
  key: string;
  storage: "local" | "session";
};

const HIDDEN_TLDRAW_UI: TLComponents = {
  ActionsMenu: null,
  ContextMenu: null,
  CursorChatBubble: null,
  DebugMenu: null,
  DebugPanel: null,
  Dialogs: null,
  HelpMenu: null,
  HelperButtons: null,
  ImageToolbar: null,
  KeyboardShortcutsDialog: null,
  MainMenu: null,
  MenuPanel: null,
  Minimap: null,
  NavigationPanel: null,
  PageMenu: null,
  QuickActions: null,
  RichTextToolbar: null,
  SharePanel: null,
  StylePanel: null,
  Toasts: null,
  Toolbar: null,
  TopPanel: null,
  VideoToolbar: null,
  ZoomMenu: null,
};

export default function PpmCanvasEditor({
  authorId,
  boardId,
  canEdit,
  onEditabilityChange,
  onOpenBoard,
  onOrchestratorRunVersionsChange,
  onSelectionChange,
  onSyncStatusChange,
  onSavedAtChange,
  onZoomChange,
  onToolChange,
  presence,
  projectId,
  statusPlacement = "card",
  workspaceId,
  workspaceSlug,
}: TPpmCanvasEditorProps) {
  const ppmT = usePpmTranslation();
  const designV2 = usePpmDesignV2();
  const grammarV2 = isCanvasGrammarV2(designV2, statusPlacement);
  const service = useMemo(() => new PpmCanvasService(), []);
  const fileService = useMemo(() => new FileService(), []);
  const vaultService = useMemo(() => new PpmVaultService(), []);
  const [editor, setEditor] = useState<Editor>();
  // tldraw follows the PPM theme, not the OS: `inferDarkMode` would track the system setting instead.
  const { resolvedTheme } = useTheme();
  const colorScheme = resolveGeneralTheme(resolvedTheme);
  const [effectiveCanEdit, setEffectiveCanEdit] = useState(false);
  const [syncStatus, setSyncStatus] = useState<TPpmCanvasSyncStatus>("loading");
  const [recoveryDraft, setRecoveryDraft] = useState<TPpmCanvasRecoveryDraft>();
  const [recoveryCandidates, setRecoveryCandidates] = useState<TRecoveryCandidate[]>([]);
  const [selectedRecoveryKey, setSelectedRecoveryKey] = useState<string>();
  const [recoveryMode, setRecoveryMode] = useState<"restore" | "export_only">("restore");
  const [mergePreview, setMergePreview] = useState<{
    contentHash: string | null;
    localChanges: number;
    remoteChanges: number;
    remoteVersion: number;
  }>();
  const [mergeUnavailable, setMergeUnavailable] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [draftStorageUnavailable, setDraftStorageUnavailable] = useState(false);
  const [copiedLocal, setCopiedLocal] = useState(false);
  const [importError, setImportError] = useState(false);
  const [desktopImport, setDesktopImport] = useState<{
    boardId: string;
    filename: string;
    plan: TPpmDesktopImportPlan;
  }>();
  const [desktopImportCount, setDesktopImportCount] = useState<number>();
  const [desktopImportReport, setDesktopImportReport] = useState<TPpmDesktopImportReport>();
  // Lives here, not in CanvasControls: the tldraw overlay remounts whenever the components memo changes.
  const [boardInfoOpen, setBoardInfoOpen] = useState(false);
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  const boardInfoFocusRef = useRef(false);
  // Same reason: "Semantic links" must survive autosave and edge updates, which rebuild the overlay.
  const [semanticPanelOpen, setSemanticPanelOpen] = useState(false);
  const semanticPanelOpenRef = useRef(false);
  const semanticPanelFocusRef = useRef(false);
  // UX1.1: the edge whose chip was clicked; the list highlights and scrolls to it. Lives here (not in the overlay)
  // and reaches the list through PpmSemanticEdgeFocusContext, so a chip click does not rebuild the overlay.
  const [focusedEdgeId, setFocusedEdgeId] = useState<string>();
  // Every write of the edge list bumps it: a focus refresh applies its response only if nothing newer happened.
  const semanticEdgesRequestRef = useRef(0);
  const [fileDropNotice, setFileDropNotice] = useState(false);
  const [pendingFileDrop, setPendingFileDrop] = useState<TPendingFileDrop>();
  const [fileDropError, setFileDropError] = useState<string>();
  const [fileDropUploading, setFileDropUploading] = useState(false);
  const [planeDropPickerOpen, setPlaneDropPickerOpen] = useState(false);
  const [bindingsByShapeId, setBindingsByShapeId] = useState<ReadonlyMap<string, TPpmCanvasBinding>>(new Map());
  const [workItemOptions, setWorkItemOptions] = useState<TPpmWorkItemEditOptions>({
    assignees: [],
    priorities: [],
    states: [],
  });
  const [projectionErrors, setProjectionErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [pendingWorkItemIds, setPendingWorkItemIds] = useState<ReadonlySet<string>>(new Set());
  const [isRefreshingWorkItems, setIsRefreshingWorkItems] = useState(false);
  const [semanticEdges, setSemanticEdges] = useState<TPpmCanvasSemanticEdge[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const editorRef = useRef<Editor>();
  const approvedProjectionDeletesRef = useRef(new Set<TLShapeId>());
  const processedVaultProjectionRef = useRef<string>();
  const processedGitProjectionRef = useRef<string>();
  const versionRef = useRef(0);
  const baselineSnapshotRef = useRef<TPpmCanvasSnapshot | null>(null);
  const conflictBindingChangesRef = useRef(false);
  const mergeBusyRef = useRef(false);
  const mergeGenerationRef = useRef(0);
  const pendingSaveRef = useRef<TPendingCanvasSave>();
  const durableRecoveryIdRef = useRef<string>();
  const adoptedRecoveryKeyRef = useRef<string>();
  const queuedBindingActivationsRef = useRef(new Set<string>());
  const queuedBindingRemovalsRef = useRef(new Set<string>());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const retryAttemptRef = useRef(0);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const remoteConflictRef = useRef(false);
  const initializedRef = useRef(false);
  const [initializationTick, setInitializationTick] = useState(0);
  const blockedRef = useRef(true);
  const editableRef = useRef(false);
  const recoveryScope = useMemo(
    () => ({ authorId, boardId, projectId, workspaceId }),
    [authorId, boardId, projectId, workspaceId]
  );

  const persistRecoveryDraft = useCallback(() => {
    const activeEditor = editorRef.current;
    if (!activeEditor) return;
    const pendingChanges = pendingSaveRef.current?.binding_changes;
    const draft: TPpmCanvasRecoveryDraft = {
      format: "ppm-canvas-recovery",
      schema_version: PPM_CANVAS_SCHEMA_VERSION,
      base_version: versionRef.current,
      saved_at: new Date().toISOString(),
      snapshot: { document: activeEditor.getSnapshot().document },
      binding_changes: {
        activate: [...new Set([...(pendingChanges?.activate ?? []), ...queuedBindingActivationsRef.current])],
        remove: [...new Set([...(pendingChanges?.remove ?? []), ...queuedBindingRemovalsRef.current])],
      },
      // An unacknowledged request must keep its exact payload and operation ID
      // across a browser restart. Replacing the ID could create a second version.
      pending_operation: pendingSaveRef.current,
    };
    const sessionStorage = getCanvasSessionStorage();
    if (sessionStorage) writeCanvasRecoveryDraft(sessionStorage, recoveryScope, draft);
    const localStorage = getCanvasLocalStorage();
    durableRecoveryIdRef.current ??= crypto.randomUUID();
    setDraftStorageUnavailable(
      !localStorage ||
        !writeDurableCanvasRecoveryDraft(localStorage, recoveryScope, durableRecoveryIdRef.current, draft)
    );
  }, [recoveryScope]);

  const clearRecoveryDraft = useCallback(() => {
    const sessionStorage = getCanvasSessionStorage();
    if (sessionStorage) clearCanvasRecoveryDraft(sessionStorage, recoveryScope);
    const localStorage = getCanvasLocalStorage();
    if (localStorage) {
      if (durableRecoveryIdRef.current)
        clearDurableCanvasRecoveryDraft(
          localStorage,
          durableCanvasRecoveryKey(recoveryScope, durableRecoveryIdRef.current)
        );
      if (adoptedRecoveryKeyRef.current) clearDurableCanvasRecoveryDraft(localStorage, adoptedRecoveryKeyRef.current);
    }
    adoptedRecoveryKeyRef.current = undefined;
    setDraftStorageUnavailable(false);
  }, [recoveryScope]);

  const purgeRecoveryDrafts = useCallback(() => {
    clearRecoveryDraft();
    const localStorage = getCanvasLocalStorage();
    if (localStorage) {
      for (const candidate of listDurableCanvasRecoveryDrafts(localStorage, recoveryScope))
        clearDurableCanvasRecoveryDraft(localStorage, candidate.key);
    }
  }, [clearRecoveryDraft, recoveryScope]);

  const queueRecoveryDraft = useCallback(() => {
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(persistRecoveryDraft, 180);
  }, [persistRecoveryDraft]);

  const scheduleSaveRef = useRef<() => void>(() => undefined);
  const flushSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const resetSaveRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    retryAttemptRef.current = 0;
  }, []);
  const scheduleSaveRetry = useCallback(() => {
    if (!initializedRef.current || blockedRef.current || !pendingSaveRef.current || retryTimerRef.current) return;
    const delay = canvasSaveRetryDelayMs(retryAttemptRef.current);
    retryAttemptRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = undefined;
      void flushSaveRef.current();
    }, delay);
  }, []);
  const flushSave = useCallback(async () => {
    const activeEditor = editorRef.current;
    if (!activeEditor || !editableRef.current || blockedRef.current || savingRef.current) return;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;

    let pending = pendingSaveRef.current;
    if (!pending) {
      const { document } = activeEditor.getSnapshot();
      const snapshot = { document };
      if (
        baselineSnapshotRef.current &&
        queuedBindingActivationsRef.current.size === 0 &&
        queuedBindingRemovalsRef.current.size === 0 &&
        sameCanvasSnapshots(snapshot, baselineSnapshotRef.current)
      ) {
        dirtyRef.current = false;
        clearRecoveryDraft();
        setSyncStatus("saved");
        return;
      }
      pending = {
        base_version: versionRef.current,
        binding_changes: {
          activate: [...queuedBindingActivationsRef.current],
          remove: [...queuedBindingRemovalsRef.current],
        },
        client_operation_id: crypto.randomUUID(),
        snapshot,
      };
      queuedBindingActivationsRef.current.clear();
      queuedBindingRemovalsRef.current.clear();
      pendingSaveRef.current = pending;
      dirtyRef.current = false;
    }

    savingRef.current = true;
    setSyncStatus("saving");
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    persistRecoveryDraft();
    try {
      const request: TPpmCanvasSaveRequest = {
        schema_version: PPM_CANVAS_SCHEMA_VERSION,
        base_version: pending.base_version,
        binding_changes: pending.binding_changes,
        client_operation_id: pending.client_operation_id,
        snapshot: pending.snapshot,
      };
      const response = await service.saveBoard(workspaceId, projectId, boardId, request);
      versionRef.current = response.version;
      setSavedAt(response.saved_at);
      baselineSnapshotRef.current = pending.snapshot;
      if (pending.binding_changes.activate.length > 0) {
        const activatedIds = new Set(pending.binding_changes.activate);
        setBindingsByShapeId(
          (current) =>
            new Map(
              [...current].map(([shapeId, binding]) => [
                shapeId,
                activatedIds.has(binding.binding_id) ? { ...binding, binding_status: "active" as const } : binding,
              ])
            )
        );
      }
      pendingSaveRef.current = undefined;
      savingRef.current = false;
      resetSaveRetry();
      const completion = resolveBoardSaveCompletion(remoteConflictRef.current, dirtyRef.current);
      if (completion === "conflict") {
        persistRecoveryDraft();
        setSyncStatus("conflict");
        return;
      }
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      if (dirtyRef.current) persistRecoveryDraft();
      else clearRecoveryDraft();
      setSyncStatus("saved");
      if (completion === "save_again") scheduleSaveRef.current();
    } catch (error) {
      savingRef.current = false;
      if (error instanceof PpmCanvasServiceError && error.status === 409) {
        resetSaveRetry();
        conflictBindingChangesRef.current =
          pending.binding_changes.activate.length > 0 ||
          pending.binding_changes.remove.length > 0 ||
          queuedBindingActivationsRef.current.size > 0 ||
          queuedBindingRemovalsRef.current.size > 0;
        await Promise.all(
          pending.binding_changes.activate.map((bindingId) =>
            service.cancelPendingBinding(workspaceId, projectId, boardId, bindingId).catch(() => undefined)
          )
        );
        pendingSaveRef.current = undefined;
        queuedBindingActivationsRef.current.clear();
        queuedBindingRemovalsRef.current.clear();
        blockedRef.current = true;
        remoteConflictRef.current = true;
        editableRef.current = false;
        editorRef.current?.updateInstanceState({ isReadonly: true });
        setEffectiveCanEdit(false);
        setSyncStatus("conflict");
        return;
      }
      setSyncStatus(remoteConflictRef.current ? "conflict" : "error");
      if (error instanceof PpmCanvasServiceError && shouldRetryCanvasSave(error.status) && !remoteConflictRef.current)
        scheduleSaveRetry();
    }
  }, [
    boardId,
    clearRecoveryDraft,
    persistRecoveryDraft,
    projectId,
    resetSaveRetry,
    scheduleSaveRetry,
    service,
    workspaceId,
  ]);
  flushSaveRef.current = flushSave;

  const scheduleSave = useCallback(() => {
    if (applyingRemoteRef.current || blockedRef.current) return;
    dirtyRef.current = true;
    setSyncStatus("saving");
    queueRecoveryDraft();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(), PPM_CANVAS_AUTOSAVE_DELAY_MS);
  }, [flushSave, queueRecoveryDraft]);
  scheduleSaveRef.current = scheduleSave;

  const createContentProjectionShape = useCallback(
    async (binding: TPpmCanvasContentBinding, pagePoint?: { x: number; y: number }) => {
      const activeEditor = editorRef.current;
      if (!activeEditor) {
        await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id).catch(() => undefined);
        throw new Error("Canvas editor is not available.");
      }
      const mediaKind = contentNodeKind(binding.source.display.mime_type, binding.source.display.extension);
      const node = createPpmContentRefNode({
        authorId,
        binding: {
          binding_id: binding.binding_id,
          entity_id: binding.entity_id,
          entity_type: binding.entity_type,
          source_version: binding.source_version,
        },
        extension: binding.source.display.extension,
        kind: mediaKind,
        sourceUrl: binding.source.identity.source_url ?? binding.source.display.preview_url ?? "",
        title: binding.source.display.title,
      });
      const id = binding.shape_id as TLShapeId;
      const center = pagePoint ?? activeEditor.getViewportPageBounds().center;
      queuedBindingActivationsRef.current.add(binding.binding_id);
      try {
        activeEditor.createShape<TPpmCanvasShape>({
          id,
          type: PPM_CANVAS_SHAPE_TYPE,
          x: center.x - node.visual.width / 2,
          y: center.y - node.visual.height / 2,
          props: { h: node.visual.height, node: serializePpmCanvasNode(node), w: node.visual.width },
        });
        setBindingsByShapeId((current) => new Map(current).set(binding.shape_id, binding));
        activeEditor.select(id).setCurrentTool("select");
        scheduleSaveRef.current();
      } catch (error) {
        queuedBindingActivationsRef.current.delete(binding.binding_id);
        await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id).catch(() => undefined);
        throw error;
      }
    },
    [authorId, boardId, projectId, service, workspaceId]
  );

  const createGitProjectionShape = useCallback(
    async (binding: TPpmCanvasGitBinding) => {
      const activeEditor = editorRef.current;
      if (!activeEditor) {
        await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id).catch(() => undefined);
        throw new Error("Canvas editor is not available.");
      }
      const { display, identity } = binding.source;
      if (!identity.source_url) {
        await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id).catch(() => undefined);
        throw new Error("Git source URL is unavailable.");
      }
      const node = createPpmGitRefNode({
        authorId,
        binding: {
          binding_id: binding.binding_id,
          entity_id: binding.entity_id,
          entity_type: binding.entity_type,
          source_version: binding.source_version,
        },
        canonicalUrl: identity.source_url,
        objectType: display.object_type,
        provider: display.provider,
        repositoryName: display.repository_name,
        sourceId: binding.entity_id,
        title: display.title,
        workItemKey: display.work_items[0]?.identifier ?? null,
      });
      const id = binding.shape_id as TLShapeId;
      const center = activeEditor.getViewportPageBounds().center;
      queuedBindingActivationsRef.current.add(binding.binding_id);
      try {
        activeEditor.createShape<TPpmCanvasShape>({
          id,
          type: PPM_CANVAS_SHAPE_TYPE,
          x: center.x - node.visual.width / 2,
          y: center.y - node.visual.height / 2,
          props: { h: node.visual.height, node: serializePpmCanvasNode(node), w: node.visual.width },
        });
        setBindingsByShapeId((current) => new Map(current).set(binding.shape_id, binding));
        activeEditor.select(id).setCurrentTool("select");
        scheduleSaveRef.current();
      } catch (error) {
        queuedBindingActivationsRef.current.delete(binding.binding_id);
        await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id).catch(() => undefined);
        throw error;
      }
    },
    [authorId, boardId, projectId, service, workspaceId]
  );

  useEffect(() => {
    if (editor && editor.user.getUserPreferences().colorScheme !== colorScheme)
      editor.user.updateUserPreferences({ colorScheme });
  }, [editor, colorScheme]);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    let stopListening: (() => void) | undefined;
    editorRef.current = editor;
    resetSaveRetry();
    blockedRef.current = true;
    editableRef.current = false;
    pendingSaveRef.current = undefined;
    adoptedRecoveryKeyRef.current = undefined;
    queuedBindingActivationsRef.current.clear();
    queuedBindingRemovalsRef.current.clear();
    dirtyRef.current = false;
    remoteConflictRef.current = false;
    conflictBindingChangesRef.current = false;
    baselineSnapshotRef.current = null;
    mergeGenerationRef.current += 1;
    mergeBusyRef.current = false;
    initializedRef.current = false;
    versionRef.current = 0;
    setSavedAt(null);
    setCopiedLocal(false);
    setImportError(false);
    setDesktopImport(undefined);
    setDesktopImportCount(undefined);
    setDesktopImportReport(undefined);
    setRecoveryDraft(undefined);
    setRecoveryCandidates([]);
    setSelectedRecoveryKey(undefined);
    setRecoveryMode("restore");
    setMergePreview(undefined);
    setMergeUnavailable(false);
    setMergeBusy(false);
    setDraftStorageUnavailable(false);
    setSemanticEdges([]);
    setEffectiveCanEdit(false);
    setSyncStatus("loading");
    editor.updateInstanceState({ isReadonly: true });

    const initialize = async () => {
      try {
        const remoteCanvas = await service.getBoard(workspaceId, projectId, boardId);
        if (!active) return;
        versionRef.current = remoteCanvas.version;
        setSavedAt(remoteCanvas.saved_at);
        baselineSnapshotRef.current = remoteCanvas.snapshot;
        if (remoteCanvas.snapshot_status === "corrupt") {
          setSyncStatus("corrupt");
          return;
        }
        if (remoteCanvas.snapshot_status === "ready" && remoteCanvas.snapshot) {
          editor.loadSnapshot(remoteCanvas.snapshot as unknown as Partial<TLEditorSnapshot>);
        }
        // Remote hydration establishes the local baseline. It must never be undoable as a user action.
        editor.clearHistory();
        setBindingsByShapeId(new Map(remoteCanvas.bindings.map((binding) => [binding.shape_id, binding])));
        setWorkItemOptions(remoteCanvas.work_item_options);
        const edgeResponse = await service
          .getSemanticEdges(workspaceId, projectId, boardId)
          .catch(() => ({ semantic_edges: [] }));
        if (!active) return;
        semanticEdgesRequestRef.current += 1;
        setSemanticEdges(edgeResponse.semantic_edges);
        const mayEdit = canEdit && remoteCanvas.access === "edit";
        const sessionStorage = getCanvasSessionStorage();
        const localStorage = getCanvasLocalStorage();
        const sessionDraft = sessionStorage ? readCanvasRecoveryDraft(sessionStorage, recoveryScope) : undefined;
        const durableCandidates: TRecoveryCandidate[] = localStorage
          ? listDurableCanvasRecoveryDrafts(localStorage, recoveryScope).map((candidate) => ({
              draft: candidate.draft,
              key: candidate.key,
              storage: "local" as const,
            }))
          : [];
        // Current versions write both stores. Migrate a unique legacy tab draft
        // before offering other drafts, so a later edit cannot replace its only copy.
        let sessionOnly = false;
        if (sessionDraft && sessionStorage) {
          const duplicate = durableCandidates.some(
            ({ draft }) => JSON.stringify(draft) === JSON.stringify(sessionDraft)
          );
          if (!duplicate && localStorage) {
            const migratedId = crypto.randomUUID();
            if (writeDurableCanvasRecoveryDraft(localStorage, recoveryScope, migratedId, sessionDraft))
              durableCandidates.push({
                draft: sessionDraft,
                key: durableCanvasRecoveryKey(recoveryScope, migratedId),
                storage: "local",
              });
            else sessionOnly = true;
          } else if (!duplicate) sessionOnly = true;
          if (!sessionOnly) clearCanvasRecoveryDraft(sessionStorage, recoveryScope);
        }
        const candidates: TRecoveryCandidate[] =
          sessionOnly && sessionDraft
            ? [{ draft: sessionDraft, key: "session", storage: "session" }]
            : durableCandidates;
        if (!mayEdit && localStorage)
          for (const candidate of durableCandidates) clearDurableCanvasRecoveryDraft(localStorage, candidate.key);
        const availableCandidates = candidates
          .filter((candidate) => {
            const classification = classifyCanvasRecoveryDraft(
              candidate.draft,
              remoteCanvas.version,
              remoteCanvas.snapshot
            );
            if (mayEdit && classification !== "already_saved") return true;
            if (candidate.storage === "local" && localStorage)
              clearDurableCanvasRecoveryDraft(localStorage, candidate.key);
            return false;
          })
          // oxlint-disable-next-line unicorn/no-array-sort -- filter already returns a new array.
          .sort((left, right) => right.draft.saved_at.localeCompare(left.draft.saved_at));
        if (!mayEdit && sessionStorage) clearCanvasRecoveryDraft(sessionStorage, recoveryScope);
        setRecoveryCandidates(availableCandidates);
        const selectedCandidate = availableCandidates[0];
        setSelectedRecoveryKey(selectedCandidate?.key);
        setRecoveryDraft(selectedCandidate?.draft);
        const recovery = selectedCandidate
          ? classifyCanvasRecoveryDraft(selectedCandidate.draft, remoteCanvas.version, remoteCanvas.snapshot)
          : undefined;
        const needsRecoveryChoice = Boolean(selectedCandidate);
        if (needsRecoveryChoice) setRecoveryMode(recovery === "restore" ? "restore" : "export_only");
        blockedRef.current = !mayEdit || needsRecoveryChoice;
        editableRef.current = mayEdit && !needsRecoveryChoice;
        setEffectiveCanEdit(mayEdit && !needsRecoveryChoice);
        editor.updateInstanceState({ isReadonly: !mayEdit || needsRecoveryChoice });
        setSyncStatus(needsRecoveryChoice ? (recovery === "restore" ? "error" : "conflict") : "saved");
        if (mayEdit) {
          stopListening = editor.store.listen(scheduleSave, { scope: "document", source: "user" });
        }
        initializedRef.current = true;
        setInitializationTick((current) => current + 1);
      } catch (error) {
        if (!active) return;
        if (error instanceof PpmCanvasServiceError && (error.status === 403 || error.status === 404))
          purgeRecoveryDrafts();
        setSyncStatus("error");
      }
    };
    void initialize();

    return () => {
      active = false;
      initializedRef.current = false;
      stopListening?.();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      resetSaveRetry();
      if (dirtyRef.current || pendingSaveRef.current) persistRecoveryDraft();
      if (dirtyRef.current || pendingSaveRef.current) void flushSave();
      mergeGenerationRef.current += 1;
      editableRef.current = false;
      if (editorRef.current === editor) editorRef.current = undefined;
    };
  }, [
    boardId,
    canEdit,
    clearRecoveryDraft,
    editor,
    flushSave,
    persistRecoveryDraft,
    projectId,
    purgeRecoveryDrafts,
    recoveryScope,
    resetSaveRetry,
    scheduleSave,
    service,
    workspaceId,
  ]);

  useEffect(() => {
    const preserveDraft = () => {
      if (dirtyRef.current || pendingSaveRef.current) {
        if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
        persistRecoveryDraft();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") preserveDraft();
    };
    window.addEventListener("pagehide", preserveDraft);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", preserveDraft);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [persistRecoveryDraft]);

  useEffect(() => {
    const change = presence?.boardChange?.board_id === boardId ? presence.boardChange : undefined;
    const knownVersion = Math.max(
      change?.version ?? 0,
      presence?.boardVersion?.board_id === boardId ? presence.boardVersion.version : 0
    );
    if (
      !editor ||
      !initializedRef.current ||
      presence?.status !== "online" ||
      knownVersion === 0 ||
      remoteConflictRef.current
    )
      return;
    if (recoveryDraft) {
      if (knownVersion > recoveryDraft.base_version) {
        setRecoveryMode("export_only");
        setSyncStatus("conflict");
      }
      return;
    }
    const action = resolveBoardChangeAction({
      change: {
        client_operation_id: change?.version === knownVersion ? change.client_operation_id : "",
        version: knownVersion,
      },
      currentVersion: versionRef.current,
      hasLocalChanges: dirtyRef.current || Boolean(pendingSaveRef.current) || savingRef.current,
      pendingOperationId: pendingSaveRef.current?.client_operation_id,
    });
    if (action === "ignore") return;

    if (action === "conflict") {
      resetSaveRetry();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      persistRecoveryDraft();
      conflictBindingChangesRef.current =
        Boolean(pendingSaveRef.current?.binding_changes.activate.length) ||
        Boolean(pendingSaveRef.current?.binding_changes.remove.length) ||
        queuedBindingActivationsRef.current.size > 0 ||
        queuedBindingRemovalsRef.current.size > 0;
      const pendingBindingIds = [...queuedBindingActivationsRef.current];
      pendingSaveRef.current = undefined;
      queuedBindingActivationsRef.current.clear();
      queuedBindingRemovalsRef.current.clear();
      dirtyRef.current = false;
      blockedRef.current = true;
      remoteConflictRef.current = true;
      editableRef.current = false;
      editor.updateInstanceState({ isReadonly: true });
      setEffectiveCanEdit(false);
      setSyncStatus("conflict");
      void Promise.all(
        pendingBindingIds.map((bindingId) =>
          service.cancelPendingBinding(workspaceId, projectId, boardId, bindingId).catch(() => undefined)
        )
      );
      return;
    }

    let active = true;
    blockedRef.current = true;
    editableRef.current = false;
    editor.updateInstanceState({ isReadonly: true });
    setEffectiveCanEdit(false);
    setSyncStatus("loading");

    const refreshFromServer = async () => {
      try {
        const remoteCanvas = await service.getBoard(workspaceId, projectId, boardId);
        if (!active) return;
        if (remoteCanvas.version < knownVersion || remoteCanvas.version < versionRef.current) {
          setSyncStatus("error");
          return;
        }
        versionRef.current = remoteCanvas.version;
        setSavedAt(remoteCanvas.saved_at);
        baselineSnapshotRef.current = remoteCanvas.snapshot;
        if (remoteCanvas.snapshot_status === "corrupt") {
          setSyncStatus("corrupt");
          return;
        }
        applyingRemoteRef.current = true;
        try {
          if (remoteCanvas.snapshot_status === "ready" && remoteCanvas.snapshot) {
            editor.loadSnapshot(remoteCanvas.snapshot as unknown as Partial<TLEditorSnapshot>);
          }
          editor.clearHistory();
        } finally {
          applyingRemoteRef.current = false;
        }
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        dirtyRef.current = false;
        setBindingsByShapeId(new Map(remoteCanvas.bindings.map((binding) => [binding.shape_id, binding])));
        setWorkItemOptions(remoteCanvas.work_item_options);
        setProjectionErrors(new Map());
        const edgeResponse = await service
          .getSemanticEdges(workspaceId, projectId, boardId)
          .catch(() => ({ semantic_edges: [] }));
        if (!active) return;
        semanticEdgesRequestRef.current += 1;
        setSemanticEdges(edgeResponse.semantic_edges);
        const mayEdit = canEdit && remoteCanvas.access === "edit";
        blockedRef.current = !mayEdit;
        editableRef.current = mayEdit;
        setEffectiveCanEdit(mayEdit);
        editor.updateInstanceState({ isReadonly: !mayEdit });
        setSyncStatus("saved");
      } catch {
        if (!active) return;
        applyingRemoteRef.current = false;
        setSyncStatus("error");
      }
    };
    void refreshFromServer();

    return () => {
      active = false;
    };
  }, [
    boardId,
    canEdit,
    editor,
    initializationTick,
    presence?.boardChange,
    presence?.boardVersion,
    presence?.status,
    projectId,
    recoveryDraft,
    persistRecoveryDraft,
    resetSaveRetry,
    service,
    workspaceId,
  ]);

  useEffect(() => {
    // A failed offline save retains its original operation ID and snapshot.
    // A reconnect allows an immediate attempt in addition to bounded timer
    // retries, without creating a new operation ID.
    if (presence?.status !== "online" || !pendingSaveRef.current || remoteConflictRef.current) return;
    void flushSave();
  }, [flushSave, presence?.status]);

  useEffect(() => {
    const onOnline = () => {
      if (!initializedRef.current || !pendingSaveRef.current || remoteConflictRef.current) return;
      void flushSave();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushSave]);

  useEffect(() => {
    onSyncStatusChange?.(boardId, syncStatus);
  }, [boardId, onSyncStatusChange, syncStatus]);

  useEffect(() => {
    onSavedAtChange?.(boardId, savedAt);
  }, [boardId, onSavedAtChange, savedAt]);

  useEffect(() => {
    // Semantic edges have no realtime channel: refresh them when the user comes back, active board only.
    if (!grammarV2) return;
    const onFocus = () => {
      // Not while «Смысловые связи» is open: a new list rebuilds the overlay and would drop a half-filled form.
      if (semanticPanelOpenRef.current) return;
      const container = editorRef.current?.getContainer();
      if (!initializedRef.current || !container?.closest(".ppm-canvas-workspace__editor[data-active]")) return;
      const request = ++semanticEdgesRequestRef.current;
      void service.getSemanticEdges(workspaceId, projectId, boardId).then(
        (response) =>
          setSemanticEdges((current) =>
            // Stale when a later refresh, a local create/review/delete or a reload already wrote a newer list.
            request !== semanticEdgesRequestRef.current || sameSemanticEdges(current, response.semantic_edges)
              ? current
              : response.semantic_edges
          ),
        () => undefined
      );
    };
    window.addEventListener("focus", onFocus);
    return () => {
      semanticEdgesRequestRef.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [boardId, grammarV2, projectId, service, workspaceId]);

  useEffect(() => {
    onEditabilityChange?.(boardId, effectiveCanEdit);
    return () => onEditabilityChange?.(boardId, false);
  }, [boardId, effectiveCanEdit, onEditabilityChange]);

  useEffect(() => {
    if (!editor || !effectiveCanEdit || syncStatus !== "saved") return;
    const parameters = new URLSearchParams(window.location.search);
    const entryId = parameters.get("ppm_vault_entry");
    const title = parameters.get("ppm_vault_title");
    const extension = parameters.get("ppm_vault_extension");
    const sourceVersion = parameters.get("ppm_vault_version");
    const sourceUrl = parameters.get("ppm_vault_url");
    if (!entryId || !title || !extension || !sourceVersion || !sourceUrl) return;
    const projectionKey = `${boardId}:${entryId}:${sourceVersion}`;
    if (processedVaultProjectionRef.current === projectionKey) return;

    const addProjection = async () => {
      const shapeId = createShapeId();
      try {
        const binding = await service.bindContent(workspaceId, projectId, boardId, {
          shape_id: shapeId,
          entity_type: "vault_file",
          entity_id: entryId,
          client_operation_id: crypto.randomUUID(),
        });
        await createContentProjectionShape(binding);
        processedVaultProjectionRef.current = projectionKey;
        for (const key of [
          "ppm_vault_entry",
          "ppm_vault_title",
          "ppm_vault_extension",
          "ppm_vault_version",
          "ppm_vault_url",
        ])
          parameters.delete(key);
        const query = parameters.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      } catch {
        setFileDropError(ppmT("canvas.source_action_error"));
      }
    };
    void addProjection();
  }, [
    boardId,
    createContentProjectionShape,
    editor,
    effectiveCanEdit,
    ppmT,
    projectId,
    service,
    syncStatus,
    workspaceId,
  ]);

  useEffect(() => {
    if (!editor || !effectiveCanEdit || syncStatus !== "saved") return;
    const parameters = new URLSearchParams(window.location.search);
    const sourceId = parameters.get("ppm_git_id");
    const objectType = parameters.get("ppm_git_type");
    if (!sourceId || !objectType) return;
    if (!PPM_CANVAS_GIT_OBJECT_TYPES.some((value) => value === objectType)) return;
    const projectionKey = `${boardId}:${sourceId}:${objectType}`;
    if (processedGitProjectionRef.current === projectionKey) return;

    const addProjection = async () => {
      const shapeId = createShapeId();
      try {
        const binding = await service.bindGit(workspaceId, projectId, boardId, {
          shape_id: shapeId,
          entity_type: objectType as TPpmCanvasGitRefNode["object_type"],
          entity_id: sourceId,
          client_operation_id: crypto.randomUUID(),
        });
        await createGitProjectionShape(binding);
        processedGitProjectionRef.current = projectionKey;
        for (const key of [
          "ppm_git_id",
          "ppm_git_title",
          "ppm_git_provider",
          "ppm_git_repository",
          "ppm_git_type",
          "ppm_git_url",
          "ppm_git_work_item",
        ])
          parameters.delete(key);
        const query = parameters.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      } catch {
        setFileDropError(ppmT("canvas.source_action_error"));
      }
    };
    void addProjection();
  }, [boardId, createGitProjectionShape, editor, effectiveCanEdit, ppmT, projectId, service, syncStatus, workspaceId]);

  useEffect(() => {
    if (!editor) return;
    return editor.sideEffects.registerBeforeDeleteHandler("shape", (shape) => {
      if (shape.type !== PPM_CANVAS_SHAPE_TYPE) return;
      const parsed = parseSerializedPpmCanvasNode((shape as TPpmCanvasShape).props.node);
      if (
        (parsed.status === "valid" || parsed.status === "migrated") &&
        "binding" in parsed.node &&
        parsed.node.binding &&
        !approvedProjectionDeletesRef.current.delete(shape.id)
      )
        return false;
    });
  }, [editor]);

  const refreshWorkItems = useCallback(async () => {
    setIsRefreshingWorkItems(true);
    try {
      const response = await service.getBindings(workspaceId, projectId, boardId);
      setBindingsByShapeId(new Map(response.bindings.map((binding) => [binding.shape_id, binding])));
      setWorkItemOptions(response.work_item_options);
      setProjectionErrors(new Map());
    } catch {
      // A transient refresh failure must not replace the last known live projection data.
    } finally {
      setIsRefreshingWorkItems(false);
    }
  }, [boardId, projectId, service, workspaceId]);

  useEffect(() => {
    if (!editor) return;
    const interval = window.setInterval(() => void refreshWorkItems(), 30_000);
    const onFocus = () => void refreshWorkItems();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [editor, refreshWorkItems]);

  const putProjectionError = useCallback((shapeId: string, message?: string) => {
    setProjectionErrors((current) => {
      const next = new Map(current);
      if (message) next.set(shapeId, message);
      else next.delete(shapeId);
      return next;
    });
  }, []);

  const replaceVaultFile = useCallback(
    async (shape: TPpmCanvasShape, binding: TPpmCanvasContentBinding, file: File) => {
      if (binding.entity_type !== "vault_file" || !binding.source_version) return;
      const baseVersion = Number(binding.source_version);
      if (!Number.isInteger(baseVersion) || baseVersion < 1) return;
      setPendingWorkItemIds((current) => new Set(current).add(binding.entity_id));
      putProjectionError(shape.id);
      try {
        const entry = await vaultService.replaceFile(workspaceId, projectId, binding.entity_id, baseVersion, file);
        const activeEditor = editorRef.current;
        const currentShape = activeEditor?.getShape<TPpmCanvasShape>(shape.id);
        if (activeEditor && currentShape) {
          const parsed = parseSerializedPpmCanvasNode(currentShape.props.node);
          if (
            (parsed.status === "valid" || parsed.status === "migrated") &&
            (parsed.node.kind === "pdf" || parsed.node.kind === "image" || parsed.node.kind === "reference")
          ) {
            activeEditor.updateShape<TPpmCanvasShape>({
              id: currentShape.id,
              type: PPM_CANVAS_SHAPE_TYPE,
              props: {
                node: serializePpmCanvasNode({
                  ...parsed.node,
                  binding: {
                    binding_id: binding.binding_id,
                    entity_id: binding.entity_id,
                    entity_type: binding.entity_type,
                    source_version: String(entry.version),
                  },
                  updated_at: new Date().toISOString(),
                }),
              },
            });
          }
        }
        await refreshWorkItems();
        scheduleSaveRef.current();
      } catch (error) {
        putProjectionError(shape.id, error instanceof Error ? error.message : ppmT("canvas.file_replace_error"));
      } finally {
        setPendingWorkItemIds((current) => {
          const next = new Set(current);
          next.delete(binding.entity_id);
          return next;
        });
      }
    },
    [ppmT, projectId, putProjectionError, refreshWorkItems, vaultService, workspaceId]
  );

  const updateWorkItemSource = useCallback(
    async (source: TPpmWorkItemProjection, patch: Omit<TPpmWorkItemPatchRequest, "source_version">) => {
      if (!source.source_version) throw new Error("Work item source version is missing.");
      const entityId = source.identity.entity_id;
      setPendingWorkItemIds((current) => new Set(current).add(entityId));
      try {
        const updated = await service.updateWorkItem(workspaceId, projectId, entityId, {
          ...patch,
          source_version: source.source_version,
        });
        setBindingsByShapeId(
          (current) =>
            new Map(
              [...current].map(([currentShapeId, currentBinding]) => [
                currentShapeId,
                currentBinding.entity_type === "work_item" && currentBinding.entity_id === entityId
                  ? { ...currentBinding, source_version: updated.source_version, source: updated }
                  : currentBinding,
              ])
            )
        );
        return updated;
      } finally {
        setPendingWorkItemIds((current) => {
          const next = new Set(current);
          next.delete(entityId);
          return next;
        });
      }
    },
    [projectId, service, workspaceId]
  );

  const updateWorkItemProjection = useCallback(
    async (
      shapeId: string,
      binding: TPpmCanvasWorkItemBinding,
      patch: Omit<TPpmWorkItemPatchRequest, "source_version">
    ) => {
      putProjectionError(shapeId);
      try {
        await updateWorkItemSource(binding.source, patch);
      } catch (error) {
        putProjectionError(
          shapeId,
          error instanceof PpmCanvasServiceError && error.status === 409
            ? ppmT("canvas.work_item_stale")
            : ppmT("canvas.work_item_update_error")
        );
        if (error instanceof PpmCanvasServiceError && error.status === 409) void refreshWorkItems();
      }
    },
    [ppmT, putProjectionError, refreshWorkItems, updateWorkItemSource]
  );

  const removeProjection = useCallback(
    async (shape: TPpmCanvasShape, binding: TPpmCanvasBinding | TPpmCanvasContentBinding) => {
      putProjectionError(shape.id);
      const activeEditor = editorRef.current;
      if (!activeEditor) return;
      const cancelBeforeActivation = queuedBindingActivationsRef.current.delete(binding.binding_id);
      setPendingWorkItemIds((current) => new Set(current).add(binding.entity_id));
      try {
        if (cancelBeforeActivation) {
          await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id);
        } else {
          queuedBindingRemovalsRef.current.add(binding.binding_id);
        }
        approvedProjectionDeletesRef.current.add(shape.id);
        activeEditor.deleteShape(shape.id);
        if (activeEditor.getShape(shape.id)) {
          queuedBindingRemovalsRef.current.delete(binding.binding_id);
          putProjectionError(shape.id, ppmT("canvas.remove_projection_error"));
          return;
        }
        setBindingsByShapeId((current) => {
          const next = new Map(current);
          next.delete(shape.id);
          return next;
        });
        scheduleSaveRef.current();
      } catch {
        if (cancelBeforeActivation) queuedBindingActivationsRef.current.add(binding.binding_id);
        putProjectionError(shape.id, ppmT("canvas.remove_projection_error"));
      } finally {
        setPendingWorkItemIds((current) => {
          const next = new Set(current);
          next.delete(binding.entity_id);
          return next;
        });
      }
    },
    [boardId, ppmT, projectId, putProjectionError, service, workspaceId]
  );

  const createProjectionShape = useCallback(
    async (binding: TPpmCanvasWorkItemBinding) => {
      const activeEditor = editorRef.current;
      if (!activeEditor) {
        await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id).catch(() => undefined);
        throw new Error("Canvas editor is not available.");
      }
      const node = createPpmWorkItemRefNode({
        authorId,
        binding: {
          binding_id: binding.binding_id,
          entity_id: binding.entity_id,
          entity_type: "work_item",
          source_version: binding.source_version,
        },
      });
      const id = binding.shape_id as TLShapeId;
      const position = findFreeNodePosition(activeEditor, node.visual.width, node.visual.height);
      queuedBindingActivationsRef.current.add(binding.binding_id);
      try {
        activeEditor.createShape<TPpmCanvasShape>({
          id,
          type: PPM_CANVAS_SHAPE_TYPE,
          x: position.x,
          y: position.y,
          props: { h: node.visual.height, node: serializePpmCanvasNode(node), w: node.visual.width },
        });
        setBindingsByShapeId((current) => new Map(current).set(binding.shape_id, binding));
        activeEditor.select(id).setCurrentTool("select");
        if (!position.inViewport)
          activeEditor.zoomToBounds(
            Box.Common([
              activeEditor.getViewportPageBounds(),
              new Box(position.x, position.y, node.visual.width, node.visual.height),
            ]),
            { immediate: true, targetZoom: 1 }
          );
        scheduleSaveRef.current();
      } catch (error) {
        queuedBindingActivationsRef.current.delete(binding.binding_id);
        await service.cancelPendingBinding(workspaceId, projectId, boardId, binding.binding_id).catch(() => undefined);
        throw error;
      }
    },
    [authorId, boardId, projectId, service, workspaceId]
  );

  const bindWorkItem = useCallback(
    async (source: TPpmWorkItemProjection) => {
      const shapeId = createShapeId();
      const binding = await service.bindWorkItem(workspaceId, projectId, boardId, {
        shape_id: shapeId,
        entity_type: "work_item",
        entity_id: source.identity.entity_id,
        client_operation_id: crypto.randomUUID(),
      });
      await createProjectionShape(binding);
    },
    [boardId, createProjectionShape, projectId, service, workspaceId]
  );

  const createWorkItem = useCallback(
    async (name: string) => {
      const shapeId = createShapeId();
      const binding = await service.createWorkItem(workspaceId, projectId, boardId, {
        name,
        shape_id: shapeId,
        client_operation_id: crypto.randomUUID(),
      });
      await createProjectionShape(binding);
    },
    [boardId, createProjectionShape, projectId, service, workspaceId]
  );

  const searchWorkItems = useCallback(
    (query: string, cursor?: string) => service.searchWorkItems(workspaceId, projectId, query, cursor),
    [projectId, service, workspaceId]
  );

  const loadWorkItemsView = useCallback(
    (query: TPpmWorkItemsViewQuery): Promise<TPpmWorkItemsViewResponse> =>
      service.getWorkItemsView(workspaceId, projectId, boardId, query),
    [boardId, projectId, service, workspaceId]
  );

  const createWorkItemFromView = useCallback(
    (request: TPpmWorkItemViewCreateRequest) =>
      service.createWorkItemFromView(workspaceId, projectId, boardId, request),
    [boardId, projectId, service, workspaceId]
  );

  const exportWorkItemsView = useCallback(
    async (format: "csv" | "markdown", query: TPpmWorkItemsViewQuery) => {
      const result = await service.exportWorkItemsView(workspaceId, projectId, boardId, format, query);
      const url = URL.createObjectURL(result.blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [boardId, projectId, service, workspaceId]
  );

  const copyLocalSnapshot = useCallback(async () => {
    const activeEditor = editorRef.current;
    if (!activeEditor) return;
    const { document } = activeEditor.getSnapshot();
    try {
      await navigator.clipboard.writeText(JSON.stringify({ document }));
      setCopiedLocal(true);
    } catch {
      setSyncStatus("error");
    }
  }, []);

  const readMergeBase = useCallback(async (): Promise<TPpmCanvasSnapshot | null> => {
    if (!recoveryDraft) return baselineSnapshotRef.current;
    if (
      recoveryDraft.base_version === 0 ||
      recoveryDraft.binding_changes.activate.length > 0 ||
      recoveryDraft.binding_changes.remove.length > 0
    )
      return null;
    const version = await service.getBoardVersion(workspaceId, projectId, boardId, recoveryDraft.base_version);
    if (version.board_id !== boardId || version.version !== recoveryDraft.base_version) return null;
    return version.snapshot;
  }, [boardId, projectId, recoveryDraft, service, workspaceId]);

  const previewDisjointMerge = useCallback(async () => {
    const activeEditor = editorRef.current;
    if (!activeEditor || mergeBusyRef.current || (!remoteConflictRef.current && !recoveryDraft)) return;
    mergeBusyRef.current = true;
    const generation = mergeGenerationRef.current;
    setMergeBusy(true);
    setMergePreview(undefined);
    setMergeUnavailable(false);
    try {
      const remote = await service.getBoard(workspaceId, projectId, boardId);
      if (generation !== mergeGenerationRef.current || editorRef.current !== activeEditor) return;
      const base = await readMergeBase();
      if (generation !== mergeGenerationRef.current || editorRef.current !== activeEditor) return;
      const merge =
        base &&
        (recoveryDraft || !conflictBindingChangesRef.current) &&
        !pendingSaveRef.current &&
        queuedBindingActivationsRef.current.size === 0 &&
        queuedBindingRemovalsRef.current.size === 0 &&
        canEdit &&
        remote.access === "edit" &&
        remote.snapshot_status === "ready" &&
        remote.snapshot
          ? mergeDisjointCanvasSnapshots(
              base,
              recoveryDraft?.snapshot ?? { document: activeEditor.getSnapshot().document },
              remote.snapshot
            )
          : undefined;
      const bytes = merge ? new TextEncoder().encode(JSON.stringify(merge.snapshot)).length : 0;
      if (!merge || bytes > MAX_CANVAS_IMPORT_SNAPSHOT_BYTES) {
        setMergeUnavailable(true);
        return;
      }
      setMergePreview({
        contentHash: remote.content_hash,
        localChanges: merge.localChanges,
        remoteChanges: merge.remoteChanges,
        remoteVersion: remote.version,
      });
    } catch {
      if (generation === mergeGenerationRef.current) setMergeUnavailable(true);
    } finally {
      if (generation === mergeGenerationRef.current) {
        mergeBusyRef.current = false;
        setMergeBusy(false);
      }
    }
  }, [boardId, canEdit, projectId, readMergeBase, recoveryDraft, service, workspaceId]);

  const confirmDisjointMerge = useCallback(async () => {
    const activeEditor = editorRef.current;
    if (!activeEditor || !mergePreview || mergeBusyRef.current || (!remoteConflictRef.current && !recoveryDraft))
      return;
    mergeBusyRef.current = true;
    const generation = mergeGenerationRef.current;
    setMergeBusy(true);
    setMergeUnavailable(false);
    try {
      const remote = await service.getBoard(workspaceId, projectId, boardId);
      if (generation !== mergeGenerationRef.current || editorRef.current !== activeEditor) return;
      if (
        !canEdit ||
        remote.access !== "edit" ||
        remote.snapshot_status !== "ready" ||
        !remote.snapshot ||
        remote.version !== mergePreview.remoteVersion ||
        remote.content_hash !== mergePreview.contentHash ||
        (!recoveryDraft && conflictBindingChangesRef.current) ||
        pendingSaveRef.current
      ) {
        setMergePreview(undefined);
        setMergeUnavailable(true);
        return;
      }
      const base = await readMergeBase();
      if (generation !== mergeGenerationRef.current || editorRef.current !== activeEditor) return;
      const merge = base
        ? mergeDisjointCanvasSnapshots(
            base,
            recoveryDraft?.snapshot ?? { document: activeEditor.getSnapshot().document },
            remote.snapshot
          )
        : undefined;
      if (
        !merge ||
        new TextEncoder().encode(JSON.stringify(merge.snapshot)).length > MAX_CANVAS_IMPORT_SNAPSHOT_BYTES
      ) {
        setMergePreview(undefined);
        setMergeUnavailable(true);
        return;
      }
      const response = await service.saveBoard(workspaceId, projectId, boardId, {
        base_version: remote.version,
        binding_changes: { activate: [], remove: [] },
        client_operation_id: crypto.randomUUID(),
        schema_version: PPM_CANVAS_SCHEMA_VERSION,
        snapshot: merge.snapshot,
      });
      if (generation !== mergeGenerationRef.current || editorRef.current !== activeEditor) return;
      versionRef.current = response.version;
      setSavedAt(response.saved_at);
      baselineSnapshotRef.current = merge.snapshot;
      clearRecoveryDraft();
      setRecoveryDraft(undefined);
      applyingRemoteRef.current = true;
      try {
        activeEditor.loadSnapshot(merge.snapshot as Partial<TLEditorSnapshot>);
        activeEditor.clearHistory();
      } catch {
        window.location.reload();
        return;
      } finally {
        applyingRemoteRef.current = false;
      }
      setBindingsByShapeId(new Map(remote.bindings.map((binding) => [binding.shape_id, binding])));
      setWorkItemOptions(remote.work_item_options);
      dirtyRef.current = false;
      remoteConflictRef.current = false;
      conflictBindingChangesRef.current = false;
      blockedRef.current = false;
      editableRef.current = true;
      activeEditor.updateInstanceState({ isReadonly: false });
      setEffectiveCanEdit(true);
      setMergePreview(undefined);
      setSyncStatus("saved");
    } catch {
      if (generation === mergeGenerationRef.current) {
        setMergePreview(undefined);
        setMergeUnavailable(true);
        setSyncStatus("conflict");
      }
    } finally {
      if (generation === mergeGenerationRef.current) {
        mergeBusyRef.current = false;
        setMergeBusy(false);
      }
    }
  }, [
    boardId,
    canEdit,
    clearRecoveryDraft,
    mergePreview,
    projectId,
    readMergeBase,
    recoveryDraft,
    service,
    workspaceId,
  ]);

  const exportBoard = useCallback(() => {
    const activeEditor = editorRef.current;
    if (!activeEditor) return;
    const { document } = activeEditor.getSnapshot();
    downloadCanvasSnapshot(boardId, { document });
  }, [boardId]);

  const downloadRecoveryDraft = useCallback(() => {
    if (recoveryDraft) downloadCanvasJson(`ppm-recovery-${boardId}.json`, serializeCanvasRecoveryDraft(recoveryDraft));
  }, [boardId, recoveryDraft]);

  const selectRecoveryDraft = useCallback(
    (key: string) => {
      const candidate = recoveryCandidates.find((item) => item.key === key);
      if (!candidate) return;
      setSelectedRecoveryKey(key);
      setRecoveryDraft(candidate.draft);
      const mode = classifyCanvasRecoveryDraft(candidate.draft, versionRef.current, baselineSnapshotRef.current);
      setRecoveryMode(mode === "restore" ? "restore" : "export_only");
      setSyncStatus(mode === "restore" ? "error" : "conflict");
    },
    [recoveryCandidates]
  );

  const discardRecoveryDraft = useCallback(() => {
    const candidate = recoveryCandidates.find((item) => item.key === selectedRecoveryKey);
    if (candidate?.storage === "local") {
      const storage = getCanvasLocalStorage();
      if (storage) clearDurableCanvasRecoveryDraft(storage, candidate.key);
    } else if (candidate?.storage === "session") {
      const storage = getCanvasSessionStorage();
      if (storage) clearCanvasRecoveryDraft(storage, recoveryScope);
    }
    window.location.reload();
  }, [recoveryCandidates, recoveryScope, selectedRecoveryKey]);

  const restoreRecoveryDraft = useCallback(async () => {
    const activeEditor = editorRef.current;
    if (!activeEditor || !recoveryDraft || (recoveryMode !== "restore" && !recoveryDraft.pending_operation)) return;
    setSyncStatus("loading");
    try {
      let current = await service.getBoard(workspaceId, projectId, boardId);
      if (current.access !== "edit" || !canEdit) {
        purgeRecoveryDrafts();
        setRecoveryDraft(undefined);
        window.location.reload();
        return;
      }
      const pending = recoveryDraft.pending_operation;
      let pendingWasSaved = false;
      if (current.version > recoveryDraft.base_version && pending?.base_version === recoveryDraft.base_version) {
        try {
          // With a newer server version this exact request can only replay an
          // already committed operation. A different team's version gets 409.
          const replay = await service.saveBoard(workspaceId, projectId, boardId, {
            ...pending,
            schema_version: PPM_CANVAS_SCHEMA_VERSION,
          });
          if (!replay.idempotent_replay) throw new Error("Unexpected new save during recovery replay.");
          current = await service.getBoard(workspaceId, projectId, boardId);
          pendingWasSaved =
            current.version === replay.version &&
            current.snapshot_status === "ready" &&
            current.snapshot !== null &&
            sameCanvasSnapshots(current.snapshot, pending.snapshot);
        } catch {
          // The pending operation was not committed, or a newer team save won.
          // Keep the local draft available for export/explicit safe merge.
        }
      }
      if (
        current.snapshot_status === "corrupt" ||
        (current.version !== recoveryDraft.base_version && !pendingWasSaved)
      ) {
        setRecoveryMode("export_only");
        setSyncStatus("conflict");
        return;
      }
      const previous = activeEditor.getSnapshot();
      try {
        applyingRemoteRef.current = true;
        activeEditor.loadSnapshot(recoveryDraft.snapshot as Partial<TLEditorSnapshot>);
        activeEditor.clearHistory();
      } catch {
        activeEditor.loadSnapshot(previous as Partial<TLEditorSnapshot>);
        setRecoveryMode("export_only");
        setSyncStatus("error");
        return;
      } finally {
        applyingRemoteRef.current = false;
      }
      versionRef.current = current.version;
      setSavedAt(current.saved_at);
      baselineSnapshotRef.current = current.snapshot;
      const candidate = recoveryCandidates.find((item) => item.key === selectedRecoveryKey);
      adoptedRecoveryKeyRef.current = candidate?.storage === "local" ? candidate.key : undefined;
      if (pending && !pendingWasSaved && pending.base_version === current.version) {
        pendingSaveRef.current = pending;
      }
      queuedBindingActivationsRef.current = new Set(
        recoveryDraft.binding_changes.activate.filter((id) => !pending?.binding_changes.activate.includes(id))
      );
      queuedBindingRemovalsRef.current = new Set(
        recoveryDraft.binding_changes.remove.filter((id) => !pending?.binding_changes.remove.includes(id))
      );
      setRecoveryDraft(undefined);
      setRecoveryCandidates([]);
      setSelectedRecoveryKey(undefined);
      blockedRef.current = false;
      editableRef.current = true;
      activeEditor.updateInstanceState({ isReadonly: false });
      setEffectiveCanEdit(true);
      scheduleSaveRef.current();
    } catch {
      setSyncStatus("error");
    }
  }, [
    boardId,
    canEdit,
    projectId,
    purgeRecoveryDrafts,
    recoveryCandidates,
    recoveryDraft,
    recoveryMode,
    selectedRecoveryKey,
    service,
    workspaceId,
  ]);

  const importBoard = useCallback(
    async (file: File) => {
      const activeEditor = editorRef.current;
      if (!activeEditor || !editableRef.current) return;
      try {
        const raw = await file.text();
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "format" in parsed &&
          parsed.format === "ppm-canvas-board"
        ) {
          const previous = activeEditor.getSnapshot();
          try {
            const payload = parsePpmCanvasBoardExport(parsed);
            activeEditor.loadSnapshot({ document: payload.document } as Partial<TLEditorSnapshot>);
            scheduleSaveRef.current();
          } catch {
            activeEditor.loadSnapshot(previous as Partial<TLEditorSnapshot>);
            throw new Error("PPM board import failed.");
          }
          setDesktopImport(undefined);
          setDesktopImportCount(undefined);
          setDesktopImportReport(undefined);
          setImportError(false);
          return;
        }
        const plan = prepareDesktopFlowImport(raw, authorId);
        setDesktopImport({ boardId, filename: file.name, plan });
        setDesktopImportCount(undefined);
        setDesktopImportReport(undefined);
        setImportError(false);
      } catch {
        setDesktopImport(undefined);
        setDesktopImportCount(undefined);
        setImportError(true);
        // Import outcomes live inside "Board": reveal them on every attempt, including a repeated failure.
        setBoardInfoOpen(true);
      }
    },
    [authorId, boardId]
  );

  const confirmDesktopImport = useCallback(() => {
    const activeEditor = editorRef.current;
    if (!activeEditor || !desktopImport || desktopImport.boardId !== boardId || !editableRef.current) return;
    const previous = activeEditor.getSnapshot();
    try {
      applyingRemoteRef.current = true;
      const importedShapeIds = new Map<string, TLShapeId>();
      const importedContainerIds = new Map<string, TLShapeId>();
      const importedFrameIds: TLShapeId[] = [];
      const pageId = activeEditor.getCurrentPageId();
      for (const group of desktopImport.plan.groups) {
        const id = createShapeId();
        activeEditor.createShape<TLGroupShape>({
          id,
          meta: { ppmDesktopSourceId: group.sourceId },
          parentId: pageId,
          type: "group",
          props: {},
          rotation: group.rotation,
          x: group.x,
          y: group.y,
        });
        importedShapeIds.set(group.sourceId, id);
        importedContainerIds.set(group.sourceId, id);
      }
      for (const item of desktopImport.plan.shapes) {
        const id = createShapeId();
        activeEditor.createShape<TPpmCanvasShape>({
          id,
          meta: { ppmDesktopSourceId: item.sourceId },
          parentId: pageId,
          type: PPM_CANVAS_SHAPE_TYPE,
          rotation: item.rotation,
          x: item.x,
          y: item.y,
          props: {
            h: item.node.visual.height,
            node: serializePpmCanvasNode(item.node),
            w: item.node.visual.width,
          },
        });
        importedShapeIds.set(item.sourceId, id);
        if (item.status === "converted" && (item.node.kind === "group" || item.node.kind === "frame")) {
          importedContainerIds.set(item.sourceId, id);
          importedFrameIds.push(id);
        }
      }
      const importedArrowIds: TLShapeId[] = [];
      for (const connection of desktopImport.plan.connections) {
        const fromId = importedShapeIds.get(connection.fromSourceId);
        const toId = importedShapeIds.get(connection.toSourceId);
        const fromBounds = fromId ? activeEditor.getShapePageBounds(fromId) : undefined;
        const toBounds = toId ? activeEditor.getShapePageBounds(toId) : undefined;
        if (!fromId || !toId || !fromBounds || !toBounds)
          throw new Error("Desktop arrow endpoints could not be imported.");
        const start = fromBounds.center;
        const end = toBounds.center;
        const arrowId = createShapeId();
        activeEditor.createShape<TLArrowShape>({
          id: arrowId,
          meta: { ppmDesktopSourceId: connection.sourceId },
          parentId: pageId,
          props: {
            ...connection.style,
            end: { x: end.x - start.x, y: end.y - start.y },
            start: { x: 0, y: 0 },
          },
          type: "arrow",
          x: start.x,
          y: start.y,
        });
        importedShapeIds.set(connection.sourceId, arrowId);
        activeEditor.createBindings<TLArrowBinding>([
          { fromId: arrowId, props: { terminal: "start", ...connection.fromBinding }, toId: fromId, type: "arrow" },
          { fromId: arrowId, props: { terminal: "end", ...connection.toBinding }, toId: toId, type: "arrow" },
        ]);
        importedArrowIds.push(arrowId);
      }
      for (const arrow of desktopImport.plan.freeArrows) {
        const arrowId = createShapeId();
        activeEditor.createShape<TLArrowShape>({
          id: arrowId,
          meta: { ppmDesktopSourceId: arrow.sourceId },
          parentId: pageId,
          props: { ...arrow.style, start: arrow.start, end: arrow.end },
          rotation: arrow.rotation,
          type: "arrow",
          x: arrow.x,
          y: arrow.y,
        });
        importedShapeIds.set(arrow.sourceId, arrowId);
        importedArrowIds.push(arrowId);
      }
      if (importedArrowIds.length > 0) activeEditor.sendToBack(importedArrowIds);
      if (importedFrameIds.length > 0) activeEditor.sendToBack(importedFrameIds);
      const importedChildrenByParent = new Map<TLShapeId, TLShapeId[]>();
      for (const item of [
        ...desktopImport.plan.groups,
        ...desktopImport.plan.shapes,
        ...desktopImport.plan.connections,
        ...desktopImport.plan.freeArrows,
      ]) {
        if (!item.parentSourceId) continue;
        const shapeId = importedShapeIds.get(item.sourceId);
        const parentId = importedContainerIds.get(item.parentSourceId);
        if (!shapeId || !parentId) continue;
        const siblings = importedChildrenByParent.get(parentId) ?? [];
        siblings.push(shapeId);
        importedChildrenByParent.set(parentId, siblings);
      }
      for (const [parentId, childIds] of importedChildrenByParent) activeEditor.reparentShapes(childIds, parentId);
      const snapshotBytes = new TextEncoder().encode(
        JSON.stringify({ document: activeEditor.getSnapshot().document })
      ).length;
      if (snapshotBytes > MAX_CANVAS_IMPORT_SNAPSHOT_BYTES)
        throw new Error("Imported board exceeds the server snapshot limit.");
      setDesktopImportCount(
        desktopImport.plan.groups.length +
          desktopImport.plan.shapes.length +
          desktopImport.plan.connections.length +
          desktopImport.plan.freeArrows.length
      );
      setDesktopImportReport(createDesktopImportReport(desktopImport.plan, desktopImport.filename));
      setDesktopImport(undefined);
      setImportError(false);
      setBoardInfoOpen(true);
    } catch {
      activeEditor.loadSnapshot(previous as Partial<TLEditorSnapshot>);
      setImportError(true);
      setBoardInfoOpen(true);
      return;
    } finally {
      applyingRemoteRef.current = false;
    }
    scheduleSaveRef.current();
  }, [boardId, desktopImport]);

  const downloadDesktopImportReport = useCallback(() => {
    const report = desktopImport
      ? createDesktopImportReport(desktopImport.plan, desktopImport.filename)
      : desktopImportReport;
    if (!report) return;
    downloadCanvasJson(`ppm-desktop-import-report-${boardId}.json`, JSON.stringify(report, null, 2));
  }, [boardId, desktopImport, desktopImportReport]);

  const addUploadedContent = useCallback(
    async (
      entityType: "attachment" | "vault_file",
      entityId: string,
      index: number,
      origin: { x: number; y: number }
    ) => {
      const shapeId = createShapeId();
      const binding = await service.bindContent(workspaceId, projectId, boardId, {
        shape_id: shapeId,
        entity_type: entityType,
        entity_id: entityId,
        client_operation_id: crypto.randomUUID(),
      });
      await createContentProjectionShape(binding, { x: origin.x + index * 42, y: origin.y + index * 42 });
    },
    [boardId, createContentProjectionShape, projectId, service, workspaceId]
  );

  const uploadDropToVault = useCallback(async () => {
    if (!pendingFileDrop || !editableRef.current) return;
    setFileDropUploading(true);
    setFileDropError(undefined);
    try {
      await Promise.all(
        pendingFileDrop.files.map(async (file, index) => {
          const entry = await vaultService.uploadFile(workspaceId, projectId, file);
          await addUploadedContent("vault_file", entry.id, index, pendingFileDrop.pagePoint);
        })
      );
      setPendingFileDrop(undefined);
    } catch (error) {
      setFileDropError(error instanceof Error ? error.message : ppmT("canvas.source_action_error"));
    } finally {
      setFileDropUploading(false);
    }
  }, [addUploadedContent, pendingFileDrop, ppmT, projectId, vaultService, workspaceId]);

  const uploadDropToWorkItem = useCallback(
    async (source: TPpmWorkItemProjection) => {
      if (!pendingFileDrop || !editableRef.current) return;
      setFileDropUploading(true);
      setFileDropError(undefined);
      try {
        await Promise.all(
          pendingFileDrop.files.map(async (file, index) => {
            const uploaded = await fileService.uploadProjectAsset(
              workspaceSlug,
              projectId,
              {
                entity_identifier: source.identity.entity_id,
                entity_type: EFileAssetType.ISSUE_ATTACHMENT,
              },
              file
            );
            await addUploadedContent("attachment", uploaded.asset_id, index, pendingFileDrop.pagePoint);
          })
        );
        setPlaneDropPickerOpen(false);
        setPendingFileDrop(undefined);
      } catch (error) {
        setFileDropError(error instanceof Error ? error.message : ppmT("canvas.source_action_error"));
      } finally {
        setFileDropUploading(false);
      }
    },
    [addUploadedContent, fileService, pendingFileDrop, ppmT, projectId, workspaceSlug]
  );

  const handleFileDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== "drop") return;
    if (!editableRef.current || !editorRef.current) {
      setFileDropNotice(true);
      return;
    }
    const files = [...event.dataTransfer.files].slice(0, 20);
    if (files.length === 0) return;
    setFileDropError(undefined);
    setPlaneDropPickerOpen(false);
    setPendingFileDrop({
      files,
      pagePoint: editorRef.current.screenToPage({ x: event.clientX, y: event.clientY }),
    });
  }, []);

  const createSemanticEdge = useCallback(
    async (fromShapeId: string, toShapeId: string, relationType: TPpmCanvasSemanticRelationType, label: string) => {
      const edge = await service.createSemanticEdge(workspaceId, projectId, boardId, {
        from_shape_id: fromShapeId,
        to_shape_id: toShapeId,
        relation_type: relationType,
        label: label.trim() || null,
        origin: "user",
        client_operation_id: crypto.randomUUID(),
      });
      semanticEdgesRequestRef.current += 1;
      setSemanticEdges((current) => [...current.filter((item) => item.edge_id !== edge.edge_id), edge]);
    },
    [boardId, projectId, service, workspaceId]
  );

  const deleteSemanticEdge = useCallback(
    async (edgeId: string) => {
      await service.deleteSemanticEdge(workspaceId, projectId, boardId, edgeId);
      semanticEdgesRequestRef.current += 1;
      setSemanticEdges((current) => current.filter((edge) => edge.edge_id !== edgeId));
    },
    [boardId, projectId, service, workspaceId]
  );

  const reviewSemanticEdge = useCallback(
    async (edgeId: string, confirmationStatus: "confirmed" | "rejected") => {
      const edge = await service.updateSemanticEdge(workspaceId, projectId, boardId, edgeId, {
        confirmation_status: confirmationStatus,
      });
      semanticEdgesRequestRef.current += 1;
      setSemanticEdges((current) => current.map((item) => (item.edge_id === edge.edge_id ? edge : item)));
    },
    [boardId, projectId, service, workspaceId]
  );

  const toggleBoardInfo = useCallback(() => {
    // Toggling rebuilds the overlay (components memo), so the pill remounts: return keyboard focus to it.
    boardInfoFocusRef.current = true;
    setBoardInfoOpen((open) => !open);
  }, []);

  const openSemanticPanel = useCallback(() => {
    // Focus moves into the panel once, when it opens; later overlay remounts must not steal focus from the canvas.
    // Opening an already open panel (a chip click) must not raise the flag for the next remount either.
    if (semanticPanelOpenRef.current) return;
    semanticPanelOpenRef.current = true;
    semanticPanelFocusRef.current = true;
    setSemanticPanelOpen(true);
  }, []);
  const closeSemanticPanel = useCallback(() => {
    setFocusedEdgeId(undefined);
    const focusInPanel =
      document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest(".ppm-semantic-edges"));
    semanticPanelOpenRef.current = false;
    setSemanticPanelOpen(false);
    // The panel unmounts with focus inside it: keep keyboard focus on this board's canvas, not on the page body.
    if (focusInPanel) editorRef.current?.getContainer().focus();
  }, []);
  const openSemanticEdge = useCallback(
    (edgeId: string) => {
      setFocusedEdgeId(edgeId);
      openSemanticPanel();
    },
    [openSemanticPanel]
  );
  const semanticLayerValue = useMemo(
    () => ({ edges: semanticEdges, enabled: grammarV2, onOpenEdge: openSemanticEdge }),
    [grammarV2, openSemanticEdge, semanticEdges]
  );

  const components = useMemo<TLComponents>(
    () => ({
      ...HIDDEN_TLDRAW_UI,
      ...(grammarV2 ? { OnTheCanvas: PpmSemanticEdgesLayer } : {}),
      InFrontOfTheCanvas: () => (
        <CanvasControls
          authorId={authorId}
          boardId={boardId}
          boardInfoFocusRef={boardInfoFocusRef}
          // A pending import preview lives inside "Board" and must stay reachable until confirmed or cancelled.
          boardInfoOpen={boardInfoOpen || Boolean(desktopImport)}
          canEdit={effectiveCanEdit}
          copiedLocal={copiedLocal}
          designV2={designV2}
          draftStorageUnavailable={draftStorageUnavailable}
          mergeBusy={mergeBusy}
          mergePreview={mergePreview}
          mergeUnavailable={mergeUnavailable}
          importError={importError}
          desktopImport={desktopImport}
          desktopImportCount={desktopImportCount}
          desktopImportReport={desktopImportReport}
          onBindWorkItem={bindWorkItem}
          onCopyLocal={() => void copyLocalSnapshot()}
          onPreviewMerge={() => void previewDisjointMerge()}
          onConfirmMerge={() => void confirmDisjointMerge()}
          onCreateWorkItem={createWorkItem}
          onCreateSemanticEdge={createSemanticEdge}
          onDeleteSemanticEdge={deleteSemanticEdge}
          onReviewSemanticEdge={reviewSemanticEdge}
          onOpenSemanticPanel={openSemanticPanel}
          onCloseSemanticPanel={closeSemanticPanel}
          onExport={exportBoard}
          onExportRecovery={downloadRecoveryDraft}
          onSelectRecovery={selectRecoveryDraft}
          onImport={importBoard}
          onConfirmDesktopImport={confirmDesktopImport}
          onCancelDesktopImport={() => setDesktopImport(undefined)}
          onDownloadDesktopImportReport={downloadDesktopImportReport}
          onOrchestratorRunVersionsChange={onOrchestratorRunVersionsChange}
          onReload={() => window.location.reload()}
          onDiscardRecovery={discardRecoveryDraft}
          onRestoreRecovery={() => void restoreRecoveryDraft()}
          onRetry={() => (pendingSaveRef.current ? void flushSave() : window.location.reload())}
          onSelectionChange={onSelectionChange}
          onSearchWorkItems={searchWorkItems}
          onToggleBoardInfo={toggleBoardInfo}
          onOpenTasksPanel={() => setTasksPanelOpen(true)}
          onCloseTasksPanel={() => setTasksPanelOpen(false)}
          tasksPanelOpen={tasksPanelOpen}
          onToolChange={onToolChange}
          statusPlacement={statusPlacement}
          syncStatus={syncStatus}
          semanticEdges={semanticEdges}
          semanticPanelFocusRef={semanticPanelFocusRef}
          semanticPanelOpen={semanticPanelOpen}
          recoveryMode={recoveryDraft ? recoveryMode : undefined}
          pendingRecoveryOperation={Boolean(recoveryDraft?.pending_operation)}
          recoveryCandidates={recoveryCandidates}
          selectedRecoveryKey={selectedRecoveryKey}
        />
      ),
    }),
    [
      authorId,
      boardId,
      boardInfoOpen,
      bindWorkItem,
      closeSemanticPanel,
      copiedLocal,
      copyLocalSnapshot,
      createWorkItem,
      createSemanticEdge,
      deleteSemanticEdge,
      designV2,
      discardRecoveryDraft,
      downloadRecoveryDraft,
      draftStorageUnavailable,
      grammarV2,
      mergeBusy,
      mergePreview,
      mergeUnavailable,
      effectiveCanEdit,
      exportBoard,
      flushSave,
      confirmDisjointMerge,
      importBoard,
      importError,
      desktopImport,
      desktopImportCount,
      desktopImportReport,
      confirmDesktopImport,
      downloadDesktopImportReport,
      onOrchestratorRunVersionsChange,
      onSelectionChange,
      onToolChange,
      openSemanticPanel,
      recoveryDraft,
      recoveryCandidates,
      recoveryMode,
      selectedRecoveryKey,
      previewDisjointMerge,
      restoreRecoveryDraft,
      selectRecoveryDraft,
      reviewSemanticEdge,
      searchWorkItems,
      semanticEdges,
      semanticPanelOpen,
      statusPlacement,
      syncStatus,
      toggleBoardInfo,
      tasksPanelOpen,
    ]
  );

  const projectionContext = useMemo(
    () => ({
      bindingsByShapeId,
      canEdit: effectiveCanEdit,
      errorsByShapeId: projectionErrors,
      isRefreshing: isRefreshingWorkItems,
      onRefresh: () => void refreshWorkItems(),
      onCreateFromView: createWorkItemFromView,
      onExportView: exportWorkItemsView,
      onLoadView: loadWorkItemsView,
      onRemove: (shape: TPpmCanvasShape, binding: TPpmCanvasBinding | TPpmCanvasContentBinding) =>
        void removeProjection(shape, binding),
      onReplaceVaultFile: (shape: TPpmCanvasShape, binding: TPpmCanvasContentBinding, file: File) =>
        void replaceVaultFile(shape, binding, file),
      onUpdate: (
        shapeId: string,
        binding: TPpmCanvasWorkItemBinding,
        patch: Omit<TPpmWorkItemPatchRequest, "source_version">
      ) => void updateWorkItemProjection(shapeId, binding, patch),
      onUpdateSource: updateWorkItemSource,
      onOpenTasks: () => setTasksPanelOpen(true),
      options: workItemOptions,
      pendingWorkItemIds,
    }),
    [
      bindingsByShapeId,
      createWorkItemFromView,
      effectiveCanEdit,
      isRefreshingWorkItems,
      exportWorkItemsView,
      loadWorkItemsView,
      projectionErrors,
      pendingWorkItemIds,
      refreshWorkItems,
      replaceVaultFile,
      removeProjection,
      updateWorkItemProjection,
      updateWorkItemSource,
      workItemOptions,
    ]
  );
  const boardNavigationContext = useMemo(() => ({ onOpenBoard }), [onOpenBoard]);
  // RC9: the inspector never covers the "Board" panel, the import preview or a blocking banner.
  const inspectorHidden =
    boardInfoOpen || Boolean(desktopImport) || isBlockingCanvasStatus(syncStatus, Boolean(recoveryDraft));

  return (
    <div
      className="ppm-canvas-shell"
      data-ppm-canvas-grammar={grammarV2 ? "v2" : undefined}
      data-ppm-canvas-mode={effectiveCanEdit ? "edit" : "read"}
      onDragOverCapture={handleFileDrop}
      onDropCapture={handleFileDrop}
    >
      <PpmCanvasGrammarContext.Provider value={grammarV2}>
        <PpmCanvasBoardNavigationContext.Provider value={boardNavigationContext}>
          <PpmWorkItemProjectionContext.Provider value={projectionContext}>
            <PpmSemanticEdgesContext.Provider value={semanticLayerValue}>
              <PpmSemanticEdgeFocusContext.Provider value={focusedEdgeId}>
                <Tldraw
                  cameraOptions={{ wheelBehavior: "pan" }}
                  components={components}
                  shapeUtils={[PpmCanvasNodeShapeUtil]}
                  onMount={setEditor}
                >
                  {presence && <PpmCanvasRealtimeCursors presence={presence} />}
                  {grammarV2 && onZoomChange && <PpmCanvasZoomReporter boardId={boardId} onZoomChange={onZoomChange} />}
                </Tldraw>
              </PpmSemanticEdgeFocusContext.Provider>
            </PpmSemanticEdgesContext.Provider>
          </PpmWorkItemProjectionContext.Provider>
        </PpmCanvasBoardNavigationContext.Provider>
      </PpmCanvasGrammarContext.Provider>
      {grammarV2 && editor && !inspectorHidden && (
        <PpmCanvasInspector
          bindingsByShapeId={bindingsByShapeId}
          canEdit={effectiveCanEdit}
          edges={semanticEdges}
          editor={editor}
          errorsByShapeId={projectionErrors}
          options={workItemOptions}
          pendingWorkItemIds={pendingWorkItemIds}
          onOpenLinks={openSemanticPanel}
          onUpdate={(shapeId, binding, patch) => void updateWorkItemProjection(shapeId, binding, patch)}
        />
      )}
      {fileDropNotice && (
        <div className="ppm-canvas-file-drop-notice" role="status">
          <span>{ppmT("canvas.file_drop_placeholder")}</span>
          <button type="button" aria-label={ppmT("canvas.close")} onClick={() => setFileDropNotice(false)}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}
      {pendingFileDrop && !planeDropPickerOpen && (
        <FileDropDialog
          error={fileDropError}
          files={pendingFileDrop.files}
          loading={fileDropUploading}
          onClose={() => {
            if (fileDropUploading) return;
            setPendingFileDrop(undefined);
            setPlaneDropPickerOpen(false);
          }}
          onPlane={() => setPlaneDropPickerOpen(true)}
          onVault={() => void uploadDropToVault()}
        />
      )}
      {planeDropPickerOpen && pendingFileDrop && !fileDropUploading && (
        <WorkItemPicker
          onAdd={uploadDropToWorkItem}
          onClose={() => setPlaneDropPickerOpen(false)}
          onCreate={async () => undefined}
          onSearch={searchWorkItems}
          createDisabled
          title={ppmT("canvas.file_drop_choose_work_item")}
        />
      )}
    </div>
  );
}

function PpmCanvasRealtimeCursors({ presence }: { presence: TPpmBoardPresenceController }) {
  const editor = useEditor();
  const { sendCursor } = presence;
  const remoteCursors = useValue(
    "ppm realtime cursors",
    () => {
      editor.getCamera();
      return presence.cursors.map((cursor) => ({ ...cursor, viewport: editor.pageToViewport(cursor) }));
    },
    [editor, presence.cursors]
  );

  useEffect(() => {
    const container = editor.getContainer();
    const handlePointerMove = (event: PointerEvent) => {
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      sendCursor({ pointer_down: event.buttons > 0, x: point.x, y: point.y });
    };
    container.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => container.removeEventListener("pointermove", handlePointerMove);
  }, [editor, sendCursor]);

  return (
    <div className="ppm-canvas-remote-cursors" aria-hidden="true">
      {remoteCursors.map((cursor) => {
        const { cursor: cursorColor, label: labelColor } = presenceCursorColors(cursor.user_id);
        return (
          <div
            className="ppm-canvas-remote-cursor"
            data-pointer-down={cursor.pointer_down || undefined}
            key={cursor.connection_id}
            style={
              {
                "--ppm-presence-cursor-color": cursorColor,
                "--ppm-presence-cursor-label": labelColor,
                transform: `translate3d(${cursor.viewport.x}px, ${cursor.viewport.y}px, 0)`,
              } as CSSProperties
            }
          >
            <MousePointer2 aria-hidden="true" />
            <span>{cursor.display_name}</span>
          </div>
        );
      })}
    </div>
  );
}

// UX1.1: a leaf child of <Tldraw> (never inside the InFrontOfTheCanvas memo). It re-renders only when the rounded
// zoom percent changes, so pinch and wheel zoom do not touch the workspace tree.
function PpmCanvasZoomReporter({
  boardId,
  onZoomChange,
}: {
  boardId: string;
  onZoomChange: (boardId: string, zoom: number) => void;
}) {
  const editor = useEditor();
  const zoom = useValue("ppm canvas zoom percent", () => Math.round(editor.getZoomLevel() * 100), [editor]);
  useEffect(() => {
    onZoomChange(boardId, zoom);
  }, [boardId, onZoomChange, zoom]);
  return null;
}

function CanvasControls({
  authorId,
  boardId,
  boardInfoFocusRef,
  boardInfoOpen,
  canEdit,
  copiedLocal,
  designV2,
  desktopImport,
  desktopImportCount,
  desktopImportReport,
  draftStorageUnavailable,
  mergeBusy,
  mergePreview,
  mergeUnavailable,
  importError,
  onBindWorkItem,
  onCopyLocal,
  onPreviewMerge,
  onConfirmMerge,
  onCreateSemanticEdge,
  onCreateWorkItem,
  onDeleteSemanticEdge,
  onReviewSemanticEdge,
  onExport,
  onExportRecovery,
  onSelectRecovery,
  onImport,
  onConfirmDesktopImport,
  onCancelDesktopImport,
  onDownloadDesktopImportReport,
  onOrchestratorRunVersionsChange,
  onReload,
  onDiscardRecovery,
  onRestoreRecovery,
  onRetry,
  onSelectionChange,
  onSearchWorkItems,
  onToggleBoardInfo,
  onOpenTasksPanel,
  onCloseTasksPanel,
  tasksPanelOpen,
  onToolChange,
  onOpenSemanticPanel,
  onCloseSemanticPanel,
  semanticEdges,
  semanticPanelFocusRef,
  semanticPanelOpen,
  recoveryMode,
  pendingRecoveryOperation,
  recoveryCandidates,
  selectedRecoveryKey,
  statusPlacement,
  syncStatus,
}: {
  authorId: string;
  boardId: string;
  boardInfoFocusRef: { current: boolean };
  boardInfoOpen: boolean;
  canEdit: boolean;
  copiedLocal: boolean;
  designV2: boolean;
  desktopImport?: { boardId: string; filename: string; plan: TPpmDesktopImportPlan };
  desktopImportCount?: number;
  desktopImportReport?: TPpmDesktopImportReport;
  draftStorageUnavailable: boolean;
  mergeBusy: boolean;
  mergePreview?: { contentHash: string | null; localChanges: number; remoteChanges: number; remoteVersion: number };
  mergeUnavailable: boolean;
  importError: boolean;
  onBindWorkItem: (source: TPpmWorkItemProjection) => Promise<void>;
  onCopyLocal: () => void;
  onPreviewMerge: () => void;
  onConfirmMerge: () => void;
  onCreateSemanticEdge: (
    fromShapeId: string,
    toShapeId: string,
    relationType: TPpmCanvasSemanticRelationType,
    label: string
  ) => Promise<void>;
  onCreateWorkItem: (name: string) => Promise<void>;
  onDeleteSemanticEdge: (edgeId: string) => Promise<void>;
  onReviewSemanticEdge: (edgeId: string, confirmationStatus: "confirmed" | "rejected") => Promise<void>;
  onExport: () => void;
  onExportRecovery: () => void;
  onSelectRecovery: (key: string) => void;
  onImport: (file: File) => Promise<void>;
  onConfirmDesktopImport: () => void;
  onCancelDesktopImport: () => void;
  onDownloadDesktopImportReport: () => void;
  onOrchestratorRunVersionsChange?: (boardId: string, versions: Record<string, string>) => void;
  onReload: () => void;
  onDiscardRecovery: () => void;
  onRestoreRecovery: () => void;
  onRetry: () => void;
  onSelectionChange?: (boardId: string, shapeIds: string[]) => void;
  onSearchWorkItems: (query: string, cursor?: string) => Promise<TPpmProjectionSearchResponse>;
  onToggleBoardInfo: () => void;
  onOpenTasksPanel: () => void;
  onCloseTasksPanel: () => void;
  tasksPanelOpen: boolean;
  onToolChange?: (boardId: string, toolId: string) => void;
  onOpenSemanticPanel: () => void;
  onCloseSemanticPanel: () => void;
  semanticEdges: TPpmCanvasSemanticEdge[];
  semanticPanelFocusRef: { current: boolean };
  semanticPanelOpen: boolean;
  recoveryMode?: "restore" | "export_only";
  pendingRecoveryOperation: boolean;
  recoveryCandidates: TRecoveryCandidate[];
  selectedRecoveryKey?: string;
  statusPlacement: "card" | "footer";
  syncStatus: TPpmCanvasSyncStatus;
}) {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const projectionContext = useContext(PpmWorkItemProjectionContext);
  const importInputRef = useRef<HTMLInputElement>(null);
  const boardInfoToggleRef = useRef<HTMLButtonElement>(null);
  const nodes = useValue(
    "ppm canvas nodes",
    () =>
      [...editor.getCurrentPageShapes()]
        .filter((shape): shape is TPpmCanvasShape => shape.type === PPM_CANVAS_SHAPE_TYPE)
        .map((shape) => ({ parsed: parseSerializedPpmCanvasNode(shape.props.node), shape })),
    [editor]
  );
  const shapeCount = useValue("ppm canvas shape count", () => editor.getCurrentPageShapes().length, [editor]);
  const selectedShapeIds = useValue("ppm canvas selected shapes", () => editor.getSelectedShapeIds(), [editor]);
  const toolId = useValue("ppm canvas tool", () => editor.getCurrentToolId(), [editor]);
  const orchestratorRunVersions = useMemo(
    () =>
      Object.fromEntries(
        nodes.flatMap(({ parsed }) =>
          (parsed.status === "valid" || parsed.status === "migrated") && parsed.node.kind === "orchestrator"
            ? [[parsed.node.run_id, `${parsed.node.run_id}:${parsed.node.run_updated_at ?? parsed.node.updated_at}`]]
            : []
        )
      ),
    [nodes]
  );

  useEffect(() => {
    onSelectionChange?.(boardId, selectedShapeIds.map(String));
  }, [boardId, onSelectionChange, selectedShapeIds]);

  useEffect(() => {
    onToolChange?.(boardId, toolId);
  }, [boardId, onToolChange, toolId]);

  useEffect(() => {
    onOrchestratorRunVersionsChange?.(boardId, orchestratorRunVersions);
  }, [boardId, onOrchestratorRunVersionsChange, orchestratorRunVersions]);

  useEffect(() => {
    if (!boardInfoFocusRef.current) return;
    boardInfoFocusRef.current = false;
    boardInfoToggleRef.current?.focus();
  }, [boardInfoFocusRef]);

  useEffect(() => {
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<TPpmCanvasCommandDetail>).detail;
      if (!detail || detail.boardId !== boardId) return;
      switch (detail.command) {
        case "select":
          editor.setCurrentTool("select");
          break;
        case "add-note":
          if (canEdit) createNode(editor, authorId, "note", ppmT("canvas.note_title"));
          break;
        case "add-document":
          if (canEdit) createNode(editor, authorId, "document", ppmT("canvas.document_title"));
          break;
        case "add-checklist":
          if (canEdit) createNode(editor, authorId, "checklist", ppmT("canvas.checklist_title"));
          break;
        case "add-table":
          if (canEdit) createNode(editor, authorId, "table", ppmT("canvas.table_title"));
          break;
        case "draw-rectangle":
        case "draw-ellipse":
        case "draw-diamond":
          if (canEdit) {
            const geo = detail.command.slice(5) as "rectangle" | "ellipse" | "diamond";
            editor.setStyleForNextShapes(GeoShapeGeoStyle, geo);
            editor.setCurrentTool("geo");
          }
          break;
        case "draw-line":
          if (canEdit) editor.setCurrentTool("line");
          break;
        case "draw-pen":
          if (canEdit) editor.setCurrentTool("draw");
          break;
        case "draw-text":
          if (canEdit) editor.setCurrentTool("text");
          break;
        case "open-tasks":
          onOpenTasksPanel();
          break;
        case "add-agent-answer":
          if (canEdit && detail.agentAnswer) createAgentAnswerNodes(editor, authorId, detail.agentAnswer);
          break;
        case "add-orchestrator-run":
          if (canEdit && detail.orchestratorRun) upsertOrchestratorNode(editor, authorId, detail.orchestratorRun);
          break;
        case "add-search-results":
          if (canEdit && detail.searchResults) createSearchNode(editor, authorId, detail.searchResults);
          break;
        case "draw-connection":
          if (canEdit) editor.setCurrentTool("arrow");
          break;
        case "semantic-edges":
          if (!semanticPanelOpen) onOpenSemanticPanel();
          break;
        case "undo":
          if (canEdit) editor.undo();
          break;
        case "redo":
          if (canEdit) editor.redo();
          break;
        case "zoom-in":
          editor.zoomIn();
          break;
        case "zoom-out":
          editor.zoomOut();
          break;
        case "fit-view":
          editor.zoomToFit({ animation: { duration: 180 } });
          break;
        case "zoom-reset":
          editor.resetZoom(editor.getViewportScreenCenter(), { animation: { duration: 180 } });
          break;
        case "focus-selection":
          if (editor.getSelectedShapeIds().length > 0) editor.zoomToSelection({ animation: { duration: 180 } });
          break;
        case "align-left":
        case "align-center-horizontal":
        case "align-right":
        case "align-top":
        case "align-center-vertical":
        case "align-bottom": {
          const selectedIds = editor.getSelectedShapeIds();
          if (!canEdit || selectedIds.length < 2) break;
          editor.alignShapes(selectedIds, detail.command.replace("align-", "") as Parameters<Editor["alignShapes"]>[1]);
          break;
        }
      }
    };
    window.addEventListener(PPM_CANVAS_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(PPM_CANVAS_COMMAND_EVENT, onCommand);
  }, [authorId, boardId, canEdit, editor, onOpenSemanticPanel, onOpenTasksPanel, ppmT, semanticPanelOpen]);

  const statusLabelKey: TPpmTranslationKey = recoveryMode
    ? "canvas.recovery_title"
    : canEdit || syncStatus !== "saved"
      ? SYNC_STATUS_LABELS[syncStatus]
      : "canvas.read_only_title";
  const statusDescriptionKey: TPpmTranslationKey = recoveryMode
    ? recoveryMode === "restore"
      ? "canvas.recovery_restore_description"
      : pendingRecoveryOperation
        ? "canvas.recovery_verify_pending_description"
        : "canvas.recovery_export_description"
    : canEdit || syncStatus !== "saved"
      ? SYNC_STATUS_DESCRIPTIONS[syncStatus]
      : "canvas.read_only_description";
  const blockingStatus = isBlockingCanvasStatus(syncStatus, Boolean(recoveryMode));
  const boardInfoPanelId = `ppm-canvas-board-info-${boardId}`;
  // Shared status blocks: the card (minimal workspace) and the footer layout (banner + "Board" pill) render the same
  // blocks with the same labels and classes, so recovery, merge and import flows behave identically in both.
  const statusNotice = (
    <p className="ppm-canvas-status__notice" data-status={syncStatus}>
      {ppmT(statusDescriptionKey)}
    </p>
  );
  const recoverySelect = recoveryMode && recoveryCandidates.length > 1 && (
    <label className="ppm-canvas-status__recovery-select">
      <span>{ppmT("canvas.recovery_choose")}</span>
      <select value={selectedRecoveryKey} onChange={(event) => onSelectRecovery(event.target.value)}>
        {recoveryCandidates.map((candidate, index) => (
          <option key={candidate.key} value={candidate.key}>
            {index + 1} · {candidate.draft.saved_at}
          </option>
        ))}
      </select>
    </label>
  );
  const recoveryActions = recoveryMode && (
    <div className="ppm-canvas-status__actions">
      {(recoveryMode === "restore" || pendingRecoveryOperation) && syncStatus !== "loading" && (
        <button type="button" onClick={onRestoreRecovery}>
          {ppmT(recoveryMode === "restore" ? "canvas.recovery_restore" : "canvas.recovery_verify_pending")}
        </button>
      )}
      <button type="button" onClick={onExportRecovery}>
        <Download aria-hidden="true" />
        {ppmT("canvas.recovery_download")}
      </button>
      <button type="button" onClick={onDiscardRecovery}>
        {ppmT("canvas.recovery_discard")}
      </button>
    </div>
  );
  const storageWarning = draftStorageUnavailable && (
    <p className="ppm-canvas-status__storage-warning">{ppmT("canvas.recovery_storage_unavailable")}</p>
  );
  const mergeBlock = ((syncStatus === "conflict" && !recoveryMode) || recoveryMode === "export_only") && (
    <div className="ppm-canvas-status__migration">
      <strong>{ppmT("canvas.merge_title")}</strong>
      <p>{ppmT("canvas.merge_description")}</p>
      {mergePreview && (
        <p>
          {ppmT("canvas.merge_local_changes")}: {mergePreview.localChanges} · {ppmT("canvas.merge_remote_changes")}:{" "}
          {mergePreview.remoteChanges}
        </p>
      )}
      {mergeUnavailable && <p className="ppm-canvas-status__import-error">{ppmT("canvas.merge_unavailable")}</p>}
      <div className="ppm-canvas-status__actions">
        <button disabled={mergeBusy} type="button" onClick={mergePreview ? onConfirmMerge : onPreviewMerge}>
          {ppmT(mergeBusy ? "canvas.merge_checking" : mergePreview ? "canvas.merge_confirm" : "canvas.merge_preview")}
        </button>
      </div>
    </div>
  );
  const exportButton = (
    <button type="button" onClick={onExport}>
      <Download aria-hidden="true" />
      {ppmT("canvas.export_board")}
    </button>
  );
  const importButton = (
    <button type="button" onClick={() => importInputRef.current?.click()}>
      <Upload aria-hidden="true" />
      {ppmT("canvas.import_board")}
    </button>
  );
  const importInput = (
    <input
      ref={importInputRef}
      hidden
      accept="application/json,.json,.flow.json"
      type="file"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void onImport(file);
        event.currentTarget.value = "";
      }}
    />
  );
  const desktopImportPreview = desktopImport && (
    <div className="ppm-canvas-status__migration" role="dialog" aria-label={ppmT("canvas.desktop_import_title")}>
      <strong>{ppmT("canvas.desktop_import_title")}</strong>
      <span className="ppm-canvas-status__migration-file">{desktopImport.filename}</span>
      <p>
        {ppmT("canvas.desktop_import_converted")}: {desktopImport.plan.convertedCount} ·{" "}
        {ppmT("canvas.desktop_import_placeholders")}: {desktopImport.plan.placeholderCount}
      </p>
      <p>
        {ppmT("canvas.desktop_import_connections")}: {desktopImport.plan.connections.length}
      </p>
      <p>
        {ppmT("canvas.desktop_import_free_arrows")}: {desktopImport.plan.freeArrows.length}
      </p>
      {(desktopImport.plan.placeholderCount > 0 ||
        desktopImport.plan.assetCount > 0 ||
        desktopImport.plan.hasLegacyExtras ||
        desktopImport.plan.hasFlattenedHierarchy ||
        desktopImport.plan.hasRotations) && <p>{ppmT("canvas.desktop_import_warning")}</p>}
      {desktopImport.plan.unsupportedKinds.length > 0 && <p>{desktopImport.plan.unsupportedKinds.join(", ")}</p>}
      <p>{ppmT("canvas.desktop_import_additive")}</p>
      <div className="ppm-canvas-status__actions">
        <button type="button" onClick={onConfirmDesktopImport}>
          {ppmT("canvas.desktop_import_confirm")}
        </button>
        <button type="button" onClick={onCancelDesktopImport}>
          {ppmT("canvas.desktop_import_cancel")}
        </button>
        <button type="button" onClick={onDownloadDesktopImportReport}>
          {ppmT("canvas.desktop_import_report")}
        </button>
      </div>
    </div>
  );
  const desktopImportResult = desktopImportCount !== undefined && (
    <div className="ppm-canvas-status__migration">
      <p className="ppm-canvas-status__import-success">
        {ppmT("canvas.desktop_import_done")}: {desktopImportCount}
      </p>
      {desktopImportReport && (
        <div className="ppm-canvas-status__actions">
          <button type="button" onClick={onDownloadDesktopImportReport}>
            {ppmT("canvas.desktop_import_report")}
          </button>
        </div>
      )}
    </div>
  );
  const importErrorNotice = importError && (
    <p className="ppm-canvas-status__import-error">{ppmT("canvas.import_error")}</p>
  );
  const syncActions = (syncStatus === "conflict" || syncStatus === "error" || syncStatus === "corrupt") && (
    <div className="ppm-canvas-status__actions">
      {syncStatus === "error" && (
        <button type="button" onClick={onRetry}>
          {ppmT("canvas.retry_save")}
        </button>
      )}
      {syncStatus === "conflict" && (
        <button type="button" onClick={onCopyLocal}>
          {ppmT(copiedLocal ? "canvas.copy_done" : "canvas.copy_local")}
        </button>
      )}
      <button type="button" onClick={onReload}>
        {ppmT("canvas.reload_server")}
      </button>
    </div>
  );
  const objectsList = (
    <details>
      <summary>
        {ppmT("canvas.objects")} · {nodes.length}
      </summary>
      {nodes.length === 0 ? (
        <p>{ppmT("canvas.objects_empty")}</p>
      ) : (
        <ul>
          {nodes.map(({ parsed, shape }) => (
            <li key={shape.id}>
              <button type="button" onClick={() => focusShape(editor, shape.id)}>
                <Frame aria-hidden="true" />
                <span>
                  {parsed.status === "valid" || parsed.status === "migrated"
                    ? parsed.node.kind === "work_item_ref"
                      ? (projectionContext.bindingsByShapeId.get(shape.id)?.source.display.title ??
                        ppmT("canvas.work_item"))
                      : parsed.node.title ||
                        ppmT(parsed.node.kind === "note" ? "canvas.note_title" : "canvas.group_title")
                    : ppmT(parsed.status === "unknown" ? "canvas.unknown_node" : "canvas.corrupt_node")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );

  return (
    <>
      {tasksPanelOpen && (
        <WorkItemPicker
          addDisabled={!canEdit}
          createDisabled={!canEdit}
          onAdd={async (source) => {
            await onBindWorkItem(source);
          }}
          onClose={onCloseTasksPanel}
          onCreate={async (name) => {
            await onCreateWorkItem(name);
          }}
          onSearch={onSearchWorkItems}
          title={ppmT("canvas.tasks_panel")}
        />
      )}
      {semanticPanelOpen && (
        <SemanticEdgesPanel
          canEdit={canEdit}
          designV2={designV2}
          edges={semanticEdges}
          focusOnMountRef={semanticPanelFocusRef}
          nodes={nodes}
          selectedShapeIds={selectedShapeIds}
          onClose={onCloseSemanticPanel}
          onCreate={onCreateSemanticEdge}
          onDelete={onDeleteSemanticEdge}
          onReview={onReviewSemanticEdge}
        />
      )}

      {statusPlacement === "card" ? (
        <aside className="ppm-canvas-status" aria-live="polite">
          <div className="ppm-canvas-status__heading">
            <span className="ppm-canvas-status__icon" aria-hidden="true">
              <BrainCircuit />
            </span>
            <div>
              <strong>{ppmT("project.brain")}</strong>
              <span>{ppmT(statusLabelKey)}</span>
            </div>
          </div>
          {statusNotice}
          {recoverySelect}
          {recoveryActions}
          {storageWarning}
          {mergeBlock}
          <div className="ppm-canvas-status__actions ppm-canvas-status__actions--always">
            {exportButton}
            {canEdit && (
              <>
                {importButton}
                {importInput}
              </>
            )}
          </div>
          {desktopImportPreview}
          {desktopImportResult}
          {importErrorNotice}
          {syncActions}
          {objectsList}
        </aside>
      ) : (
        <>
          {!blockingStatus && (
            // The footer shows the status; this keeps it announced and keeps exactly one notice per editor.
            <p className="ppm-canvas-status__notice ppm-visually-hidden" data-status={syncStatus} aria-live="polite">
              {ppmT(statusDescriptionKey)}
            </p>
          )}
          {/* One top overlay for the banner and the "Board" pill, so the banner never covers the pill. */}
          <div className="ppm-canvas-overlay-top">
            {(blockingStatus || draftStorageUnavailable) && (
              <section className="ppm-canvas-status ppm-canvas-status--alert" aria-live="polite">
                {blockingStatus && (
                  <>
                    <div className="ppm-canvas-status__heading">
                      <span className="ppm-canvas-status__icon" aria-hidden="true">
                        <AlertTriangle />
                      </span>
                      <div>
                        <strong>{ppmT(statusLabelKey)}</strong>
                      </div>
                    </div>
                    {statusNotice}
                  </>
                )}
                {recoverySelect}
                {recoveryActions}
                {storageWarning}
                {mergeBlock}
                {syncActions}
              </section>
            )}
            <div className="ppm-canvas-board-info">
              <button
                ref={boardInfoToggleRef}
                type="button"
                className="ppm-canvas-board-info__toggle"
                aria-controls={boardInfoOpen ? boardInfoPanelId : undefined}
                aria-expanded={boardInfoOpen}
                onClick={onToggleBoardInfo}
              >
                <Frame aria-hidden="true" />
                <span>
                  {ppmT("canvas.board_info")} ·{" "}
                  {ppmT("canvas.board_info_objects").replace("{count}", String(shapeCount))}
                </span>
                <ChevronDown aria-hidden="true" />
              </button>
              {/* Always mounted so a file can be imported while "Board" is collapsed. */}
              {canEdit && importInput}
              {boardInfoOpen && (
                <section
                  className="ppm-canvas-status ppm-canvas-board-info__panel"
                  id={boardInfoPanelId}
                  aria-label={ppmT("canvas.board_info")}
                >
                  <div className="ppm-canvas-status__actions ppm-canvas-status__actions--always">
                    {exportButton}
                    {canEdit && importButton}
                  </div>
                  {desktopImportPreview}
                  {desktopImportResult}
                  {importErrorNotice}
                  {objectsList}
                </section>
              )}
            </div>
          </div>
        </>
      )}

      {shapeCount === 0 && (
        <div className="ppm-canvas-empty">
          <BrainCircuit aria-hidden="true" />
          <strong>{ppmT("canvas.empty_title")}</strong>
          <span>{ppmT("canvas.empty_description")}</span>
          {canEdit && (
            <button type="button" onClick={() => createNode(editor, authorId, "note", ppmT("canvas.note_title"))}>
              <Plus aria-hidden="true" />
              {ppmT("canvas.add_note")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function FileDropDialog({
  error,
  files,
  loading,
  onClose,
  onPlane,
  onVault,
}: {
  error?: string;
  files: File[];
  loading: boolean;
  onClose: () => void;
  onPlane: () => void;
  onVault: () => void;
}) {
  const ppmT = usePpmTranslation();
  return (
    <section
      className="ppm-file-drop-dialog"
      aria-label={ppmT("canvas.file_drop_title")}
      aria-modal="true"
      role="dialog"
    >
      <header>
        <div>
          <strong>{ppmT("canvas.file_drop_title")}</strong>
          <span>{ppmT("canvas.file_drop_description")}</span>
        </div>
        <button type="button" aria-label={ppmT("canvas.close")} disabled={loading} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <ul>
        {files.map((file) => (
          <li key={`${file.name}:${file.size}:${file.lastModified}`}>
            <FileArchive aria-hidden="true" />
            <span>{file.name}</span>
            <small>{formatFileSize(file.size)}</small>
          </li>
        ))}
      </ul>
      <div className="ppm-file-drop-dialog__choices">
        <button type="button" disabled={loading} onClick={onVault}>
          <strong>{ppmT("canvas.file_drop_vault")}</strong>
          <span>{ppmT("canvas.file_drop_vault_hint")}</span>
        </button>
        <button type="button" disabled={loading} onClick={onPlane}>
          <strong>{ppmT("canvas.file_drop_plane")}</strong>
          <span>{ppmT("canvas.file_drop_plane_hint")}</span>
        </button>
      </div>
      {loading && <p>{ppmT("canvas.file_drop_uploading")}</p>}
      {error && <p className="ppm-work-item-picker__error">{error}</p>}
    </section>
  );
}

function WorkItemPicker({
  addDisabled = false,
  createDisabled = false,
  onAdd,
  onClose,
  onCreate,
  onSearch,
  title,
}: {
  addDisabled?: boolean;
  createDisabled?: boolean;
  onAdd: (source: TPpmWorkItemProjection) => Promise<void>;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onSearch: (query: string, cursor?: string) => Promise<TPpmProjectionSearchResponse>;
  title?: string;
}) {
  const ppmT = usePpmTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TPpmWorkItemProjection[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string>();
  const [error, setError] = useState(false);
  const [copiedTaskId, setCopiedTaskId] = useState<string>();

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(false);
      try {
        const response = await onSearch(query);
        if (!active) return;
        setResults(response.results);
        setNextCursor(response.next_cursor);
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [onSearch, query]);

  const add = async (source: TPpmWorkItemProjection) => {
    setActionId(source.identity.entity_id);
    setError(false);
    try {
      await onAdd(source);
      setActionId(undefined);
    } catch {
      setError(true);
      setActionId(undefined);
    }
  };

  const create = async () => {
    const name = query.trim();
    if (!name) return;
    setActionId("create");
    setError(false);
    try {
      await onCreate(name);
      setActionId(undefined);
      setQuery("");
    } catch {
      setError(true);
      setActionId(undefined);
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const response = await onSearch(query, nextCursor);
      setResults((current) => [...current, ...response.results]);
      setNextCursor(response.next_cursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="ppm-work-item-picker" aria-label={title ?? ppmT("canvas.add_work_item")}>
      <header>
        <div>
          <strong>{title ?? ppmT("canvas.add_work_item")}</strong>
          <span>{ppmT("canvas.work_item_picker_description")}</span>
        </div>
        <button type="button" aria-label={ppmT("canvas.close_picker")} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <label className="ppm-work-item-picker__search">
        <Search aria-hidden="true" />
        <input
          maxLength={160}
          placeholder={ppmT("canvas.search_work_items")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="ppm-work-item-picker__results">
        {results.map((source) => (
          <div className="ppm-work-item-picker__row" key={source.identity.entity_id}>
            <button type="button" disabled={addDisabled || Boolean(actionId)} onClick={() => void add(source)}>
              <span>
                <strong>{source.display.title}</strong>
                <small>
                  {source.identity.identifier} · {source.display.state?.name ?? ppmT("canvas.work_item_no_state")}
                </small>
              </span>
              <Plus aria-hidden="true" />
            </button>
            {source.identity.source_url && (
              <button
                type="button"
                className="ppm-work-item-picker__copy"
                aria-label={ppmT(
                  copiedTaskId === source.identity.entity_id ? "canvas.task_link_copied" : "canvas.copy_task_link"
                )}
                title={ppmT(
                  copiedTaskId === source.identity.entity_id ? "canvas.task_link_copied" : "canvas.copy_task_link"
                )}
                onClick={async () => {
                  try {
                    const sourceUrl = source.identity.source_url;
                    if (!sourceUrl) return;
                    await navigator.clipboard.writeText(new URL(sourceUrl, window.location.origin).toString());
                    setCopiedTaskId(source.identity.entity_id);
                  } catch {
                    setError(true);
                  }
                }}
              >
                <Copy aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
        {!loading && results.length === 0 && <p>{ppmT("canvas.work_item_empty_search")}</p>}
        {loading && <p>{ppmT("canvas.work_item_searching")}</p>}
      </div>
      {nextCursor && (
        <button type="button" className="ppm-work-item-picker__more" disabled={loading} onClick={() => void loadMore()}>
          {ppmT("canvas.show_more")}
        </button>
      )}
      {query.trim() && !createDisabled && (
        <button
          type="button"
          className="ppm-work-item-picker__create"
          disabled={Boolean(actionId)}
          onClick={() => void create()}
        >
          <Plus aria-hidden="true" />
          {ppmT("canvas.create_work_item")} “{query.trim()}”
        </button>
      )}
      {error && <p className="ppm-work-item-picker__error">{ppmT("canvas.work_item_action_error")}</p>}
    </section>
  );
}

function SemanticEdgesPanel({
  canEdit,
  designV2,
  edges,
  focusOnMountRef,
  nodes,
  onClose,
  onCreate,
  onDelete,
  onReview,
  selectedShapeIds,
}: {
  canEdit: boolean;
  designV2: boolean;
  edges: TPpmCanvasSemanticEdge[];
  focusOnMountRef: { current: boolean };
  nodes: { parsed: ReturnType<typeof parseSerializedPpmCanvasNode>; shape: TPpmCanvasShape }[];
  onClose: () => void;
  onCreate: (
    fromShapeId: string,
    toShapeId: string,
    relationType: TPpmCanvasSemanticRelationType,
    label: string
  ) => Promise<void>;
  onDelete: (edgeId: string) => Promise<void>;
  onReview: (edgeId: string, confirmationStatus: "confirmed" | "rejected") => Promise<void>;
  selectedShapeIds: TLShapeId[];
}) {
  const ppmT = usePpmTranslation();
  const [relationType, setRelationType] = useState<TPpmCanvasSemanticRelationType>("relates_to");
  const [label, setLabel] = useState("");
  const [fromShapeId, setFromShapeId] = useState<string>(selectedShapeIds.length === 2 ? selectedShapeIds[0] : "");
  const [toShapeId, setToShapeId] = useState<string>(selectedShapeIds.length === 2 ? selectedShapeIds[1] : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  // From context, not props: a chip click on an open panel re-renders only this list (the overlay stays mounted).
  const focusedEdgeId = useContext(PpmSemanticEdgeFocusContext);
  const focusedRowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focusedEdgeId) focusedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focusedEdgeId]);
  const pair = fromShapeId && toShapeId && fromShapeId !== toShapeId ? [fromShapeId, toShapeId] : [];
  const titleByShapeId = new Map(
    nodes.map(({ parsed, shape }) => [
      shape.id,
      parsed.status === "valid" || parsed.status === "migrated"
        ? "title" in parsed.node && typeof parsed.node.title === "string" && parsed.node.title
          ? parsed.node.title
          : parsed.node.kind
        : ppmT(parsed.status === "unknown" ? "canvas.unknown_node" : "canvas.corrupt_node"),
    ])
  );

  useEffect(() => {
    if (selectedShapeIds.length !== 2) return;
    setFromShapeId(selectedShapeIds[0]);
    setToShapeId(selectedShapeIds[1]);
  }, [selectedShapeIds]);

  useEffect(() => {
    if (!focusOnMountRef.current) return;
    focusOnMountRef.current = false;
    // Next frame: when the command palette runs this command, it returns focus to its trigger in a frame first.
    // No scroll: after a chip click the list has already scrolled to the highlighted link.
    requestAnimationFrame(() =>
      sectionRef.current?.querySelector<HTMLElement>("button, select, input")?.focus({ preventScroll: true })
    );
  }, [focusOnMountRef]);

  const create = async () => {
    const [selectedFromShapeId, selectedToShapeId] = pair;
    if (!selectedFromShapeId || !selectedToShapeId) return;
    setPending(true);
    setError(false);
    try {
      await onCreate(selectedFromShapeId, selectedToShapeId, relationType, label);
      setLabel("");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  const remove = async (edgeId: string) => {
    setPending(true);
    setError(false);
    try {
      await onDelete(edgeId);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  const review = async (edgeId: string, confirmationStatus: "confirmed" | "rejected") => {
    setPending(true);
    setError(false);
    try {
      await onReview(edgeId, confirmationStatus);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      ref={sectionRef}
      className="ppm-semantic-edges"
      aria-label={ppmT("canvas.semantic_edges")}
      onKeyDown={(event) => {
        if (event.code === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <strong>{ppmT("canvas.semantic_edges")}</strong>
          <span>{ppmT("canvas.semantic_edges_description")}</span>
        </div>
        <button type="button" aria-label={ppmT("canvas.semantic_edges_close")} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {canEdit && (
        <div className="ppm-semantic-edges__create">
          <p>{ppmT("canvas.semantic_edges_select_two")}</p>
          <div className="ppm-semantic-edges__pair">
            <label>
              <span>{ppmT("canvas.semantic_edges_from")}</span>
              <select value={fromShapeId} onChange={(event) => setFromShapeId(event.currentTarget.value)}>
                <option value="">{ppmT("canvas.semantic_edges_choose_object")}</option>
                {nodes.map(({ shape }) => (
                  <option key={shape.id} value={shape.id}>
                    {titleByShapeId.get(shape.id) ?? shape.id}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!fromShapeId && !toShapeId}
              onClick={() => {
                setFromShapeId(toShapeId);
                setToShapeId(fromShapeId);
              }}
            >
              {ppmT("canvas.semantic_edges_swap")}
            </button>
            <label>
              <span>{ppmT("canvas.semantic_edges_to")}</span>
              <select value={toShapeId} onChange={(event) => setToShapeId(event.currentTarget.value)}>
                <option value="">{ppmT("canvas.semantic_edges_choose_object")}</option>
                {nodes.map(({ shape }) => (
                  <option key={shape.id} value={shape.id}>
                    {titleByShapeId.get(shape.id) ?? shape.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>{ppmT("canvas.semantic_edges_relation")}</span>
            <select
              value={relationType}
              onChange={(event) => setRelationType(event.currentTarget.value as TPpmCanvasSemanticRelationType)}
            >
              {Object.entries(SEMANTIC_RELATION_LABELS).map(([value, translationKey]) => (
                <option key={value} value={value}>
                  {ppmT(translationKey)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{ppmT("canvas.semantic_edges_label")}</span>
            <input
              maxLength={255}
              placeholder={ppmT("canvas.semantic_edges_label_placeholder")}
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <button type="button" disabled={pair.length !== 2 || pending} onClick={() => void create()}>
            {ppmT("canvas.semantic_edges_create")}
          </button>
          <small>{ppmT("canvas.semantic_edges_visual_hint")}</small>
        </div>
      )}
      <div className="ppm-semantic-edges__list">
        <strong>{ppmT("canvas.semantic_edges_saved")}</strong>
        {edges.length === 0 ? (
          <p>{ppmT("canvas.semantic_edges_empty")}</p>
        ) : (
          <ul>
            {edges.map((edge) => (
              <li
                key={edge.edge_id}
                data-confirmation={edge.confirmation_status}
                data-focused={edge.edge_id === focusedEdgeId || undefined}
                ref={edge.edge_id === focusedEdgeId ? focusedRowRef : undefined}
              >
                <span>
                  <strong>{titleByShapeId.get(edge.from_shape_id as TLShapeId) ?? edge.from_shape_id}</strong>
                  <small>{ppmT(SEMANTIC_RELATION_LABELS[edge.relation_type])}</small>
                  <strong>{titleByShapeId.get(edge.to_shape_id as TLShapeId) ?? edge.to_shape_id}</strong>
                  {edge.label && <small>{edge.label}</small>}
                  {edge.confirmation_status === "proposed" && (
                    <small>{ppmT(designV2 ? "canvas.edge_proposed" : "canvas.semantic_edges_proposed")}</small>
                  )}
                </span>
                {canEdit && (
                  <div className="ppm-semantic-edges__actions">
                    {edge.confirmation_status === "proposed" && (
                      <>
                        <button type="button" disabled={pending} onClick={() => void review(edge.edge_id, "confirmed")}>
                          <Check aria-hidden="true" />
                          {ppmT("canvas.semantic_edges_confirm")}
                        </button>
                        <button type="button" disabled={pending} onClick={() => void review(edge.edge_id, "rejected")}>
                          <X aria-hidden="true" />
                          {ppmT("canvas.semantic_edges_reject")}
                        </button>
                      </>
                    )}
                    <button type="button" disabled={pending} onClick={() => void remove(edge.edge_id)}>
                      <Trash2 aria-hidden="true" />
                      {ppmT("canvas.semantic_edges_remove")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="ppm-semantic-edges__error">{ppmT("canvas.semantic_edges_error")}</p>}
    </section>
  );
}

const SYNC_STATUS_LABELS: Record<TPpmCanvasSyncStatus, TPpmTranslationKey> = {
  conflict: "canvas.sync_conflict",
  corrupt: "canvas.sync_corrupt",
  error: "canvas.sync_error",
  loading: "canvas.sync_loading",
  saved: "canvas.sync_saved",
  saving: "canvas.sync_saving",
};

const SYNC_STATUS_DESCRIPTIONS: Record<TPpmCanvasSyncStatus, TPpmTranslationKey> = {
  conflict: "canvas.sync_conflict_description",
  corrupt: "canvas.sync_corrupt_description",
  error: "canvas.sync_error_description",
  loading: "canvas.sync_loading_description",
  saved: "canvas.sync_saved_description",
  saving: "canvas.sync_saving_description",
};

function getCanvasSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function getCanvasLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function downloadCanvasSnapshot(boardId: string, snapshot: TPpmCanvasSnapshot): void {
  const payload = createPpmCanvasBoardExport(snapshot);
  downloadCanvasJson(`ppm-board-${boardId}.json`, JSON.stringify(payload, null, 2));
}

function downloadCanvasJson(filename: string, content: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function createNode(
  editor: Editor,
  authorId: string,
  kind: TPpmCanvasOwnedNodeKind,
  title: string,
  targetBoardId?: string
) {
  const node = createPpmCanvasNode({ authorId, kind, targetBoardId, title });
  const position = findFreeNodePosition(editor, node.visual.width, node.visual.height);
  const id = createShapeId();
  editor.createShape<TPpmCanvasShape>({
    id,
    type: PPM_CANVAS_SHAPE_TYPE,
    x: position.x,
    y: position.y,
    props: {
      h: node.visual.height,
      node: serializePpmCanvasNode(node),
      w: node.visual.width,
    },
  });
  if (kind === "group") editor.sendToBack([id]);
  editor.select(id).setCurrentTool("select");
  if (!position.inViewport)
    editor.zoomToBounds(
      Box.Common([
        editor.getViewportPageBounds(),
        new Box(position.x, position.y, node.visual.width, node.visual.height),
      ]),
      { immediate: true, targetZoom: 1 }
    );
}

function findFreeNodePosition(editor: Editor, width: number, height: number) {
  const viewport = editor.getViewportPageBounds();
  const center = viewport.center;
  const occupied = editor
    .getCurrentPageShapes()
    .filter((shape) => !["arrow", "line", "draw"].includes(shape.type))
    .map((shape) => editor.getShapePageBounds(shape))
    .filter((bounds): bounds is NonNullable<typeof bounds> => Boolean(bounds));
  const gap = 20;
  const visible = occupied.filter(
    (bounds) =>
      bounds.x < viewport.x + viewport.w &&
      bounds.x + bounds.w > viewport.x &&
      bounds.y < viewport.y + viewport.h &&
      bounds.y + bounds.h > viewport.y
  );
  const candidates: { x: number; y: number; inViewport: boolean; score: number }[] = [];
  const addCandidate = (x: number, y: number) => {
    if (
      occupied.some(
        (bounds) =>
          x < bounds.x + bounds.w + gap &&
          x + width + gap > bounds.x &&
          y < bounds.y + bounds.h + gap &&
          y + height + gap > bounds.y
      )
    )
      return;
    const inViewport =
      x >= viewport.x + gap &&
      y >= viewport.y + gap &&
      x + width <= viewport.x + viewport.w - gap &&
      y + height <= viewport.y + viewport.h - gap;
    const local = [...visible, { x, y, w: width, h: height }];
    const minX = Math.min(...local.map((bounds) => bounds.x));
    const minY = Math.min(...local.map((bounds) => bounds.y));
    const maxX = Math.max(...local.map((bounds) => bounds.x + bounds.w));
    const maxY = Math.max(...local.map((bounds) => bounds.y + bounds.h));
    const fit = Math.min(1, viewport.w / (maxX - minX + gap * 2), viewport.h / (maxY - minY + gap * 2));
    const distance = Math.hypot(x + width / 2 - center.x, y + height / 2 - center.y);
    candidates.push({ x, y, inViewport, score: (inViewport ? 2 : 0) + fit - distance / 100_000 });
  };

  addCandidate(center.x - width / 2, center.y - height / 2);
  for (const bounds of visible) {
    for (const y of [bounds.y, bounds.y + (bounds.h - height) / 2, bounds.y + bounds.h - height]) {
      addCandidate(bounds.x - width - gap, y);
      addCandidate(bounds.x + bounds.w + gap, y);
    }
    for (const x of [bounds.x, bounds.x + (bounds.w - width) / 2, bounds.x + bounds.w - width]) {
      addCandidate(x, bounds.y - height - gap);
      addCandidate(x, bounds.y + bounds.h + gap);
    }
  }

  if (candidates.length === 0) {
    for (let radius = 1; radius <= 16 && candidates.length === 0; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          addCandidate(center.x - width / 2 + dx * 128, center.y - height / 2 + dy * 128);
        }
      }
    }
  }

  let best = candidates[0];
  for (const candidate of candidates) if (!best || candidate.score > best.score) best = candidate;
  return best ?? { x: center.x - width / 2, y: center.y - height / 2, inViewport: true };
}

function createAgentAnswerNodes(
  editor: Editor,
  authorId: string,
  payload: NonNullable<TPpmCanvasCommandDetail["agentAnswer"]>
) {
  const now = new Date().toISOString();
  const queryNode = createPpmAgentQueryNode({
    authorId,
    now,
    query: payload.query,
    runId: payload.runId,
    runStatus: payload.runStatus,
    selectedShapeIds: payload.selectedShapeIds,
    serviceRun: payload.serviceRun,
    title: "Вопрос проекту",
  });
  const answerNode = createPpmAgentAnswerNode({
    authorId,
    body: payload.answer,
    citations: payload.citations,
    now,
    runId: payload.runId,
    runStatus: payload.runStatus,
    serviceRun: payload.serviceRun,
    title: "Ответ Мозга проекта",
  });
  const center = editor.getViewportPageBounds().center;
  const queryId = createShapeId();
  const answerId = createShapeId();
  editor.createShape<TPpmCanvasShape>({
    id: queryId,
    type: PPM_CANVAS_SHAPE_TYPE,
    x: center.x - queryNode.visual.width - 28,
    y: center.y - queryNode.visual.height / 2,
    props: {
      h: queryNode.visual.height,
      node: serializePpmCanvasNode(queryNode),
      w: queryNode.visual.width,
    },
  });
  editor.createShape<TPpmCanvasShape>({
    id: answerId,
    type: PPM_CANVAS_SHAPE_TYPE,
    x: center.x + 28,
    y: center.y - answerNode.visual.height / 2,
    props: {
      h: answerNode.visual.height,
      node: serializePpmCanvasNode(answerNode),
      w: answerNode.visual.width,
    },
  });
  editor.select(answerId).setCurrentTool("select");
}

function createSearchNode(
  editor: Editor,
  authorId: string,
  payload: NonNullable<TPpmCanvasCommandDetail["searchResults"]>
) {
  const node = createPpmSearchNode({
    authorId,
    degraded: payload.degraded,
    graphDepth: payload.graphDepth,
    query: payload.query,
    reason: payload.reason,
    results: payload.results,
    retrievalMode: payload.retrievalMode,
    selectedShapeIds: payload.selectedShapeIds,
    serviceRun: payload.serviceRun,
    title: "Поиск по проекту",
  });
  const center = editor.getViewportPageBounds().center;
  const id = createShapeId();
  editor.createShape<TPpmCanvasShape>({
    id,
    type: PPM_CANVAS_SHAPE_TYPE,
    x: center.x - node.visual.width / 2,
    y: center.y - node.visual.height / 2,
    props: {
      h: node.visual.height,
      node: serializePpmCanvasNode(node),
      w: node.visual.width,
    },
  });
  editor.select(id).setCurrentTool("select");
}

function upsertOrchestratorNode(
  editor: Editor,
  authorId: string,
  payload: NonNullable<TPpmCanvasCommandDetail["orchestratorRun"]>
) {
  const node = createPpmOrchestratorNode({
    actionSummary: payload.action_summary,
    actions: payload.actions,
    agentKind: payload.agent_kind,
    authorId,
    citations: payload.citations,
    model: payload.model,
    policyVersion: payload.policy_version,
    provider: payload.provider,
    runCreatedAt: payload.run_created_at,
    runFinishedAt: payload.run_finished_at,
    runId: payload.run_id,
    runStartedAt: payload.run_started_at,
    runStatus: payload.run_status,
    runUpdatedAt: payload.run_updated_at,
    selectedShapeIds: payload.selected_shape_ids,
    summary: payload.summary,
    title: payload.title,
    trace: payload.trace,
  });
  const existingShape = editor
    .getCurrentPageShapes()
    .filter((shape): shape is TPpmCanvasShape => shape.type === PPM_CANVAS_SHAPE_TYPE)
    .find((shape) => {
      const parsed = parseSerializedPpmCanvasNode(shape.props.node);
      return (
        (parsed.status === "valid" || parsed.status === "migrated") &&
        parsed.node.kind === "orchestrator" &&
        parsed.node.run_id === payload.run_id
      );
    });

  if (existingShape) {
    const parsed = parseSerializedPpmCanvasNode(existingShape.props.node);
    if ((parsed.status === "valid" || parsed.status === "migrated") && parsed.node.kind === "orchestrator") {
      const shouldExpand = payload.expand || hasOrchestratorProjections(editor, payload.run_id);
      const updated = mergePpmOrchestratorNode(parsed.node, node);
      editor.updateShape<TPpmCanvasShape>({
        id: existingShape.id,
        type: PPM_CANVAS_SHAPE_TYPE,
        props: { node: serializePpmCanvasNode(updated) },
      });
      if (shouldExpand) expandOrchestratorRun(editor, existingShape, updated);
      editor.select(existingShape.id).setCurrentTool("select");
      return;
    }
  }

  const center = editor.getViewportPageBounds().center;
  const id = createShapeId();
  editor.createShape<TPpmCanvasShape>({
    id,
    type: PPM_CANVAS_SHAPE_TYPE,
    x: center.x - node.visual.width / 2,
    y: center.y - node.visual.height / 2,
    props: {
      h: node.visual.height,
      node: serializePpmCanvasNode(node),
      w: node.visual.width,
    },
  });
  const createdShape = editor.getShape<TPpmCanvasShape>(id);
  if (payload.expand && createdShape) expandOrchestratorRun(editor, createdShape, node);
  editor.select(id).setCurrentTool("select");
}

function hasOrchestratorProjections(editor: Editor, runId: string) {
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is TPpmCanvasShape => shape.type === PPM_CANVAS_SHAPE_TYPE)
    .some((shape) => {
      const parsed = parseSerializedPpmCanvasNode(shape.props.node);
      return (
        (parsed.status === "valid" || parsed.status === "migrated") &&
        (parsed.node.kind === "orchtask" || parsed.node.kind === "orchcall") &&
        parsed.node.run_id === runId
      );
    });
}

function focusShape(editor: Editor, id: TLShapeId) {
  editor.select(id);
  editor.zoomToSelection({ animation: { duration: 180 } });
}

function contentNodeKind(mimeType: string, extension: string | null): TPpmCanvasMediaNode["kind"] {
  if (mimeType === "application/pdf" || extension?.toLowerCase() === ".pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  return "reference";
}

function formatFileSize(bytes: number) {
  if (bytes < 1_024) return `${bytes} Б`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} КБ`;
  return `${(bytes / 1_048_576).toFixed(1)} МБ`;
}
