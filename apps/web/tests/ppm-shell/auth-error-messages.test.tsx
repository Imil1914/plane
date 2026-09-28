/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line L (owner request 2026-09-28): sign-in errors speak the interface language — Russian by default in PPM, English
// when the person chose English, never a mix — and keep their links and the support address. The owner saw
// «Authentication failed. Please try again.» after a password typed in the Russian layout.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EAuthErrorCodes } from "@plane/constants";
import {
  AUTH_ERROR_TEXTS,
  authErrorHandler as utilsAuthErrorHandler,
  getAuthErrorMessage,
  getOAuthButtonText,
} from "@plane/utils";
import { PPM_TRANSLATIONS } from "@ppm/brand";
import { authErrorHandler, EAuthenticationErrorCodes, getResetLinkErrorText } from "@/helpers/authentication.helper";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children?: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const EMAIL = "person@example.com";
const WEB_CODES = Object.values(EAuthenticationErrorCodes);
const ALL_CODES = Object.values(EAuthErrorCodes);

const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const textOf = (node: ReactNode) =>
  html(node)
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

// Names that stay Latin in a Russian sentence: providers, the product, the person's own address.
const LATIN_ALLOWED = [EMAIL, "Google", "GitHub", "GitLab", "PPM"];
const latinLeftovers = (value: string) =>
  LATIN_ALLOWED.reduce((rest, allowed) => rest.replaceAll(allowed, ""), value).match(/[A-Za-z]+/g) ?? [];

const dictionary = (locale: "en" | "ru") => PPM_TRANSLATIONS[locale] as Record<string, string>;
const translator = (locale: "en" | "ru") => (key: string) => dictionary(locale)[key];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("sign-in errors in the interface language", () => {
  it("covers every one of the 52 sign-in error codes", () => {
    expect(WEB_CODES).toHaveLength(52);
    expect(new Set(WEB_CODES)).toEqual(new Set(ALL_CODES));
    for (const code of WEB_CODES) {
      for (const locale of ["ru", "en"]) {
        const info = authErrorHandler(code, EMAIL, locale);
        expect(info, `${code} ${locale}`).toBeDefined();
        expect(info?.code).toBe(code);
        expect(info?.title.trim(), `${code} ${locale} title`).not.toBe("");
        expect(textOf(info?.message).trim(), `${code} ${locale} message`).not.toBe("");
      }
    }
  });

  it("shows the owner's wrong-password error in Russian, and in English for an English interface", () => {
    expect(
      textOf(authErrorHandler(EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN, undefined, "ru")?.message)
    ).toBe("Не удалось войти. Проверьте пароль и попробуйте ещё раз.");
    expect(
      textOf(authErrorHandler(EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN, undefined, "en")?.message)
    ).toBe("Authentication failed. Please try again.");
  });

  it("never mixes languages: a Russian interface gets no English words, an English one no Russian", () => {
    for (const code of WEB_CODES) {
      const ru = authErrorHandler(code, EMAIL, "ru");
      const en = authErrorHandler(code, EMAIL, "en");
      expect(latinLeftovers(`${ru?.title} ${textOf(ru?.message)}`), `${code} ru`).toEqual([]);
      expect(`${en?.title} ${textOf(en?.message)}`, `${code} en`).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it("keeps the links, with the e-mail address carried into them", () => {
    const exists = html(authErrorHandler(EAuthenticationErrorCodes.USER_ALREADY_EXIST, EMAIL, "ru")?.message);
    expect(exists).toContain(`href="/sign-in?email=${encodeURIComponent(EMAIL)}"`);
    expect(exists).toContain(">Войдите</a>");
    expect(html(authErrorHandler(EAuthenticationErrorCodes.USER_ALREADY_EXIST, EMAIL, "en")?.message)).toContain(
      ">Sign In</a>"
    );

    const missing = html(authErrorHandler(EAuthenticationErrorCodes.USER_DOES_NOT_EXIST, EMAIL, "ru")?.message);
    expect(missing).toContain(`href="/?email=${encodeURIComponent(EMAIL)}"`);
    expect(missing).toContain(">Создайте аккаунт</a>");

    for (const code of [
      EAuthenticationErrorCodes.ADMIN_USER_ALREADY_EXIST,
      EAuthenticationErrorCodes.ADMIN_USER_DOES_NOT_EXIST,
    ]) {
      expect(html(authErrorHandler(code, undefined, "ru")?.message)).toContain('href="/admin"');
    }
    // Without an address the link still works, just without the pre-filled e-mail.
    expect(html(authErrorHandler(EAuthenticationErrorCodes.USER_ALREADY_EXIST, undefined, "ru")?.message)).toContain(
      'href="/sign-in"'
    );
  });

  it("sends a deactivated account to the administrator, never to Plane's support address", () => {
    expect(textOf(authErrorHandler(EAuthenticationErrorCodes.USER_ACCOUNT_DEACTIVATED, undefined, "ru")?.message)).toBe(
      "Аккаунт отключён. Обратитесь к администратору PPM."
    );
    expect(textOf(authErrorHandler(EAuthenticationErrorCodes.USER_ACCOUNT_DEACTIVATED, undefined, "en")?.message)).toBe(
      "User account deactivated. Please contact your administrator."
    );
    for (const code of WEB_CODES)
      for (const locale of ["ru", "en"]) {
        const text = textOf(authErrorHandler(code, undefined, locale)?.message);
        expect(text, `${code} ${locale}`).not.toMatch(/@|plane\.so/i);
      }
  });

  it("names no product in English: with the PPM brand rolled back these are the upstream screens' texts", () => {
    for (const code of WEB_CODES) {
      const en = authErrorHandler(code, EMAIL, "en");
      expect(`${en?.title} ${textOf(en?.message)}`, code).not.toMatch(/\bPPM\b|Plane/);
    }
  });

  it("asks only to check the address when a reset link is requested for an unknown e-mail", () => {
    expect(getResetLinkErrorText(EAuthenticationErrorCodes.USER_DOES_NOT_EXIST, "ru")).toBe(
      "Аккаунт с такой почтой не найден. Проверьте адрес."
    );
    expect(getResetLinkErrorText(EAuthenticationErrorCodes.USER_DOES_NOT_EXIST, "en")).toBe(
      "No account with this e-mail. Check the address."
    );
    expect(getResetLinkErrorText(EAuthenticationErrorCodes.SMTP_NOT_CONFIGURED, "ru")).toBe(
      "Отправка писем не настроена. Обратитесь к администратору."
    );
    expect(getResetLinkErrorText(undefined, "ru")).toBeUndefined();
  });

  it("returns nothing for a code that is not a sign-in error", () => {
    expect(authErrorHandler("1234" as EAuthenticationErrorCodes, undefined, "ru")).toBeUndefined();
  });

  it("without an explicit language follows the page language, Russian by default in PPM", () => {
    expect(textOf(authErrorHandler(EAuthenticationErrorCodes.INVALID_EMAIL)?.message)).toMatch(/[А-Яа-я]/);
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    expect(textOf(authErrorHandler(EAuthenticationErrorCodes.INVALID_EMAIL)?.message)).toBe(
      "Invalid email. Please try again."
    );
  });

  it("keeps the upstream English when the PPM shell is rolled back, whatever the interface language", async () => {
    vi.stubEnv("PPM_SHELL_ENABLED", "0");
    vi.resetModules();
    const helper = await import("@/helpers/authentication.helper");
    expect(
      textOf(
        helper.authErrorHandler(helper.EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN, undefined, "ru")
          ?.message
      )
    ).toBe("Authentication failed. Please try again.");
  });
});

describe("sign-in error texts live in the PPM dictionary", () => {
  it("maps every code to a title and a text present in both languages", () => {
    for (const code of ALL_CODES) {
      const spec = AUTH_ERROR_TEXTS[code];
      expect(spec, code).toBeDefined();
      for (const locale of ["en", "ru"] as const) {
        const message = getAuthErrorMessage(code, (key) => {
          const value = dictionary(locale)[key];
          expect(value, `${code}: ${key} missing in ${locale}`).toBeTruthy();
          return value;
        });
        expect(message?.title, `${code} ${locale}`).toBeTruthy();
        expect(message?.message, `${code} ${locale}`).toBeTruthy();
        if (spec.link) expect(message?.link?.label, `${code} ${locale} link`).toBeTruthy();
      }
    }
  });

  it("has the same sign-in error keys in English and Russian", () => {
    const keys = (locale: "en" | "ru") =>
      Object.keys(dictionary(locale)).filter((key) => key.startsWith("auth.error."));
    expect(new Set(keys("ru"))).toEqual(new Set(keys("en")));
    expect(keys("en").length).toBeGreaterThan(0);
  });

  it("gives the shared helper in @plane/utils the same language as the translator it is handed", () => {
    expect(getAuthErrorMessage("5065", translator("ru"))?.message).toBe(
      "Не удалось войти. Проверьте пароль и попробуйте ещё раз."
    );
    expect(
      utilsAuthErrorHandler(EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_IN, undefined, translator("ru"))?.message
    ).toBe("Не удалось войти. Проверьте пароль и попробуйте ещё раз.");
    expect(utilsAuthErrorHandler(EAuthErrorCodes.USER_ALREADY_EXIST, undefined, translator("ru"))?.message).toBe(
      "Аккаунт с этой почтой уже зарегистрирован. Войдите."
    );
    // No translator: the upstream English of @plane/utils is unchanged.
    expect(utilsAuthErrorHandler(EAuthErrorCodes.AUTHENTICATION_FAILED_SIGN_IN)?.message).toBe(
      "Authentication failed. Please try again."
    );
  });

  it("names OAuth buttons in the interface language, keeping the provider name", () => {
    expect(getOAuthButtonText("google", "sign_in", translator("ru"))).toBe("Войти через Google");
    expect(getOAuthButtonText("gitea", "sign_up", translator("ru"))).toBe("Зарегистрироваться через Gitea");
    expect(getOAuthButtonText("github", "sign_up", translator("en"))).toBe("Sign up with GitHub");
    expect(getOAuthButtonText("gitlab", "sign_in", translator("en"))).toBe("Sign in with GitLab");
    // An unknown provider keeps its upstream text (the caller falls back).
    expect(getOAuthButtonText("okta", "sign_in", translator("ru"))).toBeUndefined();
  });

  it("splits a linked text around its link in both languages", () => {
    const ru = getAuthErrorMessage("5060", translator("ru"));
    expect(ru?.link).toEqual({
      target: "create_account",
      label: "Создайте аккаунт",
      before: "Аккаунт с такой почтой не найден. ",
      after: ", чтобы начать работу.",
    });
    expect(getAuthErrorMessage("5060", translator("en"))?.message).toBe("No account found. Create one to get started.");
  });
});
