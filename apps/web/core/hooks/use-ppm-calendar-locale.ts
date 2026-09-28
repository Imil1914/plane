/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import type { Locale } from "date-fns";
import { format } from "date-fns";
import { ru } from "date-fns/locale/ru";
import { usePpmRu } from "@/hooks/use-ppm-text";

type TDayModifiers = { today?: boolean; selected?: boolean };

/** Russian ARIA labels of the date picker (react-day-picker keeps English ones even with a locale). */
const RU_CALENDAR_LABELS = {
  labelNext: () => "Следующий месяц",
  labelPrevious: () => "Предыдущий месяц",
  labelMonthDropdown: () => "Выберите месяц",
  labelYearDropdown: () => "Выберите год",
  labelNav: () => "Переход по месяцам",
  labelDayButton: (date: Date, modifiers: TDayModifiers) => {
    const label = format(date, "EEEE, d MMMM yyyy", { locale: ru });
    return `${modifiers.today ? "Сегодня, " : ""}${label}${modifiers.selected ? ", выбрано" : ""}`;
  },
};

/**
 * Locale props for the date pickers (@plane/propel/calendar): in the Russian PPM interface — Russian month and
 * weekday names and ARIA labels; otherwise nothing, so the pickers stay exactly as upstream renders them.
 * The first day of the week comes separately from userProfile.startOfTheWeek.
 */
export function usePpmCalendarLocale(): { locale?: Locale; labels?: typeof RU_CALENDAR_LABELS } {
  const isPpmRu = usePpmRu();

  return useMemo(() => (isPpmRu ? { locale: ru, labels: RU_CALENDAR_LABELS } : {}), [isPpmRu]);
}
