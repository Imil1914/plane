/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// hooks
import { IntakeIcon } from "@plane/propel/icons";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent } from "./";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { PpmActivityPhrase } from "./helpers/ppm-activity";
// icons

type TIssueInboxActivity = { activityId: string; ends: "top" | "bottom" | undefined };

export const IssueInboxActivity = observer(function IssueInboxActivity(props: TIssueInboxActivity) {
  const isPpmRu = usePpmRu();
  const { activityId, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const activity = getActivityById(activityId);

  const getInboxActivityMessage = () => {
    switch (activity?.verb) {
      case "-1":
        return "declined this work item from intake.";
      case "0":
        return "snoozed this work item.";
      case "1":
        return "accepted this work item from intake.";
      case "2":
        return "declined this work item from intake by marking a duplicate work item.";
      default:
        return "updated intake work item status.";
    }
  };

  if (!activity) return <></>;
  return (
    <IssueActivityBlockComponent
      icon={<IntakeIcon className="h-4 w-4 flex-shrink-0 text-secondary" />}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu ? (
        <PpmActivityPhrase
          phrase={
            activity.verb === "-1"
              ? "ui.activity.intake_declined"
              : activity.verb === "0"
                ? "ui.activity.intake_snoozed"
                : activity.verb === "1"
                  ? "ui.activity.intake_accepted"
                  : activity.verb === "2"
                    ? "ui.activity.intake_duplicate"
                    : "ui.activity.intake_updated"
          }
        />
      ) : (
        <>{getInboxActivityMessage()}</>
      )}
    </IssueActivityBlockComponent>
  );
});
