/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Line L, round 2 (controller ruling: option A): the /god-mode (apps/admin) and space (apps/space) sign-in screens speak
// the interface language like the web ones — error banners, labels, the password hints — and no text sends people to
// Plane's support. admin and space have no test runner of their own; their helpers are plain modules, tested here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EAdminAuthErrorCodes } from "@plane/constants";
import { LANGUAGE_STORAGE_KEY } from "@plane/i18n";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children?: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// admin and space modules are loaded at run time: web's tsconfig only type-checks files of apps/web (TS6307), and
// both apps type-check these modules themselves (`tsc` in apps/admin and apps/space).
type TErrorInfo = { code: string; title: string; message: ReactNode } | undefined;
type TResolveLanguage = (storedLanguage: string | null, shellEnabled?: boolean) => string;
const load = (path: string) =>
  import(/* @vite-ignore */ fileURLToPath(new URL(path, import.meta.url))) as Promise<Record<string, unknown>>;

const adminHelpers = await load("../../../admin/app/(all)/(home)/auth-helpers.tsx");
const adminLanguage = await load("../../../admin/app/(all)/(home)/ppm-auth-language.ts");
const spaceHelpers = await load("../../../space/helpers/authentication.helper.tsx");
const spaceLanguage = await load("../../../space/helpers/ppm-auth-language.ts");

const adminAuthErrorHandler = adminHelpers.authErrorHandler as (code: string, language?: string) => TErrorInfo;
const spaceAuthErrorHandler = spaceHelpers.authErrorHandler as (
  code: string,
  email?: string,
  language?: string
) => TErrorInfo;
const ESpaceAuthErrorCodes = spaceHelpers.EAuthenticationErrorCodes as Record<string, string>;
const resolveAdminLanguage = adminLanguage.resolveAuthLanguage as TResolveLanguage;
const resolveSpaceLanguage = spaceLanguage.resolveAuthLanguage as TResolveLanguage;

const EMAIL = "person@example.com";
const ADMIN_CODES = Object.values(EAdminAuthErrorCodes);
const SPACE_CODES = Object.values(ESpaceAuthErrorCodes);

type TProps = { children?: ReactNode; to?: string };
/** Text of an element tree without rendering it (space links need a router to render). */
const treeText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child: ReactNode) => treeText(child)).join("");
  if (!isValidElement(node)) return "";
  return treeText((node as ReactElement<TProps>).props.children);
};
const linkTargets = (node: ReactNode): string[] => {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => linkTargets(child));
  if (!isValidElement(node)) return [];
  const { to, children } = (node as ReactElement<TProps>).props;
  return [...(typeof to === "string" ? [to] : []), ...linkTargets(children)];
};
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

// Names that stay Latin in a Russian sentence: the product, OAuth providers, the person's own address.
const LATIN_ALLOWED = [EMAIL, "PPM", "Google", "GitHub", "GitLab"];
const latinWords = (value: string) =>
  LATIN_ALLOWED.reduce((rest, allowed) => rest.replaceAll(allowed, ""), value).match(/[A-Za-z]+/g) ?? [];

describe("/god-mode sign-in errors", () => {
  it("has Russian and English for every admin error code, never mixed", () => {
    expect(ADMIN_CODES).toHaveLength(9);
    for (const code of ADMIN_CODES) {
      const ru = adminAuthErrorHandler(code, "ru");
      const en = adminAuthErrorHandler(code, "en");
      expect(ru?.title, code).toBeTruthy();
      expect(en?.title, code).toBeTruthy();
      const ruText = treeText(ru?.message);
      const enText = treeText(en?.message);
      expect(ruText, code).not.toBe("");
      expect(latinWords(`${ru?.title} ${ruText}`), `${code} ru`).toEqual([]);
      expect(`${en?.title} ${enText}`, `${code} en`).not.toMatch(/[А-Яа-яЁё]/);
      expect(`${ruText} ${enText}`, code).not.toMatch(/@|plane\.so/i);
    }
  });

  it("says the owner's wrong-password case in Russian and keeps the sign-in link on this page", () => {
    expect(treeText(adminAuthErrorHandler(EAdminAuthErrorCodes.ADMIN_AUTHENTICATION_FAILED, "ru")?.message)).toBe(
      "Не удалось войти. Проверьте почту и пароль и попробуйте ещё раз."
    );
    const missing = html(adminAuthErrorHandler(EAdminAuthErrorCodes.ADMIN_USER_DOES_NOT_EXIST, "ru")?.message);
    expect(missing).toContain('href="/"');
    expect(missing).toContain(">Войдите</a>");
    expect(treeText(adminAuthErrorHandler(EAdminAuthErrorCodes.ADMIN_USER_DEACTIVATED, "ru")?.message)).toBe(
      "Ваш аккаунт отключён. Обратитесь к администратору PPM."
    );
  });

  it("ignores codes that are not admin sign-in errors", () => {
    expect(adminAuthErrorHandler("5065", "ru")).toBeUndefined();
  });
});

describe("space sign-in errors", () => {
  it("has Russian and English for every space error code, never mixed", () => {
    expect(SPACE_CODES).toHaveLength(47);
    // Upstream space shows no banner for MISSING_PASSWORD (it is not on its banner list); unchanged.
    expect(spaceAuthErrorHandler(ESpaceAuthErrorCodes.MISSING_PASSWORD, EMAIL, "ru")).toBeUndefined();
    for (const code of SPACE_CODES.filter((value) => value !== ESpaceAuthErrorCodes.MISSING_PASSWORD)) {
      const ru = spaceAuthErrorHandler(code, EMAIL, "ru");
      const en = spaceAuthErrorHandler(code, EMAIL, "en");
      expect(ru?.code, code).toBe(code);
      const ruText = treeText(ru?.message);
      const enText = treeText(en?.message);
      expect(ruText, code).not.toBe("");
      expect(latinWords(`${ru?.title} ${ruText}`), `${code} ru`).toEqual([]);
      expect(`${en?.title} ${enText}`, `${code} en`).not.toMatch(/[А-Яа-яЁё]/);
      expect(`${ruText} ${enText}`, code).not.toMatch(/@|plane\.so/i);
    }
  });

  it("keeps the react-router links with the e-mail address", () => {
    const exists = spaceAuthErrorHandler(ESpaceAuthErrorCodes.USER_ALREADY_EXIST, EMAIL, "ru")?.message;
    expect(linkTargets(exists)).toEqual([`/sign-in?email=${encodeURIComponent(EMAIL)}`]);
    expect(treeText(exists)).toBe("Аккаунт с этой почтой уже зарегистрирован. Войдите.");
    const missing = spaceAuthErrorHandler(ESpaceAuthErrorCodes.USER_DOES_NOT_EXIST, EMAIL, "en")?.message;
    expect(linkTargets(missing)).toEqual([`/?email=${encodeURIComponent(EMAIL)}`]);
    expect(treeText(missing)).toBe("No account found. Create one to get started.");
  });
});

describe("language of the /god-mode and space sign-in screens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("follows the language stored by the web app, Russian by default", () => {
    for (const resolve of [resolveAdminLanguage, resolveSpaceLanguage]) {
      expect(resolve(null, true)).toBe("ru");
      expect(resolve("en", true)).toBe("en");
      expect(resolve("ru", true)).toBe("ru");
    }
  });

  it("reads the same storage key as @plane/i18n (space imports it; /god-mode has no i18n and keeps a copy)", () => {
    expect(LANGUAGE_STORAGE_KEY).toBe("userLanguage");
    expect(adminLanguage.LANGUAGE_STORAGE_KEY).toBe(LANGUAGE_STORAGE_KEY);
  });

  // The build passes PPM_SHELL_ENABLED / PPM_BRAND_ENABLED into process.env (vite.config.ts `define`); a module reads it
  // once, as below after a fresh import.
  it.each([
    ["PPM_SHELL_ENABLED", "0"],
    ["PPM_BRAND_ENABLED", "0"],
  ])("with %s=%s in the build, /god-mode and space show the upstream English", async (flag, value) => {
    vi.stubEnv(flag, value);
    vi.resetModules();
    const admin = await load("../../../admin/app/(all)/(home)/ppm-auth-language.ts");
    const adminErrors = await load("../../../admin/app/(all)/(home)/auth-helpers.tsx");
    const space = await load("../../../space/helpers/ppm-auth-language.ts");
    const spaceErrors = await load("../../../space/helpers/authentication.helper.tsx");
    expect(admin.IS_PPM_SHELL_ENABLED).toBe(false);
    expect(space.IS_PPM_SHELL_ENABLED).toBe(false);
    expect((admin.getAuthLanguage as () => string)()).toBe("en");
    expect((space.getAuthLanguage as () => string)()).toBe("en");
    const adminBanner = (adminErrors.authErrorHandler as (code: string) => TErrorInfo)("5175");
    const spaceBanner = (spaceErrors.authErrorHandler as (code: string) => TErrorInfo)("5065");
    expect(treeText(adminBanner?.message)).toBe("Authentication failed. Please try again.");
    expect(treeText(spaceBanner?.message)).toBe("Authentication failed. Please try again.");
    expect(treeText((spaceErrors.authErrorHandler as (code: string) => TErrorInfo)("5019")?.message)).toBe(
      "User account deactivated. Please contact your administrator."
    );
  });
});

// Static checks of the screens (their components use app-local aliases and are not rendered here). An upstream
// literal may stay only in the fallback of the PPM gate: a ternary `IS_PPM_SHELL_ENABLED ? t(…) : "<upstream>"` — on
// one line, or wrapped by oxfmt over the next lines (the gate and the `t(` branch then come within a few lines above
// the literal) — or after an early `if (IS_PPM_SHELL_ENABLED) return …` / `if (!IS_PPM_SHELL_ENABLED) return …`.
const ADMIN_HOME = new URL("../../../admin/app/(all)/(home)/", import.meta.url);
const SPACE_FORMS = new URL("../../../space/components/account/", import.meta.url);

const isInTernaryFallback = (lines: string[], index: number) => {
  if (/IS_PPM_SHELL_ENABLED\s*\?[^:]*:/.test(lines[index])) return true;
  for (let above = index - 1; above >= Math.max(0, index - 8); above -= 1) {
    if (/IS_PPM_SHELL_ENABLED\s*(\?|$)/.test(lines[above]))
      return lines.slice(above, index).some((line) => /\bt\(/.test(line));
  }
  return false;
};

const bareLiterals = (source: string, literal: string) => {
  const lines = source.split("\n");
  return lines.filter((line, index) => line.includes(literal) && !isInTernaryFallback(lines, index));
};

const afterEarlyReturnGate = (source: string, upstreamUse: string) => {
  const gate = source.search(/if \(!?IS_PPM_SHELL_ENABLED\)/);
  return gate >= 0 && source.indexOf(upstreamUse) > gate;
};

const SCREEN_CASES: Array<[URL, string]> = [
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Manage your Plane instance"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Configure instance-wide settings to secure your instance"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Email"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Password"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"name@company.com"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Enter your password"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Show password"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Hide password"'],
  [new URL("sign-in-form.tsx", ADMIN_HOME), '"Sign in"'],
  [new URL("auth-banner.tsx", ADMIN_HOME), '"Dismiss banner"'],
  [new URL("auth-forms/email.tsx", SPACE_FORMS), '"Email"'],
  [new URL("auth-forms/email.tsx", SPACE_FORMS), '"Email is invalid"'],
  [new URL("auth-forms/email.tsx", SPACE_FORMS), '"Clear email"'],
  [new URL("auth-forms/email.tsx", SPACE_FORMS), '"Continue"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Email"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Password"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Set a password"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Enter password"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Confirm password"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), "Passwords don't match"],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Continue"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Go to workspace"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Sign in with unique code"'],
  [new URL("auth-forms/password.tsx", SPACE_FORMS), '"Create account"'],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), '"Email"'],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), '"Unique code"'],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), '"Paste the code sent to your email"'],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), "`Resend in ${resendTimerCode}s`"],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), '"Requesting new code"'],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), '"Resend"'],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), '"Sending code"'],
  [new URL("auth-forms/unique-code.tsx", SPACE_FORMS), '"Continue"'],
];

const EARLY_RETURN_CASES: Array<[URL, string, string]> = [
  [new URL("page.tsx", ADMIN_HOME), '"Admin – Instance Setup & Sign-In"', '"auth.admin_page_title"'],
  [new URL("auth-forms/auth-header.tsx", SPACE_FORMS), "return Titles[mode]", '"auth.space_sign_in_title"'],
  [
    new URL("auth-forms/auth-header.tsx", SPACE_FORMS),
    '"Comment or react to work items"',
    '"auth.space_default_title"',
  ],
  [new URL("terms-and-conditions.tsx", SPACE_FORMS), '"By signing in"', '"auth.terms_sign_in"'],
];

describe("no English leftovers on the /god-mode and space sign-in screens", () => {
  it.each(SCREEN_CASES)("%s keeps %s only as the upstream fallback", (file, literal) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain(literal);
    expect(bareLiterals(source, literal)).toEqual([]);
  });

  it.each(EARLY_RETURN_CASES)("%s reaches the upstream %s only past the PPM gate", (file, upstreamUse, key) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain(key);
    expect(source).toContain(upstreamUse);
    expect(afterEarlyReturnGate(source, upstreamUse)).toBe(true);
  });

  it("puts the password hints under the /god-mode and space password fields", () => {
    for (const file of [new URL("sign-in-form.tsx", ADMIN_HOME), new URL("auth-forms/password.tsx", SPACE_FORMS)]) {
      const source = readFileSync(file, "utf8");
      expect(source, file.pathname).toMatch(/IS_PPM_SHELL_ENABLED && \(\s*<PasswordFieldHints\b/);
      expect(source, file.pathname).toMatch(/\{\.\.\.passwordHints\.inputProps\}/);
    }
    const space = readFileSync(new URL("auth-forms/password.tsx", SPACE_FORMS), "utf8");
    expect(space).toMatch(/IS_PPM_SHELL_ENABLED \? \(\s*<PpmPasswordStrengthIndicator\b/);
  });

  it("passes the interface language to every space error banner", () => {
    const source = readFileSync(new URL("auth-forms/auth-root.tsx", SPACE_FORMS), "utf8");
    const calls = [...source.matchAll(/\bauthErrorHandler\(/g)].map((match) =>
      source.slice(match.index, source.indexOf(";", match.index)).replaceAll(/\s+/g, " ")
    );
    expect(calls).toHaveLength(5);
    for (const call of calls) expect(call).toMatch(/, language\)$/);
  });

  it("translates the OAuth buttons of web and space under the PPM shell", () => {
    for (const file of [
      new URL("../../core/components/account/auth-forms/auth-root.tsx", import.meta.url),
      new URL("auth-forms/auth-root.tsx", SPACE_FORMS),
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file.pathname).toMatch(
        /const oAuthOptions = IS_PPM_SHELL_ENABLED\s*\?\s*upstreamOAuthOptions\.map/
      );
      expect(source, file.pathname).toContain("getOAuthButtonText(option.id");
    }
  });

  it("the web sign-in footer is in the interface language (no Russian literal in the English interface)", () => {
    const source = readFileSync(new URL("../../core/components/auth-screens/footer.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/[А-Яа-яЁё]/);
    expect(source).toContain('ppmT("auth.footer_tagline")');
  });

  it("no sign-in screen or helper names Plane's support address", () => {
    const files = [
      new URL("../../helpers/authentication.helper.tsx", import.meta.url),
      new URL("auth-helpers.tsx", ADMIN_HOME),
      new URL("sign-in-form.tsx", ADMIN_HOME),
      new URL("../../../space/helpers/authentication.helper.tsx", import.meta.url),
    ];
    for (const file of files) expect(readFileSync(file, "utf8"), file.pathname).not.toMatch(/SUPPORT_EMAIL|support@/);
  });
});

describe("the /god-mode and space builds see the PPM dictionary", () => {
  it("declares @ppm/brand in both apps and in their lockfile importers (turbo prune follows declared deps)", () => {
    for (const app of ["admin", "space"]) {
      const manifest = JSON.parse(readFileSync(new URL(`../../../${app}/package.json`, import.meta.url), "utf8"));
      expect(manifest.dependencies["@ppm/brand"], app).toBe("workspace:*");
    }
    const lockfile = readFileSync(new URL("../../../../pnpm-lock.yaml", import.meta.url), "utf8");
    for (const app of ["admin", "space"]) {
      const importer = lockfile.slice(
        lockfile.indexOf(`\n  apps/${app}:\n`),
        lockfile.indexOf("\n  apps/", lockfile.indexOf(`\n  apps/${app}:\n`) + 1)
      );
      expect(importer, app).toMatch(
        /'@ppm\/brand':\n {8}specifier: workspace:\*\n {8}version: link:\.\.\/\.\.\/packages\/ppm-brand\n/
      );
    }
  });
});

describe("the rollback flags reach the /god-mode and space builds", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it.each(["admin", "space"])("%s: vite.config.ts defines both flags, the Dockerfile takes them", (app) => {
    const vite = read(`../../../${app}/vite.config.ts`);
    const dockerfile = read(`../../../${app}/Dockerfile.${app}`);
    for (const flag of ["PPM_BRAND_ENABLED", "PPM_SHELL_ENABLED"]) {
      expect(vite).toContain(`viteEnv.${flag} = process.env.${flag} ?? "1";`);
      expect(dockerfile).toContain(`ARG ${flag}="1"\nENV ${flag}=$${flag}`);
    }
  });

  it("ppm-build.sh passes both flags to the admin and space images", () => {
    const script = read("../../../../deployments/ppm/ppm-build.sh");
    for (const app of ["admin", "space"]) {
      const start = script.indexOf(`    ${app}) build ${app} `);
      const block = script.slice(start, script.indexOf(";;", start));
      expect(block, app).toContain('--build-arg "PPM_BRAND_ENABLED=${PPM_BRAND_ENABLED:-1}"');
      expect(block, app).toContain('--build-arg "PPM_SHELL_ENABLED=${PPM_SHELL_ENABLED:-1}"');
    }
  });
});

describe("space pages under the PPM brand", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("replaces «Powered by Plane Publish» with the PPM mark leading to «О программе → открытый код»", () => {
    const source = read("../../../space/components/common/powered-by.tsx");
    const ppmBranch = source.slice(source.indexOf("if (IS_PPM_BRAND_ENABLED)"), source.indexOf("if (!WEBSITE_URL)"));
    expect(ppmBranch).toContain("`${WEB_BASE_URL}/about/open-source`");
    expect(ppmBranch).toContain("src={ppmMark}");
    expect(ppmBranch).toContain('t("about.title")');
    expect(ppmBranch).not.toMatch(/Plane/);
    expect(source.indexOf("Plane Publish</span>")).toBeGreaterThan(source.indexOf("if (!WEBSITE_URL)"));
  });

  it("titles the tab with PPM, as the web app does", () => {
    const source = read("../../../space/app/root.tsx");
    expect(source).toMatch(/IS_PPM_BRAND_ENABLED\s*\?\s*\[\s*\{ title: PPM_BRAND\.title \}/);
    expect(source).toMatch(/: UPSTREAM_META;/);
  });

  it("says «или» between the OAuth buttons and the e-mail form in the interface language (web and space)", () => {
    const options = read("../../../../packages/ui/src/oauth/oauth-options.tsx");
    expect(options).toContain('dividerText = "or"');
    expect(options).toMatch(/\{dividerText\}/);
    expect(read("../../core/components/account/auth-forms/auth-root.tsx")).toContain(
      'dividerText={IS_PPM_SHELL_ENABLED ? ppmT("auth.or") : undefined}'
    );
    expect(read("../../../space/components/account/auth-forms/auth-root.tsx")).toContain(
      'dividerText={IS_PPM_SHELL_ENABLED ? t("auth.or") : undefined}'
    );
  });
});
