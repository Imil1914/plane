/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { START_OF_THE_WEEK_OPTIONS } from "@plane/constants";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { EStartOfTheWeek } from "@plane/types";
import { CustomSelect } from "@plane/ui";
import { isPpmShellEnabled } from "@ppm/brand";
// components
import { SettingsControlItem } from "@/components/settings/control-item";
// hooks
import { useUserProfile } from "@/hooks/store/user";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { useTranslation } from "@plane/i18n";
import { getPpmWeekdayName } from "@/components/ppm-shell/week-start";

const getStartOfWeekLabel = (startOfWeek: EStartOfTheWeek, language?: string) =>
  getPpmWeekdayName(startOfWeek, language) ??
  START_OF_THE_WEEK_OPTIONS.find((option) => option.value === startOfWeek)?.label;

export const StartOfWeekPreference = observer(function StartOfWeekPreference(props: {
  option: { title: string; description: string };
}) {
  // hooks
  const { updateUserProfile, startOfTheWeek } = useUserProfile();
  const ppmT = usePpmTranslation();
  const isPpmShell = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);
  const { currentLocale } = useTranslation();
  // Russian weekday names only under the PPM shell (upstream keeps its English labels).
  const weekdayLanguage = isPpmShell ? currentLocale : undefined;

  const handleStartOfWeekChange = async (val: number) => {
    try {
      await updateUserProfile({ start_of_the_week: val });
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: isPpmShell ? ppmT("ux.preferences.success_title") : "Success",
        message: isPpmShell
          ? ppmT("ux.preferences.start_of_week_updated")
          : "First day of the week updated successfully",
      });
    } catch (_error) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: isPpmShell ? ppmT("ux.preferences.update_failed_title") : "Update failed",
        message: isPpmShell ? ppmT("ux.preferences.try_again_later") : "Please try again later.",
      });
    }
  };

  return (
    <SettingsControlItem
      title={props.option.title}
      description={props.option.description}
      control={
        <CustomSelect
          value={startOfTheWeek}
          label={getStartOfWeekLabel(startOfTheWeek, weekdayLanguage)}
          onChange={handleStartOfWeekChange}
          buttonClassName="border border-subtle-1"
          input
          maxHeight="lg"
          placement="bottom-end"
        >
          <>
            {START_OF_THE_WEEK_OPTIONS.map((day) => (
              <CustomSelect.Option key={day.value} value={day.value}>
                {getStartOfWeekLabel(day.value, weekdayLanguage)}
              </CustomSelect.Option>
            ))}
          </>
        </CustomSelect>
      }
    />
  );
});
