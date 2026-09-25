import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TPpmCanvasBinding, TPpmCanvasSearchResult } from "@ppm/canvas";
import { getPpmTranslation } from "@ppm/brand";
import { citationParts, formatLocator, isCitationStale, isExternalHref } from "@/components/ppm-canvas/citation-format";

const result = (patch: Partial<TPpmCanvasSearchResult>): TPpmCanvasSearchResult => ({
  result_id: "r1",
  source_id: "11111111-1111-4111-8111-111111111111",
  source_type: "vault_file",
  source_version: "2:abc",
  source_url: "/ws/projects/p/knowledge/x",
  title: "Схема захвата.pdf",
  excerpt: "Сравнили на 120 деталях",
  score: 1,
  locator: { kind: "vault_pdf", path: "Схема захвата.pdf", page: 2 },
  ...patch,
});
const binding = (
  entity_type: string,
  source_version: string | null,
  entity_id = "11111111-1111-4111-8111-111111111111"
) => ({ entity_id, entity_type, source_version }) as TPpmCanvasBinding;

describe("citation format (UX1.1 C5)", () => {
  it("keeps the brain panel locator text unchanged", () => {
    expect(formatLocator({ identifier: "ROBOT-7" })).toBe("Задача ROBOT-7");
    expect(formatLocator({ path: "docs/Схема.pdf", page: 2 })).toBe("docs/Схема.pdf, страница 2");
    expect(
      formatLocator({
        kind: "git_code",
        path: "src/a.ts",
        line_start: 14,
        line_end: 22,
        commit_sha: "abcdef1234567890",
      })
    ).toBe("src/a.ts, строки 14–22 · abcdef123456");
    expect(formatLocator({ path: "notes/x.md" })).toBe("notes/x.md");
    expect(formatLocator({})).toBe("Источник проекта");
    const panel = readFileSync(new URL("../../core/components/ppm-canvas/brain-panel.tsx", import.meta.url), "utf8");
    expect(panel).not.toMatch(/function formatLocator/);
    expect(panel).toContain('import { formatLocator } from "./citation-format";');
  });

  it("builds chip parts: number · source · locator · version", () => {
    expect(citationParts(result({}))).toEqual({ title: "Схема захвата.pdf", page: 2, lines: null, version: "v2" });
    expect(
      citationParts(
        result({
          source_type: "work_item",
          title: "ROBOT-7 · Выбрать датчик",
          source_version: "2026-09-20T10:00:00+00:00",
          locator: { kind: "work_item", identifier: "ROBOT-7" },
        })
      )
    ).toEqual({ title: "ROBOT-7", page: null, lines: null, version: null });
    expect(
      citationParts(
        result({
          source_type: "git_code",
          title: "a.ts",
          source_version: "abcdef1234567:hash",
          locator: { kind: "git_code", path: "src/lib/a.ts", line_start: 14, line_end: 22 },
        })
      )
    ).toEqual({ title: "a.ts", page: null, lines: "14–22", version: "abcdef1" });
    expect(getPpmTranslation("ru", "canvas.citation_page").replace("{page}", "2")).toBe("стр. 2");
  });

  it("marks a citation stale only against a live card of the same source with another version (R17)", () => {
    expect(isCitationStale(result({}), [binding("vault_file", "3")])).toBe(true);
    expect(isCitationStale(result({ source_version: "3:def" }), [binding("vault_file", "3")])).toBe(false);
    expect(isCitationStale(result({}), [binding("vault_file", "3", "22222222-2222-4222-8222-222222222222")])).toBe(
      false
    );
    expect(isCitationStale(result({}), [])).toBe(false);
    const task = result({ source_type: "work_item", source_version: "2026-09-20T10:00:00+00:00" });
    expect(isCitationStale(task, [binding("work_item", "2026-09-22T08:00:00+00:00")])).toBe(true);
    expect(isCitationStale(task, [binding("work_item", "2026-09-20T10:00:00+00:00")])).toBe(false);
    expect(
      isCitationStale(result({ source_type: "git_code", source_version: "abc:1" }), [binding("pull_request", "x")])
    ).toBe(false);
    expect(getPpmTranslation("ru", "canvas.citation_stale")).toBe("изменился после поиска");
  });

  it("opens only links that leave PPM in a new tab (B10)", () => {
    // git_code results carry the provider's canonical URL (brain-panel.tsx sourceHref); the rest are PPM paths.
    expect(isExternalHref("https://github.com/acme/robot/blob/abc/src/a.ts#L14")).toBe(true);
    expect(isExternalHref("http://gitlab.local/acme/robot")).toBe(true);
    expect(isExternalHref("//cdn.example.com/x")).toBe(true);
    expect(isExternalHref("/ws/browse/ROBOT-7/")).toBe(false);
    expect(isExternalHref("/ws/projects/p/knowledge?entry_id=1")).toBe(false);
    const shape = readFileSync(new URL("../../core/components/ppm-canvas/shape.tsx", import.meta.url), "utf8");
    const card = shape.slice(shape.indexOf("function FoundBySearchCard"), shape.indexOf("const NATIVE_NODE_LABELS"));
    const anchors = card.match(/<a\b[\s\S]*?>/g) ?? [];
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      expect(anchor).toMatch(/rel=\{isExternalHref\([\w.]+\) \? "noreferrer" : undefined\}/);
      expect(anchor).toMatch(/target=\{isExternalHref\([\w.]+\) \? "_blank" : undefined\}/);
    }
  });
});
