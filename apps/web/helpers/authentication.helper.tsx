/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import Link from "next/link";
// plane imports
import { getAuthErrorMessage } from "@plane/utils";
import type { TAuthErrorLink, TAuthErrorMessage } from "@plane/utils";
import { PPM_DEFAULT_LANGUAGE, getPpmTranslation, isPpmShellEnabled } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";

export enum EPageTypes {
  PUBLIC = "PUBLIC",
  NON_AUTHENTICATED = "NON_AUTHENTICATED",
  SET_PASSWORD = "SET_PASSWORD",
  ONBOARDING = "ONBOARDING",
  AUTHENTICATED = "AUTHENTICATED",
}

export enum EAuthModes {
  SIGN_IN = "SIGN_IN",
  SIGN_UP = "SIGN_UP",
}

export enum EAuthSteps {
  EMAIL = "EMAIL",
  PASSWORD = "PASSWORD",
  UNIQUE_CODE = "UNIQUE_CODE",
}

export enum EErrorAlertType {
  BANNER_ALERT = "BANNER_ALERT",
  INLINE_FIRST_NAME = "INLINE_FIRST_NAME",
  INLINE_EMAIL = "INLINE_EMAIL",
  INLINE_PASSWORD = "INLINE_PASSWORD",
  INLINE_EMAIL_CODE = "INLINE_EMAIL_CODE",
}

export enum EAuthenticationErrorCodes {
  // Global
  INSTANCE_NOT_CONFIGURED = "5000",
  INVALID_EMAIL = "5005",
  EMAIL_REQUIRED = "5010",
  SIGNUP_DISABLED = "5015",
  MAGIC_LINK_LOGIN_DISABLED = "5016",
  BOT_USER_LOGIN_FORBIDDEN = "5017",
  PASSWORD_LOGIN_DISABLED = "5018",
  USER_ACCOUNT_DEACTIVATED = "5019",
  // Password strength
  INVALID_PASSWORD = "5020",
  PASSWORD_TOO_WEAK = "5021",
  SMTP_NOT_CONFIGURED = "5025",
  // Sign Up
  USER_ALREADY_EXIST = "5030",
  AUTHENTICATION_FAILED_SIGN_UP = "5035",
  REQUIRED_EMAIL_PASSWORD_SIGN_UP = "5040",
  INVALID_EMAIL_SIGN_UP = "5045",
  INVALID_EMAIL_MAGIC_SIGN_UP = "5050",
  MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED = "5055",
  // Sign In
  USER_DOES_NOT_EXIST = "5060",
  AUTHENTICATION_FAILED_SIGN_IN = "5065",
  REQUIRED_EMAIL_PASSWORD_SIGN_IN = "5070",
  INVALID_EMAIL_SIGN_IN = "5075",
  INVALID_EMAIL_MAGIC_SIGN_IN = "5080",
  MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED = "5085",
  // Both Sign in and Sign up for magic
  INVALID_MAGIC_CODE_SIGN_IN = "5090",
  INVALID_MAGIC_CODE_SIGN_UP = "5092",
  EXPIRED_MAGIC_CODE_SIGN_IN = "5095",
  EXPIRED_MAGIC_CODE_SIGN_UP = "5097",
  EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN = "5100",
  EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP = "5102",
  // Oauth
  OAUTH_NOT_CONFIGURED = "5104",
  GOOGLE_NOT_CONFIGURED = "5105",
  GITHUB_NOT_CONFIGURED = "5110",
  GITLAB_NOT_CONFIGURED = "5111",
  GOOGLE_OAUTH_PROVIDER_ERROR = "5115",
  GITHUB_OAUTH_PROVIDER_ERROR = "5120",
  GITLAB_OAUTH_PROVIDER_ERROR = "5121",
  // Reset Password
  INVALID_PASSWORD_TOKEN = "5125",
  EXPIRED_PASSWORD_TOKEN = "5130",
  // Change password
  INCORRECT_OLD_PASSWORD = "5135",
  MISSING_PASSWORD = "5138",
  INVALID_NEW_PASSWORD = "5140",
  // set password
  PASSWORD_ALREADY_SET = "5145",
  // Admin
  ADMIN_ALREADY_EXIST = "5150",
  REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME = "5155",
  INVALID_ADMIN_EMAIL = "5160",
  INVALID_ADMIN_PASSWORD = "5165",
  REQUIRED_ADMIN_EMAIL_PASSWORD = "5170",
  ADMIN_AUTHENTICATION_FAILED = "5175",
  ADMIN_USER_ALREADY_EXIST = "5180",
  ADMIN_USER_DOES_NOT_EXIST = "5185",
  ADMIN_USER_DEACTIVATED = "5190",
  // Rate limit
  RATE_LIMIT_EXCEEDED = "5900",
}

export type TAuthErrorInfo = {
  type: EErrorAlertType;
  code: EAuthenticationErrorCodes;
  title: string;
  message: ReactNode;
};

const IS_PPM_SHELL_ENABLED = isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED);

/**
 * Language of the sign-in messages (PPM line L): the one the screen passes (`useTranslation().currentLocale`), else
 * the page language (`<html lang>`, kept by the PPM locale bootstrap and the language switch), else the PPM default.
 * With the PPM shell rolled back (PPM_SHELL_ENABLED=0) always English, as upstream.
 */
const resolveAuthMessageLanguage = (locale: string | undefined): string => {
  if (!IS_PPM_SHELL_ENABLED) return "en";
  if (locale) return locale;
  const pageLanguage = typeof document === "undefined" ? undefined : document.documentElement?.lang;
  return pageLanguage || PPM_DEFAULT_LANGUAGE;
};

/**
 * Title and text of a sign-in error as plain strings (toasts), in the language chosen as for `authErrorHandler`.
 * The texts live in the PPM dictionary (`auth.error.*`); the code → text map is `AUTH_ERROR_TEXTS` in @plane/utils.
 */
export const getAuthErrorText = (errorCode: string | undefined, locale?: string): TAuthErrorMessage | undefined => {
  const language = resolveAuthMessageLanguage(locale);
  return getAuthErrorMessage(errorCode, (key) => getPpmTranslation(language, key as TPpmTranslationKey));
};

/**
 * Text of the forgot-password error toast in the interface language: an unknown address only asks to check it (the
 * reset screen is no place to call for signing up); other codes get their sign-in error text.
 */
export const getResetLinkErrorText = (errorCode: string | undefined, locale?: string): string | undefined => {
  if (errorCode === EAuthenticationErrorCodes.USER_DOES_NOT_EXIST)
    return getPpmTranslation(resolveAuthMessageLanguage(locale), "auth.reset_account_not_found");
  return getAuthErrorText(errorCode, locale)?.message;
};

const authErrorLinkHref = (target: TAuthErrorLink, email: string | undefined) => {
  if (target === "admin_sign_in") return "/admin";
  const query = email ? `?email=${encodeURIComponent(email)}` : "";
  return target === "sign_in" ? `/sign-in${query}` : `/${query}`;
};

const renderAuthErrorMessage = (text: TAuthErrorMessage, email: string | undefined): ReactNode => {
  if (!text.link) return text.message;
  const { target, label, before, after } = text.link;
  return (
    <div>
      {before}
      <Link
        className="font-medium underline underline-offset-4 transition-all hover:font-bold"
        href={authErrorLinkHref(target, email)}
      >
        {label}
      </Link>
      {after}
    </div>
  );
};

export const authErrorHandler = (
  errorCode: EAuthenticationErrorCodes,
  email?: string,
  locale?: string
): TAuthErrorInfo | undefined => {
  const bannerAlertErrorCodes = [
    EAuthenticationErrorCodes.INSTANCE_NOT_CONFIGURED,
    EAuthenticationErrorCodes.INVALID_EMAIL,
    EAuthenticationErrorCodes.EMAIL_REQUIRED,
    EAuthenticationErrorCodes.SIGNUP_DISABLED,
    EAuthenticationErrorCodes.MAGIC_LINK_LOGIN_DISABLED,
    EAuthenticationErrorCodes.PASSWORD_LOGIN_DISABLED,
    EAuthenticationErrorCodes.BOT_USER_LOGIN_FORBIDDEN,
    EAuthenticationErrorCodes.USER_ACCOUNT_DEACTIVATED,
    EAuthenticationErrorCodes.INVALID_PASSWORD,
    EAuthenticationErrorCodes.SMTP_NOT_CONFIGURED,
    EAuthenticationErrorCodes.USER_ALREADY_EXIST,
    EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_UP,
    EAuthenticationErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_UP,
    EAuthenticationErrorCodes.INVALID_EMAIL_SIGN_UP,
    EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_UP,
    EAuthenticationErrorCodes.MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED,
    EAuthenticationErrorCodes.USER_DOES_NOT_EXIST,
    EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN,
    EAuthenticationErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_IN,
    EAuthenticationErrorCodes.INVALID_EMAIL_SIGN_IN,
    EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_IN,
    EAuthenticationErrorCodes.MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED,
    EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_IN,
    EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_UP,
    EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN,
    EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP,
    EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN,
    EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP,
    EAuthenticationErrorCodes.OAUTH_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GOOGLE_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GITHUB_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GITLAB_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GOOGLE_OAUTH_PROVIDER_ERROR,
    EAuthenticationErrorCodes.GITHUB_OAUTH_PROVIDER_ERROR,
    EAuthenticationErrorCodes.GITLAB_OAUTH_PROVIDER_ERROR,
    EAuthenticationErrorCodes.INVALID_PASSWORD_TOKEN,
    EAuthenticationErrorCodes.EXPIRED_PASSWORD_TOKEN,
    EAuthenticationErrorCodes.INCORRECT_OLD_PASSWORD,
    EAuthenticationErrorCodes.MISSING_PASSWORD,
    EAuthenticationErrorCodes.INVALID_NEW_PASSWORD,
    EAuthenticationErrorCodes.PASSWORD_ALREADY_SET,
    EAuthenticationErrorCodes.ADMIN_ALREADY_EXIST,
    EAuthenticationErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME,
    EAuthenticationErrorCodes.INVALID_ADMIN_EMAIL,
    EAuthenticationErrorCodes.INVALID_ADMIN_PASSWORD,
    EAuthenticationErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD,
    EAuthenticationErrorCodes.ADMIN_AUTHENTICATION_FAILED,
    EAuthenticationErrorCodes.ADMIN_USER_ALREADY_EXIST,
    EAuthenticationErrorCodes.ADMIN_USER_DOES_NOT_EXIST,
    EAuthenticationErrorCodes.ADMIN_USER_DEACTIVATED,
    EAuthenticationErrorCodes.RATE_LIMIT_EXCEEDED,
    EAuthenticationErrorCodes.PASSWORD_TOO_WEAK,
  ];

  if (!bannerAlertErrorCodes.includes(errorCode)) return undefined;
  const text = getAuthErrorText(errorCode, locale);
  if (!text) return undefined;

  return {
    type: EErrorAlertType.BANNER_ALERT,
    code: errorCode,
    title: text.title,
    message: renderAuthErrorMessage(text, email),
  };
};

export const passwordErrors = [
  EAuthenticationErrorCodes.PASSWORD_TOO_WEAK,
  EAuthenticationErrorCodes.INVALID_NEW_PASSWORD,
];
