/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useSyncExternalStore } from "react";
import { getPpmTranslation, isPpmShellEnabled, resolvePpmInitialLanguage } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";

// PPM line L: language of the /god-mode sign-in screen. /god-mode has no translations of its own; it follows the
// interface language the web app keeps in this browser (same origin, `LANGUAGE_STORAGE_KEY` of @plane/i18n), and
// Russian — the PPM default — when there is none. The admin build passes no PPM flags, so the PPM texts are on
// unless PPM_SHELL_ENABLED / PPM_BRAND_ENABLED are ever wired into its Vite config.
export const IS_PPM_SHELL_ENABLED = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

export const LANGUAGE_STORAGE_KEY = "userLanguage";

function readStoredLanguage(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribeToStoredLanguage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** The interface language for a stored language (`null`: none stored); English when the PPM shell is off. */
export function resolveAuthLanguage(storedLanguage: string | null, shellEnabled = IS_PPM_SHELL_ENABLED): string {
  return shellEnabled ? resolvePpmInitialLanguage(storedLanguage, true) : "en";
}

/** The interface language outside React (error helpers, route meta). */
export function getAuthLanguage(): string {
  return resolveAuthLanguage(typeof window === "undefined" ? null : readStoredLanguage());
}

/** The interface language and a translator of the PPM dictionary into it. */
export function useAuthLanguage() {
  const storedLanguage = useSyncExternalStore(subscribeToStoredLanguage, readStoredLanguage, () => null);
  const language = resolveAuthLanguage(storedLanguage);
  return { language, t: (key: TPpmTranslationKey) => getPpmTranslation(language, key) };
}
