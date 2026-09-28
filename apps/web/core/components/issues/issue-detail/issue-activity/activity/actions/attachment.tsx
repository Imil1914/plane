/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Paperclip } from "lucide-react";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent, IssueLink } from "./";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { PpmActivityPhrase } from "./helpers/ppm-activity";

type TIssueAttachmentActivity = { activityId: string; showIssue?: boolean; ends: "top" | "bottom" | undefined };

export const IssueAttachmentActivity = observer(function IssueAttachmentActivity(props: TIssueAttachmentActivity) {
  const isPpmRu = usePpmRu();
  const { activityId, showIssue = true, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const activity = getActivityById(activityId);

  if (!activity) return <></>;
  return (
    <IssueActivityBlockComponent
      icon={<Paperclip size={14} className="text-secondary" aria-hidden="true" />}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu ? (
        <PpmActivityPhrase
          phrase={activity.verb === "created" ? "ui.activity.attachment_added" : "ui.activity.attachment_removed"}
          issue={showIssue ? <IssueLink activityId={activityId} /> : undefined}
        />
      ) : (
        <>
          {activity.verb === "created" ? `uploaded a new attachment` : `removed an attachment`}
          {showIssue && (activity.verb === "created" ? ` to ` : ` from `)}
          {showIssue && <IssueLink activityId={activityId} />}.
        </>
      )}
    </IssueActivityBlockComponent>
  );
});
