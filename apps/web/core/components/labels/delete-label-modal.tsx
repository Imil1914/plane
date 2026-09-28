/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// types
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IIssueLabel } from "@plane/types";
// ui
import { AlertModalCore } from "@plane/ui";
// hooks
import { useLabel } from "@/hooks/store/use-label";
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  data: IIssueLabel | null;
};

export const DeleteLabelModal = observer(function DeleteLabelModal(props: Props) {
  const isPpmRu = usePpmRu();
  const { isOpen, onClose, data } = props;
  // router
  const { workspaceSlug, projectId } = useParams();
  // store hooks
  const { deleteLabel } = useLabel();
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();
  // states
  const [isDeleteLoading, setIsDeleteLoading] = useState(false);

  const handleClose = () => {
    onClose();
    setIsDeleteLoading(false);
  };

  const handleDeletion = async () => {
    if (!workspaceSlug || !projectId || !data) return;

    setIsDeleteLoading(true);

    await deleteLabel(workspaceSlug.toString(), projectId.toString(), data.id)
      .then(() => {
        handleClose();
      })
      .catch((err) => {
        setIsDeleteLoading(false);
        const error =
          err?.error || ppmText("ui.toast.label_delete_failed", "Label could not be deleted. Please try again.");
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: error,
        });
      });
  };

  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={handleDeletion}
      isSubmitting={isDeleteLoading}
      isOpen={isOpen}
      title={ppmText("ui.confirm.delete_label_title", "Delete Label")}
      content={
        isPpmRu ? (
          <PpmTemplateText
            template={ppmT("ui.confirm.delete_label_content")}
            values={{ name: <span className="font-medium text-primary">{data?.name}</span> }}
          />
        ) : (
          <>
            Are you sure you want to delete <span className="font-medium text-primary">{data?.name}</span>? This will
            remove the label from all the work item and from any views where the label is being filtered upon.
          </>
        )
      }
      primaryButtonText={{
        loading: ppmText("ui.common.deleting", "Deleting"),
        default: ppmText("ui.common.delete", "Delete"),
      }}
      secondaryButtonText={ppmText("ui.common.cancel", "Cancel")}
    />
  );
});
