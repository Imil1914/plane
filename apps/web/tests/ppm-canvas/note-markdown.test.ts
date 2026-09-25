import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Editor, TLShapeId } from "tldraw";
import { getPpmTranslation } from "@ppm/brand";
import { createPpmCanvasNode, serializePpmCanvasNode } from "@ppm/canvas";
import { createNoteInEditMode } from "@/components/ppm-canvas/note-markdown";
import { highlightCodeHtml, normalizeCodeLanguage } from "@/components/ppm-canvas/canvas-code";
import {
  CANVAS_ALLOWED_URI,
  CANVAS_MARKDOWN_MAX_CHARS,
  canvasMarkdownPlainReason,
  canvasPurifyConfig,
  isCanvasMarkdownTooComplex,
  isCanvasMarkdownTooLong,
  isSafeCanvasHref,
  markdownToPageHtml,
  noteTaskName,
  plainTextToHtml,
  renderCanvasMarkdown,
  renderMarkdownOrPlainText,
  sanitizeCanvasHtml,
  sanitizeKatexStyle,
} from "@/components/ppm-canvas/canvas-markdown";
import {
  canScrollBy,
  findSpotBeside,
  noteSourceStep,
  rectInside,
  unplacedSourceKey,
  type TUnplacedNoteSource,
} from "@/components/ppm-canvas/canvas-placement";

const read = (name: string) =>
  readFileSync(new URL(`../../core/components/ppm-canvas/${name}`, import.meta.url), "utf8");
const shapeSource = read("shape.tsx");
const noteSource = read("note-markdown.tsx");
const editorSource = read("editor.tsx");

const timed = (render: (source: string) => string, source: string) => {
  const started = performance.now();
  const html = render(source);
  return { html, ms: performance.now() - started };
};

describe("note card v2: Markdown, KaTeX, code (AF2.1 B1)", () => {
  it("renders Markdown structure and safe links", () => {
    const html = renderCanvasMarkdown("## Калибровка\n\n- красный\n- синий\n\n[Замеры](https://example.org/a.csv)");
    expect(html).toContain("<h2>Калибровка</h2>");
    expect(html).toContain("<li>красный</li>");
    expect(html).toContain(
      '<a href="https://example.org/a.csv" rel="noopener noreferrer nofollow" target="_blank">Замеры</a>'
    );
  });

  it("never passes raw HTML, unsafe links or remote images through", () => {
    const html = renderCanvasMarkdown(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) ![logo](https://evil.example/p.png)"
    );
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("evil.example");
    expect(html).toContain("logo");
  });

  it("renders LaTeX with KaTeX inline and as a block, never throws and trusts nothing", () => {
    const html = renderCanvasMarkdown(
      "Порог $\\Delta E < 12$.\n\n$$\n\\Delta E = \\sqrt{(L_1-L_2)^2}\n$$\n\nОшибка $\\frac{1}{$ и $\\href{javascript:alert(1)}{x}$"
    );
    expect(html).toContain('<span class="katex">');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("katex-error");
    expect(html).not.toContain('href="javascript');
    expect(renderCanvasMarkdown("Цена $5 и $6")).not.toContain("katex");
    expect(renderCanvasMarkdown("Цена \\$5")).not.toContain("katex");
  });

  it("highlights fenced code locally with lowlight", () => {
    const html = renderCanvasMarkdown("```py\ndef classify(lab):\n    return lab\n```");
    expect(html).toContain('<code class="hljs language-python">');
    expect(html).toContain('<span class="hljs-keyword">def</span>');
    expect(normalizeCodeLanguage("py")).toBe("python");
    expect(normalizeCodeLanguage("text")).toBe("plaintext");
    expect(normalizeCodeLanguage("brainfuck")).toBe("plaintext");
    expect(highlightCodeHtml("<b>&", "plaintext")).toBe("&lt;b&gt;&amp;");
  });

  it("keeps GFM task list marks as text, never as form controls", () => {
    // DOMPurify forbids <input>: without a glyph the «[x]» state would silently disappear.
    const html = renderCanvasMarkdown("- [ ] замерить\n- [x] откалибровать");
    expect(html).toContain("<li>☐ замерить</li>");
    expect(html).toContain("<li>☑ откалибровать</li>");
    expect(html).not.toContain("<input");
    expect(markdownToPageHtml("- [x] готово")).toContain("<li>☑ готово</li>");
  });

  it("leaves the tldraw editing state through editor.complete(), never a bare setEditingShape(null)", () => {
    // tldraw handles Esc on its container before React; ⌘/Ctrl+Enter must go through the state machine as well,
    // otherwise select.editing_shape stays active without an editing shape and the next click on a shape throws.
    expect(noteSource).toContain("editor.complete()");
    expect(noteSource).not.toContain("setEditingShape(null)");
  });

  it("fails closed without a DOM: the sanitizer escapes instead of passing HTML", () => {
    expect(sanitizeCanvasHtml("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });

  it("builds Documents HTML without KaTeX markup and names tasks after the note", () => {
    const html = markdownToPageHtml("# Отчёт\n\nПорог $\\Delta E$\n\n$$x^2$$\n\n<b>x</b>");
    expect(html).toContain("<h1>Отчёт</h1>");
    expect(html).toContain("<code>$\\Delta E$</code>");
    expect(html).toContain("<pre><code>$$x^2$$</code></pre>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("katex");
    expect(noteTaskName("", "## Замерить при лампе\n\nтекст")).toBe("Замерить при лампе");
    expect(noteTaskName("  Порог ΔE  ", "")).toBe("Порог ΔE");
    expect(noteTaskName("", "   ")).toBe("");
    expect(noteTaskName("x".repeat(300), "")).toHaveLength(255);
  });

  it("places the new card beside the note without overlapping", () => {
    const note = { x: 0, y: 0, w: 320, h: 220 };
    expect(findSpotBeside(note, { w: 360, h: 180 }, [note])).toEqual({ x: 344, y: 0 });
    const blocker = { x: 344, y: 0, w: 360, h: 180 };
    expect(findSpotBeside(note, { w: 360, h: 180 }, [note, blocker])).toEqual({ x: 344, y: 204 });
  });

  it("falls back below the column beside the note, not below the whole board", () => {
    const note = { x: 0, y: 0, w: 320, h: 220 };
    const occupied = [
      note,
      { x: 344, y: 0, w: 360, h: 2_000 }, // the whole column to the right
      { x: 0, y: 244, w: 320, h: 200 }, // below
      { x: -384, y: 0, w: 360, h: 180 }, // left
      { x: 0, y: -204, w: 360, h: 180 }, // above
      { x: 5_000, y: 9_000, w: 100, h: 100 }, // far away, outside the column
    ];
    expect(findSpotBeside(note, { w: 360, h: 180 }, occupied)).toEqual({ x: 344, y: 2_024 });
  });

  it("never treats the section around the note as an obstacle", () => {
    // editor.tsx passes the anchor's ancestors (tldraw frame, PPM section) as exceptions to occupiedPageRects.
    expect(editorSource).toMatch(/getShapeAncestors\(anchor\.id\)/);
  });

  it("mounts the Markdown note only under grammar v2 and sanitizes before injecting", () => {
    expect(shapeSource).toMatch(/grammarV2 && node\.kind === "note" && node\.format === "markdown"/);
    expect(noteSource).toContain('import "katex/dist/katex.min.css";');
    expect(noteSource).not.toMatch(/https?:\/\//);
    expect(noteSource).toMatch(/useMemo\(\s*\(\)\s*=>\s*sanitizeCanvasHtml\(\s*renderCanvasMarkdown\(/);
    expect(noteSource).toContain("dangerouslySetInnerHTML={{ __html: html }}");
    expect(editorSource).toContain("<PpmCanvasContentActionsContext.Provider value={contentActions}>");
  });

  it("names the note actions in both languages", () => {
    expect(getPpmTranslation("ru", "canvas.note_make_task")).toBe("Сделать задачей");
    expect(getPpmTranslation("ru", "canvas.note_make_document")).toBe("Сделать документом");
    expect(getPpmTranslation("en", "canvas.note_make_task")).toBe("Make a task");
    expect(getPpmTranslation("en", "canvas.note_make_document")).toBe("Make a document");
  });
});

describe("note card v2 — review round 1 (AF2.1 B1)", () => {
  const renderers = [
    ["note", renderCanvasMarkdown],
    ["document", markdownToPageHtml],
  ] as const;

  it("keeps raw HTML escaped after an inline <kbd|code|pre|script>, in this and the next paragraph", () => {
    const payload = '<div/style="position:fixed;inset:0;background:url(//evil.example/t.png)">';
    for (const [name, render] of renderers)
      for (const tag of ["kbd", "code", "pre", "script"])
        for (const source of [`x <${tag}> ${payload}`, `x <${tag}> y\n\nnext ${payload}`]) {
          const html = render(source);
          expect(html, `${name}: ${source}`).not.toMatch(/<div|<kbd|<code|<pre|<script/i);
          expect(html, `${name}: ${source}`).toContain("&lt;div/style=&quot;position:fixed;");
        }
  });

  it("drops protocol-relative links and keeps remote images as captions in both renderers", () => {
    const source =
      '[a](//evil.example/x) [b](/\\evil.example) <a href="//evil">z</a> ![img](http://x.example/p.png) [ok](/projects/1)';
    for (const [name, render] of renderers) {
      const html = render(source);
      expect(html, name).not.toMatch(/href="\/[\\/]|<img/);
      expect(html, name).toContain("&lt;a href=&quot;//evil&quot;&gt;z&lt;/a&gt;");
      expect(html, name).not.toContain("x.example");
      expect(html, name).toContain(" img ");
      expect(html, name).toContain('<a href="/projects/1" rel="noopener noreferrer nofollow" target="_blank">ok</a>');
    }
    expect(isSafeCanvasHref("/\t/evil.example")).toBe(false);
    expect(isSafeCanvasHref("  https://ok.example  ")).toBe(true);
  });

  it("keeps every KaTeX layout style (fractions, roots, integrals, matrices, colour, scripts) and nothing else", () => {
    const formulas = [
      "\\frac{a}{b}",
      "\\sqrt{x^2+y^2}",
      "\\sqrt[3]{x}",
      "\\int_0^\\infty e^{-x}\\,dx",
      "\\sum_{i=1}^{n} i^2",
      "\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}",
      "\\color{red}{x}",
      "x_i^2 + a_{b_{c}}",
      "\\fcolorbox{red}{yellow}{w} \\boxed{E} \\rule{1em}{2pt} \\vec{v}",
      "\\frac{1}{",
    ];
    let checked = 0;
    for (const tex of formulas) {
      const html = renderCanvasMarkdown(`$$${tex}$$\n\nи $${tex}$`);
      for (const [, style] of html.matchAll(/ style="([^"]*)"/g)) {
        const declarations = style.split(";").filter((part) => part.trim());
        expect(sanitizeKatexStyle(style).split(";"), `${tex}: ${style}`).toHaveLength(declarations.length);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(sanitizeKatexStyle("position:relative;top:-0.0006em")).toBe("position:relative;top:-0.0006em");
    for (const hostile of [
      "position:fixed",
      "position:absolute;inset:0",
      "background:url(//evil.example/t.png)",
      "background-color:var(--x)",
      "width:expression(alert(1))",
      "color:\\72 ed",
      "height:1em !important",
      "@import 'x'",
      "display:block",
    ])
      expect(sanitizeKatexStyle(hostile), hostile).toBe("");
  });

  it("passes KaTeX attributes through the URI check that rejects unsafe and protocol-relative URLs", () => {
    const uriSafe = new Set(["alt", "class", "role", "style", "title", "xmlns"]);
    const html = renderCanvasMarkdown(
      "$$\\sqrt{x^2+y^2} + \\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} + \\cancel{x}$$\n\n[ok](https://ok.example)"
    );
    let checked = 0;
    for (const [, name, value] of html.matchAll(/ ([\w:-]+)="([^"]*)"/g)) {
      if (uriSafe.has(name) || name.startsWith("aria-")) continue;
      // DOMPurify strips control characters and whitespace (ATTR_WHITESPACE) before this check.
      // oxlint-disable-next-line no-control-regex -- the same character set as DOMPurify
      expect(CANVAS_ALLOWED_URI.test(value.replace(/[\x00-\x20\s]/g, "")), `${name}="${value}"`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
    for (const unsafe of [
      "//evil.example",
      "\\\\evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "data:text/html,x",
    ])
      expect(CANVAS_ALLOWED_URI.test(unsafe), unsafe).toBe(false);
    for (const safe of ["https://ok.example", "mailto:a@b.example", "/projects/1", "#y", "_blank", "0 0 400000 1080"])
      expect(CANVAS_ALLOWED_URI.test(safe), safe).toBe(true);
  });

  it("normalizes code languages safely: prototype keys, info strings, canonical names", () => {
    expect(normalizeCodeLanguage("constructor")).toBe("plaintext");
    expect(normalizeCodeLanguage("__proto__")).toBe("plaintext");
    expect(normalizeCodeLanguage("toString")).toBe("plaintext");
    expect(normalizeCodeLanguage("py title=x")).toBe("python");
    expect(normalizeCodeLanguage("cc")).toBe("cpp");
    expect(normalizeCodeLanguage("console")).toBe("shell");
    expect(normalizeCodeLanguage("Plain Text")).toBe("plaintext");
    expect(() => renderCanvasMarkdown("```constructor\nx\n```")).not.toThrow();
    expect(renderCanvasMarkdown("```__proto__\nx\n```")).toContain('<code class="hljs language-plaintext">x</code>');
    expect(
      renderMarkdownOrPlainText("a <b>", () => {
        throw new Error("render failed");
      })
    ).toBe("<p>a &lt;b&gt;</p>");
  });

  it("shows notes over 10 000 characters as escaped text: never parsed, never cut", () => {
    expect(CANVAS_MARKDOWN_MAX_CHARS).toBe(10_000);
    const long = `# Заголовок\n\n<b>жирный</b> $x$\n\n${"z".repeat(10_000)}`;
    expect(isCanvasMarkdownTooLong(long)).toBe(true);
    for (const [name, render] of renderers) {
      const html = render(long);
      expect(html.startsWith("<p># Заголовок</p>"), name).toBe(true);
      expect(html, name).toContain("<p>&lt;b&gt;жирный&lt;/b&gt; $x$</p>");
      expect(html, name).not.toContain("katex");
      expect(html, name).toContain("z".repeat(10_000));
    }
    expect(plainTextToHtml("a\nb\n\n  \n<c>")).toBe("<p>a<br>b</p>\n<p>&lt;c&gt;</p>");
    // Round 2: one reason for plain text — length (round 1) or markup complexity (round 2).
    expect(noteSource).toContain("useMemo(() => canvasMarkdownPlainReason(body), [body])");
    expect(noteSource).toContain('plainReason === "length" ? "canvas.note_too_long" : "canvas.note_too_complex"');
    expect(getPpmTranslation("ru", "canvas.note_too_long")).toBe(
      "Длинная заметка показана без форматирования (больше 10 000 знаков)"
    );
    expect(getPpmTranslation("en", "canvas.note_too_long")).toBeTruthy();
  });

  it("retries a half-done action by binding the source it already created", () => {
    const unplaced = new Map<string, TUnplacedNoteSource>();
    expect(noteSourceStep(unplaced, "shape:note", "task")).toEqual({ step: "create" });
    unplaced.set(unplacedSourceKey("shape:note", "task"), { entityId: "wi-1", label: "ROBOT-7" });
    expect(noteSourceStep(unplaced, "shape:note", "task")).toEqual({
      step: "bind",
      entityId: "wi-1",
      label: "ROBOT-7",
    });
    expect(noteSourceStep(unplaced, "shape:note", "document")).toEqual({ step: "create" });
    expect(noteSourceStep(unplaced, "shape:other", "task")).toEqual({ step: "create" });
    expect(editorSource).toMatch(/noteSourceStep\(unplacedSourcesRef\.current, anchor\.id, "task"\)/);
    expect(editorSource).toMatch(/noteSourceStep\(unplacedSourcesRef\.current, anchor\.id, "document"\)/);
    expect(getPpmTranslation("ru", "canvas.note_task_created_unplaced")).toBe(
      "Задача создана, но не добавлена на холст — нажмите ещё раз, чтобы добавить"
    );
    expect(getPpmTranslation("ru", "canvas.note_document_created_unplaced")).toBe(
      "Документ создан, но не добавлен на холст — нажмите ещё раз, чтобы добавить"
    );
  });

  it("brings an off-screen card into view, scrolls a note before panning, hides the hint from readers", () => {
    const viewport = { x: 0, y: 0, w: 1000, h: 600 };
    expect(rectInside({ x: 10, y: 10, w: 360, h: 248 }, viewport)).toBe(true);
    expect(rectInside({ x: 900, y: 10, w: 360, h: 248 }, viewport)).toBe(false);
    expect(editorSource).toContain("activeEditor.centerOnPoint(bounds.center, { animation: { duration: 220 } });");
    expect(canScrollBy(0, 200, 600, 40)).toBe(true);
    expect(canScrollBy(400, 200, 600, 40)).toBe(false);
    expect(canScrollBy(0, 200, 600, -40)).toBe(false);
    expect(canScrollBy(10, 200, 600, -40)).toBe(true);
    expect(canScrollBy(0, 200, 200, 40)).toBe(false);
    expect(noteSource).toContain("onWheelCapture={onViewWheel}");
    expect(noteSource).toMatch(/canAct && <p className="ppm-note-card__empty">/);
    expect(editorSource).toContain(
      '<div className="ppm-canvas-content-notice" data-ppm-notice="content" role="status">'
    );
  });

  it("names tasks and documents without Markdown markup", () => {
    expect(noteTaskName("", "## **Замерить** при _лампе_ [класса](https://x.example)")).toBe(
      "Замерить при лампе класса"
    );
    expect(noteTaskName("", "```py\nprint(1)\n```")).toBe("print(1)");
    expect(noteTaskName("", "$$\n\\Delta E\n$$")).toBe("\\Delta E");
    expect(noteTaskName("", "- [x] проверить lab_value и слово_другое_")).toBe("проверить lab_value и слово_другое_");
  });
});

describe("note card v2 — review round 2 (AF2.1 B1)", () => {
  // Generous for CI; the guard keeps these at a few milliseconds (reviewer's probes took 0.7–37 s before it).
  const BUDGET_MS = 500;
  const renderers = [renderCanvasMarkdown, markdownToPageHtml];
  const nbsp = String.fromCharCode(0xa0);

  it("renders the reviewer's slow probes as plain text through the guard, fast", () => {
    // Before the guard (marked 16.4.2): 0.26 s … 37 s each.
    const slow: Array<[string, string]> = [
      ['"[a](" x600', "[a](".repeat(600)],
      ['"[a](" x2400', "[a](".repeat(2_400)],
      ['"![a](" x2400', "![a](".repeat(2_400)],
      ['"[](" x3300', "[](".repeat(3_300)],
      ['"[a](<" x2000', "[a](<".repeat(2_000)],
      ['"[a](\\"" x2000', '[a]("'.repeat(2_000)],
      ['"[![a](" x1400', "[![a](".repeat(1_400)],
      ['"_a*" x3300', "_a*".repeat(3_300)],
      ['"[a](" + NBSP x2000', `[a](${nbsp}`.repeat(2_000)],
      ['"[a](" x200 + 8 000-char tail', "[a](".repeat(200) + "x ".repeat(4_000)],
      ['"**a " x2000', "**a ".repeat(2_000)],
    ];
    for (const [label, raw] of slow) {
      const source = raw.slice(0, 9_999);
      expect(isCanvasMarkdownTooComplex(source), label).toBe(true);
      expect(canvasMarkdownPlainReason(source), label).toBe("complexity");
      for (const render of renderers) {
        const { html, ms } = timed(render, source);
        expect(ms, label).toBeLessThan(BUDGET_MS);
        expect(html.startsWith("<p>"), label).toBe(true);
        expect(html, label).not.toMatch(/<a |<img|katex|<em>|<strong>/);
      }
    }
  });

  it("keeps the reviewer's cheap probes fast whichever path they take", () => {
    const cheap = [
      "[".repeat(9_999),
      "[a](b ".repeat(1_600),
      "[a](" + "(".repeat(9_000),
      "<a".repeat(4_900),
      ">".repeat(9_999),
      Array.from({ length: 400 }, (_, index) => `${"  ".repeat(index)}- x`).join("\n"),
      "**a".repeat(3_300),
      "`a".repeat(4_900),
      "a\\".repeat(4_900),
      `|${"a|".repeat(90)}\n|${"-|".repeat(90)}\n${`|${"b|".repeat(90)}\n`.repeat(50)}`,
      "[a](".repeat(150),
      "[a][".repeat(2_400),
      '[a](b "'.repeat(1_400),
      "[a](\n".repeat(2_400),
      `${"[a](".repeat(8)}\n\n`.repeat(300),
    ];
    for (const raw of cheap) {
      const source = raw.slice(0, 9_999);
      for (const render of renderers) expect(timed(render, source).ms, source.slice(0, 24)).toBeLessThan(BUDGET_MS);
    }
  });

  it("keeps the worst input the guard still lets through fast", () => {
    // Largest repetition that passes the guard, for the costliest shapes found (link openings with a long tail,
    // emphasis openers); measured ≤ 84 ms on the development machine.
    const largestPassing = (unit: string, tail: string) => {
      let low = 0;
      let high = Math.floor((9_999 - tail.length) / unit.length);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (isCanvasMarkdownTooComplex(unit.repeat(middle) + tail)) high = middle - 1;
        else low = middle;
      }
      return unit.repeat(low) + tail;
    };
    for (const [unit, tail] of [
      ["![a](", "x".repeat(8_000)],
      ["[![a](", "x ".repeat(4_000)],
      [`[a](${nbsp}`, "x\n".repeat(3_000)],
      ["[a]((((", "x".repeat(8_000)],
      ["**a ", ""],
      ["_a ", ""],
    ] as const) {
      const source = largestPassing(unit, tail);
      expect(isCanvasMarkdownTooComplex(source), unit).toBe(false);
      for (const render of renderers) expect(timed(render, source).ms, unit).toBeLessThan(BUDGET_MS);
    }
  });

  it("never treats ordinary link- and emphasis-rich notes as too complex", () => {
    const linkList = Array.from(
      { length: 150 },
      (_, index) => `- [Статья ${index}](https://example.org/a/${index}_(v2)) — **важно**`
    ).join("\n");
    const paragraph = Array.from(
      { length: 40 },
      (_, index) => `Замер **${index}** по [методике](https://example.org/m/${index}) и формуле $x_${index}$;`
    ).join(" ");
    const glossary = Array.from({ length: 140 }, (_, index) => `* **Термин ${index}** — описание термина`).join("\n");
    const code = `Функции read_lab_value, write_lab_value и calc_delta_e_2000 — в модуле color_utils.\n`.repeat(90);
    for (const [label, source] of [
      ["150 links in a list", linkList],
      ["40 links and 40 bold in one paragraph", paragraph],
      ["140 bold terms", glossary],
      ["snake_case identifiers", code],
    ] as const) {
      expect(source.length, label).toBeLessThanOrEqual(CANVAS_MARKDOWN_MAX_CHARS);
      expect(isCanvasMarkdownTooComplex(source), label).toBe(false);
      expect(timed(renderCanvasMarkdown, source).ms, label).toBeLessThan(BUDGET_MS);
    }
    expect(getPpmTranslation("ru", "canvas.note_too_complex")).toBe(
      "Заметка показана без форматирования: разметка слишком сложная для показа"
    );
    expect(getPpmTranslation("en", "canvas.note_too_complex")).toBeTruthy();
  });

  it("rejects every scheme outside http(s) and mailto, digits included", () => {
    for (const unsafe of ["h323:x", "x1:y", "a.b-c+d:e", "ms-msdt:x", "javascript:alert(1)"])
      expect(CANVAS_ALLOWED_URI.test(unsafe), unsafe).toBe(false);
    for (const safe of ["https://ok.example", "mailto:a@b.example", "M95,702", "h323", "x1 y", "0 0 400000 1080"])
      expect(CANVAS_ALLOWED_URI.test(safe), safe).toBe(true);
  });

  it("has a strict mode for foreign HTML: no style, SVG or MathML whatever the class says", () => {
    const strict = canvasPurifyConfig(false);
    expect(strict.FORBID_ATTR).toEqual(expect.arrayContaining(["style", "id", "name"]));
    expect(strict.FORBID_TAGS).toEqual(expect.arrayContaining(["svg", "math", "style", "iframe", "img"]));
    expect(strict.USE_PROFILES).toEqual({ html: true });
    const note = canvasPurifyConfig(true);
    expect(note.USE_PROFILES).toEqual({ html: true, mathMl: true, svg: true });
    expect(note.FORBID_ATTR).not.toContain("style");
    expect(sanitizeCanvasHtml('<span class="katex" style="position:fixed">x</span>', { allowKatex: false })).toBe(
      "&lt;span class=&quot;katex&quot; style=&quot;position:fixed&quot;&gt;x&lt;/span&gt;"
    );
  });

  it("names a task from a 50 000-character first line quickly", () => {
    const started = performance.now();
    const name = noteTaskName("", `${"*a ".repeat(16_667)}\n\nтекст`);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    expect(name.length).toBeLessThanOrEqual(255);
  });
});

// Финальная волна (решение контроллера): новая заметка v2 сразу в правке, как стикер; v1 и plain — без изменений.
describe("a new v2 note opens in edit mode (final wave)", () => {
  function fakeEditor(format: "markdown" | "plain" | "missing") {
    const calls: string[] = [];
    const node = createPpmCanvasNode({
      authorId: "u",
      kind: "note",
      noteFormat: format === "plain" ? "plain" : "markdown",
      title: "Новая заметка",
    });
    const shape = { id: "shape:note", props: { node: serializePpmCanvasNode(node) }, type: "ppm-canvas-node" };
    const editor = {
      getShape: (id: string) => (format !== "missing" && id === shape.id ? shape : undefined),
      markHistoryStoppingPoint: (name: string) => {
        calls.push(`mark:${name}`);
        return name;
      },
      select: (id: string) => {
        calls.push(`select:${id}`);
        return editor;
      },
      setCurrentTool: (id: string, info: { shape?: unknown; target?: string }) => {
        calls.push(`tool:${id}:${info.target}:${info.shape === shape}`);
        return editor;
      },
      setEditingShape: (id: string) => {
        calls.push(`editing:${id}`);
        return editor;
      },
    };
    const create = () => {
      calls.push("create");
      return shape.id as TLShapeId;
    };
    return { calls, create, editor: editor as unknown as Editor };
  }

  it("creates the note as its own undo step, then enters tldraw's editing state like a double click", () => {
    const { calls, create, editor } = fakeEditor("markdown");
    expect(createNoteInEditMode(editor, create)).toBe("shape:note");
    expect(calls).toEqual([
      "mark:ppm add note",
      "create",
      "select:shape:note",
      "editing:shape:note",
      "tool:select.editing_shape:shape:true",
    ]);
  });

  it("never opens a plain (pre-AF2.1) note or a missing shape for editing", () => {
    for (const format of ["plain", "missing"] as const) {
      const { calls, create, editor } = fakeEditor(format);
      createNoteInEditMode(editor, create);
      expect(calls, format).toEqual(["mark:ppm add note", "create"]);
    }
  });

  it("runs only under grammar v2 from the rail, the palette and Shift+N; the body field gets the focus", () => {
    expect(editorSource).toMatch(
      /case "add-note": \{\s+if \(!canEdit\) break;\s+const addNote = \(\) => createNode\(editor, authorId, "note", ppmT\("canvas\.note_title"\)\);[\s\S]{0,300}if \(grammarV2\) createNoteInEditMode\(editor, addNote\);\s+else addNote\(\);/
    );
    // Поля правки, на которые опираются e2e: заголовок «Заголовок», текст «Напишите заметку в Markdown…» (фокус — в тексте).
    expect(noteSource).toContain('aria-label={ppmT("canvas.note_title_placeholder")}');
    expect(noteSource).toMatch(
      /autoFocus\s+aria-label=\{ppmT\("canvas\.note_body_placeholder"\)\}[\s\S]{0,200}placeholder=\{ppmT\("canvas\.note_body_placeholder"\)\}/
    );
    expect(getPpmTranslation("ru", "canvas.note_title_placeholder")).toBe("Заголовок");
    expect(getPpmTranslation("en", "canvas.note_title_placeholder")).toBe("Title");
    expect(getPpmTranslation("ru", "canvas.note_body_placeholder")).toBe("Напишите заметку в Markdown…");
    expect(getPpmTranslation("en", "canvas.note_body_placeholder")).toBe("Write a note in Markdown…");
  });
});
