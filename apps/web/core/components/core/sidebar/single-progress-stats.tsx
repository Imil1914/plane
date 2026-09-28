/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { isPpmShellEnabled } from "@ppm/brand";
// hooks
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type TSingleProgressStatsProps = {
  title: any;
  completed: number;
  total: number;
  onClick?: () => void;
  selected?: boolean;
};

const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

export function SingleProgressStats({ title, completed, total, onClick, selected = false }: TSingleProgressStatsProps) {
  // PPM line S4: «0% из 1» in the Russian interface (upstream "of N" without the PPM shell)
  const ppmT = usePpmTranslation();
  return (
    <div
      className={`flex w-full items-center justify-between gap-4 rounded-xs p-1 text-11 ${
        onClick ? "cursor-pointer hover:bg-surface-2" : ""
      } ${selected ? "bg-layer-1" : ""}`}
      onClick={onClick}
    >
      <div className="w-4/6">{title}</div>
      <div className="flex w-2/6 items-center justify-end gap-1 px-2">
        <div className="flex h-5 items-center justify-center gap-1">
          <span className="w-8 text-right">
            {isNaN(Math.round((completed / total) * 100)) ? "0" : Math.round((completed / total) * 100)}%
          </span>
        </div>
        <span>{isPpmShell ? ppmT("stats.of_total").replace("{total}", String(total)) : `of ${total}`}</span>
      </div>
    </div>
  );
}
