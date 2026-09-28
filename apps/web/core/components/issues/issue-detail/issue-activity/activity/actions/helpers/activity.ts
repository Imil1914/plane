/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssueActivity } from "@plane/types";
import type { TPpmTranslationKey } from "@ppm/brand";

export const getRelationActivityContent = (activity: TIssueActivity | undefined): string | undefined => {
  if (!activity) return;

  switch (activity.field) {
    case "blocking":
      return activity.old_value === ""
        ? `marked this work item is blocking work item `
        : `removed the blocking work item `;
    case "blocked_by":
      return activity.old_value === ""
        ? `marked this work item is being blocked by `
        : `removed this work item being blocked by work item `;
    case "duplicate":
      return activity.old_value === ""
        ? `marked this work item as duplicate of `
        : `removed this work item as a duplicate of `;
    case "relates_to":
      return activity.old_value === "" ? `marked that this work item relates to ` : `removed the relation from `;
  }

  return;
};

/** The PPM sentence for a relation change (the related work item is filled in as {value}). */
export const getPpmRelationActivityPhrase = (activity: TIssueActivity | undefined): TPpmTranslationKey | undefined => {
  if (!activity) return;
  const added = activity.old_value === "";
  switch (activity.field) {
    case "blocking":
      return added ? "ui.activity.blocking_added" : "ui.activity.blocking_removed";
    case "blocked_by":
      return added ? "ui.activity.blocked_by_added" : "ui.activity.blocked_by_removed";
    case "duplicate":
      return added ? "ui.activity.duplicate_added" : "ui.activity.duplicate_removed";
    case "relates_to":
      return added ? "ui.activity.relates_to_added" : "ui.activity.relates_to_removed";
  }
  return;
};
