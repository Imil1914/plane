/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EPageAccess } from "@plane/types";
import { getPpmTranslation } from "@ppm/brand";
import { formatDueDate } from "@/components/ppm-canvas/canvas-grammar";
import {
  createStickyPageSearch,
  filterFallbackPages,
  formatPageUpdated,
  isPageContentReadable,
  pageCreateStep,
} from "@/components/ppm-canvas/canvas-pages";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const PR = "44444444-4444-4444-8444-444444444444";
const shapeSource = readFileSync(new URL("../../core/components/ppm-canvas/shape.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../../core/components/ppm-canvas/editor.tsx", import.meta.url), "utf8");
const canvasPagesSource = readFileSync(
  new URL("../../core/components/ppm-canvas/canvas-pages.ts", import.meta.url),
  "utf8"
);
const pickerSource = readFileSync(
  new URL("../../core/components/ppm-canvas/canvas-page-picker.tsx", import.meta.url),
  "utf8"
);
const workspaceSource = readFileSync(
  new URL("../../core/components/ppm-canvas/workspace.tsx", import.meta.url),
  "utf8"
);

function pageProjection(id: string, title: string, excerpt: string | null, access: "public" | "private" = "public") {
  return {
    identity: {
      entity_type: "page" as const,
      entity_id: id,
      workspace_id: WS,
      project_id: PR,
      source_url: `/ws/projects/${PR}/pages/${id}`,
    },
    display: {
      title,
      excerpt,
      extension: ".page",
      mime_type: "text/html",
      size_bytes: 10,
      preview_url: null,
      source_status: "active" as const,
    },
    capabilities: { read: true, update: true, delete_source: false },
    source_version: "2026-09-24T12:00:00+00:00",
    page: { access },
  };
}

describe("Documents on the canvas (AF2.1 B3)", () => {
  // Раунд 2, пункт 5: searchCanvasPages убрана (нигде в production не вызывалась) — единственная точка входа
  // теперь createStickyPageSearch; её первый вызов ведёт себя как разовый поиск, этим тестам этого достаточно.
  it("uses the canvas pages search when the server supports it", async () => {
    const listProjectPages = vi.fn();
    const search = createStickyPageSearch({
      listProjectPages,
      searchServer: async () => ({
        results: [pageProjection(P1, "Отчёт о калибровке", "Датчик TCS34725…")],
        next_cursor: null,
      }),
    });
    const result = await search("отчёт");
    expect(result).toEqual({
      source: "server",
      hits: [{ excerpt: "Датчик TCS34725…", id: P1, title: "Отчёт о калибровке" }],
    });
    expect(listProjectPages).not.toHaveBeenCalled();
  });

  it("R-a: excludes private results returned by the server", async () => {
    const search = createStickyPageSearch({
      listProjectPages: vi.fn(),
      searchServer: async () => ({
        results: [
          pageProjection(P1, "Отчёт о калибровке", null, "public"),
          pageProjection(P2, "Личные заметки автора", null, "private"),
        ],
        next_cursor: null,
      }),
    });
    const result = await search("отчёт");
    expect(result.hits.map((hit) => hit.id)).toEqual([P1]);
  });

  it("falls back to the Plane pages list filtered on the client", async () => {
    const search = createStickyPageSearch({
      listProjectPages: async () => [
        { id: P2, name: "Протокол калибровки", archived_at: null, access: EPageAccess.PUBLIC },
        { id: P1, name: "Калибровка: отчёт", archived_at: null, access: EPageAccess.PUBLIC },
        {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Калибровка (архив)",
          archived_at: "2026-09-01T00:00:00Z",
          access: EPageAccess.PUBLIC,
        },
        { id: "66666666-6666-4666-8666-666666666666", name: "Спринт 4", archived_at: null, access: EPageAccess.PUBLIC },
      ],
      searchServer: async () => {
        throw new Error("404");
      },
    });
    const result = await search("КАЛИБ");
    expect(result.source).toBe("fallback");
    expect(result.hits.map((hit) => hit.id)).toEqual([P1, P2]);
  });

  it("R-a: excludes private pages from the fallback list", () => {
    const hits = filterFallbackPages("", [
      { id: P1, name: "Публичный отчёт", archived_at: null, access: EPageAccess.PUBLIC },
      { id: P2, name: "Приватный черновик", archived_at: null, access: EPageAccess.PRIVATE },
    ]);
    expect(hits.map((hit) => hit.id)).toEqual([P1]);
  });

  it("M3: a sticky search remembers a failing server and fetches the fallback list only once", async () => {
    const searchServer = vi.fn().mockRejectedValue(new Error("404"));
    const listProjectPages = vi
      .fn()
      .mockResolvedValue([{ id: P1, name: "Отчёт", archived_at: null, access: EPageAccess.PUBLIC }]);
    const search = createStickyPageSearch({ searchServer, listProjectPages });
    await search("о");
    await search("отчёт");
    expect(searchServer).toHaveBeenCalledTimes(1);
    expect(listProjectPages).toHaveBeenCalledTimes(1);
  });

  it("M4: a sticky search does not cache a failed fallback fetch, so «Повторить» retries it", async () => {
    const listProjectPages = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([{ id: P1, name: "Отчёт", archived_at: null, access: EPageAccess.PUBLIC }]);
    const search = createStickyPageSearch({
      searchServer: vi.fn().mockRejectedValue(new Error("404")),
      listProjectPages,
    });
    await expect(search("о")).rejects.toThrow("network");
    const result = await search("о");
    expect(listProjectPages).toHaveBeenCalledTimes(2);
    expect(result.hits.map((hit) => hit.id)).toEqual([P1]);
  });

  it("Пункт 7 (раунд 2): concurrent fallback searches share one in-flight list request", async () => {
    let resolveList: (pages: { id: string; name: string; archived_at: null; access: EPageAccess }[]) => void;
    const listProjectPages = vi.fn(
      () =>
        new Promise<{ id: string; name: string; archived_at: null; access: EPageAccess }[]>((resolve) => {
          resolveList = resolve;
        })
    );
    const search = createStickyPageSearch({
      searchServer: vi.fn().mockRejectedValue(new Error("404")),
      listProjectPages,
    });
    const first = search("о");
    // Let the (already-rejected) server-search microtask run so `serverDown` flips and the fallback-list request
    // actually starts before the second, concurrent call — otherwise both calls are still stuck awaiting the
    // server and neither has reached listProjectPages() yet.
    await Promise.resolve();
    await Promise.resolve();
    const second = search("отчёт");
    expect(listProjectPages).toHaveBeenCalledTimes(1);
    resolveList!([{ id: P1, name: "Отчёт", archived_at: null, access: EPageAccess.PUBLIC }]);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.hits.map((hit) => hit.id)).toEqual([P1]);
    expect(secondResult.hits.map((hit) => hit.id)).toEqual([P1]);
    expect(listProjectPages).toHaveBeenCalledTimes(1);
  });

  it("shows when the document changed instead of a raw version", () => {
    expect(formatPageUpdated("2026-09-24T12:00:00+00:00", "ru", "изменён {date}")).toBe("изменён 24 сент.");
    expect(formatPageUpdated(null, "ru", "изменён {date}")).toBeNull();
    expect(formatPageUpdated("7", "ru", "изменён {date}")).toBeNull();
  });

  it("M7: uses the viewer's local calendar day, not a UTC slice of the ISO string", () => {
    const iso = "2026-09-24T23:45:00+00:00";
    const local = new Date(iso);
    const localIso = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    expect(formatPageUpdated(iso, "ru", "изменён {date}")).toBe(`изменён ${formatDueDate(localIso, "ru")}`);
  });

  it("Fix 1: pageCreateStep only re-creates when nothing was left unplaced", () => {
    expect(pageCreateStep(undefined)).toEqual({ step: "create" });
    expect(pageCreateStep({ pageId: P1, title: "Отчёт" })).toEqual({ step: "place", pageId: P1, title: "Отчёт" });
  });

  it("Fix 2: a document is readable only while its source is neither deleted nor unreadable", () => {
    expect(isPageContentReadable("active", true)).toBe(true);
    expect(isPageContentReadable("deleted", true)).toBe(false);
    expect(isPageContentReadable("active", false)).toBe(false);
    expect(isPageContentReadable("quarantined", true)).toBe(true);
  });

  it("hides the «.page» pseudo-extension and shows a neutral label while the binding is loading", () => {
    expect(shapeSource).toMatch(/binding\.entity_type === "page" \? null/);
    expect(shapeSource).toContain('"canvas.kind_document"');
  });

  it("Пункт 3 (раунд 2): the neutral loading label applies only under v2 — v1 keeps the wave-0 fallback title", () => {
    expect(shapeSource).toMatch(
      /grammarV2 && node\.binding\?\.entity_type === "page" \? ppmT\("canvas\.kind_document"\) : fallbackTitle/
    );
  });

  it("Fix 2: does not render or fetch the preview, and clears cached HTML, once unreadable", () => {
    expect(shapeSource).toContain("isPageContentReadable(");
    expect(shapeSource).toMatch(/setPageHtml\(null\)/);
  });

  it("M1: sanitizes and caps the HTML once, in loadPageHtml — not again on every render", () => {
    expect(editorSource).toContain("description_html");
    expect(editorSource).toMatch(/\.slice\(0,\s*50_000\)/);
    // Пункт 6 (раунд 2): недоверенный серверный description_html — строгий режим, а не значение по умолчанию B1's
    // createPageFromNote (который санитизирует HTML, сгенерированный нашим же конвертером Markdown).
    expect(editorSource).toContain("sanitizeCanvasHtml(raw.slice(0, 50_000), { allowKatex: false })");
    expect(shapeSource).not.toContain("sanitizeCanvasHtml(pageHtml)");
  });

  it("M13/пункт 9 (раунд 2): the preview is inert — links leave the tab order and a11y tree, open only via «Открыть ↗»", () => {
    const css = readFileSync(new URL("../../core/components/ppm-canvas/canvas-content.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.ppm-live-card__page-preview\s*{[^}]*pointer-events:\s*none/);
    expect(shapeSource).toMatch(/className="ppm-live-card__page-preview"[\s\S]{0,600}inert=""/);
  });

  it("names the Documents actions in both languages", () => {
    expect(getPpmTranslation("ru", "canvas.page_pick_title")).toBe("Документ PPM");
    expect(getPpmTranslation("en", "canvas.page_pick_title")).toBe("PPM document");
    expect(getPpmTranslation("ru", "canvas.page_search_error")).toBe("Не удалось загрузить документы");
    expect(getPpmTranslation("ru", "canvas.page_search_retry")).toBe("Повторить");
    expect(getPpmTranslation("ru", "canvas.page_created_unplaced")).toContain("не добавлен на холст");
  });

  it("does not leave the orphan «canvas.page_new» key behind (M9)", () => {
    const translationsSource = readFileSync(
      new URL("../../../../packages/ppm-brand/src/translations/af21-canvas.ts", import.meta.url),
      "utf8"
    );
    expect(translationsSource).not.toContain("canvas.page_new");
  });

  it("Пункт 5 (раунд 2): no dead export — searchCanvasPages is gone, createStickyPageSearch is the entry point", () => {
    expect(canvasPagesSource).not.toContain("export async function searchCanvasPages");
    expect(canvasPagesSource).not.toMatch(/\bsearchCanvasPages\(/);
    expect(pickerSource).not.toMatch(/\bsearchCanvasPages\(/);
    expect(pickerSource).toContain("createStickyPageSearch(deps)");
  });

  it("R-b (раунд 2, пункт 1): the workspace modal guard checks the AF2.1 data attribute, not aria-modal", () => {
    expect(workspaceSource).toContain('document.querySelector("[data-ppm-canvas-modal]")');
    expect(workspaceSource).not.toMatch(/document\.querySelector\(['"]\[aria-modal="true"\]['"]\)/);
    // The comment must name the right ruling and explain what this handler covers vs. editor.blur().
    expect(workspaceSource).toMatch(/AF2\.1 B: \(B3\) modal guard.*R-b/);
    expect(workspaceSource).toContain("editor.blur()");
    // The picker is what the guard is meant to catch.
    expect(pickerSource).toContain('data-ppm-canvas-modal=""');
  });

  it("Пункт 2 (раунд 2): Enter/NumpadEnter in the picker only pick from the search input", () => {
    expect(pickerSource).toMatch(/event\.target === inputRef\.current/);
    expect(pickerSource).toContain("onFocus={() => setActiveIndex(index)}");
  });

  it("Пункт 4 (раунд 2): Shift+Tab wraps to the last focusable element even when focus is on the dialog itself", () => {
    expect(pickerSource).toMatch(/active === first \|\| active === dialog/);
    expect(pickerSource).toMatch(/active === last \|\| active === dialog/);
  });

  it("Пункт 8 (раунд 2): a short notice fires when the picker is force-closed after losing edit rights", () => {
    expect(editorSource).toContain("canvas.page_picker_readonly");
    expect(editorSource).toMatch(/pagePickerOpen && !effectiveCanEdit/);
    expect(getPpmTranslation("ru", "canvas.page_picker_readonly")).toContain("Права");
    expect(getPpmTranslation("en", "canvas.page_picker_readonly")).toContain("lost");
  });
});
