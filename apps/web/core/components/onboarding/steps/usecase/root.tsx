/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Controller, useForm } from "react-hook-form";
// plane imports
import { USE_CASES } from "@plane/constants";
import { Button } from "@plane/propel/button";
import { CheckIcon } from "@plane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TUserProfile } from "@plane/types";
import { EOnboardingSteps } from "@plane/types";
import { cn } from "@plane/utils";
import { isPpmShellEnabled } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
// hooks
import { useUserProfile } from "@/hooks/store/user";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
// local imports
import { CommonOnboardingHeader } from "../common";
import type { TProfileSetupFormValues } from "../profile/root";

type Props = {
  handleStepChange: (step: EOnboardingSteps, skipInvites?: boolean) => void;
};

const defaultValues = {
  use_case: [] as string[],
};

const PPM_USE_CASE_LABELS: Record<string, TPpmTranslationKey> = {
  "Plan and track product roadmaps": "onboarding.usecase.roadmaps",
  "Manage engineering sprints": "onboarding.usecase.sprints",
  "Coordinate cross-functional projects": "onboarding.usecase.cross_functional",
  "Replace our current tool": "onboarding.usecase.replace_tool",
  "Just exploring": "onboarding.usecase.exploring",
};

export const UseCaseSetupStep = observer(function UseCaseSetupStep({ handleStepChange }: Props) {
  const ppmT = usePpmTranslation();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  // store hooks
  const { data: profile, updateUserProfile } = useUserProfile();
  // form info
  const {
    handleSubmit,
    control,
    formState: { errors, isSubmitting, isValid },
  } = useForm<TProfileSetupFormValues>({
    defaultValues: {
      ...defaultValues,
      use_case: profile?.use_case ? profile.use_case.split(". ") : [],
    },
    mode: "onChange",
  });

  // handle submit
  const handleSubmitUserPersonalization = async (formData: TProfileSetupFormValues) => {
    const profileUpdatePayload: Partial<TUserProfile> = {
      use_case: formData.use_case && formData.use_case.length > 0 ? formData.use_case.join(". ") : undefined,
    };
    try {
      await updateUserProfile(profileUpdatePayload);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: isPpmShell ? ppmT("onboarding.success") : "Success",
        message: isPpmShell ? ppmT("onboarding.profile_saved") : "Profile setup completed!",
      });
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: isPpmShell ? ppmT("onboarding.error") : "Error",
        message: isPpmShell ? ppmT("onboarding.profile_failed") : "Profile setup failed. Please try again!",
      });
    }
  };

  // on submit
  const onSubmit = async (formData: TProfileSetupFormValues) => {
    if (!profile) return;
    await handleSubmitUserPersonalization(formData);
    handleStepChange(EOnboardingSteps.USE_CASE_SETUP);
  };

  // handle skip
  const handleSkip = () => {
    handleStepChange(EOnboardingSteps.USE_CASE_SETUP);
  };

  // derived values
  const isButtonDisabled = isSubmitting || !isValid;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-10">
      {/* Header */}
      <CommonOnboardingHeader
        title={isPpmShell ? ppmT("onboarding.usecase_title") : "What brings you to Plane?"}
        description={isPpmShell ? ppmT("onboarding.usecase_description") : "Tell us your goals and team size."}
      />

      {/* Use Case Selection */}
      <div className="flex flex-col gap-3">
        <p className="text-body-sm-semibold text-placeholder">
          {isPpmShell ? ppmT("onboarding.select_many") : "Select one or more"}
        </p>

        <Controller
          control={control}
          name="use_case"
          rules={{
            required: isPpmShell ? ppmT("onboarding.selection_required") : "Please select at least one option",
            validate: (value) =>
              (value && value.length > 0) ||
              (isPpmShell ? ppmT("onboarding.selection_required") : "Please select at least one option"),
          }}
          render={({ field: { value, onChange } }) => (
            <div className="flex flex-col gap-3">
              {USE_CASES.map((useCase) => {
                const isSelected = value?.includes(useCase) || false;
                return (
                  <button
                    key={useCase}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const currentValue = value || [];
                      if (isSelected) {
                        // Remove from array
                        onChange(currentValue.filter((item) => item !== useCase));
                      } else {
                        // Add to array
                        onChange([...currentValue, useCase]);
                      }
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 transition-all duration-200 ${
                      isSelected
                        ? "border-accent-strong bg-accent-subtle text-accent-primary"
                        : "border-subtle text-tertiary hover:border-strong"
                    }`}
                  >
                    <span
                      className={cn(`flex size-4 items-center justify-center rounded-sm border-2`, {
                        "border-accent-strong bg-accent-primary": isSelected,
                        "border-strong": !isSelected,
                      })}
                    >
                      <CheckIcon
                        className={cn("h-3 w-3 text-on-color", {
                          "opacity-100": isSelected,
                          "opacity-0": !isSelected,
                        })}
                      />
                    </span>

                    <span className="text-body-sm-regular">
                      {isPpmShell ? ppmT(PPM_USE_CASE_LABELS[useCase]) : useCase}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        />
        {errors.use_case && <span className="text-13 text-danger-primary">{errors.use_case.message}</span>}
      </div>

      {/* Action Buttons */}
      <div className="space-y-3">
        <Button variant="primary" type="submit" className="w-full" size="xl" disabled={isButtonDisabled}>
          {isPpmShell ? ppmT("onboarding.continue") : "Continue"}
        </Button>
        <Button variant="ghost" onClick={handleSkip} className="w-full" size="xl">
          {isPpmShell ? ppmT("onboarding.skip") : "Skip"}
        </Button>
      </div>
    </form>
  );
});
