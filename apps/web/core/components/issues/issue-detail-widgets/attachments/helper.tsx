/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { setPromiseToast, TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// types
import type { TAttachmentUploadStatus } from "@/store/issue/issue-details/attachment.store";
import { usePpmText } from "@/hooks/use-ppm-text";

export type TAttachmentOperations = {
  create: (file: File) => Promise<void>;
  remove: (attachmentId: string) => Promise<void>;
};

export type TAttachmentSnapshot = {
  uploadStatus: TAttachmentUploadStatus[] | undefined;
};

export type TAttachmentHelpers = {
  operations: TAttachmentOperations;
  snapshot: TAttachmentSnapshot;
};

export const useAttachmentOperations = (
  workspaceSlug: string,
  projectId: string,
  issueId: string,
  issueServiceType: TIssueServiceType = EIssueServiceType.ISSUES
): TAttachmentHelpers => {
  const {
    attachment: { createAttachment, removeAttachment, getAttachmentsUploadStatusByIssueId },
  } = useIssueDetail(issueServiceType);

  const ppmText = usePpmText();
  const attachmentOperations: TAttachmentOperations = useMemo(
    () => ({
      create: async (file) => {
        if (!workspaceSlug || !projectId || !issueId) throw new Error("Missing required fields");
        const attachmentUploadPromise = createAttachment(workspaceSlug, projectId, issueId, file);
        setPromiseToast(attachmentUploadPromise, {
          loading: ppmText("ui.toast.attachment_uploading", "Uploading attachment..."),
          success: {
            title: ppmText("ui.toast.attachment_uploaded", "Attachment uploaded"),
            message: () =>
              ppmText("ui.toast.attachment_uploaded_message", "The attachment has been successfully uploaded"),
          },
          error: {
            title: ppmText("ui.toast.attachment_upload_failed", "Attachment not uploaded"),
            message: () => ppmText("ui.toast.attachment_upload_failed_message", "The attachment could not be uploaded"),
          },
        });

        await attachmentUploadPromise;
      },
      remove: async (attachmentId) => {
        try {
          if (!workspaceSlug || !projectId || !issueId) throw new Error("Missing required fields");
          await removeAttachment(workspaceSlug, projectId, issueId, attachmentId);
          setToast({
            message: ppmText("ui.toast.attachment_removed_message", "The attachment has been successfully removed"),
            type: TOAST_TYPE.SUCCESS,
            title: ppmText("ui.toast.attachment_removed", "Attachment removed"),
          });
        } catch (_error) {
          setToast({
            message: ppmText("ui.toast.attachment_remove_failed_message", "The Attachment could not be removed"),
            type: TOAST_TYPE.ERROR,
            title: ppmText("ui.toast.attachment_remove_failed", "Attachment not removed"),
          });
        }
      },
    }),
    [workspaceSlug, projectId, issueId, createAttachment, removeAttachment, ppmText]
  );
  const attachmentsUploadStatus = getAttachmentsUploadStatusByIssueId(issueId);

  return {
    operations: attachmentOperations,
    snapshot: { uploadStatus: attachmentsUploadStatus },
  };
};
