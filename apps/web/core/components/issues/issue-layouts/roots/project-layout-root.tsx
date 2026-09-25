/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import useSWR from "swr";
// plane constants
import { ISSUE_DISPLAY_FILTERS_BY_PAGE, PROJECT_VIEW_TRACKER_ELEMENTS } from "@plane/constants";
import { EIssueLayoutTypes, EIssuesStoreType } from "@plane/types";
import { Spinner } from "@plane/ui";
// components
import { ProjectLevelWorkItemFiltersHOC } from "@/components/work-item-filters/filters-hoc/project-level";
import { WorkItemFiltersRow } from "@/components/work-item-filters/filters-row";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useIssues } from "@/hooks/store/use-issues";
import { IssuesStoreContext } from "@/hooks/use-issue-layout-store";
import { usePpmDesignV2 } from "@/lib/ppm-design";
import { PpmTasksCuratorColumn } from "@/components/ppm-tasks/curator-column";
import { PpmTasksDataProvider } from "@/components/ppm-tasks/data-context";
// local imports
import { IssuePeekOverview } from "../../peek-overview";
import { CalendarLayout } from "../calendar/roots/project-root";
import { BaseGanttRoot } from "../gantt";
import { KanBanLayout } from "../kanban/roots/project-root";
import { ListLayout } from "../list/roots/project-root";
import { ProjectSpreadsheetLayout } from "../spreadsheet/roots/project-root";

function ProjectIssueLayout(props: { activeLayout: EIssueLayoutTypes | undefined }) {
  switch (props.activeLayout) {
    case EIssueLayoutTypes.LIST:
      return <ListLayout />;
    case EIssueLayoutTypes.KANBAN:
      return <KanBanLayout />;
    case EIssueLayoutTypes.CALENDAR:
      return <CalendarLayout />;
    case EIssueLayoutTypes.GANTT:
      return <BaseGanttRoot />;
    case EIssueLayoutTypes.SPREADSHEET:
      return <ProjectSpreadsheetLayout />;
    default:
      return null;
  }
}

function ProjectIssueLayoutScroller(props: {
  className: string;
  activeLayout: EIssueLayoutTypes | undefined;
  showMutationLoader: boolean;
}) {
  return (
    <div className={props.className}>
      {/* mutation loader */}
      {props.showMutationLoader && (
        <div className="fixed top-[70px] right-[20px] z-50 flex h-[40px] w-[40px] items-center justify-center rounded-sm bg-layer-1">
          <Spinner className="h-4 w-4" />
        </div>
      )}
      <ProjectIssueLayout activeLayout={props.activeLayout} />
    </div>
  );
}

/**
 * v2 only: the curator column hides while the peek is open. peekIssue is read here, not in ProjectLayoutRoot, so the
 * root (and the wave-0 v1 tree) does not re-render on every peek open/close.
 */
const PpmTasksCuratorSlot = observer(function PpmTasksCuratorSlot(props: { workspaceSlug: string; projectId: string }) {
  const { peekIssue } = useIssueDetail();
  if (peekIssue) return null;
  return <PpmTasksCuratorColumn workspaceSlug={props.workspaceSlug} projectId={props.projectId} />;
});

export const ProjectLayoutRoot = observer(function ProjectLayoutRoot() {
  // router
  const { workspaceSlug: routerWorkspaceSlug, projectId: routerProjectId } = useParams();
  const workspaceSlug = routerWorkspaceSlug ? routerWorkspaceSlug.toString() : undefined;
  const projectId = routerProjectId ? routerProjectId.toString() : undefined;
  // hooks
  const { issues, issuesFilter } = useIssues(EIssuesStoreType.PROJECT);
  // derived values
  const workItemFilters = projectId ? issuesFilter?.getIssueFilters(projectId) : undefined;
  const activeLayout = workItemFilters?.displayFilters?.layout;
  const isDesignV2 = usePpmDesignV2();

  useSWR(
    workspaceSlug && projectId ? `PROJECT_ISSUES_${workspaceSlug}_${projectId}` : null,
    async () => {
      if (workspaceSlug && projectId) {
        await issuesFilter?.fetchFilters(workspaceSlug, projectId);
      }
    },
    { revalidateIfStale: false, revalidateOnFocus: false }
  );

  if (!workspaceSlug || !projectId || !workItemFilters) return <></>;
  return (
    <IssuesStoreContext.Provider value={EIssuesStoreType.PROJECT}>
      <ProjectLevelWorkItemFiltersHOC
        enableSaveView
        entityType={EIssuesStoreType.PROJECT}
        entityId={projectId}
        filtersToShowByLayout={ISSUE_DISPLAY_FILTERS_BY_PAGE.issues.filters}
        initialWorkItemFilters={workItemFilters}
        updateFilters={issuesFilter?.updateFilterExpression.bind(issuesFilter, workspaceSlug, projectId)}
        projectId={projectId}
        workspaceSlug={workspaceSlug}
      >
        {({ filter: projectWorkItemsFilter }) => (
          <div className="relative flex h-full w-full flex-col overflow-hidden">
            {projectWorkItemsFilter && (
              <WorkItemFiltersRow
                filter={projectWorkItemsFilter}
                trackerElements={{
                  saveView: PROJECT_VIEW_TRACKER_ELEMENTS.PROJECT_HEADER_SAVE_AS_VIEW_BUTTON,
                }}
              />
            )}
            {isDesignV2 ? (
              <PpmTasksDataProvider
                workspaceSlug={workspaceSlug}
                projectId={projectId}
                enabled={activeLayout === EIssueLayoutTypes.LIST}
              >
                <div className="relative flex h-full w-full overflow-hidden">
                  <ProjectIssueLayoutScroller
                    className="relative h-full min-w-0 flex-1 overflow-auto bg-surface-1"
                    activeLayout={activeLayout}
                    showMutationLoader={issues?.getIssueLoader() === "mutation"}
                  />
                  {activeLayout === EIssueLayoutTypes.LIST && (
                    <PpmTasksCuratorSlot workspaceSlug={workspaceSlug} projectId={projectId} />
                  )}
                </div>
              </PpmTasksDataProvider>
            ) : (
              <ProjectIssueLayoutScroller
                className="relative h-full w-full overflow-auto bg-surface-1"
                activeLayout={activeLayout}
                showMutationLoader={issues?.getIssueLoader() === "mutation"}
              />
            )}
            {/* peek overview */}
            <IssuePeekOverview />
          </div>
        )}
      </ProjectLevelWorkItemFiltersHOC>
    </IssuesStoreContext.Provider>
  );
});
