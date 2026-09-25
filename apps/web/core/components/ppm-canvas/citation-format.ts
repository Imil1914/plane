import type { TPpmCanvasBinding, TPpmCanvasSearchResult } from "@ppm/canvas";

// Moved verbatim from brain-panel.tsx:2972-2984 — the "Find in project" panel and the canvas card share it.
export function formatLocator(locator: Record<string, string | number>) {
  if (locator.identifier) return `Задача ${locator.identifier}`;
  if (locator.page) return `${locator.path ?? "PDF"}, страница ${locator.page}`;
  if (locator.kind === "git_code" && locator.path) {
    const lines = locator.line_start
      ? `, строки ${locator.line_start}${locator.line_end ? `–${locator.line_end}` : ""}`
      : "";
    const commit = locator.commit_sha ? ` · ${String(locator.commit_sha).slice(0, 12)}` : "";
    return `${locator.path}${lines}${commit}`;
  }
  if (locator.path) return String(locator.path);
  return "Источник проекта";
}

export type TPpmCitationParts = { title: string; page: number | null; lines: string | null; version: string | null };

export function citationParts(result: TPpmCanvasSearchResult): TPpmCitationParts {
  const { locator } = result;
  if (result.source_type === "work_item") {
    return { title: String(locator.identifier ?? result.title), page: null, lines: null, version: null };
  }
  if (result.source_type === "git_code") {
    const path = String(locator.path ?? result.title);
    const start = Number(locator.line_start) || null;
    const end = Number(locator.line_end) || null;
    const lines = start ? (end && end !== start ? `${start}–${end}` : String(start)) : null;
    const sha = result.source_version.split(":")[0];
    return {
      title: path.split("/").pop() || path,
      page: null,
      lines,
      version: /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null,
    };
  }
  const page = Number(locator.page) || null;
  const number = result.source_version.split(":")[0];
  return { title: result.title, page, lines: null, version: /^\d+$/.test(number) ? `v${number}` : null };
}

// R17: "changed after the search" only when this board holds a live card of the same source whose version differs.
export function isCitationStale(result: TPpmCanvasSearchResult, bindings: Iterable<TPpmCanvasBinding>): boolean {
  for (const binding of bindings) {
    if (binding.entity_id !== result.source_id || !binding.source_version) continue;
    if (result.source_type === "vault_file" && binding.entity_type === "vault_file") {
      const found = result.source_version.split(":")[0];
      return /^\d+$/.test(found) && /^\d+$/.test(binding.source_version) && found !== binding.source_version;
    }
    if (result.source_type === "work_item" && binding.entity_type === "work_item") {
      return result.source_version !== binding.source_version;
    }
  }
  return false;
}

// A link that leaves PPM: an absolute http(s) or protocol-relative URL — for search results, the Git provider's
// canonical URL of a git_code hit (brain-panel.tsx sourceHref). PPM's own links are app paths («/ws/…») and keep
// the same tab, like the live card links (live-card.tsx).
export function isExternalHref(href: string): boolean {
  return /^(?:https?:)?\/\//i.test(href.trim());
}
