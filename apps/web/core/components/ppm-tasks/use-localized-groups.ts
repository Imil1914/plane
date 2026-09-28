/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTranslation } from "@plane/i18n";
import type { IGroupByColumn, TIssueGroupByOptions } from "@plane/types";
import { useProjectState } from "@/hooks/store/use-project-state";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { getPpmStateDisplayName, usePpmDesignV2 } from "@/lib/ppm-design";
import { localizePpmGroupColumns } from "./list-groups";

/**
 * v2 — подписи групп PPM (UX1.1, на любом языке); v1 — русские подписи только в русском интерфейсе PPM (линия R),
 * иначе тот же массив. Вызывать только из observer-компонентов.
 */
export function usePpmLocalizedGroupColumns(
  groups: IGroupByColumn[] | undefined,
  groupBy: TIssueGroupByOptions | null | undefined,
  isEpic = false
): IGroupByColumn[] | undefined {
  const isPpmRu = usePpmRu();
  const isDesignV2 = usePpmDesignV2();
  const ppmT = usePpmTranslation();
  const { currentLocale } = useTranslation();
  const { getStateById } = useProjectState();
  if (!groups || !(isDesignV2 || isPpmRu)) return groups;
  return localizePpmGroupColumns(groups, {
    groupBy,
    isEpic,
    translate: ppmT,
    getStateName: (stateId) => getPpmStateDisplayName(getStateById(stateId), currentLocale),
  });
}
