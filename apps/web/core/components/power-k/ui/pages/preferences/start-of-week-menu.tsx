/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { Command } from "cmdk";
// plane imports
import { START_OF_THE_WEEK_OPTIONS } from "@plane/constants";
import type { EStartOfTheWeek } from "@plane/types";
// local imports
import { useTranslation } from "@plane/i18n";
import { getPpmWeekdayName } from "@/components/ppm-shell/week-start";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { PowerKModalCommandItem } from "../../modal/command-item";

type Props = {
  onSelect: (day: EStartOfTheWeek) => void;
};

export function PowerKPreferencesStartOfWeekMenu(props: Props) {
  const isPpmRu = usePpmRu();
  const { onSelect } = props;
  const { currentLocale } = useTranslation();

  return (
    <Command.Group>
      {START_OF_THE_WEEK_OPTIONS.map((day) => (
        <PowerKModalCommandItem
          key={day.value}
          onSelect={() => onSelect(day.value)}
          label={(isPpmRu && getPpmWeekdayName(day.value, currentLocale)) || day.label}
        />
      ))}
    </Command.Group>
  );
}
