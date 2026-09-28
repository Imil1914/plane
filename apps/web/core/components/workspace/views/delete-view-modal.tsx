/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// Plane Imports
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IWorkspaceView } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
// hooks
import { useGlobalView } from "@/hooks/store/use-global-view";
import { usePpmText } from "@/hooks/use-ppm-text";

type Props = {
  data: IWorkspaceView;
  isOpen: boolean;
  onClose: () => void;
};

export const DeleteGlobalViewModal = observer(function DeleteGlobalViewModal(props: Props) {
  const { data, isOpen, onClose } = props;
  // states
  const [isDeleteLoading, setIsDeleteLoading] = useState(false);
  // router
  const { workspaceSlug } = useParams();
  // store hooks
  const { deleteGlobalView } = useGlobalView();
  const { t } = useTranslation();
  const ppmText = usePpmText();
  const handleClose = () => onClose();

  const handleDeletion = async () => {
    if (!workspaceSlug) return;
    setIsDeleteLoading(true);

    try {
      await deleteGlobalView(workspaceSlug.toString(), data.id);
    } catch (_error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: ppmText("ui.toast.error", "Error!"),
        message: ppmText("ui.toast.workspace_view_delete_failed", "Failed to delete the view. Please try again."),
      });
    }

    setIsDeleteLoading(false);
    handleClose();
    // remove filters from local storage
    localStorage.removeItem(`global_view_filters/${data.id}`);
  };

  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={handleDeletion}
      isSubmitting={isDeleteLoading}
      isOpen={isOpen}
      title={t("workspace_views.delete_view.title")}
      content={<>{t("workspace_views.delete_view.content")}</>}
      primaryButtonText={{
        loading: ppmText("ui.common.deleting", "Deleting"),
        default: ppmText("ui.common.delete", "Delete"),
      }}
      secondaryButtonText={ppmText("ui.common.cancel", "Cancel")}
    />
  );
});
