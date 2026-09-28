/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { WEB_BASE_URL, WEBSITE_URL } from "@plane/constants";
// assets
import { PlaneLogo } from "@plane/propel/icons";
import { isPpmBrandEnabled, PPM_BRAND } from "@ppm/brand";
import ppmMark from "@ppm/brand/assets/mark.svg?url";
// helpers
import { useAuthLanguage } from "@/helpers/ppm-auth-language";

const IS_PPM_BRAND_ENABLED = isPpmBrandEnabled(process.env.PPM_BRAND_ENABLED);

type TPoweredBy = {
  disabled?: boolean;
};

export function PoweredBy(props: TPoweredBy) {
  // props
  const { disabled = false } = props;
  const { t } = useAuthLanguage();

  if (disabled) return null;

  // PPM: no «Powered by Plane Publish» badge. The PPM mark leads to «О программе → открытый код» of the web app — the
  // page where PPM credits Plane and offers the source code of this build (AGPL-3.0 §13).
  if (IS_PPM_BRAND_ENABLED)
    return (
      <a
        href={`${WEB_BASE_URL}/about/open-source`}
        aria-label={t("about.title")}
        title={t("about.title")}
        className="fixed right-5 bottom-2.5 !z-[999999] flex items-center gap-1.5 rounded-sm border border-subtle bg-layer-3 px-2 py-1 shadow-raised-100"
        target="_blank"
        rel="noreferrer noopener"
      >
        <img src={ppmMark} alt="" aria-hidden="true" className="size-3" />
        <span className="text-11 font-semibold">{PPM_BRAND.name}</span>
      </a>
    );

  if (!WEBSITE_URL) return null;

  return (
    <a
      href={WEBSITE_URL}
      className="fixed right-5 bottom-2.5 !z-[999999] flex items-center gap-1 rounded-sm border border-subtle bg-layer-3 px-2 py-1 shadow-raised-100"
      target="_blank"
      rel="noreferrer noopener"
    >
      <PlaneLogo className="h-3 w-auto text-primary" />
      <div className="text-11">
        Powered by <span className="font-semibold">Plane Publish</span>
      </div>
    </a>
  );
}
