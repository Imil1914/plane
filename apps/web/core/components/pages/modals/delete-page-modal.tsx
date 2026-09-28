/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// ui
import { useParams } from "next/navigation";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { AlertModalCore } from "@plane/ui";
import { getPageName } from "@plane/utils";
// constants
// plane web hooks
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
import { useAppRouter } from "@/hooks/use-app-router";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import type { EPageStoreType } from "@/hooks/store";
import { usePageStore } from "@/hooks/store";
// store
import type { TPageInstance } from "@/store/pages/base-page";

type TConfirmPageDeletionProps = {
  isOpen: boolean;
  onClose: () => void;
  page: TPageInstance;
  storeType: EPageStoreType;
};

export const DeletePageModal = observer(function DeletePageModal(props: TConfirmPageDeletionProps) {
  const isPpmRu = usePpmRu();
  const { isOpen, onClose, page, storeType } = props;
  // states
  const [isDeleting, setIsDeleting] = useState(false);
  // store hooks
  const { removePage } = usePageStore(storeType);
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();

  // derived values
  const { id: pageId, name } = page;

  const handleClose = () => {
    setIsDeleting(false);
    onClose();
  };

  const router = useAppRouter();
  const { pageId: routePageId } = useParams();

  const handleDelete = async () => {
    if (!pageId) return;
    setIsDeleting(true);
    await removePage({ pageId })
      .then(() => {
        handleClose();
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: ppmText("ui.toast.success", "Success!"),
          message: ppmText("ui.toast.page_deleted", "Page deleted successfully."),
        });

        if (routePageId) {
          router.back();
        }
      })
      .catch(() => {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: ppmText("ui.toast.page_delete_failed", "Page could not be deleted. Please try again."),
        });
      });

    setIsDeleting(false);
  };

  if (!page || !page.id) return null;

  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={handleDelete}
      isSubmitting={isDeleting}
      isOpen={isOpen}
      title={ppmText("ui.confirm.delete_page_title", "Delete page")}
      content={
        isPpmRu ? (
          <PpmTemplateText
            template={ppmT("ui.confirm.delete_page_content")}
            values={{
              name: <span className="font-medium break-words break-all text-primary">{getPageName(name)}</span>,
            }}
          />
        ) : (
          <>
            Are you sure you want to delete page-{" "}
            <span className="font-medium break-words break-all text-primary">{getPageName(name)}</span> ? The Page will
            be deleted permanently. This action cannot be undone.
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
