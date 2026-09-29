/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { setEditorTextResolver } from "@plane/editor";
import { PPM_TRANSLATIONS } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmRu } from "@/hooks/use-ppm-text";

/** The Russian PPM text of an editor key (`ui.editor.*` in @ppm/brand); undefined for a key PPM does not know. */
export function resolvePpmEditorText(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PPM_TRANSLATIONS.ru, key)
    ? PPM_TRANSLATIONS.ru[key as TPpmTranslationKey]
    : undefined;
}

/**
 * Line R2-4: @plane/editor reads its own interface texts (menu «/», formatting toolbar, link/table/image menus,
 * placeholders, upload errors) through `editorText`. Every editor wrapper and toolbar of the web calls this hook while
 * it renders — before the editor renders its menus, like PpmDateLanguage does for the dates: the Russian PPM interface
 * registers the PPM dictionary, any other language and PPM_SHELL_ENABLED=0 leave the editor's upstream English.
 */
export function usePpmEditorLanguage(): void {
  const isPpmRu = usePpmRu();
  setEditorTextResolver(isPpmRu ? resolvePpmEditorText : null);
}
