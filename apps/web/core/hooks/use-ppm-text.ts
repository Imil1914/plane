/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { useTranslation } from "@plane/i18n";
import { isPpmShellEnabled, resolvePpmLocale } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import { selectPpmPluralKey } from "@/components/ppm-tasks/sprint";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

/** The PPM shell flag (PPM_SHELL_ENABLED and PPM_BRAND_ENABLED). */
export const IS_PPM_SHELL_TEXT = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

/**
 * Line R: the PPM Russian texts replace upstream strings only in the Russian interface of the PPM shell. Any other
 * interface language (and PPM_SHELL_ENABLED=0) keeps the upstream text of the component byte for byte.
 */
export function isPpmRussianUi(shellEnabled: boolean, locale: string | undefined): boolean {
  return shellEnabled && resolvePpmLocale(locale) === "ru";
}

/** `isPpmRu` in components: true only in the Russian interface of the PPM shell. */
export function usePpmRu(): boolean {
  const { currentLocale } = useTranslation();
  return isPpmRussianUi(IS_PPM_SHELL_TEXT, currentLocale);
}

export type TPpmText = (key: TPpmTranslationKey, upstream: string, values?: Record<string, string | number>) => string;

/** Pure core of ppmText: the PPM key (with `{name}` filled) in the Russian PPM interface, the upstream text otherwise. */
export function resolvePpmText(
  isPpmRu: boolean,
  translate: (key: TPpmTranslationKey) => string,
  key: TPpmTranslationKey,
  upstream: string,
  values?: Record<string, string | number>
): string {
  if (!isPpmRu) return upstream;
  const text = translate(key);
  return values ? formatPpmTemplate(text, values) : text;
}

/**
 * Text for a place that used to show a hard-coded upstream string: the @ppm/brand key in the Russian interface of the
 * PPM shell; the upstream string exactly as before in any other language and with PPM_SHELL_ENABLED=0.
 */
export function usePpmText(): TPpmText {
  const ppmT = usePpmTranslation();
  const isPpmRu = usePpmRu();

  return useCallback<TPpmText>(
    (key, upstream, values) => resolvePpmText(isPpmRu, ppmT, key, upstream, values),
    [ppmT, isPpmRu]
  );
}

/** Keys that come in three plural forms: `<base>_one`, `<base>_few`, `<base>_many` (Russian «1 метка / 2 метки / 5 меток»). */
export type TPpmCountBase = {
  [K in TPpmTranslationKey]: K extends `${infer Base}_one`
    ? `${Base}_few` extends TPpmTranslationKey
      ? `${Base}_many` extends TPpmTranslationKey
        ? Base
        : never
      : never
    : never;
}[TPpmTranslationKey];

/** Pure core of usePpmCount: the plural form by the language rules (CLDR one/few/many) with `{count}` filled. */
export function formatPpmCount(
  base: TPpmCountBase,
  count: number,
  locale: string | undefined,
  translate: (key: TPpmTranslationKey) => string
): string {
  const form = selectPpmPluralKey(count, locale);
  const suffix = form === "one" ? "one" : form === "few" ? "few" : "many";
  return formatPpmTemplate(translate(`${base}_${suffix}` as TPpmTranslationKey), { count });
}

/** «{count} меток»: picks the plural form by the interface language and fills `{count}`. */
export function usePpmCount(): (base: TPpmCountBase, count: number) => string {
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();

  return useCallback((base, count) => formatPpmCount(base, count, currentLocale, ppmT), [ppmT, currentLocale]);
}
