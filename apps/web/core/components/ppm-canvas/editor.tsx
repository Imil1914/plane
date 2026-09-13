/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrainCircuit,
  Frame,
  Group,
  LocateFixed,
  MousePointer2,
  MoveUpRight,
  Plus,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  Tldraw,
  createShapeId,
  useEditor,
  useValue,
  type Editor,
  type TLComponents,
  type TLEditorSnapshot,
  type TLShapeId,
} from "tldraw";
import {
  PPM_CANVAS_AUTOSAVE_DELAY_MS,
  PPM_CANVAS_SCHEMA_VERSION,
  createPpmCanvasNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasSaveRequest,
  type TPpmCanvasNodeKind,
  type TPpmCanvasSyncStatus,
} from "@ppm/canvas";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmCanvasService, PpmCanvasServiceError } from "@/services/ppm-canvas.service";
import { PPM_CANVAS_SHAPE_TYPE, PpmCanvasNodeShapeUtil, type TPpmCanvasShape } from "./shape";
// oxlint-disable-next-line import/no-unassigned-import -- tldraw owns the canvas interaction styles
import "tldraw/tldraw.css";
// oxlint-disable-next-line import/no-unassigned-import -- PPM theme is intentionally scoped to this route
import "./canvas.css";

type TPpmCanvasEditorProps = {
  authorId: string;
  canEdit: boolean;
  projectId: string;
  workspaceId: string;
};

type TPendingCanvasSave = Pick<TPpmCanvasSaveRequest, "base_version" | "client_operation_id" | "snapshot">;

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

export default function PpmCanvasEditor({ authorId, canEdit, projectId, workspaceId }: TPpmCanvasEditorProps) {
  const service = useMemo(() => new PpmCanvasService(), []);
  const [editor, setEditor] = useState<Editor>();
  const [effectiveCanEdit, setEffectiveCanEdit] = useState(false);
  const [syncStatus, setSyncStatus] = useState<TPpmCanvasSyncStatus>("loading");
  const [copiedLocal, setCopiedLocal] = useState(false);
  const editorRef = useRef<Editor>();
  const versionRef = useRef(0);
  const pendingSaveRef = useRef<TPendingCanvasSave>();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const blockedRef = useRef(true);
  const editableRef = useRef(false);

  const scheduleSaveRef = useRef<() => void>(() => undefined);
  const flushSave = useCallback(async () => {
    const activeEditor = editorRef.current;
    if (!activeEditor || !editableRef.current || blockedRef.current || savingRef.current) return;

    let pending = pendingSaveRef.current;
    if (!pending) {
      const { document } = activeEditor.getSnapshot();
      pending = {
        base_version: versionRef.current,
        client_operation_id: crypto.randomUUID(),
        snapshot: { document },
      };
      pendingSaveRef.current = pending;
      dirtyRef.current = false;
    }

    savingRef.current = true;
    setSyncStatus("saving");
    try {
      const request: TPpmCanvasSaveRequest = {
        schema_version: PPM_CANVAS_SCHEMA_VERSION,
        base_version: pending.base_version,
        client_operation_id: pending.client_operation_id,
        snapshot: pending.snapshot,
      };
      const response = await service.saveCanvas(workspaceId, projectId, request);
      versionRef.current = response.version;
      pendingSaveRef.current = undefined;
      savingRef.current = false;
      setSyncStatus("saved");
      if (dirtyRef.current) scheduleSaveRef.current();
    } catch (error) {
      savingRef.current = false;
      if (error instanceof PpmCanvasServiceError && error.status === 409) {
        blockedRef.current = true;
        setSyncStatus("conflict");
        return;
      }
      setSyncStatus("error");
    }
  }, [projectId, service, workspaceId]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (blockedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(), PPM_CANVAS_AUTOSAVE_DELAY_MS);
  }, [flushSave]);
  scheduleSaveRef.current = scheduleSave;

  useEffect(() => {
    if (!editor) return;
    let active = true;
    let stopListening: (() => void) | undefined;
    editorRef.current = editor;
    blockedRef.current = true;
    editableRef.current = false;
    pendingSaveRef.current = undefined;
    dirtyRef.current = false;
    versionRef.current = 0;
    setCopiedLocal(false);
    setEffectiveCanEdit(false);
    setSyncStatus("loading");
    editor.updateInstanceState({ isReadonly: true });

    const initialize = async () => {
      try {
        const remoteCanvas = await service.getCanvas(workspaceId, projectId);
        if (!active) return;
        versionRef.current = remoteCanvas.version;
        if (remoteCanvas.snapshot_status === "corrupt") {
          setSyncStatus("corrupt");
          return;
        }
        if (remoteCanvas.snapshot_status === "ready" && remoteCanvas.snapshot) {
          editor.loadSnapshot(remoteCanvas.snapshot as unknown as Partial<TLEditorSnapshot>);
        }
        const mayEdit = canEdit && remoteCanvas.access === "edit";
        blockedRef.current = !mayEdit;
        editableRef.current = mayEdit;
        setEffectiveCanEdit(mayEdit);
        editor.updateInstanceState({ isReadonly: !mayEdit });
        setSyncStatus("saved");
        if (mayEdit) {
          stopListening = editor.store.listen(scheduleSave, { scope: "document", source: "user" });
        }
      } catch {
        if (!active) return;
        setSyncStatus("error");
      }
    };
    void initialize();

    return () => {
      active = false;
      stopListening?.();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      editableRef.current = false;
      if (editorRef.current === editor) editorRef.current = undefined;
    };
  }, [canEdit, editor, projectId, scheduleSave, service, workspaceId]);

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

  const components = useMemo<TLComponents>(
    () => ({
      ...HIDDEN_TLDRAW_UI,
      InFrontOfTheCanvas: () => (
        <CanvasControls
          authorId={authorId}
          canEdit={effectiveCanEdit}
          copiedLocal={copiedLocal}
          onCopyLocal={() => void copyLocalSnapshot()}
          onReload={() => window.location.reload()}
          onRetry={() => (pendingSaveRef.current ? void flushSave() : window.location.reload())}
          syncStatus={syncStatus}
        />
      ),
    }),
    [authorId, copiedLocal, copyLocalSnapshot, effectiveCanEdit, flushSave, syncStatus]
  );

  return (
    <div className="ppm-canvas-shell" data-ppm-canvas-mode={effectiveCanEdit ? "edit" : "read"}>
      <Tldraw
        cameraOptions={{ wheelBehavior: "pan" }}
        components={components}
        shapeUtils={[PpmCanvasNodeShapeUtil]}
        onMount={setEditor}
      />
    </div>
  );
}

function CanvasControls({
  authorId,
  canEdit,
  copiedLocal,
  onCopyLocal,
  onReload,
  onRetry,
  syncStatus,
}: {
  authorId: string;
  canEdit: boolean;
  copiedLocal: boolean;
  onCopyLocal: () => void;
  onReload: () => void;
  onRetry: () => void;
  syncStatus: TPpmCanvasSyncStatus;
}) {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const currentTool = useValue("current tool", () => editor.getCurrentToolId(), [editor]);
  const nodes = useValue(
    "ppm canvas nodes",
    () =>
      [...editor.getCurrentPageShapes()]
        .filter((shape): shape is TPpmCanvasShape => shape.type === PPM_CANVAS_SHAPE_TYPE)
        .map((shape) => ({ parsed: parseSerializedPpmCanvasNode(shape.props.node), shape })),
    [editor]
  );

  return (
    <>
      <div className="ppm-canvas-topbar" role="toolbar" aria-label={ppmT("canvas.toolbar")}>
        <ToolbarButton
          active={currentTool === "select"}
          icon={MousePointer2}
          label={ppmT("canvas.select")}
          onClick={() => editor.setCurrentTool("select")}
        />
        {canEdit && (
          <>
            <ToolbarButton
              icon={Plus}
              label={ppmT("canvas.add_note")}
              onClick={() => createNode(editor, authorId, "note", ppmT("canvas.note_title"))}
            />
            <ToolbarButton
              icon={Group}
              label={ppmT("canvas.add_group")}
              onClick={() => createNode(editor, authorId, "group", ppmT("canvas.group_title"))}
            />
            <ToolbarButton
              active={currentTool === "arrow"}
              icon={MoveUpRight}
              label={ppmT("canvas.draw_connection")}
              onClick={() => editor.setCurrentTool("arrow")}
            />
          </>
        )}
        <span className="ppm-canvas-topbar__divider" aria-hidden="true" />
        <ToolbarButton icon={ZoomOut} label={ppmT("canvas.zoom_out")} onClick={() => editor.zoomOut()} />
        <ToolbarButton icon={ZoomIn} label={ppmT("canvas.zoom_in")} onClick={() => editor.zoomIn()} />
        <ToolbarButton icon={LocateFixed} label={ppmT("canvas.fit_view")} onClick={() => editor.zoomToFit()} />
      </div>

      <aside className="ppm-canvas-status" aria-live="polite">
        <div className="ppm-canvas-status__heading">
          <span className="ppm-canvas-status__icon" aria-hidden="true">
            <BrainCircuit />
          </span>
          <div>
            <strong>{ppmT("project.brain")}</strong>
            <span>
              {ppmT(canEdit || syncStatus !== "saved" ? SYNC_STATUS_LABELS[syncStatus] : "canvas.read_only_title")}
            </span>
          </div>
        </div>
        <p className="ppm-canvas-status__notice" data-status={syncStatus}>
          {ppmT(
            canEdit || syncStatus !== "saved" ? SYNC_STATUS_DESCRIPTIONS[syncStatus] : "canvas.read_only_description"
          )}
        </p>
        {(syncStatus === "conflict" || syncStatus === "error" || syncStatus === "corrupt") && (
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
        )}
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
                        ? parsed.node.title ||
                          ppmT(parsed.node.kind === "note" ? "canvas.note_title" : "canvas.group_title")
                        : ppmT(parsed.status === "unknown" ? "canvas.unknown_node" : "canvas.corrupt_node")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
      </aside>

      {nodes.length === 0 && (
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

type TToolbarButtonProps = {
  active?: boolean;
  icon: typeof MousePointer2;
  label: string;
  onClick: () => void;
};

function ToolbarButton({ active = false, icon: Icon, label, onClick }: TToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={active || undefined}
      className="ppm-canvas-toolbar-button"
      title={label}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function createNode(editor: Editor, authorId: string, kind: TPpmCanvasNodeKind, title: string) {
  const node = createPpmCanvasNode({ authorId, kind, title });
  const center = editor.getViewportPageBounds().center;
  const nodeIndex = editor.getCurrentPageShapes().filter((shape) => shape.type === PPM_CANVAS_SHAPE_TYPE).length;
  const offset = (nodeIndex % 5) * 36;
  const id = createShapeId();
  editor.createShape<TPpmCanvasShape>({
    id,
    type: PPM_CANVAS_SHAPE_TYPE,
    x: center.x - node.visual.width / 2 + offset,
    y: center.y - node.visual.height / 2 + offset,
    props: {
      h: node.visual.height,
      node: serializePpmCanvasNode(node),
      w: node.visual.width,
    },
  });
  if (kind === "group") editor.sendToBack([id]);
  editor.select(id).setCurrentTool("select");
}

function focusShape(editor: Editor, id: TLShapeId) {
  editor.select(id);
  editor.zoomToSelection({ animation: { duration: 180 } });
}
