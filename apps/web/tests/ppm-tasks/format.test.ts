import { describe, expect, it } from "vitest";
import { formatPpmTemplate, splitPpmTemplate } from "@/components/ppm-tasks/format";

describe("PPM tasks templates", () => {
  it("substitutes named placeholders and keeps unknown ones", () => {
    expect(formatPpmTemplate("День {day} из {total}", { day: 8, total: 14 })).toBe("День 8 из 14");
    expect(formatPpmTemplate("Срок — {date}", {})).toBe("Срок — {date}");
  });
  it("splits a template around a token", () => {
    expect(splitPpmTemplate("Ближайший срок — {task}, {date}", "task")).toEqual(["Ближайший срок — ", ", {date}"]);
    expect(splitPpmTemplate("Без токена", "task")).toEqual(["Без токена", ""]);
  });
});
