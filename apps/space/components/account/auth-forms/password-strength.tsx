/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CircleCheck } from "lucide-react";
// plane imports
import { E_PASSWORD_STRENGTH } from "@plane/constants";
import { getFragmentColor, getStrengthInfo } from "@plane/ui";
import { cn, getPasswordCriteria, getPasswordStrength } from "@plane/utils";
import type { TPpmTranslationKey } from "@ppm/brand";

const STRENGTH_TEXT_KEYS: Record<E_PASSWORD_STRENGTH, TPpmTranslationKey> = {
  [E_PASSWORD_STRENGTH.EMPTY]: "auth.password_strength_empty",
  [E_PASSWORD_STRENGTH.LENGTH_NOT_VALID]: "auth.password_strength_short",
  [E_PASSWORD_STRENGTH.STRENGTH_NOT_VALID]: "auth.password_strength_weak",
  [E_PASSWORD_STRENGTH.STRENGTH_VALID]: "auth.password_strength_strong",
};

const RULE_TEXT_KEYS: Record<string, TPpmTranslationKey> = {
  length: "auth.password_rule_length",
  uppercase: "auth.password_rule_uppercase",
  lowercase: "auth.password_rule_lowercase",
  number: "auth.password_rule_number",
  special: "auth.password_rule_special",
};

type TPpmPasswordStrengthIndicator = {
  password: string;
  isFocused?: boolean;
  t: (key: TPpmTranslationKey) => string;
};

/**
 * PPM line L: `PasswordStrengthIndicator` of @plane/ui with the words from the PPM dictionary (same markup, rules,
 * colours and visibility; the upstream meter has English literals). Twin of the web one
 * (apps/web core/components/account/auth-forms/password-strength.tsx).
 */
export function PpmPasswordStrengthIndicator(props: TPpmPasswordStrengthIndicator) {
  const { password, isFocused = false, t } = props;
  const strength = getPasswordStrength(password);
  const { textColor, activeFragments } = getStrengthInfo(strength);

  if (!isFocused && strength === E_PASSWORD_STRENGTH.STRENGTH_VALID) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex w-full gap-1 transition-all duration-300 ease-linear">
          {[0, 1, 2].map((fragmentIndex) => (
            <div
              key={fragmentIndex}
              className={cn(
                "h-1 flex-1 rounded-xs transition-all duration-300 ease-in-out",
                getFragmentColor(fragmentIndex, activeFragments)
              )}
            />
          ))}
        </div>
        {password && <p className={cn("!text-13 font-medium", textColor)}>{t(STRENGTH_TEXT_KEYS[strength])}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {getPasswordCriteria(password).map((criterion) => (
          <div key={criterion.key} className="flex items-center gap-1.5">
            <div className="flex items-center justify-center p-0.5">
              <CircleCheck
                className={cn("h-3 w-3 flex-shrink-0", {
                  "text-success-primary": criterion.isValid,
                  "text-primary": !criterion.isValid,
                })}
              />
            </div>
            <span
              className={cn("!text-11", {
                "text-success-primary": criterion.isValid,
                "text-primary": !criterion.isValid,
              })}
            >
              {RULE_TEXT_KEYS[criterion.key] ? t(RULE_TEXT_KEYS[criterion.key]) : criterion.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
