/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { Tooltip } from "@plane/propel/tooltip";
// hooks
import useOnlineStatus from "@/hooks/use-online-status";
// store
import type { TPageInstance } from "@/store/pages/base-page";
import { usePpmText } from "@/hooks/use-ppm-text";

type Props = {
  page: TPageInstance;
};

export const PageOfflineBadge = observer(function PageOfflineBadge({ page }: Props) {
  const ppmText = usePpmText();
  // use online status
  const { isOnline } = useOnlineStatus();

  if (!page.isContentEditable || isOnline) return null;

  return (
    <Tooltip
      tooltipHeading={ppmText("ui.page.offline_title", "You are offline.")}
      tooltipContent={ppmText(
        "ui.page.offline_hint",
        "You can continue making changes. They will be synced when you are back online."
      )}
    >
      <div className="flex h-7 flex-shrink-0 items-center gap-2 rounded-full bg-layer-1 px-3 py-0.5 text-11 font-medium text-tertiary">
        <span className="size-1.5 flex-shrink-0 rounded-full bg-layer-1" />
        <span>{ppmText("ui.page.offline", "Offline")}</span>
      </div>
    </Tooltip>
  );
});
