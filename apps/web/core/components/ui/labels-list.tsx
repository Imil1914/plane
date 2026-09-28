/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// ui
import { Tooltip } from "@plane/propel/tooltip";
import type { IIssueLabel } from "@plane/types";
// types
import { usePlatformOS } from "@/hooks/use-platform-os";
import { usePpmCount, usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
// hooks

type IssueLabelsListProps = {
  labels?: (IIssueLabel | undefined)[];
  length?: number;
  showLength?: boolean;
};

export function IssueLabelsList(props: IssueLabelsListProps) {
  const isPpmRu = usePpmRu();
  const { labels } = props;
  const { isMobile } = usePlatformOS();
  const ppmText = usePpmText();
  const ppmCount = usePpmCount();
  return (
    <>
      {labels && (
        <>
          <Tooltip
            position="top"
            tooltipHeading={ppmText("ui.property.labels", "Labels")}
            tooltipContent={labels.map((l) => l?.name).join(", ")}
            isMobile={isMobile}
          >
            <div className="flex h-full items-center gap-1 rounded-sm border-[0.5px] border-strong px-2 py-1 text-11 text-secondary">
              <span className="h-2 w-2 flex-shrink-0 rounded-full bg-accent-primary" />
              {isPpmRu ? (
                <span>{ppmCount("ui.count.labels", labels.length)}</span>
              ) : (
                <>
                  <span>{labels.length}</span>
                  <span> Labels</span>
                </>
              )}
            </div>
          </Tooltip>
        </>
      )}
    </>
  );
}
