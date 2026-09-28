/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// plane-i18n
import { useTranslation } from "@plane/i18n";
// types
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// ui
import { AlertModalCore } from "@plane/ui";
// helper
import { getFileName } from "@plane/utils";
// components
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
// types
import type { TAttachmentOperations } from "../issue-detail-widgets/attachments/helper";

export type TAttachmentOperationsRemoveModal = Pick<TAttachmentOperations, "remove">;

type Props = {
  isOpen: boolean;
  onClose: () => void;
  attachmentId: string;
  attachmentOperations: TAttachmentOperationsRemoveModal;
  issueServiceType?: TIssueServiceType;
};

export const IssueAttachmentDeleteModal = observer(function IssueAttachmentDeleteModal(props: Props) {
  const isPpmRu = usePpmRu();
  const { t } = useTranslation();
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();
  const { isOpen, onClose, attachmentId, attachmentOperations, issueServiceType = EIssueServiceType.ISSUES } = props;
  // states
  const [loader, setLoader] = useState(false);

  // store hooks
  const {
    attachment: { getAttachmentById },
  } = useIssueDetail(issueServiceType);

  // derived values
  const attachment = attachmentId ? getAttachmentById(attachmentId) : undefined;

  // handlers
  const handleClose = () => {
    onClose();
    setLoader(false);
  };

  const handleDeletion = async (assetId: string) => {
    setLoader(true);
    attachmentOperations.remove(assetId).finally(() => handleClose());
  };

  if (!attachment) return <></>;
  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={() => handleDeletion(attachment.id)}
      isSubmitting={loader}
      isOpen={isOpen}
      title={isPpmRu ? ppmT("ui.confirm.delete_attachment_title") : t("attachment.delete")}
      content={
        isPpmRu ? (
          <PpmTemplateText
            template={ppmT("ui.confirm.delete_attachment_content")}
            values={{ name: <span className="font-bold">{getFileName(attachment.attributes.name)}</span> }}
          />
        ) : (
          <>
            Are you sure you want to delete attachment-{" "}
            <span className="font-bold">{getFileName(attachment.attributes.name)}</span>? This attachment will be
            permanently removed. This action cannot be undone.
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
