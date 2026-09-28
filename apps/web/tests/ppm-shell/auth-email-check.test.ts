/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { EAuthModes, EAuthSteps } from "@plane/constants";
import { getPpmTranslation } from "@ppm/brand";
import { resolveEmailCheckOutcome } from "@/components/account/auth-forms/email-check-outcome";

const response = (existing: boolean, status: "MAGIC_CODE" | "CREDENTIAL" = "CREDENTIAL") => ({
  existing,
  status,
  is_password_autoset: false,
});

describe("sign-in e-mail check", () => {
  it("asks an existing account for its password on the sign-in page", () => {
    expect(resolveEmailCheckOutcome(response(true), EAuthModes.SIGN_IN)).toEqual({
      kind: "proceed",
      mode: EAuthModes.SIGN_IN,
      step: EAuthSteps.PASSWORD,
    });
  });

  it("sends an existing account without a password to the e-mail code", () => {
    expect(resolveEmailCheckOutcome(response(true, "MAGIC_CODE"), EAuthModes.SIGN_IN)).toEqual({
      kind: "proceed",
      mode: EAuthModes.SIGN_IN,
      step: EAuthSteps.UNIQUE_CODE,
    });
  });

  it("switches the sign-up page to sign-in for an e-mail that already has an account", () => {
    expect(resolveEmailCheckOutcome(response(true), EAuthModes.SIGN_UP)).toEqual({
      kind: "proceed",
      mode: EAuthModes.SIGN_IN,
      step: EAuthSteps.PASSWORD,
    });
  });

  it("does not turn the sign-in page into account creation for an unknown e-mail", () => {
    expect(resolveEmailCheckOutcome(response(false), EAuthModes.SIGN_IN)).toEqual({
      kind: "not_found",
      step: EAuthSteps.PASSWORD,
    });
    expect(resolveEmailCheckOutcome(response(false, "MAGIC_CODE"), EAuthModes.SIGN_IN)).toEqual({
      kind: "not_found",
      step: EAuthSteps.UNIQUE_CODE,
    });
  });

  it("keeps account creation on the sign-up page for a new e-mail", () => {
    expect(resolveEmailCheckOutcome(response(false), EAuthModes.SIGN_UP)).toEqual({
      kind: "proceed",
      mode: EAuthModes.SIGN_UP,
      step: EAuthSteps.PASSWORD,
    });
  });

  it("explains a missing account in Russian and English", () => {
    const keys = [
      "auth.account_not_found",
      "auth.account_not_found_hint_open",
      "auth.account_not_found_hint_closed",
      "auth.create_account_with_email",
      "auth.have_invitation_create",
    ] as const;
    for (const key of keys) {
      expect(getPpmTranslation("ru", key)).not.toBe(key);
      expect(getPpmTranslation("en", key)).not.toBe(key);
    }
    expect(getPpmTranslation("ru", "auth.account_not_found")).toBe("Аккаунт с такой почтой не найден.");
    expect(getPpmTranslation("ru", "auth.account_not_found_hint_closed")).toContain("по приглашению администратора");
  });
});
