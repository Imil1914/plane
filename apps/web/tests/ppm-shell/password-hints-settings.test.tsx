/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line L round 4: the password hints (Caps Lock, Russian letters, a space at an edge) and the Russian strength meter
// where a password is set outside the sign-in screens — onboarding («Задайте пароль») and «Профиль → Безопасность»
// (current, new and repeated password). The hints never block the buttons.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PasswordFieldHints } from "@/components/account/auth-forms/password-field-hints";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SECURITY = read("../../core/components/settings/profile/content/pages/security.tsx");
const ONBOARDING = read("../../core/components/onboarding/steps/profile/set-password.tsx");

describe("«Профиль → Безопасность»: hints under the current, new and repeated password", () => {
  const FIELDS: Array<[string, string, string]> = [
    ["current", "currentPasswordHints", "current-password-hints"],
    ["new", "newPasswordHints", "new-password-hints"],
    ["repeated", "confirmPasswordHints", "confirm-password-hints"],
  ];

  it.each(FIELDS)("the %s password field is wired to its hints", (_field, hints, id) => {
    expect(SECURITY).toContain(`const ${hints} = usePasswordFieldHints("${id}", IS_PPM_SHELL_ENABLED);`);
    expect(SECURITY).toContain(`{...${hints}.inputProps}`);
    expect(SECURITY).toMatch(
      new RegExp(`onBlur=\\{(?:${hints}\\.resetCapsLock|\\(\\) => \\{[^}]*${hints}\\.resetCapsLock\\(\\);\\s*\\})\\}`)
    );
    expect(SECURITY).toMatch(
      new RegExp(
        `IS_PPM_SHELL_ENABLED && \\(\\s*<PasswordFieldHints\\s+id="${id}"[\\s\\S]*?isCapsLockOn=\\{${hints}\\.isCapsLockOn\\}`
      )
    );
  });

  it("shows the Russian strength meter under the PPM shell, the upstream one otherwise", () => {
    expect(SECURITY).toMatch(/IS_PPM_SHELL_ENABLED \? \(\s*<PpmPasswordStrengthIndicator\b/);
    expect(SECURITY).toMatch(
      /<PasswordStrengthIndicator password=\{password\} isFocused=\{isPasswordInputFocused\} \/>/
    );
  });

  it("keeps the save button independent of the hints", () => {
    const disabled = SECURITY.slice(
      SECURITY.indexOf("const isButtonDisabled ="),
      SECURITY.indexOf(";", SECURITY.indexOf("const isButtonDisabled ="))
    );
    expect(disabled).not.toMatch(/Hints|getPasswordInputHints/);
  });
});

describe("onboarding «Задайте пароль»: hints under the password and its repetition", () => {
  const FIELDS: Array<[string, string, string]> = [
    ["password", "passwordHints", "onboarding-password-hints"],
    ["repetition", "confirmPasswordHints", "onboarding-confirm-password-hints"],
  ];

  it.each(FIELDS)("the %s field is wired to its hints", (_field, hints, id) => {
    expect(ONBOARDING).toContain(`const ${hints} = usePasswordFieldHints("${id}", isPpmShell);`);
    expect(ONBOARDING).toMatch(
      new RegExp(
        `inputProps=\\{\\s*isPpmShell\\s*\\?\\s*\\{\\s*\\.\\.\\.${hints}\\.inputProps,\\s*onBlur:\\s*${hints}\\.resetCapsLock\\s*\\}\\s*:\\s*undefined\\s*\\}`
      )
    );
    expect(ONBOARDING).toMatch(
      new RegExp(
        `isPpmShell && \\(\\s*<PasswordFieldHints\\s+id="${id}"[\\s\\S]*?isCapsLockOn=\\{${hints}\\.isCapsLockOn\\}`
      )
    );
  });

  it("shows the Russian strength meter under the PPM shell and keeps the translated labels", () => {
    expect(ONBOARDING).toMatch(
      /isPpmShell \? \(\s*<PpmPasswordStrengthIndicator password=\{passwordState\.password\} \/>/
    );
    for (const key of ["onboarding.password_set", "onboarding.password_confirm", "onboarding.password_mismatch"])
      expect(ONBOARDING).toContain(`ppmT("${key}")`);
  });

  it("keeps the password check independent of the hints", () => {
    const valid = ONBOARDING.slice(
      ONBOARDING.indexOf("const isPasswordValid"),
      ONBOARDING.indexOf("}, [passwordState]);")
    );
    expect(valid).not.toMatch(/Hints|getPasswordInputHints/);
  });
});

describe("@plane/ui PasswordInput passes the hints' props to its input", () => {
  type TPasswordInput = FunctionComponent<{
    id: string;
    value: string;
    onChange: (value: string) => void;
    inputProps?: Record<string, unknown>;
  }>;

  it("renders aria-describedby and keeps its own controlled attributes", async () => {
    const module = (await import(
      /* @vite-ignore */ fileURLToPath(
        new URL("../../../../packages/ui/src/form-fields/password/password-input.tsx", import.meta.url)
      )
    )) as { PasswordInput: TPasswordInput };
    const html = renderToStaticMarkup(
      createElement(module.PasswordInput, {
        id: "password",
        value: "secret",
        onChange: () => undefined,
        inputProps: { "aria-describedby": "onboarding-password-hints", onKeyDown: () => undefined },
      })
    );
    const input = html.match(/<input [^>]*>/)?.[0] ?? "";
    expect(input).toContain('id="password"');
    expect(input).toContain('type="password"');
    expect(input).toContain('value="secret"');
    expect(input).toContain('aria-describedby="onboarding-password-hints"');
  });
});

describe("the hints region can take the spacing of a flex layout", () => {
  it("merges a class for the gap, and stays a live region while empty", () => {
    const html = renderToStaticMarkup(
      createElement(PasswordFieldHints as FunctionComponent<Record<string, unknown>>, {
        id: "new-password-hints",
        value: "",
        isCapsLockOn: false,
        className: "mt-2 empty:mt-0",
      })
    );
    const classes = html.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
    expect(html).toContain('aria-live="polite"');
    expect(classes).toEqual(expect.arrayContaining(["empty:mb-0", "mt-2", "empty:mt-0"]));
  });
});
