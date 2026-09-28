/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { AlertTriangle } from "lucide-react";
// ui
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// components
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
// hooks
import { useUser } from "@/hooks/store/user";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

export type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  userDetails: {
    id: string;
    display_name: string;
  };
};

export const ConfirmWorkspaceMemberRemove = observer(function ConfirmWorkspaceMemberRemove(props: Props) {
  const isPpmRu = usePpmRu();
  const { isOpen, onClose, onSubmit, userDetails } = props;
  // states
  const [isRemoving, setIsRemoving] = useState(false);
  // store hooks
  const { data: currentUser } = useUser();
  const { t } = useTranslation();
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();

  const handleClose = () => {
    onClose();
    setIsRemoving(false);
  };

  const handleDeletion = async () => {
    setIsRemoving(true);

    await onSubmit();

    handleClose();
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      <div className="px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
        <div className="sm:flex sm:items-start">
          <div className="mx-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-danger-subtle sm:mx-0 sm:h-10 sm:w-10">
            <AlertTriangle className="h-6 w-6 text-danger-primary" aria-hidden="true" />
          </div>
          <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
            <h3 className="text-h5-medium leading-6 text-primary">
              {currentUser?.id === userDetails.id
                ? ppmText("ui.confirm.leave_workspace_title", "Leave workspace?")
                : ppmText("ui.confirm.remove_member_title", `Remove ${userDetails?.display_name}?`, {
                    name: userDetails?.display_name ?? "",
                  })}
            </h3>
            <div className="mt-2">
              {currentUser?.id === userDetails.id ? (
                <p className="text-body-xs-regular text-secondary">
                  {t("workspace_settings.settings.members.leave_confirmation")}
                </p>
              ) : isPpmRu ? (
                <p className="text-body-xs-regular text-secondary">
                  <PpmTemplateText
                    template={ppmT("ui.confirm.remove_workspace_member_content")}
                    values={{ name: <span className="font-bold">{userDetails?.display_name}</span> }}
                  />
                </p>
              ) : (
                <p className="text-body-xs-regular text-secondary">
                  Are you sure you want to remove member- <span className="font-bold">{userDetails?.display_name}</span>
                  ? They will no longer have access to this workspace. This action cannot be undone.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 p-4 sm:px-6">
        <Button variant="secondary" size="lg" onClick={handleClose}>
          {isPpmRu ? ppmT("ui.common.cancel") : t("cancel")}
        </Button>
        <Button variant="error-fill" size="lg" tabIndex={1} onClick={handleDeletion} loading={isRemoving}>
          {currentUser?.id === userDetails.id
            ? isRemoving
              ? t("leaving")
              : t("leave")
            : isRemoving
              ? t("removing")
              : isPpmRu
                ? ppmT("ui.confirm.remove_member_action")
                : t("remove")}
        </Button>
      </div>
    </ModalCore>
  );
});
