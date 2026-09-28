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
