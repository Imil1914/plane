/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { IS_PPM_SHELL_ENABLED, useAuthLanguage } from "@/helpers/ppm-auth-language";

type Props = {
  isSignUp?: boolean;
};

const TERMS_URL = "https://plane.so/legals/terms-and-conditions";
const PRIVACY_URL = "https://plane.so/legals/privacy-policy";

export function TermsAndConditions(props: Props) {
  const { isSignUp = false } = props;
  const { t } = useAuthLanguage();

  // PPM line L: the web sign-in wording from the PPM dictionary (same links as the web screens).
  if (IS_PPM_SHELL_ENABLED)
    return (
      <span className="flex items-center justify-center py-6">
        <p className="text-center text-13 whitespace-pre-line text-secondary">
          {t(isSignUp ? "auth.terms_sign_up" : "auth.terms_sign_in")}{" "}
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
            <span className="text-13 font-medium underline hover:cursor-pointer">{t("auth.terms")}</span>
          </a>{" "}
          {t("auth.and")}{" "}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            <span className="text-13 font-medium underline hover:cursor-pointer">{t("auth.privacy")}</span>
          </a>
          {"."}
        </p>
      </span>
    );

  return (
    <span className="flex items-center justify-center py-6">
      <p className="text-center text-13 whitespace-pre-line text-secondary">
        {isSignUp ? "By creating an account" : "By signing in"}, you agree to our{" \n"}
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
          <span className="text-13 font-medium underline hover:cursor-pointer">Terms of Service</span>
        </a>{" "}
        and{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
          <span className="text-13 font-medium underline hover:cursor-pointer">Privacy Policy</span>
        </a>
        {"."}
      </p>
    </span>
  );
}
