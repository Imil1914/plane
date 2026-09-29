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
import { ModuleIssuesHeader } from "./header";
import { ModuleIssuesMobileHeader } from "./mobile-header";

export default function ProjectModuleIssuesLayout() {
  const { workspaceSlug, projectId, moduleId } = useParams();
  // PPM line U-Web (UX2.1 U7, review round 1): this direction's own issue list re-reads itself when a colleague
  // adds/removes/moves an issue in the project, or changes this direction directly — reuses the project layout's own
  // events subscription, no socket subscription of its own.
  usePpmRealtimeCycleOrModuleIssuesSync(workspaceSlug, projectId, "module", moduleId);

  return (
    <>
      <AppHeader header={<ModuleIssuesHeader />} mobileHeader={<ModuleIssuesMobileHeader />} />
      <ContentWrapper>
        <Outlet />
      </ContentWrapper>
    </>
  );
}
