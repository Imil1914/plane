import { describe, expect, it } from "vitest";
import { getPpmTranslation } from "@ppm/brand";
import {
  formatCanvasSavedTime,
  formatCanvasStatusParts,
  formatCanvasZoom,
  isCanvasCommandAllowedReadOnly,
} from "@/components/ppm-canvas/board-workspace-state";
import { fillCanvasTemplate } from "@/components/ppm-canvas/canvas-grammar";
import { createCanvasZoomStore } from "@/components/ppm-canvas/canvas-zoom-store";
import { PPM_CANVAS_COMMANDS } from "@/components/ppm-canvas/commands";

// Local time on purpose: the footer shows the save time in the viewer's time zone.
const NOW = new Date(2026, 8, 24, 18, 0);
const SAVED = new Date(2026, 8, 24, 12, 41).toISOString();
const base = {
  activeBoardIds: ["a", "b", "c"],
  boardId: "b",
  locale: "ru",
  now: NOW,
  roleKey: "canvas.shared_badge" as const,
  savedAt: SAVED,
  statusKey: "canvas.sync_saved",
};

describe("canvas status line (UX1.1 C1)", () => {
  it("shows the sheet position only when the project has several boards", () => {
    expect(formatCanvasStatusParts(base).sheet).toEqual({ index: 2, total: 3 });
    expect(formatCanvasStatusParts({ ...base, activeBoardIds: ["b"] }).sheet).toBeNull();
    expect(formatCanvasStatusParts({ ...base, boardId: "missing" }).sheet).toBeNull();
    const sheet = getPpmTranslation("ru", "canvas.status_sheet").replace("{index}", "2").replace("{total}", "3");
    expect(sheet).toBe("Лист 2 из 3");
  });

  it("keeps the exact saved label and adds the time only next to it", () => {
    expect(getPpmTranslation("ru", "canvas.sync_saved")).toBe("Все изменения сохранены");
    expect(formatCanvasStatusParts(base).time).toEqual({ iso: SAVED, label: "12:41" });
    for (const statusKey of [
      "canvas.sync_saving",
      "canvas.sync_error",
      "canvas.sync_loading",
      "canvas.read_only_title",
    ]) {
      expect(formatCanvasStatusParts({ ...base, statusKey }).time, statusKey).toBeNull();
    }
    expect(formatCanvasStatusParts({ ...base, savedAt: null }).time).toBeNull();
  });

  it("never shows a version and never repeats the shared badge", () => {
    const parts = formatCanvasStatusParts(base);
    expect(Object.keys(parts)).toEqual(["sheet", "time", "role"]);
    expect(parts.role).toBeNull();
    expect(
      formatCanvasStatusParts({ ...base, roleKey: "canvas.read_only_title", statusKey: "canvas.sync_error" }).role
    ).toBe("canvas.read_only_title");
  });

  it("formats today's save as HH:MM and older saves with the date", () => {
    expect(formatCanvasSavedTime(SAVED, "ru", NOW)).toBe("12:41");
    expect(formatCanvasSavedTime(new Date(2026, 8, 23, 9, 5).toISOString(), "ru", NOW)).toMatch(/^23 сент\.?,? 09:05$/);
    expect(formatCanvasSavedTime("not a date", "ru", NOW)).toBeNull();
  });

  it("formats the save time in the UI language: ru* → ru, anything else → en (as in Tasks)", () => {
    expect(formatCanvasSavedTime(SAVED, "ru-RU", NOW)).toBe("12:41");
    expect(formatCanvasSavedTime(SAVED, "de", NOW)).toBe(formatCanvasSavedTime(SAVED, "en", NOW));
    expect(formatCanvasSavedTime(SAVED, "de", NOW)).not.toBe("12:41");
    expect(formatCanvasStatusParts({ ...base, locale: "fr" }).time?.label).toBe(
      formatCanvasSavedTime(SAVED, "en", NOW)
    );
  });

  it("formats zoom with a non-breaking space and a localized reset label", () => {
    // U+00A0: «100 %» never wraps between the number and the sign.
    expect(formatCanvasZoom(100)).toBe("100\u00a0%");
    expect(formatCanvasZoom(49.6)).toBe("50\u00a0%");
    expect(fillCanvasTemplate(getPpmTranslation("ru", "canvas.zoom_reset_label"), { zoom: 100 })).toBe(
      "Масштаб 100\u00a0%, сбросить"
    );
    expect(fillCanvasTemplate(getPpmTranslation("en", "canvas.zoom_reset_label"), { zoom: 100 })).toBe(
      "Zoom 100\u00a0%, reset"
    );
    expect(getPpmTranslation("ru", "canvas.zoom_reset_label")).not.toMatch(/Приблизить|Отдалить/);
  });

  it("lets readers reset zoom only in the v2 design", () => {
    expect(PPM_CANVAS_COMMANDS).toContain("zoom-reset");
    for (const command of ["select", "fit-view", "zoom-in", "zoom-out"]) {
      expect(isCanvasCommandAllowedReadOnly(command, false), command).toBe(true);
      expect(isCanvasCommandAllowedReadOnly(command, true), command).toBe(true);
    }
    expect(isCanvasCommandAllowedReadOnly("zoom-reset", true)).toBe(true);
    expect(isCanvasCommandAllowedReadOnly("zoom-reset", false)).toBe(false);
    expect(isCanvasCommandAllowedReadOnly("add-note", true)).toBe(false);
    expect(isCanvasCommandAllowedReadOnly("open-tasks", true)).toBe(true);
    expect(isCanvasCommandAllowedReadOnly("draw-rectangle", true)).toBe(false);
    // AF2.1 F2: the tasks panel is a v2 tool; v1 keeps the UX1.1 read-only set.
    expect(isCanvasCommandAllowedReadOnly("open-tasks", false)).toBe(false);
  });

  it("publishes zoom per board and skips unchanged values", () => {
    const store = createCanvasZoomStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    expect(store.get("a")).toBe(100);
    store.set("a", 80);
    store.set("a", 80);
    store.set("b", 120);
    expect([store.get("a"), store.get("b"), calls]).toEqual([80, 120, 2]);
    unsubscribe();
    store.set("a", 60);
    expect(calls).toBe(2);
  });
});
