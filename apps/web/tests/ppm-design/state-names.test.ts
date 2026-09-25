// UX1.1 F4 (R11, plan-T N1): Russian display names for the exact default states, data untouched.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPpmStateDisplayName } from "@/lib/ppm-design";

const v2 = () => vi.stubGlobal("document", { documentElement: { dataset: { ppmDesign: "v2" } } });
const v1 = () => vi.stubGlobal("document", { documentElement: { dataset: { ppmDesign: "v1" } } });

afterEach(() => vi.unstubAllGlobals());

describe("getPpmStateDisplayName (UX1.1)", () => {
  it("shows the exact default names in Russian under v2", () => {
    v2();
    expect(getPpmStateDisplayName({ name: "Backlog", group: "backlog" }, "ru")).toBe("Бэклог");
    expect(getPpmStateDisplayName({ name: "Todo", group: "unstarted" }, "ru")).toBe("К работе");
    expect(getPpmStateDisplayName({ name: "In Progress", group: "started" }, "ru")).toBe("В работе");
    expect(getPpmStateDisplayName({ name: "Done", group: "completed" }, "ru")).toBe("Готово");
    expect(getPpmStateDisplayName({ name: "Cancelled", group: "cancelled" }, "ru")).toBe("Отменена");
    expect(getPpmStateDisplayName({ name: "Triage", group: "triage" }, "ru")).toBe("На разборе");
    expect(getPpmStateDisplayName({ name: "In Progress", group: "started" }, "en")).toBe("In Progress");
  });

  it("keeps renamed, custom and cross-group names exactly as stored", () => {
    v2();
    expect(getPpmStateDisplayName({ name: "На проверке", group: "started" }, "ru")).toBe("На проверке");
    expect(getPpmStateDisplayName({ name: "in progress", group: "started" }, "ru")).toBe("in progress");
    expect(getPpmStateDisplayName({ name: "Done", group: "started" }, "ru")).toBe("Done");
  });

  it("keeps wave 0 untouched and tolerates a missing state", () => {
    v1();
    expect(getPpmStateDisplayName({ name: "Backlog", group: "backlog" }, "ru")).toBe("Backlog");
    expect(getPpmStateDisplayName(null, "ru")).toBeUndefined();
    expect(getPpmStateDisplayName(undefined, "ru")).toBeUndefined();
  });

  it("the state dropdown shows the display name and still finds states by their stored name", () => {
    const source = readFileSync(new URL("../../core/components/dropdowns/state/base.tsx", import.meta.url), "utf8");
    expect(source).toContain("const { t, currentLocale } = useTranslation();");
    expect(source).toContain('query: `${state?.name} ${getPpmStateDisplayName(state, currentLocale) ?? ""}`,');
    expect(source).toContain("{getPpmStateDisplayName(state, currentLocale)}");
    expect(source).toContain('tooltipContent={getPpmStateDisplayName(selectedState, currentLocale) ?? t("state")}');
    expect(source).toContain('{getPpmStateDisplayName(selectedState, currentLocale) ?? t("state")}');
  });
});
