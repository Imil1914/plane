// G2.3 (line G-Web): pure formatting helpers for «Вставить коммит/PR» and «Что сделано за период» — turning a
// server-provided `label` + `canonical_url` (or work-item name + url) into the exact HTML or Markdown snippet that
// gets inserted at the cursor. The API (line G-API) builds `label`/`markdown`/`html` already in Russian per the
// contract (docs/superpowers/plans/2026-09-29-g23-reports/plan.md) — this module never re-derives that text, it only
// escapes it correctly for the two insertion targets, so a commit message or PR title containing `<`, `"`, `]` or `)`
// cannot break the surrounding markup. No DOM: safe to unit test under vitest's node environment.

/** Escapes text for use as HTML content or as a double-quoted HTML attribute value. */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Escapes text for use as the visible part of a Markdown link (`[label](url)`): backslashes and square brackets
 * would otherwise end the label early or be read as a second, malformed link; a raw `<` could be read as the start
 * of inline HTML by some renderers, so it is written as the literal HTML entity instead. */
export function escapeMarkdownLabel(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("<", "&lt;");
}

/** Review round 1 (#2): only `http:`/`https:` may become a clickable/markdown link — `canonical_url` is
 * server-provided (`serialize_git_object`/the work-summary items), but nothing upstream of this module validates
 * its scheme, so a `javascript:`/`data:` value must never reach `href` or a Markdown destination. Parsed with `URL`
 * rather than a prefix check so it cannot be fooled by whitespace/case tricks `URL` already normalizes. */
export function isSafeGitObjectUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The HTML link inserted into `@plane/editor` documents, task descriptions and comments — a plain, styled snapshot
 * link (`<a href="…">label</a>`), never a live chip (owner's decision 2026-09-29, G2.3 card). An unsafe URL scheme
 * degrades to the escaped label as plain text, never an `<a>` (review round 1 #2). */
export function buildGitObjectHtmlLink(label: string, url: string): string {
  if (!isSafeGitObjectUrl(url)) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/** The Markdown link inserted into a Vault note's plain-text editor. The destination is wrapped in `<…>`
 * (CommonMark's angle-bracket link form) so a literal `)` or space inside `url` cannot close the destination early —
 * simpler and safer than percent-encoding a URL that already came from the server as-is. An unsafe URL scheme
 * degrades to the escaped label as plain text, never a `[...](...)` link (review round 1 #2). */
export function buildGitObjectMarkdownLink(label: string, url: string): string {
  if (!isSafeGitObjectUrl(url)) return escapeMarkdownLabel(label);
  return `[${escapeMarkdownLabel(label)}](<${url}>)`;
}

/** The search dialog's small second line under `label` — the ref (branch/tag/PR head) and, when known, a short
 * Russian date, e.g. "main · 28 сент." `serialize_git_object` has no repository name (facts §2.2: `provider`/name
 * live on the joined `PpmGitRepository`, not on the object itself), so this line shows what the contract's object
 * shape actually carries rather than a field the API does not send. */
export function formatGitObjectSubtitle(ref: string, isoDate: string | null | undefined): string {
  const date = isoDate ? formatShortRuDate(isoDate) : null;
  return [ref, date].filter((part): part is string => Boolean(part && part.length > 0)).join(" · ");
}

function formatShortRuDate(isoDate: string): string | null {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(parsed);
}
