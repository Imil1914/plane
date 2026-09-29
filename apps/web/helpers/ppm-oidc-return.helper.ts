/**
 * Copyright (c) 2026 PPM contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { API_BASE_URL } from "@plane/constants";

// G2.2 (R6/R20): after a sign-in that started from the Git server's «Войти через PPM» button, the anonymous
// `/auth/oidc/authorize/` endpoint (S1) sends the browser to PPM's sign-in page with
// `next_path=/auth/oidc/continue/<id>/` — a backend-only URL with no route in the SPA's client router. Every place
// that reads `next_path` after a sign-in must therefore hand it to a REAL browser navigation
// (`window.location.assign`), never to `router.push` (a client-side transition that would 404 inside the SPA
// instead of reaching Django). This module is the one place that decides "is this such a path" and "how do we get
// there" — every reading site (the authorization wrapper, the sign-in/sign-up/code forms) calls it instead of
// repeating the check.

/** The only prefix this rule ever fires for — the OIDC continuation endpoints under `/auth/oidc/` (S1). */
export const PPM_OIDC_NEXT_PATH_PREFIX = "/auth/oidc/";

/**
 * Review round 1 (Important #1): a blocklist (`no "//"`, `no "\\"`, `no ".."`) is bypassable — a double-encoded
 * `%252e%252e`, a tab hidden as `%09`, an encoded `%2f%2f`/`%5c`, a raw space or NUL, an appended `?query`, or simply
 * a 5000-character string all slip through a blocklist unchanged (none of those literal substrings appear), yet
 * `window.location.assign` still navigates the browser there. There is exactly one legitimate shape for this
 * path — S1's own continuation URL, `CONTINUE_PATH = "/auth/oidc/continue/{}/"` with `_TOKEN_PATTERN =
 * r"^[A-Za-z0-9_-]{32,64}$"` (`apps/api/plane/ppm_oidc/continuation.py`) — so this now accepts an allowlist of
 * exactly that shape instead of trying to enumerate everything unsafe. Anything else (including every case above)
 * falls through to the caller's previous behaviour (`router.push`, i.e. unchanged for every path that is not this
 * one specific, freshly-minted, single-use continuation link).
 */
const PPM_OIDC_CONTINUE_PATH = /^\/auth\/oidc\/continue\/[A-Za-z0-9_-]{32,64}\/$/;

export function isPpmOidcReturnPath(nextPath: unknown): nextPath is string {
  return typeof nextPath === "string" && PPM_OIDC_CONTINUE_PATH.test(nextPath);
}

/**
 * A full browser navigation — never `router.push` — to a path already checked by `isPpmOidcReturnPath`. Review
 * round 1 (S1's note): `/auth/oidc/continue/…/` is a Django route, not a web-app one — in production web and the API
 * share one origin (Caddy proxies `/auth/*` to the API, `ppm-facts.md` §7) so a bare relative path already lands in
 * the right place, but a local dev setup can run them on different ports. `API_BASE_URL` is exactly the value that
 * already answers this for every other cross-origin auth redirect in this codebase (`hooks/oauth/core.tsx`:
 * `${API_BASE_URL}/auth/google/…`) — it is `""` (same origin, so this is a no-op prefix) unless
 * `VITE_API_BASE_URL` points the web build at a different origin, so the same unconditional prefixing is correct
 * here too, without needing an explicit `window.location.origin` comparison.
 */
export function redirectToPpmOidcNextPath(nextPath: string): void {
  window.location.assign(`${API_BASE_URL}${nextPath}`);
}

/**
 * Review round 1 (Important #3): `continue/<id>/` is single-use (S1) — a render-body `window.location.assign` risked
 * firing twice (StrictMode's dev double-render, or a further MobX/SWR-driven re-render before the browser actually
 * leaves this page) and burning the id before the person ever sees the result. `AuthenticationWrapper` calls this
 * from a `useEffect`, passing its own `useRef({ current: false })` — a plain mutable object with exactly a ref's
 * shape, so the guard itself is testable without mounting anything. True the first time for a given ref; false ever
 * after, regardless of how many times the effect re-runs.
 */
export function shouldFireOidcRedirectOnce(hasFiredRef: { current: boolean }): boolean {
  if (hasFiredRef.current) return false;
  hasFiredRef.current = true;
  return true;
}
