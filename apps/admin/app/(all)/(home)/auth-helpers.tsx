/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
// plane packages
import type { TAdminAuthErrorInfo } from "@plane/constants";
import { EAdminAuthErrorCodes } from "@plane/constants";
import { getAuthErrorMessage } from "@plane/utils";
import type { TAuthErrorMessage } from "@plane/utils";
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
// local
import { getAuthLanguage } from "./ppm-auth-language";

export enum EErrorAlertType {
  BANNER_ALERT = "BANNER_ALERT",
  INLINE_FIRST_NAME = "INLINE_FIRST_NAME",
  INLINE_EMAIL = "INLINE_EMAIL",
  INLINE_PASSWORD = "INLINE_PASSWORD",
  INLINE_EMAIL_CODE = "INLINE_EMAIL_CODE",
}

const bannerAlertErrorCodes = new Set<string>([
  EAdminAuthErrorCodes.ADMIN_ALREADY_EXIST,
  EAdminAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME,
  EAdminAuthErrorCodes.INVALID_ADMIN_EMAIL,
  EAdminAuthErrorCodes.INVALID_ADMIN_PASSWORD,
  EAdminAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD,
  EAdminAuthErrorCodes.ADMIN_AUTHENTICATION_FAILED,
  EAdminAuthErrorCodes.ADMIN_USER_ALREADY_EXIST,
  EAdminAuthErrorCodes.ADMIN_USER_DOES_NOT_EXIST,
  EAdminAuthErrorCodes.ADMIN_USER_DEACTIVATED,
]);

// PPM line L: the texts come from the PPM dictionary (`auth.error.*`, code → text map AUTH_ERROR_TEXTS in
// @plane/utils) in the interface language. The sign-in link leads to this sign-in page ("/" under the /god-mode
// basename; upstream pointed at "/admin", a missing page).
const renderMessage = (text: TAuthErrorMessage) => {
  if (!text.link) return text.message;
  const { label, before, after } = text.link;
  return (
    <div>
      {before}
      <Link className="font-medium underline underline-offset-4 transition-all hover:font-bold" href="/">
        {label}
      </Link>
      {after}
    </div>
  );
};

/** The banner for an admin sign-in error in `language` (default: the interface language), or undefined. */
export const authErrorHandler = (
  errorCode: EAdminAuthErrorCodes,
  language: string = getAuthLanguage()
): TAdminAuthErrorInfo | undefined => {
  if (!bannerAlertErrorCodes.has(errorCode)) return undefined;
  const text = getAuthErrorMessage(errorCode, (key) => getPpmTranslation(language, key as TPpmTranslationKey));
  if (!text) return undefined;

  return {
    type: EErrorAlertType.BANNER_ALERT,
    code: errorCode,
    title: text.title,
    message: renderMessage(text),
  };
};
