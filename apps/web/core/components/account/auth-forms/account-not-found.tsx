/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CircleAlert } from "lucide-react";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

type TAuthAccountNotFound = {
  // The instance allows free sign-up; otherwise accounts come from an administrator's invitation.
  signUpOpen: boolean;
  onCreateAccount: () => void;
};

export function AuthAccountNotFound(props: TAuthAccountNotFound) {
  const { signUpOpen, onCreateAccount } = props;
  const ppmT = usePpmTranslation();

  return (
    <div role="status" className="mt-4 flex gap-2 rounded-md border border-subtle bg-surface-1 p-3">
      <CircleAlert className="mt-0.5 size-4 flex-shrink-0 text-tertiary" aria-hidden="true" />
      <div className="space-y-1.5 text-13">
        <p className="font-medium text-primary">{ppmT("auth.account_not_found")}</p>
        <p className="text-secondary">
          {ppmT(signUpOpen ? "auth.account_not_found_hint_open" : "auth.account_not_found_hint_closed")}
        </p>
        <button
          type="button"
          onClick={onCreateAccount}
          className="text-13 font-medium text-accent-primary underline-offset-2 hover:underline"
        >
          {ppmT(signUpOpen ? "auth.create_account_with_email" : "auth.have_invitation_create")}
        </button>
      </div>
    </div>
  );
}
