/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// types
import type { TIssueRelationTypes } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { useTimeLineRelationOptions } from "@/components/relations";
// local helpers
import { IssueActivityBlockComponent } from "./";
import { getRelationActivityContent } from "./helpers/activity";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { getPpmRelationActivityPhrase } from "./helpers/activity";
import { PpmActivityPhrase } from "./helpers/ppm-activity";

type TIssueRelationActivity = { activityId: string; ends: "top" | "bottom" | undefined };

export const IssueRelationActivity = observer(function IssueRelationActivity(props: TIssueRelationActivity) {
  const isPpmRu = usePpmRu();
  const { activityId, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const activity = getActivityById(activityId);
  const ISSUE_RELATION_OPTIONS = useTimeLineRelationOptions();
  const activityContent = getRelationActivityContent(activity);
  const ppmRelationPhrase = getPpmRelationActivityPhrase(activity);

  if (!activity) return <></>;
  return (
    <IssueActivityBlockComponent
      icon={activity.field ? ISSUE_RELATION_OPTIONS[activity.field as TIssueRelationTypes]?.icon(14) : <></>}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu && ppmRelationPhrase ? (
        <PpmActivityPhrase
          phrase={ppmRelationPhrase}
          values={{
            value: (
              <span className="font-medium text-primary">
                {activity.old_value === "" ? activity.new_value : activity.old_value}
              </span>
            ),
          }}
        />
      ) : (
        <>
          {activityContent}
          {activity.old_value === "" ? (
            <span className="font-medium text-primary">{activity.new_value}.</span>
          ) : (
            <span className="font-medium text-primary">{activity.old_value}.</span>
          )}
        </>
      )}
    </IssueActivityBlockComponent>
  );
});
