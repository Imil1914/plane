/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { MessageSquare } from "lucide-react";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent, IssueLink } from "./";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmActivityPhrase } from "./helpers/ppm-activity";

type TIssueLinkActivity = { activityId: string; showIssue?: boolean; ends: "top" | "bottom" | undefined };

export const IssueLinkActivity = observer(function IssueLinkActivity(props: TIssueLinkActivity) {
  const isPpmRu = usePpmRu();
  const { activityId, showIssue = false, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const ppmT = usePpmTranslation();
  const activity = getActivityById(activityId);

  if (!activity) return <></>;
  return (
    <IssueActivityBlockComponent
      icon={<MessageSquare size={14} className="text-secondary" aria-hidden="true" />}
      activityId={activityId}
      ends={ends}
    >
      {isPpmRu ? (
        <PpmActivityPhrase
          phrase={
            activity.verb === "created"
              ? "ui.activity.link_added"
              : activity.verb === "updated"
                ? "ui.activity.link_updated"
                : "ui.activity.link_removed"
          }
          values={{
            link: (
              <a
                href={`${activity.verb === "created" ? activity.new_value : activity.old_value}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                {ppmT("ui.activity.link_word")}
              </a>
            ),
          }}
          issue={showIssue ? <IssueLink activityId={activityId} /> : undefined}
        />
      ) : (
        <>
          {activity.verb === "created" ? (
            <>
              <span>added </span>
              <a
                href={`${activity.new_value}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                link
              </a>
            </>
          ) : activity.verb === "updated" ? (
            <>
              <span>updated the </span>
              <a
                href={`${activity.old_value}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                link
              </a>
            </>
          ) : (
            <>
              <span>removed this </span>
              <a
                href={`${activity.old_value}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                link
              </a>
            </>
          )}
          {showIssue && (activity.verb === "created" ? ` to ` : ` from `)}
          {showIssue && <IssueLink activityId={activityId} />}.
        </>
      )}
    </IssueActivityBlockComponent>
  );
});
