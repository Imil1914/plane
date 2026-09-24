/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { LANGUAGE_STORAGE_KEY, applyTranslationOverlay, setLanguage } from "@plane/i18n";
import type { TLanguage } from "@plane/i18n";
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

  return children;
}
