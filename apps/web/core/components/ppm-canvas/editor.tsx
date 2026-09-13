/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
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
import { Tldraw, createShapeId, useEditor, useValue, type Editor, type TLComponents, type TLShapeId } from "tldraw";
import {
  createPpmCanvasNode,
  getPpmCanvasPersistenceKey,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  type TPpmCanvasNodeKind,
} from "@ppm/canvas";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PPM_CANVAS_SHAPE_TYPE, PpmCanvasNodeShapeUtil, type TPpmCanvasShape } from "./shape";
// oxlint-disable-next-line import/no-unassigned-import -- tldraw owns the canvas interaction styles
import "tldraw/tldraw.css";
// oxlint-disable-next-line import/no-unassigned-import -- PPM theme is intentionally scoped to this route
import "./canvas.css";

type TPpmCanvasEditorProps = {
  authorId: string;
  canEdit: boolean;
  projectId: string;
  workspaceSlug: string;
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

export default function PpmCanvasEditor({ authorId, canEdit, projectId, workspaceSlug }: TPpmCanvasEditorProps) {
  const components = useMemo<TLComponents>(
    () => ({
      ...HIDDEN_TLDRAW_UI,
      InFrontOfTheCanvas: () => <CanvasControls authorId={authorId} canEdit={canEdit} />,
    }),
    [authorId, canEdit]
  );
  const persistenceKey = getPpmCanvasPersistenceKey(workspaceSlug, projectId, authorId);

  return (
    <div className="ppm-canvas-shell" data-ppm-canvas-mode={canEdit ? "edit" : "read"}>
      <Tldraw
        cameraOptions={{ wheelBehavior: "pan" }}
        components={components}
        persistenceKey={persistenceKey}
        shapeUtils={[PpmCanvasNodeShapeUtil]}
        onMount={(editor) => {
          editor.updateInstanceState({ isReadonly: !canEdit });
        }}
      />
    </div>
  );
}

function CanvasControls({ authorId, canEdit }: { authorId: string; canEdit: boolean }) {
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
            <span>{ppmT(canEdit ? "canvas.saved_local" : "canvas.read_only_title")}</span>
          </div>
        </div>
        {canEdit && <p className="ppm-canvas-status__notice">{ppmT("canvas.local_notice")}</p>}
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
