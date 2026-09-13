/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
import { RefreshCw } from "lucide-react";
// types
import type { TNameDescriptionLoader } from "@plane/types";
import { isPpmShellEnabled } from "@ppm/brand";
// hooks
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type Props = {
  isSubmitting: TNameDescriptionLoader;
};

export const NameDescriptionUpdateStatus = observer(function NameDescriptionUpdateStatus(props: Props) {
  const { isSubmitting } = props;
  const ppmT = usePpmTranslation();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

  return (
    <>
      <div
        className={`flex items-center gap-x-2 transition-all duration-300 ${
          isSubmitting === "saved" ? "fade-out" : "fade-in"
        }`}
      >
        {isSubmitting !== "submitted" && isSubmitting !== "saved" && (
          <RefreshCw className="size-3.5 animate-spin stroke-tertiary" />
        )}
        <span className="text-13 text-tertiary">
          {isSubmitting === "submitting"
            ? isPpmShell
              ? ppmT("work_item.saving")
              : "Saving..."
            : isPpmShell
              ? ppmT("work_item.saved")
              : "Saved"}
        </span>
      </div>
    </>
  );
});
