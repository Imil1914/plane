const TIME_UNITS = [
  { limit: 60, milliseconds: 1000, unit: "second" },
  { limit: 60, milliseconds: 60 * 1000, unit: "minute" },
  { limit: 24, milliseconds: 60 * 60 * 1000, unit: "hour" },
  { limit: 7, milliseconds: 24 * 60 * 60 * 1000, unit: "day" },
  { limit: 4.345, milliseconds: 7 * 24 * 60 * 60 * 1000, unit: "week" },
  { limit: 12, milliseconds: 30.44 * 24 * 60 * 60 * 1000, unit: "month" },
  { limit: Number.POSITIVE_INFINITY, milliseconds: 365.25 * 24 * 60 * 60 * 1000, unit: "year" },
] as const;

export function formatPpmTimeAgo(value: string | number | Date, locale: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";

  const delta = timestamp - now;
  const absoluteDelta = Math.abs(delta);
  let selectedUnit = TIME_UNITS[TIME_UNITS.length - 1];

  for (const unit of TIME_UNITS) {
    if (absoluteDelta < unit.limit * unit.milliseconds) {
      selectedUnit = unit;
      break;
    }
  }

  const amount = Math.round(delta / selectedUnit.milliseconds);
  return new Intl.RelativeTimeFormat(locale || "ru", { numeric: "always" }).format(amount, selectedUnit.unit);
}
