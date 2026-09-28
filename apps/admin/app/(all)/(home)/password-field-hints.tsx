/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { TriangleAlert } from "lucide-react";
// plane imports
import { getPasswordInputHints } from "@plane/utils";
import type { TPasswordInputHint } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";

// PPM line L: the same hints as under the password fields of the web sign-in screens (apps/web
// core/components/account/auth-forms/password-field-hints.tsx) — Caps Lock, the Russian layout, a space copied at an
// edge. They only inform; they never block submitting.
export const PASSWORD_HINT_TEXT_KEYS: Record<TPasswordInputHint, TPpmTranslationKey> = {
  caps_lock: "auth.hint_caps_lock",
  cyrillic: "auth.hint_cyrillic",
  edge_whitespace: "auth.hint_edge_whitespace",
};

/** Caps Lock state of one password field, read on every key press and forgotten on blur; props for the input. */
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
  t: (key: TPpmTranslationKey) => string;
};

export function PasswordFieldHints(props: TPasswordFieldHints) {
  const { id, value, isCapsLockOn, t } = props;
  const hints = getPasswordInputHints(value, isCapsLockOn);

  return (
    // The live region stays in the page even when empty (screen readers skip a region that appears with its text);
    // only its spacing goes away while there is nothing to say.
    <div id={id} aria-live="polite" className="space-y-1 empty:mb-0">
      {hints.map((hint) => (
        <p key={hint} className="flex items-start gap-1 px-0.5 text-11 text-warning-primary">
          <TriangleAlert height={12} width={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {t(PASSWORD_HINT_TEXT_KEYS[hint])}
        </p>
      ))}
    </div>
  );
}
