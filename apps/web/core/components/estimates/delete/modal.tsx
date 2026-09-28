/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// ui
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// hooks
import { useProjectEstimates } from "@/hooks/store/estimates";
import { useEstimate } from "@/hooks/store/estimates/use-estimate";
import { useProject } from "@/hooks/store/use-project";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type TDeleteEstimateModal = {
  workspaceSlug: string;
  projectId: string;
  estimateId: string | undefined;
  isOpen: boolean;
  handleClose: () => void;
};

export const DeleteEstimateModal = observer(function DeleteEstimateModal(props: TDeleteEstimateModal) {
  const isPpmRu = usePpmRu();
  // props
  const { workspaceSlug, projectId, estimateId, isOpen, handleClose } = props;
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();
  // hooks
  const { areEstimateEnabledByProjectId, deleteEstimate } = useProjectEstimates();
  const { asJson: estimate } = useEstimate(estimateId);
  const { updateProject } = useProject();
  // states
  const [buttonLoader, setButtonLoader] = useState(false);

  const handleDeleteEstimate = async () => {
    try {
      if (!workspaceSlug || !projectId || !estimateId) return;
      setButtonLoader(true);
      await deleteEstimate(workspaceSlug, projectId, estimateId);
      if (areEstimateEnabledByProjectId(projectId)) {
        await updateProject(workspaceSlug, projectId, { estimate: null });
      }
      setButtonLoader(false);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: ppmText("ui.estimate.deleted_title", "Estimate deleted"),
        message: ppmText("ui.estimate.deleted", "Estimate has been removed from your project."),
      });
      handleClose();
    } catch (_error) {
      setButtonLoader(false);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: ppmText("ui.estimate.delete_failed_title", "Estimate creation failed"),
        message: ppmText("ui.estimate.delete_failed", "We were unable to delete the estimate, please try again."),
      });
    }
  };

  return (
    <ModalCore isOpen={isOpen} position={EModalPosition.TOP} width={EModalWidth.XXL}>
      <div className="relative space-y-6 py-5">
        {/* heading */}
        <div className="relative flex items-center justify-between gap-2 px-5">
          <div className="text-18 font-medium text-primary">
            {ppmText("ui.estimate.delete_title", "Delete Estimate System")}
          </div>
        </div>

        {/* estimate steps */}
        <div className="px-5">
          <div className="text-14 text-secondary">
            {isPpmRu ? (
              <PpmTemplateText
                template={ppmT("ui.estimate.delete_content")}
                values={{ name: <span className="font-bold text-primary">{estimate?.name}</span> }}
              />
            ) : (
              <>
                Deleting the estimate <span className="font-bold text-primary">{estimate?.name}</span>
                &nbsp;system will remove it from all work items permanently. This action cannot be undone. If you add
                estimates again, you will need to update all the work items.
              </>
            )}
          </div>
        </div>

        <div className="relative flex items-center justify-end gap-3 border-t border-subtle px-5 pt-5">
          <Button variant="secondary" size="lg" onClick={handleClose} disabled={buttonLoader}>
            {ppmText("ui.common.cancel", "Cancel")}
          </Button>
          <Button variant="error-fill" size="lg" onClick={handleDeleteEstimate} disabled={buttonLoader}>
            {buttonLoader
              ? ppmText("ui.common.deleting", "Deleting")
              : ppmText("ui.estimate.delete_action", "Delete Estimate")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
});
