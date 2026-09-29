/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useTheme } from "next-themes";
// plane imports
import { Button } from "@plane/propel/button";
import { useTranslation } from "@plane/i18n";
import { getPpmTranslation, isPpmBrandEnabled } from "@ppm/brand";
import { PpmState } from "@/components/ppm-shell/state";
// assets
import maintenanceModeDarkModeImage from "@/app/assets/instance/maintenance-mode-dark.svg?url";
import maintenanceModeLightModeImage from "@/app/assets/instance/maintenance-mode-light.svg?url";
// layouts
import DefaultLayout from "@/layouts/default-layout";

// Line R2-5: under the PPM brand (not only the full shell) the page offers no Plane support address, status page or
// X account — the PPM state asks the PPM administrator. PPM_BRAND_ENABLED=0 keeps the upstream page and its links.
const IS_PPM_BRAND_ENABLED = isPpmBrandEnabled(process.env.PPM_BRAND_ENABLED);

// Production Error Component
interface ProdErrorComponentProps {
  onGoHome: () => void;
  onReload: () => void;
}

export function ProdErrorComponent({ onGoHome, onReload }: ProdErrorComponentProps) {
  // hooks
  const { resolvedTheme } = useTheme();
  const { currentLocale } = useTranslation();

  // derived values
  const maintenanceModeImage = resolvedTheme === "dark" ? maintenanceModeDarkModeImage : maintenanceModeLightModeImage;

  if (IS_PPM_BRAND_ENABLED) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <PpmState
          variant="error"
          title={getPpmTranslation(currentLocale, "state.error_title")}
          description={`${getPpmTranslation(currentLocale, "state.error_description")} ${getPpmTranslation(currentLocale, "ui.support.error_contact")}`}
          actions={
            <div className="flex flex-wrap justify-center gap-3">
              <Button variant="primary" size="lg" onClick={onGoHome}>
                {getPpmTranslation(currentLocale, "actions.go_home")}
              </Button>
              <Button variant="secondary" size="lg" onClick={onReload}>
                {getPpmTranslation(currentLocale, "actions.reload")}
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  // The upstream page only (PPM_BRAND_ENABLED=0): Plane's support, status page and X account.
  const upstreamLinks = [
    {
      key: "mail_to",
      label: "Contact Support",
      value: "mailto:support@plane.so",
    },
    {
      key: "status",
      label: "Status Page",
      value: "https://status.plane.so/",
    },
    {
      key: "twitter_handle",
      label: "@planepowers",
      value: "https://x.com/planepowers",
    },
  ];

  return (
    <DefaultLayout>
      <div className="relative container mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-2 gap-y-6 bg-surface-1 px-6 text-center">
        <div className="relative w-full">
          <img
            src={maintenanceModeImage}
            height="176"
            width="288"
            alt="ProjectSettingImg"
            className="h-full w-full object-fill object-center"
          />
        </div>
        <div className="relative mt-4 flex w-full flex-col gap-4">
          <div className="flex flex-col gap-2.5">
            <h1 className="text-left text-18 font-semibold text-primary">&#x1F6A7; Looks like something went wrong!</h1>
            <span className="text-left text-14 font-medium text-secondary">
              We track these errors automatically and working on getting things back up and running. If the problem
              persists feel free to contact us. In the meantime, try refreshing.
            </span>
          </div>

          <div className="mt-1 flex items-center justify-start gap-6">
            {upstreamLinks.map((link) => (
              <div key={link.key}>
                <a
                  href={link.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-13 text-accent-primary hover:underline"
                >
                  {link.label}
                </a>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-start gap-6">
            <Button variant="primary" size="lg" onClick={onGoHome}>
              Go to home
            </Button>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
}
