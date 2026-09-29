// G2.3 (line G-Web): pure calendar math for the «Что сделано за период» presets. The API interprets `from`/`to` as
// plain calendar dates in the *project's* timezone (contract, docs/superpowers/plans/2026-09-29-g23-reports/plan.md)
// — so the client only has to pick sensible calendar-day boundaries from "today" as the browser sees it; it does not
// need to know the project's timezone itself (the server is authoritative for the actual instant boundaries and for
// the day-of-week edge case, per Review Focus item 2, which is a G-API test). Weeks run Monday–Sunday (G2.3 card).
// All arithmetic is done on UTC-midnight `Date`s carrying only Y/M/D, so it never trips over DST.

export type TWorkSummaryPreset = "this_week" | "last_week" | "two_weeks" | "month" | "custom";

export const WORK_SUMMARY_MAX_DAYS = 92;

function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function formatDateISO(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Monday of the calendar week containing `date`. */
export function mondayOfWeek(date: Date): Date {
  const utcDate = toUtcMidnight(date);
  const weekday = utcDate.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (weekday + 6) % 7; // Monday -> 0, ..., Sunday -> 6
  return addDays(utcDate, -daysSinceMonday);
}

export type TWorkSummaryRange = { from: string; to: string };

/** The date range for every preset except «Свои даты», which has no computed range — the user types it. */
export function getWorkSummaryPresetRange(
  preset: Exclude<TWorkSummaryPreset, "custom">,
  today: Date
): TWorkSummaryRange {
  const todayUtc = toUtcMidnight(today);
  const thisMonday = mondayOfWeek(todayUtc);
  switch (preset) {
    case "this_week":
      // Week-to-date: Monday through today, never into the future.
      return { from: formatDateISO(thisMonday), to: formatDateISO(todayUtc) };
    case "last_week": {
      const lastMonday = addDays(thisMonday, -7);
      const lastSunday = addDays(thisMonday, -1);
      return { from: formatDateISO(lastMonday), to: formatDateISO(lastSunday) };
    }
    case "two_weeks":
      // Last week in full, plus this week to date.
      return { from: formatDateISO(addDays(thisMonday, -7)), to: formatDateISO(todayUtc) };
    case "month": {
      const firstOfMonth = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), 1));
      return { from: formatDateISO(firstOfMonth), to: formatDateISO(todayUtc) };
    }
  }
}

/** Strict `YYYY-MM-DD` parsing (UTC midnight); rejects overflowed components (`2026-02-30`) instead of normalizing
 * them the way the native `Date` constructor silently would. */
export function parseIsoDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m) - 1;
  const day = Number(d);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  return date;
}

/** Client-side pre-check before calling the API (which enforces the same rule server-side): a friendly Russian
 * message, or undefined when the range is acceptable. */
export function validateWorkSummaryRange(from: string, to: string): string | undefined {
  const fromDate = parseIsoDate(from);
  const toDate = parseIsoDate(to);
  if (!fromDate || !toDate) return "Укажите обе даты в формате ГГГГ-ММ-ДД.";
  if (fromDate.getTime() > toDate.getTime()) return "Дата начала позже даты окончания.";
  const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  if (days > WORK_SUMMARY_MAX_DAYS) return `Период длиннее ${WORK_SUMMARY_MAX_DAYS} дней. Сократите диапазон.`;
  return undefined;
}
