/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// ui
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@plane/propel/tooltip";
import Link from "next/link";
import { getPpmTranslation, isPpmShellEnabled } from "@ppm/brand";
// hooks
import { usePlatformOS } from "@/hooks/use-platform-os";
import packageJson from "package.json";
// local components
import { Button } from "@plane/propel/button";
import { PaidPlanUpgradeModal } from "@/components/license/modal/upgrade-modal";

export const WorkspaceEditionBadge = observer(function WorkspaceEditionBadge() {
  // states
  const [isPaidPlanPurchaseModalOpen, setIsPaidPlanPurchaseModalOpen] = useState(false);
  // translation
  const { currentLocale, t } = useTranslation();
  // platform
  const { isMobile } = usePlatformOS();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

  if (isPpmShell) {
    return (
      <Tooltip tooltipContent={`PPM · Plane Community v${packageJson.version}`} isMobile={isMobile}>
        <Link
          href="/about/open-source"
          className="focus-visible:outline-accent-primary rounded-md px-2 py-1 text-11 font-medium text-tertiary hover:bg-layer-1 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {getPpmTranslation(currentLocale, "brand.open_source")}
        </Link>
      </Tooltip>
    );
  }

  return (
    <>
      <PaidPlanUpgradeModal
        isOpen={isPaidPlanPurchaseModalOpen}
        handleClose={() => setIsPaidPlanPurchaseModalOpen(false)}
      />
      <Tooltip tooltipContent={`Version: v${packageJson.version}`} isMobile={isMobile}>
        <Button
          variant="tertiary"
          size="lg"
          onClick={() => setIsPaidPlanPurchaseModalOpen(true)}
          aria-haspopup="dialog"
          aria-label={t("aria_labels.projects_sidebar.edition_badge")}
        >
          Community
        </Button>
      </Tooltip>
    </>
  );
});
