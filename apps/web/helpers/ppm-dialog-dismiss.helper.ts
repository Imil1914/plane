// Dismissal policy for the PPM form dialogs (Git, Vault). They run on Plane ModalCore (Headless UI Dialog)
// for its focus trap and focus return, but Headless UI reports Escape and a click outside the panel through
// the same onClose callback. A stray click on the backdrop must not discard typed input, so the dialogs
// handle Escape themselves on the panel and treat Headless UI's onClose as a backdrop click.

export type TPpmDialogDismissReason = "escape" | "backdrop";

export function shouldDismissPpmDialog({
  reason,
  saving,
}: {
  reason: TPpmDialogDismissReason;
  saving: boolean;
}): boolean {
  return reason === "escape" && !saving;
}

type TPpmDialogKeyEvent = {
  code: string;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

/**
 * Escape (by physical key, `event.code`) pressed inside the dialog panel. The event is consumed so Headless
 * UI's own window-level Escape handler does not run; Escape already handled by a nested control is ignored.
 */
export function handlePpmDialogKeyDown(
  event: TPpmDialogKeyEvent,
  { saving, onClose }: { saving: boolean; onClose: () => void }
): void {
  if (event.code !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  if (shouldDismissPpmDialog({ reason: "escape", saving })) onClose();
}
