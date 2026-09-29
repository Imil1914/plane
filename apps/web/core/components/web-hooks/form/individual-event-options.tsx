/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Control } from "react-hook-form";
import { Controller } from "react-hook-form";
import type { IWebhook } from "@plane/types";
import { Checkbox } from "@plane/ui";
import type { TPpmTranslationKey } from "@ppm/brand";
// hooks
import { usePpmText } from "@/hooks/use-ppm-text";

export const INDIVIDUAL_WEBHOOK_OPTIONS: {
  key: keyof IWebhook;
  label: string;
  description: string;
}[] = [
  {
    key: "project",
    label: "Projects",
    description: "Project created, updated, or deleted",
  },
  {
    key: "cycle",
    label: "Cycles",
    description: "Cycle created, updated, or deleted",
  },
  {
    key: "issue",
    label: "Work items",
    description: "Work item created, updated, deleted, added to a cycle or module",
  },
  {
    key: "module",
    label: "Modules",
    description: "Module created, updated, or deleted",
  },
  {
    key: "issue_comment",
    label: "Work item comments",
    description: "Comment posted, updated, or deleted",
  },
];

// PPM names of the events (спринты, направления, задачи) for the Russian interface; the list above stays upstream.
const WEBHOOK_EVENT_TEXT_KEYS: Record<string, { label: TPpmTranslationKey; description: TPpmTranslationKey }> = {
  project: { label: "ui.webhook.event_projects", description: "ui.webhook.event_projects_hint" },
  cycle: { label: "ui.webhook.event_cycles", description: "ui.webhook.event_cycles_hint" },
  issue: { label: "ui.webhook.event_tasks", description: "ui.webhook.event_tasks_hint" },
  module: { label: "ui.webhook.event_modules", description: "ui.webhook.event_modules_hint" },
  issue_comment: { label: "ui.webhook.event_comments", description: "ui.webhook.event_comments_hint" },
};

type Props = {
  control: Control<IWebhook, any>;
};

export function WebhookIndividualEventOptions({ control }: Props) {
  const ppmText = usePpmText();
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-8 px-6 lg:grid-cols-2">
      {INDIVIDUAL_WEBHOOK_OPTIONS.map((option) => (
        <Controller
          key={option.key}
          control={control}
          name={option.key}
          render={({ field: { onChange, value } }) => (
            <div>
              <div className="flex items-center gap-2">
                <Checkbox id={option.key} onChange={() => onChange(!value)} checked={value === true} />
                <label className="text-13" htmlFor={option.key}>
                  {WEBHOOK_EVENT_TEXT_KEYS[option.key]
                    ? ppmText(WEBHOOK_EVENT_TEXT_KEYS[option.key].label, option.label)
                    : option.label}
                </label>
              </div>
              <p className="mt-0.5 ml-6 text-11 text-tertiary">
                {WEBHOOK_EVENT_TEXT_KEYS[option.key]
                  ? ppmText(WEBHOOK_EVENT_TEXT_KEYS[option.key].description, option.description)
                  : option.description}
              </p>
            </div>
          )}
        />
      ))}
    </div>
  );
}
