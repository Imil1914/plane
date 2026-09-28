/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EIssueLayoutTypes, EIssuesStoreType } from "@plane/types";

// Линия B (просьба владельца 2026-09-28): выделение и панель массовых действий — в «Списке» и «Таблице» задач
// проекта, спринта, направления, видов, «Моих задач» (профиль) и видов пространства. «Доска», календарь и
// «Таймлайн» (его корни зовут хук без вида) — без выделения; эпики, архив и черновики — как было.
const PPM_BULK_LAYOUTS: ReadonlySet<EIssueLayoutTypes> = new Set([
  EIssueLayoutTypes.LIST,
  EIssueLayoutTypes.SPREADSHEET,
]);
const PPM_BULK_STORES: ReadonlySet<EIssuesStoreType> = new Set([
  EIssuesStoreType.PROJECT,
  EIssuesStoreType.CYCLE,
  EIssuesStoreType.MODULE,
  EIssuesStoreType.PROJECT_VIEW,
  EIssuesStoreType.PROFILE,
  EIssuesStoreType.GLOBAL,
]);

export function isPpmBulkSelectionEnabled(layout?: EIssueLayoutTypes, storeType?: EIssuesStoreType): boolean {
  return !!layout && !!storeType && PPM_BULK_LAYOUTS.has(layout) && PPM_BULK_STORES.has(storeType);
}

export const useBulkOperationStatus = (layout?: EIssueLayoutTypes, storeType?: EIssuesStoreType) =>
  isPpmBulkSelectionEnabled(layout, storeType);
