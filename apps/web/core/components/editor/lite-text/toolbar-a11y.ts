import type { TPpmTranslationKey } from "@ppm/brand";

// Accessible names for the comment (lite) editor toolbar buttons (PPM_TRANSLATIONS,
// packages/ppm-brand/src/index.ts), keyed by ToolbarMenuItem.renderKey: it is unique per button, while
// the three alignment buttons share a single itemKey ("text-align").
export const LITE_TOOLBAR_A11Y_KEY: Readonly<Record<string, TPpmTranslationKey>> = {
  bold: "a11y.editor.bold",
  italic: "a11y.editor.italic",
  underline: "a11y.editor.underline",
  strikethrough: "a11y.editor.strikethrough",
  "text-align-left": "a11y.editor.align_left",
  "text-align-center": "a11y.editor.align_center",
  "text-align-right": "a11y.editor.align_right",
  "bulleted-list": "a11y.editor.bulleted-list",
  "numbered-list": "a11y.editor.numbered-list",
  "to-do-list": "a11y.editor.to-do-list",
  quote: "a11y.editor.quote",
  code: "a11y.editor.code",
  image: "a11y.editor.image",
};
