/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState, useEffect } from "react";
import { observer } from "mobx-react";
import { useRouter } from "next/navigation";
import { LogOut, Settings, ShieldCheck } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Avatar, CustomMenu } from "@plane/ui";
import { getFileURL } from "@plane/utils";
// components
import { CoverImage } from "@/components/common/cover-image";
// hooks
import { useAppTheme } from "@/hooks/store/use-app-theme";
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { useUser } from "@/hooks/store/user";

export const UserMenuRoot = observer(function UserMenuRoot() {
  // states
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  // router
  const router = useRouter();
  // store hooks
  const { toggleAnySidebarDropdown } = useAppTheme();
  const { data: currentUser } = useUser();
  const { signOut } = useUser();
  const { toggleProfileSettingsModal } = useCommandPalette();
  const { isGlobalAdmin } = usePpmAdminAccess();
  // translation
  const { t } = useTranslation();
  const ppmT = usePpmTranslation();

  const handleSignOut = () => {
    signOut().catch(() =>
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("auth.sign_out.toast.error.title"),
        message: t("auth.sign_out.toast.error.message"),
      })
    );
  };

  // Toggle sidebar dropdown state when menu is open
  useEffect(() => {
    if (isUserMenuOpen) toggleAnySidebarDropdown(true);
    else toggleAnySidebarDropdown(false);
  }, [isUserMenuOpen, toggleAnySidebarDropdown]);

  return (
    <CustomMenu
      className="flex items-center"
      customButton={
        <Avatar
          name={currentUser?.display_name}
          src={getFileURL(currentUser?.avatar_url ?? "")}
          size={20}
          shape="circle"
        />
      }
      customButtonClassName="grid size-8 place-items-center rounded-md text-tertiary hover:bg-layer-transparent-hover"
      ariaLabel={t("profile.label")}
      menuButtonOnClick={() => !isUserMenuOpen && setIsUserMenuOpen(true)}
      onMenuClose={() => setIsUserMenuOpen(false)}
      placement="bottom-end"
      maxHeight="2xl"
      optionsClassName="w-72 p-3 flex flex-col gap-y-3"
      closeOnSelect
    >
      <div className="relative h-29 w-full rounded-lg">
        <CoverImage
          src={currentUser?.cover_image_url ?? undefined}
          alt={currentUser?.display_name}
          className="h-29 w-full rounded-lg"
          showDefaultWhenEmpty
        />
        <div className="absolute inset-0 bg-layer-1/50" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="flex flex-col items-center gap-y-2">
            <div>
              <Avatar
                name={currentUser?.display_name}
                src={getFileURL(currentUser?.avatar_url ?? "")}
                size={40}
                shape="circle"
                className="text-18 font-medium"
              />
            </div>
            <div className="text-center">
              <p className="text-body-sm-medium">
                {currentUser?.first_name} {currentUser?.last_name}
              </p>
              <p className="text-caption-md-regular">{currentUser?.email}</p>
            </div>
          </div>
        </div>
      </div>
      <div>
        <CustomMenu.MenuItem
          onClick={() =>
            toggleProfileSettingsModal({
              activeTab: "general",
              isOpen: true,
            })
          }
          className="flex items-center gap-2"
        >
          <Settings className="size-3.5 shrink-0" />
          {t("profile.label")}
        </CustomMenu.MenuItem>
        {isGlobalAdmin && (
          <CustomMenu.MenuItem
            onClick={() => router.push("/ppm-admin")}
            className="mt-1 flex items-center gap-2 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20"
          >
            <ShieldCheck className="size-3.5 shrink-0" />
            {ppmT("admin.center")}
          </CustomMenu.MenuItem>
        )}
      </div>
      <CustomMenu.MenuItem onClick={handleSignOut} className="flex items-center gap-2">
        <LogOut className="size-3.5 shrink-0" />
        {t("sign_out")}
      </CustomMenu.MenuItem>
    </CustomMenu>
  );
});
