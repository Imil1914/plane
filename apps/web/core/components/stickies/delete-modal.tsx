/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// ui
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { AlertModalCore } from "@plane/ui";
// hooks
import { usePpmText } from "@/hooks/use-ppm-text";

interface IStickyDelete {
  isOpen: boolean;
  handleSubmit: () => Promise<void>;
  handleClose: () => void;
}

export const StickyDeleteModal = observer(function StickyDeleteModal(props: IStickyDelete) {
  const { isOpen, handleClose, handleSubmit } = props;
  // states
  const [loader, setLoader] = useState(false);
  // hooks
  const { t } = useTranslation();
  const ppmText = usePpmText();

  const formSubmit = async () => {
    try {
      setLoader(true);
      await handleSubmit();
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("stickies.toasts.not_removed.title"),
        message: t("stickies.toasts.not_removed.message"),
      });
    } finally {
      setLoader(false);
    }
  };

  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={formSubmit}
      isSubmitting={loader}
      isOpen={isOpen}
      title={t("stickies.delete")}
      content={t("stickies.delete_confirmation")}
      primaryButtonText={{
        loading: ppmText("ui.common.deleting", "Deleting"),
        default: ppmText("ui.common.delete", "Delete"),
      }}
      secondaryButtonText={ppmText("ui.common.cancel", "Cancel")}
    />
  );
});
