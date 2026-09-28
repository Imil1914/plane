/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { PriorityPropertyIcon } from "@plane/propel/icons";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent, IssueLink } from "./";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { PpmActivityPhrase } from "./helpers/ppm-activity";
import type { TIssuePriorities } from "@plane/types";
import { usePpmPriorityTitle } from "@/components/ppm-shell/priority-title";

type TIssuePriorityActivity = { activityId: string; showIssue?: boolean; ends: "top" | "bottom" | undefined };

export const IssuePriorityActivity = observer(function IssuePriorityActivity(props: TIssuePriorityActivity) {
  const isPpmRu = usePpmRu();
  const { activityId, showIssue = true, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const priorityTitle = usePpmPriorityTitle();
  const activity = getActivityById(activityId);

  if (!activity) return <></>;
  return (
    <IssueActivityBlockComponent
      icon={<PriorityPropertyIcon className="h-3.5 w-3.5 text-secondary" aria-hidden="true" />}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu ? (
        <PpmActivityPhrase
          phrase="ui.activity.priority"
          values={{
            value: (
              <span className="font-medium text-primary">
                {priorityTitle(activity.new_value?.toLowerCase() as TIssuePriorities, activity.new_value ?? "")}
              </span>
            ),
          }}
          issue={showIssue ? <IssueLink activityId={activityId} /> : undefined}
        />
      ) : (
        <>
          set the priority to <span className="font-medium text-primary">{activity.new_value}</span>
          {showIssue ? ` for ` : ``}
          {showIssue && <IssueLink activityId={activityId} />}.
        </>
      )}
    </IssueActivityBlockComponent>
  );
});
