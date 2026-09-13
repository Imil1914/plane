/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Controller, useForm } from "react-hook-form";
import { Box, PenTool, Rocket, Monitor, RefreshCw } from "lucide-react";
// plane imports
import { Button } from "@plane/propel/button";
import { CheckIcon, ViewsIcon } from "@plane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TUserProfile } from "@plane/types";
import { EOnboardingSteps } from "@plane/types";
import { isPpmShellEnabled } from "@ppm/brand";
// hooks
import { useUserProfile } from "@/hooks/store/user";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
// local components
import { CommonOnboardingHeader } from "../common";
import type { TProfileSetupFormValues } from "../profile/root";

type Props = {
  handleStepChange: (step: EOnboardingSteps, skipInvites?: boolean) => void;
};

const ROLES = [
  { id: "product-manager", label: "Product Manager", labelKey: "onboarding.role.product_manager", icon: Box },
  {
    id: "engineering-manager",
    label: "Engineering Manager",
    labelKey: "onboarding.role.engineering_manager",
    icon: ViewsIcon,
  },
  { id: "designer", label: "Designer", labelKey: "onboarding.role.designer", icon: PenTool },
  { id: "developer", label: "Developer", labelKey: "onboarding.role.developer", icon: Monitor },
  { id: "founder-executive", label: "Founder/Executive", labelKey: "onboarding.role.founder", icon: Rocket },
  {
    id: "operations-manager",
    label: "Operations Manager",
    labelKey: "onboarding.role.operations_manager",
    icon: RefreshCw,
  },
  { id: "others", label: "Others", labelKey: "onboarding.role.other", icon: Box },
] as const;

const defaultValues = {
  role: "",
};

export const RoleSetupStep = observer(function RoleSetupStep({ handleStepChange }: Props) {
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
      role: profile?.role,
    },
    mode: "onChange",
  });

  // handle submit
  const handleSubmitUserPersonalization = async (formData: TProfileSetupFormValues) => {
    const profileUpdatePayload: Partial<TUserProfile> = {
      role: formData.role,
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

  const onSubmit = async (formData: TProfileSetupFormValues) => {
    if (!profile) return;
    await handleSubmitUserPersonalization(formData);
    handleStepChange(EOnboardingSteps.ROLE_SETUP);
  };

  const handleSkip = () => {
    handleStepChange(EOnboardingSteps.ROLE_SETUP);
  };

  const isButtonDisabled = isSubmitting || !isValid;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-10">
      {/* Header */}
      <CommonOnboardingHeader
        title={isPpmShell ? ppmT("onboarding.role_title") : "What's your role?"}
        description={isPpmShell ? ppmT("onboarding.role_description") : "Let's set up Plane for how you work."}
      />
      {/* Role Selection */}
      <div className="flex flex-col gap-3">
        <p className="text-body-sm-semibold text-placeholder">
          {isPpmShell ? ppmT("onboarding.select_one") : "Select one"}
        </p>
        <Controller
          control={control}
          name="role"
          rules={{
            required: isPpmShell ? ppmT("onboarding.selection_required") : "This field is required",
          }}
          render={({ field: { value, onChange } }) => (
            <div className="flex flex-col gap-3">
              {ROLES.map((role) => {
                const Icon = role.icon;
                const isSelected = value === role.id;

                return (
                  <button
                    key={role.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onChange(role.id);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 transition-all duration-200 ${
                      isSelected
                        ? "border-accent-strong bg-accent-subtle text-accent-primary"
                        : "border-subtle text-tertiary hover:border-strong"
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <Icon className="size-3.5" />
                      <span className="text-body-sm-semibold">{isPpmShell ? ppmT(role.labelKey) : role.label}</span>
                    </div>
                    {isSelected && (
                      <span
                        className="border-blue-500 flex size-4 items-center justify-center rounded-sm border-2 bg-accent-primary"
                        aria-hidden="true"
                      >
                        <CheckIcon className="h-3 w-3 text-on-color" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        />
        {errors.role && <span className="text-13 text-danger-primary">{errors.role.message}</span>}
      </div>
      {/* Action Buttons */}
      <div className="space-y-3">
        <Button variant="primary" type="submit" className="w-full" size="xl" disabled={isButtonDisabled}>
          {isPpmShell ? ppmT("onboarding.continue") : "Continue"}
        </Button>
        <Button variant="ghost" onClick={handleSkip} className="w-full text-tertiary" size="xl">
          {isPpmShell ? ppmT("onboarding.skip") : "Skip"}
        </Button>
      </div>
    </form>
  );
});
