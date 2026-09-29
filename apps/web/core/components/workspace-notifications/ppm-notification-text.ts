/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssuePriorities } from "@plane/types";
import { convertMinutesToHoursMinutesString, renderFormattedDate, sanitizeCommentForNotification } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";

export type TPpmNotificationFieldData = {
  field: string | undefined;
  verb: string | undefined;
  newValue?: string | undefined;
  oldValue?: string | undefined;
};

/** A whole phrase of the notification card (after the author's name) and the value that fills its `{value}`. */
export type TPpmNotificationPhrase = {
  phrase: TPpmTranslationKey;
  value?: string;
  /** The value is a priority key: the card shows its PPM name («Высокий»). */
  priority?: TIssuePriorities;
};

const PRIORITIES: readonly TIssuePriorities[] = ["urgent", "high", "medium", "low", "none"];
const INTAKE_STATUS_PHRASES: Record<string, TPpmTranslationKey> = {
  Accepted: "ui.activity.intake_accepted",
  Rejected: "ui.activity.intake_declined",
  Snoozed: "ui.activity.intake_snoozed",
  Duplicate: "ui.activity.intake_duplicate",
};
// Relations: the phrase when the relation appears (value — the related work item) and when it is removed.
const RELATION_PHRASES: Record<string, [TPpmTranslationKey, TPpmTranslationKey]> = {
  duplicate: ["ui.activity.duplicate_added", "ui.activity.duplicate_removed"],
  relates_to: ["ui.activity.relates_to_added", "ui.activity.relates_to_removed"],
  blocked_by: ["ui.activity.blocked_by_added", "ui.activity.blocked_by_removed"],
  blocking: ["ui.activity.blocking_added", "ui.activity.blocking_removed"],
};

/** The API sends `str(None)` for an empty value. */
const present = (value: string | undefined): value is string =>
  value !== undefined && value !== "" && value !== "None" && value !== "null";

const UPDATED: TPpmNotificationPhrase = { phrase: "ui.notification.updated" };
// Dates and a time estimate in the interface language; a value that does not parse is shown as sent.
const formatDate = (value: string): string => renderFormattedDate(value) ?? value;
const formatMinutes = (value: string): string => convertMinutesToHoursMinutesString(Number(value)).trim() || value;

/** A phrase that needs a value; without one the card says neutrally that the work item changed. */
const withValue = (phrase: TPpmTranslationKey, value: string | undefined): TPpmNotificationPhrase =>
  present(value) ? { phrase, value } : UPDATED;

/**
 * Line R2-1: the Russian sentence of a notification card. Upstream glues English pieces («set due date» + «to» +
 * value, `${verb} ${field}`); here every field and verb gets a whole phrase — the same as the work item activity feed
 * (`ui.activity.*`) where they coincide. `renderCommentBox`: the comment is shown in the editor below the sentence.
 */
export function resolvePpmNotificationPhrase(
  data: TPpmNotificationFieldData,
  renderCommentBox = false
): TPpmNotificationPhrase {
  const { field, verb, newValue, oldValue } = data;
  const isRemoval = verb === "deleted";
  const relation = field ? RELATION_PHRASES[field] : undefined;
  if (relation) return isRemoval ? withValue(relation[1], oldValue) : withValue(relation[0], newValue);

  switch (field) {
    case "None":
      return { phrase: "ui.notification.created_assigned" };
    case "issue":
      return { phrase: "ui.notification.task_deleted" };
    case "state":
      return withValue("ui.activity.state", newValue);
    case "priority":
      return present(newValue) && (PRIORITIES as readonly string[]).includes(newValue)
        ? { phrase: "ui.activity.priority", value: newValue, priority: newValue as TIssuePriorities }
        : withValue("ui.activity.priority", newValue);
    case "name":
      return withValue("ui.activity.name", newValue);
    case "description":
      return { phrase: "ui.activity.description" };
    case "start_date":
      return present(newValue)
        ? withValue("ui.activity.start_date_set", formatDate(newValue))
        : { phrase: "ui.activity.start_date_removed" };
    case "target_date":
      return present(newValue)
        ? withValue("ui.activity.due_date_set", formatDate(newValue))
        : { phrase: "ui.activity.due_date_removed" };
    case "estimate_time":
      return present(newValue)
        ? withValue("ui.activity.estimate_set", formatMinutes(newValue))
        : withValue("ui.activity.estimate_removed", present(oldValue) ? formatMinutes(oldValue) : undefined);
    case "estimate_point":
    case "estimate_points":
    case "estimate_categories":
      return present(newValue)
        ? withValue("ui.activity.estimate_set", newValue)
        : withValue("ui.activity.estimate_removed", oldValue);
    case "labels":
      return present(newValue)
        ? withValue("ui.activity.label_added", newValue)
        : withValue("ui.activity.label_removed", oldValue);
    case "assignees":
      return present(newValue)
        ? withValue("ui.activity.assignee_added", newValue)
        : withValue("ui.activity.assignee_removed", oldValue);
    case "parent":
      return present(newValue)
        ? withValue("ui.activity.parent_set", newValue)
        : withValue("ui.activity.parent_removed", oldValue);
    case "cycles":
      if (isRemoval) return withValue("ui.activity.cycle_removed", oldValue);
      return withValue(verb === "created" ? "ui.activity.cycle_added" : "ui.activity.cycle_set", newValue);
    case "modules":
      if (isRemoval) return withValue("ui.activity.module_removed", oldValue);
      return withValue(verb === "created" ? "ui.activity.module_added" : "ui.activity.module_set", newValue);
    case "link":
      if (isRemoval) return { phrase: "ui.notification.link_removed" };
      return withValue(verb === "created" ? "ui.notification.link_added" : "ui.notification.link_updated", newValue);
    case "attachment":
      return { phrase: isRemoval ? "ui.activity.attachment_removed" : "ui.activity.attachment_added" };
    case "comment": {
      if (isRemoval) return { phrase: "ui.notification.comment_removed" };
      const isUpdate = verb === "updated";
      const comment = present(newValue) ? sanitizeCommentForNotification(newValue) : undefined;
      if (renderCommentBox || !present(comment))
        return { phrase: isUpdate ? "ui.notification.comment_updated_plain" : "ui.notification.comment_added_plain" };
      return { phrase: isUpdate ? "ui.notification.comment_updated" : "ui.notification.comment_added", value: comment };
    }
    case "archived_at":
      return { phrase: newValue === "restore" ? "ui.activity.restored" : "ui.activity.archived" };
    case "intake":
      return { phrase: (newValue && INTAKE_STATUS_PHRASES[newValue]) || "ui.activity.intake_updated" };
    case "reaction":
      return isRemoval
        ? { phrase: "ui.notification.reaction_removed" }
        : withValue("ui.notification.reaction_added", newValue);
    default:
      return UPDATED;
  }
}

/** Snooze modal: its 12-hour option («02:30» + PM) as a 24-hour time («14:30») for the Russian interface. */
export function toPpm24HourTime(time: string, period: "AM" | "PM"): string {
  const [hours = "0", minutes = "00"] = time.split(":");
  const hour12 = Number(hours) % 12;
  const hour24 = period === "PM" ? hour12 + 12 : hour12;
  return `${String(hour24).padStart(2, "0")}:${minutes}`;
}
