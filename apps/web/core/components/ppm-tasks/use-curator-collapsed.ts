/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState } from "react";

export const PPM_CURATOR_COLLAPSED_KEY = "ppm_tasks_curator_collapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PPM_CURATOR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Свёрнутость колонки — только localStorage устройства (без записи на сервер). */
export function usePpmCuratorCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        if (next) window.localStorage.setItem(PPM_CURATOR_COLLAPSED_KEY, "1");
        else window.localStorage.removeItem(PPM_CURATOR_COLLAPSED_KEY);
      } catch {
        // без localStorage колонка сворачивается до перезагрузки
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
