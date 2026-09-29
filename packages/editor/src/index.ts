/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// editors
export {
  CollaborativeDocumentEditorWithRef,
  DocumentEditorWithRef,
  LiteTextEditorWithRef,
  RichTextEditorWithRef,
} from "@/components/editors";

// constants
export * from "@/constants/common";

// helpers
export * from "@/helpers/common";
export * from "@/helpers/yjs-utils";
// PPM (line R2): the host app registers the editor's interface texts (the Russian PPM interface)
export { setEditorTextResolver } from "@/helpers/ppm-text";
export type { TEditorTextResolver } from "@/helpers/ppm-text";
// PPM (G2.3, line G-Web): the host app registers the «Коммит или PR» "/" dialog opener
export { setG23InsertGitObjectHandler } from "@/plane-editor/extensions/g23-insert-git-object-bridge";
export type {
  TG23InsertGitObjectContext,
  TG23InsertGitObjectHandler,
} from "@/plane-editor/extensions/g23-insert-git-object-bridge";

export { CORE_EXTENSIONS } from "@/constants/extension";
export { ADDITIONAL_EXTENSIONS } from "@/plane-editor/constants/extensions";

// types
export * from "@/types";

// additional exports
export { TrailingNode } from "./core/extensions/trailing-node";
