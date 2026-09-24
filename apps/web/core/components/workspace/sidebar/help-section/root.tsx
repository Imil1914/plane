/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { observer } from "mobx-react";
import { BookOpen, Bug, HelpCircle, Keyboard, User } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import { PageIcon } from "@plane/propel/icons";
// ui
import { CustomMenu } from "@plane/ui";
import { getPpmTranslation, isPpmShellEnabled, PPM_SOURCE_ATTRIBUTION } from "@ppm/brand";
// components
import { ProductUpdatesModal } from "@/components/global";
import { PlaneVersionNumber } from "@/components/global/version-number";
// hooks
import { usePowerK } from "@/hooks/store/use-power-k";

export const HelpMenuRoot = observer(function HelpMenuRoot() {
  // store hooks
  const { currentLocale, t } = useTranslation();
  const { toggleShortcutsListModal } = usePowerK();
  // states
  const [isNeedHelpOpen, setIsNeedHelpOpen] = useState(false);
  const [isProductUpdatesModalOpen, setProductUpdatesModalOpen] = useState(false);
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const ppmT = (key: Parameters<typeof getPpmTranslation>[1]) => getPpmTranslation(currentLocale, key);

  return (
    <>
      {!isPpmShell && (
        <ProductUpdatesModal isOpen={isProductUpdatesModalOpen} handleClose={() => setProductUpdatesModalOpen(false)} />
      )}

      <CustomMenu
        customButton={
          <>
            <HelpCircle className={isPpmShell ? "size-4" : "size-5"} aria-hidden="true" />
            {isPpmShell && <span className="hidden sm:inline">{ppmT("help.title")}</span>}
          </>
        }
        customButtonClassName={
          isPpmShell
            ? "flex h-8 items-center gap-1.5 rounded-md bg-layer-2 px-2.5 text-11 font-medium text-secondary transition-colors hover:bg-layer-2-hover"
            : "grid size-8 place-items-center rounded-md text-tertiary hover:bg-layer-transparent-hover hover:text-icon-secondary"
        }
        ariaLabel={ppmT("help.title")}
        menuButtonOnClick={() => !isNeedHelpOpen && setIsNeedHelpOpen(true)}
        onMenuClose={() => setIsNeedHelpOpen(false)}
        placement="bottom-end"
        maxHeight="lg"
        closeOnSelect
      >
        {isPpmShell ? (
          <>
            <CustomMenu.MenuItem onClick={() => window.open("/about/ppm-guide", "_blank", "noopener,noreferrer")}>
              <div className="flex items-center gap-x-2 rounded-sm text-11">
                <BookOpen className="size-3.5 text-secondary" aria-hidden="true" />
                <span>{ppmT("help.guide")}</span>
              </div>
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => toggleShortcutsListModal(true)}>
              <div className="flex items-center gap-x-2 rounded-sm text-11">
                <Keyboard className="size-3.5 text-secondary" aria-hidden="true" />
                <span>{ppmT("help.keyboard_shortcuts")}</span>
              </div>
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem
              onClick={() =>
                window.open(`${PPM_SOURCE_ATTRIBUTION.repository}/issues/new`, "_blank", "noopener,noreferrer")
              }
            >
              <div className="flex items-center gap-x-2 rounded-sm text-11">
                <Bug className="size-3.5 text-secondary" aria-hidden="true" />
                <span>{ppmT("help.report_problem")}</span>
              </div>
            </CustomMenu.MenuItem>
            <div className="mt-1 border-t border-subtle px-1 pt-2 text-11 text-secondary">
              {ppmT("help.version")}: v{PPM_SOURCE_ATTRIBUTION.version}
            </div>
          </>
        ) : (
          <>
            <CustomMenu.MenuItem onClick={() => window.open("https://go.plane.so/p-docs", "_blank")}>
              <div className="flex items-center gap-x-2 rounded-sm text-11">
                <PageIcon className="h-3.5 w-3.5 text-secondary" height={14} width={14} />
                <span className="text-11">{t("documentation")}</span>
              </div>
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => window.open("mailto:sales@plane.so", "_blank")}>
              <div className="flex items-center gap-x-2 rounded-sm text-11">
                <User className="h-3.5 w-3.5 text-secondary" size={14} />
                <span className="text-11">{t("contact_sales")}</span>
              </div>
            </CustomMenu.MenuItem>
            <div className="my-1 border-t border-subtle" />
            <CustomMenu.MenuItem onClick={() => toggleShortcutsListModal(true)}>
              <span className="text-11">{t("keyboard_shortcuts")}</span>
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => setProductUpdatesModalOpen(true)}>
              <span className="text-11">{t("whats_new")}</span>
            </CustomMenu.MenuItem>
            <CustomMenu.MenuItem onClick={() => window.open("https://forum.plane.so", "_blank", "noopener,noreferrer")}>
              <span className="text-11">Forum</span>
            </CustomMenu.MenuItem>
            <div className="mt-1 border-t border-subtle px-1 pt-2 text-11 text-secondary">
              <PlaneVersionNumber />
            </div>
          </>
        )}
      </CustomMenu>
    </>
  );
});
