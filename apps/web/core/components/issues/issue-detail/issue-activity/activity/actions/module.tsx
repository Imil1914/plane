/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// hooks
import { ModuleIcon } from "@plane/propel/icons";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent } from "./";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { PpmActivityPhrase } from "./helpers/ppm-activity";
// icons

type TIssueModuleActivity = { activityId: string; ends: "top" | "bottom" | undefined };

export const IssueModuleActivity = observer(function IssueModuleActivity(props: TIssueModuleActivity) {
  const isPpmRu = usePpmRu();
  const { activityId, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const activity = getActivityById(activityId);

  if (!activity) return <></>;
  return (
    <IssueActivityBlockComponent
      icon={<ModuleIcon className="h-4 w-4 flex-shrink-0 text-secondary" />}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu ? (
        <PpmActivityPhrase
          phrase={
            activity.verb === "created"
              ? "ui.activity.module_added"
              : activity.verb === "updated"
                ? "ui.activity.module_set"
                : "ui.activity.module_removed"
          }
          values={{
            value: (
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/modules/${
                  activity.verb === "created" || activity.verb === "updated"
                    ? activity.new_identifier
                    : activity.old_identifier
                }`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate">
                  {activity.verb === "created" || activity.verb === "updated" ? activity.new_value : activity.old_value}
                </span>
              </a>
            ),
          }}
        />
      ) : (
        <>
          {activity.verb === "created" ? (
            <>
              <span>added this work item to the module </span>
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/modules/${activity.new_identifier}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate">{activity.new_value}</span>
              </a>
            </>
          ) : activity.verb === "updated" ? (
            <>
              <span>set the module to </span>
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/modules/${activity.new_identifier}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate"> {activity.new_value}</span>
              </a>
            </>
          ) : (
            <>
              <span>removed the work item from the module </span>
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/modules/${activity.old_identifier}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate"> {activity.old_value}</span>
              </a>
            </>
          )}
        </>
      )}
    </IssueActivityBlockComponent>
  );
});
