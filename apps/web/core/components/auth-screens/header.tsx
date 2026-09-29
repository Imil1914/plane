/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AUTH_TRACKER_ELEMENTS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { isPpmBrandEnabled, isPpmShellEnabled, PPM_BRAND } from "@ppm/brand";
import { ProductLogo } from "@/components/ppm-shell/product-logo";
import { PageHead } from "@/components/core/page-title";
import { EAuthModes } from "@/helpers/authentication.helper";
import { useInstance } from "@/hooks/store/use-instance";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

const IS_PPM_BRAND_ENABLED = isPpmBrandEnabled(process.env.PPM_BRAND_ENABLED);
const IS_PPM_SHELL_ENABLED = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

const authContentMap = {
  [EAuthModes.SIGN_IN]: {
    pageTitle: "Sign up",
    text: "auth.common.new_to_plane",
    linkText: "Sign up",
    linkHref: "/sign-up",
  },
  [EAuthModes.SIGN_UP]: {
    pageTitle: "Sign in",
    text: "auth.common.already_have_an_account",
    linkText: "Sign in",
    linkHref: "/sign-in",
  },
};

type AuthHeaderProps = {
  type: EAuthModes;
};

export const AuthHeader = observer(function AuthHeader({ type }: AuthHeaderProps) {
  const { t } = useTranslation();
  const ppmT = usePpmTranslation();
  // store
  const { config } = useInstance();
  // G2.2 review round 1 (#4): the sign-in/sign-up toggle below must keep next_path — otherwise switching between
  // them loses the way back to the Git server's «Войти через PPM» continuation link.
  const nextPath = useSearchParams().get("next_path");
  // derived values
  const enableSignUpConfig = config?.enable_signup ?? false;
  const toggleHref = nextPath
    ? `${authContentMap[type].linkHref}?next_path=${nextPath}`
    : authContentMap[type].linkHref;
  const pageTitle = IS_PPM_SHELL_ENABLED
    ? ppmT(type === EAuthModes.SIGN_IN ? "auth.sign_in" : "auth.sign_up")
    : t(authContentMap[type].pageTitle);
  const prompt = IS_PPM_SHELL_ENABLED
    ? ppmT(type === EAuthModes.SIGN_IN ? "auth.new_to_ppm" : "auth.already_have_account")
    : t(authContentMap[type].text);
  const linkText = IS_PPM_SHELL_ENABLED
    ? ppmT(type === EAuthModes.SIGN_IN ? "auth.sign_up" : "auth.sign_in")
    : t(authContentMap[type].linkText);

  return (
    <AuthHeaderBase
      pageTitle={pageTitle}
      additionalAction={
        enableSignUpConfig && (
          <div className="flex flex-col items-end text-center text-13 font-medium text-tertiary sm:flex-row sm:items-center sm:gap-2">
            <span className="text-body-sm-regular text-tertiary">{prompt}</span>
            <Link
              data-ph-element={AUTH_TRACKER_ELEMENTS.NAVIGATE_TO_SIGN_UP}
              href={toggleHref}
              className="text-body-sm-semibold text-accent-primary hover:underline"
            >
              {linkText}
            </Link>
          </div>
        )
      }
    />
  );
});

type TAuthHeaderBase = {
  pageTitle: string;
  additionalAction?: React.ReactNode;
};

export function AuthHeaderBase(props: TAuthHeaderBase) {
  const { pageTitle, additionalAction } = props;
  return (
    <>
      <PageHead title={`${pageTitle} - ${IS_PPM_BRAND_ENABLED ? PPM_BRAND.name : "Plane"}`} />
      <div className="sticky top-0 flex w-full flex-shrink-0 items-center justify-between gap-6">
        <Link href="/" aria-label={IS_PPM_BRAND_ENABLED ? PPM_BRAND.name : "Plane"}>
          <ProductLogo />
        </Link>
        {additionalAction}
      </div>
    </>
  );
}
