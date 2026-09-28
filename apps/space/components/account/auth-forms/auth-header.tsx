/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPpmTranslationKey } from "@ppm/brand";
// helpers
import { IS_PPM_SHELL_ENABLED, useAuthLanguage } from "@/helpers/ppm-auth-language";
import { EAuthModes } from "@/types/auth";

type TAuthHeader = {
  authMode: EAuthModes;
};

type TAuthHeaderContent = {
  header: string;
  subHeader: string;
};

type TAuthHeaderDetails = {
  [mode in EAuthModes]: TAuthHeaderContent;
};

const Titles: TAuthHeaderDetails = {
  [EAuthModes.SIGN_IN]: {
    header: "Sign in to upvote or comment",
    subHeader: "Contribute in nudging the features you want to get built.",
  },
  [EAuthModes.SIGN_UP]: {
    header: "View, comment, and do more",
    subHeader: "Sign up or log in to work with Plane work items and Pages.",
  },
};

// PPM line L: the same headers from the PPM dictionary.
const PPM_TITLE_KEYS: { [mode in EAuthModes]: { header: TPpmTranslationKey; subHeader: TPpmTranslationKey } } = {
  [EAuthModes.SIGN_IN]: { header: "auth.space_sign_in_title", subHeader: "auth.space_sign_in_description" },
  [EAuthModes.SIGN_UP]: { header: "auth.space_sign_up_title", subHeader: "auth.space_sign_up_description" },
};

export function AuthHeader(props: TAuthHeader) {
  const { authMode } = props;
  const { t } = useAuthLanguage();

  const getHeaderSubHeader = (mode: EAuthModes | null): TAuthHeaderContent => {
    if (IS_PPM_SHELL_ENABLED) {
      if (mode) return { header: t(PPM_TITLE_KEYS[mode].header), subHeader: t(PPM_TITLE_KEYS[mode].subHeader) };
      return { header: t("auth.space_default_title"), subHeader: t("auth.space_default_description") };
    }
    if (mode) {
      return Titles[mode];
    }

    return {
      header: "Comment or react to work items",
      subHeader: "Use plane to add your valuable inputs to features.",
    };
  };

  const { header, subHeader } = getHeaderSubHeader(authMode);

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-20 leading-7 font-semibold text-primary">{header}</span>
        <span className="text-20 leading-7 font-semibold text-placeholder">{subHeader}</span>
      </div>
    </>
  );
}
