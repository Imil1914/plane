/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import type { TPpmTranslationKey } from "@ppm/brand";
import { extractPpmServerErrorText, matchPpmServerError } from "@/components/ppm-shell/server-error";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export type TPpmServerErrorToast = { title: string; message: string };
export type TPpmServerErrorKeys = { title: TPpmTranslationKey; message: TPpmTranslationKey };

/**
 * Pure core of usePpmServerError. In the Russian PPM interface: a known server message is explained under the flow's
 * own title («Не удалось создать спринт»); an unknown one keeps the server text under «Что-то пошло не так»; no text
 * at all — the flow's own message. In any other language and without the PPM shell — the upstream toast as is.
 */
export function resolvePpmServerError(
  isPpmRu: boolean,
  translate: (key: TPpmTranslationKey) => string,
  error: unknown,
  ppm: TPpmServerErrorKeys,
  upstream: TPpmServerErrorToast
): TPpmServerErrorToast {
  if (!isPpmRu) return upstream;
  const text = extractPpmServerErrorText(error);
  const known = matchPpmServerError(text);
  if (known) return { title: translate(ppm.title), message: translate(known) };
  if (text) return { title: translate("ui.error.something_went_wrong"), message: text };
  return { title: translate(ppm.title), message: translate(ppm.message) };
}

/** Error toast text for a failed API call, see resolvePpmServerError. */
export function usePpmServerError(): (
  error: unknown,
  ppm: TPpmServerErrorKeys,
  upstream: TPpmServerErrorToast
) => TPpmServerErrorToast {
  const isPpmRu = usePpmRu();
  const ppmT = usePpmTranslation();

  return useCallback(
    (error, ppm, upstream) => resolvePpmServerError(isPpmRu, ppmT, error, ppm, upstream),
    [ppmT, isPpmRu]
  );
}
