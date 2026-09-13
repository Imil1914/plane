/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { isPpmShellEnabled } from "@ppm/brand";
// hooks
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export function MaintenanceMessage() {
  const ppmT = usePpmTranslation();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const linkMap = [
    {
      key: "mail_to",
      label: "Contact Support",
      value: "mailto:support@plane.so",
    },
  ];

  if (isPpmShell) {
    return (
      <div className="flex flex-col gap-2.5">
        <h1 className="text-left text-18 font-semibold text-primary">🚧 {ppmT("state.maintenance_title")}</h1>
        <span className="text-left text-14 font-medium text-secondary">{ppmT("state.maintenance_description")}</span>
      </div>
    );
  }

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
