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
import { useProject } from "@/hooks/store/use-project";
import { useAppRouter } from "@/hooks/use-app-router";
import { usePpmText } from "@/hooks/use-ppm-text";

type Props = {
  workspaceSlug: string;

  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  archive: boolean;
};

export function ArchiveRestoreProjectModal(props: Props) {
  const { workspaceSlug, projectId, isOpen, onClose, archive } = props;
  // router
  const router = useAppRouter();
  // states
  const [isLoading, setIsLoading] = useState(false);
  // store hooks
  const { getProjectById, archiveProject, restoreProject } = useProject();
  const ppmText = usePpmText();

  const projectDetails = getProjectById(projectId);
  if (!projectDetails) return null;

  const handleClose = () => {
    setIsLoading(false);
    onClose();
  };

  const handleArchiveProject = async () => {
    setIsLoading(true);
    await archiveProject(workspaceSlug, projectId)
      .then(() => {
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: ppmText("ui.toast.archived", "Archive success"),
          message: ppmText("ui.toast.project_archived", `${projectDetails.name} has been archived successfully`, {
            name: projectDetails.name,
          }),
        });
        onClose();
        router.push(`/${workspaceSlug}/projects/`);
        return;
      })
      .catch(() =>
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: ppmText("ui.toast.project_archive_failed", "Project could not be archived. Please try again."),
        })
      )
      .finally(() => setIsLoading(false));
  };

  const handleRestoreProject = async () => {
    setIsLoading(true);
    await restoreProject(workspaceSlug, projectId)
      .then(() => {
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: ppmText("ui.toast.restored", "Restore success"),
          message: ppmText("ui.toast.project_restored", `You can find ${projectDetails.name} in your projects.`, {
            name: projectDetails.name,
          }),
        });
        onClose();
        router.push(`/${workspaceSlug}/projects/`);
        return;
      })
      .catch(() =>
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: ppmText("ui.toast.project_restore_failed", "Project could not be restored. Please try again."),
        })
      )
      .finally(() => setIsLoading(false));
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.CENTER} width={EModalWidth.LG}>
      <div className="px-5 py-4">
        <h3 className="text-18 font-medium 2xl:text-20">
          {archive
            ? ppmText("ui.confirm.archive_project_title", `Archive ${projectDetails.name}`, {
                name: projectDetails.name,
              })
            : ppmText("ui.confirm.restore_project_title", `Restore ${projectDetails.name}`, {
                name: projectDetails.name,
              })}
        </h3>
        <p className="mt-3 text-13 text-secondary">
          {archive
            ? ppmText(
                "ui.confirm.archive_project_content",
                "This project and its work items, cycles, modules, and pages will be archived. Its work items won't appear in search. Only project admins can restore the project."
              )
            : ppmText(
                "ui.confirm.restore_project_content",
                "Restoring a project will activate it and make it visible to all members of the project. Are you sure you want to continue?"
              )}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose}>
            {ppmText("ui.common.cancel", "Cancel")}
          </Button>
          <Button
            variant="primary"
            size="lg"
            tabIndex={1}
            onClick={archive ? handleArchiveProject : handleRestoreProject}
            loading={isLoading}
          >
            {archive
              ? isLoading
                ? ppmText("ui.common.archiving", "Archiving")
                : ppmText("ui.common.archive", "Archive")
              : isLoading
                ? ppmText("ui.common.restoring", "Restoring")
                : ppmText("ui.common.restore", "Restore")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
