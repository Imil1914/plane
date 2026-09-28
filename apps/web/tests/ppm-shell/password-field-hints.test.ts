/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line L (owner request 2026-09-28): the password field warns about Caps Lock, the Russian keyboard layout and a space
// copied at an edge — the likely reasons a correct password from a file was rejected. Hints never block submitting.
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPasswordInputHints } from "@plane/utils";
import { getPpmTranslation } from "@ppm/brand";
import type { TPpmTranslationKey } from "@ppm/brand";
import { PASSWORD_HINT_TEXT_KEYS, PasswordFieldHints } from "@/components/account/auth-forms/password-field-hints";
import { getPpmPasswordStrength } from "@/components/account/auth-forms/password-strength";

describe("password field hints", () => {
  it("says nothing about an empty field unless Caps Lock is on", () => {
    expect(getPasswordInputHints("")).toEqual([]);
    expect(getPasswordInputHints("", true)).toEqual(["caps_lock"]);
  });

  it("reports Caps Lock only from the keyboard state, not from capital letters", () => {
    expect(getPasswordInputHints("SECRET-1")).toEqual([]);
    expect(getPasswordInputHints("Secret-1", true)).toEqual(["caps_lock"]);
  });

  it("spots Russian letters, including ё and capitals, anywhere in the password", () => {
    expect(getPasswordInputHints("пароль")).toEqual(["cyrillic"]);
    expect(getPasswordInputHints("Ёлка-2024")).toEqual(["cyrillic"]);
    expect(getPasswordInputHints("Secretй1!")).toEqual(["cyrillic"]);
    expect(getPasswordInputHints("Secret-1!@#")).toEqual([]);
  });

  it("warns about a space or a tab at either edge, but not inside", () => {
    for (const value of [" secret", "secret ", "\tsecret", "secret\n", "secret ", " "]) {
      expect(getPasswordInputHints(value), JSON.stringify(value)).toEqual(["edge_whitespace"]);
    }
    expect(getPasswordInputHints("sec ret")).toEqual([]);
  });

  it("lists every applicable hint in a stable order", () => {
    expect(getPasswordInputHints(" пароль", true)).toEqual(["caps_lock", "cyrillic", "edge_whitespace"]);
  });

  it("uses the owner's wording in Russian and has English for an English interface", () => {
    expect(getPpmTranslation("ru", PASSWORD_HINT_TEXT_KEYS.caps_lock)).toBe("Включён Caps Lock");
    expect(getPpmTranslation("ru", PASSWORD_HINT_TEXT_KEYS.cyrillic)).toBe(
      "В пароле есть русские буквы — похоже, включена русская раскладка"
    );
    expect(getPpmTranslation("ru", PASSWORD_HINT_TEXT_KEYS.edge_whitespace)).toBe(
      "В начале или в конце пароля пробел — возможно, он скопировался случайно"
    );
    for (const key of Object.values(PASSWORD_HINT_TEXT_KEYS)) {
      expect(getPpmTranslation("en", key)).toMatch(/^[\x20-\x7E—]+$/);
    }
  });
});

describe("password strength under the PPM shell", () => {
  const ru = (key: Parameters<typeof getPpmTranslation>[1]) => getPpmTranslation("ru", key);

  it("names the strength and the rules in Russian", () => {
    const short = getPpmPasswordStrength("abc", ru);
    expect(short.message).toBe("Пароль слишком короткий");
    expect(short.criteria.map((criterion) => criterion.label)).toEqual([
      "Не меньше 8 символов",
      "Заглавная латинская буква",
      "Строчная латинская буква",
      "Цифра",
      "Спецсимвол, например ! или #",
    ]);
    expect(short.criteria.map((criterion) => criterion.isValid)).toEqual([false, false, true, false, false]);
    expect(getPpmPasswordStrength("abcdefgh", ru).message).toBe("Пароль ненадёжный");
    expect(getPpmPasswordStrength("Abcdefg1!", ru).message).toBe("Пароль надёжный");
  });

  it("keeps the upstream English words for an English interface", () => {
    const en = getPpmPasswordStrength("abc", (key) => getPpmTranslation("en", key));
    expect(en.message).toBe("Password is too short");
    expect(en.criteria[0]?.label).toBe("Min 8 characters");
  });
});

// Line L round 3 (review): the hints are an aria-live region. Screen readers often skip a live region that appears in
// the page together with its first text, so the region must be in the page — and not display:none — while empty.
type THintsProps = { id: string; value: string; isCapsLockOn: boolean; t?: (key: TPpmTranslationKey) => string };
const loadHints = async (path: string) =>
  ((await import(/* @vite-ignore */ fileURLToPath(new URL(path, import.meta.url)))) as Record<string, unknown>)
    .PasswordFieldHints as FunctionComponent<THintsProps>;

describe("password hints stay a live region while empty", async () => {
  const ru = (key: TPpmTranslationKey) => getPpmTranslation("ru", key);
  const components: Array<[string, FunctionComponent<THintsProps>]> = [
    ["web", PasswordFieldHints as FunctionComponent<THintsProps>],
    ["admin", await loadHints("../../../admin/app/(all)/(home)/password-field-hints.tsx")],
    ["space", await loadHints("../../../space/components/account/auth-forms/password-field-hints.tsx")],
  ];

  it.each(components)("%s renders the empty region, visible to assistive technology", (_app, Hints) => {
    const html = renderToStaticMarkup(createElement(Hints, { id: "hints", value: "", isCapsLockOn: false, t: ru }));
    expect(html).toMatch(/^<div id="hints" aria-live="polite" class="([^"]*)"><\/div>$/);
    const classes = html.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
    expect(classes).not.toContain("hidden");
    expect(classes).not.toContain("empty:hidden");
    expect(classes).toContain("empty:mb-0");
  });

  it.each(components)("%s puts the hint text inside that same region", (app, Hints) => {
    const html = renderToStaticMarkup(
      createElement(Hints, { id: "hints", value: "пароль", isCapsLockOn: true, t: ru })
    );
    expect(html).toMatch(/^<div id="hints" aria-live="polite"[^>]*><p /);
    expect(html.match(/<p /g)).toHaveLength(2);
    // web translates with the interface language of i18n itself; admin and space are handed the translator.
    if (app !== "web") expect(html).toContain("Включён Caps Lock");
  });
});
