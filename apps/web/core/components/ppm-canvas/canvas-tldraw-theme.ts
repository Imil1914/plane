// AF2.1 R2 (line R): the PPM palette for tldraw's native shapes. DefaultColorThemePalette is a global object; under v2
// it holds the PPM values (K2/K3), under v1 tldraw's originals (v1 = end of UX1.1). editor.tsx calls
// getPpmCanvasShapeUtils(grammarV2) in a useMemo before <Tldraw> mounts; the design never changes within a page load.
import { DefaultColorThemePalette, FrameShapeUtil, NoteShapeUtil, type TLAnyShapeUtilConstructor } from "tldraw";
import { paintPpmColorTheme } from "./canvas-toolkit-model";
import { PpmCanvasNodeShapeUtil } from "./shape";

const ORIGINAL_PALETTE = {
  lightMode: structuredClone(DefaultColorThemePalette.lightMode),
  darkMode: structuredClone(DefaultColorThemePalette.darkMode),
};

const PPM_PALETTE = {
  lightMode: paintPpmColorTheme(ORIGINAL_PALETTE.lightMode, "light"),
  darkMode: paintPpmColorTheme(ORIGINAL_PALETTE.darkMode, "dark"),
};

// Stickers scale like in Miro (text grows with them); frames show their palette colour on the heading and fill.
const PpmNoteShapeUtil = NoteShapeUtil.configure({ resizeMode: "scale" });
const PpmFrameShapeUtil = FrameShapeUtil.configure({ showColors: true });

export function applyPpmCanvasTldrawTheme(grammarV2: boolean): void {
  const source = grammarV2 ? PPM_PALETTE : ORIGINAL_PALETTE;
  Object.assign(DefaultColorThemePalette.lightMode, structuredClone(source.lightMode));
  Object.assign(DefaultColorThemePalette.darkMode, structuredClone(source.darkMode));
}

export function getPpmCanvasShapeUtils(grammarV2: boolean): TLAnyShapeUtilConstructor[] {
  applyPpmCanvasTldrawTheme(grammarV2);
  return grammarV2 ? [PpmCanvasNodeShapeUtil, PpmNoteShapeUtil, PpmFrameShapeUtil] : [PpmCanvasNodeShapeUtil];
}
