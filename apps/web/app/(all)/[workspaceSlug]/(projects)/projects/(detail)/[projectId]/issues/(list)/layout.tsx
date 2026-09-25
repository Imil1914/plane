/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// components
import { Outlet } from "react-router";
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { PpmSprintScale } from "@/components/ppm-tasks/sprint-scale";
import { usePpmDesignV2 } from "@/lib/ppm-design";
import { ProjectIssuesHeader } from "./header";
import { ProjectIssuesMobileHeader } from "./mobile-header";

export default function ProjectIssuesLayout() {
  const isDesignV2 = usePpmDesignV2();
  return (
    <>
      <AppHeader header={<ProjectIssuesHeader />} mobileHeader={<ProjectIssuesMobileHeader />} />
      {isDesignV2 && <PpmSprintScale />}
      <ContentWrapper>
        <Outlet />
      </ContentWrapper>
    </>
  );
}
