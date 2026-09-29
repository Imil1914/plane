/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import type { TPpmTranslationKey } from "@ppm/brand";
import { formatPpmTemplate } from "@/components/ppm-tasks/format";
import { usePpmRu } from "@/hooks/use-ppm-text";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";

// Known API messages of the workspace member flows (apps/api plane/app/views/workspace/{invite,member}.py) → a PPM key
// with the Russian explanation; a capture group fills `{email}`.
const KNOWN_MEMBER_ERRORS: ReadonlyArray<[RegExp, TPpmTranslationKey]> = [
  [/^Emails are required/i, "ui.ws.error.emails_required"],
  [/global administrator access cannot be granted by invitation/i, "ui.ws.error.global_admin_invite"],
  [/cannot invite a user with higher role/i, "ui.ws.error.higher_role_invite"],
  [/already member of workspace/i, "ui.ws.error.already_members"],
  [/^Invalid email - (.+?) provided a valid email address/i, "ui.ws.error.invalid_email"],
  [/cannot assign a role higher than your own/i, "ui.ws.error.higher_role_assign"],
  [/workspace member not found/i, "ui.ws.error.member_not_found"],
  [/cannot update your own role/i, "ui.ws.error.own_role"],
  [/global administrator role cannot be changed/i, "ui.ws.error.global_admin_role"],
  [/global administrator access belongs only to the workspace owner/i, "ui.ws.error.global_admin_owner"],
  [/cannot remove yourself from the workspace/i, "ui.ws.error.remove_self"],
  [/global administrator cannot be removed from the workspace/i, "ui.ws.error.remove_global_admin"],
  [/cannot remove a user having role higher than you/i, "ui.ws.error.remove_higher_role"],
  [/user is a part of some projects where they are the only admin/i, "ui.ws.error.only_admin_member"],
  [/you are a part of some projects where you are the only admin/i, "ui.ws.error.only_admin_self"],
  [/global administrator owns this workspace and cannot leave it/i, "ui.ws.error.global_admin_leave"],
];

/** PPM key (and `{email}`) for a known member/invitation error of the API; undefined — show the server text as is. */
export function resolvePpmMemberError(
  text: string | undefined
): { key: TPpmTranslationKey; values?: Record<string, string> } | undefined {
  if (!text) return undefined;
  for (const [pattern, key] of KNOWN_MEMBER_ERRORS) {
    const match = pattern.exec(text);
    if (match) return match[1] ? { key, values: { email: match[1] } } : { key };
  }
  return undefined;
}

/**
 * Line R2-3: the message of a failed member flow — a known API text explained in the Russian PPM interface; otherwise
 * (and in any other language) `upstream`: the server text as is, or the flow's own message.
 */
export function usePpmMemberErrorMessage(): (serverText: string | undefined, upstream: string) => string {
  const isPpmRu = usePpmRu();
  const ppmT = usePpmTranslation();

  return useCallback(
    (serverText: string | undefined, upstream: string) => {
      if (!isPpmRu) return upstream;
      const known = resolvePpmMemberError(serverText);
      return known ? formatPpmTemplate(ppmT(known.key), known.values ?? {}) : upstream;
    },
    [isPpmRu, ppmT]
  );
}
