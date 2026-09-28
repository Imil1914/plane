/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { TriangleAlert } from "lucide-react";
// plane imports
import { cn, getPasswordInputHints } from "@plane/utils";
import type { TPasswordInputHint } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";
// hooks
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

// PPM line L (owner request 2026-09-28): why a correct password may be rejected — Caps Lock, the Russian layout, a
// space copied at an edge. The hints only inform; they never block submitting.
export const PASSWORD_HINT_TEXT_KEYS: Record<TPasswordInputHint, TPpmTranslationKey> = {
  caps_lock: "auth.hint_caps_lock",
  cyrillic: "auth.hint_cyrillic",
  edge_whitespace: "auth.hint_edge_whitespace",
};

/**
 * Caps Lock state of one password field. Browsers report Caps Lock only with an event, so it is read on every key
 * press in the field and forgotten on blur (it may change while the field is not focused). `inputProps` go on the
 * input: the key handlers and the link to the hints for screen readers; empty when the hints are off.
 */
export function usePasswordFieldHints(hintsId: string, enabled: boolean) {
  const [isCapsLockOn, setIsCapsLockOn] = useState(false);
  const readCapsLock = (event: KeyboardEvent<HTMLInputElement>) => setIsCapsLockOn(event.getModifierState("CapsLock"));

  return {
    isCapsLockOn,
    inputProps: enabled ? { onKeyDown: readCapsLock, onKeyUp: readCapsLock, "aria-describedby": hintsId } : {},
    resetCapsLock: () => setIsCapsLockOn(false),
  };
}

type TPasswordFieldHints = {
  id: string;
  value: string;
  isCapsLockOn: boolean;
  // Spacing in a flex column with a gap, where the region sits next to its input: e.g. "mt-2 empty:mt-0".
  className?: string;
};

/** The hints under a password field, in the look of the other notes under the sign-in fields. */
export function PasswordFieldHints(props: TPasswordFieldHints) {
  const { id, value, isCapsLockOn, className } = props;
  const ppmT = usePpmTranslation();
  const hints = getPasswordInputHints(value, isCapsLockOn);

  return (
    // The live region stays in the page even when empty (screen readers skip a region that appears with its text);
    // only its spacing goes away while there is nothing to say.
    <div id={id} aria-live="polite" className={cn("space-y-1 empty:mb-0", className)}>
      {hints.map((hint) => (
        <p key={hint} className="flex items-start gap-1 px-0.5 text-11 text-warning-primary">
          <TriangleAlert height={12} width={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {ppmT(PASSWORD_HINT_TEXT_KEYS[hint])}
        </p>
      ))}
    </div>
  );
}
