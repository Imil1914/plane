/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Settings, UserPlus } from "lucide-react";
import { Menu } from "@headlessui/react";
// plane imports
import { EUserPermissions, ROLE_DETAILS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { CheckIcon } from "@plane/propel/icons";
import type { IWorkspace } from "@plane/types";
import { cn, getFileURL } from "@plane/utils";
import { isPpmShellEnabled } from "@ppm/brand";
// hooks
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { canAccessPpmWorkspaceAdministration } from "@/helpers/ppm-workspace-access.helper";

type TProps = {
  workspace: IWorkspace;
  activeWorkspace: IWorkspace | null;
  handleItemClick: () => void;
  handleWorkspaceNavigation: (workspace: IWorkspace) => void;
  handleClose: () => void;
};
const SidebarDropdownItem = observer(function SidebarDropdownItem(props: TProps) {
  const { workspace, activeWorkspace, handleItemClick, handleWorkspaceNavigation, handleClose } = props;
  // router
  const { workspaceSlug } = useParams();
  // hooks
  const { t } = useTranslation();
  const { isGlobalAdmin } = usePpmAdminAccess();
  const ppmT = usePpmTranslation();

  const isActive = workspace.id === activeWorkspace?.id;
  const roleDetails = ROLE_DETAILS[workspace.role as keyof typeof ROLE_DETAILS];
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const canAccessWorkspaceAdministration = canAccessPpmWorkspaceAdministration({
    isGlobalAdmin,
    isPpmShell,
  });
  const canOpenWorkspaceSettings = isPpmShell
    ? canAccessWorkspaceAdministration
    : [EUserPermissions.ADMIN, EUserPermissions.MEMBER].includes(workspace?.role);
  const canOpenWorkspaceMembers = isPpmShell
    ? canAccessWorkspaceAdministration
    : [EUserPermissions.ADMIN].includes(workspace?.role);
  const workspaceRoleLabel = isPpmShell
    ? ppmT(isGlobalAdmin ? "access.global_admin" : "access.member")
    : roleDetails
      ? t(roleDetails.i18n_title)
      : t("guest");

  return (
    <Menu.Item
      as="div"
      className={cn("mx-2 mb-1 rounded-lg border border-transparent p-2 transition-colors", {
        "border-subtle bg-layer-transparent-active": isActive,
        "hover:bg-layer-transparent-hover": !isActive,
      })}
      id={workspace.id}
    >
      <Link
        key={workspace.id}
        href={`/${workspace.slug}`}
        onClick={() => {
          handleWorkspaceNavigation(workspace);
          handleItemClick();
        }}
        className="flex w-full items-center justify-between gap-3 rounded-md p-1 text-primary outline-none"
      >
        <div className="relative flex min-w-0 flex-1 items-center justify-start gap-3">
          <span
            className={`relative flex size-9 flex-shrink-0 items-center justify-center border border-subtle text-14 font-semibold uppercase ${
              !workspace?.logo_url && "rounded-lg bg-accent-primary text-on-color"
            }`}
          >
            {workspace?.logo_url && workspace.logo_url !== "" ? (
              <img
                src={getFileURL(workspace.logo_url)}
                className="absolute inset-0 size-full rounded-lg object-cover"
                alt={t("workspace_logo")}
              />
            ) : (
              (workspace?.name?.[0] ?? "...")
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div
              className={`truncate text-left text-14 font-semibold text-ellipsis ${workspaceSlug === workspace.slug ? "" : "text-secondary"}`}
            >
              {workspace.name}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-12 text-tertiary">
              <span className="truncate">{workspaceRoleLabel}</span>
              <span className="size-1 flex-shrink-0 rounded-full bg-layer-1" />
              <span className="flex-shrink-0">{t("member", { count: workspace.total_members || 0 })}</span>
            </div>
          </div>
        </div>
        {isActive ? (
          <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-layer-2">
            <CheckIcon className="size-4 text-primary" />
          </span>
        ) : null}
      </Link>
      {isActive && (
        <div className="mt-2 grid grid-cols-2 gap-2 border-t border-subtle pt-2">
          {canOpenWorkspaceSettings && (
            <Link
              href={`/${workspace.slug}/settings`}
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-subtle bg-layer-2 px-3 py-2 text-secondary transition-colors hover:border-strong hover:bg-layer-1 hover:text-primary"
            >
              <Settings className="size-4 flex-shrink-0" />
              <span className="truncate text-13 font-medium">{t("settings")}</span>
            </Link>
          )}
          {canOpenWorkspaceMembers && (
            <Link
              href={`/${workspace.slug}/settings/members`}
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-subtle bg-layer-2 px-3 py-2 text-secondary transition-colors hover:border-strong hover:bg-layer-1 hover:text-primary"
            >
              <UserPlus className="size-4 flex-shrink-0" />
              <span className="truncate text-13 font-medium">{t("workspace_settings.settings.members.title")}</span>
            </Link>
          )}
        </div>
      )}
    </Menu.Item>
  );
});

export default SidebarDropdownItem;
