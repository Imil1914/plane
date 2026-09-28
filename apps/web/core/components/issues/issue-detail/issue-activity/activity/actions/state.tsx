/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// hooks
import { StatePropertyIcon } from "@plane/propel/icons";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent, IssueLink } from "./";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { PpmActivityPhrase } from "./helpers/ppm-activity";
import { useTranslation } from "@plane/i18n";
import { getPpmStateDisplayNameByName } from "@/lib/ppm-design";
// icons

type TIssueStateActivity = { activityId: string; showIssue?: boolean; ends: "top" | "bottom" | undefined };

export const IssueStateActivity = observer(function IssueStateActivity(props: TIssueStateActivity) {
  const isPpmRu = usePpmRu();
  const { activityId, showIssue = true, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const { currentLocale } = useTranslation();
  const activity = getActivityById(activityId);

  if (!activity) return <></>;
  return (
    <IssueActivityBlockComponent
      icon={<StatePropertyIcon className="h-4 w-4 flex-shrink-0 text-secondary" />}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu ? (
        <PpmActivityPhrase
          phrase="ui.activity.state"
          values={{
            value: (
              <span className="font-medium text-primary">
                {getPpmStateDisplayNameByName(activity.new_value, currentLocale)}
              </span>
            ),
          }}
          issue={showIssue ? <IssueLink activityId={activityId} /> : undefined}
        />
      ) : (
        <>
          set the state to <span className="font-medium text-primary">{activity.new_value}</span>
          {showIssue ? ` for ` : ``}
          {showIssue && <IssueLink activityId={activityId} />}.
        </>
      )}
    </IssueActivityBlockComponent>
  );
});
