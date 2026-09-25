/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// components
import { ThemeSwitcher } from "@/components/appearance";
import { PpmDensitySwitcher } from "@/components/ppm-shell/density-switcher";
// lib
import { usePpmDesignV2 } from "@/lib/ppm-design";

export const ProfileSettingsDefaultPreferencesList = observer(function ProfileSettingsDefaultPreferencesList() {
  const isDesignV2 = usePpmDesignV2();

  return (
    <div className="flex flex-col gap-y-1">
      <ThemeSwitcher
        option={{
          id: "theme",
          title: "theme",
          description: "select_or_customize_your_interface_color_scheme",
        }}
      />
      {isDesignV2 && <PpmDensitySwitcher />}
    </div>
  );
});
