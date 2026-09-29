/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useParams } from "next/navigation";
import { Outlet } from "react-router";
// components
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { usePpmRealtimeCycleOrModuleIssuesSync } from "@/components/ppm-realtime/use-ppm-realtime";
import { CycleIssuesHeader } from "./header";
import { CycleIssuesMobileHeader } from "./mobile-header";

export default function ProjectCycleIssuesLayout() {
  const { workspaceSlug, projectId, cycleId } = useParams();
  // PPM line U-Web (UX2.1 U7, review round 1): this sprint's own issue list re-reads itself when a colleague
  // adds/removes/moves an issue in the project, or changes this sprint directly — reuses the project layout's own
  // events subscription, no socket subscription of its own.
  usePpmRealtimeCycleOrModuleIssuesSync(workspaceSlug, projectId, "cycle", cycleId);

  return (
    <>
      <AppHeader header={<CycleIssuesHeader />} mobileHeader={<CycleIssuesMobileHeader />} />
      <ContentWrapper>
        <Outlet />
      </ContentWrapper>
    </>
  );
}
