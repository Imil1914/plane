/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import { CircleMinus } from "lucide-react";
import { Disclosure } from "@headlessui/react";
// plane imports
import { EUserPermissions, MEMBER_TRACKER_ELEMENTS } from "@plane/constants";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { EUserProjectRoles, IUser, IWorkspaceMember, TProjectMembership } from "@plane/types";
import { CustomMenu, CustomSelect } from "@plane/ui";
import { getFileURL } from "@plane/utils";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export interface RowData extends Pick<TProjectMembership, "original_role"> {
  member: IWorkspaceMember;
}

type NameProps = {
  rowData: RowData;
  workspaceSlug: string;
  isAdmin: boolean;
  currentUser: IUser | undefined;
  setRemoveMemberModal: (rowData: RowData) => void;
};

type AccountTypeProps = {
  rowData: RowData;
  currentProjectRole: EUserPermissions | undefined;
  workspaceSlug: string;
  projectId: string;
};

export function NameColumn(props: NameProps) {
  const { rowData, workspaceSlug, isAdmin, currentUser, setRemoveMemberModal } = props;
  // derived values
  const { avatar_url, display_name, email, first_name, id, last_name } = rowData.member;
  const { isGlobalAdmin: isCurrentUserGlobalAdmin } = usePpmAdminAccess();
  const ppmT = usePpmTranslation();
  const isGlobalAdmin = isCurrentUserGlobalAdmin && currentUser?.id === rowData.member.id;

  return (
    <Disclosure>
      {() => (
        <div className="group relative">
          <div className="flex w-72 items-center gap-2">
            <div className="flex flex-1 items-center gap-x-2 gap-y-2">
              {avatar_url && avatar_url.trim() !== "" ? (
                <Link href={`/${workspaceSlug}/profile/${id}`}>
                  <span className="relative flex size-6 items-center justify-center rounded-full text-on-color capitalize">
                    <img
                      src={getFileURL(avatar_url)}
                      className="absolute top-0 left-0 h-full w-full rounded-full object-cover"
                      alt={display_name || email}
                    />
                  </span>
                </Link>
              ) : (
                <Link href={`/${workspaceSlug}/profile/${id}`}>
                  <span className="relative flex size-6 items-center justify-center rounded-full bg-layer-3 text-11 text-on-color capitalize">
                    {(email ?? display_name ?? "?")[0]}
                  </span>
                </Link>
              )}
              {first_name} {last_name}
            </div>
            {!isGlobalAdmin && (isAdmin || id === currentUser?.id) && (
              <CustomMenu
                ellipsis
                buttonClassName="p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                optionsClassName="p-1.5"
                placement="bottom-end"
              >
                <CustomMenu.MenuItem>
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-x-1 font-medium text-danger-primary"
                    data-ph-element={MEMBER_TRACKER_ELEMENTS.PROJECT_MEMBER_TABLE_CONTEXT_MENU}
                    onClick={() => setRemoveMemberModal(rowData)}
                  >
                    <CircleMinus className="size-3.5 flex-shrink-0" />
                    {rowData.member?.id === currentUser?.id ? ppmT("members.leave") : ppmT("members.remove")}
                  </button>
                </CustomMenu.MenuItem>
              </CustomMenu>
            )}
          </div>
        </div>
      )}
    </Disclosure>
  );
}

export const AccountTypeColumn = observer(function AccountTypeColumn(props: AccountTypeProps) {
  const { rowData, projectId, workspaceSlug } = props;
  // store hooks
  const {
    project: { updateMemberRole },
    workspace: { getWorkspaceMemberDetails },
  } = useMember();
  const { data: currentUser } = useUser();
  const { isGlobalAdmin: isCurrentUserGlobalAdmin } = usePpmAdminAccess();
  const { getProjectRoleByWorkspaceSlugAndProjectId } = useUserPermissions();
  const ppmT = usePpmTranslation();
  // form info
  const {
    control,
    formState: { errors },
  } = useForm();
  // derived values
  const isCurrentUser = currentUser?.id === rowData.member.id;
  const isRowDataGlobalAdmin = isCurrentUserGlobalAdmin && isCurrentUser;
  const currentProjectRole = getProjectRoleByWorkspaceSlugAndProjectId(workspaceSlug, projectId);
  const getRoleLabel = (role: number) => {
    if (isRowDataGlobalAdmin) return ppmT("access.global_admin");
    if (role === EUserPermissions.ADMIN) return ppmT("access.project_lead");
    if (role === EUserPermissions.MEMBER) return ppmT("access.member");
    return ppmT("access.guest");
  };
  const roleLabel = getRoleLabel(rowData.original_role ?? EUserPermissions.GUEST);

  const isCurrentUserProjectAdmin = currentProjectRole
    ? ![EUserPermissions.MEMBER, EUserPermissions.GUEST].includes(Number(currentProjectRole))
    : false;

  // logic
  // The global administrator inherits every project and cannot be changed here.
  const isRoleEditable = isCurrentUserProjectAdmin && !isRowDataGlobalAdmin && !isCurrentUser;
  const checkCurrentOptionWorkspaceRole = (value: string) => {
    const currentMemberWorkspaceRole = getWorkspaceMemberDetails(value)?.role as EUserPermissions | undefined;
    if (!value || !currentMemberWorkspaceRole)
      return [EUserPermissions.GUEST, EUserPermissions.MEMBER, EUserPermissions.ADMIN];

    const isGuest = [EUserPermissions.GUEST].includes(currentMemberWorkspaceRole);

    return [EUserPermissions.GUEST, EUserPermissions.MEMBER, EUserPermissions.ADMIN].filter(
      (role) => !isGuest || role === EUserPermissions.GUEST
    );
  };

  return (
    <>
      {isRoleEditable ? (
        <Controller
          name="role"
          control={control}
          rules={{ required: ppmT("members.role_required") }}
          render={() => (
            <CustomSelect
              value={rowData.original_role}
              onChange={async (value: EUserProjectRoles) => {
                if (!workspaceSlug) return;
                await updateMemberRole(workspaceSlug.toString(), projectId.toString(), rowData.member.id, value).catch(
                  (err) => {
                    console.log(err, "err");
                    const error = err.error;
                    const errorString = Array.isArray(error) ? error[0] : error;

                    setToast({
                      type: TOAST_TYPE.ERROR,
                      title: ppmT("members.role_update_error_title"),
                      message: errorString ?? ppmT("members.role_update_error_message"),
                    });
                  }
                );
              }}
              label={
                <div className="flex">
                  <span>{roleLabel}</span>
                </div>
              }
              buttonClassName={`!px-0 !justify-start hover:bg-surface-1 ${errors.role ? "border-danger-strong" : "border-none"}`}
              className="w-32 rounded-md p-0"
              input
            >
              {checkCurrentOptionWorkspaceRole(rowData.member.id).map((role) => (
                <CustomSelect.Option key={role} value={role}>
                  {getRoleLabel(role)}
                </CustomSelect.Option>
              ))}
            </CustomSelect>
          )}
        />
      ) : (
        <div className="flex w-32">
          <span>{roleLabel}</span>
        </div>
      )}
    </>
  );
});
