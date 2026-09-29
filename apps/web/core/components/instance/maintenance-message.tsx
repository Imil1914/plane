/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { isPpmBrandEnabled } from "@ppm/brand";
// hooks
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

// Line R2-5: under the PPM brand (not only the full shell) nothing sends people to Plane's support mailbox — the PPM
// text asks the PPM administrator, in the interface language. PPM_BRAND_ENABLED=0 keeps the upstream message.
const IS_PPM_BRAND_ENABLED = isPpmBrandEnabled(process.env.PPM_BRAND_ENABLED);

export function MaintenanceMessage() {
  const ppmT = usePpmTranslation();

  if (IS_PPM_BRAND_ENABLED) {
    return (
      <div className="flex flex-col gap-2.5">
        <h1 className="text-left text-18 font-semibold text-primary">🚧 {ppmT("state.maintenance_title")}</h1>
        <span className="text-left text-14 font-medium text-secondary">{ppmT("state.maintenance_description")}</span>
        <span className="text-left text-13 text-secondary">{ppmT("ui.support.maintenance_contact")}</span>
      </div>
    );
  }

  const linkMap = [
    {
      key: "mail_to",
      label: "Contact Support",
      value: "mailto:support@plane.so",
    },
  ];

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <h1 className="text-left text-18 font-semibold text-primary">
          &#x1F6A7; Looks like Plane didn&apos;t start up correctly!
        </h1>
        <span className="text-left text-14 font-medium text-secondary">
          Some services might have failed to start. Please check your container logs to identify and resolve the issue.
          If you&apos;re stuck, reach out to our support team for more help.
        </span>
      </div>
      <div className="mt-1 flex items-center justify-start gap-6">
        {linkMap.map((link) => (
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
    </>
  );
}
