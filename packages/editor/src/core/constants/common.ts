/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { LucideIcon } from "lucide-react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CaseSensitive,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Strikethrough,
  Table,
  TextQuote,
  Underline,
} from "lucide-react";
import { MonospaceIcon, SansSerifIcon, SerifIcon } from "@plane/propel/icons";
// helpers
import { editorText } from "@/helpers/ppm-text";
import type { TCommandExtraProps, TEditorCommands, TEditorFontStyle } from "@/types";

export type TEditorTypes = "lite" | "document" | "sticky";

// Utility type to enforce the necessary extra props or make extraProps optional
export type ExtraPropsForCommand<T extends TEditorCommands> = T extends keyof TCommandExtraProps
  ? TCommandExtraProps[T]
  : object; // Default to empty object for commands without extra props

export type ToolbarMenuItem<T extends TEditorCommands = TEditorCommands> = {
  itemKey: T;
  renderKey: string;
  name: string;
  icon: LucideIcon;
  shortcut?: string[];
  editors: TEditorTypes[];
  extraProps?: ExtraPropsForCommand<T>;
};

// PPM (line R2): `name` and `label` below are getters — read at render time, in the language the host app registered
// (editorText); without a registration they are the upstream English. They stay after `editors`, where a11y tests look.
export const TYPOGRAPHY_ITEMS: ToolbarMenuItem<"text" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6">[] = [
  {
    itemKey: "text",
    renderKey: "text",
    icon: CaseSensitive,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.text", "Text");
    },
  },
  {
    itemKey: "h1",
    renderKey: "h1",
    icon: Heading1,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.heading_1", "Heading 1");
    },
  },
  {
    itemKey: "h2",
    renderKey: "h2",
    icon: Heading2,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.heading_2", "Heading 2");
    },
  },
  {
    itemKey: "h3",
    renderKey: "h3",
    icon: Heading3,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.heading_3", "Heading 3");
    },
  },
  {
    itemKey: "h4",
    renderKey: "h4",
    icon: Heading4,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.heading_4", "Heading 4");
    },
  },
  {
    itemKey: "h5",
    renderKey: "h5",
    icon: Heading5,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.heading_5", "Heading 5");
    },
  },
  {
    itemKey: "h6",
    renderKey: "h6",
    icon: Heading6,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.heading_6", "Heading 6");
    },
  },
];

export const TEXT_ALIGNMENT_ITEMS: ToolbarMenuItem<"text-align">[] = [
  {
    itemKey: "text-align",
    renderKey: "text-align-left",
    icon: AlignLeft,
    shortcut: ["Cmd", "Shift", "L"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.align_left", "Left align");
    },
    extraProps: {
      alignment: "left",
    },
  },
  {
    itemKey: "text-align",
    renderKey: "text-align-center",
    icon: AlignCenter,
    shortcut: ["Cmd", "Shift", "E"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.align_center", "Center align");
    },
    extraProps: {
      alignment: "center",
    },
  },
  {
    itemKey: "text-align",
    renderKey: "text-align-right",
    icon: AlignRight,
    shortcut: ["Cmd", "Shift", "R"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.align_right", "Right align");
    },
    extraProps: {
      alignment: "right",
    },
  },
];

const BASIC_MARK_ITEMS: ToolbarMenuItem<"bold" | "italic" | "underline" | "strikethrough">[] = [
  {
    itemKey: "bold",
    renderKey: "bold",
    icon: Bold,
    shortcut: ["Cmd", "B"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.bold", "Bold");
    },
  },
  {
    itemKey: "italic",
    renderKey: "italic",
    icon: Italic,
    shortcut: ["Cmd", "I"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.italic", "Italic");
    },
  },
  {
    itemKey: "underline",
    renderKey: "underline",
    icon: Underline,
    shortcut: ["Cmd", "U"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.underline", "Underline");
    },
  },
  {
    itemKey: "strikethrough",
    renderKey: "strikethrough",
    icon: Strikethrough,
    shortcut: ["Cmd", "Shift", "S"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.strikethrough", "Strikethrough");
    },
  },
];

const LIST_ITEMS: ToolbarMenuItem<"bulleted-list" | "numbered-list" | "to-do-list">[] = [
  {
    itemKey: "bulleted-list",
    renderKey: "bulleted-list",
    icon: List,
    shortcut: ["Cmd", "Shift", "7"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.bulleted_list", "Bulleted list");
    },
  },
  {
    itemKey: "numbered-list",
    renderKey: "numbered-list",
    icon: ListOrdered,
    shortcut: ["Cmd", "Shift", "8"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.numbered_list", "Numbered list");
    },
  },
  {
    itemKey: "to-do-list",
    renderKey: "to-do-list",
    icon: ListTodo,
    shortcut: ["Cmd", "Shift", "9"],
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.todo_list", "To-do list");
    },
  },
];

export const USER_ACTION_ITEMS: ToolbarMenuItem<"quote" | "code">[] = [
  {
    itemKey: "quote",
    renderKey: "quote",
    icon: TextQuote,
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.quote", "Quote");
    },
  },
  {
    itemKey: "code",
    renderKey: "code",
    icon: Code2,
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.code", "Code");
    },
  },
];

export const COMPLEX_ITEMS: ToolbarMenuItem<"table" | "image">[] = [
  {
    itemKey: "table",
    renderKey: "table",
    icon: Table,
    editors: ["document"],
    get name() {
      return editorText("ui.editor.table", "Table");
    },
  },
  {
    itemKey: "image",
    renderKey: "image",
    icon: Image,
    editors: ["lite", "document"],
    get name() {
      return editorText("ui.editor.image", "Image");
    },
  },
];

export const IMAGE_ITEM = COMPLEX_ITEMS.find((item): item is ToolbarMenuItem<"image"> => item.itemKey === "image")!;

export const TOOLBAR_ITEMS: {
  [editorType in TEditorTypes]: {
    [key: string]: ToolbarMenuItem[];
  };
} = {
  lite: {
    basic: BASIC_MARK_ITEMS.filter((item) => item.editors.includes("lite")),
    alignment: TEXT_ALIGNMENT_ITEMS.filter((item) => item.editors.includes("lite")),
    list: LIST_ITEMS.filter((item) => item.editors.includes("lite")),
    userAction: USER_ACTION_ITEMS.filter((item) => item.editors.includes("lite")),
    complex: COMPLEX_ITEMS.filter((item) => item.editors.includes("lite")),
  },
  document: {
    basic: BASIC_MARK_ITEMS.filter((item) => item.editors.includes("document")),
    alignment: TEXT_ALIGNMENT_ITEMS.filter((item) => item.editors.includes("document")),
    list: LIST_ITEMS.filter((item) => item.editors.includes("document")),
    userAction: USER_ACTION_ITEMS.filter((item) => item.editors.includes("document")),
    complex: COMPLEX_ITEMS.filter((item) => item.editors.includes("document")),
  },
  sticky: {
    basic: BASIC_MARK_ITEMS.filter((item) => ["bold", "italic"].includes(item.itemKey)),
    list: LIST_ITEMS.filter((item) => ["to-do-list"].includes(item.itemKey)),
  },
};

export const COLORS_LIST: {
  key: string;
  label: string;
  textColor: string;
  backgroundColor: string;
}[] = [
  {
    key: "gray",
    get label() {
      return editorText("ui.editor.color_gray", "Gray");
    },
    textColor: "var(--editor-colors-gray-text)",
    backgroundColor: "var(--editor-colors-gray-background)",
  },
  {
    key: "peach",
    get label() {
      return editorText("ui.editor.color_peach", "Peach");
    },
    textColor: "var(--editor-colors-peach-text)",
    backgroundColor: "var(--editor-colors-peach-background)",
  },
  {
    key: "pink",
    get label() {
      return editorText("ui.editor.color_pink", "Pink");
    },
    textColor: "var(--editor-colors-pink-text)",
    backgroundColor: "var(--editor-colors-pink-background)",
  },
  {
    key: "orange",
    get label() {
      return editorText("ui.editor.color_orange", "Orange");
    },
    textColor: "var(--editor-colors-orange-text)",
    backgroundColor: "var(--editor-colors-orange-background)",
  },
  {
    key: "green",
    get label() {
      return editorText("ui.editor.color_green", "Green");
    },
    textColor: "var(--editor-colors-green-text)",
    backgroundColor: "var(--editor-colors-green-background)",
  },
  {
    key: "light-blue",
    get label() {
      return editorText("ui.editor.color_light_blue", "Light blue");
    },
    textColor: "var(--editor-colors-light-blue-text)",
    backgroundColor: "var(--editor-colors-light-blue-background)",
  },
  {
    key: "dark-blue",
    get label() {
      return editorText("ui.editor.color_dark_blue", "Dark blue");
    },
    textColor: "var(--editor-colors-dark-blue-text)",
    backgroundColor: "var(--editor-colors-dark-blue-background)",
  },
  {
    key: "purple",
    get label() {
      return editorText("ui.editor.color_purple", "Purple");
    },
    textColor: "var(--editor-colors-purple-text)",
    backgroundColor: "var(--editor-colors-purple-background)",
  },
  // {
  //   key: "pink-blue-gradient",
  //   label: "Pink blue gradient",
  //   textColor: "var(--editor-colors-pink-blue-gradient-text)",
  //   backgroundColor: "var(--editor-colors-pink-blue-gradient-background)",
  // },
];

export const EDITOR_FONT_STYLES: {
  key: TEditorFontStyle;
  label: string;
  icon: React.FC;
}[] = [
  {
    key: "sans-serif",
    get label() {
      return editorText("ui.editor.font_sans", "Sans serif");
    },
    icon: SansSerifIcon,
  },
  {
    key: "serif",
    get label() {
      return editorText("ui.editor.font_serif", "Serif");
    },
    icon: SerifIcon,
  },
  {
    key: "monospace",
    get label() {
      return editorText("ui.editor.font_mono", "Mono");
    },
    icon: MonospaceIcon,
  },
];
