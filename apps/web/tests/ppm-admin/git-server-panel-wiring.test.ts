// G2.2 (R18): the admin center's «Git-сервер» tab — checked by source, as route-wiring.test.ts does for the sibling
// «Код» page: both `admin-center.tsx` and `git-server-panel.tsx` hold MobX/SWR hooks throughout, so calling them
// directly (the `element-tree.ts` trick the ppm-git tests use for hook-free views) is not an option here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const adminCenter = read("../../core/components/ppm-admin/admin-center.tsx");
const panel = read("../../core/components/ppm-admin/git-server-panel.tsx");

describe("admin center registers the «Git-сервер» tab", () => {
  it("is reachable only past the existing global-administrator gate (no separate permission check needed)", () => {
    const gate = adminCenter.indexOf("if (!access?.is_global_admin)");
    const tabsList = adminCenter.indexOf("const tabs:");
    const panelRender = adminCenter.indexOf('{tab === "git" && <GitServerPanel />}');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(tabsList);
    expect(tabsList).toBeLessThan(panelRender);
  });

  it("lists it with the Git-server icon and the g22 translation key, alongside the other tabs", () => {
    expect(adminCenter).toContain('type TAdminTab = "projects" | "users" | "audit" | "git";');
    expect(adminCenter).toMatch(/\{ id: "git", label: ppmT\("g22\.admin\.git_tab"\), icon: Server \}/);
  });

  it("imports the panel from its own file, not inlined into admin-center.tsx", () => {
    expect(adminCenter).toContain('import { GitServerPanel } from "./git-server-panel";');
  });

  // Round 1 (#6): admin-center.tsx used to define LoadingState/EmptyState itself and git-server-panel.tsx imported
  // them back from "./admin-center" — together with admin-center.tsx importing GitServerPanel, a circular import.
  // Both now come from a third, shared file neither owns.
  it("does not create a circular import: shared states live in their own file, not in admin-center.tsx", () => {
    expect(adminCenter).toContain('import { EmptyState, ErrorState, LoadingState } from "./shared-states";');
    expect(adminCenter).not.toMatch(/function (LoadingState|EmptyState|ErrorState)\(/);
    expect(panel).toContain('import { EmptyState, LoadingState } from "./shared-states";');
    expect(panel).not.toContain("./admin-center");
  });
});

describe("GitServerPanel", () => {
  it("uses the admin service's Git-server endpoints, not the «Код» page's service", () => {
    expect(panel).toContain("adminService.getGitServerStatus()");
    expect(panel).toContain("adminService.syncGitServerNow()");
    expect(panel).not.toContain("PpmGitService");
  });

  it("shows a Forgejo-admin link only when the API sent a valid one (through safeGitWebUrl), opens it in a new tab", () => {
    expect(panel).toContain("const forgejoAdminUrl = safeGitWebUrl(data.forgejo_admin_url);");
    expect(panel).toMatch(/\{forgejoAdminUrl && \(\s*<a[^>]*href=\{forgejoAdminUrl\}/);
    const anchor = panel.slice(panel.indexOf("href={forgejoAdminUrl}"), panel.indexOf("</a>"));
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noreferrer"');
  });

  it("formats a 429 on «Синхронизировать сейчас» as «через N с», falling back when no retry-after is known", () => {
    expect(panel).toContain("reason instanceof PpmAdminServiceError ? reason.retryAfterSeconds : undefined");
    expect(panel).toContain('ppmT("g22.admin.git_sync_retry_after").replace("{seconds}", String(retryAfter))');
    expect(panel).toContain('ppmT("g22.admin.git_sync_error")');
  });

  it("round 1 (#2): renders the fixed GIT_SERVER_COUNT_FIELDS list, not an open Object.entries of whatever counts sent", () => {
    expect(panel).toContain("GIT_SERVER_COUNT_FIELDS.map(({ key, labelKey }) =>");
    expect(panel).not.toContain("Object.entries(data.last_full_sync.counts)");
    expect(panel).not.toContain("humanizeCountKey");
  });

  it("round 2 (live-stack E): a count renders through formatCount, so null reads as «—», never a fabricated 0", () => {
    expect(panel).toContain("{formatCount(data.last_full_sync?.counts[key])}");
    expect(panel).not.toContain("data.last_full_sync?.counts[key] ?? 0");
  });

  it("round 1 (#6): a problem row shows the translated kind and drops a raw UUID subject", () => {
    const start = panel.indexOf("function ProblemRow(");
    const body = panel.slice(start, panel.indexOf("\n}\n", start));
    expect(body).toContain("getProblemKindLabelKey(problem.kind)");
    expect(body).toContain("isUuidLike(problem.subject)");
    expect(body).not.toMatch(/\{problem\.kind\}/);
  });

  it("never imports or renders a secret-shaped field (status/sync carry none per contract)", () => {
    // Field/property access, not the English word "secret" in prose (the file's own header comment says exactly
    // "No secrets ever reach this screen").
    expect(panel).not.toMatch(/\.(client_secret|private_key|admin_token|password)\b/i);
  });

  it("uses only its own g22.admin.* keys and the shared empty/loading states — no bare Russian string literals", () => {
    // Every JSX text child in the file is either a ppmT("g22.admin....") call, an interpolated value/tag, or one of
    // the imported shared state components — a bare Cyrillic string literal would mean an untranslated leftover.
    const cyrillicLiterals = [...panel.matchAll(/>([^<{}]*[А-Яа-яЁё][^<{}]*)</g)].map((match) => match[1].trim());
    expect(cyrillicLiterals).toEqual([]);
    expect(panel.match(/ppmT\("g22\.admin\./g)?.length).toBeGreaterThanOrEqual(15);
  });
});
