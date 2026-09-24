import { describe, expect, it } from "vitest";
import { formatPpmTimeAgo } from "@/helpers/ppm-time-ago.helper";

describe("PPM relative time", () => {
  const now = new Date("2026-09-19T12:00:00.000Z").getTime();

  it("formats recent activity in Russian", () => {
    expect(formatPpmTimeAgo("2026-09-19T11:18:00.000Z", "ru", now)).toBe("42 минуты назад");
  });

  it("formats day-scale activity without English fragments", () => {
    expect(formatPpmTimeAgo("2026-09-12T12:00:00.000Z", "ru", now)).toBe("1 неделю назад");
  });

  it("keeps the current locale for the upstream English shell", () => {
    expect(formatPpmTimeAgo("2026-09-19T11:18:00.000Z", "en", now)).toBe("42 minutes ago");
  });

  it("returns a neutral marker for an invalid date", () => {
    expect(formatPpmTimeAgo("not-a-date", "ru", now)).toBe("—");
  });
});
