/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
// plane imports
import { Loader } from "@plane/ui";
// local imports
import { useCycleLiveStats } from "../active-cycle/use-cycle-live-stats";
import useCyclesDetails from "../active-cycle/use-cycles-details";
import { CycleAnalyticsProgress } from "./issue-progress";
import { CycleSidebarDetails } from "./sidebar-details";
import { CycleSidebarHeader } from "./sidebar-header";

type Props = {
  handleClose: () => void;
  isArchived?: boolean;
  cycleId: string;
  projectId: string;
  workspaceSlug: string;
};

export const CycleDetailsSidebar = observer(function CycleDetailsSidebar(props: Props) {
  const { handleClose, isArchived, projectId, workspaceSlug, cycleId } = props;

  // store hooks
  const { cycle: cycleDetails } = useCyclesDetails({
    workspaceSlug,
    projectId,
    cycleId,
  });
  // PPM line S: the sidebar's numbers and charts stay fresh while it is open
  useCycleLiveStats({ workspaceSlug, projectId, cycle: isArchived ? null : cycleDetails });

  if (!cycleDetails)
    return (
      <Loader className="px-5">
        <div className="space-y-2">
          <Loader.Item height="15px" width="50%" />
          <Loader.Item height="15px" width="30%" />
        </div>
        <div className="mt-8 space-y-3">
          <Loader.Item height="30px" />
          <Loader.Item height="30px" />
          <Loader.Item height="30px" />
        </div>
      </Loader>
    );

  return (
    <div className="relative pb-2">
      <div className="flex w-full flex-col gap-5">
        <CycleSidebarHeader
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          cycleDetails={cycleDetails}
          isArchived={isArchived}
          handleClose={handleClose}
        />
        <CycleSidebarDetails projectId={projectId} cycleDetails={cycleDetails} />
      </div>

      {workspaceSlug && projectId && cycleDetails?.id && (
        <CycleAnalyticsProgress workspaceSlug={workspaceSlug} projectId={projectId} cycleId={cycleDetails?.id} />
      )}
    </div>
  );
});
