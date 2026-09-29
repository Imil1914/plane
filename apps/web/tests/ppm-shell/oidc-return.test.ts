// G2.2 (R6/R20): after a sign-in that started from the Git server's «Войти через PPM» button, `next_path` looks like
// `/auth/oidc/continue/<id>/` — a backend-only URL with no route in the SPA. Every place that reads `next_path` after
// a sign-in must hand a path like that to a real browser navigation, never `router.push` (`ppm-oidc-return.helper.ts`
// is the one place that decides this and does it). This file unit-tests the helper (allowed/disallowed paths, the
// one-shot guard, and the dev/prod origin prefix) and checks, by source (as `route-wiring.test.ts` does for
// hook-heavy MobX components — there is no jsdom in this project, so a real mounted-effect test is not available),
// that every reading site is wired to it.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPpmOidcReturnPath,
  PPM_OIDC_NEXT_PATH_PREFIX,
  shouldFireOidcRedirectOnce,
} from "@/helpers/ppm-oidc-return.helper";

describe("isPpmOidcReturnPath", () => {
  it("is exactly the OIDC continuation prefix", () => {
    expect(PPM_OIDC_NEXT_PATH_PREFIX).toBe("/auth/oidc/");
  });

  // Round 1 (Important #1): S1's own token shape (`apps/api/plane/ppm_oidc/continuation.py`,
  // `_TOKEN_PATTERN = r"^[A-Za-z0-9_-]{32,64}$"`), at both ends of the length range.
  it.each([
    ["/auth/oidc/continue/11111111-1111-4111-8111-111111111111/", "a 36-char UUID-shaped id (hyphens allowed)"],
    ["/auth/oidc/continue/" + "a".repeat(32) + "/", "the shortest valid id (32 chars)"],
    ["/auth/oidc/continue/" + "a".repeat(64) + "/", "the longest valid id (64 chars)"],
    ["/auth/oidc/continue/" + "A1_-".repeat(8) + "/", "every allowed character class (upper/lower/digit/_/-)"],
  ])("accepts %s (%s)", (path, _why) => {
    expect(isPpmOidcReturnPath(path)).toBe(true);
  });

  // Round 1 (Important #1): a blocklist (`no "//"`, `no "\\"`, `no ".."`) was bypassable — every one of these was a
  // real gap the blocklist missed (none contains a literal "//", "\\" or ".." substring), which is exactly why the
  // rule became an allowlist of one shape instead of an enumeration of unsafe ones.
  it.each([
    [null, "null"],
    [undefined, "undefined"],
    ["", "empty string"],
    [42, "not a string at all"],
    ["/auth/oidc", "missing the trailing slash of the prefix itself"],
    ["/auth/oidc/", "the bare prefix, no continue/<id>/"],
    ["/auth/oidc/authorize/", "a real OIDC endpoint, but not the continuation one"],
    ["/auth/oid/continue/" + "a".repeat(32) + "/", "a near-miss prefix"],
    ["auth/oidc/continue/" + "a".repeat(32) + "/", "not rooted at /"],
    ["/workspace-slug", "an ordinary SPA route"],
    ["/auth/oidc/continue/" + "a".repeat(31) + "/", "one character short of the minimum token length"],
    ["/auth/oidc/continue/" + "a".repeat(65) + "/", "one character over the maximum token length"],
    ["/auth/oidc/continue/" + "a".repeat(32), "missing the trailing slash"],
    ["/auth/oidc/continue//", "an empty token"],
    ["https://evil.example/auth/oidc/continue/" + "a".repeat(32) + "/", "an absolute URL (has a scheme)"],
    ["//evil.example/auth/oidc/continue/" + "a".repeat(32) + "/", "protocol-relative — no prefix match either"],
    ["/auth/oidc/continue/" + "a".repeat(32) + "/?x=1", "a query string appended"],
    ["/auth/oidc/continue/" + "a".repeat(32) + "/#frag", "a fragment appended"],
    ["/auth/oidc/continue/" + "a".repeat(30) + "%252e%252e/", "double-encoded traversal inside the token position"],
    ["/auth/oidc/continue/" + "a".repeat(30) + "%09./", "a tab-encoded sequence inside the token position"],
    ["/auth/oidc/continue/" + "a".repeat(28) + "%2f%2fevil/", "an encoded double slash inside the token position"],
    ["/auth/oidc/continue/" + "a".repeat(30) + "%5cx/", "an encoded backslash inside the token position"],
    ["/auth/oidc/continue/aaaa aaaa aaaa aaaa aaaa aaaa aaaa/", "raw spaces inside the token position"],
    ["/auth/oidc/continue/" + "a".repeat(16) + "\u0000" + "a".repeat(15) + "/", "a raw NUL byte inside the token"],
    ["/auth/oidc/continue/" + "a".repeat(5000) + "/", "a 5000-character token"],
    ["/auth/oidc/continue/" + "a".repeat(32) + "/\\evil.example", "a trailing backslash after a valid-looking token"],
  ])("rejects %s (%s)", (path, _why) => {
    expect(isPpmOidcReturnPath(path)).toBe(false);
  });
});

describe("shouldFireOidcRedirectOnce", () => {
  it("is true exactly once for the same ref object, regardless of how many times it is called again", () => {
    const ref = { current: false };
    expect(shouldFireOidcRedirectOnce(ref)).toBe(true);
    expect(ref.current).toBe(true);
    expect(shouldFireOidcRedirectOnce(ref)).toBe(false);
    expect(shouldFireOidcRedirectOnce(ref)).toBe(false);
  });

  it("tracks independently per ref — a fresh mount (a fresh ref) can fire again", () => {
    const first = { current: false };
    const second = { current: false };
    expect(shouldFireOidcRedirectOnce(first)).toBe(true);
    expect(shouldFireOidcRedirectOnce(second)).toBe(true);
  });

  it("stays false if a ref already carries true from outside (e.g. a prior render committed it)", () => {
    const ref = { current: true };
    expect(shouldFireOidcRedirectOnce(ref)).toBe(false);
  });
});

describe("redirectToPpmOidcNextPath", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // S1's addendum: web and the API can be on different origins in dev (`VITE_API_BASE_URL` set) but share one in
  // production (`packages/constants/src/endpoints.ts`: `API_BASE_URL = process.env.VITE_API_BASE_URL || ""`) — the
  // exact same value every other cross-origin auth redirect in this codebase already prefixes with
  // (`hooks/oauth/core.tsx`), unconditionally, since an empty prefix is a no-op.
  it("navigates to the bare relative path in production (API_BASE_URL empty, same origin)", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    vi.resetModules();
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const fresh = await import("@/helpers/ppm-oidc-return.helper");
    fresh.redirectToPpmOidcNextPath("/auth/oidc/continue/1/");
    expect(assign).toHaveBeenCalledExactlyOnceWith("/auth/oidc/continue/1/");
  });

  it("navigates to the API's own origin in dev (VITE_API_BASE_URL points elsewhere)", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8000");
    vi.resetModules();
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const fresh = await import("@/helpers/ppm-oidc-return.helper");
    fresh.redirectToPpmOidcNextPath("/auth/oidc/continue/1/");
    expect(assign).toHaveBeenCalledExactlyOnceWith("http://localhost:8000/auth/oidc/continue/1/");
  });
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("wiring: every place that reads next_path after a sign-in", () => {
  it("authentication-wrapper.tsx fires the redirect from an effect, guarded to run at most once, ahead of onboarding", () => {
    const source = read("../../core/lib/wrappers/authentication-wrapper.tsx");
    expect(source).toContain(
      'import {\n  isPpmOidcReturnPath,\n  redirectToPpmOidcNextPath,\n  shouldFireOidcRedirectOnce,\n} from "@/helpers/ppm-oidc-return.helper";'
    );
    // The redirect lives in a useEffect (never the render body — round 1's whole point) and is gated by the ref
    // guard, not by a bare boolean check that a second render could sail through.
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*if \(!shouldRedirectForOidc[^}]*shouldFireOidcRedirectOnce\(hasRedirectedForOidcRef\)\) redirectToPpmOidcNextPath\(nextPath\);\s*\}, \[shouldRedirectForOidc, nextPath\]\);/
    );
    expect(source).toContain("const hasRedirectedForOidcRef = useRef(false);");
    // The redirect call itself must be inside that effect, not directly in the NON_AUTHENTICATED branch below.
    const effectStart = source.indexOf("useEffect(() => {\n    if (!shouldRedirectForOidc");
    const nonAuthenticatedStart = source.indexOf("if (pageType === EPageTypes.NON_AUTHENTICATED)");
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectStart).toBeLessThan(nonAuthenticatedStart);
    const nonAuthenticatedBlock = source.slice(
      nonAuthenticatedStart,
      source.indexOf("if (pageType === EPageTypes.ONBOARDING)")
    );
    expect(nonAuthenticatedBlock).not.toContain("redirectToPpmOidcNextPath");
    expect(nonAuthenticatedBlock).toContain("if (shouldRedirectForOidc) return <></>;");
    // Order still matters: the anonymous branch first (so the sign-in form still renders), then this early return,
    // then (only then) the ordinary workspace/onboarding routing.
    const anonymous = nonAuthenticatedBlock.indexOf("if (!currentUser?.id) return");
    const gate = nonAuthenticatedBlock.indexOf("if (shouldRedirectForOidc) return <></>;");
    const onboardingGate = nonAuthenticatedBlock.indexOf("isUserOnboard");
    expect(anonymous).toBeGreaterThan(-1);
    expect(anonymous).toBeLessThan(gate);
    expect(gate).toBeLessThan(onboardingGate);
  });

  it("does not also gate the ordinary (non-OIDC) redirect — that keeps router.push as before", () => {
    const source = read("../../core/lib/wrappers/authentication-wrapper.tsx");
    expect(source).toContain("router.push(currentRedirectRoute);");
    expect(source).toContain('router.push("/onboarding");');
  });

  it("form-root.tsx still reads next_path from the URL and forwards it as a prop (unchanged: no client redirect here)", () => {
    const source = read("../../core/components/account/auth-forms/form-root.tsx");
    expect(source).toContain('const nextPath = searchParams.get("next_path");');
    expect(source).toContain("nextPath={nextPath || undefined}");
    // form-root.tsx does use router.push elsewhere (clearing the email field back to /sign-in — unrelated to
    // next_path); the point here is only that reading next_path itself never feeds a client-side transition.
    expect(source).not.toContain("isPpmOidcReturnPath");
  });

  it("round 1 (#4): clearing the email field keeps next_path instead of dropping it", () => {
    const source = read("../../core/components/account/auth-forms/form-root.tsx");
    const start = source.indexOf("const handleEmailClear = () => {");
    const body = source.slice(start, source.indexOf("};", start));
    expect(body).toContain("nextPath ? `${base}?next_path=${nextPath}` : base");
  });

  it("round 1 (#4): the sign-in/sign-up toggle in the header keeps next_path", () => {
    const source = read("../../core/components/auth-screens/header.tsx");
    expect(source).toContain('const nextPath = useSearchParams().get("next_path");');
    expect(source).toContain(
      "nextPath\n    ? `${authContentMap[type].linkHref}?next_path=${nextPath}`\n    : authContentMap[type].linkHref;"
    );
    expect(source).toContain("href={toggleHref}");
  });

  it.each(["unique-code.tsx", "password.tsx"])(
    '%s still submits next_path through a real <form method="POST"> (already a full navigation — R6 needs no change here)',
    (file) => {
      const source = read(`../../core/components/account/auth-forms/${file}`);
      expect(source).toMatch(/<form[^>]*method="POST"[^>]*action=\{`\$\{API_BASE_URL\}\/auth\//);
      expect(source).toContain('{nextPath && <input type="hidden" value={nextPath} name="next_path" />}');
    }
  );

  it("oauth/core.tsx keeps its own outbound window.location.assign (a different, already-correct concern)", () => {
    const source = read("../../core/hooks/oauth/core.tsx");
    expect(source.match(/window\.location\.assign\(/g)?.length).toBe(4);
    expect(source).not.toContain("isPpmOidcReturnPath");
  });
});
