/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { getPpmCancelledStorageKey, parsePpmExpandedGroups, togglePpmExpandedGroup } from "./list-groups";

function readExpanded(projectId: string | undefined): string[] {
  if (!projectId || typeof window === "undefined") return [];
  try {
    return parsePpmExpandedGroups(window.localStorage.getItem(getPpmCancelledStorageKey(projectId)));
  } catch {
    return [];
  }
}

function writeExpanded(projectId: string, ids: string[]): void {
  try {
    window.localStorage.setItem(getPpmCancelledStorageKey(projectId), JSON.stringify(ids));
  } catch {
    // localStorage недоступен: раскрытие живёт до перезагрузки, сохранённые фильтры не трогаем
  }
}

/** «Отменена» свёрнута по умолчанию; раскрытие хранится локально по проекту (не в kanban_filters). */
export function usePpmExpandedCancelledGroups(projectId: string | undefined) {
  const [expandedIds, setExpandedIds] = useState<string[]>(() => readExpanded(projectId));

  useEffect(() => {
    setExpandedIds(readExpanded(projectId));
  }, [projectId]);

  const toggle = useCallback(
    (groupId: string) => {
      if (!projectId) return;
      const next = togglePpmExpandedGroup(readExpanded(projectId), groupId);
      writeExpanded(projectId, next);
      setExpandedIds(next);
    },
    [projectId]
  );

  const expand = useCallback(
    (groupId: string) => {
      if (!projectId) return;
      const current = readExpanded(projectId);
      if (current.includes(groupId)) return;
      const next = [...current, groupId];
      writeExpanded(projectId, next);
      setExpandedIds(next);
    },
    [projectId]
  );

  const isExpanded = useCallback((groupId: string) => expandedIds.includes(groupId), [expandedIds]);

  return { isExpanded, toggle, expand };
}
