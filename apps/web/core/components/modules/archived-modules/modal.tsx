/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
// ui
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// hooks
import { useModule } from "@/hooks/store/use-module";
import { useAppRouter } from "@/hooks/use-app-router";
import { usePpmText } from "@/hooks/use-ppm-text";

type Props = {
  workspaceSlug: string;
  projectId: string;
  moduleId: string;
  handleClose: () => void;
  isOpen: boolean;
  onSubmit?: () => Promise<void>;
};

export function ArchiveModuleModal(props: Props) {
  const { workspaceSlug, projectId, moduleId, isOpen, handleClose } = props;
  // router
  const router = useAppRouter();
  // states
  const [isArchiving, setIsArchiving] = useState(false);
  // store hooks
  const { getModuleNameById, archiveModule } = useModule();
  const ppmText = usePpmText();

  const moduleName = getModuleNameById(moduleId);

  const onClose = () => {
    setIsArchiving(false);
    handleClose();
  };

  const handleArchiveModule = async () => {
    setIsArchiving(true);
    await archiveModule(workspaceSlug, projectId, moduleId)
      .then(() => {
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: ppmText("ui.toast.archived", "Archive success"),
          message: ppmText("ui.toast.archived_hint", "Your archives can be found in project archives."),
        });
        onClose();
        router.push(`/${workspaceSlug}/projects/${projectId}/modules`);
        return;
      })
      .catch(() =>
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: ppmText("ui.toast.module_archive_failed", "Module could not be archived. Please try again."),
        })
      )
      .finally(() => setIsArchiving(false));
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.LG}>
      <div className="px-5 py-4">
        <h3 className="text-18 font-medium 2xl:text-20">
          {ppmText("ui.confirm.archive_module_title", `Archive module ${moduleName}`, { name: moduleName ?? "" })}
        </h3>
        <p className="mt-3 text-13 text-secondary">
          {ppmText(
            "ui.confirm.archive_module_content",
            "Are you sure you want to archive the module? All your archives can be restored later."
          )}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose}>
            {ppmText("ui.common.cancel", "Cancel")}
          </Button>
          <Button variant="primary" size="lg" tabIndex={1} onClick={handleArchiveModule} loading={isArchiving}>
            {isArchiving ? ppmText("ui.common.archiving", "Archiving") : ppmText("ui.common.archive", "Archive")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
