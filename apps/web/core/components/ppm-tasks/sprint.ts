/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmTranslationKey } from "@ppm/brand";

const DAY_MS = 86_400_000;
const LABEL_ALL_DAYS_LIMIT = 16;

export type TPpmSprintTick = {
  key: string;
  label: string;
  position: number;
  isMajor: boolean;
  isToday: boolean;
  showLabel: boolean;
};

export type TPpmSprintScale = {
  totalDays: number;
  dayIndex: number;
  daysLeft: number;
  todayPosition: number;
  ticks: TPpmSprintTick[];
};

export type TPpmPluralKey = "one" | "few" | "many" | "other";

export const PPM_DAYS_LEFT_KEYS: Record<TPpmPluralKey, TPpmTranslationKey> = {
  one: "tasks.sprint.days_left_one",
  few: "tasks.sprint.days_left_few",
  many: "tasks.sprint.days_left_many",
  other: "tasks.sprint.days_left_other",
};

/** Календарная дата YYYY-MM-DD как номер дня UTC: без сдвигов часового пояса и перехода на летнее время. */
function toUtcDay(value: string | null | undefined): number | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

function localUtcDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

export function computePpmSprintScale(
  start: string | null | undefined,
  end: string | null | undefined,
  today: Date
): TPpmSprintScale | null {
  const startDay = toUtcDay(start);
  const endDay = toUtcDay(end);
  if (startDay === null || endDay === null || endDay < startDay) return null;
  const totalDays = endDay - startDay + 1;
  const todayDay = localUtcDay(today);
  const offset = Math.min(Math.max(todayDay - startDay, 0), totalDays - 1);
  const positionOf = (index: number) => (totalDays === 1 ? 0.5 : index / (totalDays - 1));
  const ticks = Array.from({ length: totalDays }, (_, index): TPpmSprintTick => {
    const date = new Date((startDay + index) * DAY_MS);
    const isMajor = index === 0 || index === totalDays - 1 || date.getUTCDay() === 1;
    const isToday = startDay + index === todayDay;
    return {
      key: date.toISOString().slice(0, 10),
      label: String(date.getUTCDate()),
      position: positionOf(index),
      isMajor,
      isToday,
      showLabel: totalDays <= LABEL_ALL_DAYS_LIMIT || isMajor || isToday,
    };
  });
  return {
    totalDays,
    dayIndex: offset + 1,
    daysLeft: Math.max(endDay - Math.max(todayDay, startDay), 0),
    todayPosition: todayDay < startDay ? 0 : todayDay > endDay ? 1 : positionOf(offset),
    ticks,
  };
}

export function formatPpmSprintRange(
  start: string | null | undefined,
  end: string | null | undefined,
  locale: string | undefined
): string | null {
  const startDay = toUtcDay(start);
  const endDay = toUtcDay(end);
  if (startDay === null || endDay === null) return null;
  const lang = locale?.toLowerCase().startsWith("ru") ? "ru" : "en";
  const from = new Date(startDay * DAY_MS);
  const to = new Date(endDay * DAY_MS);
  const day = new Intl.DateTimeFormat(lang, { day: "numeric", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat(lang, { month: "short", timeZone: "UTC" });
  const dayMonth = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", timeZone: "UTC" });
  if (from.getUTCFullYear() === to.getUTCFullYear() && from.getUTCMonth() === to.getUTCMonth())
    return lang === "ru"
      ? `${day.format(from)}–${day.format(to)} ${month.format(to)}`
      : `${month.format(to)} ${day.format(from)}–${day.format(to)}`;
  return `${dayMonth.format(from)} – ${dayMonth.format(to)}`;
}

export function selectPpmPluralKey(count: number, locale: string | undefined): TPpmPluralKey {
  const rule = new Intl.PluralRules(locale?.toLowerCase().startsWith("ru") ? "ru" : "en").select(count);
  return rule === "one" || rule === "few" || rule === "many" ? rule : "other";
}
