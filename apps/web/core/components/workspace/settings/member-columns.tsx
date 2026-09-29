/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";

import { Disclosure } from "@headlessui/react";
// plane imports
import { EUserPermissions, EUserPermissionsLevel, MEMBER_TRACKER_ELEMENTS } from "@plane/constants";
import { TrashIcon, SuspendedUserIcon } from "@plane/propel/icons";
import { Pill, EPillVariant, EPillSize } from "@plane/propel/pill";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IUser, IWorkspaceMember } from "@plane/types";
// plane ui
import { CustomSelect, PopoverMenu } from "@plane/ui";
// helpers
import { getFileURL } from "@plane/utils";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import { usePpmAdminAccess } from "@/hooks/use-ppm-admin-access";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmMemberErrorMessage } from "./ppm-member-errors";

export interface RowData {
  member: IWorkspaceMember;
  role: EUserPermissions;
  is_active: boolean;
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
  workspaceSlug: string;
};

export function NameColumn(props: NameProps) {
  const { rowData, workspaceSlug, isAdmin, currentUser, setRemoveMemberModal } = props;
  // derived values
  const { avatar_url, display_name, email, first_name, id, last_name } = rowData.member;
  const isSuspended = rowData.is_active === false;
  const { isGlobalAdmin: isCurrentUserGlobalAdmin } = usePpmAdminAccess();
  const ppmT = usePpmTranslation();
  const isGlobalAdmin = isCurrentUserGlobalAdmin && currentUser?.id === id;

  return (
    <Disclosure>
      {() => (
        <div className="group relative">
          <div className="flex w-72 items-center justify-between gap-x-4 gap-y-2">
            <div className="flex flex-1 items-center gap-x-2 gap-y-2">
              {isSuspended ? (
                <div className="rounded-full bg-layer-1">
                  <SuspendedUserIcon className="size-6 text-placeholder" />
                </div>
              ) : avatar_url && avatar_url.trim() !== "" ? (
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
                  <span className="relative flex size-6 items-center justify-center rounded-full bg-layer-3 text-11 text-tertiary capitalize">
                    {(email ?? display_name ?? "?")[0]}
                  </span>
                </Link>
              )}
              <span className={isSuspended ? "text-placeholder" : ""}>
                {first_name} {last_name}
              </span>
            </div>

            {!isGlobalAdmin && !isSuspended && (isAdmin || id === currentUser?.id) && (
              <PopoverMenu
                data={[""]}
                keyExtractor={(item) => item}
                popoverClassName="justify-end"
                buttonClassName="outline-none	origin-center rotate-90 size-8 aspect-square flex-shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity"
                render={() => (
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-x-3"
                    onClick={() => setRemoveMemberModal(rowData)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setRemoveMemberModal(rowData);
                      }
                    }}
                    data-ph-element={MEMBER_TRACKER_ELEMENTS.WORKSPACE_MEMBER_TABLE_CONTEXT_MENU}
                  >
                    <TrashIcon className="size-3.5 align-middle" />
                    {id === currentUser?.id ? ppmT("members.leave") : ppmT("members.remove")}
                  </button>
                )}
              />
            )}
          </div>
        </div>
      )}
    </Disclosure>
  );
}

export const AccountTypeColumn = observer(function AccountTypeColumn(props: AccountTypeProps) {
  const { rowData, workspaceSlug } = props;
  // form info
  const {
    control,
    formState: { errors },
  } = useForm();
  // store hooks
  const { allowPermissions } = useUserPermissions();

  const {
    workspace: { updateMember },
  } = useMember();
  const { data: currentUser } = useUser();
  const { isGlobalAdmin: isCurrentUserGlobalAdmin } = usePpmAdminAccess();
  const ppmT = usePpmTranslation();
  const memberErrorMessage = usePpmMemberErrorMessage();

  // derived values
  const isCurrentUser = currentUser?.id === rowData.member.id;
  const isGlobalAdmin = isCurrentUserGlobalAdmin && isCurrentUser;
  const isAdminRole = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const isRoleNonEditable = isCurrentUser || isGlobalAdmin || !isAdminRole;
  const isSuspended = rowData.is_active === false;
  const getRoleLabel = (role: EUserPermissions) => {
    if (isGlobalAdmin) return ppmT("access.global_admin");
    if (role === EUserPermissions.ADMIN) return ppmT("access.workspace_admin");
    if (role === EUserPermissions.MEMBER) return ppmT("access.member");
    return ppmT("access.guest");
  };

  return (
    <>
      {isSuspended ? (
        <div className="flex w-32">
          <Pill variant={EPillVariant.DEFAULT} size={EPillSize.SM} className="border-none">
            {ppmT("members.suspended")}
          </Pill>
        </div>
      ) : isRoleNonEditable ? (
        <div className="flex w-32">
          <span>{getRoleLabel(rowData.role)}</span>
        </div>
      ) : (
        <Controller
          name="role"
          control={control}
          rules={{ required: ppmT("members.role_required") }}
          render={({ field: { value: currentValue } }) => (
            <CustomSelect
              value={currentValue as EUserPermissions}
              onChange={async (nextValue: EUserPermissions) => {
                if (!workspaceSlug) return;
                try {
                  await updateMember(workspaceSlug.toString(), rowData.member.id, {
                    role: nextValue as unknown as EUserPermissions,
                  });
                } catch (err: unknown) {
                  const error = err as { error?: string | string[] };
                  const errorString = Array.isArray(error?.error) ? error.error[0] : error?.error;

                  setToast({
                    type: TOAST_TYPE.ERROR,
                    title: ppmT("members.role_update_error_title"),
                    message: memberErrorMessage(errorString, errorString ?? ppmT("members.role_update_error_message")),
                  });
                }
              }}
              label={
                <div className="flex">
                  <span>{getRoleLabel(rowData.role)}</span>
                </div>
              }
              buttonClassName={`!px-0 !justify-start hover:bg-surface-1 ${errors.role ? "border-danger-strong" : "border-none"}`}
              className="w-32 rounded-md p-0"
              input
            >
              {[EUserPermissions.GUEST, EUserPermissions.MEMBER].map((item) => (
                <CustomSelect.Option key={item} value={item as unknown as EUserPermissions}>
                  {getRoleLabel(item)}
                </CustomSelect.Option>
              ))}
            </CustomSelect>
          )}
        />
      )}
    </>
  );
});
