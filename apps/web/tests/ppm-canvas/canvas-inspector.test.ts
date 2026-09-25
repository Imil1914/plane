import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import { canvasNodeTitle, formatDueDate, formatDueDateRelative } from "@/components/ppm-canvas/canvas-grammar";

const editorSource = readFileSync(new URL("../../core/components/ppm-canvas/editor.tsx", import.meta.url), "utf8");
const inspectorSource = readFileSync(
  new URL("../../core/components/ppm-canvas/canvas-inspector.tsx", import.meta.url),
  "utf8"
);
const NOW = new Date(2026, 8, 24, 10, 0);

describe("canvas inspector (UX1.1 C6)", () => {
  it("formats the due date and its distance in days", () => {
    expect(formatDueDate("2026-09-26", "ru")).toBe("26 сент.");
    expect(formatDueDateRelative("2026-09-27", "ru", NOW)).toBe("через 3 дня");
    expect(formatDueDateRelative("2026-09-24", "ru", NOW)).toBe("сегодня");
    expect(formatDueDateRelative("2026-09-25", "ru", NOW)).toBe("завтра");
    expect(formatDueDateRelative("2026-09-23", "ru", NOW)).toBe("вчера");
  });

  it("formats dates in the UI language: ru* → ru, anything else → en (as in Tasks)", () => {
    expect(formatDueDate("2026-09-26", "ru-RU")).toBe("26 сент.");
    expect(formatDueDateRelative("2026-09-27", "ru-RU", NOW)).toBe("через 3 дня");
    expect(formatDueDate("2026-09-26", "de")).toBe(formatDueDate("2026-09-26", "en"));
    expect(formatDueDate("2026-09-26", "de")).not.toBe(
      new Intl.DateTimeFormat("de", { day: "numeric", month: "short" }).format(new Date(2026, 8, 26))
    );
    expect(formatDueDateRelative("2026-09-27", "de", NOW)).toBe("in 3 days");
    expect(formatDueDateRelative("2026-09-25", "zh-CN", NOW)).toBe("tomorrow");
  });

  it("names the section after the task and never shows a raw shape id for an untitled card (B9)", () => {
    expect(getPpmTranslation("ru", "canvas.inspector_label").replace("{identifier}", "ROBOT-12")).toBe(
      "Живая карточка · ROBOT-12"
    );
    expect(getPpmTranslation("en", "canvas.inspector_label").replace("{identifier}", "ROBOT-12")).toBe(
      "Live card · ROBOT-12"
    );
    expect(inspectorSource).toContain(
      'fillCanvasTemplate(ppmT("canvas.inspector_label"), { identifier: identity.identifier })'
    );
    expect(getPpmTranslation("ru", "canvas.untitled")).toBe("Без названия");
    expect(getPpmTranslation("en", "canvas.untitled")).toBe("Untitled");
    expect(canvasNodeTitle(["ROBOT-7", "Выбрать датчик"], "Без названия")).toBe("ROBOT-7 · Выбрать датчик");
    expect(canvasNodeTitle([null, ""], "Без названия")).toBe("Без названия");
    expect(canvasNodeTitle(["  "], "Без названия")).toBe("Без названия");
    expect(inspectorSource).not.toMatch(/return shapeId;|: shapeId;/);
  });

  it("shows default state names in the UI language without changing the select values (R11, B4)", () => {
    expect(inspectorSource).toContain("<option key={state.id} value={state.id}>");
    expect(inspectorSource).toContain("{getPpmStateDisplayName(state, currentLocale) ?? state.name}");
    expect(inspectorSource).toContain('getPpmStateDisplayName(display.state, currentLocale) ?? "—"');
  });

  it("is a sibling of <Tldraw>, not part of the remounting overlay (R14)", () => {
    const tldrawEnd = editorSource.indexOf("</Tldraw>");
    const mount = editorSource.indexOf("<PpmCanvasInspector");
    expect(mount).toBeGreaterThan(tldrawEnd);
    const overlay = editorSource.slice(
      editorSource.indexOf("InFrontOfTheCanvas: () => ("),
      editorSource.indexOf("const projectionContext = useMemo(")
    );
    expect(overlay).not.toContain("PpmCanvasInspector");
  });

  it("never adds a second dialog to the editor and edits through the projection path", () => {
    expect(inspectorSource).not.toMatch(/role="dialog"|aria-modal/);
    expect(inspectorSource).toContain("onUpdate(shapeId, binding,");
    expect(getPpmTranslation("ru", "canvas.inspector_hint")).toBe(
      "Правки сохраняются в задаче, карточка на холсте обновится сама."
    );
    expect(getPpmTranslation("ru", "canvas.inspector_links")).toBe("Связи на холсте");
  });
});
