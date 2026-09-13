/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { useTranslation } from "@plane/i18n";
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";

export function usePpmTranslation() {
  const { currentLocale } = useTranslation();

  return useCallback((key: TPpmTranslationKey) => getPpmTranslation(currentLocale, key), [currentLocale]);
}
