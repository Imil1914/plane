/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
// ui
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { AlertModalCore } from "@plane/ui";
// hooks
import { useWebhook } from "@/hooks/store/use-webhook";
import { useAppRouter } from "@/hooks/use-app-router";
import { usePpmText } from "@/hooks/use-ppm-text";

interface IDeleteWebhook {
  isOpen: boolean;
  onClose: () => void;
}

export function DeleteWebhookModal(props: IDeleteWebhook) {
  const { isOpen, onClose } = props;
  // states
  const [isDeleting, setIsDeleting] = useState(false);
  // router
  const router = useAppRouter();
  // store hooks
  const { removeWebhook } = useWebhook();
  const ppmText = usePpmText();

  const { workspaceSlug, webhookId } = useParams();

  const handleClose = () => {
    onClose();
  };

  const handleDelete = async () => {
    if (!workspaceSlug || !webhookId) return;
    setIsDeleting(true);
    try {
      await removeWebhook(workspaceSlug.toString(), webhookId.toString());
      router.replace(`/${workspaceSlug}/settings/webhooks/`);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: ppmText("ui.toast.success", "Success!"),
        message: ppmText("ui.toast.webhook_deleted", "Webhook deleted successfully."),
      });
    } catch (_error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: ppmText("ui.toast.error", "Error!"),
        message: ppmText("ui.toast.webhook_delete_failed", "Webhook could not be deleted. Please try again."),
      });
    }
    setIsDeleting(false);
  };

  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={handleDelete}
      isSubmitting={isDeleting}
      isOpen={isOpen}
      title={ppmText("ui.confirm.delete_webhook_title", "Delete webhook")}
      content={ppmText(
        "ui.confirm.delete_webhook_content",
        "Are you sure you want to delete this webhook? Future events will not be delivered to this webhook. This action cannot be undone."
      )}
      primaryButtonText={{
        loading: ppmText("ui.common.deleting", "Deleting"),
        default: ppmText("ui.common.delete", "Delete"),
      }}
      secondaryButtonText={ppmText("ui.common.cancel", "Cancel")}
    />
  );
}
