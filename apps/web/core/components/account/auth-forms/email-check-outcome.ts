/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EAuthModes, EAuthSteps } from "@plane/constants";
import type { IEmailCheckResponse } from "@plane/types";

export type TEmailCheckOutcome =
  | { kind: "proceed"; mode: EAuthModes; step: EAuthSteps | undefined }
  // Sign-in page, unknown e-mail: say so instead of silently switching to account creation — the person usually
  // mistyped the address or is on another PPM instance. `step` is the one to use if they choose to create an account.
  | { kind: "not_found"; step: EAuthSteps | undefined };

const stepFor = (status: IEmailCheckResponse["status"]) => {
  if (status === "MAGIC_CODE") return EAuthSteps.UNIQUE_CODE;
  if (status === "CREDENTIAL") return EAuthSteps.PASSWORD;
  return undefined;
};

export function resolveEmailCheckOutcome(
  response: Pick<IEmailCheckResponse, "existing" | "status">,
  currentAuthMode: EAuthModes
): TEmailCheckOutcome {
  const step = stepFor(response.status);
  if (response.existing) return { kind: "proceed", mode: EAuthModes.SIGN_IN, step };
  if (currentAuthMode === EAuthModes.SIGN_IN) return { kind: "not_found", step };
  return { kind: "proceed", mode: EAuthModes.SIGN_UP, step };
}
