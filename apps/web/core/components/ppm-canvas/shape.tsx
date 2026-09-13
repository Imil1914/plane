/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  resizeBox,
  stopEventPropagation,
  useEditor,
  type Editor,
  type RecordProps,
  type TLBaseShape,
  type TLResizeInfo,
} from "tldraw";
import {
  createPpmCanvasNode,
  parseSerializedPpmCanvasNode,
  serializePpmCanvasNode,
  updatePpmCanvasNode,
  type TPpmCanvasNode,
} from "@ppm/canvas";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export const PPM_CANVAS_SHAPE_TYPE = "ppm-canvas-node" as const;

export type TPpmCanvasShape = TLBaseShape<
  typeof PPM_CANVAS_SHAPE_TYPE,
  {
    h: number;
    node: string;
    w: number;
  }
>;

const COLOR_CLASS: Record<TPpmCanvasNode["visual"]["color"], string> = {
  cyan: "ppm-canvas-node--cyan",
  green: "ppm-canvas-node--green",
  violet: "ppm-canvas-node--violet",
  yellow: "ppm-canvas-node--yellow",
};

export class PpmCanvasNodeShapeUtil extends ShapeUtil<TPpmCanvasShape> {
  static override type = PPM_CANVAS_SHAPE_TYPE;

  static override props: RecordProps<TPpmCanvasShape> = {
    h: T.number,
    node: T.string,
    w: T.number,
  };

  override getDefaultProps(): TPpmCanvasShape["props"] {
    const node = createPpmCanvasNode({ authorId: "unknown", kind: "note", title: "" });
    return {
      h: node.visual.height,
      node: serializePpmCanvasNode(node),
      w: node.visual.width,
    };
  }

  override getGeometry(shape: TPpmCanvasShape) {
    return new Rectangle2d({ height: shape.props.h, isFilled: true, width: shape.props.w });
  }

  override canEdit() {
    return true;
  }

  override canResize() {
    return true;
  }

  override component(shape: TPpmCanvasShape) {
    return <PpmCanvasNodeCard shape={shape} />;
  }

  override indicator(shape: TPpmCanvasShape) {
    return <rect height={shape.props.h} rx={12} ry={12} width={shape.props.w} />;
  }

  override onResize(shape: TPpmCanvasShape, info: TLResizeInfo<TPpmCanvasShape>) {
    const resized = resizeBox(shape, info, { minHeight: 96, minWidth: 160, maxHeight: 1200, maxWidth: 1600 });
    const parsed = parseSerializedPpmCanvasNode(shape.props.node);
    if (parsed.status === "unknown" || parsed.status === "corrupt") return resized;

    return {
      ...resized,
      props: {
        ...resized.props,
        node: serializePpmCanvasNode({
          ...parsed.node,
          visual: { ...parsed.node.visual, height: resized.props.h, width: resized.props.w },
        }),
      },
    };
  }
}

function PpmCanvasNodeCard({ shape }: { shape: TPpmCanvasShape }) {
  const ppmT = usePpmTranslation();
  const parsed = parseSerializedPpmCanvasNode(shape.props.node);

  if (parsed.status === "unknown" || parsed.status === "corrupt") {
    return (
      <HTMLContainer className="ppm-canvas-node ppm-canvas-node--fallback" data-ppm-canvas-node-state={parsed.status}>
        <strong>{ppmT(parsed.status === "unknown" ? "canvas.unknown_node" : "canvas.corrupt_node")}</strong>
        <span>{ppmT("canvas.fallback_description")}</span>
      </HTMLContainer>
    );
  }

  return (
    <HTMLContainer
      className={`ppm-canvas-node ppm-canvas-node--${parsed.node.kind} ${COLOR_CLASS[parsed.node.visual.color]}`}
      data-ppm-canvas-node-kind={parsed.node.kind}
    >
      <NodeEditor node={parsed.node} shape={shape} />
    </HTMLContainer>
  );
}

function NodeEditor({ node, shape }: { node: TPpmCanvasNode; shape: TPpmCanvasShape }) {
  const ppmT = usePpmTranslation();
  const editor = useEditor();

  return (
    <div className="ppm-canvas-node__content">
      <span className="ppm-canvas-node__kind">
        {ppmT(node.kind === "note" ? "canvas.note_title" : "canvas.group_title")}
      </span>
      <input
        aria-label={ppmT(node.kind === "note" ? "canvas.note_title" : "canvas.group_title")}
        className="ppm-canvas-node__title"
        disabled={editor.getInstanceState().isReadonly}
        maxLength={160}
        value={node.title}
        onChange={(event) => updateNode(editor, shape, node, { title: event.currentTarget.value })}
        onKeyDown={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      />
      <textarea
        aria-label={ppmT(node.kind === "note" ? "canvas.note_body_placeholder" : "canvas.group_body_placeholder")}
        className="ppm-canvas-node__body"
        disabled={editor.getInstanceState().isReadonly}
        maxLength={50_000}
        placeholder={ppmT(node.kind === "note" ? "canvas.note_body_placeholder" : "canvas.group_body_placeholder")}
        value={node.body}
        onChange={(event) => updateNode(editor, shape, node, { body: event.currentTarget.value })}
        onKeyDown={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      />
    </div>
  );
}

function updateNode(
  editor: Editor,
  shape: TPpmCanvasShape,
  node: TPpmCanvasNode,
  patch: Partial<Pick<TPpmCanvasNode, "body" | "title">>
) {
  editor.updateShape<TPpmCanvasShape>({
    id: shape.id,
    type: shape.type,
    props: { node: serializePpmCanvasNode(updatePpmCanvasNode(node, patch)) },
  });
}
