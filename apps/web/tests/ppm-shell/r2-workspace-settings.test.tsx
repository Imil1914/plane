/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line R2-3 and R2-5: the workspace settings (members, invitations) explain the API's English errors in Russian, and no
// screen outside the sign-in ones sends people to Plane's support address under the PPM brand — «обратитесь к
// администратору PPM» instead, a neutral English sentence in the English interface.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { getPpmTranslation } from "@ppm/brand";
import { WorkspaceSettingsSidebarItemCategories } from "@/components/settings/workspace/sidebar/item-categories";
import { resolvePpmMemberError } from "@/components/workspace/settings/ppm-member-errors";

const i18n = vi.hoisted(() => ({ locale: "ru" }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ currentLocale: i18n.locale, t: (key: string) => key }),
}));
// The workspace settings menu, rendered outside the app: an admin of workspace «ws» on its general settings page.
vi.mock("mobx-react", () => ({ observer: <T,>(component: T) => component }));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useParams: () => ({ workspaceSlug: "ws" }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/ws/settings/" }));
vi.mock("@/hooks/store/user", () => ({ useUserPermissions: () => ({ allowPermissions: () => true }) }));
vi.mock("@/components/settings/sidebar/item", () => ({
  SettingsSidebarItem: ({ href, label }: { href?: string; label: ReactNode }) => <a href={href}>{label}</a>,
}));

afterEach(() => {
  i18n.locale = "ru";
  vi.unstubAllEnvs();
});

const ru = (error: string) => {
  const known = resolvePpmMemberError(error);
  if (!known) return undefined;
  return getPpmTranslation("ru", known.key).replace(/\{(\w+)\}/g, (_match, name: string) => known.values?.[name] ?? "");
};

describe("member and invitation errors of the API in the Russian PPM interface (line R2-3)", () => {
  it("explains the known messages", () => {
    expect(ru("You cannot remove a user having role higher than you")).toBe(
      "Нельзя удалить участника с ролью выше вашей."
    );
    expect(ru("Some users are already member of workspace")).toBe(
      "Некоторые из приглашённых уже состоят в пространстве."
    );
    expect(ru("Invalid email - bad@@example provided a valid email address is required to send the invite")).toBe(
      "Неверный адрес почты: bad@@example. Исправьте его и отправьте приглашение ещё раз."
    );
    expect(ru("You cannot remove yourself from the workspace. Please use leave workspace")).toBe(
      "Себя удалить нельзя — выберите «Покинуть пространство»."
    );
    expect(
      ru(
        "You are a part of some projects where you are the only admin, you should either leave the project or promote another user to admin."
      )
    ).toMatch(/^Вы — единственный администратор/);
  });

  it("leaves an unknown message to the caller (shown as the server wrote it)", () => {
    expect(resolvePpmMemberError("Something odd happened")).toBeUndefined();
    expect(resolvePpmMemberError(undefined)).toBeUndefined();
  });
});

describe("no Plane support address outside the sign-in screens under the PPM brand (line R2-5)", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("the maintenance message asks the PPM administrator in the interface language", async () => {
    const { MaintenanceMessage } = await import("@/components/instance/maintenance-message");
    const russian = renderToStaticMarkup(<MaintenanceMessage />);
    expect(russian).not.toMatch(/support@|mailto:/);
    expect(russian).toContain("Если вы не администратор, обратитесь к администратору PPM.");
    i18n.locale = "en";
    const english = renderToStaticMarkup(<MaintenanceMessage />);
    expect(english).not.toMatch(/support@|mailto:|Plane/);
    expect(english).toContain("contact your PPM administrator");
  });

  it("the maintenance message keeps the upstream text and address without the PPM brand", async () => {
    vi.stubEnv("PPM_BRAND_ENABLED", "0");
    vi.resetModules();
    try {
      const { MaintenanceMessage } = await import("@/components/instance/maintenance-message");
      const upstream = renderToStaticMarkup(<MaintenanceMessage />);
      expect(upstream).toContain("mailto:support@plane.so");
      expect(upstream).toContain("Looks like Plane didn&#x27;t start up correctly!");
    } finally {
      vi.resetModules();
    }
  });

  // Where the address stays (only the upstream branch of the brand flag) is checked on the AST by R2_CASES of
  // english-leftovers.test.ts; here — that the PPM branch shows the administrator text.
  it("the product updates footer offers the PPM administrator instead of the support mailbox under the brand", () => {
    const footer = source("../../core/components/global/product-updates/footer.tsx");
    expect(footer).toMatch(/IS_PPM_BRAND_ENABLED \? \(/);
    expect(footer).toContain('getPpmTranslation(currentLocale, "ui.support.contact_admin")');
  });

  it("the web and space error pages show the PPM state under the brand", () => {
    const web = source("../../app/error/prod.tsx");
    expect(web).toMatch(/if \(IS_PPM_BRAND_ENABLED\) \{/);
    expect(web).toContain('getPpmTranslation(currentLocale, "ui.support.error_contact")');
    const space = source("../../../space/app/error.tsx");
    expect(space).toMatch(/if \(IS_PPM_BRAND_ENABLED\)/);
    expect(space).toContain('t("ui.support.space_error_description")');
  });

  it("the PPM texts name the administrator and no address", () => {
    for (const key of [
      "ui.support.contact_admin",
      "ui.support.maintenance_contact",
      "ui.support.error_contact",
      "ui.support.space_error_description",
    ] as const) {
      expect(getPpmTranslation("ru", key), key).toMatch(/администратор\p{L}* PPM/u);
      expect(getPpmTranslation("en", key), key).toMatch(/PPM administrator/);
      for (const locale of ["ru", "en"]) expect(getPpmTranslation(locale, key)).not.toMatch(/@|Plane|support/i);
    }
  });
});

describe("«Оплата и тарифы» is not in the workspace settings menu of the PPM shell (round 1 ruling)", () => {
  const menuHrefs = () =>
    [...renderToStaticMarkup(<WorkspaceSettingsSidebarItemCategories />).matchAll(/href="([^"]+)"/g)].map(
      (match) => match[1]
    );

  it("hides the billing item under the PPM shell (self-hosted, no payments) and keeps the other items", () => {
    const hrefs = menuHrefs();
    expect(hrefs.filter((href) => href.includes("settings/billing"))).toEqual([]);
    for (const page of ["settings/members", "settings/exports", "settings/webhooks"])
      expect(
        hrefs.some((href) => href.includes(page)),
        page
      ).toBe(true);
  });

  it("keeps the upstream menu with PPM_SHELL_ENABLED=0; the page stays reachable by its address", () => {
    vi.stubEnv("PPM_SHELL_ENABLED", "0");
    expect(menuHrefs().some((href) => href.includes("settings/billing"))).toBe(true);
    const routes = readFileSync(new URL("../../app/routes/core.ts", import.meta.url), "utf8");
    expect(routes).toContain('":workspaceSlug/settings/billing"');
  });
});
