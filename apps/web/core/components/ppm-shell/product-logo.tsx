/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { PlaneLockup, PlaneLogo } from "@plane/propel/icons";
import { cn } from "@plane/utils";
import { isPpmBrandEnabled, PPM_BRAND } from "@ppm/brand";

const IS_PPM_BRAND_ENABLED = isPpmBrandEnabled(process.env.PPM_BRAND_ENABLED);

type TProductLogoProps = {
  className?: string;
  compact?: boolean;
};

export function ProductLogo({ className, compact = false }: TProductLogoProps) {
  if (!IS_PPM_BRAND_ENABLED) {
    return compact ? (
      <PlaneLogo className={cn("h-9 w-auto text-primary", className)} />
    ) : (
      <PlaneLockup height={20} width={95} className={cn("text-primary", className)} />
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-2.5", className)} aria-label={PPM_BRAND.name}>
      <img alt="" aria-hidden="true" className={compact ? "size-9" : "size-7"} src={PPM_BRAND.assets.mark} />
      {!compact && <span className="text-18 font-semibold tracking-[0.08em] text-primary">{PPM_BRAND.name}</span>}
    </span>
  );
}
