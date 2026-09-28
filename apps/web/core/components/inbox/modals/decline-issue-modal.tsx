/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
// types
import { useTranslation } from "@plane/i18n";
import type { TIssue } from "@plane/types";
// ui
import { AlertModalCore } from "@plane/ui";
// components
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
// hooks
import { useProject } from "@/hooks/store/use-project";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type Props = {
  data: Partial<TIssue>;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
};

export function DeclineIssueModal(props: Props) {
  const isPpmRu = usePpmRu();
  const { isOpen, onClose, data, onSubmit } = props;
  // states
  const [isDeclining, setIsDeclining] = useState(false);
  // store hooks
  const { getProjectById } = useProject();
  const { t } = useTranslation();
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();
  // derived values
  const projectDetails = data.project_id ? getProjectById(data?.project_id) : undefined;

  const handleClose = () => {
    setIsDeclining(false);
    onClose();
  };

  const handleDecline = async () => {
    setIsDeclining(true);
    await onSubmit().finally(() => setIsDeclining(false));
  };

  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={handleDecline}
      isSubmitting={isDeclining}
      isOpen={isOpen}
      title={t("inbox_issue.modals.decline.title")}
      content={
        isPpmRu ? (
          <PpmTemplateText
            template={ppmT("ui.confirm.decline_request_content")}
            values={{
              id: (
                <span className="font-medium break-words text-primary">
                  {projectDetails?.identifier}-{data?.sequence_id}
                </span>
              ),
            }}
          />
        ) : (
          <>
            Are you sure you want to decline work item{" "}
            <span className="font-medium break-words text-primary">
              {projectDetails?.identifier}-{data?.sequence_id}
            </span>
            {""}? This action cannot be undone.
          </>
        )
      }
      secondaryButtonText={ppmText("ui.common.cancel", "Cancel")}
      primaryButtonText={{
        loading: t("declining"),
        default: t("decline"),
      }}
    />
  );
}
