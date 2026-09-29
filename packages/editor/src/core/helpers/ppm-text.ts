/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * PPM: the editor's own interface texts (menu «/», formatting toolbar, colors, link/table/image menus, placeholders,
 * upload errors) can be replaced by the host app — the PPM web registers its Russian dictionary in the Russian
 * interface. Without a resolver (space, admin, live, any other language) every text is the upstream English literal.
 */
export type TEditorTextResolver = (key: string) => string | undefined;

let editorTextResolver: TEditorTextResolver | null = null;

/** Registers (or, with `null`, removes) the source of the editor texts; read on every render of a text. */
export const setEditorTextResolver = (resolver: TEditorTextResolver | null): void => {
  editorTextResolver = resolver;
};

/** The registered text for `key` with its `{name}` placeholders filled from `values`, or `upstream` as is. */
export const editorText = (key: string, upstream: string, values?: Record<string, string | number>): string => {
  const text = editorTextResolver?.(key);
  if (text === undefined) return upstream;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
};
