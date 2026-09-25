// AF2.1 R4 (line R): four «+» around one selected shape or PPM card (K2). Click → «Продолжить» menu → a connected
// shape in edit mode; drag → an arrow to a point or to another shape. Stickers keep tldraw's own clone «+» (ruling R1).
// A leaf child of <Tldraw> under the v2 grammar (editor.tsx). The «+» and the menu follow the shape and the camera
// through tldraw's reactive `react`, which writes their positions into the DOM — no React render per camera frame.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { Ellipsis, Plus } from "lucide-react";
import { react, useEditor, useValue, type Editor, type TLShape, type TLShapeId } from "tldraw";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate } from "./canvas-grammar";
import { PpmGeoGlyph } from "./canvas-rail";
import {
  connectToPoint,
  continueWithShape,
  quickConnectTargetAt,
  readQuickConnectTarget,
} from "./canvas-toolkit-actions";
import {
  PPM_GEO_SHAPES,
  PPM_QUICK_CONNECT_HANDLE_OFFSET,
  PPM_QUICK_CONNECT_SHAPES,
  geoLabelKey,
  isTopQuickConnectHandleCovered,
  quickConnectHandlePoints,
  quickConnectMenuFocus,
  quickConnectMenuOrigin,
  type TPpmDirection,
  type TPpmGeo,
} from "./canvas-toolkit-model";

export type TPpmCanvasQuickConnectProps = { authorId: string; canEdit: boolean };

const DIRECTIONS: readonly TPpmDirection[] = ["up", "right", "down", "left"];
const DIRECTION_KEYS = {
  up: "canvas.quick.up",
  right: "canvas.quick.right",
  down: "canvas.quick.down",
  left: "canvas.quick.left",
} as const;
// Up to this many screen px a press on «+» is a click (the menu); further, it is a drag (an arrow).
const DRAG_THRESHOLD = 4;

type TDrag = { direction: TPpmDirection; pointerId: number; startX: number; startY: number };
type TPicker = { direction: TPpmDirection; hover: TPpmGeo; more: boolean };
type TRedispatchedWheel = WheelEvent & { isSpecialRedispatchedEvent?: boolean };

/** Arrow keys, Home and End (by `e.code`) move the focus between the items of the «Продолжить» menu. */
function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const current = items.findIndex((item) => item === document.activeElement);
  const next = quickConnectMenuFocus(event.code, current, items.length);
  if (next === undefined) return;
  event.preventDefault();
  items[next]?.focus();
}

/** Viewport points (the canvas container's coordinates) of the four «+» around the shape. */
function handlePoints(editor: Editor, id: TLShapeId) {
  const bounds = editor.getShapePageBounds(id);
  if (!bounds) return undefined;
  const topLeft = editor.pageToViewport({ x: bounds.x, y: bounds.y });
  const zoom = editor.getZoomLevel();
  return quickConnectHandlePoints(
    { x: topLeft.x, y: topLeft.y, w: bounds.w * zoom, h: bounds.h * zoom },
    PPM_QUICK_CONNECT_HANDLE_OFFSET
  );
}

export function PpmCanvasQuickConnect({ canEdit }: TPpmCanvasQuickConnectProps) {
  const editor = useEditor();
  const rootRef = useRef<HTMLDivElement>(null);
  const target = useValue("ppm quick connect target", () => readQuickConnectTarget(editor, canEdit), [canEdit, editor]);

  // A wheel over a «+» or the menu pans and zooms the canvas, as over tldraw's own toolbars (usePassThroughWheelEvents).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      if ((event as TRedispatchedWheel).isSpecialRedispatchedEvent) return;
      event.preventDefault();
      const copy = Object.assign(new WheelEvent("wheel", event), { isSpecialRedispatchedEvent: true });
      editor.getContainer().querySelector(".tl-canvas")?.dispatchEvent(copy);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [editor]);

  return (
    <div ref={rootRef} className="ppm-canvas-quick-connect">
      {/* A menu or a drag belongs to the shape it started on: a new target starts clean. */}
      {target && <QuickConnectHandles key={target.id} editor={editor} rootRef={rootRef} target={target} />}
    </div>
  );
}

function QuickConnectHandles({
  editor,
  rootRef,
  target,
}: {
  editor: Editor;
  rootRef: RefObject<HTMLDivElement>;
  target: TLShape;
}) {
  const ppmT = usePpmTranslation();
  const [picker, setPicker] = useState<TPicker>();
  const [drag, setDrag] = useState<TDrag>();
  const handleRefs = useRef<Partial<Record<TPpmDirection, HTMLButtonElement | null>>>({});
  const lineRef = useRef<SVGLineElement>(null);
  const hintRef = useRef<TLShapeId>();

  // The «+» follow the shape and the camera: `react` writes their positions into the DOM, before the first paint.
  useLayoutEffect(
    () =>
      react("ppm quick connect handles", () => {
        const points = handlePoints(editor, target.id);
        if (!points) return;
        // Close to the top of the view tldraw pins the style toolbar (R3) over the top «+»: that one hides.
        const topCovered = isTopQuickConnectHandleCovered(points.up.y + PPM_QUICK_CONNECT_HANDLE_OFFSET);
        for (const direction of DIRECTIONS) {
          const handle = handleRefs.current[direction];
          if (!handle) continue;
          const { x, y } = points[direction];
          handle.style.setProperty("transform", `translate(${x}px, ${y}px) translate(-50%, -50%)`);
          const hidden = direction === "up" && topCovered;
          handle.style.visibility = hidden ? "hidden" : "";
          handle.tabIndex = hidden ? -1 : 0;
        }
      }),
    [editor, target.id]
  );

  // tldraw's hint outline marks the shape a dragged «+» would connect to; it goes away with the drag.
  useEffect(() => {
    if (!drag) return;
    return () => {
      if (!hintRef.current) return;
      hintRef.current = undefined;
      editor.setHintingShapes([]);
    };
  }, [drag, editor]);

  const closePicker = useCallback((focusDirection?: TPpmDirection) => {
    if (focusDirection) handleRefs.current[focusDirection]?.focus();
    setPicker(undefined);
  }, []);

  const togglePicker = (direction: TPpmDirection) =>
    setPicker((current) =>
      current?.direction === direction ? undefined : { direction, hover: "rectangle", more: false }
    );

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, direction: TPpmDirection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Captured: the canvas sees neither the moves nor the release, so tldraw never drags, brushes or deselects.
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ direction, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_THRESHOLD;
    const from = handlePoints(editor, target.id)?.[drag.direction];
    const screen = editor.getViewportScreenBounds();
    const to = moved ? { x: event.clientX - screen.x, y: event.clientY - screen.y } : from;
    if (lineRef.current && from && to) {
      lineRef.current.setAttribute("x1", String(from.x));
      lineRef.current.setAttribute("y1", String(from.y));
      lineRef.current.setAttribute("x2", String(to.x));
      lineRef.current.setAttribute("y2", String(to.y));
    }
    const pagePoint = editor.screenToPage({ x: event.clientX, y: event.clientY });
    const hit = moved ? quickConnectTargetAt(editor, target.id, pagePoint)?.id : undefined;
    if (hit === hintRef.current) return;
    hintRef.current = hit;
    editor.setHintingShapes(hit ? [hit] : []);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setDrag(undefined);
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= DRAG_THRESHOLD) {
      togglePicker(drag.direction);
      return;
    }
    setPicker(undefined);
    connectToPoint(editor, target.id, drag.direction, editor.screenToPage({ x: event.clientX, y: event.clientY }));
  };

  const cancelDrag = () => {
    if (drag) setDrag(undefined);
  };

  const choose = (geo: TPpmGeo) => {
    if (!picker) return;
    setPicker(undefined);
    continueWithShape(editor, target.id, picker.direction, geo);
  };

  return (
    <>
      {drag && (
        <svg className="ppm-canvas-quick-connect__drag" aria-hidden="true">
          <line ref={lineRef} />
        </svg>
      )}
      {DIRECTIONS.map((direction) => {
        const open = picker?.direction === direction;
        return (
          <button
            key={direction}
            ref={(element) => {
              handleRefs.current[direction] = element;
            }}
            type="button"
            className="ppm-canvas-quick-handle"
            data-direction={direction}
            data-active={open || undefined}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={fillCanvasTemplate(ppmT("canvas.quick.handle_hint"), {
              direction: ppmT(DIRECTION_KEYS[direction]),
            })}
            title={ppmT(DIRECTION_KEYS[direction])}
            onPointerDown={(event) => beginDrag(event, direction)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onClick={(event) => {
              // Enter / Space (detail 0); a pointer press is resolved on pointerup (click or drag).
              if (event.detail === 0) togglePicker(direction);
            }}
          >
            <Plus aria-hidden="true" />
          </button>
        );
      })}
      {picker && (
        <QuickConnectMenu
          key={picker.direction}
          editor={editor}
          picker={picker}
          rootRef={rootRef}
          targetId={target.id}
          onChoose={choose}
          onClose={closePicker}
          onUpdate={setPicker}
        />
      )}
    </>
  );
}

type TQuickConnectMenuProps = {
  editor: Editor;
  picker: TPicker;
  rootRef: RefObject<HTMLDivElement>;
  targetId: TLShapeId;
  onChoose: (geo: TPpmGeo) => void;
  onClose: (focusDirection?: TPpmDirection) => void;
  onUpdate: Dispatch<SetStateAction<TPicker | undefined>>;
};

/** K2 «Продолжить: прямоугольник · ромб · овал · параллелограмм · ещё», beside its «+». */
function QuickConnectMenu({ editor, onChoose, onClose, onUpdate, picker, rootRef, targetId }: TQuickConnectMenuProps) {
  const ppmT = usePpmTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  // Beside its «+», away from the shape, inside the viewport — following the camera like the «+» themselves.
  useLayoutEffect(
    () =>
      react("ppm quick connect menu", () => {
        const menu = menuRef.current;
        const handle = handlePoints(editor, targetId)?.[picker.direction];
        if (!menu || !handle) return;
        const viewport = editor.getViewportScreenBounds();
        const origin = quickConnectMenuOrigin(
          picker.direction,
          handle,
          { w: menu.offsetWidth, h: menu.offsetHeight },
          { w: viewport.w, h: viewport.h }
        );
        menu.style.setProperty("transform", `translate(${origin.x}px, ${origin.y}px)`);
      }),
    [editor, picker.direction, picker.more, targetId]
  );

  // The first shape takes the focus (again after «ещё»).
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [picker.more]);

  // Only while the menu is open (this component is mounted only then): Escape closes it back to its «+», a press or
  // the focus going elsewhere closes it.
  useEffect(() => {
    const root = rootRef.current;
    const outside = (node: EventTarget | null) => node instanceof Node && !root?.contains(node);
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event.target)) onClose();
    };
    const onFocusOut = (event: FocusEvent) => {
      // No relatedTarget: the window lost the focus or a focused item left the DOM («…») — not a choice to leave.
      if (outside(event.relatedTarget)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;
      // Ahead of tldraw's own Escape, which would drop the selection.
      event.stopPropagation();
      onClose(picker.direction);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    root?.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      root?.removeEventListener("focusout", onFocusOut);
    };
  }, [onClose, picker.direction, rootRef]);

  const shapes = picker.more ? PPM_GEO_SHAPES.map((shape) => shape.geo) : PPM_QUICK_CONNECT_SHAPES;
  const shapeName = (geo: TPpmGeo) => ppmT(geoLabelKey(geo) ?? "canvas.shape.rectangle");
  const withLink = ppmT("canvas.quick.with_link");
  const [captionBefore, captionAfter = ""] = withLink.split("{shape}");
  const hover = (geo: TPpmGeo) => onUpdate((current) => current && { ...current, hover: geo });

  return (
    <div
      ref={menuRef}
      className="ppm-canvas-quick-picker"
      role="menu"
      // Focusable, so a click on the menu's padding keeps the focus inside it (focusout would close it otherwise).
      tabIndex={-1}
      aria-label={ppmT("canvas.quick.continue_diagram")}
      data-direction={picker.direction}
      onKeyDown={moveMenuFocus}
    >
      <strong aria-hidden="true">{ppmT("canvas.quick.continue")}</strong>
      <div className="ppm-canvas-quick-picker__shapes">
        {shapes.map((geo) => (
          <button
            key={geo}
            type="button"
            role="menuitem"
            aria-label={fillCanvasTemplate(withLink, { shape: shapeName(geo) })}
            data-active={picker.hover === geo || undefined}
            title={shapeName(geo)}
            onFocus={() => hover(geo)}
            onMouseEnter={() => hover(geo)}
            onClick={() => onChoose(geo)}
          >
            <PpmGeoGlyph geo={geo} />
          </button>
        ))}
        {!picker.more && (
          <button
            type="button"
            role="menuitem"
            aria-label={ppmT("canvas.quick.more_shapes")}
            title={ppmT("canvas.quick.more_shapes")}
            onClick={() => onUpdate((current) => current && { ...current, more: true })}
          >
            <Ellipsis aria-hidden="true" />
          </button>
        )}
      </div>
      {/* K2: «Прямоугольник · сразу со связью» — the name of the shape under the pointer or focus. */}
      <small aria-hidden="true">
        {captionBefore}
        <strong>{shapeName(picker.hover)}</strong>
        {captionAfter}
      </small>
    </div>
  );
}
