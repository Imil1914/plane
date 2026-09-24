// UX0.2 final fix F2: the Git and Vault form dialogs run on Plane ModalCore (Headless UI Dialog) for its
// focus trap and focus return, but a stray click on the backdrop must not close them and discard typed
// input. Only Escape dismisses, and never while a request is running.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handlePpmDialogKeyDown, shouldDismissPpmDialog } from "@/helpers/ppm-dialog-dismiss.helper";

const keyEvent = (code: string, defaultPrevented = false) => ({ code, defaultPrevented, preventDefault: vi.fn() });

describe("shouldDismissPpmDialog", () => {
  it("never dismisses on a backdrop click", () => {
    expect(shouldDismissPpmDialog({ reason: "backdrop", saving: false })).toBe(false);
    expect(shouldDismissPpmDialog({ reason: "backdrop", saving: true })).toBe(false);
  });

  it("dismisses on Escape only while idle", () => {
    expect(shouldDismissPpmDialog({ reason: "escape", saving: false })).toBe(true);
    expect(shouldDismissPpmDialog({ reason: "escape", saving: true })).toBe(false);
  });
});

describe("handlePpmDialogKeyDown", () => {
  it("closes on Escape while idle and consumes the event", () => {
    const event = keyEvent("Escape");
    const onClose = vi.fn();
    handlePpmDialogKeyDown(event, { saving: false, onClose });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("swallows Escape during a request without closing", () => {
    const event = keyEvent("Escape");
    const onClose = vi.fn();
    handlePpmDialogKeyDown(event, { saving: true, onClose });
    expect(onClose).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys and Escape already handled by a nested control", () => {
    const onClose = vi.fn();
    const other = keyEvent("KeyQ");
    const handled = keyEvent("Escape", true);
    handlePpmDialogKeyDown(other, { saving: false, onClose });
    handlePpmDialogKeyDown(handled, { saving: false, onClose });
    expect(onClose).not.toHaveBeenCalled();
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(handled.preventDefault).not.toHaveBeenCalled();
  });
});

describe("Git and Vault dialogs route dismissal through the PPM policy", () => {
  const CORE = new URL("../../core/components/", import.meta.url);
  it.each(["ppm-git/route.tsx", "ppm-vault/route.tsx"])("%s", (file) => {
    const source = readFileSync(new URL(file, CORE), "utf8");
    // Headless UI calls handleClose for Escape AND for a click outside the panel.
    expect(source).not.toMatch(/handleClose=\{saving \? undefined : onClose\}/);
    expect(source).toMatch(/shouldDismissPpmDialog\(\{ reason: "backdrop", saving \}\)/);
    expect(source).toMatch(/onKeyDown=\{\(event\) => handlePpmDialogKeyDown\(event, \{ saving, onClose \}\)\}/);
  });
});
