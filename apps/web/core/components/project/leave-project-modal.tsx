/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { AlertTriangleIcon } from "lucide-react";
// Plane imports
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IProject } from "@plane/types";
import { Input, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
// hooks
import { useUserPermissions } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
import { usePpmRu, usePpmText } from "@/hooks/use-ppm-text";
import { PpmTemplateText } from "@/components/ppm-shell/template-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type FormData = {
  projectName: string;
  confirmLeave: string;
};

const defaultValues: FormData = {
  projectName: "",
  confirmLeave: "",
};

export interface ILeaveProjectModal {
  project: IProject;
  isOpen: boolean;
  onClose: () => void;
}

export const LeaveProjectModal = observer(function LeaveProjectModal(props: ILeaveProjectModal) {
  const isPpmRu = usePpmRu();
  const { project, isOpen, onClose } = props;
  // router
  const router = useAppRouter();
  const { workspaceSlug } = useParams();
  // store hooks
  const { leaveProject } = useUserPermissions();
  const ppmText = usePpmText();
  const ppmT = usePpmTranslation();
  // The typed confirmation follows the interface language («покинуть проект» in the Russian PPM UI).
  const leavePhrase = ppmText("ui.confirm.leave_project_phrase", "Leave Project");

  const {
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    reset,
  } = useForm({ defaultValues });

  const handleClose = () => {
    reset({ ...defaultValues });
    onClose();
  };

  const onSubmit = async (data: any) => {
    if (!workspaceSlug) return;

    if (data) {
      if (data.projectName === project?.name) {
        if (data.confirmLeave === leavePhrase) {
          router.push(`/${workspaceSlug}/projects`);
          return leaveProject(workspaceSlug.toString(), project.id)
            .then(() => {
              handleClose();
            })
            .catch((_err) => {
              setToast({
                type: TOAST_TYPE.ERROR,
                title: ppmText("ui.toast.error", "Error!"),
                message: ppmText("ui.toast.try_again_later", "Something went wrong please try again later."),
              });
            });
        } else {
          setToast({
            type: TOAST_TYPE.ERROR,
            title: ppmText("ui.toast.error", "Error!"),
            message: ppmText(
              "ui.confirm.leave_project_phrase_mismatch",
              "Please confirm leaving the project by typing the 'Leave Project'."
            ),
          });
        }
      } else {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: ppmText("ui.toast.error", "Error!"),
          message: ppmText(
            "ui.confirm.leave_project_name_mismatch",
            "Please enter the project name as shown in the description."
          ),
        });
      }
    } else {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: ppmText("ui.toast.error", "Error!"),
        message: ppmText("ui.confirm.fill_all_fields", "Please fill all fields."),
      });
    }
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6 p-6">
        <div className="flex w-full items-center justify-start gap-6">
          <span className="place-items-center rounded-full bg-danger-subtle p-4">
            <AlertTriangleIcon className="h-6 w-6 text-danger-primary" aria-hidden="true" />
          </span>
          <span className="flex items-center justify-start">
            <h3 className="text-18 font-medium 2xl:text-20">
              {ppmText("ui.confirm.leave_project_heading", "Leave Project")}
            </h3>
          </span>
        </div>

        <span>
          <p className="text-13 leading-7 text-secondary">
            {isPpmRu ? (
              <PpmTemplateText
                template={ppmT("ui.confirm.leave_project_typed_content")}
                values={{ name: <span className="font-medium text-primary">{project?.name}</span> }}
              />
            ) : (
              <>
                Are you sure you want to leave the project -
                <span className="font-medium text-primary">{` "${project?.name}" `}</span>? All of the work items
                associated with you will become inaccessible.
              </>
            )}
          </p>
        </span>

        <div className="text-secondary">
          <p className="text-13 break-words">
            {isPpmRu ? (
              <PpmTemplateText
                template={ppmT("ui.confirm.delete_project_name_prompt")}
                values={{ name: <span className="font-medium text-primary">{project?.name}</span> }}
              />
            ) : (
              <>
                Enter the project name <span className="font-medium text-primary">{project?.name}</span> to continue:
              </>
            )}
          </p>
          <Controller
            control={control}
            name="projectName"
            rules={{
              required: "Label title is required",
            }}
            render={({ field: { value, onChange, ref } }) => (
              <Input
                id="projectName"
                name="projectName"
                type="text"
                value={value}
                onChange={onChange}
                ref={ref}
                hasError={Boolean(errors.projectName)}
                placeholder={ppmText("ui.confirm.leave_project_name_placeholder", "Enter project name")}
                className="mt-2 w-full"
              />
            )}
          />
        </div>

        <div className="text-secondary">
          <p className="text-13">
            {isPpmRu ? (
              <PpmTemplateText
                template={ppmT("ui.confirm.delete_project_phrase_prompt")}
                values={{ phrase: <span className="font-medium text-primary">{leavePhrase}</span> }}
              />
            ) : (
              <>
                To confirm, type <span className="font-medium text-primary">Leave Project</span> below:
              </>
            )}
          </p>
          <Controller
            control={control}
            name="confirmLeave"
            render={({ field: { value, onChange, ref } }) => (
              <Input
                id="confirmLeave"
                name="confirmLeave"
                type="text"
                value={value}
                onChange={onChange}
                ref={ref}
                hasError={Boolean(errors.confirmLeave)}
                placeholder={ppmText("ui.confirm.leave_project_phrase_placeholder", "Enter 'leave project'")}
                className="mt-2 w-full"
              />
            )}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={handleClose}>
            {ppmText("ui.common.cancel", "Cancel")}
          </Button>
          <Button variant="error-fill" size="lg" type="submit" loading={isSubmitting}>
            {isSubmitting
              ? ppmText("ui.common.leaving", "Leaving...")
              : ppmText("ui.confirm.leave_project_heading", "Leave Project")}
          </Button>
        </div>
      </form>
    </ModalCore>
  );
});
