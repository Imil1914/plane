// G2.3 (G-Web): escaping and link-building for the two insertion targets. `label` always comes from the API
// (already Russian, per the G1 contract) — these tests only check that a hostile/real-world label or URL cannot
// break the surrounding `<a>` tag or `[label](url)` syntax.
import { describe, expect, it } from "vitest";
import {
  buildGitObjectHtmlLink,
  buildGitObjectMarkdownLink,
  escapeHtml,
  escapeMarkdownLabel,
  formatGitObjectSubtitle,
  isSafeGitObjectUrl,
} from "@/components/ppm-git/insert/format";

describe("escapeHtml", () => {
  it('escapes &, <, > and " in that order without double-escaping', () => {
    expect(escapeHtml(`<a href="x">R&D</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;R&amp;D&lt;/a&gt;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("коммит a1b2c3d «Сообщение»")).toBe("коммит a1b2c3d «Сообщение»");
  });
});

describe("escapeMarkdownLabel", () => {
  it("escapes backslashes before brackets so \\] is not read as an escaped literal bracket", () => {
    expect(escapeMarkdownLabel("a\\b")).toBe("a\\\\b");
  });

  it("escapes [ and ] so the label cannot end the Markdown link early", () => {
    expect(escapeMarkdownLabel("fix [PR] title")).toBe("fix \\[PR\\] title");
  });

  it("writes a raw < as an HTML entity so it is not read as inline HTML", () => {
    expect(escapeMarkdownLabel("a < b")).toBe("a &lt; b");
  });
});

describe("isSafeGitObjectUrl", () => {
  it("accepts http/https", () => {
    expect(isSafeGitObjectUrl("https://git.example/commit/a1b2c3d")).toBe(true);
    expect(isSafeGitObjectUrl("http://git.example/commit/a1b2c3d")).toBe(true);
  });

  it("rejects javascript:, data: and other non-http(s) schemes — review round 1 (#2)", () => {
    expect(isSafeGitObjectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeGitObjectUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeGitObjectUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeGitObjectUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects a scheme-relative or malformed value (URL requires an absolute, parseable URL)", () => {
    expect(isSafeGitObjectUrl("//evil.example/x")).toBe(false);
    expect(isSafeGitObjectUrl("not a url")).toBe(false);
    expect(isSafeGitObjectUrl("")).toBe(false);
  });

  it("is not fooled by leading whitespace or mixed case (java\\tscript:, JavaScript:) — URL normalizes both", () => {
    expect(isSafeGitObjectUrl("  javascript:alert(1)")).toBe(false);
    expect(isSafeGitObjectUrl("JaVaScRiPt:alert(1)")).toBe(false);
  });
});

describe("buildGitObjectHtmlLink", () => {
  it("wraps the escaped label in an <a> to the escaped url, opened in a new tab", () => {
    const html = buildGitObjectHtmlLink(`PR #12 «Fix "quotes" & <tags>»`, "https://git.example/a?x=1&y=2");
    expect(html).toBe(
      '<a href="https://git.example/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">PR #12 «Fix &quot;quotes&quot; &amp; &lt;tags&gt;»</a>'
    );
  });

  it("review round 1 (#2): degrades to the escaped label as plain text for an unsafe URL scheme, never an <a>", () => {
    const html = buildGitObjectHtmlLink("Fix <script> in title", 'javascript:alert(document.cookie)"');
    expect(html).toBe("Fix &lt;script&gt; in title");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
  });
});

describe("buildGitObjectMarkdownLink", () => {
  it("escapes ] in the label and wraps the url in <...> so a literal ) or space cannot close the destination", () => {
    const markdown = buildGitObjectMarkdownLink("PR #12 [urgent]", "https://git.example/pulls/(12)");
    expect(markdown).toBe("[PR #12 \\[urgent\\]](<https://git.example/pulls/(12)>)");
  });

  it("round-trips a plain label/url pair readably", () => {
    expect(buildGitObjectMarkdownLink("коммит a1b2c3d «Сообщение»", "https://git.example/commit/a1b2c3d")).toBe(
      "[коммит a1b2c3d «Сообщение»](<https://git.example/commit/a1b2c3d>)"
    );
  });

  it("review round 1 (#2): degrades to the escaped label as plain text for an unsafe URL scheme, never a link", () => {
    const markdown = buildGitObjectMarkdownLink("fix [it]", "data:text/html,<script>alert(1)</script>");
    expect(markdown).toBe("fix \\[it\\]");
    expect(markdown).not.toContain("](");
    expect(markdown).not.toContain("data:");
  });
});

describe("formatGitObjectSubtitle", () => {
  it("joins ref and a short Russian date with a middle dot", () => {
    expect(formatGitObjectSubtitle("main", "2026-09-28T10:00:00Z")).toBe("main · 28 сент.");
  });

  it("falls back to the ref alone without a date", () => {
    expect(formatGitObjectSubtitle("main", null)).toBe("main");
    expect(formatGitObjectSubtitle("main", undefined)).toBe("main");
  });

  it("drops an unparseable date instead of showing 'Invalid Date'", () => {
    expect(formatGitObjectSubtitle("main", "not-a-date")).toBe("main");
  });
});
