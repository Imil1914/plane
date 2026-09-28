/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { ISSUE_PRIORITIES, STATE_GROUPS } from "@plane/constants";
import type { IFilterOption, TFilterValue } from "@plane/types";
import type { TPpmTranslationKey } from "@ppm/brand";
import { PPM_PRIORITY_TITLE_KEYS } from "@/components/ppm-shell/priority-title";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

// The rich-filter configs (@plane/utils work-item-filters) carry fixed English names; they are translated where
// they are shown, by their exact upstream text, so the configs and the saved filter payloads stay untouched.
const FILTER_LABEL_KEYS: Record<string, TPpmTranslationKey> = {
  Priority: "ui.filter.priority",
  State: "ui.filter.state",
  "State Group": "ui.filter.state_group",
  Assignees: "ui.filter.assignees",
  Mentions: "ui.filter.mentions",
  "Created by": "ui.filter.created_by",
  Subscriber: "ui.filter.subscriber",
  Label: "ui.filter.label",
  Cycle: "ui.filter.cycle",
  Module: "ui.filter.module",
  "Start date": "ui.filter.start_date",
  "Target date": "ui.filter.target_date",
  "Created at": "ui.filter.created_at",
  "Updated at": "ui.filter.updated_at",
  Projects: "ui.filter.projects",
};

const OPERATOR_LABEL_KEYS: Record<string, TPpmTranslationKey> = {
  is: "ui.filter.op_is",
  "is any of": "ui.filter.op_any_of",
  between: "ui.filter.op_between",
};

const STATE_GROUP_TITLE_KEYS: Record<string, TPpmTranslationKey> = {
  backlog: "tasks.group.state_backlog",
  unstarted: "tasks.group.state_unstarted",
  started: "tasks.group.state_started",
  completed: "tasks.group.state_completed",
  cancelled: "tasks.group.state_cancelled",
};

const PRIORITY_TITLES = new Map<string, string>(ISSUE_PRIORITIES.map((priority) => [priority.key, priority.title]));
const STATE_GROUP_TITLES = new Map<string, string>(
  Object.values(STATE_GROUPS).map((group) => [group.key, group.label])
);

/**
 * The option key of a fixed option set (a priority or a state group) — only when the option still carries the
 * upstream title, so a user-defined label or state that happens to be called «High» is never translated.
 */
function getFixedOptionKey(value: TFilterValue, label: string): TPpmTranslationKey | undefined {
  if (typeof value !== "string") return undefined;
  if (PRIORITY_TITLES.get(value) === label)
    return PPM_PRIORITY_TITLE_KEYS[value as keyof typeof PPM_PRIORITY_TITLE_KEYS];
  if (STATE_GROUP_TITLES.get(value) === label) return STATE_GROUP_TITLE_KEYS[value];
  return undefined;
}

export type TPpmRichFilterText = {
  filterLabel: (label: string) => string;
  operatorLabel: (label: string) => string;
  localizeOptions: <V extends TFilterValue>(options: IFilterOption<V>[]) => IFilterOption<V>[];
};

/** Filter names, operators and fixed option sets of the rich filters in the PPM interface language. */
export function usePpmRichFilterText(): TPpmRichFilterText {
  const isPpmRu = usePpmRu();
  const ppmT = usePpmTranslation();

  return useMemo<TPpmRichFilterText>(() => {
    if (!isPpmRu)
      return { filterLabel: (label) => label, operatorLabel: (label) => label, localizeOptions: (options) => options };
    return {
      filterLabel: (label) => (FILTER_LABEL_KEYS[label] ? ppmT(FILTER_LABEL_KEYS[label]) : label),
      operatorLabel: (label) => (OPERATOR_LABEL_KEYS[label] ? ppmT(OPERATOR_LABEL_KEYS[label]) : label),
      localizeOptions: (options) =>
        options.map((option) => {
          const key = typeof option.label === "string" ? getFixedOptionKey(option.value, option.label) : undefined;
          return key ? { ...option, label: ppmT(key) } : option;
        }),
    };
  }, [ppmT, isPpmRu]);
}
