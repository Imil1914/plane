/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { TriangleAlert } from "lucide-react";
import { cn } from "@plane/utils";
import { usePpmText } from "@/hooks/use-ppm-text";

type Props = {
  className?: string;
  onDismiss?: () => void;
};

export function ContentLimitBanner({ className, onDismiss }: Props) {
  const ppmText = usePpmText();
  return (
    <div className={cn("text-sm flex items-center gap-2 border-b border-subtle-1 bg-layer-2 px-4 py-2.5", className)}>
      <div className="mx-auto flex items-center gap-2 text-secondary">
        <span className="text-amber-500">
          <TriangleAlert />
        </span>
        <span className="font-medium">
          {ppmText(
            "ui.page.content_limit",
            "Content limit reached and live sync is off. Create a new page or use nested pages to continue syncing."
          )}
        </span>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto text-placeholder hover:text-secondary"
          aria-label={ppmText("ui.page.content_limit_dismiss", "Dismiss content limit warning")}
        >
          ✕
        </button>
      )}
    </div>
  );
}
