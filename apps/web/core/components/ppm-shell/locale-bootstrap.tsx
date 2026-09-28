/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { LANGUAGE_STORAGE_KEY, applyTranslationOverlay, setLanguage, useTranslation } from "@plane/i18n";
import type { TLanguage } from "@plane/i18n";
import { setDateFormatLanguage } from "@plane/utils";
import { getPpmTranslation, isPpmShellEnabled, resolvePpmInitialLanguage } from "@ppm/brand";
import { PpmState } from "./state";

const IS_PPM_SHELL_ENABLED = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

export function PpmLocaleFallback() {
  if (!IS_PPM_SHELL_ENABLED) return null;

  return (
    <div className="flex h-screen w-full items-center justify-center bg-canvas">
      <PpmState
        variant="loading"
        title={getPpmTranslation("ru", "state.loading_title")}
        description={getPpmTranslation("ru", "state.loading_description")}
      />
    </div>
  );
}

export function PpmLocaleBootstrap({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(!IS_PPM_SHELL_ENABLED);

  useEffect(() => {
    if (!IS_PPM_SHELL_ENABLED) return;

    const storedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    const initialLanguage = resolvePpmInitialLanguage(storedLanguage, true) as TLanguage;

    // Register the RU overlay before switching language so it is merged into the bundles as they load.
    void import("@ppm/brand/i18n-overlay.json")
      .then((module) => applyTranslationOverlay(module.default))
      .catch((error: unknown) => console.error("[ppm] i18n overlay", error))
      .then(() => setLanguage(initialLanguage))
      .finally(() => setIsReady(true));
  }, []);

  if (!isReady) return <PpmLocaleFallback />;
  // Without the PPM shell the dates stay exactly as upstream renders them.
  if (!IS_PPM_SHELL_ENABLED) return children;

  return <PpmDateLanguage>{children}</PpmDateLanguage>;
}

/**
 * Dates from @plane/utils follow the interface language (Russian months, «22 сент. – 1 окт. 2026»). The language is
 * set while this wrapper renders — before any child formats a date — and again on every language switch.
 */
export function PpmDateLanguage({ children }: { children: React.ReactNode }) {
  const { currentLocale } = useTranslation();
  setDateFormatLanguage(currentLocale);

  return children;
}
