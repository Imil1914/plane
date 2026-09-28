/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// hooks
import { CycleIcon } from "@plane/propel/icons";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent } from "./";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { PpmActivityPhrase } from "./helpers/ppm-activity";
// icons

type TIssueCycleActivity = { activityId: string; ends: "top" | "bottom" | undefined };

export const IssueCycleActivity = observer(function IssueCycleActivity(props: TIssueCycleActivity) {
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
      icon={<CycleIcon className="h-4 w-4 flex-shrink-0 text-secondary" />}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu ? (
        <PpmActivityPhrase
          phrase={
            activity.verb === "created"
              ? "ui.activity.cycle_added"
              : activity.verb === "updated"
                ? "ui.activity.cycle_set"
                : "ui.activity.cycle_removed"
          }
          values={{
            value: (
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/cycles/${
                  activity.verb === "created" || activity.verb === "updated"
                    ? activity.new_identifier
                    : activity.old_identifier
                }`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate">
                  {activity.verb === "created" || activity.verb === "updated" ? activity.new_value : activity.new_value}
                </span>
              </a>
            ),
          }}
        />
      ) : (
        <>
          {activity.verb === "created" ? (
            <>
              <span>added this work item to the cycle </span>
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/cycles/${activity.new_identifier}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate">{activity.new_value}</span>
              </a>
            </>
          ) : activity.verb === "updated" ? (
            <>
              <span>set the cycle to </span>
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/cycles/${activity.new_identifier}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate"> {activity.new_value}</span>
              </a>
            </>
          ) : (
            <>
              <span>removed the work item from the cycle </span>
              <a
                href={`/${activity.workspace_detail?.slug}/projects/${activity.project}/cycles/${activity.old_identifier}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-medium text-primary hover:underline"
              >
                <span className="truncate"> {activity.new_value}</span>
              </a>
            </>
          )}
        </>
      )}
    </IssueActivityBlockComponent>
  );
});
