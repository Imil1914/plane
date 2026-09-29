/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// ui
import { Button } from "@plane/propel/button";
import { isPpmBrandEnabled } from "@ppm/brand";
// helpers
import { useAuthLanguage } from "@/helpers/ppm-auth-language";

// Line R2-5: under the PPM brand the published pages send nobody to Plane's support mailbox or forum — the text asks
// the PPM administrator, in the interface language. PPM_BRAND_ENABLED=0 keeps the upstream page.
const IS_PPM_BRAND_ENABLED = isPpmBrandEnabled(process.env.PPM_BRAND_ENABLED);

function ErrorPage() {
  const { t } = useAuthLanguage();

  const handleRetry = () => {
    window.location.reload();
  };

  if (IS_PPM_BRAND_ENABLED)
    return (
      <div className="grid h-screen place-items-center bg-surface-1 p-4">
        <div className="space-y-8 text-center">
          <div className="space-y-2">
            <h3 className="text-16 font-semibold">{t("ui.support.space_error_title")}</h3>
            <p className="mx-auto text-13 text-secondary md:w-1/2">{t("ui.support.space_error_description")}</p>
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button variant="primary" size="lg" onClick={handleRetry}>
              {t("ui.support.refresh")}
            </Button>
          </div>
        </div>
      </div>
    );

  return (
    <div className="grid h-screen place-items-center bg-surface-1 p-4">
      <div className="space-y-8 text-center">
        <div className="space-y-2">
          <h3 className="text-16 font-semibold">Yikes! That doesn{"'"}t look good.</h3>
          <p className="mx-auto text-13 text-secondary md:w-1/2">
            That crashed Plane, pun intended. No worries, though. Our engineers have been notified. If you have more
            details, please write to{" "}
            <a href="mailto:support@plane.so" className="text-accent-primary">
              support@plane.so
            </a>{" "}
            or on our{" "}
            <a href="https://forum.plane.so" target="_blank" className="text-accent-primary" rel="noopener noreferrer">
              Forum
            </a>
            .
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button variant="primary" size="lg" onClick={handleRetry}>
            Refresh
          </Button>
          {/* <Button variant="secondary" size="lg" onClick={() => {}}>
            Sign out
          </Button> */}
        </div>
      </div>
    </div>
  );
}

export default ErrorPage;
