/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { PPM_BRAND } from "@ppm/brand";
import { IS_PPM_SHELL_TEXT } from "@/hooks/use-ppm-text";

type TIssueUser = {
  activityId: string;
  customUserName?: string;
};

export function IssueCreatorDisplay(props: TIssueUser) {
  const { activityId, customUserName } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();

  const activity = getActivityById(activityId);

  if (!activity) return <></>;

  return (
    <>
      {customUserName ? (
        <span className="font-medium text-primary">
          {customUserName || (IS_PPM_SHELL_TEXT ? PPM_BRAND.name : "Plane")}
        </span>
      ) : (
        <Link
          href={`/${activity?.workspace_detail?.slug}/profile/${activity?.actor_detail?.id}`}
          className="font-medium text-primary hover:underline"
        >
          {activity.actor_detail?.display_name}
        </Link>
      )}
    </>
  );
}
