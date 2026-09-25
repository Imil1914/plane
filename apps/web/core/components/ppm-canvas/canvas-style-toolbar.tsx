// AF2.1 R3 (line R): the compact style toolbar above the selection (K2 shape, K3 sticker). Colour for everything (PPM
// palette), text size S/M/L, bold (stickers), shape/fill/font (by type). A leaf child of <Tldraw> under the v2 grammar.
// What the selection offers and how each change is applied live in canvas-toolkit-actions.ts (tested in node).
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, Ellipsis } from "lucide-react";
import { Box, TldrawUiContextualToolbar, computed, isUninitialized, preventDefault, useEditor, useValue } from "tldraw";
import { PPM_CANVAS_COLORS, type TPpmCanvasColor } from "@ppm/canvas";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { fillCanvasTemplate } from "./canvas-grammar";
import { PpmGeoGlyph } from "./canvas-rail";
import {
  PPM_STYLE_BUSY_STATES,
  applyPpmFill,
  applyPpmFont,
  applyPpmGeo,
  applyPpmStyleColor,
  applyPpmTextSize,
  isSameStyleSelection,
  styleSelectionStep,
  togglePpmStickerBold,
  type TPpmStyleSelection,
} from "./canvas-toolkit-actions";
import { PPM_GEO_SHAPES, PPM_PALETTE_HEX, geoLabelKey, isPpmGeo, styleToolbarLift } from "./canvas-toolkit-model";

export type TPpmCanvasStyleToolbarProps = { canEdit: boolean };

type TPanel = "color" | "geo" | "more";

const SIZES = [
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
] as const;
const FILLS = [
  { value: "none", labelKey: "canvas.style.fill_none" },
  { value: "semi", labelKey: "canvas.style.fill_semi" },
  { value: "solid", labelKey: "canvas.style.fill_solid" },
] as const;
const FONTS = [
  { value: "draw", labelKey: "canvas.style.font_draw" },
  { value: "sans", labelKey: "canvas.style.font_sans" },
  { value: "serif", labelKey: "canvas.style.font_serif" },
  { value: "mono", labelKey: "canvas.style.font_mono" },
] as const;

/** ← → move between the buttons of the row or of the open panel (e.code: the same keys on any keyboard layout). */
function moveFocusWithArrows(event: ReactKeyboardEvent<HTMLElement>) {
  const step = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const index = buttons.findIndex((button) => button === event.target);
  if (index < 0) return;
  event.preventDefault();
  buttons[(index + step + buttons.length) % buttons.length]?.focus();
}

// A click never moves focus into the toolbar: while typing in a sticker the text editor keeps it (as tldraw's own
// rich-text toolbar does); the keyboard still reaches every button with Tab and ← →.
const GROUP_PROPS = { onKeyDown: moveFocusWithArrows, onPointerDown: preventDefault };

export function PpmCanvasStyleToolbar({ canEdit }: TPpmCanvasStyleToolbarProps) {
  const editor = useEditor();
  const ppmT = usePpmTranslation();
  const [panel, setPanel] = useState<TPanel>();
  // A panel belongs to the selection it was opened for: «Форма» must not stay open over a sticker selected next.
  const selectedIds = useValue("ppm style ids", () => editor.getSelectedShapeIds(), [editor]);
  useEffect(() => setPanel(undefined), [selectedIds]);
  // Everything the toolbar shows comes from one computed: equal results keep React still, and while the selection is
  // being moved nothing is recomputed at all (styleSelectionStep keeps the previous value).
  const selection$ = useMemo(
    () =>
      computed<TPpmStyleSelection | undefined>(
        "ppm style selection",
        (previous) =>
          canEdit ? styleSelectionStep(editor, isUninitialized(previous) ? undefined : previous) : undefined,
        { isEqual: isSameStyleSelection }
      ),
    [canEdit, editor]
  );
  const selection = useValue(selection$);
  const busy = useValue("ppm style busy", () => editor.isInAny(...PPM_STYLE_BUSY_STATES), [editor]);
  const getSelectionBounds = useCallback(() => {
    const bounds = editor.getSelectionScreenBounds();
    if (!bounds) return undefined;
    // Above the top «+» of a single shape or card (K2) — unless that would push the toolbar off the top edge.
    const lift = styleToolbarLift(editor.getOnlySelectedShape()?.type, bounds.y - editor.getViewportScreenBounds().y);
    return new Box(bounds.x, bounds.y - lift, bounds.width, 0);
  }, [editor]);

  if (!selection) return null;

  const togglePanel = (next: TPanel) => setPanel((current) => (current === next ? undefined : next));
  const colorName = selection.color ? ppmT(`canvas.palette.${selection.color}` as TPpmTranslationKey) : undefined;
  const geoKey = selection.geo ? geoLabelKey(selection.geo) : undefined;
  const swatch = (value: TPpmCanvasColor) => ({
    background: `var(--ppm-palette-${value}-fill, ${PPM_PALETTE_HEX.light[value].fill})`,
    borderColor: `var(--ppm-palette-${value}-stroke, ${PPM_PALETTE_HEX.light[value].stroke})`,
  });

  return (
    <TldrawUiContextualToolbar
      className="ppm-canvas-style-toolbar"
      getSelectionBounds={getSelectionBounds}
      isMousingDown={busy}
      label={ppmT(selection.labelKey)}
    >
      {/* The row comes first for Tab and screen readers; CSS (column-reverse) draws the open panel above it (K2). */}
      <div className="ppm-canvas-style-toolbar__row" {...GROUP_PROPS}>
        <button
          type="button"
          className="ppm-canvas-style-toolbar__color"
          aria-expanded={panel === "color"}
          aria-label={
            colorName
              ? fillCanvasTemplate(ppmT("canvas.style.color_value"), { name: colorName })
              : ppmT("canvas.style.color")
          }
          title={ppmT("canvas.style.color")}
          onClick={() => togglePanel("color")}
        >
          <span
            className="ppm-canvas-style-toolbar__dot"
            style={selection.color ? swatch(selection.color) : undefined}
            aria-hidden="true"
          />
          <ChevronDown aria-hidden="true" />
        </button>
        {selection.showSize && (
          <div className="ppm-canvas-style-toolbar__sizes" role="group" aria-label={ppmT("canvas.style.text")}>
            <span className="ppm-canvas-style-toolbar__label" aria-hidden="true">
              {ppmT("canvas.style.text")}
            </span>
            <span className="ppm-canvas-style-toolbar__segmented">
              {SIZES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={fillCanvasTemplate(ppmT("canvas.style.text_size"), { size: option.label })}
                  aria-pressed={selection.size === option.value}
                  onClick={() => applyPpmTextSize(editor, option.value)}
                >
                  {option.label}
                </button>
              ))}
            </span>
          </div>
        )}
        {selection.showBold && (
          <button
            type="button"
            className="ppm-canvas-style-toolbar__bold"
            aria-label={ppmT("canvas.style.bold")}
            aria-pressed={selection.bold}
            title={ppmT("canvas.style.bold")}
            onClick={() => togglePpmStickerBold(editor, selection)}
          >
            {/* K3: the letter of the UI language — «Ж» in Russian, «B» in English. */}
            <span aria-hidden="true">{ppmT("canvas.style.bold_short")}</span>
          </button>
        )}
        {selection.showGeo && (
          <button
            type="button"
            className="ppm-canvas-style-toolbar__geo"
            aria-expanded={panel === "geo"}
            aria-label={
              geoKey
                ? fillCanvasTemplate(ppmT("canvas.style.shape_value"), { name: ppmT(geoKey) })
                : ppmT("canvas.style.shape")
            }
            onClick={() => togglePanel("geo")}
          >
            {selection.geo && isPpmGeo(selection.geo) && <PpmGeoGlyph geo={selection.geo} />}
            <span>{ppmT("canvas.style.shape")}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        )}
        {selection.showMore && (
          <button
            type="button"
            aria-expanded={panel === "more"}
            aria-label={ppmT("canvas.style.more")}
            title={ppmT("canvas.style.more")}
            onClick={() => togglePanel("more")}
          >
            <Ellipsis aria-hidden="true" />
          </button>
        )}
      </div>
      {panel === "color" && (
        <div
          className="ppm-canvas-style-toolbar__panel"
          role="group"
          aria-label={ppmT("canvas.style.color_title")}
          {...GROUP_PROPS}
        >
          <header>
            <span>{ppmT("canvas.style.color")}</span>
            {colorName && <strong>{colorName}</strong>}
          </header>
          <div className="ppm-canvas-style-toolbar__swatches">
            {PPM_CANVAS_COLORS.map((value) => (
              <button
                key={value}
                type="button"
                className="ppm-canvas-style-toolbar__swatch"
                aria-label={ppmT(`canvas.palette.${value}` as TPpmTranslationKey)}
                aria-pressed={selection.color === value}
                style={swatch(value)}
                title={ppmT(`canvas.palette.${value}` as TPpmTranslationKey)}
                onClick={() => {
                  applyPpmStyleColor(editor, selection, value);
                  setPanel(undefined);
                }}
              />
            ))}
          </div>
        </div>
      )}
      {panel === "geo" && selection.showGeo && (
        <div
          className="ppm-canvas-style-toolbar__panel"
          role="group"
          aria-label={ppmT("canvas.style.shape")}
          {...GROUP_PROPS}
        >
          <div className="ppm-canvas-style-toolbar__shapes">
            {PPM_GEO_SHAPES.map((shape) => (
              <button
                key={shape.geo}
                type="button"
                aria-label={ppmT(shape.labelKey)}
                aria-pressed={selection.geo === shape.geo}
                title={ppmT(shape.labelKey)}
                onClick={() => {
                  applyPpmGeo(editor, shape.geo);
                  setPanel(undefined);
                }}
              >
                <PpmGeoGlyph geo={shape.geo} />
              </button>
            ))}
          </div>
        </div>
      )}
      {panel === "more" && selection.showMore && (
        <div
          className="ppm-canvas-style-toolbar__panel"
          role="group"
          aria-label={ppmT("canvas.style.more")}
          {...GROUP_PROPS}
        >
          {selection.showGeo && (
            <div className="ppm-canvas-style-toolbar__choices" role="group" aria-label={ppmT("canvas.style.fill")}>
              <span className="ppm-canvas-style-toolbar__label">{ppmT("canvas.style.fill")}</span>
              {FILLS.map((fill) => (
                <button
                  key={fill.value}
                  type="button"
                  aria-pressed={selection.fill === fill.value}
                  onClick={() => applyPpmFill(editor, fill.value)}
                >
                  {ppmT(fill.labelKey)}
                </button>
              ))}
            </div>
          )}
          <div className="ppm-canvas-style-toolbar__choices" role="group" aria-label={ppmT("canvas.style.font")}>
            <span className="ppm-canvas-style-toolbar__label">{ppmT("canvas.style.font")}</span>
            {FONTS.map((font) => (
              <button
                key={font.value}
                type="button"
                aria-pressed={selection.font === font.value}
                onClick={() => applyPpmFont(editor, font.value)}
              >
                {ppmT(font.labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}
    </TldrawUiContextualToolbar>
  );
}
