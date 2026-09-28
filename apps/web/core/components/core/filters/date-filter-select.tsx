/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { CalendarDays } from "lucide-react";
// ui
import { CalendarAfterIcon, CalendarBeforeIcon } from "@plane/propel/icons";
import { CustomSelect } from "@plane/ui";
import type { TPpmTranslationKey } from "@ppm/brand";
import { usePpmText } from "@/hooks/use-ppm-text";

type Props = {
  title: string;
  value: string;
  onChange: (value: string) => void;
};

type DueDate = {
  name: string;
  value: string;
  icon: any;
};

const dueDateRange: DueDate[] = [
  {
    name: "before",
    value: "before",
    icon: <CalendarBeforeIcon className="h-4 w-4" />,
  },
  {
    name: "after",
    value: "after",
    icon: <CalendarAfterIcon className="h-4 w-4" />,
  },
  {
    name: "range",
    value: "range",
    icon: <CalendarDays className="h-4 w-4" />,
  },
];

// «Срок до / после / в диапазоне» in the Russian PPM interface; the upstream words otherwise.
const DATE_RANGE_KEYS: Record<string, TPpmTranslationKey> = {
  before: "ui.date_filter.type_before",
  after: "ui.date_filter.type_after",
  range: "ui.date_filter.type_range",
};

export function DateFilterSelect({ title, value, onChange }: Props) {
  const ppmText = usePpmText();
  const optionName = (option: DueDate | undefined) =>
    option ? ppmText(DATE_RANGE_KEYS[option.value], option.name) : undefined;

  return (
    <CustomSelect
      value={value}
      label={
        <div className="flex items-center gap-2 text-11">
          {dueDateRange.find((item) => item.value === value)?.icon}
          <span>
            {title} {optionName(dueDateRange.find((item) => item.value === value))}
          </span>
        </div>
      }
      onChange={onChange}
    >
      {dueDateRange.map((option, index) => (
        <CustomSelect.Option key={index} value={option.value}>
          <div className="flex items-center gap-2">
            <span>{option.icon}</span>
            {title} {optionName(option)}
          </div>
        </CustomSelect.Option>
      ))}
    </CustomSelect>
  );
}
