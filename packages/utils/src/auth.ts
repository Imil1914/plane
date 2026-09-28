/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
// plane imports
import type { TAuthErrorInfo } from "@plane/constants";
import { E_PASSWORD_STRENGTH, EErrorAlertType, EAuthErrorCodes } from "@plane/constants";

/**
 * @description Password strength levels
 */
export enum PasswordStrength {
  EMPTY = "empty",
  WEAK = "weak",
  FAIR = "fair",
  GOOD = "good",
  STRONG = "strong",
}

/**
 * Calculate password strength based on various criteria
 */
export const getPasswordStrength = (password: string): E_PASSWORD_STRENGTH => {
  if (!password || password === "" || password.length <= 0) {
    return E_PASSWORD_STRENGTH.EMPTY;
  }

  if (password.length < 8) {
    return E_PASSWORD_STRENGTH.LENGTH_NOT_VALID;
  }

  // Check all criteria
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecialChar = /[!@#$%^&*()\-_+=\[\]{}|;:'",.<>?/]/.test(password);

  if (hasUpperCase && hasLowerCase && hasDigit && hasSpecialChar) {
    return E_PASSWORD_STRENGTH.STRENGTH_VALID;
  }

  return E_PASSWORD_STRENGTH.STRENGTH_NOT_VALID;
};

export type PasswordCriteria = {
  key: string;
  label: string;
  isValid: boolean;
};

/**
 * Get password criteria for validation display
 */
export const getPasswordCriteria = (password: string): PasswordCriteria[] => [
  {
    key: "length",
    label: "Min 8 characters",
    isValid: password.length >= 8,
  },
  {
    key: "uppercase",
    label: "Min 1 upper-case letter",
    isValid: /[A-Z]/.test(password),
  },
  {
    key: "lowercase",
    label: "Min 1 lower-case letter",
    isValid: /[a-z]/.test(password),
  },
  {
    key: "number",
    label: "Min 1 number",
    isValid: /[0-9]/.test(password),
  },
  {
    key: "special",
    label: "Min 1 special character",
    isValid: /[!@#$%^&*()\-_+=\[\]{}|;:'",.<>?/]/.test(password),
  },
];

// Error code messages
const errorCodeMessages: {
  [key in EAuthErrorCodes]: { title: string; message: (email?: string) => ReactNode };
} = {
  // global
  [EAuthErrorCodes.INSTANCE_NOT_CONFIGURED]: {
    title: `Instance not configured`,
    message: () => `Instance not configured. Please contact your administrator.`,
  },
  [EAuthErrorCodes.SIGNUP_DISABLED]: {
    title: `Sign up disabled`,
    message: () => `Sign up disabled. Please contact your administrator.`,
  },
  [EAuthErrorCodes.INVALID_PASSWORD]: {
    title: `Invalid password`,
    message: () => `Invalid password. Please try again.`,
  },
  [EAuthErrorCodes.PASSWORD_TOO_WEAK]: {
    title: `Password too weak`,
    message: () => `Please use a stronger password.`,
  },
  [EAuthErrorCodes.SMTP_NOT_CONFIGURED]: {
    title: `SMTP not configured`,
    message: () => `SMTP not configured. Please contact your administrator.`,
  },
  // email check in both sign up and sign in
  [EAuthErrorCodes.INVALID_EMAIL]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  [EAuthErrorCodes.EMAIL_REQUIRED]: {
    title: `Email required`,
    message: () => `Email required. Please try again.`,
  },
  // sign up
  [EAuthErrorCodes.USER_ALREADY_EXIST]: {
    title: `User already exists`,
    message: () => `Your account is already registered. Sign in now.`,
  },
  [EAuthErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_UP]: {
    title: `Email and password required`,
    message: () => `Email and password required. Please try again.`,
  },
  [EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_UP]: {
    title: `Authentication failed`,
    message: () => `Authentication failed. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_EMAIL_SIGN_UP]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  [EAuthErrorCodes.MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED]: {
    title: `Email and code required`,
    message: () => `Email and code required. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_EMAIL_MAGIC_SIGN_UP]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  // sign in
  [EAuthErrorCodes.BOT_USER_LOGIN_FORBIDDEN]: {
    title: `Sign in not allowed`,
    message: () => `This account cannot be used to sign in. Please use a personal account.`,
  },
  [EAuthErrorCodes.USER_ACCOUNT_DEACTIVATED]: {
    title: `User account deactivated`,
    message: () => `User account deactivated. Please contact administrator.`,
  },
  [EAuthErrorCodes.USER_DOES_NOT_EXIST]: {
    title: `User does not exist`,
    message: () => `No account found. Create one to get started.`,
  },
  [EAuthErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_IN]: {
    title: `Email and password required`,
    message: () => `Email and password required. Please try again.`,
  },
  [EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_IN]: {
    title: `Authentication failed`,
    message: () => `Authentication failed. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_EMAIL_SIGN_IN]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  [EAuthErrorCodes.MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED]: {
    title: `Email and code required`,
    message: () => `Email and code required. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_EMAIL_MAGIC_SIGN_IN]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  // Both Sign in and Sign up
  [EAuthErrorCodes.INVALID_MAGIC_CODE_SIGN_IN]: {
    title: `Authentication failed`,
    message: () => `Invalid magic code. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_MAGIC_CODE_SIGN_UP]: {
    title: `Authentication failed`,
    message: () => `Invalid magic code. Please try again.`,
  },
  [EAuthErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },
  [EAuthErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },
  [EAuthErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },
  [EAuthErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },
  // Oauth
  [EAuthErrorCodes.OAUTH_NOT_CONFIGURED]: {
    title: `OAuth not configured`,
    message: () => `OAuth not configured. Please contact your administrator.`,
  },
  [EAuthErrorCodes.GOOGLE_NOT_CONFIGURED]: {
    title: `Google not configured`,
    message: () => `Google not configured. Please contact your administrator.`,
  },
  [EAuthErrorCodes.GITHUB_NOT_CONFIGURED]: {
    title: `GitHub not configured`,
    message: () => `GitHub not configured. Please contact your administrator.`,
  },
  [EAuthErrorCodes.GITLAB_NOT_CONFIGURED]: {
    title: `GitLab not configured`,
    message: () => `GitLab not configured. Please contact your administrator.`,
  },
  [EAuthErrorCodes.GOOGLE_OAUTH_PROVIDER_ERROR]: {
    title: `Google OAuth provider error`,
    message: () => `Google OAuth provider error. Please try again.`,
  },
  [EAuthErrorCodes.GITHUB_OAUTH_PROVIDER_ERROR]: {
    title: `GitHub OAuth provider error`,
    message: () => `GitHub OAuth provider error. Please try again.`,
  },
  [EAuthErrorCodes.GITLAB_OAUTH_PROVIDER_ERROR]: {
    title: `GitLab OAuth provider error`,
    message: () => `GitLab OAuth provider error. Please try again.`,
  },
  // Reset Password
  [EAuthErrorCodes.INVALID_PASSWORD_TOKEN]: {
    title: `Invalid password token`,
    message: () => `Invalid password token. Please try again.`,
  },
  [EAuthErrorCodes.EXPIRED_PASSWORD_TOKEN]: {
    title: `Expired password token`,
    message: () => `Expired password token. Please try again.`,
  },
  // Change password
  [EAuthErrorCodes.MISSING_PASSWORD]: {
    title: `Password required`,
    message: () => `Password required. Please try again.`,
  },
  [EAuthErrorCodes.INCORRECT_OLD_PASSWORD]: {
    title: `Incorrect old password`,
    message: () => `Incorrect old password. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_NEW_PASSWORD]: {
    title: `Invalid new password`,
    message: () => `Invalid new password. Please try again.`,
  },
  // set password
  [EAuthErrorCodes.PASSWORD_ALREADY_SET]: {
    title: `Password already set`,
    message: () => `Password already set. Please try again.`,
  },
  // admin
  [EAuthErrorCodes.ADMIN_ALREADY_EXIST]: {
    title: `Admin already exists`,
    message: () => `Admin already exists. Please try again.`,
  },
  [EAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME]: {
    title: `Email, password and first name required`,
    message: () => `Email, password and first name required. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_ADMIN_EMAIL]: {
    title: `Invalid admin email`,
    message: () => `Invalid admin email. Please try again.`,
  },
  [EAuthErrorCodes.INVALID_ADMIN_PASSWORD]: {
    title: `Invalid admin password`,
    message: () => `Invalid admin password. Please try again.`,
  },
  [EAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD]: {
    title: `Email and password required`,
    message: () => `Email and password required. Please try again.`,
  },
  [EAuthErrorCodes.ADMIN_AUTHENTICATION_FAILED]: {
    title: `Authentication failed`,
    message: () => `Authentication failed. Please try again.`,
  },
  [EAuthErrorCodes.ADMIN_USER_ALREADY_EXIST]: {
    title: `Admin user already exists`,
    message: () => `Admin user already exists. Sign in now.`,
  },
  [EAuthErrorCodes.ADMIN_USER_DOES_NOT_EXIST]: {
    title: `Admin user does not exist`,
    message: () => `Admin user does not exist. Sign in now.`,
  },
  [EAuthErrorCodes.MAGIC_LINK_LOGIN_DISABLED]: {
    title: `Magic link login disabled`,
    message: () => `Magic link login is disabled. Please use password to login.`,
  },
  [EAuthErrorCodes.PASSWORD_LOGIN_DISABLED]: {
    title: `Password login disabled`,
    message: () => `Password login is disabled. Please use magic link to login.`,
  },
  [EAuthErrorCodes.ADMIN_USER_DEACTIVATED]: {
    title: `Admin user deactivated`,
    message: () => `Admin user account has been deactivated. Please contact administrator.`,
  },
  [EAuthErrorCodes.RATE_LIMIT_EXCEEDED]: {
    title: `Rate limit exceeded`,
    message: () => `Too many requests. Please try again later.`,
  },
};

// ---------------- PPM (line L): sign-in errors in the interface language ----------------

/** Where a sign-in error text puts its link; each app renders the link with its own router. */
export type TAuthErrorLink = "sign_in" | "create_account" | "admin_sign_in";

/**
 * What a sign-in error says, as a text id of the PPM dictionary (`@ppm/brand`: `auth.error.<id>_title` and
 * `auth.error.<id>_message`); several codes share a text. `link`: the message has a `{link}` placeholder. No text
 * names a support address: in PPM people turn to their PPM administrator, never to Plane's support.
 */
export type TAuthErrorText = { id: string; link?: TAuthErrorLink };

export const AUTH_ERROR_TEXTS: Record<EAuthErrorCodes, TAuthErrorText> = {
  [EAuthErrorCodes.INSTANCE_NOT_CONFIGURED]: { id: "instance_not_configured" },
  [EAuthErrorCodes.INVALID_EMAIL]: { id: "invalid_email" },
  [EAuthErrorCodes.EMAIL_REQUIRED]: { id: "email_required" },
  [EAuthErrorCodes.SIGNUP_DISABLED]: { id: "signup_disabled" },
  [EAuthErrorCodes.MAGIC_LINK_LOGIN_DISABLED]: { id: "magic_link_login_disabled" },
  [EAuthErrorCodes.BOT_USER_LOGIN_FORBIDDEN]: { id: "bot_login_forbidden" },
  [EAuthErrorCodes.PASSWORD_LOGIN_DISABLED]: { id: "password_login_disabled" },
  [EAuthErrorCodes.USER_ACCOUNT_DEACTIVATED]: { id: "account_deactivated" },
  [EAuthErrorCodes.INVALID_PASSWORD]: { id: "invalid_password" },
  [EAuthErrorCodes.PASSWORD_TOO_WEAK]: { id: "password_too_weak" },
  [EAuthErrorCodes.SMTP_NOT_CONFIGURED]: { id: "smtp_not_configured" },
  [EAuthErrorCodes.USER_ALREADY_EXIST]: { id: "user_already_exists", link: "sign_in" },
  [EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_UP]: { id: "authentication_failed" },
  [EAuthErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_UP]: { id: "email_password_required" },
  [EAuthErrorCodes.INVALID_EMAIL_SIGN_UP]: { id: "invalid_email" },
  [EAuthErrorCodes.INVALID_EMAIL_MAGIC_SIGN_UP]: { id: "invalid_email" },
  [EAuthErrorCodes.MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED]: { id: "email_code_required" },
  [EAuthErrorCodes.USER_DOES_NOT_EXIST]: { id: "user_does_not_exist", link: "create_account" },
  [EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_IN]: { id: "authentication_failed" },
  [EAuthErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_IN]: { id: "email_password_required" },
  [EAuthErrorCodes.INVALID_EMAIL_SIGN_IN]: { id: "invalid_email" },
  [EAuthErrorCodes.INVALID_EMAIL_MAGIC_SIGN_IN]: { id: "invalid_email" },
  [EAuthErrorCodes.MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED]: { id: "email_code_required" },
  [EAuthErrorCodes.INVALID_MAGIC_CODE_SIGN_IN]: { id: "invalid_magic_code" },
  [EAuthErrorCodes.INVALID_MAGIC_CODE_SIGN_UP]: { id: "invalid_magic_code" },
  [EAuthErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN]: { id: "expired_magic_code" },
  [EAuthErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP]: { id: "expired_magic_code" },
  [EAuthErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN]: { id: "expired_magic_code" },
  [EAuthErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP]: { id: "expired_magic_code" },
  [EAuthErrorCodes.OAUTH_NOT_CONFIGURED]: { id: "oauth_not_configured" },
  [EAuthErrorCodes.GOOGLE_NOT_CONFIGURED]: { id: "google_not_configured" },
  [EAuthErrorCodes.GITHUB_NOT_CONFIGURED]: { id: "github_not_configured" },
  [EAuthErrorCodes.GITLAB_NOT_CONFIGURED]: { id: "gitlab_not_configured" },
  [EAuthErrorCodes.GOOGLE_OAUTH_PROVIDER_ERROR]: { id: "google_oauth_error" },
  [EAuthErrorCodes.GITHUB_OAUTH_PROVIDER_ERROR]: { id: "github_oauth_error" },
  [EAuthErrorCodes.GITLAB_OAUTH_PROVIDER_ERROR]: { id: "gitlab_oauth_error" },
  [EAuthErrorCodes.INVALID_PASSWORD_TOKEN]: { id: "invalid_password_token" },
  [EAuthErrorCodes.EXPIRED_PASSWORD_TOKEN]: { id: "expired_password_token" },
  [EAuthErrorCodes.INCORRECT_OLD_PASSWORD]: { id: "incorrect_old_password" },
  [EAuthErrorCodes.MISSING_PASSWORD]: { id: "missing_password" },
  [EAuthErrorCodes.INVALID_NEW_PASSWORD]: { id: "invalid_new_password" },
  [EAuthErrorCodes.PASSWORD_ALREADY_SET]: { id: "password_already_set" },
  [EAuthErrorCodes.ADMIN_ALREADY_EXIST]: { id: "admin_already_exists" },
  [EAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME]: { id: "admin_details_required" },
  [EAuthErrorCodes.INVALID_ADMIN_EMAIL]: { id: "invalid_admin_email" },
  [EAuthErrorCodes.INVALID_ADMIN_PASSWORD]: { id: "invalid_admin_password" },
  [EAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD]: { id: "email_password_required" },
  [EAuthErrorCodes.ADMIN_AUTHENTICATION_FAILED]: { id: "admin_authentication_failed" },
  [EAuthErrorCodes.ADMIN_USER_ALREADY_EXIST]: { id: "admin_user_already_exists", link: "admin_sign_in" },
  [EAuthErrorCodes.ADMIN_USER_DOES_NOT_EXIST]: { id: "admin_user_does_not_exist", link: "admin_sign_in" },
  [EAuthErrorCodes.ADMIN_USER_DEACTIVATED]: { id: "admin_user_deactivated" },
  [EAuthErrorCodes.RATE_LIMIT_EXCEEDED]: { id: "rate_limit_exceeded" },
};

/** Looks a PPM dictionary key up in the interface language; undefined for an unknown key. */
export type TAuthTextLookup = (key: string) => string | undefined;

export type TAuthErrorMessage = {
  title: string;
  /** The whole text; with `link` it is `before` + `label` + `after`. */
  message: string;
  link?: { target: TAuthErrorLink; label: string; before: string; after: string };
};

/**
 * Title and text of a sign-in error in the language of `lookup`, or undefined for a code that is not a sign-in
 * error. The caller renders `link` with its own router link.
 */
export const getAuthErrorMessage = (
  errorCode: string | undefined,
  lookup: TAuthTextLookup
): TAuthErrorMessage | undefined => {
  if (!errorCode || !Object.prototype.hasOwnProperty.call(AUTH_ERROR_TEXTS, errorCode)) return undefined;
  const text = AUTH_ERROR_TEXTS[errorCode as EAuthErrorCodes];
  const title = lookup(`auth.error.${text.id}_title`) || lookup("auth.error.default_title") || "";
  const message = lookup(`auth.error.${text.id}_message`) || lookup("auth.error.default_message") || "";
  if (!text.link) return { title, message };
  const label =
    lookup(text.link === "create_account" ? "auth.error.link_create_account" : "auth.error.link_sign_in") || "";
  const [before = "", after = ""] = message.split("{link}");
  return { title, message: `${before}${label}${after}`, link: { target: text.link, label, before, after } };
};

/** Names of the OAuth providers on the sign-in buttons; they stay the same in every language. */
const OAUTH_PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
};

/**
 * Text of an OAuth sign-in button in the language of `lookup` («Войти через Google»), or undefined for a provider
 * without a known name — the caller then keeps the upstream text. The upstream buttons glue an English " with Google"
 * to whatever action text they get.
 */
export const getOAuthButtonText = (
  providerId: string,
  mode: "sign_in" | "sign_up",
  lookup: TAuthTextLookup
): string | undefined => {
  const provider = OAUTH_PROVIDER_NAMES[providerId];
  const template = provider ? lookup(`auth.oauth_${mode}_with`) : undefined;
  return template && provider ? template.replace("{provider}", provider) : undefined;
};

// ---------------- PPM (line L): hints under a password field ----------------

/** Why a correct password may be rejected; shown under the field, never blocks submitting. */
export type TPasswordInputHint = "caps_lock" | "cyrillic" | "edge_whitespace";

const CYRILLIC_LETTER = /[Ѐ-ӿ]/;
const EDGE_WHITESPACE = /^\s|\s$/;

/**
 * Hints for a password field, in display order: Caps Lock is on (browsers report it only with an event, so the
 * caller reads `event.getModifierState("CapsLock")`), Russian letters (the Russian keyboard layout), a space or
 * another blank at either edge (often copied along with the password). An empty field gets only the Caps Lock hint.
 */
export const getPasswordInputHints = (value: string, isCapsLockOn = false): TPasswordInputHint[] => {
  const hints: TPasswordInputHint[] = [];
  if (isCapsLockOn) hints.push("caps_lock");
  if (CYRILLIC_LETTER.test(value)) hints.push("cyrillic");
  if (EDGE_WHITESPACE.test(value)) hints.push("edge_whitespace");
  return hints;
};

// Error handler. PPM: with `lookup` (the interface language) the texts come from the PPM dictionary; without it the
// upstream English above stays.
export const authErrorHandler = (
  errorCode: EAuthErrorCodes,
  email?: string,
  lookup?: TAuthTextLookup
): TAuthErrorInfo | undefined => {
  const bannerAlertErrorCodes = [
    EAuthErrorCodes.INSTANCE_NOT_CONFIGURED,
    EAuthErrorCodes.INVALID_EMAIL,
    EAuthErrorCodes.EMAIL_REQUIRED,
    EAuthErrorCodes.SIGNUP_DISABLED,
    EAuthErrorCodes.INVALID_PASSWORD,
    EAuthErrorCodes.SMTP_NOT_CONFIGURED,
    EAuthErrorCodes.USER_ALREADY_EXIST,
    EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_UP,
    EAuthErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_UP,
    EAuthErrorCodes.INVALID_EMAIL_SIGN_UP,
    EAuthErrorCodes.INVALID_EMAIL_MAGIC_SIGN_UP,
    EAuthErrorCodes.MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED,
    EAuthErrorCodes.USER_DOES_NOT_EXIST,
    EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_IN,
    EAuthErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_IN,
    EAuthErrorCodes.INVALID_EMAIL_SIGN_IN,
    EAuthErrorCodes.INVALID_EMAIL_MAGIC_SIGN_IN,
    EAuthErrorCodes.MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED,
    EAuthErrorCodes.INVALID_MAGIC_CODE_SIGN_IN,
    EAuthErrorCodes.INVALID_MAGIC_CODE_SIGN_UP,
    EAuthErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN,
    EAuthErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP,
    EAuthErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN,
    EAuthErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP,
    EAuthErrorCodes.OAUTH_NOT_CONFIGURED,
    EAuthErrorCodes.GOOGLE_NOT_CONFIGURED,
    EAuthErrorCodes.GITHUB_NOT_CONFIGURED,
    EAuthErrorCodes.GITLAB_NOT_CONFIGURED,
    EAuthErrorCodes.GOOGLE_OAUTH_PROVIDER_ERROR,
    EAuthErrorCodes.GITHUB_OAUTH_PROVIDER_ERROR,
    EAuthErrorCodes.GITLAB_OAUTH_PROVIDER_ERROR,
    EAuthErrorCodes.INVALID_PASSWORD_TOKEN,
    EAuthErrorCodes.EXPIRED_PASSWORD_TOKEN,
    EAuthErrorCodes.INCORRECT_OLD_PASSWORD,
    EAuthErrorCodes.INVALID_NEW_PASSWORD,
    EAuthErrorCodes.PASSWORD_ALREADY_SET,
    EAuthErrorCodes.ADMIN_ALREADY_EXIST,
    EAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME,
    EAuthErrorCodes.INVALID_ADMIN_EMAIL,
    EAuthErrorCodes.INVALID_ADMIN_PASSWORD,
    EAuthErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD,
    EAuthErrorCodes.ADMIN_AUTHENTICATION_FAILED,
    EAuthErrorCodes.ADMIN_USER_ALREADY_EXIST,
    EAuthErrorCodes.ADMIN_USER_DOES_NOT_EXIST,
    EAuthErrorCodes.BOT_USER_LOGIN_FORBIDDEN,
    EAuthErrorCodes.USER_ACCOUNT_DEACTIVATED,
  ];

  if (!bannerAlertErrorCodes.includes(errorCode)) return undefined;

  const translated = lookup ? getAuthErrorMessage(errorCode, lookup) : undefined;
  if (translated)
    return {
      type: EErrorAlertType.BANNER_ALERT,
      code: errorCode,
      title: translated.title,
      message: translated.message,
    };

  return {
    type: EErrorAlertType.BANNER_ALERT,
    code: errorCode,
    title: errorCodeMessages[errorCode]?.title || "Error",
    message: errorCodeMessages[errorCode]?.message(email) || "Something went wrong. Please try again.",
  };
};
