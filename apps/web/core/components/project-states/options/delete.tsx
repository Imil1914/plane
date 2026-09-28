/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { Loader } from "lucide-react";
import { CloseIcon } from "@plane/propel/icons";
// plane imports
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Tooltip } from "@plane/propel/tooltip";
import type { IState, TStateOperationsCallbacks } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { cn } from "@plane/utils";
// hooks
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
import { usePlatformOS } from "@/hooks/use-platform-os";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type TStateDelete = {
  totalStates: number;
  state: IState;
  deleteStateCallback: TStateOperationsCallbacks["deleteState"];
  shouldTrackEvents?: boolean;
};

export const StateDelete = observer(function StateDelete(props: TStateDelete) {
  const isPpmRu = usePpmRu();
  const { totalStates, state, deleteStateCallback } = props;
  // hooks
  const { isMobile } = usePlatformOS();
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();
  // states
  const [isDeleteModal, setIsDeleteModal] = useState(false);
  const [isDelete, setIsDelete] = useState(false);
  // derived values
  const isDeleteDisabled = state.default ? true : totalStates === 1 ? true : false;

  const handleDeleteState = async () => {
    if (isDeleteDisabled) return;

    setIsDelete(true);

    try {
      await deleteStateCallback(state.id);
      setIsDelete(false);
    } catch (error) {
      const errorStatus = error as { status: number; data: { error: string } };
      if (errorStatus.status === 400) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: ppmText(
            "ui.toast.state_has_work_items",
            "This state contains some work items within it, please move them to some other state to delete this state."
          ),
        });
      } else {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: ppmText("ui.toast.state_delete_failed", "State could not be deleted. Please try again."),
        });
      }
      setIsDelete(false);
    }
  };

  return (
    <>
      <AlertModalCore
        handleClose={() => setIsDeleteModal(false)}
        handleSubmit={handleDeleteState}
        isSubmitting={isDelete}
        isOpen={isDeleteModal}
        title={ppmText("ui.confirm.delete_state_title", "Delete State")}
        content={
          isPpmRu ? (
            <PpmTemplateText
              template={ppmT("ui.confirm.delete_state_content")}
              values={{ name: <span className="font-medium text-primary">{state?.name}</span> }}
            />
          ) : (
            <>
              Are you sure you want to delete state- <span className="font-medium text-primary">{state?.name}</span>?
              All of the data related to the state will be permanently removed. This action cannot be undone.
            </>
          )
        }
        primaryButtonText={{
          loading: ppmText("ui.common.deleting", "Deleting"),
          default: ppmText("ui.common.delete", "Delete"),
        }}
        secondaryButtonText={ppmText("ui.common.cancel", "Cancel")}
      />

      <button
        type="button"
        className={cn(
          "flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-sm transition-colors focus:outline-none",
          isDeleteDisabled ? "bg-surface-2 text-secondary" : "text-danger-primary hover:bg-layer-1"
        )}
        disabled={isDeleteDisabled}
        onClick={() => setIsDeleteModal(true)}
      >
        <Tooltip
          tooltipContent={
            state.default
              ? ppmText("ui.state.cannot_delete_default", "Cannot delete the default state.")
              : totalStates === 1
                ? ppmText("ui.state.cannot_empty_group", "Cannot have an empty group.")
                : ``
          }
          isMobile={isMobile}
          disabled={!isDeleteDisabled}
          className="focus:outline-none"
        >
          {isDelete ? <Loader className="h-3.5 w-3.5 text-secondary" /> : <CloseIcon className="h-3.5 w-3.5" />}
        </Tooltip>
      </button>
    </>
  );
});
