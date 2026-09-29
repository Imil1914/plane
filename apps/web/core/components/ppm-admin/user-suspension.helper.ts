/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// G2.2 R15a: what the admin center's «Пользователи» tab shows for a person and which of «Отключить» / «Включить» it
// offers. Pure functions of the API row (the API decides who may be switched off — never oneself, a PPM global
// administrator, an instance administrator or a service account), so they are testable without rendering.
import type { TPpmTranslationKey } from "@ppm/brand";
import type { TPpmConfirmOptions } from "@/components/ppm-shell/use-ppm-confirm";
import type { TPpmAdminUser } from "@/services/ppm-admin.service";

export type TPpmAdminUserStatus = "active" | "suspended" | "deactivated";
export type TPpmAdminUserAction = "suspend" | "resume";

export const USER_STATUS_LABEL_KEYS: Record<TPpmAdminUserStatus, TPpmTranslationKey> = {
  active: "admin.active_user",
  suspended: "g22.users.status_suspended",
  deactivated: "g22.users.status_deactivated",
};

/** Switched off by an administrator, or inactive on their own (Plane's «Деактивировать аккаунт»), or active. */
export function getUserStatus(user: Pick<TPpmAdminUser, "is_active" | "is_suspended">): TPpmAdminUserStatus {
  if (user.is_active) return "active";
  return user.is_suspended ? "suspended" : "deactivated";
}

/** The one action the row offers, by the API's own flags — none for protected people or self-deactivated ones. */
export function getUserAction(user: Pick<TPpmAdminUser, "can_suspend" | "can_resume">): TPpmAdminUserAction | null {
  if (user.can_resume) return "resume";
  if (user.can_suspend) return "suspend";
  return null;
}

export function getUserName(user: Pick<TPpmAdminUser, "display_name" | "email">): string {
  return user.display_name || user.email || "—";
}

/**
 * The confirmation asked before the action: «Отключить <имя>? Он не сможет войти в PPM и на Git-сервер…». The Git
 * server is named only while single sign-on is on there (`gitServerSso`) — otherwise switching off does not reach it.
 * The name goes in through a replacer function, so a `$&` or `$1` in someone's name stays literal.
 */
export function getUserActionConfirm(
  action: TPpmAdminUserAction,
  name: string,
  translate: (key: TPpmTranslationKey) => string,
  gitServerSso: boolean
): TPpmConfirmOptions {
  if (action === "suspend") {
    return {
      title: translate("g22.users.confirm_suspend_title").replace("{name}", () => name),
      content: translate(
        gitServerSso ? "g22.users.confirm_suspend_description_git" : "g22.users.confirm_suspend_description"
      ),
      confirmLabel: translate("g22.users.suspend"),
      variant: "danger",
    };
  }
  return {
    title: translate("g22.users.confirm_resume_title").replace("{name}", () => name),
    content: translate(
      gitServerSso ? "g22.users.confirm_resume_description_git" : "g22.users.confirm_resume_description"
    ),
    confirmLabel: translate("g22.users.resume"),
    variant: "primary",
  };
}
