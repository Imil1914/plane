import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PpmNewTaskLabel } from "@/components/ppm-tasks/new-task-label";

// Controller ruling (task-7-report.md): built on top of ppm-shell/kbd-hint.tsx (phase F) — PpmKbdHint renders the
// real N I keys with its own aria-hidden wrapper; no local .ppm-kbd style or raw <kbd> markup here.
describe("PpmNewTaskLabel", () => {
  it("shows the real N I sequence to the eye and names it for screen readers", () => {
    const html = renderToStaticMarkup(<PpmNewTaskLabel label="Новая задача" keysLabel=", клавиши N, затем I" />);
    expect(html).toContain("Новая задача");
    expect(html).toContain('<span class="sr-only">, клавиши N, затем I</span>');
    expect([...html.matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)].map((m) => m[1])).toEqual(["N", "I"]);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*><kbd[^>]*>N<\/kbd><kbd[^>]*>I<\/kbd><\/span>/);
    expect(html).not.toContain("ppm-kbd");
    expect(html).not.toContain("aria-keyshortcuts");
  });
});
