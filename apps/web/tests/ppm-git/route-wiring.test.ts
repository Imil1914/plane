// G2.1 (R10–R12): route.tsx needs the MobX stores and the router, so its wiring is checked in the source (as the
// dialog-dismiss and multi-board-focus guards do): our Git server's panel sits next to the GitHub App panel, GitHub-only
// flows get GitHub data only, a successful connect refreshes the overview and closes the dialog, copying falls back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../core/components/ppm-git/route.tsx", import.meta.url), "utf8");

describe("«Код» page wiring for our Git server", () => {
  it("shows our Git server's panel right before the GitHub App panel", () => {
    const gitServer = source.indexOf("<ForgejoProviderPanel");
    const github = source.indexOf("<GithubProviderPanel");
    expect(gitServer).toBeGreaterThan(-1);
    expect(gitServer).toBeLessThan(github);
    expect(source.slice(gitServer, github)).toMatch(/connections=\{connectionsByProvider\.forgejo\}/);
    expect(source.slice(gitServer, github)).toMatch(/canConnect=\{gitServer\.canManage\}/);
  });

  it("gives the GitHub App panel and the G1.3 write flow GitHub data only", () => {
    expect(source).toMatch(
      /<GithubProviderPanel\s+canManage=\{[^}]+\}\s+connections=\{connectionsByProvider\.github\}/
    );
    expect(source).toContain("repositories={githubWritableRepositories}");
    expect(source).toMatch(/const activeRepositories = overview \? getActiveGithubRepositories\(overview\)/);
    expect(source).not.toMatch(/installations\.find\(\(item\) => item\.status === "active"\)/);
  });

  it("refreshes the overview and then closes the dialog after a successful connect", () => {
    expect(source).toMatch(
      /onConnected=\{async \(\) => \{\s*await load\(\{ silent: true \}\);\s*setGitServerDialog\(false\);\s*\}\}/
    );
  });

  it("runs the picker in the page's dialog frame, holding Esc while connecting", () => {
    expect(source).toContain("const connecting = state.connectingId !== undefined;");
    expect(source).toMatch(/<DialogFrame\s+closeDisabled=\{connecting\}\s+onClose=\{onClose\}\s+saving=\{connecting\}/);
  });

  it("copies through the fallback helper", () => {
    expect(source).toContain("if (await copyTextToClipboard(value))");
    expect(source).not.toContain("navigator.clipboard");
  });
});

describe("fix round 1", () => {
  it("keeps the dialog open while connecting: the close button of the frame is disabled too", () => {
    expect(source).toMatch(/<DialogFrame\s+closeDisabled=\{connecting\}\s+onClose=\{onClose\}\s+saving=\{connecting\}/);
    expect(source).toMatch(
      /<button\s+type="button"\s+className="disabled:opacity-50"\s+aria-label="Закрыть"\s+disabled=\{closeDisabled\}\s+onClick=\{onClose\}\s*>/
    );
  });

  it("explains a refused copy neutrally: addresses and commands use the same helper", () => {
    expect(source).toContain('setError("Браузер не разрешил копирование. Выделите текст вручную.");');
    expect(source).not.toContain("Выделите команду вручную");
  });
});

describe("D-3: «Код» rows show the PR status", () => {
  it("imports the status helper", () => {
    expect(source).toMatch(/import\s*\{[^}]*getGitPullRequestStatusLabel[^}]*\}\s*from\s*"\.\/git-provider-labels";/s);
    expect(source).toMatch(/import\s*\{[^}]*getGitMergedAtTitle[^}]*\}\s*from\s*"\.\/git-provider-labels";/s);
  });

  it("GitObjectRow shows the status of a pull_request object only, using its own state, is_draft and merge time", () => {
    const start = source.indexOf("function GitObjectRow(");
    const end = source.indexOf("function GitLinkRow(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);
    expect(body).toMatch(
      /gitObject\.object_type === "pull_request"\s*\?\s*getGitPullRequestStatusLabel\(gitObject\.state, gitObject\.is_draft, gitObject\.provider_merged_at\)\s*:\s*null/
    );
    expect(body).toContain('{statusLabel ? "· " : ""}');
  });

  it("GitLinkRow shows the status of a pull_request link only, from git_object_state and git_object_merged_at", () => {
    const start = source.indexOf("function GitLinkRow(");
    const end = source.indexOf("function RepositoryDialog(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);
    expect(body).toMatch(
      /link\.object_type === "pull_request"\s*\?\s*getGitPullRequestStatusLabel\(link\.git_object_state, undefined, link\.git_object_merged_at\)\s*:\s*null/
    );
    expect(body).toContain("· {statusLabel}");
  });
});

describe("M review round 1: GitLinkRow's status carries the same full-date tooltip as GitObjectRow", () => {
  const start = source.indexOf("function GitLinkRow(");
  const end = source.indexOf("function RepositoryDialog(");
  const body = source.slice(start, end);

  it("computes statusTitle from getGitMergedAtTitle for a pull_request link only", () => {
    expect(body).toMatch(
      /link\.object_type === "pull_request"\s*\?\s*getGitMergedAtTitle\(link\.git_object_merged_at\)\s*:\s*undefined/
    );
  });

  it("renders the status as its own flex-wrap sibling carrying that title, not concatenated into the tertiary text", () => {
    expect(body).toContain('<span className="text-11 text-tertiary" title={statusTitle}>');
    expect(body).not.toContain('{statusLabel ? ` · ${statusLabel}` : ""}');
  });

  it("keeps the identifier/repository text and the status inside the same flex-wrap container", () => {
    const wrapStart = body.indexOf('className="flex flex-wrap items-center gap-2"');
    const statusStart = body.indexOf('<span className="text-11 text-tertiary" title={statusTitle}>');
    const containerEnd = body.indexOf("</div>", statusStart);
    expect(wrapStart).toBeGreaterThan(-1);
    expect(statusStart).toBeGreaterThan(wrapStart);
    expect(containerEnd).toBeGreaterThan(statusStart);
  });
});

describe("M-6 (review W5 #8): GitObjectRow's status survives truncation on a narrow row", () => {
  const start = source.indexOf("function GitObjectRow(");
  const end = source.indexOf("function GitLinkRow(");
  const body = source.slice(start, end);

  it("renders the status before the ref/repository text, not after it", () => {
    const statusSpanIndex = body.indexOf("{statusLabel && (");
    const restSpanIndex = body.indexOf("OBJECT_LABELS[gitObject.object_type]");
    expect(statusSpanIndex).toBeGreaterThan(-1);
    expect(restSpanIndex).toBeGreaterThan(-1);
    expect(statusSpanIndex).toBeLessThan(restSpanIndex);
  });

  it("keeps the status element itself non-truncatable (no `truncate` class on its span)", () => {
    const statusSpanStart = body.indexOf("{statusLabel && (");
    const statusSpanEnd = body.indexOf("</span>", statusSpanStart);
    const statusSpan = body.slice(statusSpanStart, statusSpanEnd);
    expect(statusSpan).toContain("shrink-0");
    expect(statusSpan).not.toContain("truncate");
  });

  it("only the ref/repository text truncates, and it is a separate flex-wrap sibling of the status", () => {
    expect(body).toContain('className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-12 text-secondary"');
    expect(body).toContain('<span className="min-w-0 truncate">');
  });
});
