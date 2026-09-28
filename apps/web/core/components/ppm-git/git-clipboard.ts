// G2.1 (R12): copying commands on the «Код» page. The Clipboard API exists only in a secure context (https,
// localhost) and may be refused; then a hidden, read-only text field is selected and copied the old way. The field
// sits inside the open dialog, if any, so the dialog's focus trap does not pull focus (and the selection) away.

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not allowed here (permissions, insecure origin): try the selection below.
  }
  return copyThroughSelection(text);
}

function copyThroughSelection(text: string): boolean {
  if (typeof document === "undefined" || !document?.body) return false;
  const active = document.activeElement as (Element & Partial<Pick<HTMLElement, "focus">>) | null;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  Object.assign(field.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
  const container = active?.closest('[role="dialog"]') ?? document.body;
  try {
    container.append(field);
    field.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    active?.focus?.();
  }
}
