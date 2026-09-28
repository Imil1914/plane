/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmTranslationKey } from "@ppm/brand";

/**
 * The text a Plane API error carries. Web services rethrow the response body: `{ error }`, `{ detail }`,
 * `{ message }`, or DRF field errors (`{ name: ["…"] }`, `{ non_field_errors: ["…"] }`).
 */
export function extractPpmServerErrorText(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined;
  if (!error || typeof error !== "object") return undefined;
  const body = error as Record<string, unknown>;
  for (const key of ["error", "detail", "message"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(body)) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  }
  return undefined;
}

// Known API messages of the task, sprint and direction flows → a PPM key with the Russian explanation.
const KNOWN_SERVER_ERRORS: ReadonlyArray<[RegExp, TPpmTranslationKey]> = [
  [/cycle already on the given dates|already have a cycle on the given dates/i, "ui.error.cycle_dates_overlap"],
  [/cycle has already been completed so it cannot be edited/i, "ui.error.cycle_completed_edit"],
  [/cycle has already been completed so no new issues can be added/i, "ui.error.cycle_completed_add"],
  [/start date cannot exceed (end|target) date/i, "ui.error.start_after_end"],
  [/start date and end date both are required/i, "ui.error.dates_both_required"],
  [/only admin or creator can delete/i, "ui.error.delete_admin_or_creator"],
  [/(don't|do not) have (the required )?permission|not allowed to|you do not have access/i, "ui.error.no_permission"],
  [/module with this name already exists/i, "ui.error.module_name_exists"],
  [/label with the same name already exists|LABEL_NAME_ALREADY_EXISTS/i, "ui.error.label_name_exists"],
  [/url already exists/i, "ui.error.link_exists"],
  [/invalid url format/i, "ui.error.link_invalid"],
  [/state is not empty|only empty states can be deleted/i, "ui.toast.state_has_work_items"],
  [/(issues|issue ids|sub issue ids) are required/i, "ui.error.select_work_items"],
  [/group by and sub group by cannot have same parameters/i, "ui.error.group_by_same"],
  [
    /(module|cycle|issue|project) not found|required object does not exist|work item is not accessible/i,
    "ui.error.not_found",
  ],
  [/name is required|this field may not be blank|this field is required/i, "ui.error.name_required"],
];

/** PPM key for a known server message, or undefined — then the caller shows the server text as is. */
export function matchPpmServerError(text: string | undefined): TPpmTranslationKey | undefined {
  if (!text) return undefined;
  return KNOWN_SERVER_ERRORS.find(([pattern]) => pattern.test(text))?.[1];
}
