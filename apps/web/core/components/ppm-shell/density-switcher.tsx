/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CustomSelect } from "@plane/ui";
import type { TPpmDensity } from "@ppm/brand";
// components
import { SettingsControlItem } from "@/components/settings/control-item";
// hooks
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
// lib
import { setPpmDensity, usePpmDensity } from "@/lib/ppm-design";

const DENSITIES: TPpmDensity[] = ["comfortable", "compact"];
const DENSITY_LABEL_KEYS = {
  comfortable: "density.comfortable",
  compact: "density.compact",
} as const satisfies Record<TPpmDensity, string>;

/**
 * «Профиль → Предпочтения»: «Плотность: Удобная / Компактная» (UX1.1, R3). Applies at once through
 * <html data-ppm-density> and is remembered in this browser only: no profile write, no reload.
 */
export function PpmDensitySwitcher() {
  const ppmT = usePpmTranslation();
  const density = usePpmDensity();

  return (
    <SettingsControlItem
      title={ppmT("density.label")}
      description={ppmT("density.description")}
      control={
        <CustomSelect
          value={density}
          label={ppmT(DENSITY_LABEL_KEYS[density])}
          onChange={(value: TPpmDensity) => setPpmDensity(value)}
          buttonClassName="border border-subtle-1"
          input
          placement="bottom-end"
        >
          {DENSITIES.map((option) => (
            <CustomSelect.Option key={option} value={option}>
              {ppmT(DENSITY_LABEL_KEYS[option])}
            </CustomSelect.Option>
          ))}
        </CustomSelect>
      }
    />
  );
}
