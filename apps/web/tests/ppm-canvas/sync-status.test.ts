import { describe, expect, it } from "vitest";
import {
  footerRoleLabelKey,
  isBlockingCanvasStatus,
  shouldShowTabSyncDot,
} from "@/components/ppm-canvas/board-workspace-state";

describe("canvas sync status", () => {
  it("treats recovery, conflict, error and corrupt as blocking", () => {
    expect(isBlockingCanvasStatus("saved", false)).toBe(false);
    expect(isBlockingCanvasStatus("saving", false)).toBe(false);
    expect(isBlockingCanvasStatus("loading", false)).toBe(false);
    expect(isBlockingCanvasStatus(undefined, false)).toBe(false);
    for (const s of ["conflict", "error", "corrupt"] as const) expect(isBlockingCanvasStatus(s, false)).toBe(true);
    expect(isBlockingCanvasStatus("saved", true)).toBe(true);
  });

  it("shows the tab dot only for problems and saving", () => {
    expect(shouldShowTabSyncDot("saved")).toBe(false);
    expect(shouldShowTabSyncDot("loading")).toBe(false);
    expect(shouldShowTabSyncDot(undefined)).toBe(false);
    for (const s of ["saving", "error", "conflict", "corrupt"] as const) expect(shouldShowTabSyncDot(s)).toBe(true);
  });

  it("never repeats the read-only label in the footer", () => {
    expect(footerRoleLabelKey(true, "canvas.sync_saved")).toBe("canvas.shared_badge");
    expect(footerRoleLabelKey(false, "canvas.read_only_title")).toBeNull();
    expect(footerRoleLabelKey(false, "canvas.sync_error")).toBe("canvas.read_only_title");
  });
});
